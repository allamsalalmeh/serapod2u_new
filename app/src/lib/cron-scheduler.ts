import cron from 'node-cron'
import { randomUUID } from 'node:crypto'
import { remoteDbWorkerBlockReason, REMOTE_DB_WORKER_OVERRIDE_ENV } from './cron/remote-db-guard'

/**
 * Internal Cron Scheduler for Coolify / self-hosted deployments.
 *
 * Replaces vercel.json cron definitions. Each job sends an HTTP GET
 * to the existing /api/cron/* endpoints with the CRON_SECRET header,
 * exactly as Vercel Cron would.
 *
 * The schedule runs inside the long‑lived Next.js Node process,
 * so it only works on persistent servers (Coolify, VPS, Docker) —
 * NOT on serverless (Vercel, AWS Lambda).
 */

interface CronJob {
  path: string
  schedule: string
  /** Absent means "always scheduled". Evaluated once, at registration. */
  enabled?: (env?: NodeJS.ProcessEnv) => boolean
}

const CRON_JOBS: CronJob[] = [
  { path: '/api/cron/qr-reverse-worker', schedule: '*/1 * * * *' },
  { path: '/api/cron/qr-generation-worker', schedule: '*/1 * * * *' },
  { path: '/api/cron/manufacturer-packing-worker', schedule: '*/1 * * * *' },
  { path: '/api/cron/notification-outbox-worker', schedule: '*/1 * * * *' },
  // Security & Access: bounded retention of ordinary shadow authorization
  // decisions (90 days). Daily; the database function is idempotent.
  { path: '/api/cron/sa-decision-retention', schedule: '17 3 * * *' },
  // Security & Access governance: expire time-boxed access, delegations and
  // stale requests every 15 minutes; the worker re-syncs the Joiner/Mover/
  // Leaver lifecycle once a day (contract end dates, missed triggers).
  { path: '/api/cron/sa-governance-maintenance', schedule: '*/15 * * * *' },
  // Outdoor orders unpaid for 24 hours are cancelled and their Stripe page closed.
  { path: '/api/cron/storefront-unpaid-expiry', schedule: '*/15 * * * *' },
  // TikTok Shop API: hourly sync of connected shops (no-op when none is connected).
  { path: '/api/cron/tiktok-shop-sync', schedule: '23 * * * *' },
  // Serapp 1-hour warehouse acceptance holds — expire unaccepted orders & release
  // stock. Opt-in: see serappHoldExpiryEnabled.
  {
    path: '/api/cron/serapp-hold-expiry',
    schedule: '*/5 * * * *',
    enabled: serappHoldExpiryEnabled,
  },
]

/**
 * Opt-in gate for the Serapp hold-expiry worker.
 *
 * Why opt-in rather than always-on: Serapp order holds are not a released
 * feature, and an environment that has not received the Serapp migrations has
 * no public.serapp_order_holds for the worker to read. Scheduling it there
 * produces nothing but a 500 every five minutes, and the moment the table does
 * appear an unreleased worker would begin expiring live holds on its own. So
 * the schedule stays off until an environment explicitly asks for it.
 *
 * This gates the SCHEDULE only. The route keeps working for anyone who calls
 * it, so enabling the feature later is an env change, not a deploy.
 *
 * Mirrors the spellings accepted by internalCronWorkersDisabled, inverted:
 * absent or a falsey spelling means not scheduled.
 */
export function serappHoldExpiryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ENABLE_SERAPP_HOLD_EXPIRY
  if (raw === undefined || raw === null) return false

  const value = String(raw).trim().toLowerCase()
  if (value === '') return false

  return !['0', 'false', 'off', 'no'].includes(value)
}

