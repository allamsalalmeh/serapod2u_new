import 'server-only'

// Shared server-side loader for RoadTour Reporting.
//
// Why this runs on the server: every name shown in these reports (account
// manager, shop, participant) lives in `users`/`organizations`, which are
// RLS-scoped to the viewer's own organization. Reading them from the browser
// silently dropped rows — an HQ Power User could only see 6 of 7 account
// managers and 4 of 199 scan participants, which is what produced the blank
// "—" account manager and the "Unknown customer" scan rows. The API route in
// front of this loader enforces the same permission and organization scope that
// `roadtour_official_visits` RLS enforces (role_level <= 20, own organization),
// and the loader then resolves display names with the service role so the
// numbers are complete and reproducible for everyone allowed to see the report.

import {
    classifyShopOutcome,
    computeScanLiftPercent,
    DAY_MS,
    daysSinceVisit,
    isObservationMature,
    normalizeImpactWindowDays,
    observationMaturesAt,
} from '@/modules/roadtour/lib/reporting/impactModel'
import { attributeShopVisits } from '@/modules/roadtour/lib/reporting/attribution'
import {
    buildUserPhoneIndex,
    normalizeParticipantPhone,
    resolveParticipantIdentity,
    type IdentityUser,
} from '@/modules/roadtour/lib/reporting/identity'
import { bucketScansAroundAnchor, resolveVisitAnchorIso } from '@/modules/roadtour/lib/reporting/scanWindow'
import { reportingCutoffDate, resolveReportingMonth } from '@/modules/roadtour/lib/reporting/month'
import { resolveShopDisplay } from '@/modules/roadtour/lib/reporting/shopDisplay'
import { selectInChunks } from '@/modules/roadtour/lib/reporting/chunkedIn'
import type {
    ReportingFilterOption,
    RoadtourReportingDataset,
    RoadtourVisitReportRow,
} from '@/modules/roadtour/lib/reporting/types'
import { AM_NAME_NOT_LOADED_LABEL } from '@/modules/roadtour/lib/reporting/types'

/** Visit statuses that represent a real field visit. */
const REPORTABLE_VISIT_STATUSES = ['official', 'manual']
const SHOP_CHUNK_SIZE = 150
const MAX_VISITS = 5000

export interface LoadReportingParams {
    admin: any
    orgId: string
    monthKey: string
    windowDays?: number
    campaignId?: string | null
    accountManagerUserId?: string | null
    regionStateId?: string | null
    /**
     * Shop Follow-Up sets this so the report reaches back to the start of the
     * campaigns in scope instead of stopping at the selected month. The floor is
     * the campaign start date rather than a month count on purpose: a follow-up
     * stays visible until it is resolved, and must never drop out of sight
     * merely because N calendar months have passed. Monthly Overview and AM
     * Performance leave it false and stay strictly month-scoped.
     */
    carryForwardOpenItems?: boolean
    now?: Date
}

interface VisitRecord {
    id: string
    campaign_id: string
    account_manager_user_id: string | null
    shop_id: string
    visit_date: string
    visit_status: string
    notes: string | null
    official_scan_event_id: string | null
    created_at: string
}

interface ScanEventRecord {
    id: string
    shop_id: string | null
    scan_time: string
    scanned_by_user_id: string | null
    consumer_phone: string | null
}

interface ConsumerScanRecord {
    id: string
    shop_id: string
    scanned_at: string
}

function emptyDataset(
    monthKey: string,
    windowDays: number,
    now: Date,
    warning: string | null,
    carryForwardFromDate: string | null = null,
): RoadtourReportingDataset {
    const month = resolveReportingMonth(monthKey, now)
    return {
        rows: [],
        campaigns: [],
        accountManagers: [],
        regions: [],
        meta: {
            monthKey: month.key,
            monthLabel: month.label,
            isCurrentMonth: month.isCurrentMonth,
            cutoffDate: reportingCutoffDate(month, now),
            windowDays,
            generatedAt: now.toISOString(),
            unassignedVisitCount: 0,
            unassignedShopCount: 0,
            carryForwardFromDate,
            warnings: warning ? [warning] : [],
        },
    }
}

