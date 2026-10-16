// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 20000 })

const stable = vi.hoisted(() => {
  const chain: any = { select: () => chain, order: () => chain, eq: () => chain, in: () => chain, ilike: () => chain, limit: () => chain, then: (r: any) => r({ data: [], error: null }) }
  return { value: { supabase: { from: () => chain, rpc: async () => ({ data: false }) } } }
})
vi.mock('@/lib/hooks/useSupabaseAuth', () => ({ useSupabaseAuth: () => stable.value }))
const listInitialAccessRoles = vi.fn()
vi.mock('@/lib/actions', () => ({ listInitialAccessRoles: (...a: any[]) => listInitialAccessRoles(...a) }))
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

import UserDialogNew from './UserDialogNew'

const PROFILES = [
  { id: 'rcv', name: 'Receiver', kind: 'custom' as const, scopeTypes: ['organization'] },
  { id: 'ship', name: 'Shipper', kind: 'custom' as const, scopeTypes: ['organization'] },
  { id: 'aud', name: 'Auditor', kind: 'custom' as const, scopeTypes: ['organization'] },
]
const SCOPES = [{ id: 's-o', organization_id: 'hq', scope_type: 'organization', display_name: 'Serapod HQ', kind: 'organization', label: 'Serapod HQ — HQ and all its warehouses' }]
const catalogue = (over: any = {}) => ({ success: true, roles: PROFILES, profiles: PROFILES, deferredProfiles: [], scopes: SCOPES, orgNames: { hq: 'Serapod HQ' },
  organization: { name: 'Serapod HQ', typeCode: 'HQ' }, canAssign: true, legacyReadOnly: true, essAllowed: true, ...over })

const ORGS = [
  { id: 'hq', org_name: 'Serapod HQ', org_code: 'HQ01', org_type_code: 'HQ' },
  { id: 'hq2', org_name: 'Second HQ', org_code: 'HQ02', org_type_code: 'HQ' },
  { id: 'dist', org_name: 'Main Distributor', org_code: 'D01', org_type_code: 'DIST' },
  { id: 'shop', org_name: 'Corner Shop', org_code: 'S01', org_type_code: 'SHOP' },
] as any
const ROLES = [{ role_code: 'HQ_ADMIN', role_name: 'HQ Admin', role_level: 10 }, { role_code: 'MGR', role_name: 'Manager', role_level: 30 }, { role_code: 'USR', role_name: 'User', role_level: 40 }] as any

const assignment = (id: string, role: any, over: any = {}) => ({
  id, status: 'active', source: 'manual', effective_from: null, effective_until: null, assignment_reason: null, role,
  scopes: [{ scope: { id: 's-o', scope_type: 'organization', scope_value: 'hq', display_name: 'Serapod HQ' } }], ...over,
})
const person = (assignments: any[]) => ({ id: 'u-1', membership: [{ id: 'm1', organization_id: 'hq', status: 'active', is_primary: true, source: 'derived', grantable: true, organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments }] })
const GRANTED = assignment('a-rcv', { id: 'rcv', role_key: 'receiver', name: 'Receiver', source: 'new' })
const GRANTED_TEMP = assignment('a-ship', { id: 'ship', role_key: 'shipper', name: 'Shipper', source: 'new' }, { effective_until: new Date(Date.now() + 5 * 864e5).toISOString() })
const ESS = assignment('a-ess', { id: 'ess', role_key: 'employee-self-service', name: 'Employee Self Service', source: 'template' }, { source: 'derived' })
const LEGACY = assignment('a-leg', { id: 'leg', role_key: 'legacy-hq', name: 'legacy-HQ_ADMIN', source: 'legacy' }, { source: 'backfill' })

const USER = {
  id: 'u-1', email: 'ali@example.com', full_name: 'Ali Hassan', call_name: 'Ali', phone: '+60123456789', role_code: 'HQ_ADMIN', organization_id: 'hq', is_active: true,
  can_be_reference: true, bank_id: 'bank-1', bank_account_number: '1234567890', bank_account_holder_name: 'ALI HASSAN', department_id: '', employment_status: 'active',
} as any

