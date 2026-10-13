import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Static contract of the UNAPPLIED migration (no database is touched).
const dir = path.resolve(__dirname, '../../../../supabase/migrations')
const read = (name: string) => readFileSync(path.join(dir, name), 'utf8')

describe('20261014100000_sa_ess_baseline_hq_only.sql', () => {
  const sql = read('20261014100000_sa_ess_baseline_hq_only.sql')
  const previous = read('20260929190000_identity_stage2_suspension_preserves_access.sql')

  it('derives a NEW ESS baseline only for HQ and keeps maintaining an existing row (no backfill, no revoke)', () => {
    expect(sql).toMatch(/v_baseline_role is not null and \(\s*v_org_type = 'HQ'\s*or exists/)
    expect(sql).not.toMatch(/\bdelete\s+from\b/i)
    expect(sql).not.toMatch(/update public\.users\b/i)
  })

  it('differs from the live definition only in the baseline block', () => {
    const fn = (t: string) => t.slice(t.indexOf('create or replace function public.sa_sync_user_lifecycle'), t.indexOf('revoke all on function public.sa_sync_user_lifecycle'))
    const strip = (t: string) => t.replace(/  -- ESS is HQ-only[\s\S]*?end if;\n/, '').replace(/  if v_baseline_role is not null then[\s\S]*?end if;\n/, '')
    expect(strip(fn(sql))).toBe(strip(fn(previous)))
  })

  it('stays service-role only', () => {
    expect(sql).toMatch(/revoke all on function public\.sa_sync_user_lifecycle\(uuid,text\) from public, anon, authenticated/)
    expect(sql).toMatch(/grant execute on function public\.sa_sync_user_lifecycle\(uuid,text\) to service_role/)
  })
})
