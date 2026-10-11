import { NextResponse } from 'next/server'
import { badRequest, commissionContext, isDate, isUuid, readJson, requireAny, rpc, text } from '@/lib/server/commission/route-kit'
import { userNames } from '@/lib/server/commission/data'
import { APPROVED_SALES_STATUSES } from '@/lib/reporting/sales-kpi'

export const dynamic = 'force-dynamic'

/** GET /api/hr/commission/settings — every settings version (newest first). */
export async function GET() {
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.view', 'reporting.commission.view')
  if (denied) return denied
  const { data } = await ctx.supabase.from('hr_commission_settings').select('*').order('effective_from', { ascending: false })
  const names = await userNames((data ?? []).map((s: any) => s.created_by))
  return NextResponse.json({ success: true, settings: (data ?? []).map((s: any) => ({ ...s, created_by_name: names[s.created_by] ?? null })) })
}

/**
 * POST /api/hr/commission/settings — a new settings version effective from the first day of a month after every
 * generated cycle. Existing cycles keep their snapshot.
 */
export async function POST(request: Request) {
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.manage')
  if (denied) return denied
  const body = await readJson(request)
  if (!isDate(body.effectiveFrom) || !body.effectiveFrom.endsWith('-01')) return badRequest('Settings take effect from the first day of a month.')
  const cycleType = body.cycleType === 'calendar_month' ? 'calendar_month' : 'custom'
  const startDay = cycleType === 'calendar_month' ? 1 : Number(body.startDay)
  if (cycleType === 'custom' && (!Number.isInteger(startDay) || startDay < 2 || startDay > 28)) return badRequest('A custom cycle starts on day 2–28 and ends the day before.')
  const statuses = Array.isArray(body.eligibleStatuses) ? body.eligibleStatuses.filter((s: unknown) => typeof s === 'string') : null
  if (statuses && (statuses.length === 0 || statuses.some((s: string) => !(APPROVED_SALES_STATUSES as readonly string[]).includes(s)))) {
    return badRequest('Only approved-stage statuses can be eligible.')
  }
  const units = Array.isArray(body.businessUnitIds) ? body.businessUnitIds.filter(isUuid) : null
  const r = await rpc(ctx, 'hr_commission_save_settings', {
    p_effective_from: body.effectiveFrom, p_cycle_type: cycleType, p_start_day: startDay,
    p_cycle_label_format: text(body.cycleLabelFormat, 80) || null, p_eligible_statuses: statuses,
    p_business_unit_ids: units && units.length ? units : null, p_notes: text(body.notes) || null,
  })
  return 'response' in r ? r.response : NextResponse.json({ success: true, settings: r.data })
}
