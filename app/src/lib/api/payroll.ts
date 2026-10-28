// ── Payroll API client ────────────────────────────────────

export interface SalaryBand {
    id: string
    organization_id: string
    code: string
    name: string
    position_id: string | null
    pay_type: 'monthly' | 'hourly'
    min_salary: number
    max_salary: number
    currency: string
    ot_eligible: boolean
    ot_rate: number
    is_active: boolean
    position?: { id: string; name: string; code: string } | null
}

export interface EmployeeCompensation {
    id: string
    employee_id: string
    salary_band_id: string | null
    pay_type: 'monthly' | 'hourly'
    basic_salary: number
    hourly_rate: number | null
    currency: string
    ot_eligible: boolean
    effective_date: string
    end_date: string | null
    status: string
    notes: string | null
    employee?: { id: string; full_name: string | null; email: string }
    salary_band?: SalaryBand | null
}

export interface AllowanceType {
    id: string
    organization_id: string
    code: string
    name: string
    description: string
    is_taxable: boolean
    is_recurring: boolean
    default_amount: number
    currency: string
    is_active: boolean
}

export interface DeductionType {
    id: string
    organization_id: string
    code: string
    name: string
    description: string
    category: string
    is_recurring: boolean
    default_amount: number
    currency: string
    is_active: boolean
}

export interface EmployeeAllowance {
    id: string
    employee_id: string
    allowance_type_id: string
    amount: number
    currency: string
    effective_date: string
    end_date: string | null
    is_active: boolean
    notes: string | null
    employee?: { id: string; full_name: string | null; email: string }
    allowance_type?: AllowanceType | null
}

export interface EmployeeDeduction {
    id: string
    employee_id: string
    deduction_type_id: string
    amount: number
    currency: string
    effective_date: string
    end_date: string | null
    total_amount: number | null
    remaining_amount: number | null
    installments: number | null
    installment_number: number
    is_active: boolean
    notes: string | null
    employee?: { id: string; full_name: string | null; email: string }
    deduction_type?: DeductionType | null
}

export interface PayrollRun {
    id: string
    name: string
    period_start: string
    period_end: string
    payroll_date: string | null
    status: string
    currency: string
    total_gross: number
    total_deductions: number
    total_net: number
    total_employer_contributions: number
    /** Not a column: present only in the calculate response. */
    employee_count?: number
    is_locked: boolean
    notes: string | null
    created_at: string
    approved_by: string | null
    approved_at: string | null
}

export interface PayrollRunItem {
    id: string
    payroll_run_id: string
    employee_user_id: string
    basic_salary: number
    overtime_amount: number
    allowances_amount: number
    work_minutes: number
    overtime_minutes: number
    gross_amount: number
    epf_employee: number
    epf_employer: number
    socso_employee: number
    socso_employer: number
    eis_employee: number
    eis_employer: number
    pcb_amount: number
    other_deductions: number
    other_allowances: number
    deductions_amount: number
    employer_contributions: number
    net_amount: number
    status: string
    employee?: { id: string; full_name: string | null; email: string }
}

export interface StatutoryConfig {
    epf_employee_rate: number
    epf_employer_rate: number
    socso_employee_rate: number
    socso_employer_rate: number
    eis_employee_rate: number
    eis_employer_rate: number
    pcb_enabled: boolean
    [key: string]: any
}

const parseJson = async <T>(response: Response): Promise<T> => {
    const data = await response.json()
    return data as T
}

// ── Salary Bands ────────────────────────────────────────────