function normalizeBaseUrl(rawUrl: string): string {
  const withProtocol = rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`
  const parsed = new URL(withProtocol)

  if (parsed.hostname.startsWith('www.')) {
    parsed.hostname = parsed.hostname.slice(4)
  }

  parsed.pathname = ''
  parsed.search = ''
  parsed.hash = ''

  return parsed.toString().replace(/\/$/, '')
}

function getBaseUrl(): string {
  const coolifyHost = process.env.COOLIFY_FQDN
    ?.split(',')
    .map((value) => value.trim())
    .find(Boolean)

  const configuredUrl =
    process.env.INTERNAL_CRON_BASE_URL ||
    coolifyHost ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL

  if (configuredUrl) {
    return normalizeBaseUrl(configuredUrl)
  }

  return `http://localhost:${process.env.PORT || 3000}`
}

async function fetchCronEndpoint(url: string, secret?: string): Promise<Response> {
  const headers: Record<string, string> = secret ? { Authorization: `Bearer ${secret}` } : {}
  const response = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(55_000),
  })

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location) {
      const redirectedUrl = new URL(location, url).toString()
      return fetch(redirectedUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(55_000),
      })
    }
  }

  return response
}

async function triggerJob(path: string, expression: string): Promise<void> {
  // Secondary safety net; see claimDispatchSlot.
  if (!claimDispatchSlot(path, expression, Date.now())) return

  const url = `${getBaseUrl()}${path}`
  const secret = process.env.CRON_SECRET || process.env.WORKER_SECRET

  try {
    const res = await fetchCronEndpoint(url, secret)

    if (!res.ok) {
      console.warn(`[Cron] ${path} responded ${res.status}`)
    }
  } catch (err: any) {
    // Don't crash the scheduler on transient failures
    if (err.name === 'TimeoutError') {
      console.warn(`[Cron] ${path} timed out`)
    } else {
      console.warn(`[Cron] ${path} error: ${err.message}`)
    }
  }
}

/**
 * PROCESS-GLOBAL scheduler registry.
 *
 * Root cause this exists for: the Next.js standalone production runtime
 * evaluates this module TWICE inside the same Node process. Each evaluation
 * previously got its own `let started = false` and registered its own four
 * node-cron tasks, so every worker was invoked ~2x/minute. Confirmed in
 * production by two distinct scheduler instance ids arriving on authenticated
 * internal cron requests while only one container and one PID existed.
 *
 * Module-scoped state (let/const/Set/Map) is duplicated along with the module
 * and therefore CANNOT own this. The registry is hung off globalThis under a
 * Symbol.for key, which is shared across every evaluation in the process.
 */
const REGISTRY_KEY = Symbol.for('serapod2u.cron.scheduler.registry')

interface CronSchedulerRegistry {
  started: boolean
  schedulerInstanceId: string
  registeredPaths: Set<string>
  /** path -> cron period index already dispatched (secondary guard) */
  lastDispatchPeriod: Map<string, number>
  /** Keeps the "workers disabled" notice to one line per process. */
  disabledNoticeLogged: boolean
}

type RegistryHolder = typeof globalThis & {
  [REGISTRY_KEY]?: CronSchedulerRegistry
}

function getRegistry(): CronSchedulerRegistry {
  const holder = globalThis as RegistryHolder
  if (!holder[REGISTRY_KEY]) {
    holder[REGISTRY_KEY] = {
      started: false,
      schedulerInstanceId: randomUUID().slice(0, 8),
      registeredPaths: new Set<string>(),
      lastDispatchPeriod: new Map<string, number>(),
      disabledNoticeLogged: false,
    }
  }
  return holder[REGISTRY_KEY]
}

/** Exported for tests only. */
export function __resetCronRegistryForTests(): void {
  delete (globalThis as RegistryHolder)[REGISTRY_KEY]
}

/** Exported for tests only. */
export function __getCronRegistryForTests(): CronSchedulerRegistry {
  return getRegistry()
}

/**
 * Kill switch for the internal cron workers.
 *
 * Why an explicit flag rather than a NODE_ENV check: a developer's localhost
 * commonly points at a SHARED database, and these workers write to it — running
 * `next dev` to review a UI would quietly mutate staging. But development is
 * also exactly where someone may need the workers running on purpose, so the
 * environment alone must never decide. Only this flag disables them, and its
 * absence leaves staging and production behaviour untouched.
 *
 * Accepts the usual falsey spellings so `DISABLE_INTERNAL_CRON_WORKERS=0`
 * means what it looks like it means.
 */
