import {
  TikTokApiError,
  getStatementTransactions,
  getStatements,
  getWithdrawals,
  mapOrderToLines,
  mapStatementTransaction,
  mapWithdrawal,
  myDateToUnix,
  refreshTikTokToken,
  searchOrders,
  type ApiOrderLine,
  type ApiPayout,
  type ApiSettlement,
} from './tiktok-api'

/**
 * TikTok Shop API → marketplace tables, for one connected shop.
 *
 * Each step saves its cursor as it goes, so a run that hits the time budget
 * (or fails) continues where it stopped next time. Orders are upserted by
 * (shop, order, SKU) like the Excel import; settlements and payouts before
 * the connection's data_from are skipped because Excel covers them.
 */

export const CONNECTION_COLUMNS =
  'shop_id, company_id, open_id, external_shop_id, external_shop_code, external_shop_name, shop_cipher, access_token, access_token_expires_at, refresh_token, refresh_token_expires_at, data_from, orders_synced_to, statements_synced_to, payouts_synced_to, last_sync_status, sync_started_at'

const WRITE_CHUNK = 500
const ID_CHUNK = 200
const ORDER_OVERLAP_S = 600
const PAYOUT_LOOKBACK_S = 7 * 86400
const REFRESH_BEFORE_MS = 24 * 3600 * 1000
const STALE_RUN_MS = 10 * 60 * 1000

export interface SyncCounts {
  orderLinesInserted: number
  orderLinesUpdated: number
  orderLinesUnchanged: number
  settlementsInserted: number
  payoutsWritten: number
}

export interface SyncResult {
  ok: boolean
  done: boolean
  counts: SyncCounts
  error?: string
}

const chunk = <T,>(items: T[], size: number) => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const toUnix = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null)

