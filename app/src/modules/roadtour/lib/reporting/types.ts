// One typed contract for every RoadTour Reporting row.
//
// All four reports (Monthly Overview, AM Performance, Shop Follow-Up, shop
// drill-down) consume this shape. Shop and participant fields are populated once,
// in the shared loader, so no view has to re-derive or re-name them.

import type { ShopOutcome } from './impactModel'

export const UNASSIGNED_AM_ID = '__unassigned__'
export const UNASSIGNED_AM_LABEL = 'Unassigned'
/** An assigned AM whose user lookup failed: still assigned, never reported as Unassigned. */
export const AM_NAME_NOT_LOADED_LABEL = 'Account manager (name not loaded)'
export const UNREGISTERED_PARTICIPANT_LABEL = 'Unregistered Participant'

export interface RoadtourVisitReportRow {
    visit_id: string
    /** Malaysia-local calendar date of the visit, `YYYY-MM-DD`. */
    visit_date: string
    /**
     * Impact anchor: the official visit scan timestamp when it is known,
     * otherwise 00:00 +08:00 on `visit_date`. Before/after windows and the
     * observation deadline are both measured from this instant.
     */
    visit_at: string
    /** True when `visit_at` came from the official scan event rather than the date. */
    visit_at_from_official_scan: boolean

    campaign_id: string
    campaign_name: string

    /** null when the account manager could not be resolved to a real user. */
    account_manager_user_id: string | null
    account_manager_name: string | null

    shop_id: string
    /** Full display label, e.g. `Kloud Room (Seberang Perai Tengah)`. */
    shop_name: string
    shop_name_primary: string
    shop_branch_label: string | null
    shop_code: string | null
    shop_region: string | null
    shop_state_id: string | null

    participant_count: number
    latest_participant_name: string | null
    /** Normalised E.164 where available. */
    latest_participant_phone: string | null

    before_scans: number
    after_scans: number
    scan_lift: number
    scan_lift_percent: number | null

    /** Observation window applied to this row (7 for official management views). */
    window_days: number
    matured: boolean
    /** ISO instant at which this visit's observation window completes. */
    matures_at: string
    days_since_visit: number

    outcome: ShopOutcome

    first_scan_after_at: string | null
    last_scan_after_at: string | null

    /** Latest visit for this shop inside the selected month (ownership + status). */
    is_current_for_shop: boolean
    /** Latest MATURED visit for this shop — the row credited in AM performance. */
    is_attributed_for_shop: boolean

    notes: string | null
}

export interface ReportingFilterOption {
    id: string
    name: string
}

export interface ReportingDatasetMeta {
    monthKey: string
    monthLabel: string
    isCurrentMonth: boolean
    /** Last date covered — today for Month to Date, otherwise the month end. */
    cutoffDate: string
    windowDays: number
    generatedAt: string
    /** Visits whose account manager could not be resolved to a real user. */
    unassignedVisitCount: number
    unassignedShopCount: number
    /**
     * First visit date pulled in ahead of the selected month, or null when the
     * report is strictly month-scoped. Shop Follow-Up sets this so the queue can
     * say which earlier visits it is still carrying.
     */
    carryForwardFromDate: string | null
    /** Non-fatal enrichment problems worth telling management about. */
    warnings: string[]
}

export interface RoadtourReportingDataset {
    rows: RoadtourVisitReportRow[]
    campaigns: ReportingFilterOption[]
    accountManagers: ReportingFilterOption[]
    regions: ReportingFilterOption[]
    meta: ReportingDatasetMeta
}
