/**
 * Browser side of the System Logs contract.
 *
 *   reportClientError(error, context)  explicit, handled operational failures (the main source of coverage:
 *                                      global listeners never see errors a component catches and shows in a toast)
 *   installGlobalErrorListeners()      window "error" + "unhandledrejection" (uncaught only)
 *
 * Delivery is best effort and bounded: at most 20 queued reports, batches of ≤ 10 / ≤ 30 KB, three retries with
 * back-off for network/5xx failures, a 15-minute expiry, and a sessionStorage copy so a reload can retry. Nothing is
 * delivered while the browser is offline, after the tab is closed before a flush, or while the server is unavailable.
 * Identity, organization and environment are NOT sent: the server derives them from the session.
 */
import {
  LIMITS, classifyFailure, digestCorrelationId, isNoise, isReferenceId, moduleFromPath, newReferenceId, normalizeForFingerprint,
  reportedByDefault, type BrowserReport, type LogCategory,
} from './contract'
import { sanitizePath } from './sanitize'

export const REPORT_ENDPOINT = '/api/system-logs/report'

export interface ClientReportContext {
  module?: string
  action?: string
  /** Failed fetch Response: its status, URL path and X-Request-ID (server reference) are used. */
  response?: Response | null
  /** Parsed error body of that response (`{ error, code, referenceId }`), when the caller already read it. */
  body?: unknown
  status?: number
  apiRoute?: string
  method?: string
  serverReferenceId?: string | null
  correlationId?: string | null
  code?: string
  category?: LogCategory
  details?: Record<string, unknown>
  /** Send routine categories (validation, permission, not found, conflict, auth) too. Off by default. */
  reportWarnings?: boolean
}

const MAX_QUEUE = 20
const DEDUPE_MS = 10_000
const EXPIRY_MS = 15 * 60_000
const RETRY_DELAYS = [2_000, 10_000, 30_000]
const STORAGE_KEY = 'system-logs:pending'

interface Pending { report: BrowserReport; attempts: number; expiresAt: number }
interface ReporterState {
  queue: Pending[]
  timer: ReturnType<typeof setTimeout> | null
  inflight: boolean
  disabledUntil: number
  recent: Map<string, { ref: string; at: number }>
  listeners: boolean
  restored: boolean
}

const KEY = Symbol.for('serapod2u.system-logs.client')
function st(): ReporterState {
  const g = globalThis as any
  g[KEY] ??= { queue: [], timer: null, inflight: false, disabledUntil: 0, recent: new Map(), listeners: false, restored: false }
  return g[KEY]
}

/** Exported for tests only. */
export function __resetClientReporterForTests() {
  const s = (globalThis as any)[KEY] as ReporterState | undefined
  if (s?.timer) clearTimeout(s.timer)
  delete (globalThis as any)[KEY]
}
export const __clientQueueForTests = () => st().queue

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined'

function factsOf(error: unknown) {
  const e = (error ?? {}) as any
  return {
    name: typeof e?.name === 'string' ? e.name : undefined,
    message: typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : undefined,
    code: e?.code !== undefined && e?.code !== null ? String(e.code) : undefined,
    status: typeof e?.status === 'number' ? e.status : undefined,
    stack: typeof e?.stack === 'string' ? e.stack : undefined,
    digest: typeof e?.digest === 'string' ? e.digest : undefined,
    details: typeof e?.details === 'string' ? e.details : undefined,
    hint: typeof e?.hint === 'string' ? e.hint : undefined,
  }
}

function bodyFacts(body: unknown) {
  const b = (body ?? {}) as any
  return {
    message: typeof b?.error === 'string' ? b.error : typeof b?.message === 'string' ? b.message : undefined,
    code: typeof b?.code === 'string' ? b.code : undefined,
    referenceId: isReferenceId(b?.referenceId) ? b.referenceId as string : undefined,
  }
}

function pathOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try { return new URL(url, isBrowser() ? window.location.origin : 'http://localhost').pathname } catch { return undefined }
}

