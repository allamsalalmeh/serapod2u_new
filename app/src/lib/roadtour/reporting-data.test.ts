import { describe, expect, it } from 'vitest'

import { loadRoadtourReportingDataset } from './reporting-data'
import { AM_NAME_NOT_LOADED_LABEL } from '@/modules/roadtour/lib/reporting/types'

// Kong (nginx) answers HTTP 414 when the request line exceeds 8 KB; production
// logged exactly that for GET /rest/v1/users on 2026-11-03. September needed 200
// user ids (6 AMs + 194 participants) and fitted; October needed 239 (6 + 233)
// and did not. The fake builds the same encoded URL supabase-js sends and
// rejects it past the same limit, so the test fails if a lookup goes back to
// one unbounded request.
const GATEWAY_REQUEST_LINE_LIMIT = 8192

type Row = Record<string, any>

/** Deterministic UUID-shaped ids, so URL lengths match production. */
function uuid(prefix: number, n: number): string {
    return `${String(prefix).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function fakeAdmin(tables: Record<string, Row[]>, failWhen?: (table: string, col: string, values: unknown[]) => boolean) {
    const requestLines: Record<string, number[]> = {}
    function from(table: string) {
        const filters: Array<(row: Row) => boolean> = []
        const url = new URL(`https://gateway.test/rest/v1/${table}`)
        let failed = false
        const builder: any = {
            select: (columns: string) => { url.searchParams.set('select', columns.replace(/\s/g, '')); return builder },
            eq: (col: string, value: unknown) => { filters.push((row) => row[col] === value); return builder },
            gte: (col: string, value: string) => { filters.push((row) => row[col] >= value); return builder },
            lte: (col: string, value: string) => { filters.push((row) => row[col] <= value); return builder },
            in: (col: string, values: unknown[]) => {
                url.searchParams.append(col, `in.(${values.join(',')})`)
                const line = `GET ${url.pathname}${url.search} HTTP/1.1`.length
                ;(requestLines[`${table}.${col}`] ||= []).push(line)
                if (line > GATEWAY_REQUEST_LINE_LIMIT || failWhen?.(table, col, values)) failed = true
                const set = new Set(values)
                filters.push((row) => set.has(row[col]))
                return builder
            },
            order: () => builder,
            limit: () => builder,
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(
                failed
                    ? { data: null, error: { message: 'URI too long', code: '414' } }
                    : { data: (tables[table] || []).filter((row) => filters.every((f) => f(row))), error: null },
            ).then(resolve, reject),
        }
        return builder
    }
    return { admin: { from }, requestLines }
}

const ORG = 'org-1'
const CAMPAIGN = 'camp-1'
const AM_IDS = Array.from({ length: 6 }, (_, i) => uuid(1, i))
const NOW = new Date('2026-11-03T00:00:00Z')

/** A month with six AM visits and `participants` distinct scanning users. */
function seed(month: '2026-09' | '2026-10', participants: number) {
    const day = `${month}-15`
    const visits = AM_IDS.map((am, i) => ({
        id: `visit-${month}-${i}`,
        campaign_id: CAMPAIGN,
        account_manager_user_id: am,
        shop_id: `shop-${i}`,
        visit_date: day,
        visit_status: 'official',
        notes: null,
        official_scan_event_id: `scan-${month}-${i}`,
        created_at: `${day}T02:00:00.000Z`,
    }))
    const scans = Array.from({ length: participants }, (_, i) => ({
        id: `scan-${month}-${i}`,
        campaign_id: CAMPAIGN,
        shop_id: `shop-${i % AM_IDS.length}`,
        scan_time: `${day}T03:00:00.000Z`,
        scanned_by_user_id: uuid(2, i),
        consumer_phone: null,
    }))
    const users = [
        ...AM_IDS.map((id, i) => ({ id, full_name: `Manager ${i}`, phone: null })),
        ...scans.map((scan, i) => ({ id: scan.scanned_by_user_id, full_name: `Participant ${i}`, phone: null })),
    ]
    return { visits, scans, users }
}