function normalizeText(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

export async function loadRoadtourReportingDataset(params: LoadReportingParams): Promise<RoadtourReportingDataset> {
    const now = params.now ?? new Date()
    const month = resolveReportingMonth(params.monthKey, now)
    const windowDays = normalizeImpactWindowDays(params.windowDays)
    const warnings: string[] = []



    const { data: campaignRows, error: campaignError } = await params.admin
        .from('roadtour_campaigns')
        .select('id, name, start_date')
        .eq('org_id', params.orgId)
    if (campaignError) throw campaignError

    const campaigns: ReportingFilterOption[] = (campaignRows || []).map((row: any) => ({
        id: row.id,
        name: normalizeText(row.name) || 'Untitled campaign',
    }))
    const campaignStartDates = (campaignRows || [])
        .map((row: any) => normalizeText(row.start_date))
        .filter(Boolean) as string[]
    if (campaigns.length === 0) {
        return emptyDataset(month.key, windowDays, now, 'No RoadTour campaigns exist for this organization yet.')
    }

    const campaignIds = campaigns.map((campaign) => campaign.id)
    const campaignNameById = new Map(campaigns.map((campaign) => [campaign.id, campaign.name]))

    // The selected month always bounds the END of the report — looking at August
    // never shows a September visit. For Shop Follow-Up the START drops to the
    // earliest campaign start instead, so an unresolved shop stays in the queue
    // for as long as its campaign's work is on the books. Deliberately NOT a
    // rolling window of N months: that would silently retire outstanding work.
    const carryForwardFrom = params.carryForwardOpenItems && campaignStartDates.length > 0
        ? campaignStartDates.reduce((earliest, value) => (value < earliest ? value : earliest))
        : null
    const visitFromDate = carryForwardFrom && carryForwardFrom < month.startDate
        ? carryForwardFrom
        : month.startDate
    const carryForwardFromDate = visitFromDate < month.startDate ? visitFromDate : null

    // ── Official visits inside the reporting window ─────────────────────────
    let visitQuery = params.admin
        .from('roadtour_official_visits')
        .select('id, campaign_id, account_manager_user_id, shop_id, visit_date, visit_status, notes, official_scan_event_id, created_at')
        .in('campaign_id', campaignIds)
        .in('visit_status', REPORTABLE_VISIT_STATUSES)
        .gte('visit_date', visitFromDate)
        .lte('visit_date', month.endDate)
    if (params.campaignId) visitQuery = visitQuery.eq('campaign_id', params.campaignId)
    if (params.accountManagerUserId) visitQuery = visitQuery.eq('account_manager_user_id', params.accountManagerUserId)

    const { data: visitRows, error: visitError } = await visitQuery
        .order('visit_date', { ascending: false })
        .limit(MAX_VISITS)
    if (visitError) throw visitError

    const visits = (visitRows || []) as VisitRecord[]
    if (visits.length === 0) {
        return emptyDataset(month.key, windowDays, now, null, carryForwardFromDate)
    }

    const shopIds = Array.from(new Set(visits.map((visit) => visit.shop_id).filter(Boolean)))
    const officialScanIds = Array.from(new Set(visits.map((visit) => visit.official_scan_event_id).filter(Boolean))) as string[]

    // ── Official scan events: the impact anchor and the visit participant ───
    const scanEventsByShop = new Map<string, ScanEventRecord[]>()
    const officialScanById = new Map<string, ScanEventRecord>()
    const scanWindowFrom = new Date(new Date(`${visitFromDate}T00:00:00+08:00`).getTime() - windowDays * DAY_MS).toISOString()
    const scanWindowTo = new Date(new Date(month.endUtc).getTime() + windowDays * DAY_MS).toISOString()

    const { data: scanEventRows, error: scanEventError } = await params.admin
        .from('roadtour_scan_events')
        .select('id, shop_id, scan_time, scanned_by_user_id, consumer_phone')
        .in('campaign_id', campaignIds)
        .gte('scan_time', scanWindowFrom)
        .lte('scan_time', scanWindowTo)
        .limit(50000)
    if (scanEventError) {
        warnings.push('RoadTour scan events could not be loaded — visit participants may be missing.')
    }

    for (const row of ((scanEventRows || []) as ScanEventRecord[])) {
        officialScanById.set(row.id, row)
        if (!row.shop_id) continue
        const list = scanEventsByShop.get(row.shop_id) || []
        list.push(row)
        scanEventsByShop.set(row.shop_id, list)
    }

    // Official scans can sit outside the fetched window (a visit recorded late);
    // fetch any that are still missing so every row keeps a real anchor.
    const missingOfficialScanIds = officialScanIds.filter((id) => !officialScanById.has(id))
    if (missingOfficialScanIds.length > 0) {
        const { data: extraScans, error: extraScanError } = await selectInChunks<ScanEventRecord>(
            missingOfficialScanIds,
            (chunk) => params.admin
                .from('roadtour_scan_events')
                .select('id, shop_id, scan_time, scanned_by_user_id, consumer_phone')
                .in('id', chunk),
        )
        if (extraScanError) {
            warnings.push('Some official visit scans could not be loaded — those visits fall back to the visit date.')
        }
        for (const row of ((extraScans || []) as ScanEventRecord[])) officialScanById.set(row.id, row)
    }

    // ── Identity + shop enrichment (service role: RLS-complete) ─────────────
    // Every `.in(...)` lookup is chunked: a month with a few hundred participants
    // otherwise exceeds the gateway URL limit (HTTP 414) and loses every name.
    const amIds = Array.from(new Set(visits.map((visit) => visit.account_manager_user_id).filter(Boolean))) as string[]
    const participantIds = Array.from(new Set(
        Array.from(officialScanById.values()).map((scan) => scan.scanned_by_user_id).filter(Boolean),
    )) as string[]
    const userIds = Array.from(new Set([...amIds, ...participantIds]))

    const [userResult, shopResult] = await Promise.all([
        selectInChunks<any>(userIds, (chunk) => params.admin
            .from('users')
            .select('id, full_name, phone')
            .in('id', chunk)),
        selectInChunks<any>(shopIds, (chunk) => params.admin
            .from('organizations')
            .select('id, org_name, branch, org_code, city, state_id, states:state_id(state_name)')
            .in('id', chunk)),
    ])

    if (userResult.error) {
        console.warn('[roadtour-reporting] users lookup failed', userResult.error)
        warnings.push('Account manager and participant names could not be loaded for this report.')
    }
    if (shopResult.error) {
        warnings.push('Shop details could not be loaded for this report.')
    }

    const usersById = new Map<string, IdentityUser>(
        ((userResult.data || []) as any[]).map((user) => [user.id, {
            id: user.id,
            full_name: normalizeText(user.full_name),
            phone: normalizeText(user.phone),
        }]),
    )

    // Participants whose scan carries only a phone still resolve to a registered
    // user when that phone normalises to the same E.164 number.
    const participantPhones = Array.from(new Set(
        Array.from(officialScanById.values())
            .map((scan) => normalizeParticipantPhone(scan.consumer_phone))
            .filter(Boolean),
    ))
    const phoneMatchedUsers: IdentityUser[] = []
    if (participantPhones.length > 0) {
        const { data: phoneUsers, error: phoneUserError } = await selectInChunks<any>(
            participantPhones,
            (chunk) => params.admin
                .from('users')
                .select('id, full_name, phone')
                .in('phone', chunk),
        )
        if (phoneUserError) {
            warnings.push('Participant lookup by phone failed — some participants may show without a name.')
        }
        for (const user of ((phoneUsers || []) as any[])) {
            const record: IdentityUser = {
                id: user.id,
                full_name: normalizeText(user.full_name),
                phone: normalizeText(user.phone),
            }
            phoneMatchedUsers.push(record)
            if (!usersById.has(record.id)) usersById.set(record.id, record)
        }
    }
    const usersByPhone = buildUserPhoneIndex([...usersById.values(), ...phoneMatchedUsers])

    const shopsById = new Map<string, {
        id: string; org_name: string | null; branch: string | null; code: string | null
        city: string | null; state_id: string | null; state_name: string | null
    }>(((shopResult.data || []) as any[]).map((shop) => [shop.id, {
        id: shop.id,
        org_name: normalizeText(shop.org_name),
        branch: normalizeText(shop.branch),
        code: normalizeText(shop.org_code),
        city: normalizeText(shop.city),
        state_id: shop.state_id ?? null,
        state_name: normalizeText(Array.isArray(shop.states) ? shop.states[0]?.state_name : shop.states?.state_name),
    }]))

    // ── Region filter is applied once shops are known ───────────────────────
    const scopedVisits = params.regionStateId
        ? visits.filter((visit) => shopsById.get(visit.shop_id)?.state_id === params.regionStateId)
        : visits
    if (scopedVisits.length === 0) {
        const dataset = emptyDataset(month.key, windowDays, now, null, carryForwardFromDate)
        dataset.campaigns = campaigns
        dataset.regions = buildRegionOptions(shopsById)
        dataset.accountManagers = buildAmOptions(amIds, usersById)
        dataset.meta.warnings = warnings
        return dataset
    }

    // ── Consumer product-QR scans: the impact signal ────────────────────────
    //
    // The official visit scan lives in `roadtour_scan_events` (a RoadTour campaign
    // QR); impact is measured from `consumer_qr_scans` (product QRs). The two
    // tables share no rows and no QR ids, so the scan that established the visit
    // can never, by itself, prove post-visit activation. Anchoring the windows on
    // the official scan's timestamp additionally keeps activity that happened
    // BEFORE the account manager arrived out of the "after" bucket.
    const targetShopIds = Array.from(new Set(scopedVisits.map((visit) => visit.shop_id)))
    const anchors = scopedVisits.map((visit) => visitAnchorFor(visit, officialScanById))
    const earliestAnchor = anchors.reduce((min, value) => (value < min ? value : min))
    const latestAnchor = anchors.reduce((max, value) => (value > max ? value : max))
    const scanFrom = new Date(new Date(earliestAnchor).getTime() - windowDays * DAY_MS).toISOString()
    const scanTo = new Date(new Date(latestAnchor).getTime() + windowDays * DAY_MS).toISOString()

    const consumerScansByShop = new Map<string, ConsumerScanRecord[]>()
    try {
        for (let index = 0; index < targetShopIds.length; index += SHOP_CHUNK_SIZE) {
            const chunk = targetShopIds.slice(index, index + SHOP_CHUNK_SIZE)
            const { data, error } = await params.admin
                .from('consumer_qr_scans')
                .select('id, shop_id, scanned_at')
                .in('shop_id', chunk)
                // Manual point adjustments are an admin action, not shop activity,
                // so they never count as a response to a visit. Shop Performance
                // applies the same exclusion, keeping one definition of a scan
                // across both reports.
                .eq('is_manual_adjustment', false)
                .gte('scanned_at', scanFrom)
                .lte('scanned_at', scanTo)
                .limit(100000)
            if (error) throw error
            for (const scan of ((data || []) as ConsumerScanRecord[])) {
                if (!scan.shop_id || !scan.scanned_at) continue
                const list = consumerScansByShop.get(scan.shop_id) || []
                list.push(scan)
                consumerScansByShop.set(scan.shop_id, list)
            }
        }
    } catch (error) {
        console.warn('[roadtour-reporting] consumer_qr_scans fetch failed', error)
        warnings.push('Product QR scan data could not be loaded — before/after scan counts are incomplete.')
        consumerScansByShop.clear()
    }

    for (const list of consumerScansByShop.values()) {
        list.sort((a, b) => a.scanned_at.localeCompare(b.scanned_at))
    }

    // ── Build the typed rows ────────────────────────────────────────────────
    const rows: RoadtourVisitReportRow[] = scopedVisits.map((visit) => {
        const officialScan = visit.official_scan_event_id ? officialScanById.get(visit.official_scan_event_id) || null : null
        const anchorIso = visitAnchorFor(visit, officialScanById)
        const anchorMs = new Date(anchorIso).getTime()

        const shop = shopsById.get(visit.shop_id) || null
        const shopDisplay = resolveShopDisplay({
            shopName: shop?.org_name ?? null,
            branch: shop?.branch ?? null,
        })

        const { beforeScans, afterScans, firstScanAfterAt, lastScanAfterAt } = bucketScansAroundAnchor(
            consumerScansByShop.get(visit.shop_id) || [],
            anchorIso,
            windowDays,
        )

        const matured = isObservationMature(anchorIso, windowDays, now)
        const outcome = classifyShopOutcome({ beforeScans, afterScans, matured })
        const participants = resolveParticipants({
            shopId: visit.shop_id,
            anchorMs,
            windowDays,
            officialScan,
            scanEventsByShop,
            usersById,
            usersByPhone,
        })

        const amUser = visit.account_manager_user_id ? usersById.get(visit.account_manager_user_id) || null : null
        // A failed lookup proves nothing about the assignment, so the visit keeps
        // its AM instead of silently moving into Unassigned.
        const amNotLoaded = !amUser && Boolean(visit.account_manager_user_id)
            && userResult.failedValues.has(visit.account_manager_user_id as string)

        return {
            visit_id: visit.id,
            visit_date: visit.visit_date,
            visit_at: anchorIso,
            visit_at_from_official_scan: Boolean(officialScan?.scan_time),
            campaign_id: visit.campaign_id,
            campaign_name: campaignNameById.get(visit.campaign_id) || 'Untitled campaign',
            account_manager_user_id: amUser ? amUser.id : amNotLoaded ? visit.account_manager_user_id : null,
            account_manager_name: amUser?.full_name ?? (amNotLoaded ? AM_NAME_NOT_LOADED_LABEL : null),
            shop_id: visit.shop_id,
            shop_name: shopDisplay.fullLabel,
            shop_name_primary: shopDisplay.primaryName,
            shop_branch_label: shopDisplay.branchLabel,
            shop_code: shop?.code ?? null,
            shop_region: shop?.state_name ?? shop?.city ?? null,
            shop_state_id: shop?.state_id ?? null,
            participant_count: participants.count,
            latest_participant_name: participants.latestName,
            latest_participant_phone: participants.latestPhone,
            before_scans: beforeScans,
            after_scans: afterScans,
            scan_lift: afterScans - beforeScans,
            scan_lift_percent: computeScanLiftPercent(beforeScans, afterScans),
            window_days: windowDays,
            matured,
            matures_at: new Date(observationMaturesAt(anchorIso, windowDays)).toISOString(),
            days_since_visit: daysSinceVisit(anchorIso, now),
            outcome,
            first_scan_after_at: firstScanAfterAt,
            last_scan_after_at: lastScanAfterAt,
            is_current_for_shop: false,
            is_attributed_for_shop: false,
            notes: normalizeText(visit.notes),
        }
    })

    const attribution = attributeShopVisits(rows.map((row) => ({
        visit_id: row.visit_id,
        shop_id: row.shop_id,
        visit_at: row.visit_at,
        matured: row.matured,
        window_days: row.window_days,
    })))
    const currentVisitIds = new Set(Array.from(attribution.values()).map((shop) => shop.currentRow.visit_id))
    const attributedVisitIds = new Set(
        Array.from(attribution.values())
            .map((shop) => shop.attributedRow?.visit_id)
            .filter(Boolean) as string[],
    )
    for (const row of rows) {
        row.is_current_for_shop = currentVisitIds.has(row.visit_id)
        row.is_attributed_for_shop = attributedVisitIds.has(row.visit_id)
    }

    // An AM whose lookup request failed is "not loaded", already covered by the
    // names warning above; only a completed lookup that found no user row proves
    // the record cannot be resolved.
    const unresolvedAmIds = amIds.filter((id) => !usersById.has(id) && !userResult.failedValues.has(id))
    if (unresolvedAmIds.length > 0) {
        warnings.push(`${unresolvedAmIds.length} account manager record(s) could not be resolved; their visits are reported as Unassigned.`)
    }

    const unassignedRows = rows.filter((row) => !row.account_manager_user_id)

    return {
        rows,
        campaigns,
        accountManagers: buildAmOptions(amIds, usersById),
        regions: buildRegionOptions(shopsById),
        meta: {
            monthKey: month.key,
            monthLabel: month.label,
            isCurrentMonth: month.isCurrentMonth,
            cutoffDate: reportingCutoffDate(month, now),
            windowDays,
            generatedAt: now.toISOString(),
            unassignedVisitCount: unassignedRows.length,
            unassignedShopCount: new Set(unassignedRows.map((row) => row.shop_id)).size,
            carryForwardFromDate,
            warnings,
        },
    }
}

/** Impact anchor for a visit — the official scan instant, else the visit date. */
function visitAnchorFor(visit: VisitRecord, officialScanById: Map<string, ScanEventRecord>): string {
    const scan = visit.official_scan_event_id ? officialScanById.get(visit.official_scan_event_id) : null
    return resolveVisitAnchorIso(visit.visit_date, scan?.scan_time ?? null)
}

/**
 * Participants come from the RoadTour scan events recorded at the shop inside the
 * visit's observation window. Identity resolves by user id, then by normalised
 * phone, then by phone alone — so a real participant is never reduced to a dash.
 */
function resolveParticipants(input: {
    shopId: string
    anchorMs: number
    windowDays: number
    officialScan: ScanEventRecord | null
    scanEventsByShop: Map<string, ScanEventRecord[]>
    usersById: Map<string, IdentityUser>
    usersByPhone: Map<string, IdentityUser>
}): { count: number; latestName: string | null; latestPhone: string | null } {
    const windowMs = input.windowDays * DAY_MS
    const inWindow = (input.scanEventsByShop.get(input.shopId) || []).filter((scan) => {
        const offset = new Date(scan.scan_time).getTime() - input.anchorMs
        return offset >= -windowMs && offset <= windowMs
    })

    const identities = new Set<string>()
    for (const scan of [...inWindow, ...(input.officialScan ? [input.officialScan] : [])]) {
        const identity = resolveParticipantIdentity({
            scannedByUserId: scan.scanned_by_user_id,
            consumerPhone: scan.consumer_phone,
            usersById: input.usersById,
            usersByPhone: input.usersByPhone,
        })
        const key = identity.userId || identity.phone
        if (key) identities.add(key)
    }

    const latestScan = [...inWindow].sort((a, b) => b.scan_time.localeCompare(a.scan_time))[0] || input.officialScan
    const preferredScan = input.officialScan || latestScan
    if (!preferredScan) return { count: identities.size, latestName: null, latestPhone: null }

    const identity = resolveParticipantIdentity({
        scannedByUserId: preferredScan.scanned_by_user_id,
        consumerPhone: preferredScan.consumer_phone,
        usersById: input.usersById,
        usersByPhone: input.usersByPhone,
    })

    return { count: identities.size, latestName: identity.name, latestPhone: identity.phone }
}

function buildAmOptions(
    amIds: string[],
    usersById: Map<string, IdentityUser>,
): ReportingFilterOption[] {
    return amIds
        .map((id) => ({ id, name: usersById.get(id)?.full_name || null }))
        .filter((option): option is ReportingFilterOption => Boolean(option.name))
        .sort((a, b) => a.name.localeCompare(b.name))
}

function buildRegionOptions(
    shopsById: Map<string, { state_id: string | null; state_name: string | null }>,
): ReportingFilterOption[] {
    const regions = new Map<string, string>()
    for (const shop of shopsById.values()) {
        if (shop.state_id && shop.state_name) regions.set(shop.state_id, shop.state_name)
    }
    return Array.from(regions.entries())
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name))
}
