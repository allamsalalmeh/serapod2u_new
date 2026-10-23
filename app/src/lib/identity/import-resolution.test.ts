import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveImportIdentity } from './import-resolution'

const rpc = vi.fn()
const admin = { rpc }

describe('bulk import identity resolution', () => {
  beforeEach(() => rpc.mockReset())

  it('reuses an existing person', async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: 'MATCH', user_id: 'u-1', matched_by: 'email+phone' }, error: null })
    expect(await resolveImportIdentity(admin, 'A@x.test ', '+60123456789', 'admin')).toEqual({ userId: 'u-1', create: false, error: null })
    expect(rpc).toHaveBeenCalledWith('identity_resolve', { p_email: 'A@x.test', p_phone: '+60123456789' })
  })

  it('creates only when nobody matches', async () => {
    rpc.mockResolvedValueOnce({ data: { outcome: 'NO_MATCH' }, error: null })
    expect(await resolveImportIdentity(admin, 'new@x.test', '+60123456780', null)).toEqual({ userId: null, create: true, error: null })
  })

  it.each(['IDENTITY_CONFLICT', 'IDENTITY_VERIFICATION_REQUIRED', 'IDENTITY_AMBIGUOUS_PHONE', 'IDENTITY_ARCHIVED'])(
    'refuses the row and records %s for review (never merged, never duplicated)', async (outcome) => {
      rpc.mockResolvedValueOnce({ data: { outcome, matched_user_ids: ['a', 'b'] }, error: null }).mockResolvedValueOnce({ data: 'c', error: null })
      const result = await resolveImportIdentity(admin, 'x@x.test', '+60123456781', 'admin')
      expect(result.userId).toBeNull()
      expect(result.create).toBe(false)
      expect(result.error).toBeTruthy()
      expect(rpc).toHaveBeenLastCalledWith('identity_record_conflict', expect.objectContaining({ p_code: outcome, p_source: 'import', p_actor: 'admin' }))
    })

  it('fails closed when the lookup fails', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'down' } })
    expect((await resolveImportIdentity(admin, 'x@x.test', null, null)).create).toBe(false)
  })
})

describe('self-service consumer registration resolves before creating a login', () => {
  const actions = readFileSync(resolve(process.cwd(), 'src/lib/actions.ts'), 'utf8')
  const register = actions.slice(actions.indexOf('export async function registerConsumer('))
  it('checks the identity before auth.admin.createUser and records phone conflicts', () => {
    expect(register.indexOf('resolveConsumerRegistrationIdentity(')).toBeGreaterThan(0)
    expect(register.indexOf('resolveConsumerRegistrationIdentity(')).toBeLessThan(register.indexOf('auth.admin.createUser('))
    const helper = actions.slice(actions.indexOf('async function resolveConsumerRegistrationIdentity'), actions.indexOf('export async function registerConsumer('))
    expect(helper).toContain("p_source: 'consumer_signup'")
    expect(helper).toContain("if (outcome === 'NO_MATCH' || outcome === 'IDENTITY_PREVIOUSLY_RELEASED') return null")
  })
})

describe('point migration imports use the shared resolver', () => {
  for (const file of ['src/app/api/admin/point-migration/route.ts', 'src/app/api/admin/point-migration-stream/route.ts']) {
    it(file, () => {
      const src = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(src).toContain('await resolveImportIdentity(')
      expect(src).not.toContain('.eq("email", row.email.trim())')
    })
  }
})
