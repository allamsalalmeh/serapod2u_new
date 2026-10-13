// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

import SystemLogsView from './SystemLogsView'
import { __resetSystemLogsAccessCache } from './useSystemLogsAccess'

const errorRow = {
  id: '00000000-0000-0000-0000-000000000001', occurred_at: '2026-10-07T03:00:00.000Z', reference_id: 'ERR-ABCDEFGHJKMN', organization_id: 'org-1',
  actor_id: 'u-1', actor_name: 'Alice Tan', actor_email: 'alice@example.com', environment: 'staging', app_build: 'b1', source: 'browser',
  severity: 'error', category: 'server', code: null, module: 'Product Catalog', action: 'Load shop staff performance', page_path: '/dashboard',
  api_route: '/api/admin/shop-staff-performance', http_method: 'GET', http_status: 500, message: 'Failed to load shop staff performance',
  group_id: 'g', occurrence_count: 4, correlation_id: null,
}
const detail = {
  event: { ...errorRow, kind: 'error', received_at: '2026-10-07T03:00:01Z', server_reference_id: 'REQ-ABCDEFGHJKMN', counted: true, stack: 'Error: x\n at f (a.ts:1:1)',
    details: { worker: 'none' }, client: { browser: 'Chrome 129', os: 'macOS', device: 'desktop', viewport: '1440x900' } },
  actor: { id: 'u-1', name: 'Alice Tan', email: 'alice@example.com' },
  group: { id: 'g', fingerprint: 'abcdefabcdefabcd', first_seen_at: '2026-10-06T00:00:00Z', last_seen_at: '2026-10-07T03:00:00Z', occurrence_count: 4, environment: 'staging', app_build: 'b1', recent_references: [] },
  related: [{ id: 'r', occurred_at: '2026-10-07T03:00:00Z', reference_id: 'REQ-ABCDEFGHJKMN', source: 'server', kind: 'error', severity: 'error', message: 'relation does not exist', http_status: 500, link: 'same_failure', counted: true }],
}

let listState: 'ok' | 'not_installed' = 'ok'
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/system-logs/access')) return new Response(JSON.stringify({ allowed: true, environment: 'staging' }))
  if (url.startsWith('/api/system-logs/0000')) return new Response(JSON.stringify({ state: 'ok', detail, organizationName: 'Serapod HQ' }))
  if (url.startsWith('/api/system-logs?')) {
    const tab = new URLSearchParams(url.split('?')[1]).get('tab')
    if (listState === 'not_installed') return new Response(JSON.stringify({ state: 'not_installed', items: [], nextCursor: null, environment: 'staging' }))
    const items = tab === 'activity'
      ? [{ sort_key: 'au:1', occurred_at: '2026-10-07T02:00:00Z', source_table: 'audit_logs', organization_id: 'org-1', actor_id: 'u-2', actor_name: 'Admin', module: 'User Management', action: 'user.password_reset', outcome: 'denied', message: 'not_authorized', entity_type: 'user', entity_id: 'u-3', details: {} }]
      : [errorRow]
    return new Response(JSON.stringify({ state: 'ok', items, nextCursor: tab === 'activity' ? null : 'CURSOR1', environment: 'staging' }))
  }
  return new Response('{}', { status: 404 })
})
const writeText = vi.fn(async () => {})

beforeEach(() => {
  __resetSystemLogsAccessCache()
  listState = 'ok'
  fetchMock.mockClear(); toast.mockClear(); writeText.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const listCalls = () => fetchMock.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/api/system-logs?'))

describe('System Logs view', () => {
  it('opens on Errors, defaulted to the last 24 hours, severity error and this server\'s environment', async () => {
    render(<SystemLogsView />)
    expect((await screen.findAllByText('Failed to load shop staff performance')).length).toBeGreaterThan(0)
    const params = new URLSearchParams(listCalls().at(-1)!.split('?')[1])
    expect(params.get('tab')).toBe('errors')
    expect(params.get('environment')).toBe('staging')
    expect(params.get('severity')).toBe('error')
    expect((Date.now() - Date.parse(params.get('from')!)) / 3_600_000).toBeCloseTo(24, 0)
    for (const h of ['Time', 'User', 'Module', 'Action / Page', 'Result', 'Message', 'Reference ID']) expect(screen.getAllByText(h).length).toBeGreaterThan(0)
    expect(screen.getAllByText('×4').length).toBeGreaterThan(0)
  })

  it('sends filters server-side and pages with the cursor', async () => {
    render(<SystemLogsView />)
    await screen.findAllByText('Failed to load shop staff performance')
    fireEvent.change(screen.getByLabelText('Module'), { target: { value: 'Supply Chain' } })
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'network' } })
    await waitFor(() => {
      const p = new URLSearchParams(listCalls().at(-1)!.split('?')[1])
      expect(p.get('module')).toBe('Supply Chain')
      expect(p.get('category')).toBe('network')
    })
    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    await waitFor(() => expect(new URLSearchParams(listCalls().at(-1)!.split('?')[1]).get('cursor')).toBe('CURSOR1'))
  })

  it('opens the detail drawer with grouped facts and related events, and copies a sanitized report', async () => {
    render(<SystemLogsView />)
    const cells = await screen.findAllByText('Failed to load shop staff performance')
    fireEvent.click(cells[0])
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByText('Serapod HQ')
    expect(within(dialog).getByText(/4 occurrences/)).toBeTruthy()
    expect(within(dialog).getByText('relation does not exist')).toBeTruthy()
    expect(within(dialog).getByText('Chrome 129 · macOS · desktop · 1440x900')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /Copy diagnostic report/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const report = (writeText.mock.calls[0] as unknown as [string])[0]
    expect(report).toContain('Reference ID: ERR-ABCDEFGHJKMN')
    expect(report).toContain('Server reference (X-Request-ID): REQ-ABCDEFGHJKMN')
    expect(report).not.toMatch(/Alice|alice@example\.com|Serapod HQ|org-1/)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Diagnostic report copied' }))
  })

  it('User Activity tab: results from server records, outcome filter, no environment filter', async () => {
    render(<SystemLogsView />)
    await screen.findAllByText('Failed to load shop staff performance')
    fireEvent.click(screen.getByRole('tab', { name: 'User Activity' }))
    expect((await screen.findAllByText('Administrative password reset')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('denied').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('Environment')).toBeNull()
    const p = new URLSearchParams(listCalls().at(-1)!.split('?')[1])
    expect(p.get('tab')).toBe('activity')
    expect(p.get('environment')).toBeNull()
    fireEvent.change(screen.getByLabelText('Result'), { target: { value: 'failure' } })
    await waitFor(() => expect(new URLSearchParams(listCalls().at(-1)!.split('?')[1]).get('outcome')).toBe('failure'))
  })

  it('shows an accurate state while the migration is pending', async () => {
    listState = 'not_installed'
    render(<SystemLogsView />)
    expect(await screen.findByText(/storage is not installed in this database yet/)).toBeTruthy()
  })
})
