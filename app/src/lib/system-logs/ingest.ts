import { z } from 'zod'
import { LIMITS, LOG_CATEGORIES, REFERENCE_PATTERN, fingerprintOf, severityFor, type IngestPayload } from './contract'
import { describeUserAgent, sanitizeDetails, sanitizeLabel, sanitizePath, sanitizeStack, sanitizeText } from './sanitize'

/**
 * Validation + server-side construction of a stored browser report (used by POST /api/system-logs/report).
 * Unknown keys (actor, organization, environment, source, kind, severity, fingerprint …) are stripped by the schema,
 * so a browser can never choose them.
 */
const str = (max: number) => z.string().max(max * 4).transform(v => v.slice(0, max))
export const browserEventSchema = z.object({
  referenceId: z.string().regex(REFERENCE_PATTERN),
  occurredAt: z.string().max(40).optional(),
  category: z.enum(LOG_CATEGORIES),
  message: str(LIMITS.message),
  name: str(80).optional(),
  code: str(LIMITS.code).optional(),
  module: str(LIMITS.module).optional(),
  action: str(LIMITS.action).optional(),
  pagePath: str(LIMITS.path * 2).optional(),
  apiRoute: str(LIMITS.path * 2).optional(),
  httpMethod: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional(),
  httpStatus: z.number().int().min(0).max(599).optional(),
  stack: str(LIMITS.stack).optional(),
  correlationId: z.string().regex(REFERENCE_PATTERN).optional(),
  serverReferenceId: z.string().regex(REFERENCE_PATTERN).optional(),
  appBuild: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/).optional(),
  viewport: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
  online: z.boolean().optional(),
  details: z.record(z.unknown()).optional(),
})
export const reportBodySchema = z.object({ events: z.array(z.unknown()).min(1).max(LIMITS.batchEvents) })
export type BrowserEvent = z.infer<typeof browserEventSchema>
export type ReportBody = z.infer<typeof reportBodySchema>

/** Server-built payload: identity, environment, source and severity are never taken from the browser. */
export function toBrowserPayload(
  ev: BrowserEvent,
  ctx: { actorId: string; organizationId: string | null; environment: IngestPayload['environment']; serverBuild: string; ua: ReturnType<typeof describeUserAgent> },
): IngestPayload {
  const message = sanitizeText(ev.message) || 'Unknown error'
  const module = sanitizeLabel(ev.module, LIMITS.module)
  const action = sanitizeLabel(ev.action, LIMITS.action)
  const code = sanitizeLabel(ev.code, LIMITS.code)
  const apiRoute = ev.apiRoute ? sanitizePath(ev.apiRoute) : null
  const stack = ev.stack ? sanitizeStack(ev.stack) : null
  const occurred = ev.occurredAt && !Number.isNaN(Date.parse(ev.occurredAt)) ? new Date(ev.occurredAt).toISOString() : new Date().toISOString()
  return {
    kind: 'error',
    reference_id: ev.referenceId,
    occurred_at: occurred,
    source: 'browser',
    environment: ctx.environment,
    // The failing code is the browser's bundle (a stale tab can run an older build than the server).
    app_build: ev.appBuild ?? ctx.serverBuild,
    fingerprint: fingerprintOf({ source: 'browser', category: ev.category, code, module, action, route: apiRoute, message, stack }),
    category: ev.category,
    severity: severityFor(ev.category),
    message,
    actor_id: ctx.actorId,
    organization_id: ctx.organizationId,
    code,
    module,
    action,
    page_path: ev.pagePath ? sanitizePath(ev.pagePath) : null,
    api_route: apiRoute,
    http_method: ev.httpMethod ?? null,
    http_status: ev.httpStatus ?? null,
    stack,
    correlation_id: ev.correlationId ?? null,
    server_reference_id: ev.serverReferenceId ?? null,
    details: sanitizeDetails({ ...(ev.details ?? {}), ...(ev.name ? { error_name: ev.name } : {}) }),
    client: {
      ...ctx.ua,
      ...(ev.viewport ? { viewport: ev.viewport } : {}),
      ...(ev.online === false ? { online: false } : {}),
      ...(ev.appBuild && ev.appBuild !== ctx.serverBuild ? { server_build: ctx.serverBuild } : {}),
    },
  }
}
