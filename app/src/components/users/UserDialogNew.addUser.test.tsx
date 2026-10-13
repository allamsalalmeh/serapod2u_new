// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The dialog debounces its existing-person lookup (real timers); give a loaded CI machine room.
vi.setConfig({ testTimeout: 20000 })

const stable = vi.hoisted(() => {
  const chain: any = { select: () => chain, order: () => chain, eq: () => chain, in: () => chain, ilike: () => chain, limit: () => chain, then: (r: any) => r({ data: [], error: null }) }
  return { value: { supabase: { from: () => chain, rpc: async () => ({ data: false }) } } }
})
vi.mock('@/lib/hooks/useSupabaseAuth', () => ({ useSupabaseAuth: () => stable.value }))

const listInitialAccessRoles = vi.fn()
vi.mock('@/lib/actions', () => ({ listInitialAccessRoles: (...a: any[]) => listInitialAccessRoles(...a) }))

import UserDialogNew from './UserDialogNew'

const PROFILES = [
  { id: 'wh', name: 'Warehouse Operator', kind: 'custom' as const, scopeTypes: ['warehouse'] },
  { id: 'rcv', name: 'Receiver', kind: 'custom' as const, scopeTypes: ['organization'] },
  { id: 'sc', name: 'Supply Chain Full Access', kind: 'standard' as const, roleKey: 'supply-chain-full-access', permissionKeys: ['inventory.stock_count.view'], scopeTypes: ['warehouse'] },
  { id: 'cg', name: 'Customer & Growth Full Access', kind: 'standard' as const, roleKey: 'customer-growth-full-access', permissionKeys: ['marketing.campaign.view'], scopeTypes: ['warehouse'] },
]
const SCOPES = [
  { id: 's-a', organization_id: 'hq', scope_type: 'warehouse', display_name: 'Balakong' },
  { id: 's-b', organization_id: 'hq', scope_type: 'warehouse', display_name: 'Alma' },
  { id: 's-o', organization_id: 'hq', scope_type: 'organization', display_name: 'Serapod HQ' },
]
const catalogue = (essAllowed: boolean, profiles = PROFILES) => ({ success: true, roles: profiles, profiles, deferredProfiles: [], scopes: SCOPES, orgNames: { hq: 'Serapod HQ' },
  organization: { name: 'Serapod HQ', typeCode: essAllowed ? 'HQ' : 'DIST' }, canAssign: true, legacyReadOnly: true, essAllowed })

const ORGS = [{ id: 'hq', org_name: 'Serapod HQ', org_code: 'HQ01', org_type_code: 'HQ' }, { id: 'dist', org_name: 'Main Distributor', org_code: 'D01', org_type_code: 'DIST' }] as any
const ROLES = [{ role_code: 'MGR', role_name: 'Manager', role_level: 30 }, { role_code: 'USR', role_name: 'User', role_level: 40 }] as any

let lookupResult: any
const fetchMock = vi.fn()
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.scrollIntoView = () => undefined
})
beforeEach(() => {
  lookupResult = { status: 'none' }
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ result: lookupResult }) }))
  vi.stubGlobal('fetch', fetchMock)
  listInitialAccessRoles.mockReset()
  listInitialAccessRoles.mockResolvedValue(catalogue(true))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const onSave = vi.fn()
const onOpenExistingUser = vi.fn()
function open(extra: any = {}) {
  onSave.mockReset(); onOpenExistingUser.mockReset()
  return render(<UserDialogNew user={null} roles={ROLES} organizations={ORGS} open currentUserRoleLevel={1} onOpenChange={() => undefined}
    defaultValues={{ organization_id: 'hq' }} onSave={onSave} onOpenExistingUser={onOpenExistingUser} {...extra} />)
}
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement
const next = () => userEvent.click(screen.getByRole('button', { name: /Next/ }))
/** Wait for the debounced existing-person check to finish (Next is blocked while it runs). */
const settle = () => waitFor(() => expect(screen.queryByText(/Checking whether this person already exists/)).toBeNull(), { timeout: 3000 })

async function fillBasic(user = userEvent) {
  await user.type(field(/Full Name/), 'Ali Hassan')
  await user.type(field(/^Email/), 'ali@example.com')
  await user.type(field(/Phone Number/), '0123456789')
  await user.type(field(/^Password/), 'secret-1')
  await user.type(field(/Confirm Password/), 'secret-1')
}

