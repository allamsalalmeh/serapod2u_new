'use client'

import { useEffect, useState } from 'react'

type CapabilityAnswer = { allowed: boolean; enforced: boolean }

/**
 * Equivalent requests that are in flight at the same moment (same permission and organization, e.g. StrictMode's second
 * effect or two components asking for the same permission) share one request. Nothing is kept once it settles, so a
 * later call (another account, after a grant or revocation) always asks again.
 */
const inflight = new Map<string, Promise<any>>()
function fetchCapability(url: string): Promise<any> {
  const shared = inflight.get(url)
  if (shared) return shared
  const request: Promise<any> = fetch(url, { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .finally(() => { if (inflight.get(url) === request) inflight.delete(url) })
  inflight.set(url, request)
  return request
}

/**
 * Whether to show an action the server will decide through Security & Access.
 *
 * Asks /api/security-access/me/capabilities for the caller's own S&A answer.
 * Once the permission is enforced the S&A answer decides; until then (or if
 * the lookup fails) the screen's historical rule (`legacyAllowed`) is used, so
 * nothing changes before cut-over. While loading, the action is hidden. The
 * server always decides the operation itself; this only avoids showing
 * controls that would be refused (or hiding ones that would be allowed).
 */
export function useSaCapability(permission: string, legacyAllowed: boolean, organizationId?: string | null, warehouseId?: string | null): boolean {
  return useSaCapabilityState(permission, legacyAllowed, organizationId, warehouseId).allowed
}

/** Same answer plus whether it is still being looked up (for screens that show a "checking" state). */
export function useSaCapabilityState(permission: string, legacyAllowed: boolean, organizationId?: string | null, warehouseId?: string | null): { allowed: boolean; loading: boolean } {
  const [answer, setAnswer] = useState<CapabilityAnswer | null | 'failed'>(null)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ permissions: permission })
    if (organizationId) params.set('organizationId', organizationId)
    // Warehouse-owned operations (e.g. Stock Count) are answered for that warehouse, like the server decides them.
    if (warehouseId) params.set('warehouseId', warehouseId)
    fetchCapability(`/api/security-access/me/capabilities?${params.toString()}`)
      .then(body => {
        if (cancelled) return
        const value = body?.capabilities?.[permission]
        setAnswer(value && typeof value.allowed === 'boolean' ? value : 'failed')
      })
      .catch(() => { if (!cancelled) setAnswer('failed') })
    return () => { cancelled = true }
  }, [permission, organizationId, warehouseId])

  if (answer === null) return { allowed: false, loading: true }
  if (answer === 'failed' || !answer.enforced) return { allowed: legacyAllowed, loading: false }
  return { allowed: answer.allowed, loading: false }
}

export type SaCapabilityCheck = { status: 'checking' | 'allowed' | 'denied' | 'failed'; retry: () => void }

/**
 * Same decision as useSaCapability, for an action that should report a failed lookup instead of guessing: a failed
 * request is 'failed' (with `retry`), never silently replaced by the legacy rule — the screen cannot know whether S&A
 * or the legacy rule decides until the lookup answers. Once answered: the S&A answer when enforced, else `legacyAllowed`.
 */
export function useSaCapabilityCheck(permission: string, legacyAllowed: boolean, organizationId?: string | null): SaCapabilityCheck {
  const [answer, setAnswer] = useState<CapabilityAnswer | null | 'failed'>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setAnswer(null)
    const params = new URLSearchParams({ permissions: permission })
    if (organizationId) params.set('organizationId', organizationId)
    fetchCapability(`/api/security-access/me/capabilities?${params.toString()}`)
      .then(body => {
        if (cancelled) return
        const value = body?.capabilities?.[permission]
        // The server marks a mode/decision lookup that errored as unavailable: that is a failed check, not a denial.
        setAnswer(value && typeof value.allowed === 'boolean' && typeof value.enforced === 'boolean' && !value.unavailable ? value : 'failed')
      })
      .catch(() => { if (!cancelled) setAnswer('failed') })
    return () => { cancelled = true }
  }, [permission, organizationId, attempt])

  const retry = () => setAttempt(n => n + 1)
  if (answer === null) return { status: 'checking', retry }
  if (answer === 'failed') return { status: 'failed', retry }
  const allowed = answer.enforced ? answer.allowed : legacyAllowed
  return { status: allowed ? 'allowed' : 'denied', retry }
}
