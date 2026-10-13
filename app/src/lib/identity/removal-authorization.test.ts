import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IDENTITY_ARCHIVE_ENFORCEMENT_READY } from '@/lib/security-access/identity-catalog'
import { isEnforcementReady } from '@/lib/security-access/readiness'
import { ROUTE_COVERAGE } from '@/lib/security-access/route-coverage'
import { legacyTargetAllowed, superAdminTargetProtected } from './removal-authorization'

const src = (p: string) => readFileSync(resolve(process.cwd(), 'src', p), 'utf8')
const migrations = resolve(process.cwd(), '..', 'supabase', 'migrations')
const sql = (f: string) => readFileSync(resolve(migrations, f), 'utf8')
const readiness = sql('20261023100000_sa_identity_delete_enforcement_ready.sql')
const modes = sql('20261019110000_sa_mode_change_note_and_keep_retired.sql')

describe('Archive Identities readiness ↔ migration lock-step', () => {
  it('registers exactly the key the application treats as ready', () => {
    const seg = readiness.slice(readiness.indexOf('insert into public.sa_enforcement_readiness'), readiness.indexOf('on conflict (permission_key)', readiness.indexOf('insert into public.sa_enforcement_readiness')))
    const keys = [...seg.matchAll(/^ \('([a-z_.]+)'/gm)].map(m => m[1]).sort()
    expect(keys).toEqual([...IDENTITY_ARCHIVE_ENFORCEMENT_READY].sort())
    expect(isEnforcementReady('platform.identity.delete')).toBe(true)
  })

  it('changes no migration mode and checks its prerequisites (governance function, dominance, guards)', () => {
    expect(readiness).not.toMatch(/update\s+public\.sa_migration_modes/i)
    expect(readiness).not.toMatch(/insert into public\.sa_migration_modes/i)
    for (const prereq of ['identity_set_account_status', 'sa_actor_dominates', 'users_protect_access_fields', 'users_history_delete_guard'])
      expect(readiness, prereq).toContain(prereq)
  })

  it('preview and execution read the same readiness source (single and group change)', () => {
    const evaluate = modes.slice(modes.indexOf('create or replace function public.sa_bulk_mode_evaluate'), modes.indexOf('revoke all on function public.sa_bulk_mode_evaluate'))
    const apply = modes.slice(modes.indexOf('create or replace function public.sa_apply_migration_mode'), modes.indexOf('revoke all on function public.sa_apply_migration_mode'))
    const bulk = modes.slice(modes.indexOf('create or replace function public.sa_bulk_set_migration_mode'))
    expect(evaluate).toContain('public.sa_enforcement_readiness')
    expect(apply).toContain('public.sa_enforcement_readiness')
    // The group change re-evaluates at submission with the same function the preview uses, then applies each key.
    expect(bulk).toContain('public.sa_bulk_mode_evaluate(v_keys, p_target)')
    expect(bulk).toContain('public.sa_apply_migration_mode(p_actor, v_key, p_target, v_note, v_batch)')
  })
})

describe('every identity removal path decides Archive Identities', () => {
  const helper = 'lib/identity/removal-authorization.ts'

  it('the OTP routes, bulk delete and the server action call the shared target-scoped decision before mutating', () => {
    const request = src('app/api/admin/delete-user-otp/request/route.ts')
    expect(request.indexOf('authorizeIdentityRemoval(user.id, targetUserId)')).toBeGreaterThan(-1)
    expect(request.indexOf('authorizeIdentityRemoval(')).toBeLessThan(request.indexOf("from('auth_verification_codes')"))

    const verify = src('app/api/admin/delete-user-otp/verify-and-delete/route.ts')
    const decide = verify.indexOf('authorizeIdentityRemoval(user.id, targetUserId)')
    expect(decide).toBeGreaterThan(-1)
    // Decided before the OTP is read, counted or consumed, and before any account mutation.
    expect(decide).toBeLessThan(verify.indexOf("from('auth_verification_codes')"))
    expect(decide).toBeLessThan(verify.indexOf('archiveIdentityKeepingIdentifiers('))
    expect(decide).toBeLessThan(verify.indexOf("from('users').delete()"))
    expect(verify).not.toMatch(/account_status:\s*'ARCHIVED'/) // the archive write lives in the shared helper only

    const bulk = src('app/api/admin/bulk-delete-users/route.ts')
    expect(bulk.indexOf('authorizeIdentityRemoval(callerId, id)')).toBeGreaterThan(-1)
    expect(bulk.indexOf('authorizeIdentityRemoval(')).toBeLessThan(bulk.indexOf('batchDeleteRelatedData(batch'))

    const actions = src('lib/actions.ts')
    const fn = actions.slice(actions.indexOf('export async function deleteUserWithAuth'), actions.indexOf('export async function', actions.indexOf('export async function deleteUserWithAuth') + 10))
    expect(fn.indexOf('authorizeIdentityRemoval(currentUser!.id, userId)')).toBeGreaterThan(-1)
    expect(fn.indexOf('authorizeIdentityRemoval(')).toBeLessThan(fn.indexOf(".from('audit_logs')"))
  })

  it('the helper decides for the target organization and archives through the governance function once enforced', () => {
    const code = src(helper)
    expect(code).toContain("export const IDENTITY_REMOVAL_PERMISSION = 'platform.identity.delete'")
    expect(code).toMatch(/organizationResource\('user', row\?\.organization_id \?\? actorOrganizationId/)
    expect(code).toContain("setIdentityAccountStatus(actorId, targetUserId, 'ARCHIVED', reason)")
    expect(code).toContain('targetProtectionAllows(actorId, target.id, IDENTITY_REMOVAL_PERMISSION')
    expect(code).not.toMatch(/auth\.admin\.deleteUser/) // archive never deletes
  })

  it('organization deletion (which deletes every member identity) decides each member before deleting', () => {
    for (const file of ['app/api/organizations/delete/verify-and-delete/route.ts', 'app/api/organizations/delete/route.ts', 'app/api/organizations/delete/request-otp/route.ts']) {
      const code = src(file)
      const decide = code.indexOf('authorizeOrganizationIdentityRemoval(')
      expect(decide, file).toBeGreaterThan(-1)
      const rpc = code.indexOf("rpc('hard_delete_organization'")
      if (rpc > -1) expect(decide, file).toBeLessThan(rpc)
      const otp = code.indexOf("from('auth_verification_codes')")
      if (otp > -1) expect(decide, file).toBeLessThan(otp)
    }
    const code = src(helper)
    const fn = code.slice(code.indexOf('export async function authorizeOrganizationIdentityRemoval'))
    expect(fn).toContain("eq('organization_id', organizationId)")
    expect(fn).toContain('authorizeIdentityRemoval(actorId, id)')
  })

  it('the lifecycle server action cannot archive', () => {
    const actions = src('lib/actions.ts')
    const fn = actions.slice(actions.indexOf('export async function setUserAccountStatus'), actions.indexOf('export async function deleteUserWithAuth'))
    expect(fn).toContain("['ACTIVE', 'SUSPENDED', 'DISABLED'].includes(status)")
  })

  it('route coverage declares platform.identity.delete with the helper for every removal route', () => {
    for (const route of ['admin/delete-user-otp/request', 'admin/delete-user-otp/verify-and-delete', 'admin/bulk-delete-users',
      'organizations/delete', 'organizations/delete/request-otp', 'organizations/delete/verify-and-delete']) {
      const coverage = ROUTE_COVERAGE[route] as any
      expect(coverage.permissions, route).toContain('platform.identity.delete')
      expect(coverage.via, route).toContain(helper)
    }
  })

  it('the User Management delete control follows the S&A answer once enforced', () => {
    const ui = src('components/users/UserManagementNew.tsx')
    expect(ui).toContain('useSaCapability("platform.identity.delete", resolveCurrentUserLevel() <= 10)')
    expect(ui).not.toContain('will be released for reuse')
  })
})

describe('target protection rules', () => {
  it('a Super Admin target needs a Super Admin actor in every mode', () => {
    expect(superAdminTargetProtected(10, 1)).toBe(true)
    expect(superAdminTargetProtected(null, 1)).toBe(true)
    expect(superAdminTargetProtected(1, 1)).toBe(false)
    expect(superAdminTargetProtected(10, 10)).toBe(false)
  })
  it('legacy: never a more privileged legacy role', () => {
    expect(legacyTargetAllowed(10, 40)).toBe(true)
    expect(legacyTargetAllowed(10, 10)).toBe(true)
    expect(legacyTargetAllowed(10, 1)).toBe(false)
    expect(legacyTargetAllowed(null, 40)).toBe(false)
    expect(legacyTargetAllowed(10, null)).toBe(true)
  })
})
