import {
  buildSalesReport,
  buildSettlementReport,
  buildShippingReport,
  periodRange,
  type OrderTiming,
  type PayoutRow,
  type ReportKind,
  type ReportPeriod,
  type SalesLine,
  type SettlementRow,
  type ShippingLine,
  type TikTokReport,
  type UnsettledRow,
} from './tiktok-reports'

const PAGE = 1000
const ID_CHUNK = 200

const SALES_COLUMNS = 'id, shop_id, order_id, product_name, seller_sku, order_status, quantity, subtotal_after_discount, created_time'
const SETTLEMENT_COLUMNS = 'id, shop_id, transaction_type, related_order_id, settled_date, total_settlement_amount, total_revenue, total_fees, customer_refund, fee_breakdown'
const SHIPPING_COLUMNS = 'id, shop_id, order_id, order_status, order_substatus, shipping_provider, tracking_number, quantity, created_time, paid_time, shipped_time, delivered_time, cancelled_time'

const MISSING_TABLE = new Set(['42P01', 'PGRST205'])

async function fetchAll<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build(offset, offset + PAGE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE) return rows
  }
}

function settlementsIn(db: any, companyId: string, shopIds: string[], start: string, end: string) {
  return fetchAll<SettlementRow>((from, to) => db.from('marketplace_settlements').select(SETTLEMENT_COLUMNS)
    .eq('company_id', companyId).in('shop_id', shopIds)
    .gte('settled_date', start).lt('settled_date', end)
    .order('settled_date').order('id').range(from, to))
}

async function loadUnsettled(db: any, companyId: string, shopIds: string[]): Promise<UnsettledRow[]> {
  try {
    return await fetchAll<UnsettledRow>((from, to) => db.from('marketplace_unsettled')
      .select('id, shop_id, order_id, reason, est_settlement, synced_at')
      .eq('company_id', companyId).in('shop_id', shopIds)
      .order('id').range(from, to))
  } catch (error) {
    if (MISSING_TABLE.has((error as { code?: string })?.code || '')) return []
    throw error
  }
}

async function loadTimings(db: any, companyId: string, shopIds: string[], orderIds: string[]): Promise<OrderTiming[]> {
  const out: OrderTiming[] = []
  const unique = [...new Set(orderIds)]
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const { data, error } = await db.from('marketplace_order_lines').select('shop_id, order_id, created_time, delivered_time')
      .eq('company_id', companyId).in('shop_id', shopIds).in('order_id', unique.slice(i, i + ID_CHUNK))
    if (error) throw error
    out.push(...(data || []))
  }
  return out
}

function shippingLines(db: any, companyId: string, shopIds: string[], filter: (q: any) => any) {
  return fetchAll<ShippingLine & { id: string }>((from, to) => filter(db.from('marketplace_order_lines').select(SHIPPING_COLUMNS)
    .eq('company_id', companyId).in('shop_id', shopIds))
    .order('id').range(from, to))
}

/** One report for one or more TikTok shops of the company. */
export async function loadTikTokReport(
  db: any,
  input: { companyId: string; shopIds: string[]; kind: ReportKind; period: ReportPeriod; date: string; now?: Date },
): Promise<TikTokReport> {
  const now = input.now || new Date()
  const range = periodRange(input.period, input.date, now)

  const [{ data: shopRows, error }, { data: connections }] = await Promise.all([
    db.from('marketplace_shops').select('id, shop_name').eq('company_id', input.companyId).in('id', input.shopIds).order('shop_name'),
    db.from('marketplace_shop_connections').select('shop_id, last_sync_at').eq('company_id', input.companyId).in('shop_id', input.shopIds),
  ])
  if (error) throw error
  const shops = ((shopRows || []) as { id: string; shop_name: string }[]).map(s => ({ id: s.id, name: s.shop_name }))
  const shopIds = shops.map(s => s.id)
  const syncTimes = ((connections || []) as { last_sync_at: string | null }[]).map(c => c.last_sync_at).filter(Boolean).sort() as string[]

  let data: TikTokReport['data']
  if (input.kind === 'sales') {
    const lines = shopIds.length
      ? await fetchAll<SalesLine>((from, to) => db.from('marketplace_order_lines').select(SALES_COLUMNS)
        .eq('company_id', input.companyId).in('shop_id', shopIds)
        .gte('created_time', range.prevStartIso).lt('created_time', range.endIso)
        .order('id').range(from, to))
      : []
    data = buildSalesReport({ range, shops, lines, now })
  } else if (input.kind === 'settlement') {
    const [settlements, payouts, unsettled] = shopIds.length
      ? await Promise.all([
        settlementsIn(db, input.companyId, shopIds, range.start, range.end),
        fetchAll<PayoutRow>((from, to) => db.from('marketplace_payouts').select('id, shop_id, reference_id, transaction_type, request_date, amount, status')
          .eq('company_id', input.companyId).in('shop_id', shopIds)
          .order('id').range(from, to)),
        loadUnsettled(db, input.companyId, shopIds),
      ])
      : [[], [], []]
    const orderIds = settlements.filter(r => /^order$/i.test(String(r.transaction_type || '')) && r.related_order_id).map(r => String(r.related_order_id))
    const timings = orderIds.length ? await loadTimings(db, input.companyId, shopIds, orderIds) : []
    data = buildSettlementReport({ range, shops, settlements, payouts, unsettled, timings })
  } else {
    const between = (column: string) => (q: any) => q.gte(column, range.startIso).lt(column, range.endIso)
    const [shipped, delivered, cancelled, toShip, settlements] = shopIds.length
      ? await Promise.all([
        shippingLines(db, input.companyId, shopIds, between('shipped_time')),
        shippingLines(db, input.companyId, shopIds, between('delivered_time')),
        shippingLines(db, input.companyId, shopIds, between('cancelled_time')),
        shippingLines(db, input.companyId, shopIds, q => q.eq('order_status', 'To ship')),
        settlementsIn(db, input.companyId, shopIds, range.start, range.end),
      ])
      : [[], [], [], [], []]
    const lines = [...new Map([...shipped, ...delivered, ...cancelled, ...toShip].map(l => [l.id, l])).values()]
    data = buildShippingReport({ range, shops, lines, settlements, now })
  }

  return {
    kind: input.kind,
    period: input.period,
    date: input.date,
    range,
    shops,
    lastSyncAt: syncTimes[0] ?? null,
    generatedAt: now.toISOString(),
    data,
  }
}
