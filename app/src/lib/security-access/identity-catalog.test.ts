import { STAGE2D_PERMISSION_KEYS } from './stage2d-catalog'
import { HR_DATA_PERMISSION_KEYS } from './hr-data-catalog'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FINAL_WAVE_PERMISSION_KEYS, compatGrants } from './catalog'
import { IDENTITY_CATALOG, IDENTITY_ENFORCEMENT_READY, IDENTITY_PERMISSION_KEYS } from './identity-catalog'
import { ALL_ENFORCEMENT_READY_PERMISSIONS, ENFORCEMENT_READY_PERMISSIONS } from './readiness'
import { permissionLabel } from './labels'

const migrations = resolve(process.cwd(), '..', 'supabase', 'migrations')
const read = (f: string) => readFileSync(resolve(migrations, f), 'utf8')
const foundation = read('20260929110000_identity_foundation.sql')
const decisions = read('20260929100000_sa_decisions_history_survives_user_deletion.sql')
const guard = read('20260929120000_identity_protected_fields_guard.sql')
const closure = read('20260929140000_identity_stage1_closure.sql')

describe('Identity catalog ↔ migration lock-step', () => {
  it('seeds exactly the TypeScript identity permissions with the same sensitivity', () => {
    const seg = foundation.slice(foundation.indexOf('insert into public.sa_permissions'), foundation.indexOf('on conflict (permission_key) do nothing;', foundation.indexOf('insert into public.sa_permissions')))
    const rows = [...seg.matchAll(/^ \('([a-z_.]+)','[a-z_]+','[a-z_]+','[a-z_]+','(?:[^']|'')*','new','([a-z_]+)'\)/gm)]
    expect(rows.map(r => r[1]).sort()).toEqual([...IDENTITY_PERMISSION_KEYS].sort())
    for (const entry of IDENTITY_CATALOG) expect(rows.find(r => r[1] === entry.key)?.[2], entry.key).toBe(entry.sensitivity)
  })

  it('seeds the same compatibility rules', () => {
    const seg = foundation.slice(foundation.indexOf('insert into public.sa_legacy_compat_rules'), foundation.indexOf('insert into public.sa_migration_modes'))
    for (const entry of IDENTITY_CATALOG) {
      const row = seg.match(new RegExp(`\\('${entry.key.replace(/\./g, '\\.')}', (\\d+), '\\{\\}', (array\\[[^\\]]*\\]|'\\{\\}')`))
      expect(row, entry.key).not.toBeNull()
      expect(Number(row![1]), entry.key).toBe(entry.compat.maxRoleLevel)
      const perms = row![2].startsWith('array') ? [...row![2].matchAll(/'([a-z_]+)'/g)].map(m => m[1]) : []
      expect(perms, entry.key).toEqual(entry.compat.legacyPermissions ?? [])
    }
  })

  it('registers exactly the identity operations that are wired end to end', () => {
    const seg = foundation.slice(foundation.indexOf('insert into public.sa_enforcement_readiness'), foundation.indexOf('insert into public.sa_business_roles'))
    const keys = [...seg.matchAll(/^ \('([a-z_.]+)'/gm)].map(m => m[1]).sort()
    expect(keys).toEqual([...IDENTITY_ENFORCEMENT_READY].sort())
    expect(ALL_ENFORCEMENT_READY_PERMISSIONS).toEqual([...ENFORCEMENT_READY_PERMISSIONS, ...IDENTITY_ENFORCEMENT_READY, ...STAGE2D_PERMISSION_KEYS, ...HR_DATA_PERMISSION_KEYS])
  })

  it('does not duplicate an existing Final Wave key (platform.user.manage stays identity-manage)', () => {
    for (const key of IDENTITY_PERMISSION_KEYS) expect(FINAL_WAVE_PERMISSION_KEYS).not.toContain(key)
    expect(FINAL_WAVE_PERMISSION_KEYS).toContain('platform.user.manage')
  })

  it('seeds identity modes SHADOW and never enforces a mode in a migration', () => {
    expect(foundation).toMatch(/select k, 'SHADOW', null/)
    for (const sql of [foundation, decisions, guard]) {
      expect(sql).not.toMatch(/update\s+public\.sa_migration_modes\s+set\s+mode/i)
      expect(sql).not.toMatch(/'(NEW_ENFORCED|LEGACY_RETIRED)'\s*,\s*null/)
    }
  })

  it('keeps access administration HQ-admin-only in compatibility and never implied by employee management', () => {
    const access = IDENTITY_CATALOG.find(e => e.key === 'platform.identity_access.manage')!
    expect(compatGrants(access, { roleCode: 'HQ', roleLevel: 10, permissions: [] })).toBe(true)
    expect(compatGrants(access, { roleCode: 'POWER_USER', roleLevel: 20, permissions: ['edit_users', 'create_users'] })).toBe(false)
    expect(compatGrants(access, { roleCode: 'HR_MANAGER', roleLevel: 30, permissions: ['manage_org_chart'] })).toBe(false)
    const archive = IDENTITY_CATALOG.find(e => e.key === 'platform.identity.delete')!
    expect(compatGrants(archive, { roleCode: 'HQ', roleLevel: 10, permissions: [] })).toBe(false)
    // The HR Manager template role does not receive identity access administration.
    const templates = foundation.slice(foundation.indexOf('insert into public.sa_business_role_permissions'))
    expect(templates).toMatch(/\('identity-administrator', array\['platform\.user\.manage','platform\.identity\.view','platform\.identity\.disable'\]\)/)
    expect(templates).not.toMatch(/'hr-manager'/)
  })

  it('labels every identity permission for the Security & Access UI', () => {
    for (const key of IDENTITY_PERMISSION_KEYS) expect(permissionLabel(key).group, key).toBe('Identity')
    expect(permissionLabel('platform.identity_access.manage').label).toBe('Manage Identity Access (role / organization)')
  })
})

describe('Identity Foundation migration contracts', () => {
  it('removes append-only history FKs to users generically, keeping the append-only triggers', () => {
    expect(decisions).toMatch(/p\.proname like 'sa\\_reject\\_%'/)
    expect(decisions).toMatch(/alter table %s drop constraint %I/)
    expect(decisions).toMatch(/sa_authorization_decisions_append_only/)
    expect(decisions).not.toMatch(/drop trigger/i)
  })

  it('protects every identity and enterprise-access column from API roles', () => {
    for (const col of ['id', 'email', 'phone', 'email_verified_at', 'phone_verified_at', 'is_verified', 'auth_provider',
      'role_code', 'organization_id', 'account_scope', 'principal_type', 'account_status', 'is_active']) {
      expect(guard, col).toMatch(new RegExp(`new\\.${col} is distinct from old\\.${col}`))
    }
    expect(guard).toMatch(/current_user not in \('anon', 'authenticated'\)/)
    expect(guard).toMatch(/identity_create_requires_provisioning/)
    expect(guard).toMatch(/identity_delete_requires_lifecycle/)
  })

  it('treats Supply Chain, document, finance and audit references as history (never on the owned allowlist)', () => {
    const owned = guard.slice(guard.indexOf('v_owned constant text[]'), guard.indexOf('begin', guard.indexOf('v_owned constant text[]')))
    for (const history of ['stock_movements', 'stock_transfers', 'orders', 'documents', 'document_files', 'document_signatures',
      'gl_journals', 'audit_logs', 'hr_payroll_runs', 'qr_movements']) {
      expect(owned, history).not.toContain(`'${history}.`)
    }
    expect(guard).toMatch(/sa_authorization_decisions where actor_id = p_user/)
  })

  it('keeps identity functions away from API roles', () => {
    for (const fn of ['identity_resolve(text,text)', 'identity_provision(uuid,uuid,jsonb)', 'identity_record_conflict(text,jsonb,text,text,text,uuid,jsonb)',
      'identity_set_account_status(uuid,uuid,text,text)', 'identity_admin_update_access(uuid,uuid,text,uuid,boolean,text)']) {
      expect(foundation, fn).toContain(`revoke all on function public.${fn} from public, anon, authenticated;`)
      expect(foundation, fn).toContain(`grant execute on function public.${fn} to service_role;`)
    }
  })

  it('never makes email or phone a key and never merges identities', () => {
    expect(foundation).not.toMatch(/primary key \((email|phone)/i)
    expect(foundation).not.toMatch(/unique\s*\(\s*(email|phone|email_normalized)/i)
    expect(foundation).toMatch(/IDENTITY_CONFLICT/)
    expect(foundation).toMatch(/no silent merge/i)
  })
})

describe('Identity Stage 1 closure migration contracts', () => {
  it('defines staff canonically: internal employee + S&A membership + non-baseline assignment; level only a ceiling', () => {
    const fn = closure.slice(closure.indexOf('create or replace function public.sa_actor_is_staff'), closure.indexOf('create or replace function public.sa_actor_is_supply_partner'))
    expect(fn).toContain("u.principal_type = 'INTERNAL_EMPLOYEE'")
    expect(fn).toContain("u.account_status in ('ACTIVE', 'INVITED')")
    expect(fn).toContain('public.sa_organization_memberships m')
    expect(fn).toContain("br.role_key <> 'employee-self-service'")
    expect(fn).toMatch(/r\.role_level <= p_max_role_level\s+-- compatibility ceiling only/)
  })

  it('gives supply partners only the six operational read policies', () => {
    const block = closure.slice(closure.indexOf('do $partner$'), closure.indexOf('$partner$;'))
    for (const [t, p] of [['qr_codes', 'sa_staff_read'], ['qr_batches', 'sa_staff_read'], ['qr_master_codes', 'sa_staff_read'],
      ['qr_movements', 'sa_scoped_staff_read'], ['stock_movements', 'stock_movements_view_all'], ['stock_transfers', 'stock_transfers_view_all']]) {
      expect(block).toContain(`('${t}', '${p}')`)
    }
    expect(closure).toMatch(/supply-partner access must be read-only/)
  })

  it('onboards HR/department employees with the no-authority legacy code, never USER or "staff"', () => {
    expect(closure).toContain("v_baseline := case when v_perm = 'hr.employee.manage' and v_principal <> 'CONSUMER' then 'GUEST'")
    expect(closure).not.toMatch(/'staff'/)
  })

  it('adds exactly the application audit actions and keeps the list closed', () => {
    expect(closure).toContain("array['INSERT'::text, 'UPDATE'::text, 'DELETE'::text,\n                      'PASSWORD_RESET'::text, 'BULK_ENABLE_STOCK_CONFIGURATIONS'::text]")
  })

  it('changes no migration mode', () => {
    expect(closure).not.toMatch(/update\s+public\.sa_migration_modes/i)
  })
})
