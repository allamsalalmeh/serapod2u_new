import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { issueAffiliateRefToken, verifyAffiliateRefToken } from './ref-token'

const SECRET = 'affiliate-ref-test-secret-that-is-at-least-32-bytes'
const NOW = Date.UTC(2026, 10, 6, 10, 0, 0)
const DAY = 86_400_000

describe('affiliate referral token', () => {
  beforeEach(() => {
    vi.stubEnv('AFFILIATE_REF_SECRET', SECRET)
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    vi.stubEnv('CRON_SECRET', '')
  })

  afterEach(() => vi.unstubAllEnvs())

  it('round-trips a normalized code, sub id and issue time', () => {
    const issued = issueAffiliateRefToken('aminah-7k2q', 'tiktok', NOW)
    expect(issued).not.toBeNull()
    expect(verifyAffiliateRefToken(issued!.token, 'AMINAH-7K2Q', 30, NOW + DAY)).toEqual({
      code: 'AMINAH-7K2Q', sub: 'tiktok', issuedAt: NOW,
    })
  })

  it('rejects tampering, the wrong code and expired claims', () => {
    const token = issueAffiliateRefToken('AMINAH-7K2Q', 'social', NOW)!.token
    expect(verifyAffiliateRefToken(`${token}x`, 'AMINAH-7K2Q', 30, NOW)).toBeNull()
    expect(verifyAffiliateRefToken(token, 'OTHER-CODE', 30, NOW)).toBeNull()
    expect(verifyAffiliateRefToken(token, 'AMINAH-7K2Q', 30, NOW + 31 * DAY)).toBeNull()
  })

  it('rejects a claim issued too far in the future', () => {
    const token = issueAffiliateRefToken('AMINAH-7K2Q', '', NOW + 61_000)!.token
    expect(verifyAffiliateRefToken(token, 'AMINAH-7K2Q', 30, NOW)).toBeNull()
  })

  it('fails closed when no strong server secret is configured', () => {
    vi.stubEnv('AFFILIATE_REF_SECRET', '')
    expect(issueAffiliateRefToken('AMINAH-7K2Q', '', NOW)).toBeNull()
    expect(verifyAffiliateRefToken('x.y', 'AMINAH-7K2Q', 30, NOW)).toBeNull()
  })
})