export function internalCronWorkersDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.DISABLE_INTERNAL_CRON_WORKERS
  if (raw === undefined || raw === null) return false

  const value = String(raw).trim().toLowerCase()
  if (value === '') return false

  return !['0', 'false', 'off', 'no'].includes(value)
}

/** A 5-field expression is minute-granular; a 6-field one carries seconds. */
export function isMinuteGranular(expression: string): boolean {
  return expression.trim().split(/\s+/).length === 5
}

/**
 * Secondary safety net, retained deliberately.
 *
 * Preventing duplicate registration is the primary fix. This additionally caps
 * a minute-granular path at one dispatch per minute per PROCESS, so any future
 * mechanism that manages to call triggerJob twice in a tick still cannot double
 * dispatch. Its state lives in the same global registry - a module-local Map
 * would be duplicated exactly like the state that caused the original bug.
 *
 * Sub-minute (6-field) schedules are never suppressed.
 */
export function claimDispatchSlot(path: string, expression: string, now: number): boolean {
  if (!isMinuteGranular(expression)) return true
  const registry = getRegistry()
  const period = Math.floor(now / 60_000)
  if (registry.lastDispatchPeriod.get(path) === period) return false
  registry.lastDispatchPeriod.set(path, period)
  return true
}

export function startCronScheduler(): void {
  const registry = getRegistry()

  // Checked before the started flag is claimed and before any cron.schedule
  // call, so a disabled process registers nothing at all — not a registered
  // task that later declines to fire.
  if (internalCronWorkersDisabled()) {
    if (!registry.disabledNoticeLogged) {
      registry.disabledNoticeLogged = true
      console.log('[Cron] Internal cron workers DISABLED by DISABLE_INTERNAL_CRON_WORKERS — no workers registered')
    }
    return
  }

  // Same principle for a local process pointed at a shared remote database:
  // register nothing unless explicitly overridden. Each worker route also
  // enforces this, so a manual call cannot bypass it.
  const remoteDbBlock = remoteDbWorkerBlockReason()
  if (remoteDbBlock) {
    if (!registry.disabledNoticeLogged) {
      registry.disabledNoticeLogged = true
      console.log(
        `[Cron] Internal cron workers NOT registered: ${remoteDbBlock} (set ${REMOTE_DB_WORKER_OVERRIDE_ENV}=true to override)`
      )
    }
    return
  }

  if (registry.started) {
    // Reached when the runtime evaluates this module a second time. One concise
    // line, emitted at most once per extra evaluation - not per tick.
    console.warn(
      `[Cron] Duplicate scheduler initialization suppressed (owner=${registry.schedulerInstanceId})`
    )
    return
  }
  registry.started = true

  console.log('[Cron] Starting internal cron scheduler (Coolify mode)')
  console.log(`[Cron] Scheduler instance: ${registry.schedulerInstanceId}`)
  console.log(`[Cron] Base URL: ${getBaseUrl()}`)
  console.log(`[Cron] CRON_SECRET: ${process.env.CRON_SECRET ? 'set' : 'NOT SET'}`)

  for (const job of CRON_JOBS) {
    // Checked before registration so a gated-off job registers no task at all,
    // rather than a task that fires and then declines to do anything.
    if (job.enabled && !job.enabled()) {
      console.log(`[Cron] Not scheduled: ${job.path} — feature not enabled in this environment`)
      continue
    }

    if (registry.registeredPaths.has(job.path)) {
      console.warn(`[Cron] ${job.path} already registered - skipping`)
      continue
    }
    registry.registeredPaths.add(job.path)

    cron.schedule(job.schedule, () => {
      triggerJob(job.path, job.schedule)
    })
    console.log(`[Cron] Scheduled: ${job.path} → ${job.schedule}`)
  }

  console.log(`[Cron] Registered ${registry.registeredPaths.size} worker route(s)`)
}
