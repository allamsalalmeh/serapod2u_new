import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { buildCommissionPdf, buildCommissionWorkbook } from './export'
import { buildCommissionReport, formatRate, type AdjustmentRow, type CycleRow, type ItemRow } from './report'

// The October fixture of supabase/tests/hr_commission (database-calculated values).
const CYCLE: CycleRow = {
  id: 'c10', cycle_code: '2026-10', label: 'October 2026 Commission Cycle', period_month: '2026-10-01',
  start_at: '2026-09-27T16:00:00Z', end_at: '2026-10-27T16:00:00Z', status: 'calculated', calc_version: 3,
  eligible_sales: '1611034.00', total_commission: '5596.20', total_adjustments: '47.72', net_commission: '5643.92',
  review_flag_count: 2, calculated_at: '2026-10-11T10:00:00Z', approved_at: null, locked_at: null,
}
const item = (over: Partial<ItemRow>): ItemRow => ({
  id: 'i', employee_id: 'e4', employee_name: 'Mohamad Fakhrul Aiman Bin Zamri', employee_no: 10001, department_id: 'd1',
  department_name: 'Serapod Team', business_unit_id: 'bu-cel', business_unit_code: 'CELLERA', business_unit_name: 'Cellera',
  rate_percent: '0.12000', rule_effective_from: '2026-08-01', rule_effective_to: '2026-12-31', source_line_count: 4,
  eligible_sales: '1608634.00', commission_amount: '1930.36', ...over,
})
const ITEMS: ItemRow[] = [
  item({ id: 'i1' }),
  item({ id: 'i2', business_unit_id: 'bu-ell', business_unit_code: 'ELLBOW', business_unit_name: 'Ellbow', rate_percent: '0.05000', rule_effective_to: null, eligible_sales: '2400.00', commission_amount: '1.20', source_line_count: 2 }),
  item({ id: 'i3', employee_id: 'e5', employee_name: 'Siti Production', employee_no: 10002, department_id: 'd2', department_name: 'Production Staff', rate_percent: '0.22780', rule_effective_to: '2026-10-19', eligible_sales: '1607884.00', commission_amount: '3662.76', source_line_count: 2 }),
  item({ id: 'i4', employee_id: 'e5', employee_name: 'Siti Production', employee_no: 10002, department_id: 'd2', department_name: 'Production Staff', rate_percent: '0.25000', rule_effective_from: '2026-10-20', rule_effective_to: null, eligible_sales: '750.00', commission_amount: '1.88', source_line_count: 2 }),
]
const ADJ: AdjustmentRow[] = [
  { id: 'a1', employee_id: 'e4', business_unit_id: null, kind: 'manual', amount: '50.00', reason: 'Q3 target bonus top-up', status: 'approved', source_order_no: null },
  { id: 'a2', employee_id: 'e5', business_unit_id: 'bu-cel', kind: 'cancellation_reversal', amount: '-2.28', reason: 'Order HCT-SO001 cancelled after cycle 2026-09 was approved', status: 'approved', source_order_no: 'HCT-SO001' },
  { id: 'a3', employee_id: 'e4', business_unit_id: 'bu-cel', kind: 'cancellation_reversal', amount: '-1.20', reason: 'rejected reversal', status: 'rejected', source_order_no: 'HCT-SO001' },
  { id: 'a4', employee_id: 'e4', business_unit_id: null, kind: 'manual', amount: '9.99', reason: 'pending', status: 'pending', source_order_no: null },
]
const BU_SALES = [
  { business_unit_id: 'bu-cel', business_unit_code: 'CELLERA', business_unit_name: 'Cellera', eligible_sales: '1608634.00', source_line_count: 4 },
  { business_unit_id: 'bu-ell', business_unit_code: 'ELLBOW', business_unit_name: 'Ellbow', eligible_sales: '2400.00', source_line_count: 2 },
]
const build = (filters = {}) => buildCommissionReport({ cycle: CYCLE, items: ITEMS, adjustments: ADJ, businessUnitSales: BU_SALES, filters })

