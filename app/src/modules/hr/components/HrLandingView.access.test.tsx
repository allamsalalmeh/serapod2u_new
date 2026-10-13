// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HrLandingView from './HrLandingView'
import { computeDestinations } from '@/lib/security-access/nav-access'

let allowed: Record<string, boolean> = {}
vi.mock('@/hooks/useNavAccess', () => ({
  useNavAccess: () => ({ snapshot: { destinations: allowed }, allows: (id: string) => allowed[id] === true, allowsAny: (ids: readonly string[]) => ids.some(id => allowed[id] === true) }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('./HrHeroBanner', () => ({ default: () => <div /> }))
vi.mock('@/components/shared/SetupReadinessBanner', () => ({ default: () => <div /> }))
afterEach(cleanup)

const answers = (org: string[], self: string[] = []) =>
  computeDestinations({ org: Object.fromEntries(org.map(p => [p, true])), self: Object.fromEntries(self.map(p => [p, true])) })

describe('HR administrative landing cards', () => {
  it('shows only the cards (and links) the administrator\'s permissions allow', () => {
    allowed = answers(['hr.module.view', 'hr.employee.view', 'hr.leave.approve'])
    render(<HrLandingView />)
    expect(screen.getByText('People')).toBeTruthy()
    expect(screen.getByText('Leave Management')).toBeTruthy()
    expect(screen.queryByText('Payroll')).toBeNull()
    expect(screen.queryByText('HR Settings')).toBeNull()
    expect(screen.queryByText('Performance')).toBeNull()
    expect(screen.getByText('Employees')).toBeTruthy()
    expect(screen.getByText('Leave Types')).toBeTruthy() // hr.leave.approve covers leave configuration
  })

  it('shows no administrative setup card to an employee-only user, and never the employee group on this landing', () => {
    allowed = answers([], ['hr.self_service.use'])
    const { container } = render(<HrLandingView />)
    for (const label of ['People', 'Attendance', 'Leave Management', 'Payroll', 'Performance', 'HR Settings', 'My Workspace']) {
      expect(screen.queryByText(label), label).toBeNull()
    }
    expect(container.querySelectorAll('.sera-module-landing__grid > *').length).toBe(0)
  })
})