describe('Add New User — three-step redesign', () => {
  it('shows three steps and keeps entered values when moving between them', async () => {
    open()
    const steps = screen.getAllByRole('button').filter(b => /Basic details|Organization & access|Review/.test(b.textContent || ''))
    expect(steps.map(s => s.textContent?.replace(/^\d/, ''))).toEqual(['Basic details', 'Organization & access', 'Review'])
    await fillBasic()
    await next()
    expect(await screen.findByText('Group Policies', { selector: 'h4' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(field(/Full Name/).value).toBe('Ali Hassan')
    expect(field(/^Email/).value).toBe('ali@example.com')
    expect(field(/^Password/).value).toBe('secret-1')
  })

  it('focuses the first invalid field when validation fails and keeps navigation visible', async () => {
    open()
    await next()
    await waitFor(() => expect(document.activeElement).toBe(field(/Full Name/)))
    expect(screen.getByText('Full name is required')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy()
    await userEvent.type(field(/Full Name/), 'Ali')
    await userEvent.type(field(/^Email/), 'ali@example.com')
    await userEvent.type(field(/Phone Number/), '0123456789')
    await next()
    await waitFor(() => expect(document.activeElement).toBe(field(/^Password/)))
  })

  it('assigns several Group Policies with independent scopes without any legacy level, and reviews everything (never the password)', async () => {
    open()
    await fillBasic()
    await next()
    await screen.findByText('Group Policies', { selector: 'h4' })
    await screen.findByText(/Additional Group Policies/)
    await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
    await userEvent.click(screen.getByRole('button', { name: /, expand$/ }))      // modules start collapsed
    await userEvent.click(screen.getByRole('checkbox', { name: 'Warehouse Operator' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Receiver' }))
    // different valid scopes → separate controls; Receiver has exactly one valid scope, shown and selected
    await userEvent.click(within(screen.getByRole('group', { name: 'Data scope for Warehouse Operator' })).getByRole('checkbox', { name: /Balakong/ }))
    expect(within(screen.getByRole('group', { name: 'Data scope for Receiver' })).getByText(/only option, selected/)).toBeTruthy()
    expect(document.getElementById('user-dialog-access-reason')).toBeNull()
    await settle()

    // No legacy level exists in the form: nothing is asked, validated or chosen for the administrator.
    expect(screen.queryByText(/Legacy compatibility/)).toBeNull()
    expect(screen.queryByText(/Required: choose a level/)).toBeNull()
    expect(document.getElementById('user-dialog-legacy')).toBeNull()
    await next()

    const review = await screen.findByText('Review', { selector: 'h3' })
    const body = review.closest('div.space-y-3') as HTMLElement
    expect(body.textContent).toContain('Warehouse Operator')
    expect(body.textContent).toContain('scope: Balakong')
    expect(body.textContent).toContain('Receiver')
    expect(body.textContent).toContain('scope: Serapod HQ')
    expect(body.textContent).not.toMatch(/Legacy|Level \d/)
    expect(body.textContent).toContain('Not the complete effective access')
    expect(body.textContent).not.toContain('secret-1')

    const create = screen.getByRole('button', { name: /Create User/ })
    await userEvent.dblClick(create)
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))               // repeated clicks never submit twice
    const sent = onSave.mock.calls[0][0]
    expect(sent.initial_role_id).toBe('profiles')
    expect(sent.initial_profiles).toEqual([{ roleId: 'wh', scopeId: 's-a' }, { roleId: 'rcv', scopeId: 's-o' }])
    expect(sent.role_code).toBeFalsy()                                        // no legacy role/level is ever sent
    expect(sent.linked_user_id).toBeUndefined()
    expect(sent.confirmPassword).toBeUndefined()
  })

  it('offers Employee Self Service only for HQ and never for a distributor organization', async () => {
    open()
    await fillBasic(); await next()
    expect(await screen.findByText('Basic access for HQ staff.')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: /Exclude Employee Self Service/ }) as HTMLInputElement).checked).toBe(false)
    cleanup()
    listInitialAccessRoles.mockResolvedValue(catalogue(false))
    open({ organizations: [{ ...ORGS[1], id: 'hq' }] })
    await fillBasic(); await next()
    expect(await screen.findByRole('radio', { name: 'No Group Policy for now' })).toBeTruthy()
    expect(screen.queryByText(/Employee Self Service/)).toBeNull()
  })
})

describe('Add New User — existing person / HR employee', () => {
  const employee = { status: 'employee', matchedBy: 'email', userId: 'emp-1', name: 'Aisyah Rahman', organizationName: 'Serapod HQ', employeeNo: 7, fills: [{ field: 'full_name', label: 'Full name', value: 'Aisyah Rahman' }] }

  it('shows the match inline, never links automatically, previews what is replaced, then links and keeps the existing login', async () => {
    lookupResult = employee
    open()
    await fillBasic(); await next()
    expect(await screen.findByText(/Employee found:/, undefined, { timeout: 3000 })).toBeTruthy()
    expect(screen.getByText('Aisyah Rahman', { selector: 'strong' })).toBeTruthy()
    // The entered name was not overwritten, and continuing is blocked until the choice is explicit.
    await next()
    await waitFor(() => expect(screen.getAllByText(/An HR employee matches this email or phone/).length).toBeGreaterThan(0))

    await userEvent.click(screen.getByRole('button', { name: 'Use employee details' }))
    expect(screen.getByText(/replaces these fields/)).toBeTruthy()
    expect(screen.getByText(/“Ali Hassan” → “Aisyah Rahman”/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Replace and link' }))
    expect(screen.getByText('Linked to HR employee')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(field(/Full Name/).value).toBe('Aisyah Rahman')

    // Changing the email drops the link and says so.
    await next()
    await screen.findByText('Linked to HR employee')
    await userEvent.click(screen.getByRole('button', { name: /Back/ }))
    await userEvent.type(field(/^Email/), 'x')
    await next()
    expect(await screen.findByText(/HR employee link was removed because the email, phone or organization changed/)).toBeTruthy()
    expect(screen.queryByText('Linked to HR employee')).toBeNull()
  })

  it('"Change" unlinks, and a linked submission carries the employee id and no password', async () => {
    lookupResult = employee
    open()
    await fillBasic(); await next()
    await userEvent.click(await screen.findByRole('button', { name: 'Use employee details' }, { timeout: 3000 }))
    await userEvent.click(screen.getByRole('button', { name: 'Link, keep my entry' }))
    await userEvent.click(screen.getByRole('button', { name: 'Change' }))
    expect(screen.queryByText('Linked to HR employee')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Use employee details' }))
    await userEvent.click(screen.getByRole('button', { name: 'Link, keep my entry' }))
    expect(await screen.findByText('Basic access for HQ staff.')).toBeTruthy()
    await next()
    expect((await screen.findByText(/Existing login kept/))).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Create User/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].linked_user_id).toBe('emp-1')
    expect(onSave.mock.calls[0][0].password).toBeUndefined()
  })

  it('blocks an existing account (no duplicate) and offers to open it', async () => {
    lookupResult = { status: 'account_exists', matchedBy: 'email', message: 'An account already exists for this person. No second account is created.', openUserId: 'u-9', name: 'Ali Old', organizationName: 'Serapod HQ' }
    open()
    await fillBasic(); await next()
    expect(await screen.findByText(/No second account is created/, undefined, { timeout: 3000 })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Open existing user' }))
    expect(onOpenExistingUser).toHaveBeenCalledWith('u-9')
    await next()
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('user-dialog-identity')))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('requires resolution when the email and phone belong to different people', async () => {
    lookupResult = { status: 'conflict', message: 'The email and the phone number belong to two different people in the system.' }
    open()
    await fillBasic(); await next()
    expect(await screen.findByText(/two different people/, undefined, { timeout: 3000 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Use employee details' })).toBeNull()
  })

  it('applies only the latest lookup (a slow earlier answer never overwrites the current one)', async () => {
    const answers: Array<(v: any) => void> = []
    fetchMock.mockImplementation(() => new Promise(resolve => { answers.push(resolve) }))
    open()
    await fillBasic(); await next()
    await waitFor(() => expect(answers.length).toBeGreaterThan(0), { timeout: 3000 })
    await userEvent.click(screen.getByRole('button', { name: /Back/ }))
    await userEvent.type(field(/^Email/), 'z')
    await next()
    await waitFor(() => expect(answers.length).toBeGreaterThan(1), { timeout: 3000 })
    answers[1]({ ok: true, json: async () => ({ result: { status: 'none' } }) })
    answers[0]({ ok: true, json: async () => ({ result: employee }) })           // stale answer arrives last
    await waitFor(() => expect(screen.queryByText(/Checking whether this person already exists/)).toBeNull())
    expect(screen.queryByText(/Employee found:/)).toBeNull()
  })
})

describe('Add New User — organization changes revalidate earlier choices', () => {
  const dist = { ...ORGS[1], org_name: 'Main Distributor' }
  async function switchToDistributor() {
    await userEvent.click(screen.getByRole('button', { name: 'Distributor' }))
    await userEvent.click(screen.getByRole('combobox', { name: /Organization/ }))
    await userEvent.click(await screen.findByRole('option', { name: /Main Distributor/ }))
  }

  it('removes policies that do not apply to the new organization — and says so', async () => {
    listInitialAccessRoles.mockImplementation(async (orgId: string) => (orgId === 'dist'
      ? { ...catalogue(false, [PROFILES[1]]), scopes: SCOPES.map(s => ({ ...s, organization_id: 'dist' })) }
      : catalogue(true)))
    open()
    await fillBasic(); await next()
    await screen.findByText(/Additional Group Policies/)
    await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
    await userEvent.click(screen.getByRole('button', { name: /, expand$/ }))      // modules start collapsed
    await userEvent.click(screen.getByRole('checkbox', { name: 'Warehouse Operator' }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Balakong/ }))
    expect(screen.getByRole('list', { name: 'Selected Group Policies' })).toBeTruthy()

    await switchToDistributor()
    expect(await screen.findByText(/selection does not apply to this organization and was removed/)).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Selected Group Policies' })).toBeNull()
  })

  it('drops a pending Employee Self Service choice when the organization is no longer HQ, with an explanation', async () => {
    listInitialAccessRoles.mockImplementation(async (orgId: string) => (orgId === 'dist' ? { ...catalogue(false), scopes: [] } : catalogue(true)))
    open({ organizations: [ORGS[0], dist] })
    await fillBasic(); await next()
    await userEvent.click(await screen.findByRole('checkbox', { name: /Exclude Employee Self Service/ }))
    await switchToDistributor()
    expect(await screen.findByText(/Employee Self Service is available to HQ users only, so the exclusion was cleared/)).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'No Group Policy for now' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByRole('checkbox', { name: /Exclude Employee Self Service/ })).toBeNull()
    expect(screen.queryByText('Basic access for HQ staff.')).toBeNull()
  })

  it('removes an HR employee link when the organization changes away from HQ and explains why', async () => {
    lookupResult = { status: 'employee', matchedBy: 'email', userId: 'emp-1', name: 'Aisyah Rahman', organizationName: 'Serapod HQ', employeeNo: 7, fills: [] }
    listInitialAccessRoles.mockImplementation(async (orgId: string) => (orgId === 'dist' ? { ...catalogue(false), scopes: [] } : catalogue(true)))
    open({ organizations: [ORGS[0], dist] })
    await fillBasic(); await next()
    await userEvent.click(await screen.findByRole('button', { name: 'Use employee details' }, { timeout: 3000 }))
    expect(screen.getByText('Linked to HR employee')).toBeTruthy()
    lookupResult = { status: 'none' }
    await switchToDistributor()
    expect(await screen.findByText(/Employee Self Service is available to HQ users only, so the HR employee link was removed/)).toBeTruthy()
    expect(screen.queryByText('Linked to HR employee')).toBeNull()
  })
})

describe('Add New User — assignment permission states', () => {
  const denial = (cannotCreate: boolean) => ({ success: true, roles: [], canAssign: false, legacyReadOnly: false, denial: { permission: cannotCreate ? 'platform.user.manage' : 'security.role.assign', code: 'MISSING_MEMBERSHIP', cannotCreate, reason: 'Your Security & Access authority does not reach this organization.' } })

  it('shows "Checking assignment permissions" and then the selectors for an authorized administrator', async () => {
    let finish: (v: any) => void = () => undefined
    listInitialAccessRoles.mockImplementation(() => new Promise(r => { finish = r }))
    open()
    await fillBasic(); await next()
    expect(await screen.findByText('Checking assignment permissions…')).toBeTruthy()
    expect(screen.queryByText(/Additional Group Policies/)).toBeNull()
    finish(catalogue(true))
    expect(await screen.findByText(/Additional Group Policies/)).toBeTruthy()
  })

  it('a confirmed denial explains the restriction, offers no selector, and blocks Next when users cannot be created there', async () => {
    listInitialAccessRoles.mockResolvedValue(denial(true))
    open()
    await fillBasic(); await next()
    expect(await screen.findByText(/does not reach this organization/)).toBeTruthy()
    expect(screen.queryByText(/Additional Group Policies/)).toBeNull()
    expect(screen.queryByText('Unable to check assignment permissions', { exact: false })).toBeNull()
    await settle()
    await next()
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('user-dialog-access-status')))
    expect(screen.queryByText('Review', { selector: 'h3' })).toBeNull()
  })

  it('when only assigning is denied the user can still be created, with the policies cleared and no selector', async () => {
    listInitialAccessRoles.mockResolvedValue(denial(false))
    open()
    await fillBasic(); await next()
    expect(await screen.findByText(/You can still create the user without Group Policies/)).toBeTruthy()
    await settle()
    await next()
    expect(await screen.findByText('Review', { selector: 'h3' })).toBeTruthy()
  })

  it('a failed check is "Unable to check assignment permissions" with Retry — not a denial — and assigns nothing unchecked', async () => {
    listInitialAccessRoles.mockResolvedValueOnce({ success: false, failed: true, roles: [], canAssign: false, legacyReadOnly: false })
    open()
    await fillBasic(); await next()
    expect(await screen.findByText(/Unable to check assignment permissions/)).toBeTruthy()
    expect(screen.queryByText(/does not reach|cannot assign/)).toBeNull()
    expect(screen.queryByText(/Additional Group Policies/)).toBeNull()
    await settle(); await next()
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById('user-dialog-access-status')))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/Additional Group Policies/)).toBeTruthy()
    expect(listInitialAccessRoles).toHaveBeenCalledTimes(2)
  })

  it('a catalogue/scope loading failure after authorization is reported accurately, with a fresh Retry', async () => {
    listInitialAccessRoles.mockResolvedValueOnce({ success: false, failed: true, failedStage: 'scopes', roles: [], canAssign: false, legacyReadOnly: false })
    open()
    await fillBasic(); await next()
    expect(await screen.findByText(/permission was confirmed, but the Group Policies or scopes/)).toBeTruthy()
    expect(screen.queryByText(/Unable to check assignment permissions/)).toBeNull()
    expect(screen.queryByText(/Additional Group Policies/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/Additional Group Policies/)).toBeTruthy()
    expect(listInitialAccessRoles).toHaveBeenCalledTimes(2)
  })

  it('a rejected request is also a failed check, never a denial', async () => {
    listInitialAccessRoles.mockRejectedValueOnce(new Error('network'))
    open()
    await fillBasic(); await next()
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(screen.queryByText(/does not reach/)).toBeNull()
  })

  it('rapid organization changes never reuse a stale answer for another organization', async () => {
    const answers: Record<string, (v: any) => void> = {}
    listInitialAccessRoles.mockImplementation((org: string) => new Promise(r => { answers[org] = r }))
    const dist = { ...ORGS[1], org_name: 'Main Distributor' }
    open({ organizations: [ORGS[0], dist] })
    await fillBasic(); await next()
    await waitFor(() => expect(answers.hq).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: 'Distributor' }))
    await userEvent.click(screen.getByRole('combobox', { name: /Organization/ }))
    await userEvent.click(await screen.findByRole('option', { name: /Main Distributor/ }))
    await waitFor(() => expect(answers.dist).toBeTruthy())
    answers.dist(denial(true))                                   // the current organization is denied …
    answers.hq(catalogue(true))                                  // … and a slow answer for the previous one arrives last
    expect(await screen.findByText(/does not reach this organization/)).toBeTruthy()
    expect(screen.queryByText(/Additional Group Policies/)).toBeNull()
  })

  it('an organization change shows "checking" again instead of the previous organization’s permissions', async () => {
    const answers: Record<string, (v: any) => void> = {}
    listInitialAccessRoles.mockImplementation((org: string) => new Promise(r => { answers[org] = r }))
    const dist = { ...ORGS[1], org_name: 'Main Distributor' }
    open({ organizations: [ORGS[0], dist] })
    await fillBasic(); await next()
    await waitFor(() => expect(answers.hq).toBeTruthy())
    answers.hq(catalogue(true))
    expect(await screen.findByText(/Additional Group Policies/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Distributor' }))
    await userEvent.click(screen.getByRole('combobox', { name: /Organization/ }))
    await userEvent.click(await screen.findByRole('option', { name: /Main Distributor/ }))
    expect(await screen.findByText('Checking assignment permissions…')).toBeTruthy()
    expect(screen.queryByText(/Additional Group Policies/)).toBeNull()
  })
})

