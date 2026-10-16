import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

let actor: any
const requireSecurityActor = vi.fn(async (_p: string) => actor)
const previewBulkModeChange = vi.fn()
const applyBulkModeChange = vi.fn()
vi.mock('@/lib/security-access/admin-api', () => ({ requireSecurityActor: (p: string) => requireSecurityActor(p) }))
vi.mock('@/lib/security-access/bulk-modes', async () => ({
  ...(await vi.importActual<any>('@/lib/security-access/bulk-modes')),
  previewBulkModeChange: (...a: any[]) => previewBulkModeChange(...a),
  applyBulkModeChange: (...a: any[]) => applyBulkModeChange(...a),
}))

const post = async (body: unknown) => {
  const { POST } = await import('./route')
  return POST({ json: async () => body } as any)
}
const apply = { action: 'apply', groupId: 'supply_chain/stock_count', mode: 'LEGACY_RETIRED', selection: 'eligible_only', reason: 'Parity reviewed for a week', previewHash: 'a'.repeat(64), idempotencyKey: '11111111-1111-4111-8111-111111111111' }

describe('POST /api/security-access/modes/bulk', () => {
  beforeEach(() => {
    actor = { userId: 'admin-1', organizationId: 'org', admin: {} }
    requireSecurityActor.mockClear(); previewBulkModeChange.mockReset(); applyBulkModeChange.mockReset()
  })

  it('requires the permission-management authority before doing anything', async () => {
    actor = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await post({ action: 'preview', groupId: 'finance', mode: 'SHADOW' })).status).toBe(403)
    expect((await post(apply)).status).toBe(403)
    expect(requireSecurityActor).toHaveBeenCalledWith('security.permission.manage')
    expect(previewBulkModeChange).not.toHaveBeenCalled()
    expect(applyBulkModeChange).not.toHaveBeenCalled()
  })

  it('explains an authority denial instead of a bare "Forbidden"', async () => {
    actor = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const body = await (await post({ action: 'preview', groupId: 'finance', mode: 'SHADOW' })).json()
    expect(body.code).toBe('forbidden')
    expect(body.error).toMatch(/Manage permissions/)
  })

  it('rejects client-supplied permission lists and other forged input', async () => {
    for (const body of [
      { action: 'preview', groupId: 'finance', mode: 'SHADOW', permissions: ['finance.ledger.view'] },
      { ...apply, permissionKeys: ['finance.ledger.view'] },
      { ...apply, mode: 'ROOT' }, { ...apply, reason: 'x'.repeat(501) }, { ...apply, reason: 42 }, { ...apply, selection: 'everything' },
      { ...apply, groupId: '../x' }, { ...apply, idempotencyKey: 'not-a-uuid' }, { ...apply, previewHash: 'xyz' },
      { action: 'delete', groupId: 'finance', mode: 'SHADOW' }, null,
    ]) expect((await post(body)).status).toBe(400)
    expect(previewBulkModeChange).not.toHaveBeenCalled()
    expect(applyBulkModeChange).not.toHaveBeenCalled()
  })

  it('runs the preview and the apply as the authenticated actor, never a client-named one', async () => {
    previewBulkModeChange.mockResolvedValue({ ok: true, value: { counts: {} } })
    applyBulkModeChange.mockResolvedValue({ ok: true, value: { changed: 26, unchanged: 0, skipped: 4 } })
    expect((await post({ action: 'preview', groupId: 'finance', mode: 'SHADOW' })).status).toBe(200)
    expect(previewBulkModeChange).toHaveBeenCalledWith(actor.admin, 'admin-1', { groupId: 'finance', targetMode: 'SHADOW' })
    const res = await post(apply)
    expect((await res.json()).result.changed).toBe(26)
    expect(applyBulkModeChange).toHaveBeenCalledWith(actor.admin, 'admin-1', expect.objectContaining({ selection: 'eligible_only', reason: 'Parity reviewed for a week' }))
  })

  it('an apply without a note reaches the server-side rule (which knows the current modes)', async () => {
    applyBulkModeChange.mockResolvedValue({ ok: true, value: { changed: 3 } })
    const { reason: _omit, ...noNote } = apply
    expect((await post({ ...noNote, mode: 'NEW_ENFORCED' })).status).toBe(200)
    expect(applyBulkModeChange).toHaveBeenCalledWith(actor.admin, 'admin-1', expect.objectContaining({ targetMode: 'NEW_ENFORCED', reason: undefined }))
  })

  it('returns the typed failure (e.g. stale preview) with its status', async () => {
    applyBulkModeChange.mockResolvedValue({ ok: false, status: 409, code: 'stale_preview', error: 'changed' })
    const res = await post(apply)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'changed', code: 'stale_preview' })
  })
})
