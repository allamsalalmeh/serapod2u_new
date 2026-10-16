import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateInitialSelections, essGrantAllowed, validateInitialSelections, type PolicyRow } from '@/lib/identity/add-user-selections'
import {
  ELIGIBLE_ORG_TYPES, ORG_TYPE_CLASSES, filterPoliciesForRecipient, firstIncompatiblePermission, isHqOnlyPermission, isManufacturingOnly,
  partitionPoliciesForRecipient, permissionAllowedForOrgType, recipientEligibility, unavailablePoliciesNote,
} from './recipient-eligibility'

const MFG_KEYS = ['manufacturing.adjustment.administer', 'manufacturing.adjustment.manage', 'manufacturing.production.manage', 'manufacturing.scan.reverse']
const base = { status: 'active', source: 'template' }
const mfgPolicy = { ...base, roleKey: 'manufacturing-operator', orgTypes: ['MFG'], permissionKeys: ['manufacturing.production.manage'] }

describe('Manufacturer recipient eligibility', () => {
  it('accepts a published, Manufacturer-designated policy that holds only Manufacturing permissions', () => {
    expect(recipientEligibility(mfgPolicy, 'MFG')).toEqual({ ok: true })
    expect(recipientEligibility({ ...mfgPolicy, orgTypes: ['MFG'], accountTypes: ['partner'], permissionKeys: MFG_KEYS }, 'mfg')).toEqual({ ok: true })
    // An account type alone no longer designates a policy: the organization type must be listed (legacy rule accepted it).
    expect(recipientEligibility({ ...mfgPolicy, orgTypes: [], accountTypes: ['partner'], permissionKeys: MFG_KEYS }, 'MFG')).toMatchObject({ ok: false, code: 'AUDIENCE_NOT_MANUFACTURER' })
    expect(recipientEligibility({ ...mfgPolicy, orgTypes: [], accountTypes: ['partner'], permissionKeys: MFG_KEYS }, 'MFG', 'legacy')).toEqual({ ok: true })
  })
  it.each([
    ['Finance', ['finance.report.view']], ['CRM', ['customer.crm.view']], ['HR', ['hr.employee.view']], ['ESS', ['hr.self_service.view']],
    ['mixed', ['manufacturing.production.manage', 'finance.report.view']], ['QR', ['qr.batch.manage']], ['empty', []],
  ])('excludes a %s policy', (_n, permissionKeys) => {
    expect(recipientEligibility({ ...mfgPolicy, permissionKeys }, 'MFG')).toMatchObject({ ok: false })
  })
  it('excludes an unrestricted policy and an internal-only policy even when Manufacturing-only (never relabelled as partner)', () => {
    expect(recipientEligibility({ ...mfgPolicy, orgTypes: [], accountTypes: [] }, 'MFG')).toMatchObject({ ok: false, code: 'AUDIENCE_NOT_MANUFACTURER' })
    expect(recipientEligibility({ ...mfgPolicy, orgTypes: [], accountTypes: ['internal'] }, 'MFG')).toMatchObject({ ok: false, code: 'AUDIENCE_NOT_MANUFACTURER' })
    expect(recipientEligibility({ ...mfgPolicy, orgTypes: ['HQ'] }, 'MFG')).toMatchObject({ ok: false })
  })
  it('excludes broad Supply Chain Full Access, draft and retired policies', () => {
    expect(recipientEligibility({ ...mfgPolicy, roleKey: 'supply-chain-full-access', accountTypes: ['internal'], permissionKeys: [...MFG_KEYS, 'inventory.stock.view'] }, 'MFG').ok).toBe(false)
    expect(recipientEligibility({ ...mfgPolicy, status: 'draft' }, 'MFG')).toMatchObject({ ok: false, code: 'NOT_ASSIGNABLE' })
    expect(recipientEligibility({ ...mfgPolicy, status: 'retired' }, 'MFG')).toMatchObject({ ok: false, code: 'NOT_ASSIGNABLE' })
  })
  it('an unclassified policy is eligible nowhere (legacy rule: anywhere but Manufacturer) and ESS stays HQ-only', () => {
    const open = { ...base, roleKey: 'warehouse-operator', permissionKeys: ['warehouse.stock.view'] }
    for (const t of ['HQ', 'WH', 'DIST', 'SHOP', 'MFG', null]) expect(recipientEligibility(open, t).ok).toBe(false)
    for (const t of ['HQ', 'DIST', 'SHOP', null]) expect(recipientEligibility(open, t, 'legacy').ok).toBe(true)
    const ess = { ...base, roleKey: 'employee-self-service', orgTypes: ['HQ'], permissionKeys: ['hr.self_service.view'] }
    expect(recipientEligibility(ess, 'HQ').ok).toBe(true)
    expect(recipientEligibility(ess, 'MFG')).toMatchObject({ ok: false, code: 'ESS_HQ_ONLY' })
    expect(filterPoliciesForRecipient([open, mfgPolicy], 'MFG')).toEqual([mfgPolicy])
  })
  it('classifies Manufacturing-only from the live catalogue keys', () => {
    expect(isManufacturingOnly(MFG_KEYS)).toBe(true)
    expect(isManufacturingOnly([...MFG_KEYS, 'qr.batch.manage'])).toBe(false)
  })
})

