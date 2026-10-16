'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Explicit load states for a Security & Access read model. Each is rendered
 * differently; none is inferred from an empty or missing body:
 *   loading          first load for this account/organization, nothing to show yet
 *   ready            a successful response (empty lists are real, measured empties)
 *   schema_missing   the server verified a specific missing table/relationship
 *   denied           a recorded policy denial (403): protected data is cleared
 *   unauthenticated  the session expired (401): protected data is cleared
 *   unavailable      the server or network could not answer (503 / 5xx / offline)
 */
export type LoadStatus = 'loading' | 'ready' | 'schema_missing' | 'denied' | 'unauthenticated' | 'unavailable'

export interface ReadModel<T> {
  status: LoadStatus
  /** Last verified data for the current account/organization (kept while a refresh is in flight or fails transiently). */
  data: T | null
  /** True while a newer request is in flight and earlier data is still shown. */
  refreshing: boolean
  /** A refresh failed transiently while earlier verified data is still shown. */
  stale: boolean
  error: string | null
  correlationId: string | null
}

type Outcome<T> = { status: LoadStatus; data: T | null; error: string | null; correlationId: string | null }

/** Maps one HTTP response to a load outcome (exported for tests). */
export async function readOutcome<T>(response: Response, isSchemaMissing?: (body: any) => boolean): Promise<Outcome<T>> {
  const body: any = await response.json().catch(() => null)
  const correlationId = response.headers?.get?.('x-correlation-id') ?? body?.correlationId ?? null
  if (response.ok) {
    if (body && isSchemaMissing?.(body)) return { status: 'schema_missing', data: body, error: body.error ?? null, correlationId }
    if (body && typeof body === 'object') return { status: 'ready', data: body as T, error: null, correlationId }
    return { status: 'unavailable', data: null, error: 'The server returned an unreadable response.', correlationId }
  }
  if (response.status === 401) return { status: 'unauthenticated', data: null, error: body?.error || 'Your session has expired. Sign in again.', correlationId }
  if (response.status === 403) return { status: 'denied', data: null, error: 'You do not have access to this information.', correlationId }
  return { status: 'unavailable', data: null, error: body?.error || `The service did not respond (${response.status}).`, correlationId }
}

const INITIAL: ReadModel<any> = { status: 'loading', data: null, refreshing: false, stale: false, error: null, correlationId: null }

/**
 * Loads `url` for one account/organization (`scopeKey`). Guarantees:
 * - only the latest request may update state (earlier ones are aborted and ignored);
 * - a scope change (account switch, organization change) clears data immediately;
 * - a transient failure keeps verified data (marked stale), a 401/403 clears it;
 * - no automatic retries: `reload()` is the explicit Retry.
 */
export function useReadModel<T = any>(url: string | null, scopeKey: string, options: { isSchemaMissing?: (body: any) => boolean } = {}) {
  const [state, setState] = useState<ReadModel<T>>(INITIAL)
  const seq = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const scopeRef = useRef(scopeKey)
  const schemaCheck = useRef(options.isSchemaMissing)
  schemaCheck.current = options.isSchemaMissing

  const reload = useCallback(() => {
    if (!url) return
    const id = ++seq.current
    controller.current?.abort()
    const ac = new AbortController()
    controller.current = ac
    setState(prev => ({ ...prev, refreshing: prev.data !== null, status: prev.data !== null ? prev.status : 'loading', error: prev.data !== null ? prev.error : null }))
    fetch(url, { cache: 'no-store', signal: ac.signal })
      .then(response => readOutcome<T>(response, schemaCheck.current))
      .catch((error): Outcome<T> | null => (ac.signal.aborted ? null : { status: 'unavailable', data: null, error: 'Network error. Check your connection and retry.', correlationId: null }))
      .then(outcome => {
        // Superseded (newer request, scope change or unmount): never overwrite newer state.
        if (!outcome || id !== seq.current) return
        setState(prev => {
          if (outcome.status === 'unavailable' && prev.data !== null) {
            return { ...prev, refreshing: false, stale: true, error: outcome.error, correlationId: outcome.correlationId }
          }
          return { status: outcome.status, data: outcome.data, refreshing: false, stale: false, error: outcome.error, correlationId: outcome.correlationId }
        })
      })
  }, [url])

  useEffect(() => {
    if (scopeRef.current !== scopeKey) {
      // Another account or organization: nothing verified for the previous one may remain visible.
      scopeRef.current = scopeKey
      setState(INITIAL)
    }
    reload()
    return () => { seq.current++; controller.current?.abort() }
  }, [reload, scopeKey])

  return { ...state, reload }
}