/** Builds a report, or null when the failure is not a diagnostic (cancelled, routine, noise). Exported for tests. */
export function buildClientReport(error: unknown, ctx: ClientReportContext = {}): BrowserReport | null {
  const f = factsOf(error)
  const b = bodyFacts(ctx.body)
  const status = ctx.status ?? ctx.response?.status ?? f.status
  const message = (f.message || b.message || (status ? `HTTP ${status}` : '') || 'Unknown error').slice(0, LIMITS.message)
  if (isNoise(message, f.stack) || isNoise(f.digest)) return null
  const offline = isBrowser() && typeof navigator !== 'undefined' && navigator.onLine === false
  const code = ctx.code ?? f.code ?? b.code
  const category = ctx.category ?? classifyFailure({ status, name: f.name, message, code, offline })
  if (category === 'cancelled') return null
  if (!reportedByDefault(category) && !ctx.reportWarnings) return null
  const pagePath = isBrowser() ? sanitizePath(window.location.pathname) : undefined
  const serverRef = ctx.serverReferenceId ?? b.referenceId ?? ctx.response?.headers?.get?.('x-request-id') ?? undefined
  const apiRoute = ctx.apiRoute ?? pathOf(ctx.response?.url)
  const details: Record<string, unknown> = { ...(ctx.details ?? {}) }
  if (f.details) details.db_details = f.details.slice(0, 300)
  if (f.hint) details.db_hint = f.hint.slice(0, 300)
  return {
    referenceId: newReferenceId('ERR'),
    occurredAt: new Date().toISOString(),
    category,
    message,
    name: f.name?.slice(0, 80),
    code: code?.slice(0, LIMITS.code),
    module: (ctx.module ?? (pagePath ? moduleFromPath(pagePath) : undefined))?.slice(0, LIMITS.module),
    action: ctx.action?.slice(0, LIMITS.action),
    pagePath,
    apiRoute: apiRoute ? sanitizePath(apiRoute) : undefined,
    httpMethod: ctx.method?.toUpperCase(),
    httpStatus: typeof status === 'number' ? status : undefined,
    stack: f.stack?.slice(0, LIMITS.stack),
    correlationId: (isReferenceId(ctx.correlationId) ? ctx.correlationId : digestCorrelationId(f.digest)) ?? undefined,
    serverReferenceId: isReferenceId(serverRef) ? serverRef : undefined,
    appBuild: process.env.NEXT_PUBLIC_APP_BUILD || undefined,
    viewport: isBrowser() ? `${window.innerWidth}x${window.innerHeight}` : undefined,
    online: offline ? false : undefined,
    details: Object.keys(details).length ? details : undefined,
  }
}

/**
 * Report a handled operational failure. Returns a reference id to show the user ("Reference: ERR-…"), or null when
 * nothing is reported (cancellation, routine validation/permission outcome, hot-reload noise). Never throws.
 */
export function reportClientError(error: unknown, ctx: ClientReportContext = {}): string | null {
  try {
    if (!isBrowser()) return null
    const report = buildClientReport(error, ctx)
    if (!report) return null
    const s = st()
    restorePending()
    // The same failure repeating within 10 s (re-renders, retries) is reported once.
    const key = [report.category, report.module, report.action, report.pagePath, report.apiRoute, normalizeForFingerprint(report.message)].join('|')
    const now = Date.now()
    for (const [k, v] of s.recent) if (now - v.at > DEDUPE_MS) s.recent.delete(k)
    const seen = s.recent.get(key)
    if (seen) return seen.ref
    s.recent.set(key, { ref: report.referenceId, at: now })
    if (now < s.disabledUntil) return report.referenceId
    s.queue.push({ report, attempts: 0, expiresAt: now + EXPIRY_MS })
    if (s.queue.length > MAX_QUEUE) s.queue.splice(0, s.queue.length - MAX_QUEUE)
    persist()
    schedule(1_500)
    return report.referenceId
  } catch {
    return null
  }
}

/** " (Reference: ERR-…)" for toasts; empty when there is no reference. */
export function referenceSuffix(ref: string | null | undefined): string {
  return ref ? ` (Reference: ${ref})` : ''
}

function schedule(ms: number) {
  const s = st()
  if (s.timer) return
  s.timer = setTimeout(() => { s.timer = null; void flush() }, ms)
}

