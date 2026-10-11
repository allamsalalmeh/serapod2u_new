import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyPermission } from './modules'
import { COMMISSION_PERMISSION_KEYS, COMMISSION_STANDARD_POLICIES, parseCommissionAccess } from './commission'

const migrations = resolve(process.cwd(), '..', 'supabase', 'migrations')
const core = readFileSync(resolve(migrations, '20261102110000_hr_commission_core.sql'), 'utf8')
const policies = readFileSync(resolve(migrations, '20261102120000_hr_commission_policies.sql'), 'utf8')

describe('Staff Commission permissions ↔ migrations lock-step', () => {
  it('seeds exactly these permissions, all security-sensitive, with no legacy audience', () => {
    const seeded = [...core.matchAll(/^ \('((?:hr|reporting)\.commission\.[a-z]+)','[a-z]+','commission','[a-z]+','[^']*','new','([a-z_]+)'\)/gm)]
    expect(seeded.map((m) => m[1]).sort()).toEqual([...COMMISSION_PERMISSION_KEYS].sort())
    expect(new Set(seeded.map((m) => m[2]))).toEqual(new Set(['security_sensitive']))
    const keysFn = /hr_commission_permission_keys\(\)[\s\S]*?select array\[([^\]]+)\]/.exec(core)?.[1] ?? ''
    expect([...keysFn.matchAll(/'([a-z.]+)'/g)].map((m) => m[1])).toEqual([...COMMISSION_PERMISSION_KEYS])
    expect(core).toMatch(/sa_legacy_compat_rules[\s\S]*select k, null, '\{\}', '\{\}', false/)
    expect(core).not.toMatch(/update\s+public\.sa_migration_modes\s+set\s+mode/i)
  })

  it('seeds the three standard policies with exactly these permissions and never assigns them', () => {
    for (const [key, perms] of Object.entries(COMMISSION_STANDARD_POLICIES)) {
      const block = new RegExp(`'key', '${key}'[\\s\\S]*?'perms', jsonb_build_array\\(([^)]*)\\)`).exec(policies)?.[1] ?? ''
      expect([...block.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]).sort(), key).toEqual([...perms].sort())
    }
    expect(COMMISSION_STANDARD_POLICIES['commission-administrator']).not.toContain('hr.commission.approve')
    expect(COMMISSION_STANDARD_POLICIES['commission-approver']).not.toContain('hr.commission.manage')
    expect(policies).not.toMatch(/insert into public\.sa_role_assignments/i)
    // HR & Payroll Full Access is not extended by a migration (only documented).
    expect(policies).not.toMatch(/^select public\.sa_extend_standard_policy/m)
  })

  it('classifies HR commission under HR & Payroll and Commission Reporting under Reporting', () => {
    expect(classifyPermission('hr.commission.approve').groupId).toBe('hr_payroll')
    expect(classifyPermission('reporting.commission.export').groupId).toBe('reporting')
  })

  it('parses the access summary fail-closed', () => {
    expect(parseCommissionAccess(null)['hr.commission.view']).toBe(false)
    const a = parseCommissionAccess({ company_id: 'c1', 'hr.commission.view': true, 'hr.commission.approve': 'yes' })
    expect(a.companyId).toBe('c1')
    expect(a['hr.commission.view']).toBe(true)
    expect(a['hr.commission.approve']).toBe(false)
  })
})
