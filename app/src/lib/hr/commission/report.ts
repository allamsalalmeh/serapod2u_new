/**
 * Commission Reporting model — ONE builder for the screen, the PDF and the Excel export (report.test.ts and
 * export.test.ts check parity). Pure: it only arranges ledger rows the database already calculated and locked; it never
 * recalculates commission.
 *
 * Layout (the Serapod commission spreadsheet):
 *   Income / Eligible Sales  — eligible sales per Business Unit
 *   one section per HR department (Serapod Team, Production Staff, Office Staff, … — whatever HR data says; employees
 *   without a department are grouped under "No Department")
 *     detail rows: employee × Business Unit × applicable rate, plus approved adjustment rows
 *     employee subtotal (consolidated across Business Units), section subtotal
 *   grand total
 */

export interface CycleRow {
  id: string
  cycle_code: string
  label: string
  period_month: string
  start_at: string
  end_at: string
  status: string
  calc_version: number
  eligible_sales: number | string
  total_commission: number | string
  total_adjustments: number | string
  net_commission: number | string
  review_flag_count: number
  calculated_at: string | null
  approved_at: string | null
  locked_at: string | null
}

export interface ItemRow {
  id: string
  employee_id: string
  employee_name: string | null
  employee_no: number | null
  department_id: string | null
  department_name: string | null
  business_unit_id: string
  business_unit_code: string
  business_unit_name: string
  rate_percent: number | string
  rule_effective_from: string
  rule_effective_to: string | null
  source_line_count: number
  eligible_sales: number | string
  commission_amount: number | string
}

export interface AdjustmentRow {
  id: string
  employee_id: string
  business_unit_id: string | null
  kind: 'manual' | 'cancellation_reversal'
  amount: number | string
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  source_order_no: string | null
}

export interface BusinessUnitSalesRow {
  business_unit_id: string
  business_unit_code: string
  business_unit_name: string
  eligible_sales: number | string
  source_line_count: number
}

export interface EmployeeRef {
  employee_id: string
  employee_name: string | null
  employee_no: number | null
  department_id: string | null
  department_name: string | null
}

export interface ReportFilters {
  businessUnitId?: string | null
  employeeId?: string | null
  departmentId?: string | null
}

export interface DetailRow {
  kind: 'commission' | 'adjustment'
  employeeId: string
  employeeName: string
  businessUnit: string
  businessUnitId: string | null
  commissionableSales: number | null
  ratePercent: number | null
  ratePeriod: string | null
  commission: number
  adjustments: number
  net: number
  note: string | null
}

export interface EmployeeBlock {
  employeeId: string
  employeeName: string
  employeeNo: number | null
  rows: DetailRow[]
  commission: number
  adjustments: number
  net: number
}

export interface DepartmentSection {
  departmentId: string | null
  departmentName: string
  employees: EmployeeBlock[]
  commission: number
  adjustments: number
  net: number
}

export interface CommissionReport {
  cycle: { id: string; code: string; label: string; status: string; startAt: string; endAt: string; calcVersion: number; reviewFlags: number; calculatedAt: string | null; approvedAt: string | null; lockedAt: string | null }
  filters: Required<{ [K in keyof ReportFilters]: string | null }>
  summary: {
    eligibleSales: number
    totalCommission: number
    totalAdjustments: number
    netCommission: number
    eligibleEmployees: number
    averageCommission: number | null
    pendingAdjustments: number
  }
  income: { businessUnitId: string; code: string; name: string; eligibleSales: number; lines: number; commission: number }[]
  sections: DepartmentSection[]
  grandTotal: { commission: number; adjustments: number; net: number }
  isEmpty: boolean
}

const num = (v: number | string | null | undefined) => (v == null || v === '' ? 0 : Number(v))
/** Sum of cents, so money never drifts in binary floating point. */
const sum = (values: number[]) => Math.round(values.reduce((s, v) => s + Math.round(v * 100), 0)) / 100
export const NO_DEPARTMENT = 'No Department'

