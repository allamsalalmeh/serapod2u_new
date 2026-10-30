import { describe, expect, it } from 'vitest'
import { denialDiagnostics, policyCandidates, policyOptions } from './denial-diagnostics'
const permissions = [
  { permission_key: 'supply_chain.order.view', audit_sensitivity: 'ordinary' },
  { permission_key: 'supply_chain.order.approve', audit_sensitivity: 'security_sensitive' },
]
const policy = (id: string, keys: string[], extra = {}) => ({ id, name: id, role_key: id, status: 'active', source: 'new', applicable_org_types: ['HQ'], applicable_account_types: ['internal'], permissions: keys.map(permission_key => ({ permission: { permission_key } })), ...extra })
describe('least privilege review candidates', () => {
  it('prefers a narrow ordinary policy and explicitly lists extra sensitive privileges', () => {
    const candidates = policyCandidates([policy('full', permissions.map(p => p.permission_key)), policy('viewer', ['supply_chain.order.view'])], permissions, 'supply_chain.order.view', 'HQ')
    expect(candidates.map(c => c.id)).toEqual(['viewer', 'full'])
    expect(candidates[1].sensitivePermissions).toEqual(['supply_chain.order.approve'])
    expect(candidates.every(c => c.requiresExplicitReview)).toBe(true)
  })
  it('omits module Full Access when a narrower eligible policy exists', () => {
    const candidates = policyCandidates([policy('supply-chain-full-access', permissions.map(p => p.permission_key)), policy('viewer', ['supply_chain.order.view'])], permissions, 'supply_chain.order.view', 'HQ')
    expect(candidates.map(c => c.roleKey)).toEqual(['viewer'])
  })
  it('excludes policies containing disabled emergency access', () => {
    const catalogue = [...permissions, { permission_key: 'security.emergency_access.grant', audit_sensitivity: 'security_sensitive' }]
    expect(policyCandidates([policy('emergency-bundle', catalogue.map(p => p.permission_key))], catalogue, 'supply_chain.order.view', 'HQ')).toEqual([])
  })
  it('excludes legacy, inactive, unknown and organization-ineligible policies', () => {
    const roles = [policy('legacy', ['supply_chain.order.view'], { source: 'legacy' }), policy('inactive', ['supply_chain.order.view'], { status: 'deprecated' }), policy('other', ['supply_chain.order.view'], { applicable_org_types: ['SHOP'] })]
    expect(policyCandidates(roles, permissions, 'supply_chain.order.view', 'HQ')).toEqual([])
    expect(policyCandidates([policy('unknown', ['unknown.key.action'])], [], 'unknown.key.action', 'HQ')).toEqual([])
  })
})


describe('installed readiness schema', () => {
  it('does not treat a browser-reported event as an authoritative denial', async () => {
    expect(await denialDiagnostics({}, { source: 'browser', http_status: 403, actor_id: 'target', organization_id: 'org', details: { event: 'security.authorization.denied', permission: 'supply_chain.order.view', reason: 'MISSING_PERMISSION' } })).toBeNull()
  })
  it.each([['rls_gate', true], ['unregistered', false]])('uses named database backstop %s rather than a boolean', async (backstop, expected) => {
    const values: Record<string, any> = {
      sa_permissions: permissions.map(p => ({ ...p, status: 'active' })),
      sa_business_roles: [policy('viewer', ['supply_chain.order.view'])],
      organizations: { org_type_code: 'HQ' }, sa_role_assignments: [],
      sa_enforcement_readiness: { route_wiring: true, database_backstop: backstop },
    }
    const admin = { from: (table: string) => {
      const result = { data: values[table], error: null }
      const query: any = { select: () => query, eq: () => query, neq: () => query,
        maybeSingle: async () => result, limit: async () => result,
        then: (resolve: any) => Promise.resolve(result).then(resolve) }
      return query
    } }
    const result = await denialDiagnostics(admin, { source: 'server', http_status: 403, actor_id: 'target', organization_id: 'org', details: {
      event: 'security.authorization.denied', permission: 'supply_chain.order.view', reason: 'MISSING_PERMISSION',
    } })
    expect(result?.enforcementRegistered).toBe(expected)
    expect(result?.candidates.length).toBe(expected ? 1 : 0)
  })
})


describe('Payment Gateway policy explanation', () => {
  const key = 'ecommerce.channel.manage'
  const catalogue = [{ permission_key: key, status: 'active', audit_sensitivity: 'security_sensitive' }]
  const gateway = policy('ecommerce-payment-gateway-administrator', [key])
  it('offers the existing HQ gateway policy for explicit sensitive review', () => {
    const result = policyOptions([gateway], catalogue, key, 'HQ')
    expect(result.matchingPolicyCount).toBe(1)
    expect(result.candidates[0]).toMatchObject({ roleKey: gateway.role_key, sensitivePermissions: [key], requiresExplicitReview: true })
  })
  it('distinguishes nonexistent policies from existing organization restrictions', () => {
    expect(policyOptions([], catalogue, key, 'HQ').matchingPolicyCount).toBe(0)
    const result = policyOptions([gateway], catalogue, key, 'SHOP')
    expect(result.matchingPolicyCount).toBe(1); expect(result.candidates).toHaveLength(0)
    expect(result.restrictedPolicies[0].reason).toBeTruthy()
  })
  it('explains missing enforcement without pretending the policy does not exist', () => {
    const result = policyOptions([gateway], catalogue, key, 'HQ', false)
    expect(result.matchingPolicyCount).toBe(1); expect(result.candidates).toHaveLength(0)
    expect(result.restrictedPolicies[0].reason).toContain('enforcement')
  })
})
