import { describe, expect, it } from 'vitest'
import {
  STATUTORY_DEFAULTS, buildPayrollLine, eligibilityForPeriod, isStatutoryCertified, mergeStatutoryRates, readStatutoryRates,
  sanitizeStatutoryRatesInput, summarizePayrollLines, validatePayrollLine,
} from './payroll-calculation'

const period = { period_start: '2026-10-01', period_end: '2026-10-31' }
const comp = (over: Record<string, unknown> = {}) => ({
  employee_id: 'emp-1', basic_salary: 3000, hourly_rate: null, ot_eligible: null, effective_date: '2026-01-01', end_date: null, ...over,
}) as any
const employment = (over: Record<string, unknown> = {}) => ({ user_id: 'emp-1', onboarding_status: 'completed', status: 'active', end_date: null, ...over })

describe('statutory settings (hr_settings.config)', () => {
  it('defaults when nothing is stored and reads the statutory_rates key', () => {
    expect(readStatutoryRates(null)).toEqual(STATUTORY_DEFAULTS)
    expect(readStatutoryRates({ statutory_rates: { epf_employee_rate: 9, pcb_enabled: false } })).toMatchObject({ epf_employee_rate: 9, pcb_enabled: false, epf_employer_rate: 13 })
  })
  it('ignores invalid stored values', () => {
    expect(readStatutoryRates({ statutory_rates: { epf_employee_rate: 'abc', socso_employer_rate: 500 } })).toEqual(STATUTORY_DEFAULTS)
  })
  it('certification is explicit and never set through the rates update', () => {
    expect(isStatutoryCertified({})).toBe(false)
    expect(isStatutoryCertified({ payroll: { statutory_certified: 'true' } })).toBe(false)
    expect(isStatutoryCertified({ payroll: { statutory_certified: true } })).toBe(true)
    expect(sanitizeStatutoryRatesInput({ epf_employee_rate: 11, payroll: { statutory_certified: true } })).toEqual({ ok: false, error: 'Unknown statutory setting(s): payroll' })
    expect(sanitizeStatutoryRatesInput({ epf_employee_rate: 101 }).ok).toBe(false)
    expect(sanitizeStatutoryRatesInput({ pcb_enabled: 'yes' }).ok).toBe(false)
  })
  it('merging rates keeps every other config key (incl. the certification flag)', () => {
    const merged = mergeStatutoryRates({ payroll: { statutory_certified: true }, other: 1 }, { ...STATUTORY_DEFAULTS, epf_employee_rate: 9 })
    expect(merged).toMatchObject({ payroll: { statutory_certified: true }, other: 1, statutory_rates: { epf_employee_rate: 9 } })
  })
})

describe('eligibility (leavers excluded)', () => {
  it('includes an onboarded employee with compensation in force', () => {
    expect(eligibilityForPeriod(employment(), comp(), period)).toEqual({ eligible: true })
  })
  it('excludes leavers, not-onboarded employees and compensation outside the period', () => {
    expect(eligibilityForPeriod(undefined, comp(), period)).toEqual({ eligible: false, reason: 'no_employment_record' })
    expect(eligibilityForPeriod(employment({ onboarding_status: 'pending' }), comp(), period)).toEqual({ eligible: false, reason: 'onboarding_not_completed' })
    expect(eligibilityForPeriod(employment({ end_date: '2026-09-30', status: 'resigned' }), comp(), period)).toEqual({ eligible: false, reason: 'left_before_period' })
    expect(eligibilityForPeriod(employment({ status: 'terminated' }), comp(), period)).toEqual({ eligible: false, reason: 'left_before_period' })
    expect(eligibilityForPeriod(employment(), comp({ effective_date: '2026-11-01' }), period)).toEqual({ eligible: false, reason: 'compensation_not_yet_effective' })
    expect(eligibilityForPeriod(employment(), comp({ end_date: '2026-09-15' }), period)).toEqual({ eligible: false, reason: 'compensation_ended' })
  })
  it('keeps a leaver who worked part of the period (final pay)', () => {
    expect(eligibilityForPeriod(employment({ end_date: '2026-10-15', status: 'resigned' }), comp(), period)).toEqual({ eligible: true })
  })
})

describe('payroll line (real columns, provisional formula)', () => {
  const line = buildPayrollLine({
    organizationId: 'org', runId: 'run', compensation: comp(), rates: STATUTORY_DEFAULTS,
    allowances: [{ amount: 200 }, { amount: '50' }], deductions: [{ amount: 30 }],
    timesheets: [{ total_minutes: 9600, overtime_minutes: 120 }],
  })
  it('uses the real hr_payroll_run_items column names', () => {
    expect(line).toMatchObject({ organization_id: 'org', payroll_run_id: 'run', employee_user_id: 'emp-1', status: 'calculated' })
    for (const legacy of ['employee_id', 'gross_salary', 'net_salary', 'deductions']) expect(line).not.toHaveProperty(legacy)
  })
  it('computes gross, deductions and net consistently', () => {
    expect(line.gross_amount).toBe(3250)  // OT not eligible without the band flag
    expect(line.work_minutes).toBe(9600)
    expect(line.overtime_minutes).toBe(120)
    expect(line.epf_employee).toBe(357.5)
    expect(line.deductions_amount).toBe(Math.round((357.5 + 16.25 + 6.5 + line.pcb_amount + 30) * 100) / 100)
    expect(line.net_amount).toBe(Math.round((3250 - line.deductions_amount) * 100) / 100)
    expect(validatePayrollLine(line)).toBeNull()
  })
  it('pays overtime only when the salary band allows it (unchanged rule)', () => {
    const ot = buildPayrollLine({
      organizationId: 'o', runId: 'r', rates: STATUTORY_DEFAULTS,
      compensation: comp({ hourly_rate: 20, salary_band: { ot_eligible: true, ot_rate: 1.5 } }),
      allowances: [], deductions: [], timesheets: [{ total_minutes: 0, overtime_minutes: 60 }],
    })
    expect(ot.overtime_amount).toBe(30)
  })
  it('flags impossible lines so the run fails closed', () => {
    const negative = buildPayrollLine({ organizationId: 'o', runId: 'r', compensation: comp({ basic_salary: 100 }), rates: STATUTORY_DEFAULTS, allowances: [], deductions: [{ amount: 500 }], timesheets: [] })
    expect(validatePayrollLine(negative)).toMatch(/net amount is negative/)
  })
  it('summarizes run totals from the lines', () => {
    expect(summarizePayrollLines([line, line])).toEqual({
      total_gross: 6500, total_deductions: Math.round(line.deductions_amount * 2 * 100) / 100,
      total_net: Math.round(line.net_amount * 2 * 100) / 100, total_employer_contributions: Math.round(line.employer_contributions * 2 * 100) / 100,
    })
  })
})
