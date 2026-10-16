import { describe, expect, it } from 'vitest'
import {
  classifyFailure, digestCorrelationId, fingerprintOf, isNoise, isReferenceId, moduleFromPath, newReferenceId,
  normalizeForFingerprint, normalizeRoute, reportedByDefault, severityFor,
} from './contract'

describe('System Logs contract — classification', () => {
  it('keeps network failures, timeouts, authentication, permission, validation and unexpected exceptions apart', () => {
    expect(classifyFailure({ name: 'TypeError', message: 'Failed to fetch' })).toBe('network')
    expect(classifyFailure({ message: 'Load failed' })).toBe('network')
    expect(classifyFailure({ status: 0 })).toBe('network')
    expect(classifyFailure({ offline: true, message: 'whatever' })).toBe('network')
    expect(classifyFailure({ name: 'TimeoutError', message: 'signal timed out' })).toBe('timeout')
    expect(classifyFailure({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe('timeout')
    expect(classifyFailure({ status: 504 })).toBe('timeout')
    expect(classifyFailure({ status: 401 })).toBe('authentication')
    expect(classifyFailure({ code: 'PGRST301', message: 'JWT expired' })).toBe('authentication')
    expect(classifyFailure({ status: 403 })).toBe('permission')
    expect(classifyFailure({ code: '42501', message: 'new row violates row-level security policy' })).toBe('permission')
    expect(classifyFailure({ status: 422 })).toBe('validation')
    expect(classifyFailure({ code: '23514', message: 'violates check constraint' })).toBe('validation')
    expect(classifyFailure({ code: '23505', message: 'duplicate key' })).toBe('conflict')
    expect(classifyFailure({ status: 404 })).toBe('not_found')
    expect(classifyFailure({ status: 429 })).toBe('rate_limited')
    expect(classifyFailure({ status: 500, message: 'boom' })).toBe('server')
    expect(classifyFailure({ name: 'TypeError', message: "Cannot read properties of undefined (reading 'id')" })).toBe('unexpected')
  })

  it('treats request cancellations as non-diagnostic', () => {
    expect(classifyFailure({ name: 'AbortError', message: 'The user aborted a request.' })).toBe('cancelled')
    expect(severityFor('cancelled')).toBe('info')
  })

  it('reports only errors by default — routine outcomes are warnings that do not flood the Errors view', () => {
    for (const c of ['network', 'timeout', 'server', 'unexpected'] as const) expect(reportedByDefault(c)).toBe(true)
    for (const c of ['validation', 'permission', 'authentication', 'not_found', 'conflict', 'rate_limited', 'cancelled'] as const) expect(reportedByDefault(c)).toBe(false)
  })
})

describe('System Logs contract — references, fingerprints, noise', () => {
  it('issues well-formed, distinct reference ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newReferenceId()))
    expect(ids.size).toBe(500)
    for (const id of ids) expect(isReferenceId(id) && /^ERR-[0-9A-Z]{12}$/.test(id)).toBe(true)
    expect(newReferenceId('REQ')).toMatch(/^REQ-/)
    expect(isReferenceId('bad ref!')).toBe(false)
  })

  it('derives a digest correlation id usable on both sides', () => {
    expect(digestCorrelationId('1234567890')).toBe('DIG-1234567890')
    expect(isReferenceId(digestCorrelationId('abc@@def'))).toBe(true)
    expect(digestCorrelationId(undefined)).toBeNull()
  })

  it('groups repeats of one failure regardless of ids, numbers and quoted values', () => {
    const a = fingerprintOf({ source: 'browser', category: 'server', module: 'Orders', action: 'save', route: '/api/orders/3f2c1d8e-1111-2222-3333-444455556666', message: 'Order ORD-1 failed after 3 tries for "Alice"' })
    const b = fingerprintOf({ source: 'browser', category: 'server', module: 'Orders', action: 'save', route: '/api/orders/9a9a9a9a-1111-2222-3333-444455556666', message: 'Order ORD-27 failed after 12 tries for "Bob"' })
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{16}$/)
    expect(fingerprintOf({ source: 'server', category: 'server', message: 'x' })).not.toBe(fingerprintOf({ source: 'browser', category: 'server', message: 'x' }))
    expect(normalizeRoute('/api/orders/123/items?x=1')).toBe('/api/orders/:n/items')
    expect(normalizeForFingerprint('ERR-ABCDEF123456 at 10:42')).toBe('<ref> at <n>:<n>')
  })

  it('recognises hot-reload noise, extension errors and Next.js control-flow signals', () => {
    expect(isNoise('[HMR] connected')).toBe(true)
    expect(isNoise('[Fast Refresh] rebuilding')).toBe(true)
    expect(isNoise('Script error.')).toBe(true)
    expect(isNoise('ResizeObserver loop completed with undelivered notifications.')).toBe(true)
    expect(isNoise('x', 'at foo (chrome-extension://abc/content.js:1:1)')).toBe(true)
    expect(isNoise('NEXT_REDIRECT')).toBe(true)
    expect(isNoise('Failed to save order')).toBe(false)
  })

  it('labels modules from paths for grouping and display', () => {
    expect(moduleFromPath('/api/admin/shop-staff-performance')).toBe('Product Catalog')
    expect(moduleFromPath('/api/orders/1')).toBe('Supply Chain')
    expect(moduleFromPath('/api/security-access/assignments')).toBe('Security & Access')
    expect(moduleFromPath('/whatever')).toBe('Other')
  })
})
