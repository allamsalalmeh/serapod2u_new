import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

/** Single-permission mode change: reason required only for an actual move back; optional note otherwise. */
let actor: any
let currentMode: string | null
let rpcResult: { data: any; error: any }
const rpc = vi.fn(async (_fn: string, _args: any) => rpcResult)
vi.mock('@/lib/security-access/admin-api', async () => ({
  requireSecurityActor: async () => actor,
  governanceError: (await vi.importActual<any>('@/lib/security-access/admin-api')).governanceError,
}))

const post = async (body: unknown) => {
  const { POST } = await import('./route')
  return POST({ json: async () => body } as any)
}

beforeEach(() => {
  currentMode = 'SHADOW'
  rpcResult = { data: 'NEW_ENFORCED', error: null }
  rpc.mockClear()
  actor = {
    userId: 'admin-1',
    admin: {
      from: () => {
        const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: currentMode ? { mode: currentMode } : null, error: null }) }
        return chain
      },
      rpc,
    },
  }
})

describe('POST /api/security-access/modes', () => {
  it('requires the permission-management authority', async () => {
    actor = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const res = await post({ permissionKey: 'inventory.transfer.view', mode: 'NEW_ENFORCED' })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('forbidden')
  })

  it('moving to New Access Active / Legacy Retired needs no note; blank is sent as no note', async () => {
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: null }]) {
      const res = await post({ permissionKey: 'inventory.transfer.view', mode: 'NEW_ENFORCED', ...body })
      expect(res.status).toBe(200)
    }
    expect(rpc).toHaveBeenLastCalledWith('sa_set_migration_mode', { p_actor: 'admin-1', p_permission: 'inventory.transfer.view', p_mode: 'NEW_ENFORCED', p_reason: null })
    currentMode = 'NEW_ENFORCED'
    expect((await post({ permissionKey: 'inventory.transfer.view', mode: 'LEGACY_RETIRED', reason: 'ok' })).status).toBe(200)
    expect(rpc).toHaveBeenLastCalledWith('sa_set_migration_mode', expect.objectContaining({ p_mode: 'LEGACY_RETIRED', p_reason: 'ok' }))
  })

  it('moving back to Legacy enforced or Monitoring / Shadow requires a reason of 10+ characters', async () => {
    currentMode = 'NEW_ENFORCED'
    for (const mode of ['SHADOW', 'LEGACY_ENFORCED']) {
      for (const reason of [undefined, '', 'too short']) {
        const res = await post({ permissionKey: 'inventory.transfer.view', mode, reason })
        expect(res.status).toBe(400)
        expect((await res.json()).code).toBe('reason_required')
      }
    }
    expect(rpc).not.toHaveBeenCalled()
    expect((await post({ permissionKey: 'inventory.transfer.view', mode: 'SHADOW', reason: '  Parity regression in staging  ' })).status).toBe(200)
    expect(rpc).toHaveBeenLastCalledWith('sa_set_migration_mode', expect.objectContaining({ p_mode: 'SHADOW', p_reason: 'Parity regression in staging' }))
  })

  it('rejects a note over 500 characters and malformed input', async () => {
    expect((await post({ permissionKey: 'inventory.transfer.view', mode: 'NEW_ENFORCED', reason: 'x'.repeat(501) })).status).toBe(400)
    expect((await post({ permissionKey: 'not a key', mode: 'NEW_ENFORCED' })).status).toBe(400)
    expect((await post({ permissionKey: 'inventory.transfer.view', mode: 'ROOT' })).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('explains a database that still requires text for a forward change (migration not applied)', async () => {
    rpcResult = { data: null, error: { message: 'sa_reason_required' } }
    const res = await post({ permissionKey: 'inventory.transfer.view', mode: 'NEW_ENFORCED' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/20261019110000/)
  })

  it('passes database refusals through (e.g. not enforcement-ready)', async () => {
    rpcResult = { data: null, error: { message: 'sa_not_enforcement_ready: inventory.transfer.view' } }
    const res = await post({ permissionKey: 'inventory.transfer.view', mode: 'NEW_ENFORCED' })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