describe('Add New User — existing-person check states', () => {
  it('a confirmed lookup denial is explained and blocks continuing; a failed lookup offers Retry and does not block', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 403, json: async () => ({ code: 'DENIED', reason: 'Outside your hierarchy.' }) }))
    open()
    await fillBasic(); await next()
    expect(await screen.findByText('Outside your hierarchy.', undefined, { timeout: 3000 })).toBeTruthy()
    cleanup()

    let calls = 0
    fetchMock.mockImplementation(async () => (++calls === 1 ? { ok: false, status: 503, json: async () => ({ code: 'UNAVAILABLE' }) } : { ok: true, json: async () => ({ result: { status: 'none' } }) }))
    open()
    await fillBasic(); await next()
    expect(await screen.findByText(/Unable to check for an existing person/, undefined, { timeout: 3000 })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(calls).toBe(2), { timeout: 3000 })
    await settle()
    expect(screen.queryByText(/Unable to check for an existing person/)).toBeNull()
  })
})

describe('Add New User — information popovers', () => {
  it('keeps long notes behind the shared info icon (Escape closes) and offers no legacy-level popover', async () => {
    open()
    await fillBasic(); await next()
    await screen.findByText('Group Policies', { selector: 'h4' })
    expect(screen.queryByRole('button', { name: 'About the legacy compatibility level' })).toBeNull()
    const icon = screen.getAllByRole('button', { name: /^About / })[0]
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(icon)
    expect(screen.getByRole('dialog')).toBeTruthy()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(icon)
  })

  it('does not show a legacy section whatever the legacy-authorization setting says', async () => {
    listInitialAccessRoles.mockResolvedValue({ ...catalogue(true), legacyReadOnly: false })
    open()
    await fillBasic(); await next()
    await screen.findByText('Group Policies', { selector: 'h4' })
    expect(screen.queryByText(/legacy/i)).toBeNull()
  })
})

