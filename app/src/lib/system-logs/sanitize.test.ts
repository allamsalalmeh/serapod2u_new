import { describe, expect, it } from 'vitest'
import { describeUserAgent, sanitizeDetails, sanitizePath, sanitizeStack, sanitizeText } from './sanitize'
import { buildDiagnosticReport } from './report'

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

describe('System Logs sanitization (applied before storage and before copying)', () => {
  it('removes credentials, tokens, cookies and authorization headers from free text', () => {
    const text = sanitizeText(`Authorization: Bearer abcdefghijklmnop12345 password=hunter22 token: "tok_123456789" apikey=${JWT} cookie=sb-abcd-auth-token=base64stuff; service_role_key=${JWT} sk_live_ABCDEFGH12345678`)
    expect(text).not.toMatch(/hunter22|abcdefghijklmnop12345|tok_123456789|eyJhbGci|base64stuff|sk_live_ABCDEFGH/)
    expect(text).toContain('[redacted]')
  })

  it('removes personal data: e-mail, phone, bank/card/identity numbers', () => {
    const text = sanitizeText('Contact alice.tan@example.com or +60 12-345 6789; acct 1234567890123; card 4111 1111 1111 1111; IC 900101-14-5678')
    expect(text).not.toMatch(/alice\.tan|345 6789|1234567890123|4111|900101/)
    expect(text).toContain('[email]')
    expect(text).toContain('[number]')
  })

  it('keeps record ids, order numbers and dates (needed to investigate)', () => {
    const text = sanitizeText('Order ORD26000098 (3f2c1d8e-1111-2222-3333-444455556666) failed on 2026-10-07')
    expect(text).toContain('ORD26000098')
    expect(text).toContain('3f2c1d8e-1111-2222-3333-444455556666')
    expect(text).toContain('2026-10-07')
  })

  it('strips URL query strings and fragments from text', () => {
    expect(sanitizeText('GET https://stg.serapod2u.com/reset?token=abc&email=x@y.z#frag failed')).toBe('GET https://stg.serapod2u.com/reset?[query] failed')
  })

  it('bounds length', () => {
    expect(sanitizeText('x'.repeat(5000)).length).toBeLessThanOrEqual(1000)
  })

  it('sanitizes page paths: no query, no token segments', () => {
    expect(sanitizePath('/dashboard/orders?search=alice@example.com')).toBe('/dashboard/orders')
    expect(sanitizePath('/track/product/PROD-ABC-123-SECRETTOKEN?sc=1')).toBe('/track/product/:token')
    expect(sanitizePath('https://stg.serapod2u.com/settings/system/logs#x')).toBe('/settings/system/logs')
    expect(sanitizePath(`/api/x/${JWT}`)).toBe('/api/x/:token')
    expect(sanitizePath('/api/orders/3f2c1d8e-1111-2222-3333-444455556666')).toBe('/api/orders/3f2c1d8e-1111-2222-3333-444455556666')
    expect(sanitizePath('/api/users/0123456789012/profile')).toBe('/api/users/:token/profile')
  })

  it('drops sensitive metadata keys and request bodies, bounds depth/size', () => {
    const details = sanitizeDetails({
      order_no: 'ORD-1', password: 'x', new_password: 'y', access_token: 't', Authorization: 'Bearer z', cookie: 'c', bank_account_no: '123',
      card_number: '4111', phone: '0123', email: 'a@b.c', body: { password: 'p' }, payload: { a: 1 }, headers: { authorization: 'x' },
      nested: { deeper: { deepest: { gone: true } } }, note: 'call 0123456789 now', list: Array.from({ length: 50 }, (_, i) => i),
    })
    expect(Object.keys(details).sort()).toEqual(['list', 'nested', 'note', 'order_no'])
    expect(details.note).toBe('call [number] now')
    expect((details.list as unknown[]).length).toBe(10)
    expect((details.nested as any).deeper.deepest).toBe('[depth]')
    const big = sanitizeDetails({ a: 'x'.repeat(290), b: 'y'.repeat(290), ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`k${i}`, 'z'.repeat(290)])) })
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(8000)
  })

  it('shortens stack paths and removes secrets from stack lines', () => {
    const stack = sanitizeStack(`TypeError: bad token=${JWT}\n    at save (webpack-internal:///./src/components/orders/CreateOrderView.tsx:1210:15)\n    at /Users/edierwan/serapod2u_dev/app/.next/server/chunks/ssr/a.js:1:2\n    at https://stg.serapod2u.com/_next/static/chunks/app.js?v=abc:3:4`)
    expect(stack).not.toMatch(/eyJhbGci|\/Users\/edierwan|v=abc/)
    expect(stack).toContain('components/orders/CreateOrderView.tsx:1210:15')
  })

  it('describes the browser coarsely from the User-Agent', () => {
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'))
      .toEqual({ browser: 'Chrome 129', os: 'macOS', device: 'desktop' })
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1').device).toBe('mobile')
  })
})

