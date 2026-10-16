// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccessSimulator from './AccessSimulator'
import DecisionLog from './DecisionLog'

const HQ = '11111111-1111-4111-8111-111111111111'
const WH = '22222222-2222-4222-8222-222222222222'
const ADMIN = '33333333-3333-4333-8333-333333333333'
const MANAGER = '44444444-4444-4444-8444-444444444444'
const organizations = [
  { id: HQ, org_name: 'Serapod HQ', org_type_code: 'HQ', parent_org_id: null },
  { id: WH, org_name: 'Main Warehouse', org_type_code: 'WH', parent_org_id: HQ },
]
const people = [
  { id: ADMIN, full_name: 'Aisha Admin', email: 'aisha@example.test', role_code: 'SA', organization_id: HQ, organization: { org_name: 'Serapod HQ' } },
  { id: MANAGER, full_name: 'Marcus Manager', email: 'marcus@example.test', role_code: 'MANAGER', organization_id: HQ, organization: { org_name: 'Serapod HQ' } },
]
const permissions = ['inventory.stock_count.verify', 'inventory.transfer.request', 'security.role.assign'].map((permission_key, i) => ({ id: String(i), permission_key }))
const userProfile = { id: ADMIN, full_name: 'Aisha Admin', organization_id: HQ, role_code: 'SA' }

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  // Radix popovers need these in jsdom.
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any
  Element.prototype.scrollIntoView = vi.fn()
  fetchMock = vi.fn(async () => new Response(JSON.stringify({
    decision: 'ALLOW', permission: 'inventory.stock_count.verify', actor: MANAGER, reasonCode: 'LEGACY_ALLOWED', newReasonCode: 'SCOPE_MISMATCH',
    migrationMode: 'SHADOW', legacyDecision: 'ALLOW', newDecision: 'DENY', policyVersion: 'sa-wave1-v1', decisionId: 'dec-123',
    matchedAssignments: [{ assignmentId: 'asg-9', roleName: 'Legacy MANAGER' }],
    resolvedScopes: [{ assignmentId: 'asg-9', scopeType: 'organization', scopeValue: HQ, matched: false }],
  }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Access Simulator', () => {
  it('uses names instead of UUID text inputs and defaults to the signed-in administrator', () => {
    render(<AccessSimulator userProfile={userProfile} people={people} actors={[]} permissions={permissions} organizations={organizations} />)
    expect(screen.getByRole('combobox', { name: 'User' }).textContent).toContain('Aisha Admin')
    expect(screen.getByRole('combobox', { name: 'Permission' }).textContent).toContain('Verify Stock Count')
    expect(screen.getByRole('combobox', { name: 'Organization' }).textContent).toContain('Serapod HQ')
    expect(screen.getByRole('combobox', { name: 'Resource type' }).textContent).toContain('Stock Count')
    expect(screen.queryByRole('textbox')).toBeNull() // no free-text UUID fields
    expect(document.body.textContent).not.toContain(ADMIN)
  })

  it('searches users by name and sends only the selected IDs to the explain-only endpoint', async () => {
    const user = userEvent.setup()
    render(<AccessSimulator userProfile={userProfile} people={people} actors={[]} permissions={permissions} organizations={organizations} />)
    await user.click(screen.getByRole('combobox', { name: 'User' }))
    await user.type(screen.getByPlaceholderText('Search user…'), 'marcus')
    await user.click(await screen.findByText('Marcus Manager'))
    await user.click(screen.getByRole('combobox', { name: 'Warehouse' }))
    await user.click(await screen.findByText('Main Warehouse'))
    await user.click(screen.getByRole('button', { name: 'Explain access' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/security-access/simulate')
    expect(JSON.parse(String(init.body))).toEqual({
      actorId: MANAGER, permission: 'inventory.stock_count.verify',
      resource: { type: 'stock_count', organizationId: HQ, warehouseId: WH },
    })
  })

  it('explains the result in plain language and keeps identifiers under Technical details', async () => {
    const user = userEvent.setup()
    render(<AccessSimulator userProfile={userProfile} people={people} actors={[]} permissions={permissions} organizations={organizations} />)
    await user.click(screen.getByRole('button', { name: 'Explain access' }))
    expect((await screen.findAllByText('ALLOW')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Allowed by the existing (legacy) role permissions.').length).toBeGreaterThan(0)
    expect(screen.getByText('Legacy MANAGER')).toBeTruthy()
    expect(screen.getByText('Monitoring / Shadow')).toBeTruthy()
    expect(screen.getByText(/New model: The user’s role applies to a different organization or warehouse/)).toBeTruthy()
    const technical = screen.getByText('Technical details').closest('details')!
    expect(technical.open).toBe(false)
    expect(within(technical).getByText(/dec-123 \(explain-only, not recorded\)/)).toBeTruthy()
    expect(within(technical).getByText('asg-9')).toBeTruthy()
  })
})

describe('Decision log', () => {
  const decisions = [
    { id: 'd1', occurred_at: '2026-09-27T06:05:18Z', actor_id: MANAGER, permission_key: 'inventory.stock_count.verify', resource_type: 'stock_count', resource_id: 'sess-1', decision: 'ALLOW', reason_code: 'LEGACY_ALLOWED', migration_mode: 'SHADOW', legacy_decision: 'ALLOW', new_decision: 'DENY', comparison: 'SCOPE_MISMATCH', resolved_scopes: [{ scopeType: 'warehouse', scopeValue: WH, matched: false }], matched_assignments: [], correlation_id: 'corr-1', policy_version: 'sa-wave1-v1' },
    { id: 'd2', occurred_at: '2026-09-27T06:05:46Z', actor_id: ADMIN, permission_key: 'inventory.stock_count.post', resource_type: 'stock_count', resource_id: 'sess-1', decision: 'ALLOW', reason_code: 'LEGACY_ALLOWED', migration_mode: 'SHADOW', legacy_decision: 'ALLOW', new_decision: 'ALLOW', comparison: 'MATCH_ALLOW', resolved_scopes: [{ scopeType: 'organization', scopeValue: HQ, matched: true }], matched_assignments: [{ assignmentId: 'asg-1' }], correlation_id: 'corr-1', policy_version: 'sa-wave1-v1' },
  ]

  it('shows readable rows, filters differences, and expands technical identifiers on demand', async () => {
    const user = userEvent.setup()
    render(<DecisionLog decisions={decisions} actors={[]} people={people} organizations={organizations} />)
    expect(screen.getByText('Marcus Manager')).toBeTruthy()
    expect(screen.getByText('Verify Stock Count')).toBeTruthy()
    expect(screen.getByText('Warehouse: Main Warehouse')).toBeTruthy()
    expect(screen.getByText('Org: Serapod HQ')).toBeTruthy()
    expect(screen.getByText('Scope mismatch')).toBeTruthy()
    expect(screen.queryByText('corr-1')).toBeNull()

    await user.click(screen.getByText('Marcus Manager'))
    expect(screen.getByText('No matching role')).toBeTruthy()
    expect(screen.queryByText('corr-1')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Technical reference/ }))
    expect(screen.getByText('corr-1')).toBeTruthy()
    expect(screen.getByText('d1')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Differences only' }))
    expect(screen.queryByText('Aisha Admin')).toBeNull()
  })
})