describe('Add New User — Reference is HQ-only', () => {
  const dist = { ...ORGS[1], org_name: 'Main Distributor' }
  const reference = () => screen.queryByRole('checkbox', { name: 'Reference' }) as HTMLInputElement | null
  async function toAccessStep() { await fillBasic(); await next(); await screen.findByText('Group Policies', { selector: 'h4' }) }
  async function switchTo(type: string, name: RegExp) {
    await userEvent.click(screen.getByRole('button', { name: type }))
    await userEvent.click(screen.getByRole('combobox', { name: /Organization/ }))
    await userEvent.click(await screen.findByRole('option', { name }))
  }

  it('shows Reference for an HQ organization and hides it for a non-HQ one', async () => {
    listInitialAccessRoles.mockImplementation(async (orgId: string) => (orgId === 'dist' ? { ...catalogue(false), scopes: [] } : catalogue(true)))
    open({ organizations: [ORGS[0], dist] })
    await toAccessStep()
    expect(reference()).not.toBeNull()
    expect(screen.queryByRole('switch', { name: 'Active' })).toBeNull()
    await switchTo('Distributor', /Main Distributor/)
    expect(reference()).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Active' })).toBeNull()
  })

  it('clears a checked Reference when moving to non-HQ and does not restore it on returning to HQ', async () => {
    listInitialAccessRoles.mockImplementation(async (orgId: string) => (orgId === 'dist' ? { ...catalogue(false), scopes: [] } : catalogue(true)))
    open({ organizations: [ORGS[0], dist] })
    await toAccessStep()
    await userEvent.click(reference()!)
    expect(reference()!.checked).toBe(true)
    await switchTo('Distributor', /Main Distributor/)
    await switchTo('HQ', /Serapod HQ/)
    expect(reference()!.checked).toBe(false)
  })

  it('submits can_be_reference=false for a non-HQ account', async () => {
    listInitialAccessRoles.mockImplementation(async (orgId: string) => (orgId === 'dist' ? { ...catalogue(false), scopes: [] } : catalogue(true)))
    open({ organizations: [ORGS[0], dist] })
    await toAccessStep()
    await userEvent.click(reference()!)
    await switchTo('Distributor', /Main Distributor/)
    await userEvent.click(await screen.findByRole('radio', { name: 'No Group Policy for now' }))
    await settle()
    await next()
    await screen.findByText('Review', { selector: 'h3' })
    expect(screen.queryByText('Reference', { selector: 'dt' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Create User/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].can_be_reference).toBe(false)
  })
})

describe('Add New User — Employment details are HQ-only', () => {
  const mfg = { id: 'mfg', org_name: 'Hong Kong Vapehome International Limited', org_code: 'MF004', org_type_code: 'MFG' }
  const employment = () => screen.queryByText('Employment details', { exact: false, selector: 'summary' })
  const openAccess = () => open({ organizations: [ORGS[0], mfg], defaultValues: { organization_id: 'hq', role_code: 'MGR' } })
  async function toAccessStep() { await fillBasic(); await next(); await screen.findByText('Group Policies', { selector: 'h4' }) }
  async function switchTo(type: string, name: RegExp) {
    await userEvent.click(screen.getByRole('button', { name: type }))
    await userEvent.click(screen.getByRole('combobox', { name: /Organization/ }))
    await userEvent.click(await screen.findByRole('option', { name }))
  }
  beforeEach(() => {
    listInitialAccessRoles.mockImplementation(async (orgId: string) => (orgId === 'mfg' ? { ...catalogue(false), organization: { name: mfg.org_name, typeCode: 'MFG' }, roles: [], profiles: [], scopes: [] } : catalogue(true)))
  })

  it('shows Employment details for HQ and hides them for a Manufacturer, with basic fields intact', async () => {
    openAccess()
    await toAccessStep()
    expect(employment()).not.toBeNull()
    await switchTo('Manufacturer', /MF004/)
    expect(employment()).toBeNull()
    expect(screen.queryByText('Department')).toBeNull()
    expect(screen.queryByText('Reports To')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect((field(/Full Name/)).value).toBe('Ali Hassan')
    expect(field(/^Email/).value).toBe('ali@example.com')
  })

  it('clears pending HQ employment values on switching away, never restores them, and never submits them', async () => {
    openAccess()
    await toAccessStep()
    await userEvent.click(employment()!)
    const date = document.querySelector('input[type="date"]') as HTMLInputElement
    await userEvent.type(date, '2026-03-04')
    expect(date.value).toBe('2026-03-04')
    await switchTo('Manufacturer', /MF004/)
    expect(await screen.findByText(/Employment details are available for HQ accounts only/)).toBeTruthy()
    await switchTo('HQ', /Serapod HQ/)
    await userEvent.click(employment()!)
    expect((document.querySelector('input[type="date"]') as HTMLInputElement).value).toBe('')
  })

  it('creates a Manufacturer account with no policy chosen and sends no employment values', async () => {
    openAccess()
    await toAccessStep()
    await userEvent.click(employment()!)
    await userEvent.type(document.querySelector('input[type="date"]') as HTMLInputElement, '2026-03-04')
    await switchTo('Manufacturer', /MF004/)
    // Empty catalogue: nothing is chosen for the admin; the explicit no-policy path is the only route and is not preselected.
    expect(await screen.findByText(/You may assign Group Policies here, but none is eligible/)).toBeTruthy()
    await settle()
    await next()
    await screen.findByText('Review', { selector: 'h3' })
    expect(screen.queryByText(/HR Configuration|Employment/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Create User/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const sent = onSave.mock.calls[0][0]
    expect(sent.join_date || '').toBe('')
    expect(sent.department_id || '').toBe('')
    expect(sent.position_id || '').toBe('')
    expect(sent.manager_user_id || '').toBe('')
    expect(sent.employment_type || '').toBe('')
    expect(sent.employment_status || 'active').toBe('active')
    expect(sent.linked_user_id).toBeUndefined()
  })
})

describe('Add New User — status is always Active', () => {
  it('has no Active toggle or its description, reviews a read-only Active status, and submits is_active=true', async () => {
    listInitialAccessRoles.mockResolvedValue({ ...catalogue(false), scopes: [] })
    open({ defaultValues: { organization_id: 'dist' } })
    await fillBasic(); await next()
    await screen.findByText('Group Policies', { selector: 'h4' })
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('About the Active setting', { exact: false })).toBeNull()
    expect(screen.queryByText('User can log in to the system')).toBeNull()
    await userEvent.click(await screen.findByRole('radio', { name: 'No Group Policy for now' }))
    await settle()
    await next()
    await screen.findByText('Review', { selector: 'h3' })
    const statusRow = screen.getByText('Status', { selector: 'dt' }).parentElement as HTMLElement
    expect(statusRow.textContent).toContain('Active')
    expect(screen.queryByText('Inactive')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Create User/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].is_active).toBe(true)
  })

  it('a stale inactive value in the form can never create an inactive user, and reopening starts Active', async () => {
    listInitialAccessRoles.mockResolvedValue({ ...catalogue(false), scopes: [] })
    open({ defaultValues: { organization_id: 'dist', is_active: false } as any })
    await fillBasic(); await next()
    await screen.findByText('Group Policies', { selector: 'h4' })
    await userEvent.click(await screen.findByRole('radio', { name: 'No Group Policy for now' }))
    await settle()
    await next()
    await screen.findByText('Review', { selector: 'h3' })
    await userEvent.click(screen.getByRole('button', { name: /Create User/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].is_active).toBe(true)
    cleanup()
  })
})

describe('Add New User — default HQ organization', () => {
  const HQ = { id: 'hq-real', org_name: 'Serapod Technology Sdn Bhd', org_code: 'HQ01', org_type_code: 'HQ' }
  const HQ2 = { id: 'hq-2', org_name: 'Second HQ', org_code: 'HQ02', org_type_code: 'HQ' }
  const DIST = { id: 'dist', org_name: 'Main Distributor', org_code: 'D01', org_type_code: 'DIST' }
  const orgTrigger = () => document.getElementById('user-dialog-organization') as HTMLElement
  const toAccess = async () => { await fillBasic(); await next(); await screen.findByText('Organization & access', { selector: 'h3' }) }

  it('auto-selects the only HQ by its real name and loads access options for its id', async () => {
    open({ organizations: [HQ, DIST], defaultValues: {} })
    await toAccess()
    await waitFor(() => expect(orgTrigger().textContent).toContain('Serapod Technology Sdn Bhd'))
    await waitFor(() => expect(listInitialAccessRoles).toHaveBeenCalledWith('hq-real'))
    expect(await screen.findByText(/Additional Group Policies/)).toBeTruthy()
    expect((screen.getByTestId('summary-ess').textContent)).toContain('Employee Self Service')
  })

  it('requires a manual choice with several HQs', async () => {
    open({ organizations: [HQ, HQ2], defaultValues: {} })
    await toAccess()
    expect(orgTrigger().textContent).not.toContain('Serapod Technology')
    expect(listInitialAccessRoles).not.toHaveBeenCalled()
  })

  it('does not select before the list has loaded, and shows an empty state with none', async () => {
    const view = open({ organizations: [HQ], organizationsLoaded: false, defaultValues: {} })
    await toAccess()
    expect(orgTrigger().textContent).not.toContain('Serapod Technology')
    view.unmount()
    open({ organizations: [DIST], defaultValues: {} })
    await toAccess()
    expect(await screen.findByText(/No HQ organization is available/)).toBeTruthy()
  })

  it('keeps the selection across Back/Next and respects a switch to another type', async () => {
    open({ organizations: [HQ, DIST], defaultValues: {} })
    await toAccess()
    await waitFor(() => expect(orgTrigger().textContent).toContain('Serapod Technology'))
    await userEvent.click(screen.getByRole('button', { name: /Back/ }))
    await next()
    await screen.findByText('Organization & access', { selector: 'h3' })
    expect(orgTrigger().textContent).toContain('Serapod Technology')
    await userEvent.click(screen.getByRole('button', { name: /Distributor/ }))
    await waitFor(() => expect(orgTrigger().textContent).not.toContain('Serapod Technology'))
    await new Promise(r => setTimeout(r, 100))
    expect(orgTrigger().textContent).not.toContain('Serapod Technology')
  })
})

describe('Add New User — Employee Self Service default for HQ', () => {
  const dist = { ...ORGS[1], org_name: 'Main Distributor' }
  const excludeBox = () => screen.findByRole('checkbox', { name: /Exclude Employee Self Service/ }) as Promise<HTMLInputElement>
  const create = async () => { await userEvent.click(screen.getByRole('button', { name: /Create User/ })); await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1)); return onSave.mock.calls[0][0] }

  it('HQ staff are created with ESS only and no extra action', async () => {
    open()
    await fillBasic(); await next()
    expect(await screen.findByText('Basic access for HQ staff.')).toBeTruthy()
    expect((await excludeBox()).checked).toBe(false)
    expect(screen.queryByRole('radio')).toBeNull()
    await settle(); await next()
    const review = await screen.findByText('Review', { selector: 'h3' })
    expect((review.closest('div.space-y-3') as HTMLElement).textContent).toContain('Employee Self Service')
    expect(screen.getByTestId('review-ess').textContent).not.toContain('excluded')
    const sent = await create()
    expect(sent.include_ess).toBe(true)
    expect(sent.initial_profiles ?? []).toEqual([])
  })

  it('ESS is retained beside several additional policies, in the access summary and in Review', async () => {
    open()
    await fillBasic(); await next()
    await screen.findByText(/Additional Group Policies/)
    await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
    await userEvent.click(screen.getByRole('button', { name: /, expand$/ }))      // modules start collapsed
    await userEvent.click(screen.getByRole('checkbox', { name: 'Warehouse Operator' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Receiver' }))
    await userEvent.click(within(screen.getByRole('group', { name: 'Data scope for Warehouse Operator' })).getByRole('checkbox', { name: /Balakong/ }))
    expect(screen.getByTestId('summary-ess').textContent).toContain('Employee Self Service')
    await settle(); await next()
    const review = await screen.findByText('Review', { selector: 'h3' })
    const text = (review.closest('div.space-y-3') as HTMLElement).textContent!
    expect(text).toContain('Warehouse Operator'); expect(text).toContain('Receiver'); expect(text).toContain('Employee Self Service')
    const sent = await create()
    expect(sent.include_ess).toBe(true)
    expect(sent.initial_role_id).toBe('profiles')
    expect(sent.initial_profiles).toHaveLength(2)
  })

  it('an explicit exclusion survives Back/Next, is shown in Review and is sent as include_ess=false', async () => {
    open()
    await fillBasic(); await next()
    await userEvent.click(await excludeBox())
    expect(screen.getByTestId('summary-ess').textContent).toContain('excluded')
    await settle(); await next()
    await screen.findByText('Review', { selector: 'h3' })
    expect(screen.getByTestId('review-ess').textContent).toContain('Employee Self Service excluded')
    await userEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect((await excludeBox()).checked).toBe(true)
    await settle(); await next()
    await screen.findByText('Review', { selector: 'h3' })
    expect((await create()).include_ess).toBe(false)
  })

  it('a non-HQ account never carries ESS or HQ-only state, even after an exclusion was ticked on HQ', async () => {
    listInitialAccessRoles.mockImplementation(async (orgId: string) => (orgId === 'dist' ? { ...catalogue(false), scopes: [] } : catalogue(true)))
    open({ organizations: [ORGS[0], dist] })
    await fillBasic(); await next()
    await userEvent.click(await excludeBox())
    await userEvent.click(screen.getByRole('button', { name: 'Distributor' }))
    await userEvent.click(screen.getByRole('combobox', { name: /Organization/ }))
    await userEvent.click(await screen.findByRole('option', { name: /Main Distributor/ }))
    expect(await screen.findByText(/the exclusion was cleared/)).toBeTruthy()
    await userEvent.click(await screen.findByRole('radio', { name: 'No Group Policy for now' }))
    await settle(); await next()
    await screen.findByText('Review', { selector: 'h3' })
    expect(screen.queryByTestId('review-ess')).toBeNull()
    const sent = await create()
    expect('include_ess' in sent).toBe(false)
    expect('ess_excluded' in sent).toBe(false)
  })
})
