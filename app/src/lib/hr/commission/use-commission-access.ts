'use client'

import { useCallback, useEffect, useState } from 'react'
import { NO_COMMISSION_ACCESS, type CommissionAccess, type CommissionPermission } from '@/lib/security-access/commission'

/**
 * The caller's commission permissions for showing/hiding commission UI. Hiding is never authorization: every API and
 * database function checks again. Fails closed (no access) while loading or on error.
 */
export function useCommissionAccess() {
  const [access, setAccess] = useState<CommissionAccess>(NO_COMMISSION_ACCESS)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/api/hr/commission/access', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (!cancelled && json?.access) setAccess(json.access) })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])
  const can = useCallback((p: CommissionPermission) => access[p] === true, [access])
  return { access, loaded, can }
}

/** JSON helper for the commission API: throws the server's human message on failure. */
export async function commissionApi<T = any>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || json?.success === false) throw new Error(json?.error || `Request failed (${res.status})`)
  return json as T
}
