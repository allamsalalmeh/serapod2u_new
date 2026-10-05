// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RolesPoliciesPanel from './RolesPoliciesPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const data = {
  modes: [
    { permission_key: 'finance.ledger.view', mode: 'NEW_ENFORCED' },
    { permission_key: 'inventory.stock_count.create', mode: 'SHADOW' },
  ],
  permissions: [
    { id: 'p1', permission_key: 'finance.ledger.view', description: 'View the general ledger', audit_sensitivity: 'ordinary' },
    { id: 'p2', permission_key: 'inventory.stock_count.create', description: 'Start a stock count', audit_sensitivity: 'security_sensitive' },
  ],
  roles: [
    { id: 'r1', name: 'Finance Viewer', role_key: 'finance-viewer', source: 'template', status: 'active', permissions: [{ permission: { permission_key: 'finance.ledger.view' } }] },
    { id: 'r2', name: 'Legacy HQ', role_key: 'legacy-hq', source: 'legacy', status: 'active', permissions: [] },
  ],
  scopeDefinitions: [{ id: 's1', scope_type: 'organization', display_name: 'Serapod HQ' }, { id: 's2', scope_type: 'warehouse', display_name: 'Main WH' }],
}
const governance = { readiness: [{ permission_key: 'finance.ledger.view', database_backstop: 'rls_gate', notes: 'wired' }], authorityPolicies: [] }

