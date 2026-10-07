import { NextResponse } from 'next/server'
import { loadMarketplaceContext } from '@/lib/marketplace/access'
import { readXlsx } from '@/lib/marketplace/xlsx-lite'
import {
  centsToAmount,
  detectTikTokFile,
  parseTikTokOrders,
  parseTikTokSettlements,
} from '@/lib/marketplace/tiktok-shop'

/**
 * POST /api/ecommerce/tiktok-shop/import
 * Body: { shop_id, file_name, file_base64, mode: 'preview' | 'import' }
 *
 * Accepts the TikTok Seller Center exports as downloaded (orders file or
 * transaction file). Preview reports what is new / changed / already
 * imported; import writes only those rows, so the same or an overlapping
 * file can be uploaded again safely.
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024
const ID_CHUNK = 200
const WRITE_CHUNK = 500

const chunk = <T,>(items: T[], size: number) => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const bad = (error: string, status = 422, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status })

async function selectIn(db: any, table: string, columns: string, shopFilter: (q: any) => any, column: string, ids: string[]) {
  const rows: any[] = []
  for (const part of chunk([...new Set(ids)], ID_CHUNK)) {
    const { data, error } = await shopFilter(db.from(table).select(columns)).in(column, part)
    if (error) throw error
    rows.push(...(data || []))
  }
  return rows
}

/** First day whose settlements/payouts come from the TikTok Shop API for this shop (also after a disconnect), or null. */
async function apiDataFrom(db: any, shopId: string): Promise<string | null> {
  const [conn, firstApi] = await Promise.all([
    db.from('marketplace_shop_connections').select('data_from').eq('shop_id', shopId).maybeSingle(),
    db.from('marketplace_settlements').select('settled_date').eq('shop_id', shopId).like('dedupe_key', 'api|%')
      .not('settled_date', 'is', null).order('settled_date').limit(1).maybeSingle(),
  ])
  if (conn.error && conn.error.code !== '42P01' && conn.error.code !== 'PGRST205') throw conn.error
  if (firstApi.error) throw firstApi.error
  return [conn.data?.data_from, firstApi.data?.settled_date].filter(Boolean).sort()[0] ?? null
}

function otherShopNameInFile(fileName: string, shop: any, shops: any[]) {
  const name = fileName.toLowerCase()
  if (name.includes(String(shop.shop_name).toLowerCase())) return null
  return shops.find(s => s.id !== shop.id && name.includes(String(s.shop_name).toLowerCase()))?.shop_name ?? null
}

