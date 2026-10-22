import type { ReturnCase, ReturnCaseItem, ReturnSettings } from './types'
import { isTerminalStatus, type ReturnStatus } from './constants'

export function itemsTotalQty(items?: ReturnCaseItem[] | null): number {
    return (items || []).reduce((sum, it) => sum + Number(it.total_units || it.quantity || 0), 0)
}

/**
 * Value of one return line. Quantities are recorded in pieces while unit_cost
 * is the cost of one stock unit — a case for lines with a pack size — so the
 * pieces are restated in cases first.
 */
export function itemLineValue(
    it: Pick<ReturnCaseItem, 'total_units' | 'quantity' | 'unit_cost' | 'units_per_case_snapshot'>,
): number {
    const qty = Number(it.total_units || it.quantity || 0)
    const perCase = Number(it.units_per_case_snapshot)
    const stockUnits = Number.isFinite(perCase) && perCase > 1 ? qty / perCase : qty
    return stockUnits * Number(it.unit_cost || 0)
}

export function itemsTotalValue(items?: ReturnCaseItem[] | null): number {
    return (items || []).reduce((sum, it) => sum + itemLineValue(it), 0)
}

/** Whole days between a start timestamp and now (or an end timestamp). */
export function daysBetween(start?: string | null, end?: string | null): number {
    if (!start) return 0
    const startMs = new Date(start).getTime()
    const endMs = end ? new Date(end).getTime() : Date.now()
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) return 0
    return Math.max(0, Math.floor((endMs - startMs) / 86_400_000))
}

/** Days a case has been open (created → completed/now). */
export function daysOpen(rc: Pick<ReturnCase, 'created_at' | 'completed_at' | 'cancelled_at'>): number {
    return daysBetween(rc.created_at, rc.completed_at || rc.cancelled_at)
}

/**
 * A case is overdue when the current (non-terminal) stage has exceeded its SLA
 * target measured from the timestamp it entered that stage.
 */
export function isOverdue(rc: ReturnCase, settings: ReturnSettings): boolean {
    const status = rc.status as ReturnStatus
    if (isTerminalStatus(status)) return false

    const target = slaTargetForStatus(status, settings)
    if (target == null) return false

    const enteredAt = stageEnteredAt(rc, status)
    if (!enteredAt) return false
    return daysBetween(enteredAt) > target
}

function slaTargetForStatus(status: ReturnStatus, s: ReturnSettings): number | null {
    switch (status) {
        case 'return_submitted': return s.sla_submitted_to_received_days
        case 'return_received': return s.sla_received_to_processing_days
        case 'return_processing': return s.sla_processing_to_completed_days
        default: return null
    }
}

function stageEnteredAt(rc: ReturnCase, status: ReturnStatus): string | null {
    switch (status) {
        case 'return_submitted': return rc.submitted_at
        case 'return_received': return rc.received_at
        case 'return_processing': return rc.processing_started_at
        default: return null
    }
}

/** Attach computed convenience fields used by list/reporting views. */
export function decorateCase(rc: ReturnCase, settings: ReturnSettings): ReturnCase {
    return {
        ...rc,
        total_qty: itemsTotalQty(rc.items),
        total_value: itemsTotalValue(rc.items),
        days_open: daysOpen(rc),
        is_overdue: isOverdue(rc, settings),
    }
}
