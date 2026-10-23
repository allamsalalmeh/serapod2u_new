import { describe, expect, it } from 'vitest'
import {
  BULK_REMOVAL_MAX_TARGETS, bulkExecutionComplete, bulkPlanFingerprint, bulkPreviewState,
  bulkRemovalPhrase, bulkPlanReference, classifyBulkRemoval, normalizeBulkPhrase, perTargetRequestId,
  signBulkPlanToken, summarizeBulkEligibility, summarizeBulkResults, validateBulkPlan, verifyBulkPlanToken,
  type BulkPlanTokenPayload, type BulkRemovalEligibility, type BulkRemovalPlanEntry,
} from './bulk-removal-plan'

const SECRET = 'test-bulk-secret'
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

const eligibility = (over: Partial<BulkRemovalEligibility> = {}): BulkRemovalEligibility => ({
  user_id: id(1), full_name: 'Tess Tester', email: 'tess@example.test', employee_no: 42,
  organization_id: '11111111-1111-1111-1111-111111111111', organization_name: 'HQ',
  account_status: 'ACTIVE', onboarding_status: 'completed', employment_status: 'active',
  classification: 'DELETE_ELIGIBLE', delete_allowed: true, archive_allowed: true, releasable: true,
  blockers: [], warnings: [], detail: null, ...over,
})

const entry = (over: Partial<BulkRemovalPlanEntry> = {}): BulkRemovalPlanEntry => ({
  user_id: id(1), action: 'delete', employment_end: 'resigned', release_identifiers: false, ...over,
})

const tokenPayload = (over: Partial<BulkPlanTokenPayload> = {}): BulkPlanTokenPayload => ({
  v: 1, actor: id(90), organization: id(91), request_id: id(92),
  issued_at: Date.now(), expires_at: Date.now() + 60_000,
  phrase: 'REMOVE 1 EMPLOYEE', plan_hash: bulkPlanFingerprint([entry()]),
  plan: [{ user_id: id(1), action: 'delete', state: 'state-1' }], ...over,
})

describe('bulk eligibility classification', () => {
  it('offers permanent deletion only when the deletion preview allows it', () => {
    expect(classifyBulkRemoval({ deleteAllowed: true, archiveAllowed: true, deleteVerified: true, archiveVerified: true })).toBe('DELETE_ELIGIBLE')
    expect(classifyBulkRemoval({ deleteAllowed: true, archiveAllowed: false, deleteVerified: true, archiveVerified: true })).toBe('DELETE_ELIGIBLE')
  })

  it('offers archival when permanent deletion is blocked by protected history but archival is allowed', () => {
    expect(classifyBulkRemoval({ deleteAllowed: false, archiveAllowed: true, deleteVerified: true, archiveVerified: true })).toBe('ARCHIVE_ELIGIBLE')
  })

  it('is blocked only when both previews answered with a refusal', () => {
    expect(classifyBulkRemoval({ deleteAllowed: false, archiveAllowed: false, deleteVerified: true, archiveVerified: true })).toBe('BLOCKED')
  })

  it('never treats an unanswered preview as permission or a definitive refusal', () => {
    expect(classifyBulkRemoval({ deleteAllowed: false, archiveAllowed: false, deleteVerified: false, archiveVerified: true })).toBe('UNVERIFIED')
    expect(classifyBulkRemoval({ deleteAllowed: false, archiveAllowed: false, deleteVerified: false, archiveVerified: false })).toBe('UNVERIFIED')
  })

  it('summarizes the mixed selection', () => {
    expect(summarizeBulkEligibility([
      eligibility({ classification: 'DELETE_ELIGIBLE' }),
      eligibility({ classification: 'DELETE_ELIGIBLE' }),
      eligibility({ classification: 'ARCHIVE_ELIGIBLE' }),
      eligibility({ classification: 'ARCHIVE_ELIGIBLE' }),
      eligibility({ classification: 'BLOCKED' }),
    ])).toEqual({ total: 5, deleteEligible: 2, archiveEligible: 2, blocked: 1, unverified: 0 })
  })
})

