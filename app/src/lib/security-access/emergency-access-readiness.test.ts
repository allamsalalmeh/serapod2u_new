import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isEnforcementReady } from './readiness'
import { BLOCKER_MESSAGES, blockerMessage } from './bulk-modes'

/**
 * Grant Emergency Access (security.emergency_access.grant).
 *
 * Database: 20261024100000 added the real grant flow — sa_grant_emergency_access (service role only) re-verifies the
 * actor's permission and a fresh MFA step-up (sa_assert_fresh_step_up) — and registered database readiness only
 * together with it. The old request stub now refuses and nobody may execute it. Emergency access stays switched off:
 * only the explicit opt-in 20261024110000 turns emergency_access.enabled on.
 *
 * Application: there is no TOTP enrollment / step-up / grant screen yet, so the application keeps the permission
 * not enforcement-ready.
 */
const migrations = resolve(process.cwd(), '..', 'supabase', 'migrations')
const files = readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()
const read = (f: string) => readFileSync(resolve(migrations, f), 'utf8')
const GRANT_FLOW = '20261024100000_sa_emergency_access_grant_flow.sql'
const ENABLE_OPT_IN = '20261024110000_sa_emergency_access_enable.sql'

describe('Grant Emergency Access readiness', () => {
  it('is not enforcement-ready in the application', () => {
    expect(isEnforcementReady('security.emergency_access.grant')).toBe(false)
  })

  it('database readiness is registered only by the migration that adds the step-up-checked grant flow', () => {
    const registering = files.filter(f => [...read(f).matchAll(/insert into public\.sa_enforcement_readiness[\s\S]*?;/gi)]
      .some(m => m[0].includes("'security.emergency_access.grant'")))
    expect(registering).toEqual([GRANT_FLOW])
    const sql = read(GRANT_FLOW)
    expect(sql).toContain('create or replace function public.sa_grant_emergency_access(')
    expect(sql).toContain('public.sa_assert_fresh_step_up(p_actor, p_step_up_session)')
    expect(sql).toMatch(/revoke all on function public\.sa_grant_emergency_access\([^)]*\) from public, anon, authenticated;/)
  })

  it('the latest sa_request_emergency_access refuses and nobody may execute it', () => {
    const defs = files.flatMap(f => {
      const sql = read(f)
      const at = sql.indexOf('create or replace function public.sa_request_emergency_access')
      return at > -1 ? [{ f, body: sql.slice(at, sql.indexOf('end $$;', at)) }] : []
    })
    expect(defs.length).toBeGreaterThan(0)
    const latest = defs.at(-1)!
    expect(latest.body).toMatch(/^\s*begin\s+raise exception 'emergency_access_use_grant_flow'/m)
    expect(read(latest.f)).toMatch(/revoke all on function public\.sa_request_emergency_access\([^)]*\) from public, anon, authenticated, service_role;/)
  })

  it('only the explicit opt-in migration switches emergency access on', () => {
    const enabling = files.filter(f => /update public\.sa_settings set setting_value = 'true'[\s\S]*?setting_key = 'emergency_access\.enabled'/i
      .test(read(f).replace(/^\s*--.*$/gm, '')))
    expect(enabling.every(f => f === ENABLE_OPT_IN)).toBe(true)
  })

  it('explains the block as a missing grant flow, other permissions keep the generic text', () => {
    expect(blockerMessage('security.emergency_access.grant', 'sa_not_enforcement_ready')).toMatch(/no grant flow/)
    expect(blockerMessage('security.role.assign', 'sa_not_enforcement_ready')).toBe(BLOCKER_MESSAGES.sa_not_enforcement_ready)
    expect(blockerMessage('security.emergency_access.grant', 'sa_permission_unknown')).toBe(BLOCKER_MESSAGES.sa_permission_unknown)
  })
})
