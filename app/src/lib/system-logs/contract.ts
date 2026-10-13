/**
 * System Logs — the ONE diagnostic contract shared by the browser reporter, server/API reporter and background jobs.
 *
 * Isomorphic and dependency-free (no server imports). Storage is public.system_log_events / system_log_groups
 * (supabase/migrations/20261017100000_system_logs_foundation.sql); limits here mirror that file's CHECK constraints.
 *
 * Nothing in this contract makes a browser value authoritative: actor, organization, environment, source and kind are
 * always decided by the server (see lib/system-logs/server.ts and app/api/system-logs/report/route.ts).
 */

export const SYSTEM_LOG_PERMISSION = 'platform.system_logs.view'

export const LOG_SOURCES = ['browser', 'server', 'worker'] as const
export type LogSource = (typeof LOG_SOURCES)[number]

export const LOG_ENVIRONMENTS = ['production', 'staging', 'local', 'development', 'test'] as const
export type LogEnvironment = (typeof LOG_ENVIRONMENTS)[number]

export const LOG_SEVERITIES = ['error', 'warning', 'info'] as const
export type LogSeverity = (typeof LOG_SEVERITIES)[number]

export const LOG_CATEGORIES = [
  'network', 'timeout', 'authentication', 'permission', 'validation', 'not_found',
  'conflict', 'rate_limited', 'server', 'unexpected', 'cancelled',
] as const
export type LogCategory = (typeof LOG_CATEGORIES)[number]

export const ACTIVITY_OUTCOMES = ['success', 'failure', 'denied'] as const
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number]

/** Database limits (CHECK constraints). Sanitizers truncate to these before storage. */
export const LIMITS = {
  message: 1000,
  stack: 8000,
  module: 80,
  action: 160,
  code: 80,
  path: 300,
  appBuild: 64,
  detailsBytes: 8000,
  /** Browser → server: one request carries at most this many events and this many bytes. */
  batchEvents: 10,
  batchBytes: 32_000,
} as const

export const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$/

/**
 * Categories that are routine (expected user/session outcomes). They are WARNINGS: never shown in the default Errors
 * view, and the browser reporter does not send them unless the caller explicitly asks (reportWarnings).
 */
const WARNING_CATEGORIES: ReadonlySet<LogCategory> = new Set([
  'authentication', 'permission', 'validation', 'not_found', 'conflict', 'rate_limited',
])

export function severityFor(category: LogCategory): LogSeverity {
  if (category === 'cancelled') return 'info'
  return WARNING_CATEGORIES.has(category) ? 'warning' : 'error'
}

export interface FailureFacts {
  /** HTTP status when the failure is an HTTP response. 0 = no response (network). */
  status?: number | null
  name?: string | null
  message?: string | null
  /** Postgres SQLSTATE, PostgREST code (PGRSTxxx) or an application code such as sa_forbidden. */
  code?: string | null
  /** navigator.onLine === false at the time of failure. */
  offline?: boolean
}

const has = (value: string, ...needles: string[]) => needles.some(n => value.includes(n))

/**
 * Classifies a failure from observable facts only. Network failures, timeouts, authentication, permission denials,
 * validation and unexpected exceptions are kept apart so routine outcomes do not flood the Errors view.
 */
