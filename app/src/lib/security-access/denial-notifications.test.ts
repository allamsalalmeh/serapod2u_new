// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { denialNotice, installDenialNotifications } from './denial-notifications'
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })
describe('shared authorization notifications', () => {
  it('shows safe text and the backend reference, never raw details', () => {
    const notice = denialNotice(403, { code: 'sa_forbidden', reason: 'MISSING_PERMISSION', referenceId: 'SA-12345678', error: 'secret SQL stack' })!
    expect(notice.title).toBe('Access Denied'); expect(notice.description).toContain('SA-12345678'); expect(notice.description).not.toContain('SQL')
  })
  it('distinguishes sessions, evaluator failures, scopes and step-up', () => {
    expect(denialNotice(401, {})?.title).toBe('Session expired')
    expect(denialNotice(503, { code: 'sa_unavailable' })?.title).toBe('Authorization unavailable')
    expect(denialNotice(403, { code: 'sa_forbidden', reason: 'STEP_UP_REQUIRED' })?.description).toContain('authentication')
    expect(denialNotice(403, { code: 'sa_forbidden', reason: 'SCOPE_MISMATCH' })?.description).toContain('scope')
    expect(denialNotice(403, { error: 'Forbidden' })?.title).toBe('Access Denied')
    expect(denialNotice(200, { code: 'sa_forbidden' })).toBeNull()
  })
  it('coalesces concurrent notices without consuming the original response or emitting a second log', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ code: 'sa_forbidden', permission: 'hr.employee.manage', reason: 'MISSING_PERMISSION', referenceId: 'SA-87654321' }), { status: 403, headers: { 'content-type': 'application/json' } }))
    window.fetch = fetcher
    const notify = vi.fn(); const stop = installDenialNotifications(notify)
    const responses = await Promise.all(Array.from({ length: 5 }, () => window.fetch('/api/hr/employees')))
    expect(notify).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(5)
    expect(await responses[0].json()).toMatchObject({ code: 'sa_forbidden' })
    stop(); expect(window.fetch).toBe(fetcher)
  })
  it('does not observe external responses', async () => {
    window.fetch = vi.fn(async () => new Response('{"code":"sa_forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } }))
    const notify = vi.fn(); const stop = installDenialNotifications(notify)
    await window.fetch('https://example.com/api/hr'); expect(notify).not.toHaveBeenCalled(); stop()
  })
})


describe('page versus interactive notification ownership', () => {
  it('keeps full-page denial feedback single while notifying an interactive POST once', async () => {
    document.body.innerHTML = '<div data-access-state="denied">Access denied</div>'
    window.fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'sa_forbidden', permission: 'ecommerce.channel.manage', reason: 'MISSING_PERMISSION', referenceId: 'SA-persisted123' }), { status: 403, headers: { 'content-type': 'application/json' } }))
    const notify = vi.fn(); const stop = installDenialNotifications(notify)
    await window.fetch('/api/payment-gateway/access')
    expect(notify).not.toHaveBeenCalled()
    await window.fetch('/api/payment-gateway/access', { method: 'POST' })
    await window.fetch('/api/payment-gateway/access', { method: 'POST' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0].description).toContain('SA-persisted123')
    stop()
  })
})
