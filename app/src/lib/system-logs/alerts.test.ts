import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestPayload } from './contract'

const mocks = vi.hoisted(() => ({
  settings: [] as Array<{ org_id: string }>,
  orgs: [] as Array<{ id: string; org_type_code: string }>,
  recentAlerts: [] as Array<{ payload_json: Record<string, unknown> }>,
  queue: vi.fn(),
  adminThrows: false,
  outboxError: null as null | { message: string },
}))

function query(rows: () => unknown, error: () => unknown = () => null) {
  const chain: any = {
    select: () => chain, eq: () => chain, in: () => chain, gte: () => chain, limit: () => chain,
    then: (resolve: (value: unknown) => void) => resolve({ data: rows(), error: error() }),
  }
  return chain
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (mocks.adminThrows) throw new Error('admin unavailable')
    return {
      from: (table: string) => {
        if (table === 'notification_settings') return query(() => mocks.settings)
        if (table === 'organizations') return query(() => mocks.orgs)
        return query(() => mocks.recentAlerts, () => mocks.outboxError)
      },
    }
  },
}))
vi.mock('@/lib/notifications/supplyChainEventQueue', () => ({ queueNotificationEvent: mocks.queue }))

import { ALERTS_PER_HOUR, buildAlertPayload, dispatchSystemAlert, qualifiesForAlert } from './alerts'
import { resetRateLimitsForTests } from '@/lib/security/rate-limit'

const HQ = 'hq-org'
const DIST = 'distributor-org'
const OTHER = 'other-org'

const failure = (over: Partial<IngestPayload> = {}): IngestPayload => ({
  kind: 'error',
  reference_id: 'SYS-7K3M9QX2',
  occurred_at: '2026-11-05T02:30:00.000Z',
  source: 'server',
  environment: 'staging',
  app_build: 'abc',
  fingerprint: 'fp-1',
  category: 'server',
  severity: 'error',
  message: 'new row violates check constraint "document_signatures_document_type_check"',
  actor_id: 'user-1',
  organization_id: DIST,
  code: '23514',
  module: 'Supply Chain',
  action: 'document.acknowledge.record_signature',
  api_route: '/api/documents/doc-1/acknowledge',
  stack: 'at /app/src/app/api/documents/route.ts',
  details: { document_id: 'doc-1' },
  ...over,
})