export const fetchSalaryBands = async () => {
    const response = await fetch('/api/hr/payroll/salary-bands')
    const data = await parseJson<{ success: boolean; data?: SalaryBand[]; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to load salary bands' }
    return { success: true, data: data.data || [] }
}

export const createSalaryBand = async (payload: Partial<SalaryBand>) => {
    const response = await fetch('/api/hr/payroll/salary-bands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: SalaryBand; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to create salary band' }
    return { success: true, data: data.data }
}

export const updateSalaryBand = async (id: string, payload: Partial<SalaryBand>) => {
    const response = await fetch(`/api/hr/payroll/salary-bands/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: SalaryBand; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to update salary band' }
    return { success: true, data: data.data }
}

export const deleteSalaryBand = async (id: string) => {
    const response = await fetch(`/api/hr/payroll/salary-bands/${id}`, { method: 'DELETE' })
    const data = await parseJson<{ success: boolean; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to delete salary band' }
    return { success: true }
}

// ── Employee Compensation ────────────────────────────────────

export const fetchEmployeeCompensations = async () => {
    const response = await fetch('/api/hr/payroll/compensation')
    const data = await parseJson<{ success: boolean; data?: EmployeeCompensation[]; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to load compensation records' }
    return { success: true, data: data.data || [] }
}

export const upsertEmployeeCompensation = async (payload: Partial<EmployeeCompensation>) => {
    const response = await fetch('/api/hr/payroll/compensation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: EmployeeCompensation; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to save compensation' }
    return { success: true, data: data.data }
}

// ── Allowance Types ──────────────────────────────────────────

export const fetchAllowanceTypes = async () => {
    const response = await fetch('/api/hr/payroll/allowance-types')
    const data = await parseJson<{ success: boolean; data?: AllowanceType[]; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to load allowance types' }
    return { success: true, data: data.data || [] }
}

export const createAllowanceType = async (payload: Partial<AllowanceType>) => {
    const response = await fetch('/api/hr/payroll/allowance-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: AllowanceType; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to create allowance type' }
    return { success: true, data: data.data }
}

export const updateAllowanceType = async (id: string, payload: Partial<AllowanceType>) => {
    const response = await fetch(`/api/hr/payroll/allowance-types/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: AllowanceType; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to update allowance type' }
    return { success: true, data: data.data }
}

// ── Deduction Types ──────────────────────────────────────────

export const fetchDeductionTypes = async () => {
    const response = await fetch('/api/hr/payroll/deduction-types')
    const data = await parseJson<{ success: boolean; data?: DeductionType[]; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to load deduction types' }
    return { success: true, data: data.data || [] }
}

export const createDeductionType = async (payload: Partial<DeductionType>) => {
    const response = await fetch('/api/hr/payroll/deduction-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: DeductionType; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to create deduction type' }
    return { success: true, data: data.data }
}

export const updateDeductionType = async (id: string, payload: Partial<DeductionType>) => {
    const response = await fetch(`/api/hr/payroll/deduction-types/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: DeductionType; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to update deduction type' }
    return { success: true, data: data.data }
}

// ── Employee Allowances / Deductions ─────────────────────────

export const fetchEmployeeAllowances = async () => {
    const response = await fetch('/api/hr/payroll/employee-allowances')
    const data = await parseJson<{ success: boolean; data?: EmployeeAllowance[]; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to load employee allowances' }
    return { success: true, data: data.data || [] }
}

export const upsertEmployeeAllowance = async (payload: Partial<EmployeeAllowance>) => {
    const response = await fetch('/api/hr/payroll/employee-allowances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: EmployeeAllowance; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to save employee allowance' }
    return { success: true, data: data.data }
}

export const fetchEmployeeDeductions = async () => {
    const response = await fetch('/api/hr/payroll/employee-deductions')
    const data = await parseJson<{ success: boolean; data?: EmployeeDeduction[]; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to load employee deductions' }
    return { success: true, data: data.data || [] }
}

export const upsertEmployeeDeduction = async (payload: Partial<EmployeeDeduction>) => {
    const response = await fetch('/api/hr/payroll/employee-deductions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: EmployeeDeduction; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to save employee deduction' }
    return { success: true, data: data.data }
}

// ── Payroll Runs ─────────────────────────────────────────────

export const fetchPayrollRuns = async () => {
    const response = await fetch('/api/hr/payroll/runs')
    const data = await parseJson<{ success: boolean; data?: PayrollRun[]; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to load payroll runs' }
    return { success: true, data: data.data || [] }
}

export const createPayrollRun = async (payload: { name: string; period_start: string; period_end: string; payroll_date?: string; notes?: string }) => {
    const response = await fetch('/api/hr/payroll/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: PayrollRun; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to create payroll run' }
    return { success: true, data: data.data }
}

export const calculatePayrollRun = async (runId: string) => {
    const response = await fetch(`/api/hr/payroll/runs/${runId}/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    const data = await parseJson<{ success: boolean; data?: PayrollRun; error?: string; message?: string; errors?: Array<{ employee_user_id?: string; step: string; message: string }> }>(response)
    if (!response.ok || !data.success) {
        // PAYROLL_CALCULATION_FAILED: nothing was calculated; show the reason and the first problems.
        const problems = (data.errors || []).slice(0, 3).map((e) => e.message).join('; ')
        return { success: false, error: [data.message || data.error || 'Failed to calculate payroll', problems].filter(Boolean).join(' — ') }
    }
    return { success: true, data: data.data }
}

export const approvePayrollRun = async (runId: string) => {
    const response = await fetch(`/api/hr/payroll/runs/${runId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    const data = await parseJson<{ success: boolean; data?: PayrollRun; error?: string; message?: string }>(response)
    // PAYROLL_STATUTORY_NOT_CERTIFIED carries a readable message: approval stays blocked until certification.
    if (!response.ok || !data.success) return { success: false, error: data.message || data.error || 'Failed to approve payroll run' }
    return { success: true, data: data.data }
}

export const fetchPayrollRunItems = async (runId: string) => {
    const response = await fetch(`/api/hr/payroll/runs/${runId}/items`)
    const data = await parseJson<{ success: boolean; data?: PayrollRunItem[]; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to load payroll items' }
    return { success: true, data: data.data || [] }
}

// ── Statutory Settings ───────────────────────────────────────

export const fetchStatutoryConfig = async () => {
    const response = await fetch('/api/hr/payroll/statutory-settings')
    const data = await parseJson<{ success: boolean; data?: StatutoryConfig; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to load statutory config' }
    return { success: true, data: data.data }
}

export const updateStatutoryConfig = async (payload: Partial<StatutoryConfig>) => {
    const response = await fetch('/api/hr/payroll/statutory-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: StatutoryConfig; error?: string }>(response)
    if (!response.ok || !data.success) return { success: false, error: data.error || 'Failed to update statutory config' }
    return { success: true, data: data.data }
}
