// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The dashboard's data panels fetch on mount; the quick links do not depend on
// them, so they are stubbed to keep this test about navigation only.
vi.mock('@/components/dashboard/DashboardStatistics', () => ({ default: () => null }))
vi.mock('@/components/dashboard/ActionRequired', () => ({ default: () => null }))
vi.mock('@/components/dashboard/RecentActivities', () => ({ default: () => null }))

const access = vi.hoisted(() => ({ allowed: [] as string[] }))
vi.mock('@/hooks/useNavAccess', () => ({
  useNavAccess: () => ({ allows: (id: string) => access.allowed.includes(id) }),
}))

import DashboardOverview from './DashboardOverview'

const profile = (orgType: string, roleLevel: number) => ({
  id: 'user-1',
  email: 'user@serapod2u.com',
  role_code: 'ADMIN',
  organization_id: 'org-1',
  is_active: true,
  organizations: { id: 'org-1', org_name: 'Serapod Technology', org_type_code: orgType, org_code: 'HQ01' },
  roles: { role_name: 'HQ Admin', role_level: roleLevel },
})

afterEach(() => {
  cleanup()
  access.allowed = []
})

describe('Dashboard quick access', () => {
  it('offers D2H Order right after Create Order and opens the distributor order view', async () => {
    const user = userEvent.setup()
    const onViewChange = vi.fn()
    render(<DashboardOverview userProfile={profile('HQ', 10)} onViewChange={onViewChange} />)

    const labels = screen.getAllByRole('button').map(button => button.textContent)
    expect(labels).toEqual(['Orders', 'Create Order', 'D2H Order', 'Reporting', 'Documents'])

    await user.click(screen.getByRole('button', { name: 'D2H Order' }))
    expect(onViewChange).toHaveBeenCalledWith('distributor-order')
  })

  it('hides the shortcut from users the distributor order view would reject', () => {
    render(<DashboardOverview userProfile={profile('SHOP', 10)} onViewChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'D2H Order' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create Order' })).not.toBeNull()
  })

  it('shows Finance last for users with Finance access and opens the finance landing', async () => {
    access.allowed = ['finance']
    const user = userEvent.setup()
    const onViewChange = vi.fn()
    render(<DashboardOverview userProfile={profile('HQ', 10)} onViewChange={onViewChange} />)

    const labels = screen.getAllByRole('button').map(button => button.textContent)
    expect(labels).toEqual(['Orders', 'Create Order', 'D2H Order', 'Reporting', 'Documents', 'Finance'])

    await user.click(screen.getByRole('button', { name: 'Finance' }))
    expect(onViewChange).toHaveBeenCalledWith('finance')
  })

  it('hides Finance from users without Finance access', () => {
    render(<DashboardOverview userProfile={profile('HQ', 10)} onViewChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Finance' })).toBeNull()
  })
})
