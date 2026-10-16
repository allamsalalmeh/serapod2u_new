'use client'

import { useEffect, useState } from 'react'

/**
 * Whether the signed-in user may open System Logs, and the server's environment (GET /api/system-logs/access, decided
 * by Security & Access without writing an audit row). Cached per tab. Presentation only: the page and the data APIs
 * authorize every request.
 */
export interface SystemLogsAccessInfo { allowed: boolean; environment?: string }

let pending: Promise<SystemLogsAccessInfo> | null = null

export function fetchSystemLogsAccess(): Promise<SystemLogsAccessInfo> {
  pending ??= fetch('/api/system-logs/access', { cache: 'no-store', credentials: 'same-origin' })
    .then(res => (res.ok ? res.json() : { allowed: false }))
    .then(body => ({ allowed: body?.allowed === true, environment: typeof body?.environment === 'string' ? body.environment : undefined }))
    .catch(() => { pending = null; return { allowed: false } })
  return pending
}

/** Exported for tests only. */
export function __resetSystemLogsAccessCache() { pending = null }

export function useSystemLogsAccessInfo(): SystemLogsAccessInfo | null {
  const [info, setInfo] = useState<SystemLogsAccessInfo | null>(null)
  useEffect(() => {
    let active = true
    fetchSystemLogsAccess().then(value => { if (active) setInfo(value) })
    return () => { active = false }
  }, [])
  return info
}

export function useSystemLogsAccess(): boolean {
  return useSystemLogsAccessInfo()?.allowed === true
}