const row = (id: string, extra: Partial<PolicyRow> = {}): PolicyRow => ({ id, role_key: 'x', status: 'active', source: 'template', applicable_account_types: [], applicable_org_types: [], permission_keys: [], ...extra })
const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b1', S = '00000000-0000-4000-8000-0000000000c1'

describe('submission and direct API cannot bypass recipient eligibility', () => {
  const roles = new Map<string, PolicyRow>([
    [A, row(A, { role_key: 'manufacturing-operator', applicable_org_types: ['MFG'], permission_keys: ['manufacturing.production.manage'] })],
    [B, row(B, { role_key: 'finance-clerk', applicable_org_types: ['HQ'], permission_keys: ['finance.report.view'] })],
  ])
  it('accepts several eligible policies with their own scopes for a Manufacturer', () => {
    const r = evaluateInitialSelections({ organizationTypeCode: 'MFG', roles, items: [{ role_id: A, scope_id: S }] })
    expect(r).toMatchObject({ ok: true })
  })
  it('rejects an ineligible policy for a Manufacturer but allows it for HQ', () => {
    expect(evaluateInitialSelections({ organizationTypeCode: 'MFG', roles, items: [{ role_id: A, scope_id: S }, { role_id: B, scope_id: S }] })).toMatchObject({ ok: false, code: 'RECIPIENT_NOT_ELIGIBLE' })
    expect(evaluateInitialSelections({ organizationTypeCode: 'HQ', roles, items: [{ role_id: B, scope_id: S }] })).toMatchObject({ ok: true })
  })
  it('uses the stored organization type, not a client value, and the direct S&A grant path agrees', async () => {
    const withKeys = (id: string) => ({ ...roles.get(id), permissions: (roles.get(id)!.permission_keys || []).map(k => ({ permission: { permission_key: k } })) })
    const admin: any = { from: (t: string) => ({ select: () => ({
      eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: t === 'organizations' ? { org_type_code: 'MFG' } : withKeys(id), error: null }) }),
      in: async (_c: string, ids: string[]) => ({ data: ids.map(withKeys), error: null }) }) }) }
    expect(await essGrantAllowed(admin, B, 'org')).toMatchObject({ ok: false, code: 'RECIPIENT_NOT_ELIGIBLE' })
    expect(await essGrantAllowed(admin, A, 'org')).toEqual({ ok: true })
    expect(await validateInitialSelections(admin, 'org', [{ role_id: B, scope_id: S }])).toMatchObject({ ok: false, code: 'RECIPIENT_NOT_ELIGIBLE' })
  })
  it('a failed catalogue read blocks submission instead of passing unchecked', async () => {
    const admin: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_type_code: 'MFG' }, error: null }) }), in: async () => ({ data: null, error: { code: 'XX000' } }) }) }) }
    expect(await validateInitialSelections(admin, 'org', [{ role_id: A, scope_id: S }])).toMatchObject({ ok: false, code: 'CATALOGUE_UNAVAILABLE' })
  })
})

