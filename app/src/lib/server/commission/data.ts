import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildCommissionReport, type CommissionReport, type ReportFilters } from '@/lib/hr/commission/report'
import type { CommissionContext } from './route-kit'

/**
 * Commission reads. Ledger rows are read with the CALLER's session (RLS decides). The service client is used only for
 * display names of employees and people in records the caller has already been allowed to read, and for resolving an
 * HR employee inside the caller's company.
 */

export interface EmployeeName { employeeId: string; userId: string; name: string; employeeNo: number | null; departmentId: string | null; departmentName: string | null }

export async function employeeNames(employeeIds: string[]): Promise<Map<string, EmployeeName>> {
  const out = new Map<string, EmployeeName>()
  const ids = [...new Set(employeeIds.filter(Boolean))]
  if (ids.length === 0) return out
  const admin = createAdminClient() as any
  const { data } = await admin.from('hr_employees')
    .select('id, user_id, employee_no, department_id, users:user_id(full_name, email), departments:department_id(dept_name)')
    .in('id', ids)
  for (const e of data ?? []) {
    out.set(e.id, {
      employeeId: e.id, userId: e.user_id, name: e.users?.full_name || e.users?.email || 'Unknown employee',
      employeeNo: e.employee_no ?? null, departmentId: e.department_id ?? null, departmentName: e.departments?.dept_name ?? null,
    })
  }
  return out
}

export async function userNames(userIds: (string | null | undefined)[]): Promise<Record<string, string>> {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))]
  if (ids.length === 0) return {}
  const admin = createAdminClient() as any
  const { data } = await admin.from('users').select('id, full_name, email').in('id', ids)
  return Object.fromEntries((data ?? []).map((u: any) => [u.id, u.full_name || u.email || 'Unknown user']))
}

/** The HR employee of a user, only when that employee belongs to the caller's company. */
export async function employeeOfUser(ctx: CommissionContext, userId: string) {
  if (!ctx.access.companyId) return null
  const admin = createAdminClient() as any
  const { data: rows } = await admin.from('hr_employees')
    .select('id, user_id, organization_id, employee_no, onboarding_status, status, department_id, hire_date, end_date')
    .eq('user_id', userId)
  for (const row of rows ?? []) {
    const { data: company } = await admin.rpc('get_company_id', { p_org_id: row.organization_id })
    if (company === ctx.access.companyId) return row
  }
  return null
}

export async function loadCycles(ctx: CommissionContext) {
  const { data, error } = await ctx.supabase.from('hr_commission_cycles')
    .select('id, cycle_code, label, period_month, start_at, end_at, status, calc_version, eligible_sales, total_commission, total_adjustments, net_commission, eligible_employee_count, review_flag_count, calculated_at, calculated_by, submitted_at, submitted_by, approved_at, approved_by, approval_note, locked_at, locked_by, payroll_ready_at, payroll_ready_by, payroll_period_start, payroll_period_end, integration_status, settings_snapshot')
    .order('period_month', { ascending: false })
  return { data: data ?? [], error }
}

/** The report model for a cycle, from the stored ledger (never recalculated). */
export async function loadReport(ctx: CommissionContext, cycleId: string, filters: ReportFilters): Promise<CommissionReport | null> {
  const [{ data: cycle }, { data: items }, { data: adjustments }, { data: sources }] = await Promise.all([
    ctx.supabase.from('hr_commission_cycles').select('*').eq('id', cycleId).maybeSingle(),
    ctx.supabase.from('hr_commission_items').select('*').eq('cycle_id', cycleId),
    ctx.supabase.from('hr_commission_adjustments').select('id, employee_id, business_unit_id, kind, amount, reason, status, source_order_no').eq('target_cycle_id', cycleId),
    ctx.supabase.from('hr_commission_sources').select('business_unit_id, business_unit_code, business_unit_name, line_value').eq('cycle_id', cycleId).not('business_unit_id', 'is', null),
  ])
  if (!cycle) return null
  const buSales = new Map<string, { business_unit_id: string; business_unit_code: string; business_unit_name: string; cents: number; source_line_count: number }>()
  for (const s of sources ?? []) {
    const b = buSales.get(s.business_unit_id) ?? { business_unit_id: s.business_unit_id, business_unit_code: s.business_unit_code, business_unit_name: s.business_unit_name, cents: 0, source_line_count: 0 }
    b.cents += Math.round(Number(s.line_value) * 100)
    b.source_line_count += 1
    buSales.set(s.business_unit_id, b)
  }
  // Adjustment-only employees (no item this cycle) still need a name and department.
  const adjOnly = (adjustments ?? []).map((a: any) => a.employee_id).filter((id: string) => !(items ?? []).some((i: any) => i.employee_id === id))
  const names = await employeeNames(adjOnly)
  return buildCommissionReport({
    cycle,
    items: items ?? [],
    adjustments: adjustments ?? [],
    businessUnitSales: [...buSales.values()].map((b) => ({ ...b, eligible_sales: b.cents / 100 })),
    employees: [...names.values()].map((n) => ({ employee_id: n.employeeId, employee_name: n.name, employee_no: n.employeeNo, department_id: n.departmentId, department_name: n.departmentName })),
    filters,
  })
}

export async function logAccess(ctx: CommissionContext, action: 'report_viewed' | 'report_exported' | 'employee_viewed' | 'drilldown_viewed', entityType: string, entityId: string | null, details: Record<string, unknown> = {}) {
  const { error } = await ctx.supabase.rpc('hr_commission_log_access', { p_action: action, p_entity_type: entityType, p_entity_id: entityId, p_details: details })
  if (error) console.warn('[commission] access log not written', error.code)
}
