import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  user: { id: 'u-1' } as { id: string } | null,
  store: vi.fn(),
  org: 'org-1',
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.user } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { organization_id: mocks.org } }) }) }) }) }),
}))
vi.mock('@/lib/system-logs/server', () => ({ storeDiagnostic: mocks.store }))

import { POST } from './route'
import { resetRateLimitsForTests } from '@/lib/security/rate-limit'

const event = (over: Record<string, unknown> = {}) => ({
  referenceId: `ERR-${Math.random().toString(36).slice(2, 14).toUpperCase().padEnd(12, 'X')}`, occurredAt: new Date().toISOString(),
  category: 'network', message: 'Failed to fetch', module: 'Orders', action: 'Save order', pagePath: '/dashboard/orders?q=alice@example.com', ...over,
})
const post = (body: unknown, raw?: string, ip = '10.0.0.1') => new NextRequest('http://localhost/api/system-logs/report', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/129.0' },
  body: raw ?? JSON.stringify(body),
})

beforeEach(() => {
  resetRateLimitsForTests()
  mocks.user = { id: 'u-1' }
  mocks.store.mockReset()
  mocks.store.mockResolvedValue({ stored: true })
})

describe('POST /api/system-logs/report — untrusted browser input', () => {
  it('requires a signed-in session (no anonymous reporting)', async () => {
    mocks.user = null
    expect((await POST(post({ events: [event()] }))).status).toBe(401)
    expect(mocks.store).not.toHaveBeenCalled()
  })

  it('derives actor, organization, environment, source and kind on the server; client-supplied identity is ignored', async () => {
    const res = await POST(post({ events: [event({
      actorId: 'someone-else', actor_id: 'someone-else', organizationId: 'org-x', organization_id: 'org-x', environment: 'production',
      source: 'server', kind: 'activity', severity: 'error', fingerprint: 'ffffffffffffffff', outcome: 'success',
    })] }))
    expect(res.status).toBe(200)
    const payload = mocks.store.mock.calls[0][0]
    expect(payload).toMatchObject({ actor_id: 'u-1', organization_id: 'org-1', environment: 'test', source: 'browser', kind: 'error', severity: 'error' })
    expect(payload.fingerprint).not.toBe('ffffffffffffffff')
    expect(payload).not.toHaveProperty('outcome')
  })

  it('sanitizes before storage (paths, messages, stacks, details)', async () => {
    await POST(post({ events: [event({
      category: 'unexpected', message: 'Save failed for bob@example.com with Bearer abcdefghijklmnop',
      stack: 'Error\n    at x (/Users/me/app/src/a.ts:1:1)', details: { password: 'p', note: 'call 0123456789', token: 't', order_no: 'ORD-1' },
    })] }))
    const p = mocks.store.mock.calls[0][0]
    expect(p.page_path).toBe('/dashboard/orders')
    expect(p.message).not.toMatch(/bob@|abcdefghijklmnop/)
    expect(p.stack).not.toMatch(/\/Users\/me/)
    expect(p.details).toEqual({ note: 'call [number]', order_no: 'ORD-1' })
    expect(p.client).toMatchObject({ browser: 'Chrome 129', os: 'Windows', device: 'desktop' })
  })

  it('rejects malformed, oversized and over-long batches', async () => {
    expect((await POST(post(null, '{not json'))).status).toBe(400)
    expect((await POST(post({ events: [] }))).status).toBe(400)
    expect((await POST(post({ events: Array.from({ length: 11 }, () => event()) }))).status).toBe(400)
    expect((await POST(post(null, JSON.stringify({ events: [event({ message: 'x'.repeat(40_000) })] })))).status).toBe(413)
    const res = await POST(post({ events: [event({ referenceId: 'bad ref!' }), event({ category: 'bogus' }), event({ httpStatus: 9999 }), event()] }))
    expect(await res.json()).toMatchObject({ rejected: 3 })
    expect(mocks.store).toHaveBeenCalledTimes(1)
  })

  it('drops cancellations and hot-reload noise', async () => {
    const res = await POST(post({ events: [event({ category: 'cancelled' }), event({ message: '[HMR] connected', category: 'unexpected' })] }))
    expect(await res.json()).toMatchObject({ accepted: [], rejected: 2 })
    expect(mocks.store).not.toHaveBeenCalled()
  })

  it('rate-limits per user (30 events/minute) and per IP', async () => {
    for (let i = 0; i < 3; i++) await POST(post({ events: Array.from({ length: 10 }, () => event()) }))
    expect(mocks.store).toHaveBeenCalledTimes(30)
    const limited = await POST(post({ events: [event()] }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
    resetRateLimitsForTests()
    let last = 0
    for (let i = 0; i < 121; i++) last = (await POST(post({ events: [{}] }, undefined, '10.9.9.9'))).status
    expect(last).toBe(429)
  })

  it('a storage failure is reported as rejected, never as a server error', async () => {
    mocks.store.mockResolvedValue({ stored: false, reason: 'storage_unavailable' })
    const res = await POST(post({ events: [event()] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: [], rejected: 1 })
  })
})
