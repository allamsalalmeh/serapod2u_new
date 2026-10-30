import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ store: vi.fn(), build: vi.fn() }))
vi.mock('@/lib/system-logs/server', () => ({ storeDiagnostic: mocks.store, buildServerPayload: mocks.build }))
import { fingerprintOf } from '@/lib/system-logs/contract'
import { MODULE_OPTIONS } from '@/lib/system-logs/query'
import { MODULE_TAXONOMY } from './modules'
import { recordAuthorizationDenial } from './denial-log'
import type { AuthorizationDecision, AuthorizationRequest } from './types'
const request = (actorId: string, organizationId = 'org-a'): AuthorizationRequest => ({ actorId, permission: 'supply_chain.order.approve', resource: { type: 'order', organizationId } })
const decision = { decision: 'DENY', reasonCode: 'MISSING_PERMISSION', decisionId: 'audit-id', matchedAssignments: [], resolvedScopes: [], migrationMode: 'LEGACY_RETIRED', policyVersion: 'v1' } as unknown as AuthorizationDecision
beforeEach(() => { mocks.store.mockReset().mockResolvedValue({ stored: true, result: { stored: true, event_id: 'persisted-occurrence' } }); mocks.build.mockReset().mockImplementation(i => ({ reference_id: i.referenceId, ...i })) })
describe('authoritative denial diagnostics', () => {
  it('offers every authorization module as a System Logs filter', () => {
    for (const module of MODULE_TAXONOMY) expect(MODULE_OPTIONS).toContain(module.name)
  })
  it('shares a persisted reference across concurrent requests and links the durable decision', async () => {
    const refs = await Promise.all(Array.from({ length: 8 }, () => recordAuthorizationDenial(request('concurrent'), decision)))
    expect(new Set(refs).size).toBe(1); expect(refs[0]).toMatch(/^SA-/); expect(mocks.store).toHaveBeenCalledTimes(1)
    expect(mocks.build.mock.calls[0][0]).toMatchObject({ actorId: 'concurrent', organizationId: 'org-a', category: 'permission', status: 403, details: { decision_id: 'audit-id', result: 'DENIED' } })
  })
  it('never advertises an unpersisted reference after storage suppression', async () => {
    mocks.store.mockResolvedValue({ stored: false })
    expect(await recordAuthorizationDenial(request('suppressed'), decision)).toBeUndefined()
  })
  it('does not advertise a reference after an ambiguous storage acknowledgement', async () => {
    mocks.store.mockResolvedValue({ stored: true, result: null })
    expect(await recordAuthorizationDenial(request('ambiguous'), decision)).toBeUndefined()
  })
  it('isolates actor and organization deduplication keys', async () => {
    const a = await recordAuthorizationDenial(request('isolation', 'one'), decision)
    const b = await recordAuthorizationDenial(request('isolation', 'two'), decision)
    expect(a).not.toBe(b); expect(mocks.store).toHaveBeenCalledTimes(2)
  })
  it('records evaluator failures as errors while preserving fail-closed outcome', async () => {
    await recordAuthorizationDenial(request('unavailable'), { ...decision, reasonCode: 'POLICY_ERROR', unavailable: 'policy_evaluation_failed' })
    expect(mocks.build.mock.calls[0][0]).toMatchObject({ category: 'server', status: 503, code: 'AUTHORIZATION_UNAVAILABLE' })
  })
})


describe('denial occurrence bounds', () => {
  it('starts a new persisted occurrence after the burst window and keeps references distinct', async () => {
    vi.useFakeTimers()
    try {
      const first = await recordAuthorizationDenial(request('timed-window'), decision)
      vi.advanceTimersByTime(10_001)
      const second = await recordAuthorizationDenial(request('timed-window'), decision)
      expect(first).not.toBe(second); expect(mocks.store).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
  it('groups repeats by operation/reason independently of volatile references', () => {
    const parts = { source: 'server' as const, category: 'permission' as const, code: 'MISSING_PERMISSION', action: 'ecommerce.channel.manage', module: 'Customer & Growth', message: 'security.authorization.denied: ecommerce.channel.manage (MISSING_PERMISSION)' }
    expect(fingerprintOf(parts)).toBe(fingerprintOf({ ...parts }))
    expect(fingerprintOf(parts)).not.toBe(fingerprintOf({ ...parts, action: 'ecommerce.order.manage' }))
  })
  it('records page provenance and avoids merging it with an interactive operation', async () => {
    const base = request('different-origins')
    const page = await recordAuthorizationDenial({ ...base, context: { diagnosticOrigin: 'page_navigation', operationId: 'supply-chain' } }, decision)
    const action = await recordAuthorizationDenial({ ...base, context: { diagnosticOrigin: 'api_operation' } }, decision)
    expect(page).not.toBe(action)
    expect(mocks.build.mock.calls[0][0]).toMatchObject({ action: 'supply-chain', pagePath: '/supply-chain', details: { origin: 'page_navigation', operation: 'supply-chain' } })
  })
})