describe('organization-type eligibility (mirror of sa_policy_org_type_ineligibility)', () => {
  const policy = (orgTypes: string[], permissionKeys: string[], extra: object = {}) => ({ ...base, roleKey: 'p', orgTypes, permissionKeys, ...extra })
  it('1-4: each organization type receives only the policies that list it', () => {
    const hq = policy(['HQ'], ['finance.ledger.view'])
    const ordering = policy(['HQ', 'DIST', 'SHOP'], ['supply_chain.order.create'])
    const warehouse = policy(['HQ', 'WH'], ['inventory.stock_count.view'])
    const mfg = policy(['MFG'], ['manufacturing.production.manage'])
    const all = [hq, ordering, warehouse, mfg]
    expect(filterPoliciesForRecipient(all, 'HQ')).toEqual([hq, ordering, warehouse])
    expect(filterPoliciesForRecipient(all, 'WH')).toEqual([warehouse])            // WH is never implied by HQ
    expect(filterPoliciesForRecipient(all, 'MFG')).toEqual([mfg])
    expect(filterPoliciesForRecipient(all, 'DIST')).toEqual([ordering])
    expect(filterPoliciesForRecipient(all, 'shop')).toEqual([ordering])
  })
  it('6: a partner-only policy is never eligible for an HQ membership', () => {
    expect(recipientEligibility(policy(['MFG'], ['manufacturing.production.manage']), 'HQ')).toMatchObject({ ok: false, code: 'ORG_TYPE_NOT_ELIGIBLE' })
    expect(recipientEligibility(policy(['DIST', 'SHOP'], ['supply_chain.order.create']), 'HQ')).toMatchObject({ ok: false, code: 'ORG_TYPE_NOT_ELIGIBLE' })
  })
  it('consumers, independent and unknown organization types receive nothing', () => {
    const everywhere = policy([...ELIGIBLE_ORG_TYPES], ['supply_chain.order.create'])
    for (const t of ['END_USER', 'INDEP', 'GALAXY', '', null]) expect(recipientEligibility(everywhere, t)).toMatchObject({ ok: false, code: 'ORG_TYPE_NOT_ASSIGNABLE' })
  })
  it('7: custom policies follow the same rule; account types narrow further', () => {
    const custom = policy(['HQ', 'SHOP'], ['supply_chain.order.create'], { source: 'new' })
    expect(recipientEligibility(custom, 'SHOP').ok).toBe(true)
    expect(recipientEligibility({ ...custom, accountTypes: ['internal'] }, 'SHOP')).toMatchObject({ ok: false, code: 'ORG_TYPE_NOT_ELIGIBLE' })
    expect(recipientEligibility({ ...custom, orgTypes: [] }, 'HQ')).toMatchObject({ ok: false, code: 'POLICY_UNCLASSIFIED' })
  })
  it('permissions must suit the organization type even when it is listed (no HQ-only permission reaches a partner)', () => {
    expect(recipientEligibility(policy(['HQ', 'SHOP'], ['finance.ledger.view']), 'SHOP')).toMatchObject({ ok: false, code: 'PERMISSION_INCOMPATIBLE' })
    expect(recipientEligibility(policy(['HQ', 'DIST'], ['platform.organization.manage']), 'DIST')).toMatchObject({ ok: false, code: 'PERMISSION_INCOMPATIBLE' })
    expect(recipientEligibility(policy(['HQ', 'MFG'], ['qr.batch.manage']), 'MFG')).toMatchObject({ ok: false, code: 'NOT_MANUFACTURING_ONLY' })
    expect(recipientEligibility(policy(['HQ', 'MFG'], ['qr.batch.manage']), 'HQ').ok).toBe(true)
    expect(firstIncompatiblePermission(['supply_chain.order.create', 'hr.employee.view'], 'SHOP')).toBe('hr.employee.view')
  })
  it('the HQ-only and per-type permission rules', () => {
    for (const k of ['hr.employee.view', 'security.role.assign', 'platform.user.manage', 'platform.settings.manage', 'finance.ledger.view', 'finance.data.reset']) expect(isHqOnlyPermission(k)).toBe(true)
    for (const k of ['supply_chain.order.create', 'inventory.stock_count.view', 'customer.crm.view', 'manufacturing.production.manage']) expect(isHqOnlyPermission(k)).toBe(false)
    expect(permissionAllowedForOrgType('finance.ledger.view', 'WH')).toBe(true)
    expect(permissionAllowedForOrgType('inventory.stock_count.view', 'MFG')).toBe(false)
    expect(permissionAllowedForOrgType('supply_chain.order.create', 'END_USER')).toBe(false)
  })
  it('explains what is not offered', () => {
    const { eligible, ineligible } = partitionPoliciesForRecipient([policy(['HQ'], []), policy(['SHOP'], [])], 'SHOP')
    expect(eligible).toHaveLength(1)
    expect(ineligible[0]).toMatchObject({ code: 'ORG_TYPE_NOT_ELIGIBLE' })
    expect(unavailablePoliciesNote(1, 'SHOP')).toMatch(/1 Group Policy is not available for Shop accounts/)
    expect(unavailablePoliciesNote(0, 'SHOP')).toBeNull()
  })
})

describe('the application mirror matches the eligibility migration', () => {
  const sql = readFileSync(resolve(__dirname, '../../../../supabase/migrations/20261030100000_sa_policy_org_type_eligibility.sql'), 'utf8')
  it('organization type classes', () => {
    const rows = [...sql.matchAll(/\('([A-Z_]+)',\s+'(internal|partner|not_assignable)'/g)].map(m => [m[1], m[2]])
    expect(Object.fromEntries(rows.filter(([, c]) => c !== 'not_assignable'))).toEqual(ORG_TYPE_CLASSES)
    expect(rows.filter(([, c]) => c === 'not_assignable').map(([t]) => t)).toEqual(['END_USER', 'INDEP'])
  })
  it('the HQ-only permission rule', () => {
    expect(sql).toMatch(/sa_permission_forbidden_for_partner\(p_key\) or p_key like 'finance\.%' or p_key like 'platform\.%'/)
    expect(sql).toMatch(/c\.org_type_code <> 'MFG' or p_key like 'manufacturing\.%'/)
  })
  it('standard classification is conservative: no new partner type for any standard policy', () => {
    const lists = [...sql.matchAll(/\('([a-z-]+)', array\[([^\]]*)\]\)/g)].map(m => [m[1], m[2].replace(/'/g, '').split(', ')] as const)
    expect(lists.length).toBeGreaterThan(40)
    for (const [key, types] of lists) expect(types.every(t => t === 'HQ' || t === 'WH'), key).toBe(true)
    expect(Object.fromEntries(lists)['warehouse-manager']).toEqual(['HQ', 'WH'])
  })
})
