import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAllHrNavItems, getHrBreadcrumb, hrNavGroups } from './hrNav'
import { HR_DESTINATIONS } from '@/lib/security-access/nav-access'

// UI/UX reconciliation 2026-10-26: every HR menu / landing-card link must open a real page (no 404, no undocumented
// URL), be gated by a registered S&A destination, and the Wave 1–3 workflows must be reachable from the menu.
const APP_DIR = join(__dirname, '..', '..', 'app')
const pageFor = (href: string) => join(APP_DIR, href.split('?')[0].replace(/^\//, ''), 'page.tsx')

describe('HR navigation targets', () => {
  it('every HR menu link resolves to an existing page', () => {
    for (const item of getAllHrNavItems()) expect(existsSync(pageFor(item.href)), `${item.id} → ${item.href}`).toBe(true)
  })

  it('every HR menu link is gated by a registered HR destination', () => {
    for (const item of getAllHrNavItems()) {
      for (const id of item.requiresAny ?? [item.id]) expect(HR_DESTINATIONS[id], `${item.id} needs ${id}`).toBeDefined()
    }
  })

  it('the HR setup checklist target "Public Holidays" is a real page and in the Attendance menu', () => {
    expect(existsSync(pageFor('/hr/attendance/public-holidays'))).toBe(true)
    const attendance = hrNavGroups.find(g => g.id === 'hr-attendance')!
    expect(attendance.children.map(c => c.label)).toEqual(['Attendance Operations', 'Timesheets', 'Public Holidays'])
  })

  it('leave balances are reachable from the menu and open the Balances tab of the leave screen', () => {
    const leave = hrNavGroups.find(g => g.id === 'hr-leave')!
    const balances = leave.children.find(c => c.id === 'hr/leave/balances')!
    expect(balances.href).toBe('/hr/leave/requests?tab=balances')
    expect(balances.requiresAny).toEqual(['hr/leave/requests'])
    expect(leave.children.map(c => c.label)).toEqual(['Leave Requests & Approvals', 'Balances & Entitlements', 'Leave Types'])
  })

  it('names the attendance workspace by what it is (HR operations, not the employee clock)', () => {
    expect(getHrBreadcrumb('hr/attendance/clock-in-out').map(c => c.label)).toEqual(['HR', 'Attendance', 'Attendance Operations'])
    expect(getHrBreadcrumb('hr/attendance/public-holidays').map(c => c.label)).toEqual(['HR', 'Attendance', 'Public Holidays'])
  })

  it('has no duplicate menu ids', () => {
    const ids = getAllHrNavItems().map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
