import { describe, expect, it } from 'vitest'
import {
    CHANNEL_STATUSES,
    UNMAPPED_MODULE_ID,
    annotateRecords,
    applyMonitorQuery,
    dateRangeBounds,
    errorSummary,
    monitorCsv,
    normalizeWhatsAppStatus,
    parseMonitorFilters,
    referenceFrom,
    type MonitorFilters,
    type MonitorRecord,
    type TypeCatalogEntry,
} from './monitorCore'
import { smsToMonitorRecord, whatsAppToMonitorRecord } from './channelLoaders'

const catalog = new Map<string, TypeCatalogEntry>([
    ['order_submitted', { event_code: 'order_submitted', event_name: 'Order Submitted', category: 'order' }],
    ['order_approved', { event_code: 'order_approved', event_name: 'Order Approved', category: 'order' }],
    ['qr_batch_generated', { event_code: 'qr_batch_generated', event_name: 'QR Batch Generated', category: 'order' }],
    ['user_created_shop', { event_code: 'user_created_shop', event_name: 'User Create New Shop', category: 'user' }],
    ['roadtour_qr_delivery', { event_code: 'roadtour_qr_delivery', event_name: 'RoadTour QR Delivery', category: 'roadtour' }],
])

let seq = 0
function record(overrides: Partial<MonitorRecord>): MonitorRecord {
    seq += 1
    return {
        id: `r${seq}`, channel: 'sms', kind: 'original', createdAt: `2026-10-01T0${seq % 10}:00:00.000Z`, status: 'sent', rawStatus: 'sent',
        recipient: `+6012000000${seq % 10}`, eventCode: 'order_submitted', provider: 'local_my', reference: null, ...overrides,
    }
}

const filters = (overrides: Partial<MonitorFilters> = {}): MonitorFilters => ({
    channel: 'sms', q: '', module: 'all', type: 'all', from: '2026-09-25', to: '2026-10-01', status: 'all', provider: 'all', kind: 'original', page: 1, pageSize: 2, ...overrides,
})

function dataset() {
    seq = 0
    return annotateRecords([
        record({ eventCode: 'order_submitted', status: 'failed', recipient: '+60111111111', provider: 'local_my' }),
        record({ eventCode: 'order_submitted', status: 'sent' }),
        record({ eventCode: 'order_approved', status: 'delivered' }),
        record({ eventCode: 'order_approved', status: 'failed', provider: 'other_gw' }),
        record({ eventCode: 'user_created_shop', status: 'pending' }),
        record({ eventCode: 'legacy_ping', status: 'failed' }),
        record({ eventCode: 'roadtour_qr_delivery', status: 'sent' }),
    ], catalog)
}

describe('applyMonitorQuery', () => {
    it('applies search, module, type and provider to every row before paginating', () => {
        const result = applyMonitorQuery(dataset(), filters({ module: 'supply_chain', provider: 'local_my', pageSize: 1 }))
        expect(result.matchingBeforeStatus).toBe(3)
        expect(result.total).toBe(3)
        expect(result.totalPages).toBe(3)
        expect(result.rows).toHaveLength(1)
        const page3 = applyMonitorQuery(dataset(), filters({ module: 'supply_chain', provider: 'local_my', pageSize: 1, page: 3 }))
        expect(page3.rows).toHaveLength(1)
        expect(page3.rows[0].id).not.toBe(result.rows[0].id)
    })

    it('counts every status under the other filters and the status filter narrows only the rows', () => {
        const all = applyMonitorQuery(dataset(), filters({ module: 'supply_chain' }))
        const failed = applyMonitorQuery(dataset(), filters({ module: 'supply_chain', status: 'failed' }))
        expect(failed.statusCounts).toEqual(all.statusCounts)
        expect(all.statusCounts).toMatchObject({ failed: 2, sent: 1, delivered: 1, pending: 0 })
        expect(Object.values(all.statusCounts).reduce((sum, n) => sum + n, 0)).toBe(all.matchingBeforeStatus)
        expect(failed.total).toBe(2)
        expect(failed.rows.every((row) => row.status === 'failed')).toBe(true)
    })

    it('search matches recipient digits and readable names', () => {
        expect(applyMonitorQuery(dataset(), filters({ q: '0111 111', pageSize: 50 })).total).toBe(1)
        expect(applyMonitorQuery(dataset(), filters({ q: 'new shop', pageSize: 50 })).rows.map((row) => row.eventCode)).toEqual(['user_created_shop'])
    })

    it('narrows type choices by module through the facets and keeps unmapped events reachable', () => {
        const result = applyMonitorQuery(dataset(), filters({ pageSize: 50 }))
        expect(result.facets.modules.map((m) => m.value)).toEqual(['customer_growth', 'platform_settings', 'supply_chain', UNMAPPED_MODULE_ID])
        expect(result.facets.modules.at(-1)?.label).toBe('Other / Unmapped')
        const supplyTypes = result.facets.types.filter((t) => t.moduleId === 'supply_chain').map((t) => t.value)
        expect(supplyTypes.sort()).toEqual(['order_approved', 'order_submitted'])
        const unmapped = applyMonitorQuery(dataset(), filters({ module: UNMAPPED_MODULE_ID, pageSize: 50 }))
        expect(unmapped.rows.map((row) => [row.eventCode, row.notificationName])).toEqual([['legacy_ping', 'Legacy ping']])
    })

    it('clamps an out-of-range page instead of returning an empty page', () => {
        const result = applyMonitorQuery(dataset(), filters({ page: 99 }))
        expect(result.filters.page).toBe(result.totalPages)
        expect(result.rows.length).toBeGreaterThan(0)
    })
})

