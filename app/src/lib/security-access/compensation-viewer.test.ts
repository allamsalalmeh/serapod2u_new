import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyPermission } from './modules'
import { COMPENSATION_VIEWER_PERMISSION_KEYS, COMPENSATION_VIEWER_ROLE_KEY, COMPENSATION_VIEWER_STANDARD_POLICY } from './compensation-viewer'

const migration = readFileSync(resolve(process.cwd(), '..', 'supabase', 'migrations', '20261103100000_hr_mss_compensation_viewer.sql'), 'utf8')
const rls = readFileSync(resolve(process.cwd(), '..', 'supabase', 'migrations', '20261104100000_hr_mss_compensation_rls.sql'), 'utf8')
const columns = readFileSync(resolve(process.cwd(), '..', 'supabase', 'migrations', '20261105100000_hr_compensation_column_grants.sql'), 'utf8')

describe('Manager Compensation Viewer permissions ↔ migration lock-step', () => {
  it('seeds exactly these two permissions, all security-sensitive, no legacy audience', () => {
    const seeded = [...migration.matchAll(/^ \('(hr\.compensation\.(?:salary|allowance)_view)','hr','compensation','[a-z_]+',.*,'new','security_sensitive'\)/gm)]
    expect(seeded.map((m) => m[1]).sort()).toEqual([...COMPENSATION_VIEWER_PERMISSION_KEYS].sort())
    expect(seeded.every((m) => m[0].includes("'security_sensitive')"))).toBe(true)
    const keysFn = /hr_compensation_viewer_permission_keys\(\)[\s\S]*?select array\[([^\]]+)\]/.exec(migration)?.[1] ?? ''
    expect([...keysFn.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1])).toEqual([...COMPENSATION_VIEWER_PERMISSION_KEYS])
    expect(migration).toMatch(/hr\.compensation\.(?:salary|allowance)_view'[\s\S]*?select k, null, '\{\}', '\{\}', false/)
  })

  it('seeds the manager-compensation-viewer policy with exactly these permissions and never assigns it', () => {
    const [key, perms] = Object.entries(COMPENSATION_VIEWER_STANDARD_POLICY)[0]
    const block = new RegExp(`'key', '${key}'[\\s\\S]*?'perms', jsonb_build_array\\(([^)]*)\\)`).exec(migration)?.[1] ?? ''
    expect([...block.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort(), key).toEqual([...perms].sort())
    expect(migration).not.toMatch(/insert into public\.sa_role_assignments/i)
    expect(migration).not.toMatch(/sa_extend_standard_policy\('hr-payroll-full-access'/m)
    // The viewer is read-only: only *_view permissions.
    expect(perms.every((p) => p.endsWith('_view'))).toBe(true)
  })

  it('classifies the viewer under HR & Payroll (Payroll & Compensation)', () => {
    expect(classifyPermission('hr.compensation.salary_view').groupId).toBe('hr_payroll')
    expect(classifyPermission('hr.compensation.salary_view').areaName).toBe('Payroll & Compensation')
  })

  it('exposes the standard policy role key', () => {
    expect(COMPENSATION_VIEWER_ROLE_KEY).toBe('manager-compensation-viewer')
  })
})

describe('Manager Compensation Viewer row-level security migration', () => {
  it('adds RLS SELECT policies to both sensitive compensation tables for direct-report managers', () => {
    expect(rls).toMatch(/create policy hr_mss_compensation_salary_view on public\.hr_employee_compensation[\s\S]*?for select to authenticated[\s\S]*?hr_mss_salary_viewer_can_read\(employee_id\)/)
    expect(rls).toMatch(/create policy hr_mss_compensation_allowance_view on public\.hr_employee_allowances[\s\S]*?for select to authenticated[\s\S]*?hr_mss_allowance_viewer_can_read\(employee_id\)/)
  })

  it('predicates require the matching permission, the company and the CURRENT direct-report relationship', () => {
    expect(rls).toMatch(/hr_mss_salary_viewer_can_read[\s\S]*?hr_compensation_viewer_allowed\('hr\.compensation\.salary_view'/)
    expect(rls).toMatch(/hr_mss_allowance_viewer_can_read[\s\S]*?hr_compensation_viewer_allowed\('hr\.compensation\.allowance_view'/)
    expect(rls).toMatch(/hr_manager_is_direct_report\(auth\.uid\(\), p_employee_user_id\)/)
  })

  it('keeps the direct-report helper service-role only while exposing the predicates to authenticated (RLS)', () => {
    expect(rls).toMatch(/grant execute on function public\.hr_mss_salary_viewer_can_read\(uuid\) to authenticated/)
    expect(rls).toMatch(/grant execute on function public\.hr_mss_allowance_viewer_can_read\(uuid\) to authenticated/)
    expect(rls).toMatch(/direct-report helper must stay service-role only/)
  })

  it('is ordered after the Commission migrations and the viewer migration', () => {
    expect('20261104100000_hr_mss_compensation_rls.sql' > '20261102120000_hr_commission_policies.sql').toBe(true)
    expect('20261104100000_hr_mss_compensation_rls.sql' > '20261103100000_hr_mss_compensation_viewer.sql').toBe(true)
  })
})

describe('Manager Compensation Viewer column-level grants', () => {
  it('revokes whole-table SELECT and grants only the permitted columns to authenticated', () => {
    expect(columns).toMatch(/revoke select on public\.hr_employee_compensation from authenticated/)
    expect(columns).toMatch(/revoke select on public\.hr_employee_allowances from authenticated/)
    expect(columns).toMatch(/grant select \(id, organization_id, employee_id, basic_salary, currency, effective_date, end_date, status\)[\s\S]*?on public\.hr_employee_compensation to authenticated/)
    expect(columns).toMatch(/grant select \(id, organization_id, employee_id, allowance_type_id, amount, currency, effective_date, end_date, is_active\)[\s\S]*?on public\.hr_employee_allowances to authenticated/)
  })

  it('post-conditions forbid hourly_rate, salary_band_id and notes for the API role', () => {
    expect(columns).toMatch(/must not select hourly_rate \/ salary_band_id \/ notes/)
    expect(columns).toMatch(/must not select notes on hr_employee_allowances/)
  })

  it('preserves the service role full read for the authorized payroll routes', () => {
    expect(columns).toMatch(/service_role must keep full SELECT/)
  })
})
