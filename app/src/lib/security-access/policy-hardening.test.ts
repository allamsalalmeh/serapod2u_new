import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { seededProfilePermissions } from './coverage-audit'
import { BREAK_GLASS_POLICIES, DESTRUCTIVE_PERMISSIONS, FULL_ACCESS_POLICIES, FUNCTIONAL_STANDARD_POLICIES, OUTSIDE_FULL_ACCESS, isBreakGlassPolicy } from './group-policies'
import { SUPPORTING_READS, missingSupportingReads } from './policy-dependencies'
import { isSensitivePermission } from './profiles'
import { classifyPermission } from './modules'
import { NAV_DESTINATIONS, REPORTING_DESTINATION, REPORTING_PERMISSION, destinationAllowed } from './nav-access'

const migration = readFileSync(resolve(process.cwd(), '..', 'supabase', 'migrations', '20261110100000_sa_policy_hardening_and_new_standard_policies.sql'), 'utf8')
const seeded = seededProfilePermissions()
const keys = (role: string) => [...(seeded.get(role) ?? [])].sort()

describe('Standard Policy hardening — lock-step with 20261110100000', () => {
  it('no module Full Access policy holds a destructive operation', () => {
    for (const p of FULL_ACCESS_POLICIES) for (const k of DESTRUCTIVE_PERMISSIONS) expect(keys(p.roleKey), `${p.roleKey} ${k}`).not.toContain(k)
    expect(keys('finance-full-access')).toContain('finance.payment.approve')
    expect(keys('hr-payroll-full-access')).toHaveLength(25)
    expect(keys('finance-full-access')).toHaveLength(12)
    expect(keys('platform-settings-full-access')).toHaveLength(9)
    for (const k of DESTRUCTIVE_PERMISSIONS) expect(OUTSIDE_FULL_ACCESS).toContain(k)
  })

  it('every destructive operation lives in exactly one break-glass policy, in its own module', () => {
    for (const [role, perms] of Object.entries(BREAK_GLASS_POLICIES)) {
      expect(keys(role), role).toEqual([...perms].sort())
      expect(isBreakGlassPolicy(role)).toBe(true)
    }
    expect(Object.values(BREAK_GLASS_POLICIES).flat().sort()).toEqual([...DESTRUCTIVE_PERMISSIONS].sort())
    const holders = (k: string) => [...seeded.entries()].filter(([, s]) => s.has(k)).map(([r]) => r).filter(r => !r.startsWith('legacy-'))
    for (const k of DESTRUCTIVE_PERMISSIONS) expect(holders(k), k).toHaveLength(1)
  })

  it('the migration narrows Full Access only after moving current holders onto the break-glass policy', () => {
    expect(migration.indexOf('do $transfer$')).toBeGreaterThan(0)
    expect(migration.indexOf('do $transfer$')).toBeLessThan(migration.indexOf("select public.sa_narrow_standard_policy('hr-payroll-full-access'"))
    expect(migration).toContain("('finance-full-access', 'finance.data.reset', 'finance-data-reset-administrator')")
    expect(migration).toContain("('platform-settings-full-access', 'platform.identity.delete', 'platform-data-maintenance-administrator')")
    expect(migration).toContain("('hr-payroll-full-access', 'hr.data.reset', 'hr-data-reset-administrator')")
    // Narrowing is owner-only and never revokes an assignment.
    expect(migration).toMatch(/revoke all on function public\.sa_narrow_standard_policy\(text,text\[\],text\) from public, anon, authenticated, service_role;/)
    const fn = migration.slice(migration.indexOf('create or replace function public.sa_narrow_standard_policy'), migration.indexOf('revoke all on function public.sa_narrow_standard_policy'))
    expect(fn).not.toMatch(/update public\.sa_role_assignments|delete from public\.sa_role_assignments/)
  })

  it('the four functional policies hold exactly their reviewed lists, with supporting reads included', () => {
    for (const [role, perms] of Object.entries(FUNCTIONAL_STANDARD_POLICIES)) {
      expect(keys(role), role).toEqual([...perms].sort())
      expect(missingSupportingReads(perms).size, role).toBe(0)
      expect(perms.some(isSensitivePermission), role).toBe(false)
    }
    expect(FUNCTIONAL_STANDARD_POLICIES['warehouse-receiving-dispatch'].every(k => classifyPermission(k).groupId === 'supply_chain')).toBe(true)
    for (const role of ['hr-leave-attendance-administrator', 'hr-records-officer']) {
      expect(FUNCTIONAL_STANDARD_POLICIES[role].every(k => k.startsWith('hr.'))).toBe(true)
      expect(FUNCTIONAL_STANDARD_POLICIES[role].some(k => /payroll|compensation|commission|data\.reset|settings/.test(k)), role).toBe(false)
    }
  })

  it('organization eligibility: HQ only, warehouse staff for Receiving & Dispatch', () => {
    expect(migration).toMatch(/\('warehouse-receiving-dispatch',[^\n]*array\['HQ','WH'\],/)
    for (const role of ['finance-data-reset-administrator', 'platform-data-maintenance-administrator', 'hr-leave-attendance-administrator', 'hr-records-officer', 'reporting-viewer']) {
      expect(migration).toMatch(new RegExp(`\\('${role}',[^\\n]*array\\['HQ'\\],`))
    }
  })

  it('declares the same supporting reads as the app, and every standard policy satisfies them', () => {
    const block = migration.slice(migration.indexOf('insert into public.sa_permission_dependencies'), migration.indexOf('on conflict (permission_key, requires_key)'))
    const sql = [...block.matchAll(/\('([a-z_.]+)', '([a-z_.]+)', '/g)].map(m => `${m[1]}>${m[2]}`).sort()
    const app = Object.entries(SUPPORTING_READS).filter(([op]) => !op.startsWith('supply_chain.order.'))
      .flatMap(([op, reads]) => reads.map(r => `${op}>${r}`)).sort()
    expect(sql).toEqual(app)
    for (const [role, set] of seeded) {
      if (role.startsWith('legacy-')) continue
      expect([...missingSupportingReads([...set]).keys()], role).toEqual([])
    }
  })

  it('maker/checker for payroll and payment requests moves to enforce', () => {
    expect(migration).toMatch(/set enforcement = 'enforce'[\s\S]*rule_key in \('payroll-prepare-approve', 'payment-request-maker-checker'\) and enforcement <> 'enforce'/)
    expect(migration).toContain("'sod.rule_enforcement_changed'")
  })

  it('changes no permission key or migration mode', () => {
    expect(migration).not.toMatch(/insert into public\.sa_permissions\b|update public\.sa_permissions\b|delete from public\.sa_permissions\b/)
    expect(migration).not.toMatch(/insert into public\.sa_migration_modes|update public\.sa_migration_modes/)
    expect(migration).not.toMatch(/legacy_compat_rules/)
  })

  it('Reporting opens exactly on reporting.analytics.view (Reporting Viewer), like its API routes', () => {
    const req = NAV_DESTINATIONS[REPORTING_DESTINATION]
    expect(req).toEqual({ org: [REPORTING_PERMISSION] })
    expect(destinationAllowed(req, { org: { [REPORTING_PERMISSION]: true }, self: {} })).toBe(true)
    expect(destinationAllowed(req, { org: { 'finance.report.view_sensitive': true }, self: {} })).toBe(false)
    expect(keys('reporting-viewer')).toEqual([REPORTING_PERMISSION])
  })
})