beforeEach(() => {
  resetRateLimitsForTests()
  mocks.settings = [{ org_id: HQ }]
  mocks.orgs = [{ id: HQ, org_type_code: 'HQ' }]
  mocks.recentAlerts = []
  mocks.adminThrows = false
  mocks.outboxError = null
  mocks.queue.mockReset()
  mocks.queue.mockResolvedValue({ queuedCount: 1, skippedReason: null, errors: [] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('qualifiesForAlert', () => {
  const env = {} as NodeJS.ProcessEnv

  it('accepts an unexpected server failure in staging and production', () => {
    expect(qualifiesForAlert(failure(), env)).toBe(true)
    expect(qualifiesForAlert(failure({ environment: 'production' }), env)).toBe(true)
  })

  it('never alerts for expected outcomes', () => {
    for (const category of ['validation', 'permission', 'authentication', 'not_found', 'conflict', 'rate_limited'] as const) {
      expect(qualifiesForAlert(failure({ category, severity: 'warning' }), env)).toBe(false)
    }
  })

  it('never alerts from a browser report or a background worker', () => {
    expect(qualifiesForAlert(failure({ source: 'browser' }), env)).toBe(false)
    expect(qualifiesForAlert(failure({ source: 'worker' }), env)).toBe(false)
  })

  it('never alerts about the notification or logging pipeline itself', () => {
    for (const api_route of ['/api/cron/notification-outbox-worker', '/api/notifications/sms-check', '/api/settings/notifications/monitor', '/api/system-logs/report', '/api/cron/system-log-retention']) {
      expect(qualifiesForAlert(failure({ api_route }), env)).toBe(false)
    }
    expect(qualifiesForAlert(failure({ api_route: null, page_path: '/settings/notifications/types' }), env)).toBe(false)
  })

  it('stays quiet on localhost, which shares the staging database, unless asked', () => {
    expect(qualifiesForAlert(failure({ environment: 'local' }), env)).toBe(false)
    expect(qualifiesForAlert(failure({ environment: 'local' }), { SYSTEM_LOG_ALERT_ENVIRONMENTS: 'local' } as any)).toBe(true)
    expect(qualifiesForAlert(failure(), { SYSTEM_LOG_ALERT_ENVIRONMENTS: 'production' } as any)).toBe(false)
  })
})

describe('buildAlertPayload', () => {
  it('carries the reference, module, severity, environment and time, and nothing technical', () => {
    const alert = buildAlertPayload(failure(), 'database', 'system_error_database')
    expect(alert).toMatchObject({ reference_id: 'SYS-7K3M9QX2', module: 'Supply Chain', severity: 'ERROR', environment_label: 'STAGING', alert_title: 'Database Operation Failure' })
    expect(alert.occurred_at).toContain('2026')
    const text = JSON.stringify(alert)
    for (const secret of ['document_signatures', '23514', '/app/src', 'user-1', DIST, 'doc-1']) expect(text).not.toContain(secret)
  })

  it('has no key the outbox would treat as a recipient', () => {
    const keys = Object.keys(buildAlertPayload(failure(), 'critical', 'system_error_critical'))
    expect(keys.filter((key) => /phone|email|order|created_by|customer/.test(key))).toEqual([])
  })

  it('keeps staging and production alerts distinguishable', () => {
    expect(buildAlertPayload(failure({ environment: 'production' }), 'critical', 'system_error_critical')).toMatchObject({ environment_label: 'PRODUCTION', severity: 'CRITICAL' })
  })
})

describe('dispatchSystemAlert', () => {
  it('queues the type matching the failure class through the existing queue', async () => {
    await expect(dispatchSystemAlert(failure(), 'database')).resolves.toBe(1)
    expect(mocks.queue).toHaveBeenCalledTimes(1)
    const [, input] = mocks.queue.mock.calls[0]
    expect(input).toMatchObject({ orgId: HQ, eventCode: 'system_error_database', priority: 'high', dedupePayload: { alert_fingerprint: 'fp-1', environment_label: 'STAGING' } })
    expect(input.allowedChannels).toEqual(['whatsapp', 'sms', 'email'])
  })

  it('sends nothing when the type is disabled or was never configured', async () => {
    mocks.settings = []
    await expect(dispatchSystemAlert(failure(), 'database')).resolves.toBe(0)
    expect(mocks.queue).not.toHaveBeenCalled()
  })

  it('applies an HQ setting to every failure and an organization setting only to its own', async () => {
    mocks.settings = [{ org_id: HQ }, { org_id: DIST }, { org_id: OTHER }]
    mocks.orgs = [{ id: HQ, org_type_code: 'HQ' }, { id: DIST, org_type_code: 'DIST' }, { id: OTHER, org_type_code: 'DIST' }]
    await dispatchSystemAlert(failure(), 'database')
    expect(mocks.queue.mock.calls.map(([, input]) => input.orgId).sort()).toEqual([DIST, HQ].sort())
  })

  it('does not flood: a repeated failure in one process is queued once', async () => {
    for (let i = 0; i < 25; i++) await dispatchSystemAlert(failure({ reference_id: `SYS-AAAAAA${String(i).padStart(2, '0')}` }), 'database')
    expect(mocks.queue).toHaveBeenCalledTimes(1)
  })

  it('stops at the hourly limit for different failures, counting an alert and its children once', async () => {
    mocks.recentAlerts = Array.from({ length: ALERTS_PER_HOUR * 3 }, (_, i) => ({ payload_json: { report_key: `SYS-${i % ALERTS_PER_HOUR}` } }))
    await expect(dispatchSystemAlert(failure(), 'database')).resolves.toBe(0)
    expect(mocks.queue).not.toHaveBeenCalled()
    mocks.recentAlerts = Array.from({ length: ALERTS_PER_HOUR * 3 }, () => ({ payload_json: { report_key: 'SYS-ONE' } }))
    await expect(dispatchSystemAlert(failure({ fingerprint: 'fp-2' }), 'database')).resolves.toBe(1)
  })

  it('never throws and never reports when the notification system fails', async () => {
    const report = vi.fn()
    vi.doMock('./server', () => ({ reportServerError: report, reportSystemFailure: report }))
    mocks.queue.mockRejectedValue(new Error('outbox down'))
    await expect(dispatchSystemAlert(failure(), 'database')).resolves.toBe(0)
    mocks.adminThrows = true
    await expect(dispatchSystemAlert(failure({ fingerprint: 'fp-3' }), 'critical')).resolves.toBe(0)
    expect(report).not.toHaveBeenCalled()
    vi.doUnmock('./server')
  })
})
