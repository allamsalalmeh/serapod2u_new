import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findUnknownTables, findViolations, listSourceFiles, loadHrSchema, scanSource } from './schema-contract'
import { buildPayrollLine, STATUTORY_DEFAULTS } from './payroll-calculation'
import {
  attendanceAuditRow, buildCorrectionEntryUpdate, buildOvertimeRequestInsert, overtimeDecisionUpdate, summarizeTimesheetEntries, timesheetRow,
} from './attendance-repairs'

/**
 * HR column contract (B2B). Every literal column that HR code writes, filters on or selects on an hr_* table must exist
 * in the committed schema snapshot (staging, 2026-10-16) or be added by a later migration. Pure static analysis.
 *
 * KNOWN_BASELINE: defects found by this check on 2026-10-24 that are OUTSIDE the B2B repair scope (HR assistant
 * read-only tools). They are recorded in docs/hr (HR_PROGRESS_TRACKER §4) and must only ever shrink.
 */
const KNOWN_BASELINE = new Set([
  'src/lib/server/hr/assistant/tools.ts hr_positions.title',
  'src/lib/server/hr/assistant/tools.ts hr_positions.department_id',
  'src/lib/server/hr/assistant/tools.ts hr_leave_types.annual_entitlement',
  'src/lib/server/hr/assistant/tools.ts hr_leave_types.is_paid',
  'src/lib/server/hr/assistant/tools.ts hr_attendance_policies.name',
  'src/lib/server/hr/assistant/tools.ts hr_settings.payroll_day',
  'src/lib/server/hr/assistant/tools.ts hr_settings.epf_employer_rate',
  'src/lib/server/hr/assistant/tools.ts hr_settings.socso_enabled',
])
/** Tables referenced by HR code that do not exist in the snapshot or any later migration (2026-10-24 baseline). */
// hr_employee_profiles created by Wave 2 (20261221100000) — removed from the baseline 2026-10-25.
const KNOWN_MISSING_TABLES = ['hr_control_accounts', 'hr_payroll_gl_mappings']

const appDir = path.resolve(__dirname, '../../..')
const repoRoot = path.resolve(appDir, '..')
const schema = loadHrSchema(repoRoot)
const SCANNED = ['src/app/api/hr', 'src/components/hr', 'src/modules/hr', 'src/lib/hr', 'src/lib/server/hr', 'src/lib/api/payroll.ts']
const usages = listSourceFiles(SCANNED.map((d) => path.join(appDir, d)))
  .flatMap((f) => scanSource(path.relative(appDir, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')))

const columnsOf = (table: string) => schema.get(table) ?? new Set<string>()
const notInTable = (table: string, keys: string[]) => keys.filter((k) => !columnsOf(table).has(k))

describe('HR column contract', () => {
  it('loads the schema snapshot', () => {
    expect(schema.size).toBeGreaterThan(50)
    expect(columnsOf('hr_payroll_run_items').has('employee_user_id')).toBe(true)
    expect(columnsOf('hr_leave_request_events').has('actor_ref')).toBe(true) // from migration 20261219100000
  })

  it('HR code uses only existing columns (except the recorded baseline)', () => {
    const unexpected = findViolations(schema, usages)
      .filter((u) => !KNOWN_BASELINE.has(`${u.file} ${u.table}.${u.column}`))
      .map((u) => `${u.file}:${u.line} ${u.table}.${u.column} (${u.kind})`)
    expect(unexpected).toEqual([])
  })

  it('the baseline only shrinks (remove an entry once it is fixed)', () => {
    const current = new Set(findViolations(schema, usages).map((u) => `${u.file} ${u.table}.${u.column}`))
    expect([...KNOWN_BASELINE].filter((k) => !current.has(k))).toEqual([])
  })

  it('no new reference to a table that does not exist', () => {
    expect(findUnknownTables(schema, usages)).toEqual(KNOWN_MISSING_TABLES)
  })

  it('B2B repaired routes are clean', () => {
    const repaired = [
      'src/app/api/hr/payroll/runs/[id]/calculate/route.ts', 'src/app/api/hr/payroll/runs/[id]/approve/route.ts',
      'src/app/api/hr/payroll/runs/route.ts', 'src/app/api/hr/payroll/statutory-settings/route.ts',
      'src/app/api/hr/attendance/corrections/[id]/review/route.ts', 'src/app/api/hr/attendance/timesheets/route.ts',
      'src/app/api/hr/attendance/overtime/requests/route.ts', 'src/app/api/hr/attendance/overtime/preview/route.ts',
      'src/app/api/hr/public-holidays/route.ts', 'src/app/api/hr/config/audit/route.ts', 'src/app/api/hr/accounting/preview-journal/route.ts',
      'src/components/hr/mobile/HrMobileLeave.tsx',
    ]
    expect(findViolations(schema, usages).filter((u) => repaired.includes(u.file))).toEqual([])
  })

  it('rows built by the B2B helpers use only real columns', () => {
    const line = buildPayrollLine({
      organizationId: 'o', runId: 'r', rates: STATUTORY_DEFAULTS,
      compensation: { employee_id: 'e', basic_salary: 3000, hourly_rate: null, ot_eligible: null, effective_date: null, end_date: null },
      allowances: [], deductions: [], timesheets: [],
    })
    expect(notInTable('hr_payroll_run_items', Object.keys(line))).toEqual([])
    expect(notInTable('hr_timesheets', Object.keys(timesheetRow({
      userId: 'u', organizationId: 'o', periodStart: '2026-10-01', periodEnd: '2026-10-31', totals: summarizeTimesheetEntries([]),
    })))).toEqual([])
    const ot = buildOvertimeRequestInsert({ organizationId: 'o', employeeId: 'e', body: { request_date: '2026-10-01', reason: 'x', ot_minutes: 60 } })
    expect(ot.ok && notInTable('hr_overtime_requests', Object.keys(ot.row))).toEqual([])
    expect(notInTable('hr_overtime_requests', Object.keys(overtimeDecisionUpdate('a', 'approved', 'ok')))).toEqual([])
    expect(notInTable('hr_attendance_audit', Object.keys(attendanceAuditRow({
      organizationId: 'o', actorId: 'a', entityType: 't', entityId: 'i', action: 'x', metadata: {},
    })))).toEqual([])
    const fix = buildCorrectionEntryUpdate({
      id: 'c', entry_id: 'e', requested_by: 'u', status: 'pending', corrected_clock_in: '2026-10-01T09:00:00Z', corrected_clock_out: '2026-10-01T18:00:00Z',
    })
    expect(fix.ok && notInTable('hr_attendance_entries', Object.keys(fix.updates))).toEqual([])
  })

  it('detects an injected bad column (negative control)', () => {
    const bad = `supabase.from('hr_payroll_run_items').insert({ employee_id: 'x', gross_salary: 1 }).eq('net_salary', 1).select('id, review_note')`
    const found = findViolations(schema, scanSource('injected.ts', bad)).map((u) => u.column)
    expect(found).toEqual(['employee_id', 'gross_salary', 'net_salary', 'review_note'])
  })
})