let snapshot: any
let capabilities: Record<string, { allowed: boolean; enforced: boolean }>
let assignmentResponses: Array<{ ok: boolean; error?: string }>
const fetchMock = vi.fn()
beforeAll(() => { Element.prototype.hasPointerCapture = () => false; Element.prototype.scrollIntoView = () => undefined })
beforeEach(() => {
  snapshot = person([GRANTED, GRANTED_TEMP, ESS, LEGACY])
  capabilities = { 'platform.identity_access.manage': { allowed: true, enforced: true }, 'platform.user.password_reset': { allowed: true, enforced: true } }
  assignmentResponses = []
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string, init?: any) => {
    const u = String(url)
    if (u.includes('/me/capabilities')) {
      const key = new URL(u, 'http://x').searchParams.get('permissions') as string
      return { ok: true, json: async () => ({ capabilities: { [key]: capabilities[key] ?? { allowed: false, enforced: true } } }) }
    }
    if (u.includes('/api/security-access/people/')) return { ok: true, json: async () => ({ ok: true, person: snapshot }) }
    if (u === '/api/security-access/assignments') {
      const next = assignmentResponses.shift() ?? { ok: true }
      return next.ok ? { ok: true, json: async () => ({ ok: true }) } : { ok: false, status: 409, json: async () => ({ error: next.error }) }
    }
    if (u === '/api/users/reset-password') return { ok: true, json: async () => ({ success: true }) }
    return { ok: true, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
  listInitialAccessRoles.mockReset()
  listInitialAccessRoles.mockResolvedValue(catalogue())
  toast.mockReset()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const onSave = vi.fn()
function open(extra: any = {}) {
  onSave.mockReset()
  return render(<UserDialogNew user={USER} roles={ROLES} organizations={ORGS} open currentUserRoleLevel={10} onOpenChange={() => undefined} onSave={onSave} {...extra} />)
}
const assignmentCalls = () => fetchMock.mock.calls.filter(([u]) => u === '/api/security-access/assignments').map(([, init]) => JSON.parse(init.body))
const next = () => userEvent.click(screen.getByRole('button', { name: /Next/ }))
async function toAccess() { await next(); await screen.findByText('Group Policies', { selector: 'h4' }); await screen.findByRole('region', { name: 'Current access' }) }
async function toReview() { await toAccess(); await next(); await screen.findByRole('heading', { name: 'Review' }) }
const save = () => userEvent.click(screen.getByRole('button', { name: /Save User/ }))
async function tickReceiverOffOnly() { await userEvent.click(screen.getByRole('checkbox', { name: 'Receiver' })) }
async function tickReceiverOff() {
  await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
  const module = screen.getAllByRole('button', { name: /, expand$/ })[0]
  await userEvent.click(module)
  await userEvent.click(screen.getByRole('checkbox', { name: 'Receiver' }))
}

describe('Edit User — modern three-step layout', () => {
  it('uses Basic details → Organization & access → Review, with no legacy cards or banking/business steps', async () => {
    open()
    const steps = screen.getAllByRole('button').filter(b => /Basic details|Organization & access|Review|Banking|Role & Access|Business/.test(b.textContent || ''))
    expect(steps.map(s => s.textContent?.replace(/^\d/, ''))).toEqual(['Basic details', 'Organization & access', 'Review'])
    await toAccess()
    expect(screen.queryByText(/Legacy level \(compatibility\)/)).toBeNull()
    expect(screen.queryByText(/Business access for an existing person is managed/)).toBeNull()
    expect(screen.queryByText('Level 10')).toBeNull()
  })

  it('loads existing values (including banking, compactly) and an unchanged save sends them back with no access change', async () => {
    open()
    expect((screen.getByLabelText(/Full Name/) as HTMLInputElement).value).toBe('Ali Hassan')
    expect((screen.getByLabelText(/Phone Number/) as HTMLInputElement).value).toBe('+60123456789')
    expect((screen.getByLabelText(/^Email/) as HTMLInputElement).disabled).toBe(true)
    await userEvent.click(screen.getByText(/Banking details/))
    expect((screen.getByLabelText('Account Number') as HTMLInputElement).value).toBe('1234567890')
    await toReview()
    expect(screen.getByText('No profile changes.')).toBeTruthy()
    expect(screen.getByText('No Group Policy changes.')).toBeTruthy()
    await save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [data, , access] = onSave.mock.calls[0]
    expect(data).toMatchObject({ full_name: 'Ali Hassan', phone: '+60123456789', organization_id: 'hq', role_code: 'HQ_ADMIN', is_active: true, can_be_reference: true, bank_id: 'bank-1', bank_account_number: '1234567890', bank_account_holder_name: 'ALI HASSAN' })
    expect(data).not.toHaveProperty('password')
    expect(access).toBeUndefined()
    expect(assignmentCalls()).toEqual([])
  })

  it('does not show or send banking details the administrator was not given', async () => {
    const { bank_id, bank_account_number, bank_account_holder_name, ...withoutBanking } = USER
    open({ user: withoutBanking })
    expect(screen.queryByText(/Banking details/)).toBeNull()
    await toReview()
    await save()
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const [data] = onSave.mock.calls[0]
    expect(data).not.toHaveProperty('bank_id'); expect(data).not.toHaveProperty('bank_account_number'); expect(data).not.toHaveProperty('bank_account_holder_name')
  })

  it('masks banking in the review and keeps Active / Deactivate in the form', async () => {
    open()
    await userEvent.click(screen.getByText(/Banking details/))
    await userEvent.clear(screen.getByLabelText('Account Number'))
    await userEvent.type(screen.getByLabelText('Account Number'), '9988776655')
    await next()
    await screen.findByRole('region', { name: 'Current access' })
    const active = screen.getByRole('switch', { name: 'Active' })
    expect(active.getAttribute('aria-checked')).toBe('true')
    await userEvent.click(active)
    await next()
    const profile = await screen.findByRole('list', { hidden: false, name: '' }).catch(() => null)
    expect(profile).toBeNull()
    const dl = screen.getByLabelText('Profile changes')
    expect(dl.textContent).toContain('••••7890')
    expect(dl.textContent).toContain('••••6655')
    expect(dl.textContent).not.toContain('1234567890')
    expect(dl.textContent).toContain('Status')
    await save()
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).toMatchObject({ is_active: false, bank_account_number: '9988776655' })
  })
})

describe('Edit User — Group Policy access', () => {
  it('shows each kind of current access accurately: granted (with scope and end date), managed ESS, legacy-migration', async () => {
    open()
    await toAccess()
    const region = screen.getByRole('region', { name: 'Current access' })
    expect(within(region).getByText('Receiver').closest('li')!.textContent).toMatch(/Granted/)
    expect(within(region).getByText('Receiver').closest('li')!.textContent).toMatch(/Serapod HQ/)
    expect(within(region).getByText('Shipper').closest('li')!.textContent).toMatch(/Until/)
    const ess = within(region).getByText('Employee Self Service').closest('li')!
    expect(ess.textContent).toMatch(/Managed/); expect(ess.textContent).toMatch(/not removed by this form/)
    expect(within(region).getByText('legacy-HQ_ADMIN').closest('li')!.textContent).toMatch(/Legacy migration/)
  })

  it('removing a granted policy is the only revocation: managed ESS, legacy and temporary access are untouched; reason required; nothing runs before Save', async () => {
    open()
    await toAccess()
    await tickReceiverOff()
    expect(assignmentCalls()).toEqual([])
    await next()
    const list = await screen.findByRole('list', { name: 'Group Policy changes' })
    expect(list.textContent).toMatch(/Remove\s+Receiver/)
    expect(list.textContent).not.toMatch(/Shipper|Employee Self Service|legacy/)
    expect(screen.getByText(/other grants are kept exactly as is/)).toBeTruthy()
    await save()                                      // no reason yet
    expect(await screen.findByText(/Enter a reason of at least 5 characters/)).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
    await userEvent.type(screen.getByLabelText(/Reason for the Group Policy changes/), 'Role change')
    await save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const access = onSave.mock.calls[0][2]
    expect(assignmentCalls()).toEqual([])              // applied by the host after the profile, not by the form itself
    const outcome = await access.apply()
    expect(outcome.allApplied).toBe(true)
    expect(assignmentCalls()).toEqual([{ action: 'revoke', assignmentId: 'a-rcv', reason: 'Role change' }])
  })

  it('adds a policy with its explicit scope, and reports a partial outcome honestly (never complete success)', async () => {
    open()
    await toAccess()
    await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
    await userEvent.click(screen.getAllByRole('button', { name: /, expand$/ })[0])
    await userEvent.click(screen.getByRole('checkbox', { name: 'Auditor' }))
    await tickReceiverOffOnly()
    await next()
    const list = await screen.findByRole('list', { name: 'Group Policy changes' })
    expect(list.textContent).toMatch(/Add\s+Auditor — scope: Serapod HQ/)
    expect(list.textContent).toMatch(/Remove\s+Receiver/)
    await userEvent.type(screen.getByLabelText(/Reason for the Group Policy changes/), 'Cleanup')
    await save()
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    assignmentResponses = [{ ok: true }, { ok: false, error: 'This conflicts with a segregation-of-duties rule.' }]
    const outcome = await onSave.mock.calls[0][2].apply()
    expect(outcome.allApplied).toBe(false)
    expect(outcome.applied).toBe(1)
    expect(outcome.message).toMatch(/1 of 2/)
    expect(outcome.message).toMatch(/could not add Auditor/)
    expect(outcome.message).toMatch(/segregation/)
    expect(assignmentCalls().map(c => c.action)).toEqual(['revoke', 'grant'])
    expect(assignmentCalls()[1]).toMatchObject({ roleId: 'aud', organizationId: 'hq', scopeIds: ['s-o'], effectiveUntil: null, reason: 'Cleanup' })
  })

  it('Cancel never persists a draft: closing the form makes no assignment request', async () => {
    const onOpenChange = vi.fn()
    open({ onOpenChange })
    await toAccess()
    await tickReceiverOff()
    await userEvent.click(screen.getAllByRole('button').find(b => b.querySelector('svg.lucide-x') && !b.getAttribute('aria-label'))!)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSave).not.toHaveBeenCalled()
    expect(assignmentCalls()).toEqual([])
  })

  it('without assignment authority the current access is shown read-only and no policy picker is offered', async () => {
    listInitialAccessRoles.mockResolvedValue(catalogue({ canAssign: false, profiles: [], denial: { reason: 'You cannot assign Group Policies in this organization.', cannotCreate: false } }))
    open()
    await toAccess()
    expect(screen.getByText(/You cannot assign Group Policies in this organization/)).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /^Custom/ })).toBeNull()
    await next()
    expect(await screen.findByText(/no Group Policy changes|No Group Policy changes/i)).toBeTruthy()
  })

  it('a failed authority check is a retryable error, not a denial, and changes nothing', async () => {
    listInitialAccessRoles.mockResolvedValue({ success: false, failed: true })
    open()
    await toAccess()
    expect(screen.getByText(/authority to change Group Policies here could not be checked/)).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /^Custom/ })).toBeNull()
  })

  it('an administrator who cannot view Group Policies sees a plain explanation and the profile is still editable', async () => {
    fetchMock.mockImplementation(async (url: string) => String(url).includes('/api/security-access/people/')
      ? { ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) }
      : { ok: true, json: async () => ({ capabilities: {} }) })
    open()
    await next()
    expect(await screen.findByText(/do not have access to view Group Policies/)).toBeTruthy()
    await next()
    await save()
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][2]).toBeUndefined()
  })
})

