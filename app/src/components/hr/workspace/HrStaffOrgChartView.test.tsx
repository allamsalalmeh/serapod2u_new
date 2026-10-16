// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HrStaffOrgChartView from './HrStaffOrgChartView'

const respond = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const nodes = [
  { key: 'n1', name: 'Aisha CEO', jobTitle: 'CEO', department: 'Executive', managerKey: null, isSelf: false },
  { key: 'n2', name: 'Ben Ops', jobTitle: 'Ops Lead', department: 'Operations', managerKey: 'n1', isSelf: true },
  { key: 'n3', name: 'Cara Ops', jobTitle: null, department: 'Operations', managerKey: 'n2', isSelf: false },
]
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('staff organization chart', () => {
  it('renders the reporting line with name, title and department, read-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { nodes })))
    const { container } = render(<HrStaffOrgChartView />)
    await waitFor(() => expect(screen.getByText('Aisha CEO')).toBeTruthy())
    expect(screen.getByText('Ben Ops (you)')).toBeTruthy()
    expect(screen.getByText('CEO · Executive')).toBeTruthy()
    // nested under the manager
    expect(container.querySelector('ul ul li')?.textContent).toContain('Ben Ops')
    // nothing to click, edit or open: no buttons or links besides the search field
    expect(container.querySelectorAll('button, a, [contenteditable]').length).toBe(0)
  })

  it('filters by name, title or department', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { nodes })))
    render(<HrStaffOrgChartView />)
    await waitFor(() => expect(screen.getByText('Aisha CEO')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Search the organization chart'), { target: { value: 'operations' } })
    expect(screen.getByText('Cara Ops').closest('div[class*="opacity-50"]')).toBeNull()
    expect(screen.getByText('Aisha CEO').closest('div[class*="opacity-50"]')).not.toBeNull()
  })

  it('does not loop on a reporting cycle', async () => {
    const cyc = [
      { key: 'a', name: 'A', jobTitle: null, department: null, managerKey: 'b', isSelf: false },
      { key: 'b', name: 'B', jobTitle: null, department: null, managerKey: 'a', isSelf: false },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { nodes: cyc })))
    render(<HrStaffOrgChartView />)
    await waitFor(() => expect(screen.getByText('A')).toBeTruthy())
    expect(screen.getAllByText('B')).toHaveLength(1) // shown once, under A; A is not repeated under B
  })

  it('separates a failed load from a denial', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(503)))
    const failed = render(<HrStaffOrgChartView />)
    await waitFor(() => expect(screen.getByText(/couldn’t load the organization chart/)).toBeTruthy())
    expect(screen.queryByText(/don’t have access/)).toBeNull()
    failed.unmount()
    vi.stubGlobal('fetch', vi.fn(async () => respond(403)))
    render(<HrStaffOrgChartView />)
    await waitFor(() => expect(screen.getByText(/You don’t have access to this page/)).toBeTruthy())
  })
})