function tablesFor(data: ReturnType<typeof seed>, users = data.users) {
    return {
        roadtour_campaigns: [{ id: CAMPAIGN, org_id: ORG, name: 'RoadTour', start_date: '2026-09-01' }],
        roadtour_official_visits: data.visits,
        roadtour_scan_events: data.scans,
        users,
        organizations: AM_IDS.map((_, i) => ({ id: `shop-${i}`, org_name: `Shop ${i}`, branch: null, org_code: null, city: null, state_id: null, states: null })),
        consumer_qr_scans: [],
    }
}

async function load(month: '2026-09' | '2026-10', participants: number) {
    const { admin, requestLines } = fakeAdmin(tablesFor(seed(month, participants)))
    const dataset = await loadRoadtourReportingDataset({ admin, orgId: ORG, monthKey: month, now: NOW })
    return { dataset, requestLines }
}

describe('loadRoadtourReportingDataset identity lookup', () => {
    it('the unbatched October users request would exceed the gateway limit', () => {
        // Guards the premise: one request carrying all 239 ids is over 8 KB, the
        // 200-id September request is under it.
        const line = (n: number) => {
            const url = new URL('https://gateway.test/rest/v1/users')
            url.searchParams.set('select', 'id,full_name,phone')
            url.searchParams.append('id', `in.(${Array.from({ length: n }, (_, i) => uuid(2, i)).join(',')})`)
            return `GET ${url.pathname}${url.search} HTTP/1.1`.length
        }
        expect(line(200)).toBeLessThanOrEqual(GATEWAY_REQUEST_LINE_LIMIT)
        expect(line(239)).toBeGreaterThan(GATEWAY_REQUEST_LINE_LIMIT)
    })

    it('September production volume (200 ids) resolves every account manager without warnings', async () => {
        const { dataset } = await load('2026-09', 194)
        expect(dataset.meta.warnings).toEqual([])
        expect(dataset.rows.every((row) => row.account_manager_name?.startsWith('Manager'))).toBe(true)
    })

    it('October production volume (239 ids) resolves every name with every request under the limit', async () => {
        const { dataset, requestLines } = await load('2026-10', 233)
        expect(dataset.meta.warnings).toEqual([])
        expect(dataset.rows).toHaveLength(AM_IDS.length)
        expect(dataset.rows.map((row) => row.account_manager_user_id).sort()).toEqual([...AM_IDS].sort())
        expect(dataset.rows.every((row) => row.account_manager_name?.startsWith('Manager'))).toBe(true)
        expect(dataset.rows.every((row) => row.latest_participant_name?.startsWith('Participant'))).toBe(true)
        for (const lines of Object.values(requestLines)) {
            expect(Math.max(...lines)).toBeLessThanOrEqual(GATEWAY_REQUEST_LINE_LIMIT)
        }
        // 239 unique ids in batches of 100: each id requested exactly once.
        expect(requestLines['users.id']).toHaveLength(3)
    })

    it('a failed batch keeps its managers assigned and warns, instead of reporting them as Unassigned', async () => {
        const data = seed('2026-10', 233)
        // Fail every attempt of the users batch that carries the first AM.
        const { admin } = fakeAdmin(tablesFor(data), (table, col, values) => table === 'users' && col === 'id' && values.includes(AM_IDS[0]))
        const dataset = await loadRoadtourReportingDataset({ admin, orgId: ORG, monthKey: '2026-10', now: NOW })

        expect(dataset.meta.warnings).toEqual(['Account manager and participant names could not be loaded for this report.'])
        const failedRow = dataset.rows.find((row) => row.visit_id === 'visit-2026-10-0')!
        expect(failedRow.account_manager_user_id).toBe(AM_IDS[0])
        expect(failedRow.account_manager_name).toBe(AM_NAME_NOT_LOADED_LABEL)
        expect(dataset.rows.every((row) => row.account_manager_user_id)).toBe(true)
    })

    it('still reports a genuinely missing account manager as unresolved', async () => {
        const data = seed('2026-10', 10)
        const { admin } = fakeAdmin(tablesFor(data, data.users.filter((user) => user.id !== AM_IDS[0])))
        const dataset = await loadRoadtourReportingDataset({ admin, orgId: ORG, monthKey: '2026-10', now: NOW })
        expect(dataset.meta.warnings).toEqual([
            '1 account manager record(s) could not be resolved; their visits are reported as Unassigned.',
        ])
        expect(dataset.rows.find((row) => row.visit_id === 'visit-2026-10-0')!.account_manager_user_id).toBeNull()
    })
})
