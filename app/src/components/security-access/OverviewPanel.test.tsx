// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OverviewPanel from './OverviewPanel'

afterEach(() => cleanup())

const modes = [
  { permission_key: 'finance.ledger.view', mode: 'NEW_ENFORCED', enforcementReady: true },
  { permission_key: 'finance.report.view_sensitive', mode: 'LEGACY_RETIRED', enforcementReady: true },
  { permission_key: 'customer.crm.view', mode: 'SHADOW', enforcementReady: true },
  { permission_key: 'inventory.stock_count.create', mode: 'SHADOW', enforcementReady: false },
]
const base = {
  schemaReady: true,
  metrics: { businessIdentities: 54, activeAssignments: 488, shadowMismatches: 2 },
  modes,
  decisions: [
    { occurred_at: '2026-09-29T10:00:00Z', permission_key: 'customer.crm.view', comparison: 'LEGACY_ALLOW_NEW_DENY' },
    { occurred_at: '2026-09-28T10:00:00Z', permission_key: 'finance.ledger.view', comparison: 'SCOPE_MISMATCH' },
    { occurred_at: '2026-09-27T10:00:00Z', permission_key: 'finance.ledger.view', comparison: 'MATCH_DENY' },
  ],
}

describe('Security & Access Overview', () => {
  it('shows the real metrics, the actual period and working links', async () => {
    const onNavigate = vi.fn()
    render(<OverviewPanel data={base} onNavigate={onNavigate} />)
    expect(screen.getByText('54')).toBeTruthy()
    expect(screen.getByText('488')).toBeTruthy()
    // The first card counts active organization memberships, and says so.
    expect(screen.getByText('Active memberships')).toBeTruthy()
    expect(screen.queryByText('Business identities')).toBeNull()
    expect(screen.getByText(/^in all recorded decisions \(/).textContent).not.toMatch(/24 hours/)

    await userEvent.click(screen.getByRole('button', { name: /^People/ }))
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'people' })
    await userEvent.click(screen.getByRole('button', { name: /^Assignments/ }))
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'people' })
    const review = screen.getAllByRole('button', { name: /^Review/ })
    await userEvent.click(review[0])
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'audit', differencesOnly: true })
  })

  it('flags only differences on permissions still in Monitoring', () => {
    render(<OverviewPanel data={base} onNavigate={vi.fn()} />)
    const status = screen.getByRole('status')
    expect(within(status).getByText(/Needs attention/)).toBeTruthy()
    expect(status.textContent).toMatch(/1 difference in all recorded decisions .* is on 1 permission still in Monitoring/)
    // The other difference is on an enforced permission: historical, not an open issue.
    expect(status.textContent).toMatch(/1 other is historical/)
  })

  it('stays quiet when differences are only on enforced permissions, and hides when there are none', () => {
    const enforcedOnly = { ...base, decisions: [base.decisions[1]] }
    const { unmount } = render(<OverviewPanel data={enforcedOnly} onNavigate={vi.fn()} />)
    expect(screen.queryByText(/Needs attention/)).toBeNull()
    expect(screen.getByText(/historical records, not open issues/)).toBeTruthy()
    unmount()
    render(<OverviewPanel data={{ ...base, decisions: [], metrics: { ...base.metrics, shadowMismatches: 0 } }} onNavigate={vi.fn()} />)
    expect(screen.queryByText(/Needs attention/)).toBeNull()
    expect(screen.queryByText(/historical records/)).toBeNull()
    expect(screen.getByText('none in the recorded decisions')).toBeTruthy()
  })

  it('starts with main groups collapsed and totals that reconcile', () => {
    render(<OverviewPanel data={base} onNavigate={vi.fn()} />)
    const table = screen.getByRole('table')
    const toggles = within(table).getAllByRole('button', { expanded: false })
    expect(toggles.map(t => t.getAttribute('aria-label'))).toEqual([
      'Supply Chain, 1 permission, expand', 'Customer & Growth, 1 permission, expand', 'Finance, 2 permissions, expand',
    ])
    const total = within(table).getAllByRole('row').find(r => within(r).queryByRole('rowheader', { name: /^Total/ }))!
    expect(within(total).getAllByRole('cell').slice(0, 3).map(c => c.textContent)).toEqual(['1', '2', '1'])
    expect(screen.queryByText('finance.ledger.view')).toBeNull()
  })

  it('expands group → subgroup → permission; collapsed content is not rendered', async () => {
    const onNavigate = vi.fn()
    render(<OverviewPanel data={base} onNavigate={onNavigate} />)
    const supply = screen.getByRole('button', { name: /^Supply Chain, 1 permission/ })
    await userEvent.click(supply)
    expect(supply.getAttribute('aria-expanded')).toBe('true')
    const stock = screen.getByRole('button', { name: /^Supply Chain: Stock Count/ })
    expect(screen.queryByText('inventory.stock_count.create')).toBeNull()
    await userEvent.click(stock)
    expect(screen.getByText('inventory.stock_count.create')).toBeTruthy()
    expect(screen.getByText('Not marked ready')).toBeTruthy()
    // Closing the parent hides (and unmounts) its subgroups; focus stays on the parent.
    await userEvent.click(supply)
    expect(screen.queryByRole('button', { name: /Stock Count/ })).toBeNull()
    expect(document.activeElement).toBe(supply)

    await userEvent.click(screen.getByRole('button', { name: /^Finance, 2 permissions/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Finance: General Ledger/ }))
    expect(screen.getByText('finance.ledger.view')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Change mode for View Ledger/ }))
    expect(onNavigate).toHaveBeenLastCalledWith({ tab: 'roles', query: 'finance.ledger.view' })
    expect(screen.queryByRole('button', { name: /View details/ })).toBeNull()
  })

  it('keeps several groups open, and Collapse all closes everything', async () => {
    render(<OverviewPanel data={base} onNavigate={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /^Finance/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Customer & Growth/ }))
    expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0)
  })

  it('expands with the keyboard', async () => {
    render(<OverviewPanel data={base} onNavigate={vi.fn()} />)
    const finance = screen.getByRole('button', { name: /^Finance/ })
    finance.focus()
    await userEvent.keyboard('{Enter}')
    expect(finance.getAttribute('aria-expanded')).toBe('true')
  })

  it('search opens the ancestors of a matching permission, states filtered counts, and restores expansion when cleared', async () => {
    render(<OverviewPanel data={base} onNavigate={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /^Finance, / }))
    const search = screen.getByRole('textbox', { name: /Search modules/ })
    await userEvent.type(search, 'stock_count.create')
    expect(screen.getByRole('button', { name: /^Supply Chain,/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /^Supply Chain: Stock Count/ }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('inventory.stock_count.create')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Finance, / })).toBeNull()
    expect(screen.getByText(/Showing 1 of 4 permissions/)).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: /Filtered total/ })).toBeTruthy()

    await userEvent.clear(search)
    expect(screen.getByRole('button', { name: /^Finance, / }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /^Supply Chain,/ }).getAttribute('aria-expanded')).toBe('false')

    await userEvent.type(search, 'nothing-matches')
    expect(screen.getByText(/No modules or permissions match/)).toBeTruthy()
  })

  it('a group-name search shows its descendants', async () => {
    render(<OverviewPanel data={base} onNavigate={vi.fn()} />)
    await userEvent.type(screen.getByRole('textbox', { name: /Search modules/ }), 'customer')
    expect(screen.getByRole('button', { name: /^Customer & Growth, / }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: /^Customer & Growth: CRM & Customers/ })).toBeTruthy()
  })

  it('never presents a capped sample as a complete total', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ occurred_at: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z`, permission_key: 'finance.ledger.view', comparison: 'SCOPE_MISMATCH' }))
    render(<OverviewPanel data={{ ...base, decisions: many }} onNavigate={vi.fn()} />)
    expect(screen.getByText('100+')).toBeTruthy()
    expect(screen.getAllByText(/in the latest 100 non-matching decisions/).length).toBeGreaterThan(0)
  })

  it('keeps mode explanations in an "About access modes" disclosure and has no empty Details column', () => {
    render(<OverviewPanel data={base} onNavigate={vi.fn()} />)
    expect(screen.getByText('About access modes').closest('details')?.hasAttribute('open')).toBe(false)
    expect(within(screen.getByRole('table')).queryByRole('columnheader', { name: 'Details' })).toBeNull()
  })

  it('shows every mode present, including ones outside the three rollout columns', () => {
    const withLegacy = { ...base, modes: [...modes, { permission_key: 'qr.batch.manage', mode: 'LEGACY_ENFORCED' }] }
    render(<OverviewPanel data={withLegacy} onNavigate={vi.fn()} />)
    expect(within(screen.getByRole('table')).getAllByText('Legacy enforced').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /^Supply Chain, 2 permissions/ })).toBeTruthy()
  })

  it('shows an empty state when no permissions are registered', () => {
    render(<OverviewPanel data={{ schemaReady: false, metrics: {}, modes: [], decisions: [] }} onNavigate={vi.fn()} />)
    expect(screen.getByText(/No permissions are registered/)).toBeTruthy()
    expect(screen.getAllByText('—').length).toBe(2)
  })
})
