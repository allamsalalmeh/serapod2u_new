import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isActiveAccountRecord } from './active-account'

const root = process.cwd()
const apiRoot = resolve(root, 'src/app/api/security-access')
const routes = (readdirSync(apiRoot, { recursive: true }) as string[])
  .filter(file => file.endsWith('route.ts'))
  .map(file => resolve(apiRoot, file))

describe('Security & Access active-account gate', () => {
  it('allows only an explicit active record and fails closed', () => {
    expect(isActiveAccountRecord({ is_active: true })).toBe(true)
    expect(isActiveAccountRecord({ is_active: false })).toBe(false)
    expect(isActiveAccountRecord(null)).toBe(false)
    expect(isActiveAccountRecord({ is_active: true }, new Error('lookup failed'))).toBe(false)
  })

  it('the shared administration helper applies the gate before any decision', () => {
    const helper = readFileSync(resolve(root, 'src/lib/security-access/admin-api.ts'), 'utf8')
    // One read supplies the active flag and the trusted organization; a read failure is 503, never an allow.
    expect(helper).toContain("select('is_active, organization_id')")
    expect(helper).toMatch(/if \(error\) \{[\s\S]*?unavailableResponse[\s\S]*?if \(!isActiveAccountRecord\(data\)\)/)
  })

  it('is applied to every Security & Access API route', () => {
    expect(routes.length).toBeGreaterThanOrEqual(11)
    for (const route of routes) {
      const source = readFileSync(route, 'utf8')
      const gated = source.includes('await isActiveSecurityAccessAccount(user.id)')
        || /require(Security|SelfService)Actor\(/.test(source)
      expect(gated, route).toBe(true)
    }
  })
})
