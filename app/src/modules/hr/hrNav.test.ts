import { describe, expect, it } from 'vitest'
import { getHrBreadcrumb } from './hrNav'

describe('HR breadcrumbs', () => {
  it('names My Workspace once', () => {
    expect(getHrBreadcrumb('hr/my-workspace').map(c => c.label)).toEqual(['HR', 'My Workspace'])
  })
  it('adds the child page after it', () => {
    expect(getHrBreadcrumb('hr/mobile/leave').map(c => c.label)).toEqual(['HR', 'My Workspace', 'My Leave'])
    expect(getHrBreadcrumb('hr/mobile/payslip').map(c => c.label)).toEqual(['HR', 'My Workspace', 'My Payslips'])
  })
  it('keeps the administrative trail for administrative pages', () => {
    expect(getHrBreadcrumb('hr/people/employees')).toEqual([
      { label: 'HR', href: '/hr' }, { label: 'People' }, { label: 'Employees', href: '/hr/people/employees' },
    ])
  })
})
