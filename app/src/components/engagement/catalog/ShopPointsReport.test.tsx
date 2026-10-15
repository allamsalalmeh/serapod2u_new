// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ShopPointsReport } from './ShopPointsReport'
const mocks = vi.hoisted(() => ({ push: vi.fn(), single: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ single: mocks.single }) }) }) }) }))
vi.mock('@/components/users/UserManagementNew', () => ({ default: (props: any) => <div role="dialog">Edit User {props.editUserId}<button onClick={props.onEditUnavailable}>Unavailable</button><button onClick={props.onEditClose}>Close</button></div> }))
const orgId = '10000000-0000-4000-8000-000000000001'
const userId = '20000000-0000-4000-8000-000000000002'
const row = { shop_id: orgId, shop_name: 'Test Outlet', branch_name: 'Test Branch', reference_user_id: userId, shop_reference_am: 'Test Reference', total_consumers: 0, total_points_balance: 10, total_collected_system: 10, total_collected_manual: 0, total_migration_points: 0, total_redeemed: 0, total_transactions: 1, last_activity: null }
function mount(rows = [row]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: rows }) }))
  return render(<ShopPointsReport userProfile={{ roles: { role_level: 20 } } as any} reportStatusRule={{} as any} />)
}
beforeEach(() => { vi.clearAllMocks(); mocks.single.mockResolvedValue({ data: { id: orgId }, error: null }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe('ranking record links', () => {
  it('uses the row organization ID in a same-tab link and retains the branch', async () => {
    mount()
    const link = await screen.findByRole('link', { name: row.shop_name })
    expect(link.getAttribute('href')).toBe(`/supply-chain/organizations/${orgId}/edit`)
    expect(link.getAttribute('target')).toBeNull()
    expect(screen.getByText(row.branch_name)).toBeTruthy()
    fireEvent.click(link)
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/supply-chain/organizations/${orgId}/edit`))
  })
  it('opens the existing editor with the exact reference ID without navigation', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: row.shop_reference_am }))
    expect(screen.getByRole('dialog').textContent).toContain(userId)
    expect(mocks.push).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Unavailable'))
    expect(screen.queryByRole('button', { name: row.shop_reference_am })).toBeNull()
    expect(screen.getByText(row.shop_reference_am)).toBeTruthy()
  })
  it.each(['', 'invalid'])('renders missing/invalid identifiers as plain text (%s)', async (id) => {
    mount([{ ...row, shop_id: id, reference_user_id: id }])
    await screen.findByText(row.shop_name)
    expect(screen.queryByRole('link', { name: row.shop_name })).toBeNull()
    expect(screen.queryByRole('button', { name: row.shop_reference_am })).toBeNull()
  })
  it.each(['PGRST116', '42501'])('handles missing or forbidden organizations (%s)', async (code) => {
    mocks.single.mockResolvedValue({ data: null, error: { code } }); mount()
    fireEvent.click(await screen.findByRole('link', { name: row.shop_name }))
    await screen.findByText(/Unable to open organization/)
    expect(mocks.push).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: row.shop_name })).toBeNull()
  })
  it('keeps filtering, sorting, pagination and CSV export available', async () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({ ...row, shop_id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, shop_name: `Outlet ${String(index).padStart(2, '0')}` }))
    mount(rows); await screen.findByText('Page 1 of 2')
    fireEvent.click(screen.getByRole('columnheader', { name: 'Shop' }))
    expect(screen.getAllByRole('link')[0].textContent).toBe('Outlet 20')
    fireEvent.click(screen.getByText('Page 1 of 2').nextElementSibling!)
    expect(screen.getByText('Page 2 of 2')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Search shop...'), { target: { value: 'Outlet 03' } })
    expect(screen.getAllByRole('link')).toHaveLength(1)
    const create = vi.fn(() => 'blob:test')
    URL.createObjectURL = create; URL.revokeObjectURL = vi.fn()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(create).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce(); click.mockRestore()
  })
})
