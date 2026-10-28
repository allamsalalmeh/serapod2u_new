import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const guard = vi.fn()
const deletionPreview = vi.fn()
const deletionExecute = vi.fn()

vi.mock('@/lib/server/destructive-ops-guard', () => ({ assertDestructiveOpsAllowed: (...a: unknown[]) => guard(...a) }))
vi.mock('@/lib/identity/permanent-deletion', () => ({
  isUuid: (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v),
  deletionPreview: (...a: unknown[]) => deletionPreview(...a),
  deletionExecute: (...a: unknown[]) => deletionExecute(...a),
}))

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const post = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/admin/bulk-delete-users', { method: 'POST', body: JSON.stringify(body) })
async function events(res: Response) {
  const text = await res.text()
  return text.split('\n\n').filter(Boolean).map(chunk => JSON.parse(chunk.replace(/^data: /, '')))
}
const allowedPreview = (n: number) => ({ ok: true, preview: { allowed: true, preview_token: `tok-${n}`, confirmation_phrase: `u${n}@example.test`, blockers: [] } })

describe('bulk-delete-users: every account through the canonical permanent deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    guard.mockResolvedValue({ blocked: false, userId: 'admin-1', response: NextResponse.json({}) })
  })

  it('the destructive-operations guard still decides first', async () => {
    guard.mockResolvedValue({ blocked: true, response: NextResponse.json({ error: 'blocked' }, { status: 403 }) })
    const { POST } = await import('./route')
    expect((await POST(post({ userIds: [id(1)] }))).status).toBe(403)
    expect(deletionPreview).not.toHaveBeenCalled()
  })

  it('requires a reason and the typed batch confirmation before anything is checked', async () => {
    const { POST } = await import('./route')
    const noReason = await events(await POST(post({ userIds: [id(1), id(2)], reason: 'short', confirmation: 'DELETE 2 USERS' })))
    expect(noReason.at(-1)).toMatchObject({ type: 'error' })
    const wrongCount = await events(await POST(post({ userIds: [id(1), id(2)], reason: 'Pre-go-live clean-up of test accounts', confirmation: 'DELETE 1 USERS' })))
    expect(wrongCount.at(-1)).toMatchObject({ type: 'error', message: 'Type "DELETE 2 USERS" to confirm' })
    const duplicates = await events(await POST(post({ userIds: [id(1), id(1)], reason: 'Pre-go-live clean-up of test accounts', confirmation: 'DELETE 2 USERS' })))
    expect(duplicates.at(-1)).toMatchObject({ type: 'error' })
    expect(deletionPreview).not.toHaveBeenCalled()
  })

  it('previews and executes each identity as the guard-verified caller; blocked and unauthorized accounts are kept', async () => {
    deletionPreview.mockImplementation(async (_actor: string, userId: string) => {
      if (userId === id(2)) return { ok: true, preview: { allowed: false, blockers: [{ code: 'PROTECTED_RECORDS', message: 'Referenced by 2 Supply Chain records.' }] } }
      if (userId === id(3)) return { ok: false, status: 403, code: 'FORBIDDEN', message: 'Not authorized' }
      return allowedPreview(1)
    })
    deletionExecute.mockResolvedValue({ ok: true, outcome: { status: 'completed', deletionId: 'd-1', authVerified: true } })
    const { POST } = await import('./route')
    const list = await events(await POST(post({ userIds: [id(1), id(2), id(3)], callerId: 'someone-else',
      reason: 'Pre-go-live clean-up of test accounts', confirmation: 'DELETE 3 USERS' })))

    expect(deletionPreview).toHaveBeenCalledWith('admin-1', id(1), 'user_management')
    expect(deletionExecute).toHaveBeenCalledTimes(1)
    expect(deletionExecute).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'admin-1', userId: id(1), entry: 'user_management', previewToken: 'tok-1',
      confirmation: 'u1@example.test', reason: 'Bulk deletion: Pre-go-live clean-up of test accounts',
    }))
    const complete = list.at(-1)
    expect(complete.type).toBe('complete')
    expect(complete.summary).toMatchObject({ total: 3, success: 1, blocked: 1, notAuthorized: 1, failed: 0 })
    expect(complete.results.find((r: any) => r.id === id(2))).toMatchObject({ result: 'blocked', detail: 'Referenced by 2 Supply Chain records.' })
  })

  it('an unverified login or a stale preview is never counted as deleted', async () => {
    deletionPreview.mockResolvedValue(allowedPreview(1))
    deletionExecute
      .mockResolvedValueOnce({ ok: false, status: 502, code: 'AUTH_CLEANUP_REQUIRED', message: 'login not confirmed' })
      .mockResolvedValueOnce({ ok: true, outcome: { status: 'stale' } })
    const { POST } = await import('./route')
    const list = await events(await POST(post({ userIds: [id(1), id(2)], reason: 'Pre-go-live clean-up of test accounts', confirmation: 'DELETE 2 USERS' })))
    expect(list.at(-1).summary).toMatchObject({ total: 2, success: 0, failed: 2 })
  })
})
