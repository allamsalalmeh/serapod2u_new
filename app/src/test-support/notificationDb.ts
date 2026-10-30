/**
 * In-memory Supabase double for notification tests. Supports the query shapes
 * the notification resolvers use: select / eq / in / contains / limit /
 * order / maybeSingle / single / await, plus insert and update recording.
 * No network, no real providers.
 */
import { createHash } from 'node:crypto'

export type Tables = Record<string, any[]>

/** Deterministic uuid for a readable fixture name (ids are uuid columns in the database). */
export function u(name: string): string {
  const h = createHash('sha1').update(`serapod-fixture:${name}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function notificationDb(tables: Tables, options: { errors?: Record<string, string> } = {}) {
  const inserts: Array<{ table: string; row: any }> = []
  const updates: Array<{ table: string; values: any; filters: Array<[string, string, any]> }> = []
  const queries: Array<{ table: string; filters: Array<[string, string, any]> }> = []

  const matches = (row: any, filters: Array<[string, string, any]>) => filters.every(([op, column, value]) => {
    if (op === 'eq') return row[column] === value
    if (op === 'in') return (value as unknown[]).includes(row[column])
    if (op === 'is') return (row[column] ?? null) === value
    if (op === 'contains') return Object.entries(value).every(([key, expected]) => (row[column] || {})[key] === expected)
    if (op === 'gte') return true
    return true
  })

  function from(table: string) {
    const filters: Array<[string, string, any]> = []
    let limit = Infinity
    let mode: 'select' | 'update' = 'select'
    let updateValues: any = null
    const rows = () => (tables[table] || []).filter((row) => matches(row, filters)).slice(0, limit)
    const failure = options.errors?.[table] ? { data: null, error: { message: options.errors[table] } } : null
    const run = () => {
      if (failure) return failure
      if (mode === 'update') {
        const hit = (tables[table] || []).filter((row) => matches(row, filters))
        hit.forEach((row) => Object.assign(row, updateValues))
        updates.push({ table, values: updateValues, filters: [...filters] })
        return { data: hit, error: null }
      }
      return { data: rows(), error: null }
    }
    const query: any = {
      select: () => query,
      eq: (column: string, value: any) => { filters.push(['eq', column, value]); return query },
      in: (column: string, value: any) => { filters.push(['in', column, value]); return query },
      is: (column: string, value: any) => { filters.push(['is', column, value]); return query },
      contains: (column: string, value: any) => { filters.push(['contains', column, value]); return query },
      gte: (column: string, value: any) => { filters.push(['gte', column, value]); return query },
      order: () => query,
      limit: (n: number) => { limit = n; return query },
      maybeSingle: async () => { queries.push({ table, filters: [...filters] }); return failure || { data: rows()[0] || null, error: null } },
      single: async () => { queries.push({ table, filters: [...filters] }); return failure || { data: rows()[0] || null, error: null } },
      update: (values: any) => { mode = 'update'; updateValues = values; return query },
      insert: (row: any) => {
        const record = { id: u(`row-${inserts.length + 1}`), ...row }
        inserts.push({ table, row: record })
        ;(tables[table] ||= []).push(record)
        const result: any = { select: () => ({ single: async () => ({ data: record, error: null }) }), then: (resolve: any) => resolve({ data: record, error: null }) }
        return result
      },
      then: (resolve: (value: any) => void) => { queries.push({ table, filters: [...filters] }); resolve(run()) },
    }
    return query
  }

  return { from, inserts, updates, queries, tables }
}

/** Orders, organizations and documents for two distributors and two manufacturers. */
export function supplyChainWorld() {
  const organizations = [
    { id: u('hq'), org_name: 'Serapod HQ', org_type_code: 'HQ', contact_phone: '+60100000000', contact_email: 'hq@serapod.test', is_active: true },
    { id: u('dist-eariel'), org_name: 'Eariel Distributor', org_type_code: 'DIST', contact_phone: '+60123456001', contact_email: 'orders@eariel.test', is_active: true },
    { id: u('dist-b'), org_name: 'Distributor B', org_type_code: 'DIST', contact_phone: '+60123456002', contact_email: 'b@dist.test', is_active: true },
    { id: u('mfg-a'), org_name: 'Manufacturer A', org_type_code: 'MFG', contact_phone: '+60123456101', contact_email: 'a@mfg.test', is_active: true },
    { id: u('mfg-b'), org_name: 'Manufacturer B', org_type_code: 'MFG', contact_phone: '+60123456102', contact_email: 'b@mfg.test', is_active: true },
    { id: u('wh-1'), org_name: 'Main Warehouse', org_type_code: 'WH', contact_phone: '+60123456201', contact_email: 'wh@serapod.test', is_active: true },
    { id: u('shop-1'), org_name: 'Shop One', org_type_code: 'SHOP', contact_phone: '+60123456301', contact_email: 'shop@shop.test', is_active: true },
  ]
  const orders = [
    { id: u('o-d2h-eariel'), order_no: 'ORD-D2H-1', display_doc_no: 'SO26000001', order_type: 'D2H', company_id: u('hq'), buyer_org_id: u('dist-eariel'), seller_org_id: u('hq'), warehouse_org_id: u('wh-1'), created_by: u('u-creator') },
    { id: u('o-d2h-b'), order_no: 'ORD-D2H-2', display_doc_no: 'SO26000002', order_type: 'D2H', company_id: u('hq'), buyer_org_id: u('dist-b'), seller_org_id: u('hq'), warehouse_org_id: u('wh-1'), created_by: u('u-creator') },
    { id: u('o-h2m-a'), order_no: 'ORD-H2M-1', display_doc_no: 'PO26000001', order_type: 'H2M', company_id: u('hq'), buyer_org_id: u('hq'), seller_org_id: u('mfg-a'), warehouse_org_id: u('wh-1'), created_by: u('u-creator') },
    { id: u('o-h2m-b'), order_no: 'ORD-H2M-2', display_doc_no: 'PO26000002', order_type: 'H2M', company_id: u('hq'), buyer_org_id: u('hq'), seller_org_id: u('mfg-b'), warehouse_org_id: u('wh-1'), created_by: u('u-creator') },
    { id: u('o-s2d'), order_no: 'ORD-S2D-1', display_doc_no: 'SO26000003', order_type: 'S2D', company_id: u('hq'), buyer_org_id: u('shop-1'), seller_org_id: u('dist-eariel'), warehouse_org_id: null, created_by: u('u-creator') },
    { id: u('o-other'), order_no: 'ORD-X', display_doc_no: 'SO26000099', order_type: 'D2H', company_id: u('hq-2'), buyer_org_id: u('dist-b'), seller_org_id: u('hq-2'), warehouse_org_id: null, created_by: u('u-creator') },
  ]
  const documents = [
    { id: u('doc-po-a'), order_id: u('o-h2m-a'), doc_type: 'PO', doc_no: 'PO-ORD-H2M-1', company_id: u('hq'), issued_by_org_id: u('hq'), issued_to_org_id: u('mfg-a') },
    { id: u('doc-po-b'), order_id: u('o-h2m-b'), doc_type: 'PO', doc_no: 'PO-ORD-H2M-2', company_id: u('hq'), issued_by_org_id: u('hq'), issued_to_org_id: u('mfg-b') },
    { id: u('doc-inv-eariel'), order_id: u('o-d2h-eariel'), doc_type: 'INVOICE', doc_no: 'INV-ORD-D2H-1', company_id: u('hq'), issued_by_org_id: u('hq'), issued_to_org_id: u('dist-eariel') },
  ]
  const users = [
    { id: u('u-creator'), full_name: 'Cara Creator', phone: '+60129999999', email: 'cara@serapod.test', organization_id: u('hq'), role_code: 'HQ_ADMIN', is_active: true },
    { id: u('u-sales'), full_name: 'Sam Sales', phone: '+60128888888', email: 'sam@serapod.test', organization_id: u('hq'), role_code: 'USER', is_active: true },
    // Same phone as Eariel's organization contact: must not be sent twice.
    { id: u('u-eariel-owner'), full_name: 'Eariel Owner', phone: '0123456001', email: 'ORDERS@eariel.test', organization_id: u('dist-eariel'), role_code: 'DIST_ADMIN', is_active: true },
    { id: u('u-gone'), full_name: 'Gone User', phone: '+60127777777', email: 'gone@serapod.test', organization_id: u('hq'), role_code: 'USER', is_active: false },
  ]
  return { organizations, orders, documents, users }
}
