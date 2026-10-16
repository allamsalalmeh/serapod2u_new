/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NotificationMonitor from './NotificationMonitor'

const fetchMock = vi.fn()

function response(params: URLSearchParams) {
  const channel = params.get('channel') || 'whatsapp'
  const row = (id: string, status: string, eventCode: string, moduleId: string, moduleName: string, name: string) => ({
    id, channel, kind: 'original', createdAt: '2026-10-01T03:00:00Z', status, rawStatus: status, recipient: '+60123456789', eventCode, provider: 'local_my',
    reference: { kind: 'order', label: 'ORD26000001' }, notificationName: name, moduleId, moduleName, errorMessage: status === 'failed' ? 'Gateway timeout' : null,
    action: { phone: '+60123456789', suggestedTemplateKey: 'recovery_notice', suggestedMessagePreview: 'Hi' },
  })
  const rows = [row('a', 'failed', 'order_submitted', 'supply_chain', 'Supply Chain', 'Order Submitted'), row('b', 'sent', 'user_created_shop', 'platform_settings', 'Platform & Settings', 'User Create New Shop')]
  return {
    rows: params.get('status') === 'failed' ? rows.slice(0, 1) : rows,
    total: params.get('status') === 'failed' ? 1 : 2,
    totalPages: 1,
    statusCounts: { pending: 0, sent: 1, delivered: 0, read: 0, failed: 1, resolved: 0, other: 0 },
    kindCounts: { original: 2, recovery: 3 },
    matchingBeforeStatus: 2,
    facets: {
      modules: [{ value: 'platform_settings', label: 'Platform & Settings', count: 1 }, { value: 'supply_chain', label: 'Supply Chain', count: 1 }, { value: 'unmapped', label: 'Other / Unmapped', count: 0 }],
      types: [
        { value: 'order_submitted', label: 'Order Submitted', count: 1, moduleId: 'supply_chain' },
        { value: 'user_created_shop', label: 'User Create New Shop', count: 1, moduleId: 'platform_settings' },
      ],
      providers: [{ value: 'local_my', label: 'local_my', count: 2 }],
    },
    filters: { page: 1 },
    range: { from: params.get('from'), to: params.get('to'), timezone: 'Asia/Kuala_Lumpur' },
    truncated: false,
    sourceLimit: 2000,
    statuses: channel === 'whatsapp' ? ['pending', 'sent', 'delivered', 'read', 'failed', 'resolved', 'other'] : ['pending', 'sent', 'delivered', 'failed'],
    capabilityNote: channel === 'email' ? 'The email provider confirms acceptance only.' : 'Delivered appears only when the gateway reports it.',
    provider: { configured: true, active: true, name: 'local_my', lastTestStatus: null, lastTestAt: null, lastTestError: null, blockedReason: null },
    selected: { module: null, type: null },
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname === '/api/settings/whatsapp/status') return { ok: true, json: async () => ({ connected: true, provider_name: 'Baileys' }) }
    return { ok: true, json: async () => response(url.searchParams) }
  })
  vi.stubGlobal('fetch', fetchMock)
  window.history.replaceState(null, '', '/notifications/whatsapp-activity-recovery')
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const monitorCalls = () => fetchMock.mock.calls.map(([input]) => new URL(input as string, 'http://localhost')).filter((url) => url.pathname === '/api/settings/notifications/monitor')
const lastMonitorParams = () => monitorCalls().at(-1)!.searchParams

describe('NotificationMonitor', () => {
  it('reads filters from the URL and requests them from the server', async () => {
    window.history.replaceState(null, '', '/notifications/whatsapp-activity-recovery?channel=sms&module=supply_chain&type=order_submitted&from=2026-09-01&to=2026-09-30')
    render(<NotificationMonitor initialChannel="whatsapp" />)
    await waitFor(() => expect(monitorCalls().length).toBeGreaterThan(0))
    expect(Object.fromEntries(lastMonitorParams())).toMatchObject({ channel: 'sms', module: 'supply_chain', type: 'order_submitted', from: '2026-09-01', to: '2026-09-30', page: '1' })
    expect(await screen.findByText(/^1 Sept? 2026 – 30 Sept? 2026$/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /SMS/, pressed: true })).toBeTruthy()
  })

  it('narrows Notification Type to the module and clears an incompatible choice', async () => {
    render(<NotificationMonitor initialChannel="sms" />)
    const typeSelect = await screen.findByLabelText('Notification Type') as HTMLSelectElement
    await waitFor(() => expect(typeSelect.options.length).toBe(3))
    await userEvent.selectOptions(typeSelect, 'order_submitted')
    await userEvent.selectOptions(screen.getByLabelText('Module'), 'supply_chain')
    expect(typeSelect.value).toBe('order_submitted')
    expect(Array.from(typeSelect.options).map((o) => o.value)).toEqual(['all', 'order_submitted'])
    await userEvent.selectOptions(screen.getByLabelText('Module'), 'platform_settings')
    expect(typeSelect.value).toBe('all')
    await waitFor(() => expect(Object.fromEntries(lastMonitorParams())).toMatchObject({ module: 'platform_settings' }))
    expect(lastMonitorParams().get('type')).toBeNull()
    expect(screen.getByRole('option', { name: 'Other / Unmapped (0)' })).toBeTruthy()
  })

  it('uses one status control whose counts ignore the selected status', async () => {
    render(<NotificationMonitor initialChannel="sms" />)
    const status = await screen.findByRole('group', { name: 'Status' })
    await waitFor(() => expect(within(status).getByRole('button', { name: /Failed/ }).textContent).toContain('1'))
    expect(within(status).queryByRole('button', { name: /Read/ })).toBeNull()
    await userEvent.click(within(status).getByRole('button', { name: /Failed/ }))
    await waitFor(() => expect(lastMonitorParams().get('status')).toBe('failed'))
    expect(within(status).getByRole('button', { name: /Sent/ }).textContent).toContain('1')
    expect(screen.queryAllByRole('combobox', { name: /status/i })).toHaveLength(0)
  })

  it('separates WhatsApp recovery messages from original notifications', async () => {
    render(<NotificationMonitor initialChannel="whatsapp" />)
    const kind = await screen.findByRole('group', { name: 'Message kind' })
    await waitFor(() => expect(within(kind).getByRole('button', { name: /Recovery messages \(3\)/ })).toBeTruthy())
    await userEvent.click(within(kind).getByRole('button', { name: /Recovery messages/ }))
    await waitFor(() => expect(lastMonitorParams().get('kind')).toBe('recovery'))
  })

  it('states export scope and sends nothing without an explicit action', async () => {
    render(<NotificationMonitor initialChannel="sms" />)
    await screen.findByText('Order Submitted')
    await userEvent.click(screen.getByRole('button', { name: /Export/ }))
    expect(screen.getByRole('menuitem', { name: 'All matching results (2)' })).toBeTruthy()
    expect((screen.getByRole('menuitem', { name: 'Selected rows only (0)' }) as HTMLButtonElement).disabled).toBe(true)
    const posted = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET')
    expect(posted).toEqual([])
  })

  it('shows the module under the notification name, a readable error and details on demand', async () => {
    render(<NotificationMonitor initialChannel="sms" />)
    const table = await screen.findByRole('table')
    const firstRow = within(table).getAllByRole('row')[1]
    expect(firstRow.textContent).toContain('Order SubmittedSupply Chain')
    expect(firstRow.textContent).toContain('Provider timed out')
    await userEvent.click(within(firstRow).getByRole('button', { name: /Details for Order Submitted/ }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Gateway timeout')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Retry original \(edit & resend\)/ })).toBeTruthy()
  })
})
