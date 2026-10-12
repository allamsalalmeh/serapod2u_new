import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyPermission } from './modules'
import { MSS_PERMISSION_KEYS, MSS_ROLE_KEY, MSS_STANDARD_POLICY } from './mss'

const migration = readFileSync(resolve(process.cwd(), '..', 'supabase', 'migrations', '20261103100000_hr_mss_compensation_viewer.sql'), 'utf8')

describe('Manager Self-Service permissions ↔ migration lock-step', () => {
  it('seeds exactly these six permissions, all security-sensitive, no legacy audience', () => {
    const seeded = [...migration.matchAll(/^ \('(hr\.mss\.[a-z.]+)','hr','mss','[a-z.]+',.*,'new','security_sensitive'\)/gm)]
    expect(seeded.map((m) => m[1]).sort()).toEqual([...MSS_PERMISSION_KEYS].sort())
    expect(seeded.every((m) => m[0].includes("'security_sensitive')"))).toBe(true)
    const keysFn = /hr_mss_permission_keys\(\)[\s\S]*?select array\[([^\]]+)\]/.exec(migration)?.[1] ?? ''
    expect([...keysFn.matchAll(/'([a-z.]+)'/g)].map((m) => m[1])).toEqual([...MSS_PERMISSION_KEYS])
    expect(migration).toMatch(/hr\.mss\.[a-z.]+'[\s\S]*?select k, null, '\{\}', '\{\}', false, 'Manager self-service/)
  })

  it('seeds the manager-self-service policy with exactly these permissions and never assigns it', () => {
    const [key, perms] = Object.entries(MSS_STANDARD_POLICY)[0]
    const block = new RegExp(`'key', '${key}'[\\s\\S]*?'perms', jsonb_build_array\\(([^)]*)\\)`).exec(migration)?.[1] ?? ''
    expect([...block.matchAll(/'([a-z.]+)'/g)].map((m) => m[1]).sort(), key).toEqual([...perms].sort())
    expect(MSS_STANDARD_POLICY[key]).toContain('hr.mss.leave.approve')
    expect(migration).not.toMatch(/insert into public\.sa_role_assignments/i)
    // HR & Payroll Full Access is not extended: MSS is a separate, explicitly granted policy.
    expect(migration).not.toMatch(/sa_extend_standard_policy\('hr-payroll-full-access'/m)
    // MSS never includes compensation permissions.
    expect(perms).not.toContain('hr.compensation.salary.view')
  })

  it('classifies MSS under HR & Payroll', () => {
    expect(classifyPermission('hr.mss.team.view').groupId).toBe('hr_payroll')
    expect(classifyPermission('hr.mss.leave.approve').groupId).toBe('hr_payroll')
  })

  it('exposes the standard policy role key', () => {
    expect(MSS_ROLE_KEY).toBe('manager-self-service')
  })
})
