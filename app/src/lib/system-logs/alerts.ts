import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkRateLimit } from '@/lib/security/rate-limit'
import {
  REQUIRED_NOTIFICATION_TYPES,
  SYSTEM_ERROR_APPLICATION_EVENT,
  SYSTEM_ERROR_CRITICAL_EVENT,
  SYSTEM_ERROR_DATABASE_EVENT,
} from '@/lib/notifications/notificationEventCatalog'
import { queueNotificationEvent } from '@/lib/notifications/supplyChainEventQueue'
import type { IngestPayload, LogCategory, LogEnvironment } from './contract'
import type { SystemFailureClass } from './system-failure-class'

/**
 * System Log → Notification Rules → Delivery Queue. The queue, providers, retries, routing and recipients are the
 * existing Notification Types ones; only the decision of whether a stored failure is worth an alert lives here.
 *
 * Guarantees (each is tested in alerts.test.ts):
 *   - a setting must be explicitly enabled: with no saved row nothing is sent, unlike ordinary queued events;
 *   - never throws, and never reports into System Logs: a failing notification system cannot alert about itself;
 *   - failures of the notification and logging pipeline itself never alert;
 *   - one alert per failure per 15 minutes, and at most ALERTS_PER_HOUR distinct alerts per organization and type;
 *   - the alert carries the reference, module, severity, environment and time. Never the message, code, path or user.
 */

export const ALERTS_PER_HOUR = 10
const DEDUPE_WINDOW_MS = 15 * 60_000
const DB_TIMEOUT_MS = 3_000
const ALERTING_CATEGORIES: ReadonlySet<LogCategory> = new Set(['server', 'unexpected', 'timeout', 'network'])
/** Localhost shares the staging database, so it must not queue alerts unless a developer asks for it. */
const DEFAULT_ALERT_ENVIRONMENTS: readonly LogEnvironment[] = ['production', 'staging']
const PIPELINE_PATHS = /^(\/api)?\/(cron\/notification|cron\/system-log|notifications|settings\/notifications|system-logs|settings\/system\/logs)/

const EVENT_BY_CLASS: Record<SystemFailureClass, string> = {
  critical: SYSTEM_ERROR_CRITICAL_EVENT,
  database: SYSTEM_ERROR_DATABASE_EVENT,
  application: SYSTEM_ERROR_APPLICATION_EVENT,
}

const eventName = (eventCode: string) => REQUIRED_NOTIFICATION_TYPES.find((type) => type.event_code === eventCode)?.event_name ?? 'System Error'
const allowedChannels = (eventCode: string) => REQUIRED_NOTIFICATION_TYPES.find((type) => type.event_code === eventCode)?.available_channels

function alertEnvironments(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = String(env.SYSTEM_LOG_ALERT_ENVIRONMENTS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
  return configured.length ? configured : [...DEFAULT_ALERT_ENVIRONMENTS]
}

/** Whether a stored failure may alert at all (pure; exported for tests). */
export function qualifiesForAlert(payload: IngestPayload, env: NodeJS.ProcessEnv = process.env): boolean {
  if (payload.source !== 'server') return false
  if (payload.severity !== 'error' || !ALERTING_CATEGORIES.has(payload.category)) return false
  if (PIPELINE_PATHS.test(payload.api_route ?? '') || PIPELINE_PATHS.test(payload.page_path ?? '')) return false
  return alertEnvironments(env).includes(payload.environment)
}

/** The whole message an administrator's phone or inbox can ever see (pure; exported for tests). */
export function buildAlertPayload(payload: IngestPayload, failureClass: SystemFailureClass, eventCode: string): Record<string, string> {
  return {
    // report_key lets the existing outbox fan out to every configured recipient and drop per-recipient duplicates.
    report_key: payload.reference_id,
    reference_id: payload.reference_id,
    alert_fingerprint: payload.fingerprint,
    alert_title: eventName(eventCode),
    environment_label: payload.environment.toUpperCase(),
    module: payload.module || 'Other',
    severity: failureClass === 'critical' ? 'CRITICAL' : 'ERROR',
    occurred_at: new Date(payload.occurred_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' }),
  }
}

/**
 * Whose settings apply. An HQ organization's setting covers every failure; any other organization's setting only covers
 * failures attributed to that organization. Recipients then resolve inside that organization, as for every other event.
 */
async function targetOrganizations(admin: any, eventCode: string, failureOrgId: string | null): Promise<string[]> {
  const { data: settings } = await admin.from('notification_settings').select('org_id').eq('event_code', eventCode).eq('enabled', true)
  const orgIds: string[] = (settings || []).map((row: any) => row.org_id)
  if (!orgIds.length) return []
  const { data: orgs } = await admin.from('organizations').select('id, org_type_code').in('id', orgIds)
  return (orgs || [])
    .filter((org: any) => String(org.org_type_code ?? '').toUpperCase() === 'HQ' || org.id === failureOrgId)
    .map((org: any) => org.id)
}

/** Distinct alerts already queued in the last hour; children of one alert (fan-out, fallback) share a report_key. */
async function underHourlyLimit(admin: any, orgId: string, eventCode: string): Promise<boolean> {
  const { data, error } = await admin
    .from('notifications_outbox')
    .select('payload_json')
    .eq('org_id', orgId)
    .eq('event_code', eventCode)
    .gte('created_at', new Date(Date.now() - 60 * 60_000).toISOString())
    .limit(500)
  if (error) return false
  return new Set((data || []).map((row: any) => row.payload_json?.report_key)).size < ALERTS_PER_HOUR
}

/** Never throws. Returns how many alert rows were queued; deliberately reports nothing anywhere but the console. */
export async function dispatchSystemAlert(payload: IngestPayload, failureClass: SystemFailureClass): Promise<number> {
  try {
    if (!qualifiesForAlert(payload)) return 0
    const eventCode = EVENT_BY_CLASS[failureClass]
    const admin = createAdminClient(DB_TIMEOUT_MS) as any
    const orgIds = await targetOrganizations(admin, eventCode, payload.organization_id)
    let queued = 0
    for (const orgId of orgIds) {
      // Spares the database during a flood; the queue's own payload check below is what holds across server processes.
      if (!checkRateLimit(`system-alert:${eventCode}:${orgId}:${payload.fingerprint}`, 1, DEDUPE_WINDOW_MS).allowed) continue
      if (!(await underHourlyLimit(admin, orgId, eventCode))) continue
      const alert = buildAlertPayload(payload, failureClass, eventCode)
      const outcome = await queueNotificationEvent(admin, {
        orgId,
        eventCode,
        payload: alert,
        dedupePayload: { alert_fingerprint: alert.alert_fingerprint, environment_label: alert.environment_label },
        priority: failureClass === 'critical' ? 'critical' : 'high',
        allowedChannels: allowedChannels(eventCode),
      })
      queued += outcome.queuedCount
      if (outcome.errors?.length) console.warn('[system-log-alerts] queue refused', { eventCode, channels: outcome.errors.length })
    }
    return queued
  } catch (err) {
    console.warn('[system-log-alerts] dispatch failed', { name: (err as any)?.name })
    return 0
  }
}
