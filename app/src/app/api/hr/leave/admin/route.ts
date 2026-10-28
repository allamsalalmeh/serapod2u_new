import { NextRequest } from 'next/server'
import {
    invalid, leaveAdjust, leaveCarryForwardRun, leaveEntitlementRun, leaveSetEntitlement, respond, sessionActor, unauthenticated,
} from '@/lib/hr/wave3/server'
import { isUuid } from '@/lib/hr/wave3/messages'

/**
 * POST /api/hr/leave/admin — HR leave balance administration (explicit HR leave authority 'hr.leave.approve' in the
 * employee's company until 'hr.leave.manage' exists; never on one's own record; every change is a ledger line with a reason).
 *   { action: 'set_entitlement', employee_user_id, leave_type_id, year, days, reason }
 *   { action: 'adjust', employee_user_id, leave_type_id, year, delta, reason }          (whole or half days, ±)
 *   { action: 'entitlement_run', leave_type_id, year, dry_run, reason?, organization_id? }  (type's own tiers / pro-rata)
 *   { action: 'carry_forward', leave_type_id, from_year, dry_run, reason?, organization_id? } (type's own cap; no expiry automation)
 */
const yearOk = (y: unknown): y is number => Number.isInteger(y) && (y as number) >= 2000 && (y as number) <= 2100

export async function POST(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const b = await request.json().catch(() => ({}))
    const reason = typeof b?.reason === 'string' ? b.reason.trim() : ''
    const needReason = () => invalid('Enter a reason (at least 5 characters).', 'REASON_REQUIRED')
    switch (b?.action) {
        case 'set_entitlement': {
            const days = Number(b.days)
            if (!isUuid(b.employee_user_id) || !isUuid(b.leave_type_id) || !yearOk(b.year) || !Number.isFinite(days)) return invalid()
            if (reason.length < 5) return needReason()
            return respond(await leaveSetEntitlement(actor.id, b.employee_user_id, b.leave_type_id, b.year, days, reason))
        }
        case 'adjust': {
            const delta = Number(b.delta)
            if (!isUuid(b.employee_user_id) || !isUuid(b.leave_type_id) || !yearOk(b.year) || !Number.isFinite(delta) || delta === 0) return invalid()
            if (reason.length < 5) return needReason()
            return respond(await leaveAdjust(actor.id, b.employee_user_id, b.leave_type_id, b.year, delta, reason))
        }
        case 'entitlement_run':
        case 'carry_forward': {
            const org = b.organization_id ?? actor.organizationId
            const year = b.action === 'entitlement_run' ? b.year : b.from_year
            const dryRun = b.dry_run !== false
            if (!isUuid(org) || !isUuid(b.leave_type_id) || !yearOk(year)) return invalid()
            if (!dryRun && reason.length < 5) return needReason()
            return respond(b.action === 'entitlement_run'
                ? await leaveEntitlementRun(actor.id, org, b.leave_type_id, year, dryRun, reason || null)
                : await leaveCarryForwardRun(actor.id, org, b.leave_type_id, year, dryRun, reason || null))
        }
        default:
            return invalid('Invalid action')
    }
}