describe('Copy diagnostic report', () => {
  const detail = {
    event: {
      id: 'e1', kind: 'error' as const, occurred_at: '2026-10-07T03:00:00.000Z', reference_id: 'ERR-ABCDEFGHJKMN', correlation_id: 'DIG-123456',
      server_reference_id: 'REQ-ABCDEFGHJKMN', environment: 'staging', app_build: '0.1.0-202610070300', source: 'browser', severity: 'error',
      category: 'server', code: '23505', module: 'Supply Chain', action: 'Create order', page_path: '/dashboard', api_route: '/api/orders',
      http_method: 'POST', http_status: 500, message: 'Insert failed for alice@example.com token=abcdefghijkl',
      stack: `Error: x\n    at f (/Users/someone/app/src/a.ts:1:2) ${JWT}`, details: { order_no: 'ORD-1', password: 'p', note: 'phone 0123456789' },
      client: { browser: 'Chrome 129', os: 'macOS', device: 'desktop', viewport: '1440x900' }, actor_id: 'u-1', organization_id: 'o-1',
    },
    actor: { id: 'u-1', name: 'Alice Tan', email: 'alice@example.com' },
    group: { id: 'g', fingerprint: 'abcdefabcdefabcd', first_seen_at: '2026-10-06T00:00:00Z', last_seen_at: '2026-10-07T03:00:00Z', occurrence_count: 7, environment: 'staging', app_build: 'b' },
    related: [{ id: 'r1', occurred_at: '2026-10-07T03:00:00Z', reference_id: 'REQ-ABCDEFGHJKMN', source: 'server', kind: 'error', severity: 'error', message: 'duplicate key value', http_status: 500, link: 'same_failure' as const, counted: true }],
  }

  it('contains the facts Coder AI needs', () => {
    const text = buildDiagnosticReport(detail, new Date('2026-10-07T04:00:00Z'))
    for (const fact of ['Environment: staging', 'App build: 0.1.0-202610070300', 'Reference ID: ERR-ABCDEFGHJKMN', 'Server reference (X-Request-ID): REQ-ABCDEFGHJKMN',
      'Module: Supply Chain', 'Action: Create order', 'API: POST /api/orders → HTTP 500', 'Error code: 23505', 'Grouped occurrences: 7', 'Browser/device: Chrome 129 · macOS · desktop · viewport 1440x900',
      'Related events (linked by recorded ids only):', 'same failure (browser/server pair)']) {
      expect(text).toContain(fact)
    }
  })

  it('contains no identity, organization, secrets or personal data', () => {
    const text = buildDiagnosticReport(detail)
    expect(text).not.toMatch(/Alice|alice@example\.com|u-1|o-1|abcdefghijkl|eyJhbGci|"password"|0123456789|\/Users\/someone/)
  })

  it('says when an activity record has no environment instead of inventing one', () => {
    const text = buildDiagnosticReport({ event: { id: 'a', kind: 'activity', occurred_at: 't', reference_id: 'ACT-123456', source: 'database', severity: 'info', message: 'ORD-1', outcome: 'success' }, related: [] })
    expect(text).toContain('Environment: not recorded')
    expect(text).toContain('Related events: none recorded')
  })
})
