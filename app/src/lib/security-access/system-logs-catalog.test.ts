import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FINAL_WAVE_PERMISSION_KEYS, compatGrants } from './catalog'
import { IDENTITY_PERMISSION_KEYS } from './identity-catalog'
import { ALL_ENFORCEMENT_READY_PERMISSIONS } from './readiness'
import { ROUTE_COVERAGE } from './route-coverage'
import { classifyPermission } from './modules'
import { permissionLabel } from './labels'
import { isSensitivePermission } from './profiles'
import { coverageReport, seededProfilePermissions } from './coverage-audit'
import { SYSTEM_LOGS_CATALOG, SYSTEM_LOGS_ENFORCEMENT_READY, SYSTEM_LOGS_PERMISSION, SYSTEM_LOGS_ROLE, SYSTEM_LOGS_ROLE_NAME } from './system-logs-catalog'

const migration = readFileSync(new URL('../../../../supabase/migrations/20261017110000_sa_system_logs_view_permission.sql', import.meta.url), 'utf8')
const foundation = readFileSync(new URL('../../../../supabase/migrations/20261017100000_system_logs_foundation.sql', import.meta.url), 'utf8')
const access = readFileSync(new URL('../system-logs/access.ts', import.meta.url), 'utf8')

describe('System Logs permission ↔ migration lock-step', () => {
  it('seeds the same key, sensitivity and compatibility rule (central Super Admin only)', () => {
    expect(SYSTEM_LOGS_PERMISSION).toBe('platform.system_logs.view')
    expect(migration).toContain(`('${SYSTEM_LOGS_PERMISSION}','platform','system_logs','view'`)
    expect(migration).toMatch(/'new','security_sensitive'\)/)
    expect(SYSTEM_LOGS_CATALOG[0].sensitivity).toBe('security_sensitive')
    expect(migration).toContain(`('${SYSTEM_LOGS_PERMISSION}', ${SYSTEM_LOGS_CATALOG[0].compat.maxRoleLevel}, '{}', '{}', false,`)
  })

  it('starts in SHADOW and never enforces a mode', () => {
    expect(migration).toContain(`('${SYSTEM_LOGS_PERMISSION}', 'SHADOW', null,`)
    expect(migration).not.toMatch(/update\s+public\.sa_migration_modes\s+set\s+mode/i)
    expect(migration).not.toMatch(/^\s*[^-\s].*'(NEW_ENFORCED|LEGACY_RETIRED)'/m)
  })

  it('registers readiness for the wired routes and mirrors the TypeScript list', () => {
    expect(migration).toContain(`('${SYSTEM_LOGS_PERMISSION}', true, 'read_only'`)
    expect([...SYSTEM_LOGS_ENFORCEMENT_READY]).toEqual([SYSTEM_LOGS_PERMISSION])
    expect(ALL_ENFORCEMENT_READY_PERMISSIONS).toContain(SYSTEM_LOGS_PERMISSION)
    for (const route of ['system-logs', 'system-logs/[id]', 'system-logs/access']) {
      expect((ROUTE_COVERAGE as any)[route]).toMatchObject({ kind: 'ENTERPRISE', permissions: [SYSTEM_LOGS_PERMISSION] })
    }
    expect((ROUTE_COVERAGE as any)['system-logs/report'].kind).toBe('SELF')
    expect((ROUTE_COVERAGE as any)['cron/system-log-retention'].kind).toBe('SERVICE')
    // The legacy evaluator in the access helper is the same audience as the compatibility rule.
    expect(access).toContain('profile.role_level === 1')
  })

  it('is a new key: not Settings, User Management or S&A audit', () => {
    expect(FINAL_WAVE_PERMISSION_KEYS).not.toContain(SYSTEM_LOGS_PERMISSION)
    expect(IDENTITY_PERMISSION_KEYS).not.toContain(SYSTEM_LOGS_PERMISSION)
    for (const other of ['platform.settings.manage', 'platform.user.manage', 'security.audit.view']) expect(SYSTEM_LOGS_PERMISSION).not.toBe(other)
  })

  it('compatibility: Settings (≤ 40) and User Management (≤ 30) administrators do not get it; only level 1 does', () => {
    const entry = SYSTEM_LOGS_CATALOG[0]
    const role = (level: number) => ({ roleCode: `L${level}`, roleLevel: level, permissions: ['view_settings', 'edit_users', 'manage_authorization'] })
    expect(compatGrants(entry, role(1))).toBe(true)
    for (const level of [10, 20, 30, 40]) expect(compatGrants(entry, role(level)), `level ${level}`).toBe(false)
  })

  it('is listed under Platform & Settings → System as "View System Logs", not grant-sensitive', () => {
    expect(classifyPermission(SYSTEM_LOGS_PERMISSION)).toEqual({ groupId: 'platform_settings', areaId: 'system', areaName: 'System' })
    expect(permissionLabel(SYSTEM_LOGS_PERMISSION).label).toBe('View System Logs')
    expect(isSensitivePermission(SYSTEM_LOGS_PERMISSION)).toBe(false)
    expect(migration).not.toMatch(/create or replace function public\.sa_permission_is_sensitive/)
  })

  it('seeds one narrow policy, assigns it to nobody and extends no other policy', () => {
    expect(migration).toContain(`v_key constant text := '${SYSTEM_LOGS_ROLE}'`)
    expect(migration).toContain(`'${SYSTEM_LOGS_ROLE_NAME}'`)
    expect(migration).toContain("array['platform.system_logs.view']")
    expect(migration).not.toMatch(/sa_assign_role|sa_create_assignment_internal|insert\s+into\s+public\.sa_role_assignments/i)
    expect(migration).not.toMatch(/perform\s+public\.sa_extend_standard_policy/i)
    const seeded = seededProfilePermissions()
    expect([...(seeded.get(SYSTEM_LOGS_ROLE) ?? [])]).toEqual([SYSTEM_LOGS_PERMISSION])
    expect(seeded.get('platform-settings-full-access')?.has(SYSTEM_LOGS_PERMISSION) ?? false).toBe(false)
    const report = coverageReport()
    expect(report.universe).toContain(SYSTEM_LOGS_PERMISSION)
    expect(report.withoutProfile).not.toContain(SYSTEM_LOGS_PERMISSION)
    expect(report.orphanReady).not.toContain(SYSTEM_LOGS_PERMISSION)
  })

  it('orders after the foundation migration and edits no applied migration', () => {
    expect('20261017110000' > '20261017100000').toBe(true)
    expect(migration).toContain('20261017100000_system_logs_foundation.sql')
    expect(foundation).not.toMatch(/sa_permissions|sa_business_roles/)
  })
})