describe('Roles & Policies', () => {
  it('hides group mode changes and disables single changes only when the server says the viewer lacks the authority', async () => {
    const props = { governance, onChanged: vi.fn(), initialQuery: 'finance.ledger.view' }
    const { unmount } = render(<RolesPoliciesPanel data={{ ...data, capabilities: { canManageModes: false } }} {...props} />)
    expect(screen.queryByRole('button', { name: /^Change group mode for/ })).toBeNull()
    expect((screen.getByRole('combobox', { name: /^Change mode for/ }) as HTMLSelectElement).disabled).toBe(true)
    unmount()
    render(<RolesPoliciesPanel data={{ ...data, capabilities: { canManageModes: true } }} {...props} />)
    expect(screen.getAllByRole('button', { name: /^Change group mode for/ }).length).toBeGreaterThan(0)
    expect((screen.getByRole('combobox', { name: /^Change mode for/ }) as HTMLSelectElement).disabled).toBe(false)
  })

  it('shows one section at a time, with counts', async () => {
    render(<RolesPoliciesPanel data={data} governance={governance} onChanged={vi.fn()} />)
    expect(screen.getByRole('tab', { name: /^Migration modes\s*2$/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('button', { name: /^Finance, 1 permission, expand/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('tab', { name: /^Access Profiles\s*2$/ }))
    expect(screen.queryByRole('button', { name: /^Finance, 1 permission/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Finance, 1 role, expand/ }))
    expect(screen.getByRole('button', { name: /^Finance Viewer, 1 permission/ })).toBeTruthy()
  })

  it('opens the tree at a permission when arriving from the Overview, and guards enforcement by readiness', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('prompt', () => 'Parity reviewed for a week')
    const onChanged = vi.fn()
    render(<RolesPoliciesPanel data={data} governance={governance} onChanged={onChanged} initialQuery="inventory.stock_count.create" />)
    const select = screen.getByRole('combobox', { name: /Change mode for Create Stock Count/ }) as HTMLSelectElement
    const enforce = Array.from(select.options).find(o => o.value === 'NEW_ENFORCED')!
    expect(enforce.disabled).toBe(true)
    expect(screen.getByText('Not ready for enforcement')).toBeTruthy()
    await userEvent.selectOptions(select, 'LEGACY_ENFORCED')
    expect(fetchMock).toHaveBeenCalledWith('/api/security-access/modes', expect.objectContaining({
      body: JSON.stringify({ permissionKey: 'inventory.stock_count.create', mode: 'LEGACY_ENFORCED', reason: 'Parity reviewed for a week' }),
    }))
    expect(onChanged).toHaveBeenCalled()
  })

  it('separates business roles from compatibility roles and folds their permissions', async () => {
    render(<RolesPoliciesPanel data={data} governance={governance} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('tab', { name: /Access Profiles/ }))
    expect(screen.queryByText('Legacy HQ')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Compatibility\s*1$/ }))
    // A role with no mapped permissions stays visible under Other / Unmapped.
    await userEvent.click(screen.getByRole('button', { name: /^Other \/ Unmapped, 1 role/ }))
    expect(screen.getByText('Legacy HQ')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^Business roles\s*1$/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Finance, 1 role/ }))
    expect(screen.queryByText('View Ledger')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Finance Viewer/ }))
    expect(screen.getByText('View Ledger')).toBeTruthy()
    expect(screen.getByText(/Finance · General Ledger · 1/)).toBeTruthy()
  })

  it('keeps cross-module roles discoverable from each module filter', async () => {
    const roles = [...data.roles, { id: 'r3', name: 'Payroll Finance Approver', role_key: 'pfa', source: 'template', status: 'active',
      permissions: [{ permission: { permission_key: 'hr.payroll.approve' } }, { permission: { permission_key: 'finance.payment.approve' } }] }]
    render(<RolesPoliciesPanel data={{ ...data, roles }} governance={governance} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('tab', { name: /Access Profiles/ }))
    expect(screen.getByRole('button', { name: /^Shared \/ Cross-module, 1 role/ })).toBeTruthy()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Module' }), 'hr_payroll')
    expect(screen.getByText('Payroll Finance Approver')).toBeTruthy()
    expect(screen.queryByText('Finance Viewer')).toBeNull()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Module' }), 'finance')
    expect(screen.getByText('Payroll Finance Approver')).toBeTruthy()
    expect(screen.getByText('Finance Viewer')).toBeTruthy()
    expect(screen.getByText(/Showing 2 of 2 roles/)).toBeTruthy()
  })

  it('groups scopes by type and lists the catalogue with descriptions', async () => {
    render(<RolesPoliciesPanel data={data} governance={governance} onChanged={vi.fn()} />)
    await userEvent.click(screen.getByRole('tab', { name: /Scopes/ }))
    expect(screen.queryByText('Main WH')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^warehouse scopes, 1/ }))
    expect(screen.getByText('Main WH')).toBeTruthy()
    await userEvent.click(screen.getByRole('tab', { name: /Permission catalogue/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Supply Chain,/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Supply Chain: Stock Count/ }))
    expect(screen.getByText('Start a stock count')).toBeTruthy()
    expect(screen.getByText('Sensitive audit')).toBeTruthy()
  })

  describe('group mode change', () => {
    const bulkData = {
      ...data,
      modes: [
        { permission_key: 'inventory.stock_count.view', mode: 'NEW_ENFORCED' }, { permission_key: 'inventory.stock_count.create', mode: 'NEW_ENFORCED' },
        { permission_key: 'inventory.stock_count.verify', mode: 'SHADOW' }, { permission_key: 'finance.ledger.view', mode: 'SHADOW' },
      ],
      permissions: [],
    }
    const row = (key: string, current: string, target: string, status: string, blockers: any[] = []) => ({ permissionKey: key, label: key, currentMode: current, targetMode: target, status, blockers })
    const preview = (over: any = {}) => ({
      group: { id: 'supply_chain/stock_count', name: 'Supply Chain · Stock Count', total: 3 }, targetMode: 'LEGACY_RETIRED',
      rows: [row('inventory.stock_count.create', 'NEW_ENFORCED', 'LEGACY_RETIRED', 'change'), row('inventory.stock_count.view', 'NEW_ENFORCED', 'LEGACY_RETIRED', 'change'),
        row('inventory.stock_count.verify', 'SHADOW', 'LEGACY_RETIRED', 'blocked', [{ code: 'sa_retire_requires_new_enforced', message: 'Legacy can only be retired from New Access Active.' }])],
      counts: { change: 2, unchanged: 0, blocked: 1 }, previewHash: 'a'.repeat(64), canApplyAll: false, canApplyEligibleOnly: true, ...over,
    })
    const respond = (handler: (url: string, body: any) => any) => vi.fn(async (url: string, init: any) => {
      const out = handler(url, JSON.parse(init.body))
      return { ok: out.status ? out.status < 400 : true, status: out.status ?? 200, json: async () => out.body ?? out }
    })

    it('adds a group button beside each module and subgroup that does not toggle the accordion, and counts hidden permissions', async () => {
      render(<RolesPoliciesPanel data={bulkData} governance={governance} onChanged={vi.fn()} />)
      const supply = screen.getByRole('button', { name: /^Change group mode for Supply Chain, 3 permissions$/ })
      const toggle = screen.getByRole('button', { name: /^Supply Chain, 3 permissions, expand/ })
      await userEvent.click(supply)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('dialog', { name: /Change group mode: Supply Chain/ })).toBeTruthy()
      expect(screen.getByText(/all 3 permissions in this group, including any hidden/)).toBeTruthy()
      await userEvent.click(screen.getByRole('button', { name: 'Close' }))
      // Subgroup button appears once the module is open; collapsed children stay collapsed.
      await userEvent.click(toggle)
      const sub = screen.getByRole('button', { name: /^Change group mode for Stock Count, 3 permissions$/ })
      await userEvent.click(sub)
      expect(screen.getByRole('button', { name: /^Supply Chain: Stock Count, 3 permissions, expand/ }).getAttribute('aria-expanded')).toBe('false')
      expect(screen.getByRole('dialog', { name: /Supply Chain · Stock Count/ })).toBeTruthy()
    })

    it('a search never narrows the group: the button and dialog still cover the full group', async () => {
      render(<RolesPoliciesPanel data={bulkData} governance={governance} onChanged={vi.fn()} initialQuery="inventory.stock_count.verify" />)
      await userEvent.click(screen.getByRole('button', { name: /^Change group mode for Stock Count, 3 permissions$/ }))
      expect(screen.getByRole('dialog').textContent).toMatch(/Supply Chain · Stock Count/)
      expect(screen.getByRole('dialog').textContent).toMatch(/all 3 permissions/)
    })

    it('previews blockers, disables "all", offers eligible-only, requires a reason, applies once and reports totals', async () => {
      const fetchMock = respond((_url, body) => body.action === 'preview'
        ? { preview: preview() }
        : { ok: true, result: { batchId: 'batch-1', changed: 2, unchanged: 0, skipped: 1, replayed: false, items: [] } })
      vi.stubGlobal('fetch', fetchMock)
      const onChanged = vi.fn()
      render(<RolesPoliciesPanel data={bulkData} governance={governance} onChanged={onChanged} />)
      await userEvent.click(screen.getByRole('button', { name: /^Change group mode for Supply Chain, 3 permissions$/ }))
      await userEvent.click(screen.getByRole('radio', { name: /Legacy Retired/ }))
      const dialog = within(await screen.findByRole('dialog'))
      expect(await dialog.findByText('2 will change')).toBeTruthy()
      expect(dialog.getByText('0 already in target mode')).toBeTruthy()
      expect(dialog.getByText('1 blocked')).toBeTruthy()
      expect(dialog.getByText('Legacy can only be retired from New Access Active.')).toBeTruthy()
      expect(dialog.getAllByText('New Access Active → Legacy Retired').length).toBe(2)
      expect(dialog.getByText('Monitoring / Shadow → Legacy Retired')).toBeTruthy()
      const applyBtn = dialog.getByRole('button', { name: /^Apply to 2 permissions$/ }) as HTMLButtonElement
      expect((dialog.getByRole('radio', { name: /^All permissions/ }) as HTMLInputElement).checked).toBe(true)
      await userEvent.type(dialog.getByLabelText(/^Reason/), 'too short')
      expect(applyBtn.disabled).toBe(true)                       // all-selected + blocked: nothing can change
      await userEvent.click(dialog.getByRole('radio', { name: /Eligible permissions only/ }))
      expect(applyBtn.disabled).toBe(true)                       // reason is still under 10 trimmed characters
      await userEvent.type(dialog.getByLabelText(/^Reason/), ' now ok')
      expect(applyBtn.disabled).toBe(false)
      await userEvent.dblClick(applyBtn)
      expect(await dialog.findByText('2 changed · 0 unchanged · 1 skipped')).toBeTruthy()
      const applies = fetchMock.mock.calls.map(c => JSON.parse(c[1].body)).filter(b => b.action === 'apply')
      expect(applies).toHaveLength(1)
      expect(applies[0]).toEqual({ action: 'apply', groupId: 'supply_chain', mode: 'LEGACY_RETIRED', selection: 'eligible_only', reason: 'too short now ok', previewHash: 'a'.repeat(64), idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) })
      expect(applies[0]).not.toHaveProperty('permissions')
      expect(onChanged).toHaveBeenCalledTimes(1)
    })

    it('keeps Apply disabled when no change remains', async () => {
      vi.stubGlobal('fetch', respond(() => ({ preview: preview({ counts: { change: 0, unchanged: 3, blocked: 0 }, canApplyAll: false, canApplyEligibleOnly: false,
        rows: preview().rows.map((r: any) => ({ ...r, status: 'unchanged', blockers: [] })) }) })))
      render(<RolesPoliciesPanel data={bulkData} governance={governance} onChanged={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /^Change group mode for Supply Chain, 3 permissions$/ }))
      await userEvent.click(screen.getByRole('radio', { name: /Legacy Retired/ }))
      const dialog = within(await screen.findByRole('dialog'))
      await userEvent.type(await dialog.findByLabelText(/^Reason/), 'a perfectly good reason')
      expect((dialog.getByRole('button', { name: /^Apply to 0 permissions$/ }) as HTMLButtonElement).disabled).toBe(true)
      expect(dialog.getByText(/No changes remain/)).toBeTruthy()
    })

    it('asks for a fresh preview when the server says the preview is stale, and explains a missing migration', async () => {
      let mode = 'stale'
      vi.stubGlobal('fetch', respond((_u, body) => body.action === 'preview'
        ? (mode === 'missing' ? { status: 409, body: { code: 'bulk_migration_missing', error: 'needs migration' } } : { preview: preview({ canApplyAll: true, counts: { change: 3, unchanged: 0, blocked: 0 } }) })
        : { status: 409, body: { code: 'stale_preview', error: 'The group changed since this preview.' } }))
      render(<RolesPoliciesPanel data={bulkData} governance={governance} onChanged={vi.fn()} />)
      await userEvent.click(screen.getByRole('button', { name: /^Change group mode for Supply Chain, 3 permissions$/ }))
      await userEvent.click(screen.getByRole('radio', { name: /Legacy Retired/ }))
      const dialog = within(await screen.findByRole('dialog'))
      await userEvent.type(await dialog.findByLabelText(/^Reason/), 'a perfectly good reason')
      await userEvent.click(dialog.getByRole('button', { name: /^Apply to 3 permissions$/ }))
      expect(await dialog.findByText(/The group changed since this preview/)).toBeTruthy()
      expect(dialog.getByRole('button', { name: 'Refresh preview' })).toBeTruthy()
      mode = 'missing'
      await userEvent.click(dialog.getByRole('radio', { name: /New Access Active/ }))
      expect(await dialog.findByText(/not available in this environment yet/)).toBeTruthy()
      expect(dialog.getByText(/20261004100000_sa_bulk_migration_mode\.sql/)).toBeTruthy()
    })
  })
})
