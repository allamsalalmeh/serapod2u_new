import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * B3 (HR-owned part, Wave 2): no HR API route may pass an "allow everyone" legacy evaluator (`() => true`) to the
 * canonical S&A check. In SHADOW / LEGACY_ENFORCED modes the legacy evaluator DECIDES, so `() => true` opened those
 * routes to every signed-in user wherever a key was not yet enforced (production modes last recorded SHADOW). The
 * default evaluator (canManageHr: HR administrator roles / legacy HR permissions) is used instead; in NEW_ENFORCED /
 * LEGACY_RETIRED modes S&A alone decides, unchanged.
 */
const apiHr = path.resolve(__dirname, '../../app/api/hr')
const routeFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? routeFiles(path.join(dir, e.name)) : e.name === 'route.ts' ? [path.join(dir, e.name)] : [])

describe('HR routes never use an allow-everyone legacy evaluator (B3)', () => {
  const files = routeFiles(apiHr)
  it('scans the HR API routes', () => {
    expect(files.length).toBeGreaterThan(50)
  })
  it('no hrCan / hrCanIn call passes () => true', () => {
    const offenders = files.filter((f) => /hrCan(?:In)?\([\s\S]{0,400}?\(\)\s*=>\s*true\s*\)/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(apiHr, f))
    expect(offenders).toEqual([])
  })
  it('detects an injected allow-everyone evaluator (negative control)', () => {
    const src = "if (!(await hrCan(ctx, 'hr.benefits.manage', () => true))) {"
    expect(/hrCan(?:In)?\([\s\S]{0,400}?\(\)\s*=>\s*true\s*\)/.test(src)).toBe(true)
  })
})
