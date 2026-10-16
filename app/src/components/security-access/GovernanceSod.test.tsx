// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GovernancePanel from './GovernancePanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const rule = (id: string, name: string, kind: string, left: string, right: string, doc: string | null, enforcement: string) =>
  ({ id, rule_key: id, name, description: `${name} description`, rule_kind: kind, left_key: left, right_key: right, document_type: doc, enforcement, status: 'active' })
const sod = {
  rules: [
    rule('r1', 'Order maker/checker', 'same_document', 'supply_chain.order.create', 'supply_chain.order.approve', 'order', 'enforce'),
    rule('r2', 'Payroll prepare vs approve', 'same_document', 'hr.payroll.prepare', 'hr.payroll.approve', 'payroll_run', 'monitor'),
    rule('r3', 'Payment request maker/checker', 'same_document', 'supply_chain.document.manage', 'finance.payment.approve', 'payment_request', 'monitor'),
    rule('r4', 'Payroll preparation vs release', 'permission_conflict', 'hr.payroll.prepare', 'hr.payroll.release', null, 'monitor'),
    rule('r5', 'Security administration vs payment approval', 'permission_conflict', 'security.role.assign', 'finance.payment.approve', null, 'monitor'),
  ],
  mitigations: [{ id: 'm1', rule_id: 'r2', status: 'active' }],
  violations: [
    { id: 'v1', rule_id: 'r1', user_id: 'u1', document_type: 'order', detected_at: '2026-09-29T02:00:00Z', outcome: 'blocked' },
    { id: 'v2', rule_id: 'r2', user_id: 'u1', document_type: 'payroll_run', detected_at: '2026-09-28T02:00:00Z', outcome: 'allowed_monitor' },
  ],
}
const data = { people: [{ id: 'u1', full_name: 'Aisha Admin' }], actors: [], organizations: [], roles: [] }

async function openSod() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => (url.includes('/sod') ? sod : {}) })))
  render(<GovernancePanel section="sod" data={data} governance={{}} />)
  await screen.findByRole('button', { name: /^Supply Chain, 1 rule/ })
}

describe('Governance → Segregation of Duties', () => {
  it('groups rules by the module they protect, collapsed, with summaries', async () => {
    await openSod()
    const groups = screen.getAllByRole('button', { name: /rules?, expand$/ }).map(b => b.getAttribute('aria-label'))
    expect(groups).toEqual(['Supply Chain, 1 rule, expand', 'HR & Payroll, 2 rules, expand', 'Finance, 2 rules, expand'])
    expect(screen.queryByText('Order maker/checker')).toBeNull()
    expect(screen.getByText('1 blocking · 1 conflict')).toBeTruthy()
  })

  it('opens a rule with readable steps, exceptions and its latest conflicts', async () => {
    await openSod()
    await userEvent.click(screen.getByRole('button', { name: /^HR & Payroll/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Payroll prepare vs approve, expand/ }))
    expect(screen.getByText('The same payroll run')).toBeTruthy()
    expect(screen.getByText('1 active')).toBeTruthy()
    expect(screen.getAllByText('Aisha Admin').length).toBeGreaterThan(0)
  })

  it('filters by enforcement and search, auto-opening matches', async () => {
    await openSod()
    await userEvent.click(screen.getByRole('button', { name: /^Blocks\s*1$/ }))
    expect(screen.getByText('Order maker/checker')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Finance,/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^All\s*5$/ }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Search rules' }), 'zzz')
    expect(screen.getByText(/No rules match/)).toBeTruthy()
  })

  it('keeps recent conflicts folded with outcome filters', async () => {
    await openSod()
    const toggle = screen.getByRole('button', { name: /^Recent conflicts, expand/ })
    await userEvent.click(toggle)
    expect(screen.getByRole('button', { name: /^Blocked\s*1$/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^Blocked\s*1$/ }))
    expect(screen.getAllByText('Order maker/checker').length).toBe(1)
    expect(screen.queryByText('Payroll prepare vs approve')).toBeNull()
  })
})

describe('Governance → Access Requests module filter', () => {
  it('maps requests to modules through their business role and keeps unknown roles visible', async () => {
    const requests = [
      { id: 'q1', role_id: 'role-gl', target_user_id: 'u1', requester_id: 'u1', organization_id: 'o', status: 'requested', reason: 'month end close', created_at: '2026-09-29T02:00:00Z' },
      { id: 'q2', role_id: 'role-gone', target_user_id: 'u1', requester_id: 'u1', organization_id: 'o', status: 'requested', reason: 'old role', created_at: '2026-09-29T02:00:00Z' },
    ]
    const roles = [{ id: 'role-gl', name: 'GL Clerk', source: 'template', status: 'active', permissions: [{ permission: { permission_key: 'finance.ledger.view' } }] }]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => (url.includes('access-requests') ? { requests, canApprove: true } : {}) })))
    render(<GovernancePanel section="requests" data={{ ...data, roles }} governance={{}} />)
    const select = await screen.findByRole('combobox', { name: 'Module' }) as HTMLSelectElement
    await screen.findByText(/month end close/)
    expect(Array.from(select.options).map(o => o.text)).toEqual(['All modules', 'Finance', 'Other / Unmapped'])
    await userEvent.selectOptions(select, 'other')
    expect(screen.getByText(/old role/)).toBeTruthy()
    expect(screen.queryByText(/month end close/)).toBeNull()
  })
})


describe('Governance → Access Requests card', () => {
  const mk = (id: string, status: string) => ({ id, role_id: 'r', target_user_id: 'u1', requester_id: 'u1', organization_id: 'o', status, reason: `reason for ${id}`, created_at: '2026-09-29T02:00:00Z' })
  const renderReq = (requests: any[]) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => (url.includes('access-requests') ? { requests, canApprove: true } : {}) })))
    render(<GovernancePanel section="requests" data={{ ...data, roles: [] }} governance={{}} />)
  }
  it('is one card with Pending/Decided/All counts, a New request action and the intro behind the info popover', async () => {
    renderReq([mk('a', 'requested'), mk('b', 'approved'), mk('c', 'denied')])
    await screen.findByText(/reason for a/)
    expect(screen.getAllByRole('heading', { name: 'Access Requests' })).toHaveLength(1)
    expect(screen.queryByText('Request access')).toBeNull()
    expect(screen.getByRole('button', { name: /^Pending\s*1$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Decided\s*2$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^All\s*3$/ })).toBeTruthy()
    expect(screen.queryByText(/requester and the person receiving access cannot approve/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'About access requests' }))
    expect(screen.getByText(/Temporary requests must end/)).toBeTruthy()
    expect(screen.getByText(/requester and the person receiving access cannot approve/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New request' }).getAttribute('aria-expanded')).toBe('false')
  })
  it('offers "Switch to All" only when previous requests exist', async () => {
    renderReq([mk('b', 'approved')])
    await screen.findByText('No pending access requests.')
    await userEvent.click(screen.getByRole('button', { name: 'Switch to All to view previous requests' }))
    expect(screen.getByText(/reason for b/)).toBeTruthy()
  })
  it('shows only the plain empty state when there are no requests at all', async () => {
    renderReq([])
    await screen.findByText('No pending access requests.')
    expect(screen.queryByText(/Switch to All/)).toBeNull()
  })
})