describe('batch confirmation phrase', () => {
  it('is generated from the number of confirmed identities', () => {
    expect(bulkRemovalPhrase(5)).toBe('REMOVE 5 EMPLOYEES')
    expect(bulkRemovalPhrase(2)).toBe('REMOVE 2 EMPLOYEES')
    expect(bulkRemovalPhrase(1)).toBe('REMOVE 1 EMPLOYEE')
  })

  it('compares the typed phrase regardless of case and repeated spaces', () => {
    expect(normalizeBulkPhrase('  remove   5   employees ')).toBe('REMOVE 5 EMPLOYEES')
    expect(normalizeBulkPhrase('REMOVE 5 EMPLOYEE')).not.toBe(normalizeBulkPhrase(bulkRemovalPhrase(5)))
    expect(normalizeBulkPhrase(undefined)).toBe('')
  })
})

describe('signed plan token', () => {
  it('round-trips the exact plan binding', () => {
    const payload = tokenPayload()
    const token = signBulkPlanToken(payload, SECRET)
    const verified = verifyBulkPlanToken(token, SECRET, payload.issued_at)
    expect(verified.ok).toBe(true)
    if (verified.ok) expect(verified.payload).toEqual(payload)
  })

  it('rejects any tampering with the payload', () => {
    const token = signBulkPlanToken(tokenPayload(), SECRET)
    const [body, signature] = token.split('.')
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    forged.phrase = 'REMOVE 99 EMPLOYEES'
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`
    expect(verifyBulkPlanToken(tampered, SECRET)).toMatchObject({ ok: false, code: 'INVALID_TOKEN' })
  })

  it('rejects an expired or foreign plan', () => {
    const payload = tokenPayload({ issued_at: 1_000, expires_at: 2_000 })
    const token = signBulkPlanToken(payload, SECRET)
    expect(verifyBulkPlanToken(token, SECRET, 2_001)).toMatchObject({ ok: false, code: 'TOKEN_EXPIRED' })
    expect(verifyBulkPlanToken(token, 'another-secret', 1_500)).toMatchObject({ ok: false, code: 'INVALID_TOKEN' })
    expect(verifyBulkPlanToken(undefined, SECRET)).toMatchObject({ ok: false, code: 'INVALID_TOKEN' })
  })

  it('prints a stable short plan reference', () => {
    expect(bulkPlanReference('abcdef1234567890')).toBe('ABCDEF12')
  })
})

describe('plan fingerprint', () => {
  it('is order-independent for the same plan', () => {
    const a = entry()
    const b = entry({ user_id: id(2), action: 'archive', employment_end: 'terminated', release_identifiers: true })
    expect(bulkPlanFingerprint([a, b])).toBe(bulkPlanFingerprint([b, a]))
  })

  it('changes when a target, action, employment outcome or release choice changes', () => {
    const base = bulkPlanFingerprint([entry()])
    expect(bulkPlanFingerprint([entry({ user_id: id(2) })])).not.toBe(base)
    expect(bulkPlanFingerprint([entry({ action: 'archive' })])).not.toBe(base)
    expect(bulkPlanFingerprint([entry({ employment_end: 'terminated' })])).not.toBe(base)
    expect(bulkPlanFingerprint([entry({ release_identifiers: true })])).not.toBe(base)
  })

  it('binds the preview state fingerprint', () => {
    expect(bulkPreviewState({ deletion: 'a', archive: 'b' })).toBe(bulkPreviewState({ deletion: 'a', archive: 'b' }))
    expect(bulkPreviewState({ deletion: 'a', archive: 'b' })).not.toBe(bulkPreviewState({ deletion: 'a', archive: 'c' }))
    expect(bulkPreviewState({ deletion: 'a', archive: 'b' })).not.toBe(bulkPreviewState({ deletion: 'a', archive: null }))
  })
})

describe('per-target request ids', () => {
  it('are deterministic for a safe retry and unique per identity and action', () => {
    const request = id(80)
    const first = perTargetRequestId(SECRET, request, id(1), 'delete')
    expect(first).toBe(perTargetRequestId(SECRET, request, id(1), 'delete'))
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(perTargetRequestId(SECRET, request, id(1), 'archive')).not.toBe(first)
    expect(perTargetRequestId(SECRET, request, id(2), 'delete')).not.toBe(first)
    expect(perTargetRequestId(SECRET, id(81), id(1), 'delete')).not.toBe(first)
  })
})


describe('plan validation against authoritative eligibility', () => {
  const map = (...rows: BulkRemovalEligibility[]) => new Map(rows.map(row => [row.user_id, row]))

  it('accepts an allowed mixed plan', () => {
    const problems = validateBulkPlan(
      [entry(), entry({ user_id: id(2), action: 'archive', release_identifiers: true })],
      map(
        eligibility(),
        eligibility({ user_id: id(2), classification: 'ARCHIVE_ELIGIBLE', delete_allowed: false }),
      ),
    )
    expect(problems).toEqual([])
  })

  it('refuses to substitute archive for a permanent deletion that is not allowed', () => {
    const problems = validateBulkPlan(
      [entry({ action: 'delete' })],
      map(eligibility({ delete_allowed: false, classification: 'ARCHIVE_ELIGIBLE' })),
    )
    expect(problems[0].message).toContain('Permanent deletion is not allowed')
  })

  it('refuses archival where it is not allowed and unverified targets', () => {
    expect(validateBulkPlan([entry({ action: 'archive' })], map(eligibility({ archive_allowed: false })))[0].message)
      .toContain('Archive & Revoke Access is not allowed')
    expect(validateBulkPlan([entry()], map(eligibility({ classification: 'UNVERIFIED', delete_allowed: false, archive_allowed: false })))[0].message)
      .toContain('could not be verified')
  })

  it('refuses duplicates, unknown targets, invalid actions and invalid employment outcomes', () => {
    expect(validateBulkPlan([entry(), entry()], map(eligibility()))[0].message).toContain('planned twice')
    expect(validateBulkPlan([entry({ user_id: id(9) })], map(eligibility()))[0].message).toContain('not part of the reviewed selection')
    expect(validateBulkPlan([entry({ action: 'skip' as any })], map(eligibility()))[0].message).toContain('Choose permanent deletion')
    expect(validateBulkPlan([entry({ employment_end: 'retired' as any })], map(eligibility()))[0].message).toContain('employment outcome')
  })

  it('refuses releasing identifiers where it is not possible, and empty/oversized plans', () => {
    expect(validateBulkPlan([entry({ action: 'archive', release_identifiers: true })], map(eligibility({ releasable: false })))[0].message)
      .toContain('cannot be released')
    expect(validateBulkPlan([], map())[0].message).toContain('at least one employee')
    const many = Array.from({ length: BULK_REMOVAL_MAX_TARGETS + 1 }, (_, index) => entry({ user_id: id(index + 1) }))
    expect(validateBulkPlan(many, map())[0].message).toContain(`at most ${BULK_REMOVAL_MAX_TARGETS}`)
  })
})

describe('execution summary', () => {
  it('counts each outcome and is complete only when every identity reached its confirmed state', () => {
    const results = [
      { outcome: 'deleted' as const }, { outcome: 'archived' as const },
      { outcome: 'blocked' as const }, { outcome: 'failed' as const }, { outcome: 'stale' as const },
    ]
    const summary = summarizeBulkResults(results)
    expect(summary).toEqual({ total: 5, deleted: 1, archived: 1, blocked: 1, failed: 1, stale: 1 })
    expect(bulkExecutionComplete(summary)).toBe(false)
    expect(bulkExecutionComplete(summarizeBulkResults([{ outcome: 'deleted' }, { outcome: 'archived' }]))).toBe(true)
  })
})

