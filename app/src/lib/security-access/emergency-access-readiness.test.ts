import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isEnforcementReady } from './readiness'
import { BLOCKER_MESSAGES, blockerMessage } from './bulk-modes'

/**
 * Grant Emergency Access (security.emergency_access.grant) stays unregistered:
 * there is no grant path to wire. The only entry point,
 * sa_request_emergency_access, refuses unconditionally
 * (emergency_access_activation_not_implemented, behind the MFA step-up
 * prerequisite) and never decides the permission; sa_emergency_access_grants
 * has no write grant or policy for API roles and no application writer.
 * Registering readiness must wait for a real, permission-checked grant flow.
 */
const migrations = resolve(process.cwd(), '..', 'supabase', 'migrations')
const files = readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()

describe('Grant Emergency Access readiness', () => {
  it('is not enforcement-ready in the application', () => {
    expect(isEnforcementReady('security.emergency_access.grant')).toBe(false)
  })

  it('no migration registers it in sa_enforcement_readiness', () => {
    for (const f of files) {
      const sql = readFileSync(resolve(migrations, f), 'utf8')
      for (const m of sql.matchAll(/insert into public\.sa_enforcement_readiness[\s\S]*?;/gi))
        expect(m[0], f).not.toContain("'security.emergency_access.grant'")
    }
  })

  it('the latest sa_request_emergency_access is still the refusing stub', () => {
    const defs = files.flatMap(f => {
      const sql = readFileSync(resolve(migrations, f), 'utf8')
      const at = sql.indexOf('create or replace function public.sa_request_emergency_access')
      return at > -1 ? [sql.slice(at, sql.indexOf('end $$;', at))] : []
    })
    expect(defs.length).toBeGreaterThan(0)
    expect(defs.at(-1)).toContain('emergency_access_activation_not_implemented')
  })

  it('explains the block as a missing grant flow, other permissions keep the generic text', () => {
    expect(blockerMessage('security.emergency_access.grant', 'sa_not_enforcement_ready')).toMatch(/no grant flow/)
    expect(blockerMessage('security.role.assign', 'sa_not_enforcement_ready')).toBe(BLOCKER_MESSAGES.sa_not_enforcement_ready)
    expect(blockerMessage('security.emergency_access.grant', 'sa_permission_unknown')).toBe(BLOCKER_MESSAGES.sa_permission_unknown)
  })
})