describe('Edit User — organization change', () => {
  it('pauses policy editing, explains what moving ends, and requires an explicit acknowledgement; grants are never edited silently', async () => {
    open()
    await toAccess()
    const select = screen.getByRole('combobox', { name: /Organization/ })
    await userEvent.click(select)
    await userEvent.click(await screen.findByRole('option', { name: /Second HQ/ }))
    expect(screen.getByText(/Group Policy changes are paused/)).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /^Custom/ })).toBeNull()
    await next()
    const warning = await screen.findByRole('alert')
    expect(warning.textContent).toMatch(/Moving this person to Second HQ/)
    expect(warning.textContent).toMatch(/Memberships created manually are kept/)
    expect(warning.textContent).toMatch(/Receiver/)
    await save()
    expect(await screen.findByText(/Confirm that you understand/)).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('checkbox', { name: /I understand/ }))
    await save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0]).toMatchObject({ organization_id: 'hq2', role_code: 'HQ_ADMIN' })
    expect(onSave.mock.calls[0][2]).toBeUndefined()
    expect(assignmentCalls()).toEqual([])
  })
})

describe('Edit User — organization-type fields', () => {
  it('HQ: Reference and Employment details; Distributor: neither, with stored values preserved', async () => {
    open()
    await toAccess()
    expect(screen.getByRole('checkbox', { name: 'Reference' })).toBeTruthy()
    expect(screen.getByText(/Employment details/)).toBeTruthy()
    cleanup()
    open({ user: { ...USER, organization_id: 'dist', can_be_reference: true } })
    await next()
    await screen.findByText('Group Policies', { selector: 'h4' })
    expect(screen.queryByRole('checkbox', { name: 'Reference' })).toBeNull()
    expect(screen.queryByText(/Employment details/)).toBeNull()
    await next(); await save()
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('can_be_reference')
  })

  it('Shop: shop details are a compact optional section', async () => {
    open({ user: { ...USER, organization_id: 'shop', shop_name: 'Corner', can_be_reference: false } })
    await next()
    await screen.findByText('Group Policies', { selector: 'h4' })
    expect(screen.getByText(/Shop details/)).toBeTruthy()
  })
})

