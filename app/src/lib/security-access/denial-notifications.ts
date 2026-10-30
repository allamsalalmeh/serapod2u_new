'use client'

import { permissionLabel } from './labels'
import { classifyPermission, moduleGroupName } from './modules'
import { isReferenceId } from '@/lib/system-logs/contract'

export interface DenialNotice { title: string; description: string; variant: 'destructive' }
/** API 403 responses are authoritative denials. Known reason codes refine safe text; raw backend text is never displayed. */
export function denialNotice(status: number, body: any): DenialNotice | null {
  if (status === 401) return { title: 'Session expired', description: 'Sign in again to continue.', variant: 'destructive' }
  if (status === 503 && body?.code === 'sa_unavailable') return {
    title: 'Authorization unavailable', description: 'Access could not be checked. Please retry shortly.', variant: 'destructive',
  }
  if (status !== 403) return null
  const messages: Record<string, string> = {
    STEP_UP_REQUIRED: 'Additional authentication is required to perform this action.',
    SCOPE_MISMATCH: 'This action is outside your authorized organization or data scope. Contact your administrator.',
    WRONG_ORGANIZATION_SCOPE: 'This action is outside your authorized organization or data scope. Contact your administrator.',
    ACCOUNT_INACTIVE: 'Your account is inactive. Contact your administrator.',
    MISSING_MEMBERSHIP: 'An active organization membership is required. Contact your administrator.',
    SEPARATION_OF_DUTIES_DENIED: 'This action requires a different authorized person.',
    PRIVILEGED_OPERATION_RESTRICTED: 'This action requires privileged access and administrator review.',
  }
  const message = messages[body?.reason] ?? "You don't have permission to perform this action. Contact your administrator if you need access."
  const action = body?.code === 'sa_forbidden' && typeof body.permission === 'string' && /^[a-z_]+\.[a-z_]+\.[a-z_]+$/.test(body.permission)
    ? ` ${moduleGroupName(classifyPermission(body.permission).groupId)}: ${permissionLabel(body.permission).label}.` : ''
  return { title: 'Access Denied', description: message + action + (isReferenceId(body?.referenceId) ? ` Reference: ${body.referenceId}` : ''), variant: 'destructive' }
}

/** Observe existing fetch consumers without consuming/changing their response or duplicating server logs.
 * Scoped to our own API; Supabase, external services, assets and streaming responses are untouched.
 */
export function installDenialNotifications(notify: (notice: DenialNotice) => void): () => void {
  const original = window.fetch
  const recent = new Map<string, number>()
  const wrapped: typeof fetch = async (input, init) => {
    const response = await original.call(window, input, init)
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const url = new URL(raw, window.location.href)
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/') ||
          ![401, 403, 503].includes(response.status) || !response.headers.get('content-type')?.includes('application/json')) return response
      // Await the small denial envelope so the notice is available before existing error consumers run.
      const method = String(init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase()
      // The page already owns direct-navigation feedback; don't toast its background reads.
      if (response.status === 403 && ['GET', 'HEAD'].includes(method) && document.querySelector('[data-access-state="denied"]')) return response
      const body = await response.clone().json()
      const notice = denialNotice(response.status, body)
      if (notice) {
        const now = Date.now()
        for (const [key, until] of recent) if (until <= now) recent.delete(key)
        const key = JSON.stringify([response.status, body?.code, body?.reason, body?.permission])
        if (!recent.has(key) && recent.size < 100) { recent.set(key, now + 10_000); notify(notice) }
      }
    } catch { /* Diagnostics must never break a response consumer. */ }
    return response
  }
  window.fetch = wrapped
  return () => { if (window.fetch === wrapped) window.fetch = original }
}
