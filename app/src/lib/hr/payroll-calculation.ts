/**
 * HR payroll — PROVISIONAL line calculation and fail-closed safeguards (B2B, HR Core).
 *
 * This is NOT the statutory engine (Phase B). It keeps the existing provisional formula, but:
 *   - writes only real hr_payroll_run_items columns (employee_user_id, gross_amount, deductions_amount, net_amount, …);
 *   - excludes leavers (employment ended before the period) and employees whose onboarding is not completed;
 *   - lets the route fail the whole run when any line cannot be prepared (no partial "calculated" runs);
 *   - blocks approval while statutory calculation is not certified (hr_settings.config.payroll.statutory_certified).
 * Pure functions only: no database access, so the rules are unit-tested without a server.
 */

export const PAYROLL_STATUTORY_NOT_CERTIFIED = 'PAYROLL_STATUTORY_NOT_CERTIFIED'
export const PAYROLL_CALCULATION_FAILED = 'PAYROLL_CALCULATION_FAILED'

export const STATUTORY_NOT_CERTIFIED_MESSAGE =
  'Payroll approval is blocked: the statutory calculation (EPF, SOCSO, EIS, PCB) is provisional and has not been certified. ' +
  'Calculated runs are for review only until the certified statutory engine is released.'

export interface StatutoryRates {
  epf_employee_rate: number
  epf_employer_rate: number
  socso_employee_rate: number
  socso_employer_rate: number
  eis_employee_rate: number
  eis_employer_rate: number
  pcb_enabled: boolean
}

export const STATUTORY_DEFAULTS: StatutoryRates = {
  epf_employee_rate: 11,
  epf_employer_rate: 13,
  socso_employee_rate: 0.5,
  socso_employer_rate: 1.75,
  eis_employee_rate: 0.2,
  eis_employer_rate: 0.2,
  pcb_enabled: true,
}

const RATE_KEYS = Object.keys(STATUTORY_DEFAULTS).filter((k) => k !== 'pcb_enabled') as Array<Exclude<keyof StatutoryRates, 'pcb_enabled'>>

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** hr_settings.config is one JSON document per organization; statutory rates live under `statutory_rates`. */
export function readStatutoryRates(config: unknown): StatutoryRates {
  const stored = isObject(config) && isObject(config.statutory_rates) ? config.statutory_rates : {}
  const rates: StatutoryRates = { ...STATUTORY_DEFAULTS }
  for (const key of RATE_KEYS) {
    const value = Number(stored[key])
    if (Number.isFinite(value) && value >= 0 && value <= 100) rates[key] = value
  }
  if (typeof stored.pcb_enabled === 'boolean') rates.pcb_enabled = stored.pcb_enabled
  return rates
}

/** Validates a statutory-rates update. Only rate fields are accepted; certification can never be set through it. */
export function sanitizeStatutoryRatesInput(input: unknown): { ok: true; rates: StatutoryRates } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: 'Statutory rates must be an object' }
  const allowed = new Set<string>([...RATE_KEYS, 'pcb_enabled'])
  const unknown = Object.keys(input).filter((k) => !allowed.has(k))
  if (unknown.length > 0) return { ok: false, error: `Unknown statutory setting(s): ${unknown.join(', ')}` }
  const rates: StatutoryRates = { ...STATUTORY_DEFAULTS }
  for (const key of RATE_KEYS) {
    if (input[key] === undefined) continue
    const value = Number(input[key])
    if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false, error: `${key} must be a percentage between 0 and 100` }
    rates[key] = value
  }
  if (input.pcb_enabled !== undefined) {
    if (typeof input.pcb_enabled !== 'boolean') return { ok: false, error: 'pcb_enabled must be true or false' }
    rates.pcb_enabled = input.pcb_enabled
  }
  return { ok: true, rates }
}

/** Merges new rates into the organization's config document without touching any other key (incl. `payroll`). */
export function mergeStatutoryRates(config: unknown, rates: StatutoryRates): Json {
  const base = isObject(config) ? { ...config } : {}
  return { ...base, statutory_rates: { ...rates } }
}

/** Certification is an explicit, owner-recorded flag — never inferred, never defaulted to true. */
export function isStatutoryCertified(config: unknown): boolean {
  return isObject(config) && isObject(config.payroll) && config.payroll.statutory_certified === true
}

export interface PayrollPeriod {
  period_start: string // ISO date
  period_end: string
}

export interface EmploymentRow {
  user_id: string
  onboarding_status: string | null
  status: string | null
  end_date: string | null
}

export interface CompensationRow {
  employee_id: string
  basic_salary: number | string | null
  hourly_rate: number | string | null
  ot_eligible: boolean | null
  effective_date: string | null
  end_date: string | null
  salary_band?: { ot_rate?: number | string | null; ot_eligible?: boolean | null } | null
}

const LEAVER_STATUSES = new Set(['resigned', 'terminated', 'archived', 'inactive', 'separated'])

