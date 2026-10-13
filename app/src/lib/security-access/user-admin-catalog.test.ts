import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FINAL_WAVE_PERMISSION_KEYS, compatGrants } from './catalog'
import { IDENTITY_PERMISSION_KEYS } from './identity-catalog'
import { ALL_ENFORCEMENT_READY_PERMISSIONS } from './readiness'
import { ROUTE_COVERAGE } from './route-coverage'
import { classifyPermission } from './modules'
import { permissionLabel } from './labels'
import { isForbiddenForPartner, isSensitivePermission } from './profiles'
import {
  USER_ADMIN_CATALOG, USER_ADMIN_ENFORCEMENT_READY, USER_PASSWORD_RESET_PERMISSION, USER_PASSWORD_RESET_ROLE, USER_PASSWORD_RESET_ROLE_NAME,
} from './user-admin-catalog'

const migration = readFileSync(new URL('../../../../supabase/migrations/20261016100000_sa_user_password_reset_permission.sql', import.meta.url), 'utf8')
const route = readFileSync(new URL('../../app/api/users/reset-password/route.ts', import.meta.url), 'utf8')

describe('User Administration password-reset permission ↔ migration lock-step', () => {
  it('seeds the same key, sensitivity and compatibility rule', () => {
    expect(migration).toContain(`('${USER_PASSWORD_RESET_PERMISSION}','platform','user','password_reset'`)
    expect(migration).toMatch(/'new','security_sensitive'\)/)
    expect(USER_ADMIN_CATALOG[0].sensitivity).toBe('security_sensitive')
    expect(migration).toContain(`('${USER_PASSWORD_RESET_PERMISSION}', ${USER_ADMIN_CATALOG[0].compat.maxRoleLevel}, '{}', '{}', false,`)
  })

  it('starts in SHADOW and never enforces a mode', () => {
    expect(migration).toContain(`('${USER_PASSWORD_RESET_PERMISSION}', 'SHADOW', null,`)
    expect(migration).not.toMatch(/update\s+public\.sa_migration_modes\s+set\s+mode/i)
    expect(migration).not.toMatch(/^\s*[^-\s].*'(NEW_ENFORCED|LEGACY_RETIRED)'/m)
  })

  it('registers readiness exactly for the wired route and mirrors the TypeScript list', () => {
    expect(migration).toContain(`('${USER_PASSWORD_RESET_PERMISSION}', true, 'decision_backstop'`)
    expect([...USER_ADMIN_ENFORCEMENT_READY]).toEqual([USER_PASSWORD_RESET_PERMISSION])
    expect(ALL_ENFORCEMENT_READY_PERMISSIONS).toContain(USER_PASSWORD_RESET_PERMISSION)
    // The route really decides through this permission (readiness is only true because of that).
    expect(route).toContain('USER_PASSWORD_RESET_PERMISSION')
    expect((ROUTE_COVERAGE as any)['users/reset-password'].permissions).toEqual([USER_PASSWORD_RESET_PERMISSION])
  })

  it('is a new key: not the profile permission, not a duplicate', () => {
    expect(FINAL_WAVE_PERMISSION_KEYS).not.toContain(USER_PASSWORD_RESET_PERMISSION)
    expect(IDENTITY_PERMISSION_KEYS).not.toContain(USER_PASSWORD_RESET_PERMISSION)
    expect(USER_PASSWORD_RESET_PERMISSION).not.toBe('platform.user.manage')
  })

  it('is narrower than profile administration in compatibility: profile editors do not get reset', () => {
    const entry = USER_ADMIN_CATALOG[0]
    const role = (level: number) => ({ roleCode: `L${level}`, roleLevel: level, permissions: ['edit_users', 'create_users'] })
    expect(compatGrants(entry, role(10))).toBe(true)
    expect(compatGrants(entry, role(1))).toBe(true)
    for (const level of [20, 30, 40]) expect(compatGrants(entry, role(level)), `level ${level}`).toBe(false)
  })

  it('is listed under Platform & Settings → User Administration as "Reset User Password"', () => {
    expect(classifyPermission(USER_PASSWORD_RESET_PERMISSION)).toEqual({ groupId: 'platform_settings', areaId: 'user_admin', areaName: 'User Administration' })
    expect(permissionLabel(USER_PASSWORD_RESET_PERMISSION).label).toBe('Reset User Password')
  })

  it('mirrors the database sensitivity and partner rules', () => {
    expect(isSensitivePermission(USER_PASSWORD_RESET_PERMISSION)).toBe(true)
    expect(isForbiddenForPartner(USER_PASSWORD_RESET_PERMISSION)).toBe(true)
    expect(migration).toContain("'platform.user.password_reset')")
    expect(migration).toMatch(/p_key in \('hr\.data\.reset','platform\.data\.destructive','finance\.data\.reset','platform\.user\.password_reset'\)/)
  })

  it('seeds one narrow standard policy, assigns it to nobody, and extends only Platform & Settings Full Access', () => {
    expect(migration).toContain(`v_key constant text := '${USER_PASSWORD_RESET_ROLE}'`)
    expect(migration).toContain(`'${USER_PASSWORD_RESET_ROLE_NAME}'`)
    expect(migration).toContain("array['platform.user.password_reset']")
    expect(migration).not.toMatch(/sa_assign_role|sa_create_assignment_internal|insert\s+into\s+public\.sa_role_assignments/i)
    const extended = [...migration.matchAll(/sa_extend_standard_policy\('([a-z-]+)'/g)].map(m => m[1])
    expect(extended).toEqual(['platform-settings-full-access'])
  })

  it('changes no existing migration file', () => {
    expect(migration).not.toMatch(/alter\s+table\s+public\.sa_(permissions|business_roles)\s+drop/i)
  })
})