describe('Edit User — Account security and the legacy value', () => {
  it('keeps Reset password in a compact section of Basic details; resetting does not save the form or touch pending edits', async () => {
    open()
    expect(screen.getByRole('heading', { name: 'Basic details' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Account security' })).toBeTruthy()
    await userEvent.click(await screen.findByRole('button', { name: /^Reset password/ }))
    expect(screen.getByTestId('password-reset-modal')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('New Password'), 'brand-new-pass')
    await userEvent.type(screen.getByLabelText('Confirm New Password'), 'brand-new-pass')
    await userEvent.click(screen.getAllByRole('button', { name: /^Reset password/ }).at(-1)!)
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/users/reset-password')).toBe(true))
    expect(onSave).not.toHaveBeenCalled()
    expect(assignmentCalls()).toEqual([])
    const resetCall = fetchMock.mock.calls.find(([u]) => u === '/api/users/reset-password')!
    expect(JSON.parse(resetCall[1].body)).toEqual({ user_id: 'u-1', new_password: 'brand-new-pass' })
    await waitFor(() => expect(screen.queryByTestId('password-reset-modal')).toBeNull())
    // The form can still be saved afterwards, and its payload never carries a password.
    await toReview(); await save()
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(JSON.stringify(onSave.mock.calls[0])).not.toContain('brand-new-pass')
  })

  it('shows Reset password only in Basic details, not under Organization & access', async () => {
    open()
    expect(await screen.findByRole('button', { name: /^Reset password/ })).toBeTruthy()
    await toAccess()
    expect(screen.queryByRole('heading', { name: 'Account security' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Reset password/ })).toBeNull()
  })

  it('hides Reset password for a profile editor without reset authority', async () => {
    capabilities['platform.user.password_reset'] = { allowed: false, enforced: true }
    open()
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('platform.user.password_reset'))).toBe(true))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Account security' })).toBeNull())
    expect(screen.queryByRole('button', { name: /^Reset password/ })).toBeNull()
  })

  it('preserves the stored legacy value on an ordinary save; the Advanced control exists only with access-administration authority', async () => {
    open()
    await toAccess()
    expect(await screen.findByText(/Advanced/)).toBeTruthy()
    await next(); await save()
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].role_code).toBe('HQ_ADMIN')
    cleanup()
    capabilities['platform.identity_access.manage'] = { allowed: false, enforced: true }
    open()
    await toAccess()
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).includes('platform.identity_access.manage'))).toBe(true))
    expect(screen.queryByText(/legacy compatibility\)/)).toBeNull()
    await next(); await save()
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].role_code).toBe('HQ_ADMIN')
  })

  it('a changed legacy level is shown in the review and is the only way the level changes', async () => {
    open()
    await toAccess()
    await userEvent.click(await screen.findByText(/Advanced/))
    await userEvent.click(screen.getByRole('combobox', { name: /Change legacy level/ }))
    await userEvent.click(await screen.findByRole('option', { name: /Manager/ }))
    await next()
    expect(screen.getByLabelText('Profile changes').textContent).toMatch(/Legacy compatibility level[\s\S]*Manager/)
  })
})