describe('Commission report model', () => {
  it('groups by HR department with employee and section subtotals and a grand total', () => {
    const r = build()
    expect(r.sections.map((s) => s.departmentName)).toEqual(['Production Staff', 'Serapod Team'])
    const fakhrul = r.sections[1].employees[0]
    expect(fakhrul.rows.map((x) => x.businessUnit)).toEqual(['Cellera', 'Ellbow', 'All Business Units'])
    expect(fakhrul.commission).toBe(1931.56)
    expect(fakhrul.adjustments).toBe(50)
    expect(fakhrul.net).toBe(1981.56)
    const siti = r.sections[0].employees[0]
    expect(siti.rows.filter((x) => x.kind === 'commission')).toHaveLength(2) // two rates in one cycle
    expect(siti.net).toBe(3662.76 + 1.88 - 2.28)
    expect(r.grandTotal).toEqual({ commission: 5596.2, adjustments: 47.72, net: 5643.92 })
    // Same totals the database stored on the cycle.
    expect(r.grandTotal.commission).toBe(Number(CYCLE.total_commission))
    expect(r.grandTotal.net).toBe(Number(CYCLE.net_commission))
    expect(r.summary.eligibleSales).toBe(Number(CYCLE.eligible_sales))
    expect(r.summary.eligibleEmployees).toBe(2)
    expect(r.summary.averageCommission).toBe(2798.1)
    expect(r.summary.pendingAdjustments).toBe(1)
    expect(r.income.map((b) => [b.name, b.eligibleSales, b.commission])).toEqual([['Cellera', 1608634, 5595.0], ['Ellbow', 2400, 1.2]])
  })

  it('filters by Business Unit, employee and department without recalculating', () => {
    expect(build({ businessUnitId: 'bu-ell' }).grandTotal).toEqual({ commission: 1.2, adjustments: 0, net: 1.2 })
    expect(build({ employeeId: 'e5' }).sections.map((s) => s.departmentName)).toEqual(['Production Staff'])
    expect(build({ departmentId: 'd1' }).grandTotal.net).toBe(1981.56)
  })

  it('keeps rate precision', () => {
    expect(formatRate(0.12)).toBe('0.120%')
    expect(formatRate(0.2278)).toBe('0.2278%')
    expect(formatRate(0.01)).toBe('0.010%')
    expect(formatRate(0.015)).toBe('0.015%')
  })
})

describe('PDF / Excel parity with the screen model', () => {
  it('the workbook carries exactly the model totals', async () => {
    const r = build()
    const buf = await buildCommissionWorkbook(r, { generatedAt: '2026-10-11T10:00:00Z', generatedBy: 'Tester' })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as any)
    const ws = wb.getWorksheet('Commission')!
    const rows: any[][] = []
    ws.eachRow((row) => rows.push((row.values as any[]).slice(1)))
    const grand = rows.find((x) => x[0] === 'GRAND TOTAL')!
    expect([grand[4], grand[5], grand[6]]).toEqual([r.grandTotal.commission, r.grandTotal.adjustments, r.grandTotal.net])
    const eligible = rows.find((x) => x[0] === 'Total Eligible Sales')!
    expect(eligible[2]).toBe(r.summary.eligibleSales)
    const subtotals = rows.filter((x) => typeof x[0] === 'string' && x[0].endsWith(' subtotal'))
    expect(subtotals.map((x) => x[6])).toEqual(r.sections.map((s) => s.net))
    // Detail rows sum to the grand total (no row lost or doubled).
    const detail = rows.filter((x) => x[0] && !String(x[0]).includes('total') && !String(x[0]).includes('Commission') && typeof x[4] === 'number' && x[0] !== 'GRAND TOTAL' && x[1] !== '' && x[0] !== 'Employee')
    expect(Math.round(detail.reduce((s, x) => s + x[6] * 100, 0)) / 100).toBe(r.grandTotal.net)
  })

  it('the PDF is generated from the same model', async () => {
    const r = build()
    const buf = await buildCommissionPdf(r, { generatedAt: '2026-10-11T10:00:00Z', generatedBy: 'Tester' })
    expect(buf.subarray(0, 4).toString()).toBe('%PDF')
    expect(buf.length).toBeGreaterThan(2000)
  })
})
