import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STOCK_COUNT_ENFORCEMENT_READY, isEnforcementReady } from './readiness'
import { REASON_REQUIRED_TARGETS, checkModeNote, reasonRequiredFor } from './mode-change-rules'
import { MODE_LABELS } from './labels'

const migrations = resolve(process.cwd(), '..', 'supabase', 'migrations')
const stockCount = readFileSync(resolve(migrations, '20261019100000_sa_stock_count_create_post_enforcement.sql'), 'utf8')
const modeNote = readFileSync(resolve(migrations, '20261019110000_sa_mode_change_note_and_keep_retired.sql'), 'utf8')

describe('Stock Count create/post readiness ↔ migration lock-step', () => {
  it('registers exactly the keys the application treats as ready', () => {
    const seg = stockCount.slice(stockCount.indexOf('insert into public.sa_enforcement_readiness'), stockCount.indexOf('on conflict (permission_key) do nothing'))
    const keys = [...seg.matchAll(/^ \('([a-z_.]+)'/gm)].map(m => m[1]).sort()
    expect(keys).toEqual([...STOCK_COUNT_ENFORCEMENT_READY].sort())
    for (const key of keys) expect(isEnforcementReady(key)).toBe(true)
  })
  it('the database backstops are no-ops until the key is enforced (applying changes nothing while SHADOW)', () => {
    expect(stockCount).toContain("if not public.sa_cached_mode_is_new('inventory.stock_count.create') then return; end if;")
    expect(stockCount).toContain("if not public.sa_is_new_authoritative('inventory.stock_count.post') then")
    expect(stockCount).toContain("IF public.sa_is_new_authoritative('inventory.stock_count.post') THEN")
    // No mode is changed by the migration.
    expect(stockCount).not.toMatch(/update\s+public\.sa_migration_modes/i)
    expect(modeNote).not.toMatch(/update\s+public\.sa_migration_modes\s+set\s+mode\s*=\s*'/i)
  })
})

describe('mode-change reason rule ↔ database', () => {
  it('the database requires a reason for exactly the same targets', () => {
    const fn = modeNote.slice(modeNote.indexOf('create or replace function public.sa_mode_reason_required'), modeNote.indexOf('revoke all on function public.sa_mode_reason_required'))
    const targets = fn.match(/p_to in \(([^)]*)\)/)![1].split(',').map(s => s.trim().replace(/'/g, ''))
    expect(targets.sort()).toEqual([...REASON_REQUIRED_TARGETS].sort())
  })
  it('generated descriptions use the screen labels', () => {
    for (const [mode, { label }] of Object.entries(MODE_LABELS)) expect(modeNote).toContain(`when '${mode}' then '${label}'`)
  })
  it('optional note for forward moves, required reason for actual moves back', () => {
    expect(reasonRequiredFor('NEW_ENFORCED', 'SHADOW')).toBe(true)
    expect(reasonRequiredFor('SHADOW', 'LEGACY_ENFORCED')).toBe(true)
    expect(reasonRequiredFor('SHADOW', 'SHADOW')).toBe(false)
    expect(reasonRequiredFor('SHADOW', 'NEW_ENFORCED')).toBe(false)
    expect(reasonRequiredFor('NEW_ENFORCED', 'LEGACY_RETIRED')).toBe(false)
    expect(checkModeNote(false, '   ')).toEqual({ ok: true, note: null })
    expect(checkModeNote(false, ' ok ')).toEqual({ ok: true, note: 'ok' })
    expect(checkModeNote(true, 'too short')).toMatchObject({ ok: false, code: 'reason_required' })
    expect(checkModeNote(true, ' long enough reason ')).toEqual({ ok: true, note: 'long enough reason' })
    expect(checkModeNote(false, 'x'.repeat(501))).toMatchObject({ ok: false, code: 'note_too_long' })
  })
})