describe('Edit User — legacy GUEST uses real Security & Access membership data', () => {
  const GUEST_ROLES = [...ROLES, { role_code: 'GUEST', role_name: 'Guest', role_level: 50 }]
  // supply@dev.com shape: legacy GUEST, account organization = HQ, an Active Primary HQ membership (derived, employee).
  const SUPPLY = { ...USER, id: 'u-supply', email: 'supply@example.com', full_name: 'Supply Person', call_name: 'Supply', role_code: 'GUEST', organization_id: 'hq', bank_id: '', bank_account_number: '', bank_account_holder_name: '' }
  const openGuest = (user: any = SUPPLY) => { onSave.mockReset(); return render(<UserDialogNew user={user} roles={GUEST_ROLES} organizations={ORGS} open currentUserRoleLevel={10} onOpenChange={() => undefined} onSave={onSave} />) }

  it('a GUEST with an active primary HQ membership is not treated as an independent guest', async () => {
    snapshot = { id: 'u-supply', membership: [{ id: 'm-hq', organization_id: 'hq', status: 'active', is_primary: true, source: 'derived', grantable: true, organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments: [ESS] }] }
    openGuest()
    await toAccess()
    expect(screen.queryByText(/Independent guests hold no organization membership/)).toBeNull()
    expect(screen.queryByText(/Guest users can be independent/)).toBeNull()
    // Group Policies for the HQ membership are shown (the membership snapshot was loaded for this person).
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/security-access/people/u-supply'))).toBe(true)
    expect(screen.getByRole('region', { name: 'Current access' })).toBeTruthy()
  })

  it('an ordinary profile save keeps the organization, membership and assignments unchanged', async () => {
    openGuest()
    await userEvent.clear(screen.getByLabelText(/Full Name/))
    await userEvent.type(screen.getByLabelText(/Full Name/), 'Supply Person Renamed')
    await toReview()
    await save()
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const [data, , access] = onSave.mock.calls[0]
    expect(data).toMatchObject({ full_name: 'Supply Person Renamed', organization_id: 'hq', role_code: 'GUEST' })
    expect(access).toBeUndefined()
    expect(assignmentCalls()).toEqual([])
  })

  it('a GUEST with no organization and no active membership is still an independent guest', async () => {
    snapshot = { id: 'u-indep', membership: [] }
    openGuest({ ...SUPPLY, id: 'u-indep', organization_id: null })
    await toAccess().catch(() => undefined)
    expect(await screen.findByText(/Independent guests hold no organization membership/)).toBeTruthy()
  })

  it('a GUEST without an account organization but with an active membership shows that membership, not "independent"', async () => {
    snapshot = { id: 'u-mem', membership: [{ id: 'm-d', organization_id: 'dist', status: 'active', is_primary: true, source: 'manual', grantable: false, organization: { org_name: 'Main Distributor', org_type_code: 'DIST' }, assignments: [] }] }
    openGuest({ ...SUPPLY, id: 'u-mem', organization_id: null })
    await next()
    expect(await screen.findByText(/Active membership: Main Distributor \(primary\)/)).toBeTruthy()
    expect(screen.queryByText(/Independent guests hold no organization membership/)).toBeNull()
  })
})