export async function POST(request: Request) {
  try {
    const ctx = await loadMarketplaceContext()
    if (ctx.error) return ctx.error
    const { db, orgId, userId } = ctx

    const body = await request.json().catch(() => null)
    const mode = body?.mode === 'import' ? 'import' : 'preview'
    const fileName = typeof body?.file_name === 'string' ? body.file_name.slice(0, 200) : 'upload.xlsx'
    if (typeof body?.shop_id !== 'string' || typeof body?.file_base64 !== 'string') return bad('shop_id and file_base64 are required', 400)
    if (!/\.xlsx$/i.test(fileName)) return bad('Upload the .xlsx file downloaded from TikTok Seller Center.', 400)

    const { data: shops, error: shopsError } = await db
      .from('marketplace_shops')
      .select('id, shop_name, is_active')
      .eq('company_id', orgId)
      .eq('platform', 'tiktok_shop')
    if (shopsError) return bad(shopsError.message, 500)
    const shop = (shops || []).find((s: any) => s.id === body.shop_id)
    if (!shop) return bad('Shop not found', 404)
    if (!shop.is_active) return bad('This shop is inactive.', 400)

    const buffer = Buffer.from(body.file_base64, 'base64')
    if (buffer.length === 0) return bad('The file is empty.', 400)
    if (buffer.length > MAX_FILE_BYTES) return bad('The file is larger than 5 MB.', 413)

    let sheets
    try {
      sheets = readXlsx(buffer)
    } catch (error) {
      return bad(`Could not read the Excel file: ${(error as Error).message}`)
    }
    const kind = detectTikTokFile(sheets)
    if (!kind) return bad('This is not a TikTok Shop orders file or transaction file.')

    const warnings: string[] = []
    const otherShop = otherShopNameInFile(fileName, shop, shops || [])
    if (otherShop) warnings.push(`The file name mentions "${otherShop}" but you selected "${shop.shop_name}". Check the shop before importing.`)
    const otherShopIds = (shops || []).filter((s: any) => s.id !== shop.id).map((s: any) => s.id)
    const shopName = (id: string) => (shops || []).find((s: any) => s.id === id)?.shop_name || 'another shop'

    if (kind === 'orders') {
      const parsed = parseTikTokOrders(sheets)
      if (!parsed.value) return bad(parsed.errors[0], 422, { errors: parsed.errors, kind })
      const file = parsed.value
      warnings.push(...parsed.warnings)

      if (otherShopIds.length) {
        const clash = await selectIn(db, 'marketplace_order_lines', 'shop_id', q => q.eq('company_id', orgId).in('shop_id', otherShopIds), 'order_id', file.orderIds)
        if (clash.length) return bad(`These orders are already imported under "${shopName(clash[0].shop_id)}". This file belongs to that shop.`, 422, { kind })
      }

      const existing = await selectIn(db, 'marketplace_order_lines', 'order_id, sku_id, content_hash', q => q.eq('company_id', orgId).eq('shop_id', shop.id), 'order_id', file.orderIds)
      const known = new Map(existing.map(e => [`${e.order_id}|${e.sku_id}`, e.content_hash]))
      const fresh = file.lines.filter(l => !known.has(`${l.orderId}|${l.skuId}`))
      const changed = file.lines.filter(l => known.has(`${l.orderId}|${l.skuId}`) && known.get(`${l.orderId}|${l.skuId}`) !== l.contentHash)
      const unchanged = file.lines.length - fresh.length - changed.length

      const summary = {
        kind,
        period_start: file.periodStart,
        period_end: file.periodEnd,
        orders: file.orderIds.length,
        lines: file.lines.length,
        new_lines: fresh.length,
        updated_lines: changed.length,
        unchanged_lines: unchanged,
      }
      if (mode === 'preview') return NextResponse.json({ mode, summary, warnings })

      const { data: imp, error: impError } = await db.from('marketplace_imports').insert({
        company_id: orgId, shop_id: shop.id, source: 'excel', file_kind: 'orders', file_name: fileName,
        period_start: file.periodStart, period_end: file.periodEnd, rows_in_file: file.lines.length, imported_by: userId,
      }).select('id').single()
      if (impError) return bad(impError.message, 500)

      const now = new Date().toISOString()
      const rows = [...fresh, ...changed].map(l => ({
        ...l.row, company_id: orgId, shop_id: shop.id, order_id: l.orderId, sku_id: l.skuId,
        content_hash: l.contentHash, last_import_id: imp.id, updated_at: now,
      }))
      for (const part of chunk(rows, WRITE_CHUNK)) {
        const { error } = await db.from('marketplace_order_lines').upsert(part, { onConflict: 'shop_id,order_id,sku_id' })
        if (error) {
          await db.from('marketplace_imports').update({ status: 'failed' }).eq('id', imp.id)
          return bad(`Import stopped: ${error.message}. Rows already saved are kept; upload the same file again to finish.`, 500)
        }
      }
      await db.from('marketplace_imports').update({
        status: 'completed', rows_inserted: fresh.length, rows_updated: changed.length, rows_unchanged: unchanged,
      }).eq('id', imp.id)
      return NextResponse.json({ mode, summary, warnings, import_id: imp.id })
    }

    const parsed = parseTikTokSettlements(sheets)
    if (!parsed.value) return bad(parsed.errors[0], 422, { errors: parsed.errors, kind })
    const file = { ...parsed.value }
    warnings.push(...parsed.warnings)

    const apiFrom = await apiDataFrom(db, shop.id)
    if (apiFrom) {
      const settlementsBefore = file.settlements.filter(s => !s.settledDate || s.settledDate < apiFrom)
      const payoutsBefore = file.payouts.filter(p => !p.row.request_date || p.row.request_date < apiFrom)
      const skipped = file.settlements.length - settlementsBefore.length + file.payouts.length - payoutsBefore.length
      if (skipped) {
        warnings.push(`${skipped} row(s) dated ${apiFrom} or later are skipped: this shop's settlements and payouts from that date come from the TikTok Shop API.`)
        file.settlements = settlementsBefore
        file.payouts = payoutsBefore
        if (!file.settlements.length && !file.payouts.length) return bad(`Everything in this file is dated ${apiFrom} or later, which the TikTok Shop API already provides for this shop.`, 422, { kind })
      }
    }
    const recordIds = file.settlements.map(s => s.recordId)

    if (otherShopIds.length && recordIds.length) {
      const clash = [
        ...await selectIn(db, 'marketplace_settlements', 'shop_id', q => q.eq('company_id', orgId).in('shop_id', otherShopIds), 'record_id', recordIds),
        ...await selectIn(db, 'marketplace_order_lines', 'shop_id', q => q.eq('company_id', orgId).in('shop_id', otherShopIds), 'order_id', recordIds),
      ]
      if (clash.length) return bad(`These orders are already imported under "${shopName(clash[0].shop_id)}". This file belongs to that shop.`, 422, { kind })
    }

    const existingKeys = new Set(
      (await selectIn(db, 'marketplace_settlements', 'dedupe_key', q => q.eq('company_id', orgId).eq('shop_id', shop.id), 'record_id', recordIds))
        .map(e => e.dedupe_key),
    )
    const freshSettlements = file.settlements.filter(s => !existingKeys.has(s.dedupeKey))

    const existingPayouts = await selectIn(db, 'marketplace_payouts', 'reference_id, transaction_type, amount, status, success_date', q => q.eq('company_id', orgId).eq('shop_id', shop.id), 'reference_id', file.payouts.map(p => p.referenceId))
    const payoutState = new Map(existingPayouts.map(p => [`${p.reference_id}|${p.transaction_type}`, `${Number(p.amount).toFixed(2)}|${p.status ?? ''}|${p.success_date ?? ''}`]))
    const freshPayouts = file.payouts.filter(p => !payoutState.has(`${p.referenceId}|${p.transactionType}`))
    const changedPayouts = file.payouts.filter(p => {
      const state = payoutState.get(`${p.referenceId}|${p.transactionType}`)
      return state !== undefined && state !== `${p.row.amount}|${p.row.status ?? ''}|${p.row.success_date ?? ''}`
    })

    const newSettlementCents = freshSettlements.reduce((s, r) => s + r.totalSettlementCents, 0)
    const summary = {
      kind,
      period_start: file.periodStart,
      period_end: file.periodEnd,
      currency: file.currency,
      settlements: file.settlements.length,
      new_settlements: freshSettlements.length,
      already_imported_settlements: file.settlements.length - freshSettlements.length,
      file_total: centsToAmount(file.totalSettlementCents),
      report_total: file.reportTotalCents === null ? null : centsToAmount(file.reportTotalCents),
      new_settlement_amount: centsToAmount(newSettlementCents),
      payouts: file.payouts.length,
      new_payouts: freshPayouts.length,
      updated_payouts: changedPayouts.length,
    }
    if (mode === 'preview') return NextResponse.json({ mode, summary, warnings })

    const rowsInFile = file.settlements.length + file.payouts.length
    const { data: imp, error: impError } = await db.from('marketplace_imports').insert({
      company_id: orgId, shop_id: shop.id, source: 'excel', file_kind: 'settlements', file_name: fileName,
      period_start: file.periodStart, period_end: file.periodEnd, rows_in_file: rowsInFile, imported_by: userId,
    }).select('id').single()
    if (impError) return bad(impError.message, 500)
    const failImport = async (message: string) => {
      await db.from('marketplace_imports').update({ status: 'failed' }).eq('id', imp.id)
      return bad(`Import stopped: ${message}. Rows already saved are kept; upload the same file again to finish.`, 500)
    }

    for (const part of chunk(freshSettlements, WRITE_CHUNK)) {
      const { error } = await db.from('marketplace_settlements').upsert(
        part.map(s => ({ ...s.row, company_id: orgId, shop_id: shop.id, import_id: imp.id, dedupe_key: s.dedupeKey })),
        { onConflict: 'shop_id,dedupe_key', ignoreDuplicates: true },
      )
      if (error) return failImport(error.message)
    }
    const now = new Date().toISOString()
    for (const part of chunk([...freshPayouts, ...changedPayouts], WRITE_CHUNK)) {
      const { error } = await db.from('marketplace_payouts').upsert(
        part.map(p => ({ ...p.row, company_id: orgId, shop_id: shop.id, import_id: imp.id, updated_at: now })),
        { onConflict: 'shop_id,reference_id,transaction_type' },
      )
      if (error) return failImport(error.message)
    }
    const inserted = freshSettlements.length + freshPayouts.length
    await db.from('marketplace_imports').update({
      status: 'completed', rows_inserted: inserted, rows_updated: changedPayouts.length, rows_unchanged: rowsInFile - inserted - changedPayouts.length,
    }).eq('id', imp.id)
    return NextResponse.json({ mode, summary, warnings, import_id: imp.id })
  } catch (error) {
    console.error('Error importing TikTok Shop file:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