/** Day after the latest Excel settlement/payout of the shop, or the 1st of the month two months back (Malaysia time). */
export async function computeDataFrom(db: any, shopId: string, now = Date.now()) {
  const [settled, paid] = await Promise.all([
    db.from('marketplace_settlements').select('settled_date').eq('shop_id', shopId).not('settled_date', 'is', null)
      .not('dedupe_key', 'like', 'api|%').order('settled_date', { ascending: false }).limit(1).maybeSingle(),
    db.from('marketplace_payouts').select('request_date').eq('shop_id', shopId).not('request_date', 'is', null)
      .order('request_date', { ascending: false }).limit(1).maybeSingle(),
  ])
  if (settled.error) throw settled.error
  if (paid.error) throw paid.error
  const latest = [settled.data?.settled_date, paid.data?.request_date].filter(Boolean).sort().pop() as string | undefined
  if (latest) {
    const next = new Date(`${latest}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    return next.toISOString().slice(0, 10)
  }
  const my = new Date(now + 8 * 3600 * 1000)
  const start = new Date(Date.UTC(my.getUTCFullYear(), my.getUTCMonth() - 2, 1))
  return start.toISOString().slice(0, 10)
}

/**
 * Claims the shop for one sync run; false when another run is still active.
 * Compare-and-swap on the status/start time just read, because PostgREST
 * rejects or=(...) filters on PATCH ("column ... does not exist").
 */
export async function claimSyncRun(db: any, shopId: string, now = Date.now()) {
  const { data: current, error: readError } = await db
    .from('marketplace_shop_connections')
    .select('last_sync_status, sync_started_at')
    .eq('shop_id', shopId)
    .maybeSingle()
  if (readError) throw readError
  if (!current) return false
  const started = toUnix(current.sync_started_at)
  if (current.last_sync_status === 'running' && started !== null && started * 1000 >= now - STALE_RUN_MS) return false

  let query = db
    .from('marketplace_shop_connections')
    .update({ last_sync_status: 'running', sync_started_at: new Date(now).toISOString() })
    .eq('shop_id', shopId)
  query = current.last_sync_status === null ? query.is('last_sync_status', null) : query.eq('last_sync_status', current.last_sync_status)
  query = current.sync_started_at === null ? query.is('sync_started_at', null) : query.eq('sync_started_at', current.sync_started_at)
  const { data, error } = await query.select('shop_id')
  if (error) throw error
  return (data || []).length > 0
}

async function validAccessToken(db: any, conn: any) {
  const expires = Date.parse(conn.access_token_expires_at)
  if (Number.isFinite(expires) && expires - Date.now() > REFRESH_BEFORE_MS) return conn.access_token as string
  const tokens = await refreshTikTokToken(conn.refresh_token)
  const update = {
    access_token: tokens.accessToken,
    access_token_expires_at: tokens.accessTokenExpiresAt,
    refresh_token: tokens.refreshToken || conn.refresh_token,
    refresh_token_expires_at: tokens.refreshTokenExpiresAt ?? conn.refresh_token_expires_at,
    updated_at: new Date().toISOString(),
  }
  const { error } = await db.from('marketplace_shop_connections').update(update).eq('shop_id', conn.shop_id)
  if (error) throw error
  Object.assign(conn, update)
  return tokens.accessToken
}

async function startImport(db: any, conn: any, kind: 'orders' | 'settlements', periodStart: string | null) {
  const { data, error } = await db.from('marketplace_imports').insert({
    company_id: conn.company_id, shop_id: conn.shop_id, source: 'api', file_kind: kind,
    file_name: kind === 'orders' ? 'TikTok Shop API — orders' : 'TikTok Shop API — settlements & payouts',
    period_start: periodStart, period_end: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10),
  }).select('id').single()
  if (error) throw error
  return data.id as string
}

interface ImportLog {
  kind: 'orders' | 'settlements'
  id: string
}

type ImportFor = (kind: 'orders' | 'settlements') => Promise<string>

async function writeOrderLines(db: any, conn: any, importFor: ImportFor, lines: ApiOrderLine[], counts: SyncCounts) {
  const orderIds = [...new Set(lines.map(l => l.orderId))]
  const known = new Map<string, string>()
  for (const part of chunk(orderIds, ID_CHUNK)) {
    const { data, error } = await db.from('marketplace_order_lines').select('order_id, sku_id, content_hash')
      .eq('shop_id', conn.shop_id).in('order_id', part)
    if (error) throw error
    for (const r of data || []) known.set(`${r.order_id}|${r.sku_id}`, r.content_hash)
  }
  const now = new Date().toISOString()
  const write = lines.filter(l => known.get(`${l.orderId}|${l.skuId}`) !== l.contentHash)
  for (const l of write) known.has(`${l.orderId}|${l.skuId}`) ? counts.orderLinesUpdated++ : counts.orderLinesInserted++
  counts.orderLinesUnchanged += lines.length - write.length
  if (!write.length) return
  const importId = await importFor('orders')
  for (const part of chunk(write, WRITE_CHUNK)) {
    const { error } = await db.from('marketplace_order_lines').upsert(
      part.map(l => ({ ...l.row, company_id: conn.company_id, shop_id: conn.shop_id, order_id: l.orderId, sku_id: l.skuId, content_hash: l.contentHash, last_import_id: importId, updated_at: now })),
      { onConflict: 'shop_id,order_id,sku_id' },
    )
    if (error) throw error
  }
}

async function writeSettlements(db: any, conn: any, importFor: ImportFor, rows: ApiSettlement[], counts: SyncCounts) {
  const keep = rows.filter(r => r.settledDate && r.settledDate >= conn.data_from)
  const existing = new Set<string>()
  for (const part of chunk(keep.map(r => r.dedupeKey), ID_CHUNK)) {
    const { data, error } = await db.from('marketplace_settlements').select('dedupe_key').eq('shop_id', conn.shop_id).in('dedupe_key', part)
    if (error) throw error
    for (const r of data || []) existing.add(r.dedupe_key)
  }
  const fresh = keep.filter(r => !existing.has(r.dedupeKey))
  if (!fresh.length) return
  const importId = await importFor('settlements')
  for (const part of chunk(fresh, WRITE_CHUNK)) {
    const { error } = await db.from('marketplace_settlements').upsert(
      part.map(r => ({ ...r.row, company_id: conn.company_id, shop_id: conn.shop_id, import_id: importId, dedupe_key: r.dedupeKey })),
      { onConflict: 'shop_id,dedupe_key', ignoreDuplicates: true },
    )
    if (error) throw error
  }
  counts.settlementsInserted += fresh.length
}

async function writePayouts(db: any, conn: any, importFor: ImportFor, rows: ApiPayout[], counts: SyncCounts) {
  const state = (p: { amount: unknown; status: unknown; request_date: unknown }) => `${Number(p.amount).toFixed(2)}|${p.status ?? ''}|${p.request_date ?? ''}`
  const known = new Map<string, string>()
  for (const part of chunk([...new Set(rows.map(r => r.referenceId))], ID_CHUNK)) {
    const { data, error } = await db.from('marketplace_payouts').select('reference_id, transaction_type, amount, status, request_date')
      .eq('shop_id', conn.shop_id).in('reference_id', part)
    if (error) throw error
    for (const r of data || []) known.set(`${r.reference_id}|${r.transaction_type}`, state(r))
  }
  const write = rows.filter(r => known.get(`${r.referenceId}|${r.transactionType}`) !== state(r.row as any))
  if (!write.length) return
  const importId = await importFor('settlements')
  const now = new Date().toISOString()
  for (const part of chunk(write, WRITE_CHUNK)) {
    const { error } = await db.from('marketplace_payouts').upsert(
      part.map(p => ({ ...p.row, company_id: conn.company_id, shop_id: conn.shop_id, import_id: importId, updated_at: now })),
      { onConflict: 'shop_id,reference_id,transaction_type' },
    )
    if (error) throw error
  }
  counts.payoutsWritten += write.length
}

async function saveCursor(db: any, conn: any, update: Record<string, string>) {
  const { error } = await db.from('marketplace_shop_connections').update(update).eq('shop_id', conn.shop_id)
  if (error) throw error
  Object.assign(conn, update)
}

/**
 * Runs one sync for a claimed connection (see claimSyncRun) and records the
 * outcome on it. `deadline` is a Date.now() value after which no new page is
 * started; the result says whether everything was fetched.
 */
export async function syncTikTokShop(db: any, conn: any, deadline: number): Promise<SyncResult> {
  const counts: SyncCounts = { orderLinesInserted: 0, orderLinesUpdated: 0, orderLinesUnchanged: 0, settlementsInserted: 0, payoutsWritten: 0 }
  const imports: ImportLog[] = []
  const importFor = async (kind: 'orders' | 'settlements') => {
    let log = imports.find(i => i.kind === kind)
    if (!log) {
      log = { kind, id: await startImport(db, conn, kind, conn.data_from) }
      imports.push(log)
    }
    return log.id
  }
  let done = false
  try {
    const token = await validAccessToken(db, conn)
    const dataFromUnix = myDateToUnix(conn.data_from)

    // Orders (created or changed since the cursor)
    let ordersDone = false
    const orderSince = Math.max(dataFromUnix, (toUnix(conn.orders_synced_to) ?? dataFromUnix) - ORDER_OVERLAP_S)
    let pageToken: string | undefined
    while (Date.now() < deadline) {
      const page = await searchOrders(token, conn.shop_cipher, { updateTimeGe: orderSince, pageToken })
      const orders = page?.orders || []
      const lines = orders.flatMap(mapOrderToLines)
      if (lines.length) await writeOrderLines(db, conn, importFor, lines, counts)
      const maxUpdate = Math.max(0, ...orders.map((o: any) => Number(o.update_time) || 0))
      if (maxUpdate > (toUnix(conn.orders_synced_to) ?? 0)) await saveCursor(db, conn, { orders_synced_to: new Date(maxUpdate * 1000).toISOString() })
      pageToken = page?.next_page_token || undefined
      if (!pageToken || orders.length === 0) { ordersDone = true; break }
    }

    // Settlement statements (one per day) and their transactions
    let statementsDone = false
    if (ordersDone) {
      const statementSince = Math.max(dataFromUnix, (toUnix(conn.statements_synced_to) ?? dataFromUnix - 1) + 1)
      let statementToken: string | undefined
      outer: while (Date.now() < deadline) {
        const page = await getStatements(token, conn.shop_cipher, { statementTimeGe: statementSince, pageToken: statementToken })
        const statements = (page?.statements || []).filter((s: any) => s?.id && Number(s.statement_time) > 0)
        for (const statement of statements) {
          if (Date.now() >= deadline) break outer
          const rows: ApiSettlement[] = []
          let txToken: string | undefined
          do {
            const tx = await getStatementTransactions(token, conn.shop_cipher, String(statement.id), txToken)
            for (const t of tx?.transactions || []) {
              const row = mapStatementTransaction(String(statement.id), Number(statement.statement_time), statement.currency ?? tx?.currency ?? null, t)
              if (row) rows.push(row)
            }
            txToken = tx?.next_page_token || undefined
          } while (txToken)
          await writeSettlements(db, conn, importFor, rows, counts)
          await saveCursor(db, conn, { statements_synced_to: new Date(Number(statement.statement_time) * 1000).toISOString() })
        }
        statementToken = page?.next_page_token || undefined
        if (!statementToken || statements.length === 0) { statementsDone = true; break }
      }
    }

    // Earnings, withdrawals and other balance movements
    let payoutsDone = false
    if (statementsDone) {
      const payoutSince = Math.max(dataFromUnix, (toUnix(conn.payouts_synced_to) ?? dataFromUnix) - PAYOUT_LOOKBACK_S)
      const startedAt = new Date().toISOString()
      let withdrawalToken: string | undefined
      while (Date.now() < deadline) {
        const page = await getWithdrawals(token, conn.shop_cipher, { createTimeGe: payoutSince, pageToken: withdrawalToken })
        const items = page?.withdrawals || []
        const rows = items.map(mapWithdrawal).filter((p): p is ApiPayout => Boolean(p?.row.request_date && p.row.request_date >= conn.data_from))
        if (rows.length) await writePayouts(db, conn, importFor, rows, counts)
        withdrawalToken = page?.next_page_token || undefined
        if (!withdrawalToken || items.length === 0) { payoutsDone = true; break }
      }
      if (payoutsDone) await saveCursor(db, conn, { payouts_synced_to: startedAt })
    }

    done = ordersDone && statementsDone && payoutsDone
    await finishImports(db, imports, counts, 'completed')
    await db.from('marketplace_shop_connections').update({
      last_sync_status: 'ok', last_sync_at: new Date().toISOString(), last_sync_error: done ? null : 'Not finished in this run; the next sync continues.', updated_at: new Date().toISOString(),
    }).eq('shop_id', conn.shop_id)
    return { ok: true, done, counts }
  } catch (error) {
    const message = describeSyncError(error)
    await finishImports(db, imports, counts, 'failed').catch(() => undefined)
    await db.from('marketplace_shop_connections').update({
      last_sync_status: 'failed', last_sync_at: new Date().toISOString(), last_sync_error: message, updated_at: new Date().toISOString(),
    }).eq('shop_id', conn.shop_id)
    return { ok: false, done: false, counts, error: message }
  }
}

async function finishImports(db: any, imports: ImportLog[], counts: SyncCounts, status: 'completed' | 'failed') {
  for (const imp of imports) {
    const [inserted, updated, unchanged] = imp.kind === 'orders'
      ? [counts.orderLinesInserted, counts.orderLinesUpdated, counts.orderLinesUnchanged]
      : [counts.settlementsInserted + counts.payoutsWritten, 0, 0]
    await db.from('marketplace_imports').update({
      status, rows_in_file: inserted + updated + unchanged, rows_inserted: inserted, rows_updated: updated, rows_unchanged: unchanged,
    }).eq('id', imp.id)
  }
}

export function describeSyncError(error: unknown) {
  if (error instanceof TikTokApiError) {
    if (error.code === 105002 || error.code === 105001 || /access.?token|expired|invalid.*token/i.test(error.message)) {
      return `TikTok rejected the connection (${error.message}). Connect the shop again.`
    }
    return `TikTok Shop API: ${error.message}${error.code ? ` (code ${error.code})` : ''}`
  }
  const message = (error as { message?: string })?.message
  return String(message || error || 'Sync failed').slice(0, 500)
}