export function classifyFailure(facts: FailureFacts): LogCategory {
  const name = String(facts.name ?? '').toLowerCase()
  const message = String(facts.message ?? '').toLowerCase()
  const code = String(facts.code ?? '').toUpperCase()
  const status = typeof facts.status === 'number' ? facts.status : null

  if (name === 'aborterror' || has(message, 'aborted', 'the operation was aborted', 'request cancelled', 'request canceled')) return 'cancelled'
  if (name === 'timeouterror' || code === '57014' || status === 408 || status === 504 || has(message, 'timed out', 'timeout')) return 'timeout'
  if (facts.offline || status === 0 || code.startsWith('08') ||
      has(message, 'failed to fetch', 'networkerror', 'network error', 'network request failed', 'load failed', 'net::err', 'fetch failed', 'econnrefused', 'econnreset', 'enotfound')) return 'network'
  if (status === 401 || code === 'PGRST301' || code === 'PGRST302' || has(message, 'jwt expired', 'invalid jwt', 'refresh token', 'not authenticated', 'unauthorized - please log in')) return 'authentication'
  if (status === 403 || code === '42501' || code === 'SA_FORBIDDEN' || has(message, 'permission denied', 'row-level security', 'forbidden')) return 'permission'
  if (status === 429 || has(message, 'rate limit', 'too many requests')) return 'rate_limited'
  if (status === 404 || code === 'PGRST116') return 'not_found'
  if (status === 409 || code === '23505' || code === '40001') return 'conflict'
  if (status === 400 || status === 422 || code === '22023' || code === '22P02' || code === '23502' || code === '23514' || code === '23503' || name === 'zoderror') return 'validation'
  if (status !== null && status >= 500) return 'server'
  return 'unexpected'
}

/** True when the browser should send this category without an explicit request. */
export function reportedByDefault(category: LogCategory): boolean {
  return severityFor(category) === 'error'
}

// ── Reference ids ────────────────────────────────────────────────

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32 (no I, L, O, U)

function randomChars(length: number): string {
  const bytes = new Uint8Array(length)
  const cryptoObj = (globalThis as any).crypto
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes)
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  let out = ''
  for (const b of bytes) out += ALPHABET[b & 31]
  return out
}

/** Reference shown to users ("ERR-7K3M9QX2TB4R") and stored with the occurrence. */
export function newReferenceId(prefix: 'ERR' | 'REQ' | 'JOB' = 'ERR'): string {
  return `${prefix}-${randomChars(12)}`
}

export function isReferenceId(value: unknown): value is string {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value)
}

/** Next.js error digest → correlation id shared by the server render report and the browser error boundary. */
export function digestCorrelationId(digest: unknown): string | null {
  if (typeof digest !== 'string') return null
  const clean = digest.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 56)
  return clean.length >= 2 ? `DIG-${clean}` : null
}

// ── Fingerprints ────────────────────────────────────────────────

/** Volatile parts (ids, numbers, quoted values) removed so repeats of one failure group together. */
export function normalizeForFingerprint(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b(err|req|job|act)-[0-9a-z]{6,}\b/g, '<ref>')
    .replace(/(["'`])(?:(?!\1).){1,120}\1/g, '<s>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
}

/** First stack frame's function/file name without line or column numbers (stable across builds of the same code). */
export function topFrame(stack: string | null | undefined): string {
  if (!stack) return ''
  for (const raw of stack.split('\n').slice(0, 12)) {
    const line = raw.trim()
    if (!line || !/^(at |[\w$.<>]*@)/.test(line)) continue
    return line.replace(/:\d+(:\d+)?\)?$/, '').replace(/\?[^\s)]*/g, '').replace(/\s+/g, ' ').slice(0, 160)
  }
  return ''
}

/** 64-bit (two 32-bit lanes) FNV-1a style hash → 16 hex chars. Deterministic in Node and browsers. */
export function hash64(input: string): string {
  let h1 = 0x811c9dc5 ^ 0
  let h2 = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x5bd1e995)
    h2 ^= h2 >>> 15
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

export interface FingerprintParts {
  source: LogSource
  category: LogCategory
  code?: string | null
  module?: string | null
  action?: string | null
  route?: string | null
  message: string
  stack?: string | null
}

export function fingerprintOf(parts: FingerprintParts): string {
  return hash64([
    parts.source, parts.category, (parts.code ?? '').toUpperCase(), (parts.module ?? '').toLowerCase(),
    (parts.action ?? '').toLowerCase(), normalizeRoute(parts.route ?? ''), normalizeForFingerprint(parts.message), topFrame(parts.stack),
  ].join('|'))
}

/** '/api/orders/3f2c…/items' → '/api/orders/:id/items' (ids never split groups). */
export function normalizeRoute(route: string): string {
  return route
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
}

