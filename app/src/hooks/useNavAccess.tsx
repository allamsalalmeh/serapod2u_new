'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { filterGroupsByDestination, snapshotAllows, snapshotAllowsAny, type NavAccessSnapshot } from '@/lib/security-access/nav-access'

/**
 *   loading      first answer not received yet: UNRESOLVED, neither allowed nor denied (the sidebar shows a skeleton)
 *   ready        the server's answers for this account and organization
 *   unavailable  the permission checks could not be completed (network/service): NOT a denial; nothing gated is shown
 *   signed_out   the login expired
 *   denied       the account is not active
 */
export type NavAccessStatus = 'loading' | 'ready' | 'unavailable' | 'signed_out' | 'denied'

export interface NavAccessValue {
  status: NavAccessStatus
  snapshot: NavAccessSnapshot | null
  allows: (destinationId: string) => boolean
  allowsAny: (destinationIds: readonly string[]) => boolean
  /** Re-check now (Retry). A failed check restarts from `loading`; a ready answer stays visible until the new one arrives. */
  refresh: () => void
}

/** A shown answer older than this is revalidated in the background when the tab regains focus or a shell mounts. */
const STALE_AFTER_MS = 60_000
/** Window event other screens dispatch after changing access (assignment, revocation, profile/organization change). */
export const NAV_ACCESS_CHANGED_EVENT = 'sa:nav-access-changed'

const NavAccessContext = createContext<NavAccessValue | null>(null)

type Result = { status: NavAccessStatus; snapshot: NavAccessSnapshot | null }
type Held = Result & { key: string; at: number }

/**
 * Client store shared by every shell. Each page renders its own shell, so the provider remounts on navigation; this
 * module-level state is what keeps an ordinary route change from re-asking (and from blinking the menu):
 *
 *  - `cache` holds ONE `ready` answer, for one verified user + organization. Any other identity replaces it, a sign-out or a
 *    failed/denied/signed-out answer drops it, and it is never shown after REMEMBER_MS. It only affects what is shown;
 *    the server decides every route, API and mutation again.
 *  - `inflight` shares one request between equivalent callers (same identity key), so a shell remount, a focus event or
 *    StrictMode's double effect does not send a second request. A result is stored only if no invalidation happened
 *    since the request started (`generation`), so a late response from an obsolete session/identity is ignored.
 * The server never populates it (fetches run in effects), so server-rendered HTML never carries another user's answers.
 */
let cache: Held | null = null
let generation = 0
const inflight = new Map<string, Promise<Result>>()
/** A remembered answer older than this is not shown at all (a long-idle tab starts from loading). */
const REMEMBER_MS = 5 * 60_000
/** A request that has not answered by then is reported as unavailable (Retry), never left as an endless skeleton. */
const REQUEST_TIMEOUT_MS = 20_000

const canRemember = () => typeof window !== 'undefined'
const remembered = (key: string): Held | null => (cache && cache.key === key && Date.now() - cache.at < REMEMBER_MS ? cache : null)

/** Forget everything held for navigation (sign-out, identity change). In-flight answers started before this are ignored. */
export function clearNavAccessCache(): void {
  cache = null
  generation++
  inflight.clear()
}

