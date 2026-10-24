// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installDenialNotifications } from '@/lib/security-access/denial-notifications'
const m = vi.hoisted(() => ({ update: vi.fn(), result: { data: { id: 'gateway' } as any, error: null as any } }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => ({
  select: () => ({ eq: async () => ({ data: [{ id: 'gateway', provider: 'stripe', is_active: true, credentials: {} }], error: null }) }),
  update: (...args: any[]) => { m.update(...args); return { eq: () => ({ select: () => ({ maybeSingle: async () => m.result }) }) } },
}) }) }))
import PaymentGatewaySettingsView from './PaymentGatewaySettingsView'
afterEach(cleanup)
beforeEach(() => { m.update.mockReset(); m.result = { data: { id: 'gateway' }, error: null } })
async function deactivate() {
  render(<PaymentGatewaySettingsView organizationId="org-hq" canEdit />)
  await fireEvent.click(await screen.findByRole('button', { name: /Stripe/ }))
  fireEvent.click(screen.getByRole('button', { name: /Deactivate/i }))
}
describe('gateway interactive denial', () => {
  it('shows one shared correlated toast and does not issue writes or show false success', async () => {
    window.fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'sa_forbidden', permission: 'ecommerce.channel.manage', reason: 'MISSING_PERMISSION', referenceId: 'SA-persisted123' }), { status: 403, headers: { 'content-type': 'application/json' } }))
    const notify = vi.fn(); const stop = installDenialNotifications(notify)
    try {
      await deactivate()
      await waitFor(() => expect(notify).toHaveBeenCalledTimes(1))
      expect(notify.mock.calls[0][0].description).toContain('SA-persisted123')
      expect(m.update).not.toHaveBeenCalled()
      expect(screen.queryByText('stripe deactivated.')).toBeNull()
    } finally { stop() }
  })
  it.each(['error', 'empty'])('does not show success after an RLS %s result', async failure => {
    window.fetch = vi.fn(async () => new Response('{"allowed":true}', { status: 200 }))
    m.result = failure === 'error' ? { data: null, error: { code: '42501', message: 'private details' } } : { data: null, error: null }
    await deactivate()
    await screen.findByText('Failed to deactivate')
    expect(screen.queryByText('stripe deactivated.')).toBeNull()
    expect(screen.queryByText('private details')).toBeNull()
  })
})