// ── Dev hot-reload / browser noise ─────────────────────────────

const NOISE_PATTERNS = [
  /\[hmr\]/i, /\[fast refresh\]/i, /hot[-_ ]update/i, /webpack-hmr/i, /turbopack.*hmr/i, /__nextjs_original-stack-frame/i,
  /ResizeObserver loop/i, /^Script error\.?$/i, /chrome-extension:\/\//i, /moz-extension:\/\//i, /safari-(web-)?extension:\/\//i,
  /NEXT_REDIRECT/, /NEXT_NOT_FOUND/, /NEXT_HTTP_ERROR_FALLBACK/, /DYNAMIC_SERVER_USAGE/,
]

/** Hot-reload chatter, browser-extension errors and Next.js control-flow signals are not diagnostics. */
export function isNoise(message: string | null | undefined, stack?: string | null): boolean {
  const texts = [String(message ?? '').trim(), (stack ?? '').slice(0, 2000)].filter(Boolean)
  return texts.some(text => NOISE_PATTERNS.some(p => p.test(text)))
}

// ── Wire shapes ─────────────────────────────────────────────────

/** What the browser may send (everything else is derived by the server). */
export interface BrowserReport {
  referenceId: string
  occurredAt: string
  category: LogCategory
  message: string
  name?: string
  code?: string
  module?: string
  action?: string
  pagePath?: string
  apiRoute?: string
  httpMethod?: string
  httpStatus?: number
  stack?: string
  correlationId?: string
  serverReferenceId?: string
  appBuild?: string
  viewport?: string
  online?: boolean
  details?: Record<string, unknown>
}

/** Stored diagnostic shape passed to public.system_log_ingest (server-built only). */
export interface IngestPayload {
  kind: 'error'
  reference_id: string
  occurred_at: string
  source: LogSource
  environment: LogEnvironment
  app_build: string
  fingerprint: string
  category: LogCategory
  severity: LogSeverity
  message: string
  actor_id: string | null
  organization_id: string | null
  code?: string | null
  module?: string | null
  action?: string | null
  page_path?: string | null
  api_route?: string | null
  http_method?: string | null
  http_status?: number | null
  stack?: string | null
  correlation_id?: string | null
  server_reference_id?: string | null
  details?: Record<string, unknown>
  client?: Record<string, unknown>
}

// ── Module labels ───────────────────────────────────────────────

/** Coarse module label from a route path ('/api/hr/…' → 'HR'); 'Other' when unknown. Display/grouping only. */
export function moduleFromPath(path: string): string {
  const p = path.replace(/^\/api/, '').toLowerCase()
  const table: Array<[RegExp, string]> = [
    [/^\/(orders|supply-chain|documents|shipping|returns)/, 'Supply Chain'], [/^\/(inventory|warehouse|stock)/, 'Inventory'],
    [/^\/(hr|attendance|payroll|leave)/, 'HR'], [/^\/(finance|accounting)/, 'Finance'], [/^\/(security-access)/, 'Security & Access'],
    [/^\/(users|admin\/users|identity)/, 'User Management'], [/^\/(settings|notifications)/, 'Settings'], [/^\/(qr|track|verify|scan)/, 'QR & Traceability'],
    [/^\/(catalog|products|engagement|loyalty|admin\/(shop|consumer))/, 'Product Catalog'], [/^\/(crm|customer-growth|marketing|wa)/, 'Customer & Growth'],
    [/^\/(ecommerce|store|storefront|outdoor)/, 'E-Commerce'], [/^\/(roadtour|rt)/, 'RoadTour'], [/^\/(cron)/, 'Background jobs'],
    [/^\/(system-logs)/, 'System Logs'], [/^\/(dashboard|reporting)/, 'Dashboard'], [/^\/(manufacturer|manufacturing)/, 'Manufacturing'],
  ]
  return table.find(([re]) => re.test(p))?.[1] ?? 'Other'
}