export function buildCommissionReport(input: {
  cycle: CycleRow
  items: ItemRow[]
  adjustments: AdjustmentRow[]
  businessUnitSales: BusinessUnitSalesRow[]
  employees?: EmployeeRef[]
  filters?: ReportFilters
}): CommissionReport {
  const f = { businessUnitId: input.filters?.businessUnitId ?? null, employeeId: input.filters?.employeeId ?? null, departmentId: input.filters?.departmentId ?? null }
  const employeeIndex = new Map<string, EmployeeRef>()
  for (const e of input.employees ?? []) employeeIndex.set(e.employee_id, e)
  for (const i of input.items) {
    if (!employeeIndex.has(i.employee_id)) {
      employeeIndex.set(i.employee_id, { employee_id: i.employee_id, employee_name: i.employee_name, employee_no: i.employee_no, department_id: i.department_id, department_name: i.department_name })
    }
  }
  const keepEmployee = (id: string) => {
    if (f.employeeId && id !== f.employeeId) return false
    if (f.departmentId && (employeeIndex.get(id)?.department_id ?? null) !== f.departmentId) return false
    return true
  }
  const keepBu = (bu: string | null) => !f.businessUnitId || bu === f.businessUnitId

  const items = input.items.filter((i) => keepEmployee(i.employee_id) && keepBu(i.business_unit_id))
  const approvedAdjustments = input.adjustments.filter((a) => a.status === 'approved' && keepEmployee(a.employee_id) && (!f.businessUnitId || a.business_unit_id === f.businessUnitId))
  const pendingAdjustments = input.adjustments.filter((a) => a.status === 'pending' && keepEmployee(a.employee_id) && (!f.businessUnitId || a.business_unit_id === f.businessUnitId)).length
  const buName = new Map<string, string>()
  for (const b of input.businessUnitSales) buName.set(b.business_unit_id, b.business_unit_name)
  for (const i of input.items) buName.set(i.business_unit_id, i.business_unit_name)

  const blocks = new Map<string, EmployeeBlock>()
  const blockFor = (employeeId: string) => {
    let b = blocks.get(employeeId)
    if (!b) {
      const e = employeeIndex.get(employeeId)
      b = { employeeId, employeeName: e?.employee_name || 'Unknown employee', employeeNo: e?.employee_no ?? null, rows: [], commission: 0, adjustments: 0, net: 0 }
      blocks.set(employeeId, b)
    }
    return b
  }
  for (const i of items) {
    const commission = num(i.commission_amount)
    blockFor(i.employee_id).rows.push({
      kind: 'commission', employeeId: i.employee_id, employeeName: i.employee_name || 'Unknown employee',
      businessUnit: i.business_unit_name, businessUnitId: i.business_unit_id,
      commissionableSales: num(i.eligible_sales), ratePercent: num(i.rate_percent),
      ratePeriod: `${i.rule_effective_from} → ${i.rule_effective_to ?? 'open'}`,
      commission, adjustments: 0, net: commission, note: null,
    })
  }
  for (const a of approvedAdjustments) {
    const amount = num(a.amount)
    blockFor(a.employee_id).rows.push({
      kind: 'adjustment', employeeId: a.employee_id, employeeName: employeeIndex.get(a.employee_id)?.employee_name || 'Unknown employee',
      businessUnit: a.business_unit_id ? (buName.get(a.business_unit_id) ?? 'Business Unit') : 'All Business Units',
      businessUnitId: a.business_unit_id, commissionableSales: null, ratePercent: null, ratePeriod: null,
      commission: 0, adjustments: amount, net: amount,
      note: `${a.kind === 'cancellation_reversal' ? 'Reversal' : 'Adjustment'}: ${a.reason}${a.source_order_no ? ` (${a.source_order_no})` : ''}`,
    })
  }
  for (const b of blocks.values()) {
    b.rows.sort((x, y) => (x.kind === y.kind ? x.businessUnit.localeCompare(y.businessUnit) : x.kind === 'commission' ? -1 : 1))
    b.commission = sum(b.rows.map((r) => r.commission))
    b.adjustments = sum(b.rows.map((r) => r.adjustments))
    b.net = sum([b.commission, b.adjustments])
  }

  const sectionMap = new Map<string, DepartmentSection>()
  for (const b of blocks.values()) {
    const e = employeeIndex.get(b.employeeId)
    const key = e?.department_id ?? '__none__'
    let s = sectionMap.get(key)
    if (!s) {
      s = { departmentId: e?.department_id ?? null, departmentName: e?.department_name || NO_DEPARTMENT, employees: [], commission: 0, adjustments: 0, net: 0 }
      sectionMap.set(key, s)
    }
    s.employees.push(b)
  }
  const sections = [...sectionMap.values()]
  for (const s of sections) {
    s.employees.sort((a, b) => a.employeeName.localeCompare(b.employeeName))
    s.commission = sum(s.employees.map((e) => e.commission))
    s.adjustments = sum(s.employees.map((e) => e.adjustments))
    s.net = sum(s.employees.map((e) => e.net))
  }
  sections.sort((a, b) => (a.departmentId === null ? 1 : b.departmentId === null ? -1 : a.departmentName.localeCompare(b.departmentName)))

  const commissionByBu = new Map<string, number[]>()
  for (const i of items) commissionByBu.set(i.business_unit_id, [...(commissionByBu.get(i.business_unit_id) ?? []), num(i.commission_amount)])
  const income = input.businessUnitSales
    .filter((b) => keepBu(b.business_unit_id))
    .map((b) => ({ businessUnitId: b.business_unit_id, code: b.business_unit_code, name: b.business_unit_name, eligibleSales: num(b.eligible_sales), lines: b.source_line_count, commission: sum(commissionByBu.get(b.business_unit_id) ?? []) }))
    .sort((a, b) => b.eligibleSales - a.eligibleSales)

  const grandTotal = { commission: sum(sections.map((s) => s.commission)), adjustments: sum(sections.map((s) => s.adjustments)), net: sum(sections.map((s) => s.net)) }
  const employeesWithCommission = [...blocks.values()].filter((b) => b.rows.some((r) => r.kind === 'commission'))

  return {
    cycle: {
      id: input.cycle.id, code: input.cycle.cycle_code, label: input.cycle.label, status: input.cycle.status,
      startAt: input.cycle.start_at, endAt: input.cycle.end_at, calcVersion: input.cycle.calc_version,
      reviewFlags: input.cycle.review_flag_count, calculatedAt: input.cycle.calculated_at,
      approvedAt: input.cycle.approved_at, lockedAt: input.cycle.locked_at,
    },
    filters: f,
    summary: {
      eligibleSales: sum(income.map((b) => b.eligibleSales)),
      totalCommission: grandTotal.commission,
      totalAdjustments: grandTotal.adjustments,
      netCommission: grandTotal.net,
      eligibleEmployees: employeesWithCommission.length,
      averageCommission: employeesWithCommission.length ? Math.round((grandTotal.commission / employeesWithCommission.length) * 100) / 100 : null,
      pendingAdjustments,
    },
    income,
    sections,
    grandTotal,
    isEmpty: sections.length === 0 && income.length === 0,
  }
}

export const formatRM = (v: number | null | undefined) =>
  v == null ? '—' : `RM ${v.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
/** Rates keep their full precision (up to 5 decimals), never rounded for display. */
export const formatRate = (v: number | null | undefined) =>
  v == null ? '—' : `${Number(v).toFixed(5).replace(/0{1,2}$/, '')}%`
