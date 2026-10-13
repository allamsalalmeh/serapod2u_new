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

/** Build identifier inlined at build time (next.config.js → NEXT_PUBLIC_APP_BUILD). */
export function appBuild(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.NEXT_PUBLIC_APP_BUILD ?? '').trim()
  return /^[A-Za-z0-9._+-]{1,64}$/.test(raw) ? raw : 'unknown'
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
