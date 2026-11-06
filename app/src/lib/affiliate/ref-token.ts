import 'server-only'

import { createHmac, timingSafeEqual } from 'node:crypto'
import { normalizeAffiliateCode } from '@/lib/outdoor/sales-tools'
import { normalizeSubId } from '@/lib/affiliate/program'

const TOKEN_VERSION = 1
const FUTURE_TOLERANCE_MS = 60_000
const MIN_SECRET_BYTES = 32

export type AffiliateRefClaims = {
  code: string
  sub: string
  issuedAt: number
}

function signingSecret(): string | null {
  const candidates = [
    process.env.AFFILIATE_REF_SECRET,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.CRON_SECRET,
  ]
  for (const candidate of candidates) {
    const value = String(candidate || '')
    if (Buffer.byteLength(value, 'utf8') >= MIN_SECRET_BYTES) return value
  }
  return null
}

function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/** Issues a server-authenticated referral click. Returns null when no strong server secret exists. */
export function issueAffiliateRefToken(code: unknown, sub: unknown, now = Date.now()): { token: string; claims: AffiliateRefClaims } | null {
  const secret = signingSecret()
  const clean = normalizeAffiliateCode(code)
  if (!secret || !clean || !Number.isFinite(now) || now <= 0) return null
  const claims: AffiliateRefClaims = { code: clean, sub: normalizeSubId(sub), issuedAt: Math.floor(now) }
  const payload = Buffer.from(JSON.stringify({ v: TOKEN_VERSION, c: claims.code, s: claims.sub, i: claims.issuedAt }), 'utf8').toString('base64url')
  return { token: `${payload}.${signature(payload, secret)}`, claims }
}

/** Verifies signature, code and attribution window. Invalid/missing/future tokens fail closed. */
export function verifyAffiliateRefToken(token: unknown, expectedCode: unknown, maxAgeDays: number, now = Date.now()): AffiliateRefClaims | null {
  const secret = signingSecret()
  const cleanExpected = normalizeAffiliateCode(expectedCode)
  const raw = typeof token === 'string' ? token.trim() : ''
  if (!secret || !cleanExpected || !raw || raw.length > 1_024 || !Number.isFinite(now)) return null

  const pieces = raw.split('.')
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) return null
  const [payload, suppliedSignature] = pieces
  try {
    const expectedSignature = Buffer.from(signature(payload, secret), 'base64url')
    const actualSignature = Buffer.from(suppliedSignature, 'base64url')
    if (expectedSignature.length !== actualSignature.length || !timingSafeEqual(expectedSignature, actualSignature)) return null

    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { v?: unknown; c?: unknown; s?: unknown; i?: unknown }
    const code = normalizeAffiliateCode(parsed.c)
    const issuedAt = Number(parsed.i)
    if (parsed.v !== TOKEN_VERSION || code !== cleanExpected || !Number.isInteger(issuedAt) || issuedAt <= 0) return null
    if (issuedAt > now + FUTURE_TOLERANCE_MS) return null
    const maxAgeMs = Math.max(0, Number(maxAgeDays) || 0) * 86_400_000
    if (now - issuedAt > maxAgeMs) return null
    return { code, sub: normalizeSubId(parsed.s), issuedAt }
  } catch {
    return null
  }
}
