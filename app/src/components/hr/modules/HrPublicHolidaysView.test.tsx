// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// UI/UX reconciliation 2026-10-26: the holiday form records WHERE a holiday applies (the database matches the
// employee's work state); a "State" holiday without a state used to apply to everyone. Edit controls follow the API's
// own rule (HR settings authority).
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))
let allowed: Record<string, boolean> = {}
vi.mock('@/hooks/useNavAccess', () => ({ useNavAccess: () => ({ allows: (id: string) => allowed[id] === true }) }))

import HrPublicHolidaysView, { holidayScopeLabel } from './HrPublicHolidaysView'

const year = new Date().getFullYear()
const rows = [
  { id: 'h1', name: 'Merdeka Day', date: `${year}-08-31`, is_recurring: true, state: null },
  { id: 'h2', name: 'Federal Territory Day', date: `${year}-02-01`, is_recurring: true, state: 'WP' },
  { id: 'h3', name: 'Pesta Kaamatan', date: `${year}-05-30`, is_recurring: false, state: 'Labuan' },
]
let posts: any[] = []
beforeEach(() => {
  toast.mockReset(); posts = []; allowed = { 'hr/settings/configuration': true }
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    if (init?.method === 'POST' || init?.method === 'PUT') { posts.push({ method: init.method, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ success: true, data: {} })) }
    return new Response(JSON.stringify({ success: true, data: rows }))
  }) as any
})
afterEach(cleanup)

describe('holidayScopeLabel', () => {
  it('names national, per-territory and legacy WP holidays', () => {
    expect(holidayScopeLabel(null)).toBe('National (all employees)')
    expect(holidayScopeLabel('Labuan')).toBe('W.P. Labuan')
    expect(holidayScopeLabel('kuala lumpur')).toBe('W.P. Kuala Lumpur')
    expect(holidayScopeLabel('WP')).toBe('WP — all Federal Territories')
  })
})

describe('HrPublicHolidaysView', () => {
  it('shows where each holiday applies', async () => {
    render(<HrPublicHolidaysView />)
    expect(await screen.findByText('National (all employees)')).toBeTruthy()
    expect(screen.getByText('WP — all Federal Territories')).toBeTruthy()
    expect(screen.getByText('W.P. Labuan')).toBeTruthy()
  })

  it('sends the chosen state with a new holiday (null for national)', async () => {
    render(<HrPublicHolidaysView />)
    await screen.findByText('Merdeka Day')
    fireEvent.click(screen.getByRole('button', { name: /Add Holiday/ }))
    fireEvent.change(screen.getByPlaceholderText('e.g. Company Anniversary'), { target: { value: 'Company Day' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(posts[0]).toMatchObject({ method: 'POST', body: { name: 'Company Day', state: null } }))
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Holiday added', description: 'National (all employees)' }))
  })

  it('keeps the state when an existing territory holiday is edited', async () => {
    render(<HrPublicHolidaysView />)
    await screen.findByText('Pesta Kaamatan')
    const editButtons = screen.getAllByRole('button').filter(b => b.querySelector('svg.lucide-pencil'))
    fireEvent.click(editButtons[2])
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(posts[0]).toMatchObject({ method: 'PUT', body: { id: 'h3', state: 'Labuan' } }))
  })

  it('offers no edit controls without HR settings authority (read-only calendar)', async () => {
    allowed = {}
    render(<HrPublicHolidaysView />)
    await screen.findByText('Merdeka Day')
    expect(screen.queryByRole('button', { name: /Add Holiday/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Template/ })).toBeNull()
  })

  it('shows a load failure instead of an empty calendar', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Admin only' }), { status: 403 })) as any
    render(<HrPublicHolidaysView />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText(/No holidays for/)).toBeNull()
  })
})
