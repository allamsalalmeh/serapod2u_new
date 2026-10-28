import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Migration-version collision regression check (B2B, P-R01). Supabase identifies a migration by the prefix before the
 * first underscore; two files with the same prefix collide in ordering/history. Historical duplicates are recorded
 * below with their file counts (2026-10-24, incl. the four origin/main migrations merged at b6b78002) and must not
 * grow; any NEW duplicate fails. Never fix a collision by renaming an APPLIED file (D-017).
 *
 * Wave 2 decision (E-13, 2026-10-25): the KVM2 staging diagnostic of 2026-10-25 shows the effects of
 * 20261214100000_hr_employee_controlled_delete, both 20261216100000 files and 20261022100000_core_system_preferences
 * PRESENT on staging (hand-applied; staging has no supabase_migrations ledger), and the colliding origin/main files are
 * recorded applied in PMS. Every HR-owned colliding file has therefore been applied somewhere and is NOT renamed.
 * 20261215100000_sa_payment_gateway_restriction is S&A-owned (handover). The collisions stay pinned here instead.
 * The Wave 2 HR migration was re-stamped 20261220100000 → 20261221100000 before any application because the inventory
 * workstream created 20261220100000_inventory_cases_and_pcs.sql concurrently (2026-10-25); never-applied files are the
 * only ones that may be re-stamped.
 */
const KNOWN_DUPLICATES: Record<string, number> = {
  '20260403': 2, '20260407': 2, '20260408': 4, '20260409': 2, '20260410': 2, '20260411': 5, '20260412': 4, '20260413': 2,
  '20260414': 2, '20260415': 2, '20260416': 2, '20260510': 2, '20260621': 2, '20260622': 2, '20260623': 14, '20260707': 2,
  '20260708': 2, '20260712': 4, '20260713': 2, '20260715': 3, '20260716': 5, '20260717': 9, '20260718': 5, '20260719': 7,
  '20260720': 4, '20260723': 2, '20260730': 3, '20260731': 3, '20260904': 2, '20260904120000': 2, '20260917120000': 2,
  '20260928100000': 2, '20261003100000': 2, '20261007': 3, '20261007100000': 2, '20261022100000': 2, '20261212100000': 2,
  '20261213100000': 2, '20261214100000': 2, '20261215100000': 2, '20261216100000': 2,
}

const repoRoot = path.resolve(__dirname, '../../../..')
const migrationsDir = path.join(repoRoot, 'supabase/migrations')

export function versionCounts(files: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const f of files) {
    if (!f.endsWith('.sql') || !/^\d/.test(f)) continue
    const version = f.split('_')[0]
    counts.set(version, (counts.get(version) ?? 0) + 1)
  }
  return counts
}

export function newCollisions(counts: Map<string, number>, known: Record<string, number>): string[] {
  return [...counts].filter(([v, n]) => n > 1 && n > (known[v] ?? 1)).map(([v, n]) => `${v} ×${n}`)
}

describe('migration versions', () => {
  const files = fs.readdirSync(migrationsDir)

  it('introduces no new duplicate migration version', () => {
    expect(newCollisions(versionCounts(files), KNOWN_DUPLICATES)).toEqual([])
  })

  it('detects an injected collision (negative control)', () => {
    const injected = [...files, '20261219100000_injected_duplicate.sql']
    expect(newCollisions(versionCounts(injected), KNOWN_DUPLICATES)).toEqual(['20261219100000 ×2'])
    const grown = [...files, '20261214100000_third_file.sql']
    expect(newCollisions(versionCounts(grown), KNOWN_DUPLICATES)).toEqual(['20261214100000 ×3'])
  })

  it('Wave 2 employment foundation has a unique version after B2A', () => {
    const w2 = files.filter((f) => f.startsWith('20261221100000_'))
    expect(w2).toEqual(['20261221100000_hr_employment_foundation.sql'])
    const hr = files.filter((f) => /^\d{14}_hr_/.test(f)).sort()
    expect(hr.indexOf('20261221100000_hr_employment_foundation.sql')).toBeGreaterThan(hr.indexOf('20261219100000_hr_leave_containment_guard.sql'))
  })

  it('Wave 3 migrations have unique versions after Wave 2, attendance before leave ledger', () => {
    expect(files.filter((f) => f.startsWith('20261222100000_'))).toEqual(['20261222100000_hr_hybrid_attendance_overtime.sql'])
    expect(files.filter((f) => f.startsWith('20261223100000_'))).toEqual(['20261223100000_hr_leave_ledger.sql'])
    const hr = files.filter((f) => /^\d{14}_hr_/.test(f)).sort()
    expect(hr.slice(-4)).toEqual(['20261221100000_hr_employment_foundation.sql', '20261222100000_hr_hybrid_attendance_overtime.sql', '20261223100000_hr_leave_ledger.sql',
      '20261224100000_hr_w3_wp_holiday_alias.sql'])
  })

  it('B2A leave containment has a unique version after every lifecycle migration', () => {
    const b2a = files.filter((f) => f.startsWith('20261219100000_'))
    expect(b2a).toEqual(['20261219100000_hr_leave_containment_guard.sql'])
    const versions = files.filter((f) => /^\d{14}_/.test(f)).map((f) => f.slice(0, 14)).sort()
    expect(versions[versions.length - 1] >= '20261219100000').toBe(true)
  })
})
