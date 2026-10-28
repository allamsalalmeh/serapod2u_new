import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ORDER_EVENT_COPY, ORDER_EVENT_NAME_OVERRIDES, orderEventCopy } from './notificationOrderCopy'
import { EVENT_DISPLAY_GROUP, EVENT_SCOPE, groupByModule } from './notificationTypeModules'

/** The 13 events that were audited in the two categories (7 Order Status + 6 Order Document). */
const AUDITED = [
    'order_submitted', 'order_approved', 'order_closed', 'order_rejected',
    'qr_batch_generated', 'manufacturer_scan_complete', 'warehouse_received',
    'po_created', 'po_acknowledged', 'invoice_created', 'invoice_acknowledged',
    'payment_received', 'receipt_issued',
]

/** Events that only exist on the H2M (HQ → manufacturer) flow. */
const H2M_ONLY = ['qr_batch_generated', 'manufacturer_scan_complete', 'warehouse_received', 'po_created', 'po_acknowledged']

const type = (event_code: string, category: string, event_name = event_code, event_description = '') =>
    ({ event_code, category, event_name, event_description })

describe('audited order / document copy', () => {
    it('describes every audited event with "when" and "which transaction"', () => {
        AUDITED.forEach((code) => {
            const copy = ORDER_EVENT_COPY[code]
            expect(copy, code).toBeDefined()
            expect(copy.when.length, code).toBeGreaterThan(20)
            expect(copy.transaction.length, code).toBeGreaterThan(20)
        })
        // Nothing was invented beyond the audited set.
        expect(Object.keys(ORDER_EVENT_COPY).sort()).toEqual([...AUDITED].sort())
    })

    it('replaces the misleading names and keeps every other stored name', () => {
        expect(orderEventCopy(type('manufacturer_scan_complete', 'order', 'Manufacture Completed His Order')).name).toBe('Manufacture Completed')
        expect(orderEventCopy(type('warehouse_received', 'order', 'Warehouse Receive Order')).name).toBe('Warehouse Received')
        // Names the catalog already gets right are left alone, so history, monitor filters and labels stay valid.
        expect(orderEventCopy(type('order_submitted', 'order', 'Order Submitted')).name).toBe('Order Submitted')
        expect(orderEventCopy(type('po_created', 'document', 'Purchase Order Created')).name).toBe('Purchase Order Created')
        expect(Object.keys(ORDER_EVENT_NAME_OVERRIDES).sort()).toEqual(['manufacturer_scan_complete', 'warehouse_received'])
    })

    it('renders the audited description as "When: … · Transaction: …"', () => {
        const rendered = orderEventCopy(type('po_created', 'document', 'Purchase Order Created')).description
        expect(rendered.startsWith('When: ')).toBe(true)
        expect(rendered).toContain(' · Transaction: ')
        expect(rendered).toContain('H2M only')
    })

    it('leaves events outside the audit on the stored catalog copy', () => {
        const stored = orderEventCopy(type('low_stock_alert', 'inventory', 'Low Stock Alert', 'Sent when stock drops below the reorder point'))
        expect(stored).toEqual({ name: 'Low Stock Alert', description: 'Sent when stock drops below the reorder point' })
    })

    it('shows the stored description when a mapped event has none of its own in the catalog', () => {
        const mapped = orderEventCopy(type('receipt_issued', 'document', 'Receipt Issued', 'stored text'))
        expect(mapped.description).not.toBe('stored text')
        expect(mapped.description).toContain('Transaction:')
    })
})

describe('H2M / D2H applicability is shown, and no event is listed twice', () => {
    it('marks the H2M-only events and leaves shared events unqualified', () => {
        // Production and receiving exist on the H2M flow only, and the badge says so.
        for (const code of ['qr_batch_generated', 'manufacturer_scan_complete', 'warehouse_received']) {
            expect(EVENT_SCOPE[code], code).toContain('H2M')
        }
        // A PO document is labelled by what it is, not by an assumed flow: it follows its order.
        // The audited copy states which flow creates it today (H2M only).
        expect(EVENT_SCOPE.po_created).toBe('PO document · follows its order')
        expect(EVENT_SCOPE.po_acknowledged).toBe('PO document · follows its order')
        expect(ORDER_EVENT_COPY.po_created.transaction).toContain('H2M only')
        // Shared events are not presented as belonging to one flow.
        expect(EVENT_SCOPE.order_submitted).toBe('All order types')
        expect(EVENT_SCOPE.invoice_created).toBe('Follows its order')
        // The H2M-only claim is repeated in the audited copy, so the list and the copy agree.
        H2M_ONLY.forEach((code) => expect(ORDER_EVENT_COPY[code].transaction, code).toContain('H2M'))
    })

    it('lists each audited event exactly once, in the four proven groups', () => {
        const [supply] = groupByModule(AUDITED.map((code) => type(code, code.startsWith('po_') || code.startsWith('invoice_') || code === 'payment_received' || code === 'receipt_issued' ? 'document' : 'order')))
        expect(supply.categories.map((group) => group.label)).toEqual([
            'Sales Orders', 'Purchase Orders', 'Production & Receiving', 'Documents & Payments',
        ])
        const listed = supply.categories.flatMap((group) => group.types.map((item) => item.event_code))
        expect(listed.sort()).toEqual([...AUDITED].sort())
        expect(new Set(listed).size).toBe(AUDITED.length)
        expect(supply.categories.map((group) => group.types.length)).toEqual([4, 2, 3, 4])
    })

    it('keeps each event in the display group its stored category routes through', () => {
        AUDITED.forEach((code) => {
            const group = EVENT_DISPLAY_GROUP[code]
            expect(group, code).toBeDefined()
        })
    })
})

describe('catalog migration matches the app copy', () => {
    const sql = readFileSync(join(__dirname, '../../../../supabase/migrations/20261027160000_notification_types_order_copy.sql'), 'utf8')
    // ('event_code', 'name' | NULL, 'description', true|false)
    const rows = Array.from(sql.matchAll(/\(\s*'([a-z_]+)',\s*(NULL|'(?:[^']|'')*'),\s*'((?:[^']|'')*)',\s*(true|false)\)/g))
        .map(([, code, name, description, ack]) => ({
            code,
            name: name === 'NULL' ? null : name.slice(1, -1).replace(/''/g, "'"),
            description: description.replace(/''/g, "'"),
            ack: ack === 'true',
        }))

    it('writes exactly the audited events, with the same text the page shows', () => {
        expect(rows.map((row) => row.code).sort()).toEqual([...AUDITED].sort())
        for (const row of rows) {
            const shown = orderEventCopy(type(row.code, 'order', row.name ?? 'stored name'))
            expect(row.description, row.code).toBe(shown.description)
            expect(row.name, row.code).toBe(ORDER_EVENT_NAME_OVERRIDES[row.code] ?? null)
        }
    })

    it('holds back only the three acknowledgement events until their trigger exists', () => {
        expect(rows.filter((row) => row.ack).map((row) => row.code).sort()).toEqual(['invoice_acknowledged', 'payment_received', 'po_acknowledged'])
    })

    it('contains no environment or implementation commentary in user-facing text', () => {
        for (const row of rows) expect(row.description, row.code).not.toMatch(/staging|build|migration|trigger/i)
        for (const copy of Object.values(ORDER_EVENT_COPY)) expect(`${copy.when} ${copy.transaction}`).not.toMatch(/staging|build|migration|trigger/i)
    })
})