async function requestNavAccess(key: string, force: boolean): Promise<Result> {
  if (force) { generation++; inflight.delete(key) }
  const shared = inflight.get(key)
  if (shared) return shared

  const startedIn = generation
  const [uid, org] = key.split(':')
  const run = async (): Promise<Result> => {
    try {
      const res = await fetch('/api/security-access/me/navigation', { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (res.status === 401) return { status: 'signed_out', snapshot: null }
      if (res.status === 403) return { status: 'denied', snapshot: null }
      if (!res.ok) return { status: 'unavailable', snapshot: null }
      const body = await res.json()
      const snapshot = body?.snapshot as NavAccessSnapshot | undefined
      // A response that names another identity is discarded, never shown.
      if (body?.status !== 'ready' || !snapshot || snapshot.userId !== uid || (snapshot.organizationId ?? '') !== org) {
        return { status: 'unavailable', snapshot: null }
      }
      return { status: 'ready', snapshot }
    } catch {
      return { status: 'unavailable', snapshot: null }
    }
  }
  const promise = run().then(result => {
    if (inflight.get(key) === promise) inflight.delete(key)
    if (startedIn === generation && canRemember()) {
      cache = result.status === 'ready' ? { ...result, key, at: Date.now() } : null
    }
    return result
  })
  inflight.set(key, promise)
  return promise
}

/**
 * One request for /api/security-access/me/navigation per signed-in identity, shared by the sidebar, the module top
 * navigation, landing cards and in-page actions. The held answer is keyed by the verified user and organization: a
 * different account or organization never sees the previous one's answers (it is `loading` until its own answer
 * arrives). Answers are revalidated after a minute when the tab regains focus and whenever access changes in the app.
 */
export function NavAccessProvider({ userId, organizationId, children }: { userId: string; organizationId: string | null; children: ReactNode }) {
  const key = `${userId}:${organizationId ?? ''}`
  const [held, setHeld] = useState<Held | null>(() => remembered(key))
  const keyRef = useRef(key)
  keyRef.current = key
  const callId = useRef(0)

  const load = useCallback(async (force = false) => {
    const id = ++callId.current
    const forKey = keyRef.current
    const result = await requestNavAccess(forKey, force)
    // Late or superseded answers (another call, another identity) are ignored.
    if (id !== callId.current || forKey !== keyRef.current) return
    setHeld({ ...result, key: forKey, at: Date.now() })
  }, [])

  useEffect(() => {
    // A different identity never inherits the previous answers.
    const known = remembered(key)
    setHeld(prev => (prev && prev.key === key ? prev : known))
    // A fresh remembered answer is reused as is: an ordinary route change does not re-ask.
    if (!known || Date.now() - known.at >= STALE_AFTER_MS) void load()
  }, [key, load])

  useEffect(() => {
    const refreshIfStale = () => {
      if (document.visibilityState === 'hidden') return
      const current = remembered(keyRef.current)
      if (!current || Date.now() - current.at >= STALE_AFTER_MS) void load()
    }
    const onChanged = () => { void load(true) }
    document.addEventListener('visibilitychange', refreshIfStale)
    window.addEventListener('focus', refreshIfStale)
    window.addEventListener(NAV_ACCESS_CHANGED_EVENT, onChanged)
    return () => {
      document.removeEventListener('visibilitychange', refreshIfStale)
      window.removeEventListener('focus', refreshIfStale)
      window.removeEventListener(NAV_ACCESS_CHANGED_EVENT, onChanged)
    }
  }, [load])

  const current = held && held.key === key ? held : null
  const value = useMemo<NavAccessValue>(() => {
    const snapshot = current?.status === 'ready' ? current.snapshot : null
    return {
      status: current?.status ?? 'loading',
      snapshot,
      allows: id => snapshotAllows(snapshot, id),
      allowsAny: ids => snapshotAllowsAny(snapshot, ids),
      refresh: () => {
        if (current?.status !== 'ready') setHeld(null)
        void load(true)
      },
    }
  }, [current, load])

  return <NavAccessContext.Provider value={value}>{children}</NavAccessContext.Provider>
}

const FALLBACK: NavAccessValue = {
  status: 'loading', snapshot: null, allows: () => false, allowsAny: () => false, refresh: () => {},
}

/** Outside a provider nothing gated is shown. */
export function useNavAccess(): NavAccessValue {
  return useContext(NavAccessContext) ?? FALLBACK
}

/** Tell every mounted shell that access changed so it re-reads its answers (call after a successful access change). */
export function notifyNavAccessChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NAV_ACCESS_CHANGED_EVENT))
}

/** A module's nav groups reduced to what this person may open (nothing until the answers are ready). */
export function useAccessibleNavGroups<G extends { children: readonly { id: string }[] }>(groups: readonly G[]): G[] {
  const { snapshot, allows } = useNavAccess()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => filterGroupsByDestination(groups, allows), [groups, snapshot])
}
