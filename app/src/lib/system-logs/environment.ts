import { LOG_ENVIRONMENTS, type LogEnvironment } from './contract'

/**
 * Environment of THIS server process, from trusted runtime configuration only (never from a request).
 *
 * Localhost shares the staging database, so a local `next dev` must never be recorded as "staging":
 *   1. SYSTEM_LOG_ENVIRONMENT (explicit; recommended on every deployment: production | staging | development).
 *   2. NODE_ENV test → 'test'; any non-production NODE_ENV (next dev) → 'local'.
 *   3. Production build: the configured app host (NEXT_PUBLIC_APP_URL, else COOLIFY_FQDN). Loopback → 'local',
 *      a 'stg'/'staging' label → 'staging', a 'dev' label → 'development', otherwise 'production'.
 */
export function resolveRuntimeEnvironment(env: NodeJS.ProcessEnv = process.env): LogEnvironment {
  const explicit = String(env.SYSTEM_LOG_ENVIRONMENT ?? '').trim().toLowerCase()
  if ((LOG_ENVIRONMENTS as readonly string[]).includes(explicit)) return explicit as LogEnvironment
  if (env.NODE_ENV === 'test' || env.VITEST) return 'test'
  if (env.NODE_ENV !== 'production') return 'local'
  const host = hostOf(env.NEXT_PUBLIC_APP_URL) ?? hostOf(env.COOLIFY_FQDN?.split(',')[0])
  if (!host || isLoopback(host)) return 'local'
  if (/(^|[.-])(stg|staging)([.-]|$)/.test(host)) return 'staging'
  if (/(^|[.-])dev([.-]|$)/.test(host)) return 'development'
  return 'production'
}

const BUILD_ID_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/

/**
 * Build identifier, resolved from trusted runtime configuration only (never from a request).
 *
 * Order: the build-time-inlined NEXT_PUBLIC_APP_BUILD, then an explicit APP_BUILD_ID, then the
 * deployment commit (SOURCE_COMMIT / GIT_COMMIT_SHA — Coolify sets these at runtime on the container).
 * Falling back to the runtime commit fixes the "App build: unknown" gap on self-hosted deployments,
 * where the build-time inlining of NEXT_PUBLIC_APP_BUILD does not survive the standalone server bundle.
 */
export function appBuild(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.NEXT_PUBLIC_APP_BUILD,
    env.APP_BUILD_ID,
    env.SOURCE_COMMIT,
    env.GIT_COMMIT_SHA,
  ]
  for (const raw of candidates) {
    const value = String(raw ?? '').trim()
    if (BUILD_ID_PATTERN.test(value)) return value.slice(0, 64)
  }
  return 'unknown'
}

function hostOf(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

function isLoopback(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host) || host.endsWith('.localhost') || host.startsWith('127.')
}