describe('Edit User — identity stays visible and Reset password states', () => {
  it('keeps the edited user name and email visible on every step', async () => {
    open()
    const identity = () => screen.getByTestId('edit-user-identity').textContent
    expect(identity()).toContain('Ali')
    expect(identity()).toContain('ali@example.com')
    await toAccess()
    expect(identity()).toContain('ali@example.com')
    await next(); await screen.findByRole('heading', { name: 'Review' })
    expect(identity()).toContain('ali@example.com')
  })

  it('a failed permission check is shown with Retry (not hidden); Retry then shows the action', async () => {
    let fail = true
    const base = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (fail && String(url).includes('permissions=platform.user.password_reset')) return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }
      return base(url, init)
    })
    open()
    const section = screen.getByRole('heading', { name: 'Account security' }).closest('section')!
    expect((await within(section).findByRole('alert')).textContent).toMatch(/Couldn’t check whether you can reset this password/)
    expect(within(section).queryByRole('button', { name: /^Reset password/ })).toBeNull()
    fail = false
    await userEvent.click(within(section).getByRole('button', { name: /Retry/ }))
    expect(await within(section).findByRole('button', { name: /^Reset password/ })).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Reset password is offered for a GUEST with an HQ membership when the administrator is authorized, in the target organization', async () => {
    const SUPPLY = { ...USER, id: 'u-supply', email: 'supply@example.com', full_name: 'Supply Person', role_code: 'GUEST', organization_id: 'hq' }
    onSave.mockReset()
    render(<UserDialogNew user={SUPPLY} roles={[...ROLES, { role_code: 'GUEST', role_name: 'Guest', role_level: 50 }]} organizations={ORGS} open currentUserRoleLevel={10} onOpenChange={() => undefined} onSave={onSave} />)
    expect(await screen.findByRole('button', { name: /^Reset password/ })).toBeTruthy()
    const url = fetchMock.mock.calls.map(([u]) => String(u)).find(u => u.includes('permissions=platform.user.password_reset'))!
    expect(url).toContain('organizationId=hq')
  })
})