function persist() {
  try {
    const s = st()
    window.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(s.queue.slice(-MAX_QUEUE)))
  } catch { /* storage unavailable (private mode / quota): memory only */ }
}

function restorePending() {
  const s = st()
  if (s.restored || !isBrowser()) return
  s.restored = true
  try {
    const raw = window.sessionStorage?.getItem(STORAGE_KEY)
    if (!raw) return
    const items = JSON.parse(raw) as Pending[]
    const now = Date.now()
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.report && isReferenceId(item.report.referenceId) && item.expiresAt > now && !s.queue.some(q => q.report.referenceId === item.report.referenceId)) {
        s.queue.push({ report: item.report, attempts: Number(item.attempts) || 0, expiresAt: item.expiresAt })
      }
    }
    if (s.queue.length > MAX_QUEUE) s.queue.splice(0, s.queue.length - MAX_QUEUE)
    if (s.queue.length) schedule(3_000)
  } catch { /* ignore corrupt storage */ }
}

/** Sends one batch. Exported for tests. */
export async function flush(): Promise<void> {
  const s = st()
  if (s.inflight || !isBrowser()) return
  const now = Date.now()
  s.queue = s.queue.filter(p => p.expiresAt > now)
  if (!s.queue.length) { persist(); return }
  if (now < s.disabledUntil) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    window.addEventListener('online', () => schedule(1_000), { once: true })
    return
  }
  const batch: Pending[] = []
  let size = 2
  for (const p of s.queue) {
    const len = JSON.stringify(p.report).length + 1
    if (batch.length >= LIMITS.batchEvents || size + len > LIMITS.batchBytes - 200) break
    batch.push(p); size += len
  }
  if (!batch.length) { s.queue.shift(); persist(); return } // a single oversized report cannot be sent
  s.inflight = true
  let retry = false
  try {
    const res = await fetch(REPORT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch.map(p => p.report) }),
      keepalive: true,
      credentials: 'same-origin',
    })
    if (res.ok || res.status === 400 || res.status === 413) {
      drop(batch)
    } else if (res.status === 401 || res.status === 403) {
      // Signed out / not allowed to report: stop for a while, do not retry these.
      drop(batch); s.disabledUntil = Date.now() + 10 * 60_000
    } else if (res.status === 429) {
      const after = Number(res.headers.get('retry-after')) || 60
      s.disabledUntil = Date.now() + Math.min(after, 600) * 1000
      retry = true
    } else {
      retry = true
    }
  } catch {
    retry = true
  } finally {
    s.inflight = false
  }
  if (retry) {
    for (const p of batch) p.attempts += 1
    s.queue = s.queue.filter(p => p.attempts <= RETRY_DELAYS.length)
    const attempts = Math.max(...batch.map(p => p.attempts))
    persist()
    if (s.queue.length && attempts <= RETRY_DELAYS.length) schedule(Math.max(RETRY_DELAYS[attempts - 1] ?? 30_000, s.disabledUntil - Date.now()))
    return
  }
  persist()
  if (s.queue.length) schedule(500)
}

function drop(batch: Pending[]) {
  const s = st()
  const refs = new Set(batch.map(p => p.report.referenceId))
  s.queue = s.queue.filter(p => !refs.has(p.report.referenceId))
}

/**
 * Uncaught browser errors and unhandled promise rejections. Idempotent. Handled errors (caught and shown in a toast)
 * are NOT visible here; those call reportClientError explicitly.
 */
export function installGlobalErrorListeners(): () => void {
  const s = st()
  if (!isBrowser() || s.listeners) return () => {}
  s.listeners = true
  restorePending()
  const onError = (event: ErrorEvent) => {
    // Resource load failures (img/script) reach window only in the capture phase; this listener is bubble-phase.
    if (!event.error && !event.message) return
    if (event.filename && !event.filename.startsWith(window.location.origin) && !event.error) return
    reportClientError(event.error ?? event.message, { action: 'Uncaught error', category: event.error ? undefined : 'unexpected' })
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    reportClientError(event.reason, { action: 'Unhandled promise rejection' })
  }
  const onHide = () => { persist(); void flush() }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('pagehide', onHide)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('pagehide', onHide)
    s.listeners = false
  }
}
