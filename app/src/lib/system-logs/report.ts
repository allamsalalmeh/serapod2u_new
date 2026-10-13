/**
 * "Copy diagnostic report" — a plain-text summary of ONE recorded occurrence for pasting into Coder AI.
 *
 * Only recorded facts: environment/build, time, reference ids, module/action, error/status, sanitized technical detail
 * and events linked by recorded ids. Every string is sanitized again here (defence in depth). Deliberately excluded:
 * the user's name/e-mail/id, organization, request bodies, credentials, query strings.
 */
import { sanitizeDetails, sanitizeStack, sanitizeText } from './sanitize'

export interface LogEventDetail {
  event: {
    id: string
    kind: 'error' | 'activity'
    occurred_at: string
    received_at?: string
    reference_id: string
    correlation_id?: string | null
    server_reference_id?: string | null
    counted?: boolean
    duplicate_of?: string | null
    organization_id?: string | null
    actor_id?: string | null
    actor_kind?: string | null
    environment?: string | null
    app_build?: string | null
    source: string
    severity: string
    category?: string | null
    code?: string | null
    module?: string | null
    action?: string | null
    page_path?: string | null
    api_route?: string | null
    http_method?: string | null
    http_status?: number | null
    message: string
    stack?: string | null
    details?: Record<string, unknown> | null
    client?: Record<string, unknown> | null
    outcome?: string | null
    entity_type?: string | null
    entity_id?: string | null
  }
  actor?: { id: string; name?: string | null; email?: string | null } | null
  group?: {
    id: string
    fingerprint: string
    first_seen_at: string
    last_seen_at: string
    occurrence_count: number
    environment: string
    app_build: string
    recent_references?: string[]
  } | null
  related: Array<{
    id: string
    occurred_at: string
    reference_id: string
    source: string
    kind: string
    severity: string
    category?: string | null
    module?: string | null
    action?: string | null
    api_route?: string | null
    http_status?: number | null
    message: string
    counted?: boolean
    link: 'same_failure' | 'correlation_id' | 'server_reference' | 'same_group'
  }>
}

const LINK_LABEL: Record<string, string> = {
  same_failure: 'same failure (browser/server pair)',
  correlation_id: 'same correlation id',
  server_reference: 'server reference',
  same_group: 'same error group',
}

const t = (v: unknown, max = 500) => sanitizeText(v, max)

export function buildDiagnosticReport(detail: LogEventDetail, generatedAt: Date = new Date()): string {
  const e = detail.event
  const lines: string[] = []
  const push = (label: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return
    lines.push(`${label}: ${t(value)}`)
  }
  lines.push('Serapod2U diagnostic report (System Logs)')
  lines.push(`Copied: ${generatedAt.toISOString()}`)
  lines.push('')
  push('Environment', e.environment ?? (e.kind === 'activity' ? 'not recorded (database event; localhost and staging share this database)' : null))
  push('App build', e.app_build)
  push('Source', e.source)
  push('Occurred at', e.occurred_at)
  push('Reference ID', e.reference_id)
  push('Correlation ID', e.correlation_id)
  push('Server reference (X-Request-ID)', e.server_reference_id)
  push('Module', e.module)
  push('Action', e.action)
  push('Page', e.page_path)
  if (e.api_route || e.http_status) lines.push(`API: ${[e.http_method, e.api_route ? t(e.api_route, 300) : null].filter(Boolean).join(' ')}${e.http_status ? ` → HTTP ${e.http_status}` : ''}`)
  push('Kind', e.kind)
  push('Severity', e.severity)
  push('Category', e.category)
  push('Error code', e.code)
  push('Outcome', e.outcome)
  push('Message', e.message)
  if (detail.group) {
    const g = detail.group
    lines.push(`Grouped occurrences: ${g.occurrence_count} (first seen ${g.first_seen_at}, last seen ${g.last_seen_at}; fingerprint ${t(g.fingerprint, 64)})`)
  }
  const c = (e.client ?? {}) as Record<string, unknown>
  const device = [c.browser, c.os, c.device, c.viewport ? `viewport ${c.viewport}` : null, c.online === false ? 'offline' : null].filter(Boolean).map(v => t(v, 60))
  if (device.length) lines.push(`Browser/device: ${device.join(' · ')}`)
  const details = sanitizeDetails(e.details ?? {})
  if (Object.keys(details).length) {
    lines.push('Details (sanitized):')
    lines.push(JSON.stringify(details, null, 2))
  }
  if (e.stack) {
    lines.push('Stack (sanitized):')
    lines.push(sanitizeStack(e.stack))
  }
  if (detail.related?.length) {
    lines.push('Related events (linked by recorded ids only):')
    for (const r of detail.related.slice(0, 20)) {
      lines.push(`- ${r.occurred_at} ${t(r.reference_id, 64)} · ${r.source}${r.http_status ? ` · HTTP ${r.http_status}` : ''}${r.api_route ? ` · ${t(r.api_route, 200)}` : ''} · ${LINK_LABEL[r.link] ?? r.link}${r.counted === false ? ' · not counted separately' : ''} · ${t(r.message, 200)}`)
    }
  } else {
    lines.push('Related events: none recorded')
  }
  lines.push('')
  lines.push('Not included: user identity, organization, request bodies, credentials, tokens, query strings.')
  return lines.join('\n')
}