/** Whether an employee belongs in a run for the period: onboarded, not a leaver before the period, compensation in force. */
export function eligibilityForPeriod(
  employment: EmploymentRow | undefined,
  compensation: CompensationRow,
  period: PayrollPeriod,
): { eligible: true } | { eligible: false; reason: string } {
  if (!employment) return { eligible: false, reason: 'no_employment_record' }
  if (employment.onboarding_status !== 'completed') return { eligible: false, reason: 'onboarding_not_completed' }
  if (employment.end_date && employment.end_date < period.period_start) return { eligible: false, reason: 'left_before_period' }
  if (employment.status && LEAVER_STATUSES.has(employment.status.toLowerCase()) && (!employment.end_date || employment.end_date < period.period_start)) {
    return { eligible: false, reason: 'left_before_period' }
  }
  if (compensation.effective_date && compensation.effective_date > period.period_end) return { eligible: false, reason: 'compensation_not_yet_effective' }
  if (compensation.end_date && compensation.end_date < period.period_start) return { eligible: false, reason: 'compensation_ended' }
  return { eligible: true }
}

const num = (value: unknown): number => {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}
export const round2 = (value: number): number => Math.round(value * 100) / 100

export interface PayrollLineInput {
  organizationId: string
  runId: string
  compensation: CompensationRow
  allowances: Array<{ amount: number | string | null }>
  deductions: Array<{ amount: number | string | null }>
  timesheets: Array<{ total_minutes: number | null; overtime_minutes: number | null }>
  rates: StatutoryRates
}

/** One payroll line with the REAL hr_payroll_run_items columns. Formula unchanged from the pre-B2B route (provisional). */
export function buildPayrollLine(input: PayrollLineInput) {
  const { compensation: comp, rates } = input
  const basicSalary = num(comp.basic_salary)
  const allowancesAmount = input.allowances.reduce((s, a) => s + num(a.amount), 0)
  const otherDeductions = input.deductions.reduce((s, d) => s + num(d.amount), 0)
  const workMinutes = input.timesheets.reduce((s, t) => s + num(t.total_minutes), 0)
  const overtimeMinutes = input.timesheets.reduce((s, t) => s + num(t.overtime_minutes), 0)

  const otRate = num(comp.salary_band?.ot_rate) || 1.5
  const otEligible = Boolean(comp.salary_band?.ot_eligible) // unchanged pre-B2B rule (band decides)
  const hourlyRate = num(comp.hourly_rate) || basicSalary / (22 * 8)
  const overtimeAmount = otEligible ? (overtimeMinutes / 60) * hourlyRate * otRate : 0
  const gross = basicSalary + allowancesAmount + overtimeAmount

  const pct = (rate: number) => round2((gross * rate) / 100)
  const epfEmployee = pct(rates.epf_employee_rate)
  const epfEmployer = pct(rates.epf_employer_rate)
  const socsoEmployee = pct(rates.socso_employee_rate)
  const socsoEmployer = pct(rates.socso_employer_rate)
  const eisEmployee = pct(rates.eis_employee_rate)
  const eisEmployer = pct(rates.eis_employer_rate)

  // Provisional PCB approximation (unchanged); the certified LHDN schedule is Phase B.
  let pcb = 0
  if (rates.pcb_enabled) {
    const annual = gross * 12
    if (annual > 34000) {
      const taxable = annual - 9000 - epfEmployee * 12
      if (taxable > 70000) pcb = round2(((taxable - 70000) * 0.21 + 4600) / 12)
      else if (taxable > 50000) pcb = round2(((taxable - 50000) * 0.16 + 1600) / 12)
      else if (taxable > 35000) pcb = round2(((taxable - 35000) * 0.08 + 600) / 12)
      else if (taxable > 20000) pcb = round2(((taxable - 20000) * 0.03 + 150) / 12)
      else if (taxable > 5000) pcb = round2(((taxable - 5000) * 0.01) / 12)
    }
  }

  const employeeDeductions = epfEmployee + socsoEmployee + eisEmployee + pcb + otherDeductions
  const employerContributions = epfEmployer + socsoEmployer + eisEmployer
  return {
    organization_id: input.organizationId,
    payroll_run_id: input.runId,
    employee_user_id: comp.employee_id,
    basic_salary: round2(basicSalary),
    overtime_amount: round2(overtimeAmount),
    allowances_amount: round2(allowancesAmount),
    work_minutes: Math.round(workMinutes),
    overtime_minutes: Math.round(overtimeMinutes),
    gross_amount: round2(gross),
    epf_employee: epfEmployee,
    epf_employer: epfEmployer,
    socso_employee: socsoEmployee,
    socso_employer: socsoEmployer,
    eis_employee: eisEmployee,
    eis_employer: eisEmployer,
    pcb_amount: pcb,
    other_deductions: round2(otherDeductions),
    other_allowances: 0,
    deductions_amount: round2(employeeDeductions),
    employer_contributions: round2(employerContributions),
    net_amount: round2(gross - employeeDeductions),
    status: 'calculated',
  }
}
export type PayrollLine = ReturnType<typeof buildPayrollLine>

export function validatePayrollLine(line: PayrollLine): string | null {
  for (const [key, value] of Object.entries(line)) {
    if (typeof value === 'number' && !Number.isFinite(value)) return `${key} is not a number`
  }
  if (!line.employee_user_id) return 'employee missing'
  if (line.gross_amount < 0) return 'gross amount is negative'
  if (line.net_amount < 0) return 'net amount is negative (deductions exceed gross)'
  return null
}

export function summarizePayrollLines(lines: readonly PayrollLine[]) {
  return {
    total_gross: round2(lines.reduce((s, l) => s + l.gross_amount, 0)),
    total_deductions: round2(lines.reduce((s, l) => s + l.deductions_amount, 0)),
    total_net: round2(lines.reduce((s, l) => s + l.net_amount, 0)),
    total_employer_contributions: round2(lines.reduce((s, l) => s + l.employer_contributions, 0)),
  }
}