describe('WhatsApp kinds and statuses', () => {
    const wa = (purpose: string, status: string, id: string) => whatsAppToMonitorRecord({
        id, purpose, status, eventType: purpose === 'password_reset' ? 'password_reset_otp_sent' : 'wa_recovery_sent', createdAt: '2026-10-01T01:00:00.000Z',
        recipientPhone: '+60123456789', contactName: 'Una', provider: 'baileys', latestRecovery: purpose === 'password_reset' && status === 'failed'
            ? { status: 'recovery_sent', sentAt: '2026-10-01T02:00:00.000Z', createdAt: '2026-10-01T02:00:00.000Z', messageTemplate: 'password_reset_recovery', messageBody: 'Hi', errorMessage: null }
            : null,
    })

    it('keeps recovery messages out of the original notification counts', () => {
        const rows = annotateRecords([
            wa('password_reset', 'failed', 'a'),
            wa('password_reset_recovery', 'recovery_sent', 'b'),
            wa('password_reset_recovery', 'delivered', 'c'),
        ], catalog)
        const originals = applyMonitorQuery(rows, filters({ channel: 'whatsapp', pageSize: 50 }))
        expect(originals.statusCounts).toMatchObject({ failed: 1, sent: 0, delivered: 0 })
        expect(originals.kindCounts).toEqual({ original: 1, recovery: 2 })
        expect(originals.rows[0].recovery?.status).toBe('recovery_sent')
        const recovery = applyMonitorQuery(rows, filters({ channel: 'whatsapp', kind: 'recovery', pageSize: 50 }))
        expect(recovery.statusCounts).toMatchObject({ sent: 1, delivered: 1 })
    })

    it('maps raw statuses to their meaning and keeps resolution separate from delivery', () => {
        expect(normalizeWhatsAppStatus('send_failed')).toBe('failed')
        expect(normalizeWhatsAppStatus('recovery_sent')).toBe('sent')
        expect(normalizeWhatsAppStatus('verified')).toBe('resolved')
        expect(normalizeWhatsAppStatus('queued')).toBe('pending')
        expect(normalizeWhatsAppStatus('rate_limited')).toBe('other')
        expect(CHANNEL_STATUSES.sms).not.toContain('read')
        expect(CHANNEL_STATUSES.email).not.toContain('read')
    })
})

describe('dates and filters', () => {
    it('uses Malaysia-time day boundaries', () => {
        expect(dateRangeBounds('2026-10-01', '2026-10-01')).toEqual({ sinceIso: '2026-09-30T16:00:00.000Z', untilIso: '2026-10-01T15:59:59.999Z' })
    })

    it('defaults to the last 7 Malaysia days and repairs reversed ranges', () => {
        const at = new Date('2026-10-01T17:30:00.000Z') // 2 Oct 01:30 in Malaysia
        expect(parseMonitorFilters(new URLSearchParams(''), at)).toMatchObject({ channel: 'whatsapp', from: '2026-09-26', to: '2026-10-02', status: 'all', kind: 'original', page: 1 })
        expect(parseMonitorFilters(new URLSearchParams('channel=sms&from=2026-10-05&to=2026-10-01&kind=recovery'), at)).toMatchObject({ from: '2026-10-01', to: '2026-10-05', kind: 'original' })
    })
})

describe('records and export', () => {
    it('builds references for orders, QR batches and returns', () => {
        expect(referenceFrom({ order_no: 'x' }, { orderNo: 'ORD1', orderId: 'o1' })).toEqual({ kind: 'order', label: 'ORD1', id: 'o1' })
        expect(referenceFrom({ batch_id: 'abcdef1234' })).toMatchObject({ kind: 'qr_batch', label: 'QR batch abcdef12' })
        expect(referenceFrom({ return_no: 'RT1' })).toMatchObject({ kind: 'return', label: 'RT1' })
    })

    it('keeps the stored key and readable name in the export', () => {
        const rows = annotateRecords([smsToMonitorRecord({ id: '1', source: 'log', status: 'failed', rawStatus: 'error', phone: '+601', eventCode: 'order_submitted', providerName: 'local_my', errorMessage: 'Gateway timeout', orderNo: 'ORD1', createdAt: '2026-10-01T00:00:00Z' })], catalog)
        const csv = monitorCsv(rows)
        expect(csv.split('\n')[1]).toContain('"Order Submitted","order_submitted","Supply Chain","ORD1","Failed","error"')
        expect(errorSummary('Gateway timeout after 15s')).toBe('Provider timed out')
    })
})
