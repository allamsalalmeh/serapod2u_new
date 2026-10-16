import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(resolve(process.cwd(), '../supabase/migrations/20260927140000_sa_wave1_foundation.sql'), 'utf8')

describe('S&A Wave 1 migration security contract', () => {
  it('is additive and does not remove legacy identity fields', () => {
    expect(sql).not.toMatch(/drop\s+(column|table)\s+(public\.)?(users|roles)/i)
    expect(sql).not.toMatch(/drop\s+column\s+(organization_id|role_code|role_level)/i)
  })
  it('forces RLS and denies direct anon/authenticated access for every S&A table', () => {
    expect(sql).toContain('enable row level security')
    expect(sql).toContain('force row level security')
    expect(sql).toContain('revoke all on table public.%I from anon, authenticated')
  })
  it('backfills compatibility rows only for active portal identities, never consumers', () => {
    expect(sql).toContain("u.account_scope='portal'")
    expect(sql).toContain('u.is_active=true')
    expect(sql).not.toMatch(/account_scope\s*=\s*['"]store['"][\s\S]*insert/i)
    expect(sql).toContain("'legacy_portal'")
  })
  it('keeps all Supply Chain pilot operations in shadow', () => {
    expect(sql).toContain("case when permission_key like 'inventory.%' then 'SHADOW'")
    expect(sql).not.toMatch(/inventory\.[^']+'\s*,\s*'NEW_ENFORCED'/)
  })
  it('constrains migration modes and append audit decisions', () => {
    expect(sql).toContain("'LEGACY_ENFORCED','SHADOW','NEW_ENFORCED','LEGACY_RETIRED'")
    expect(sql).toContain('sa_authorization_decisions')
  })
})
