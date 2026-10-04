import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROUTE_COVERAGE } from './route-coverage'
import { FINAL_WAVE_PERMISSION_KEYS } from './catalog'
import { IDENTITY_PERMISSION_KEYS } from './identity-catalog'
import { STAGE2D_PERMISSION_KEYS } from './stage2d-catalog'
import { HR_DATA_PERMISSION_KEYS } from './hr-data-catalog'

const src = resolve(process.cwd(), 'src')
const apiRoot = resolve(src, 'app/api')
const routes = (readdirSync(apiRoot, { recursive: true }) as string[])
  .filter(file => file.endsWith('/route.ts') || file === 'route.ts')
  .map(file => file.replace(/\/?route\.ts$/, ''))
  .sort()

const WAVE1_KEYS = [
  'inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.post',
  'inventory.transfer.view', 'inventory.transfer.request', 'inventory.transfer.approve', 'inventory.transfer.dispatch',
  'inventory.transfer.receive', 'security.access.view', 'security.role.assign', 'security.permission.manage',
]
const KNOWN = new Set([...FINAL_WAVE_PERMISSION_KEYS, ...WAVE1_KEYS, ...IDENTITY_PERMISSION_KEYS, ...STAGE2D_PERMISSION_KEYS, ...HR_DATA_PERMISSION_KEYS])

describe('authorization coverage gate', () => {
  it('classifies every API route (no UNKNOWN, no stale entries)', () => {
    expect(routes.filter(r => !(r in ROUTE_COVERAGE))).toEqual([])
    expect(Object.keys(ROUTE_COVERAGE).filter(r => !routes.includes(r))).toEqual([])
    expect(Object.entries(ROUTE_COVERAGE).filter(([, c]) => (c.kind as string) === 'UNKNOWN').map(([r]) => r)).toEqual([])
  })

  it('every ENTERPRISE route references its permission in the route or a declared helper', () => {
    const problems: string[] = []
    for (const [route, coverage] of Object.entries(ROUTE_COVERAGE)) {
      if (coverage.kind !== 'ENTERPRISE') continue
      const sources = [readFileSync(resolve(apiRoot, route, 'route.ts'), 'utf8'),
        ...(coverage.via || []).map(helper => readFileSync(resolve(src, helper), 'utf8'))]
      for (const permission of coverage.permissions) {
        if (!KNOWN.has(permission)) problems.push(`${route}: unknown permission ${permission}`)
        const literal = sources.some(s => s.includes(`'${permission}'`) || s.includes(`"${permission}"`))
        const templated = permission.startsWith('inventory.transfer.') && sources.some(s => s.includes('inventory.transfer.${'))
        if (!literal && !templated) problems.push(`${route}: ${permission} not referenced`)
      }
      if (!coverage.permissions.length) problems.push(`${route}: no permission`)
    }
    expect(problems).toEqual([])
  })

  it('non-enterprise classifications carry a documented reason', () => {
    for (const [route, coverage] of Object.entries(ROUTE_COVERAGE)) {
      if (coverage.kind === 'ENTERPRISE') continue
      expect(coverage.reason.length, route).toBeGreaterThan(10)
    }
  })

  it('keeps documented compatibility exceptions to the reviewed minimum', () => {
    const exceptions = Object.entries(ROUTE_COVERAGE).filter(([, c]) => c.kind === 'EXCEPTION').map(([r]) => r).sort()
    // Outdoor store staff routes decide through S&A (ecommerce.outdoor.operate,
    // Stage 2D); only the public Outdoor contact form keeps a documented
    // exception (its staff inbox uses the same S&A decision).
    expect(exceptions).toEqual([
      'orders/[orderId]/access', 'orders/actors', 'outdoor/contact',
    ].sort())
  })

  it('never classifies an admin or settings route as public or consumer', () => {
    const risky = Object.entries(ROUTE_COVERAGE).filter(([route, c]) =>
      /^(admin|settings|accounting|finance|hr|security-access|organizations|users)\//.test(`${route}/`)
      && (c.kind === 'PUBLIC' || c.kind === 'CONSUMER')
      && route !== 'admin/destructive-ops-status')
    expect(risky.map(([r]) => r)).toEqual([])
  })
})
