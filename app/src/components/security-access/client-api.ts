'use client'

import { notifyNavAccessChanged } from '@/hooks/useNavAccess'

export interface ApiResult<T = any> { ok: boolean; data?: T; error?: string; code?: string }

/** JSON helper for the Security & Access admin API; errors are human-readable. */
export async function callApi<T = any>(url: string, init?: { method?: string; body?: unknown; /** A read-only POST (a preflight): changes nothing, so the shell is not told to re-read access. */ readOnly?: boolean }): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: init?.method ?? (init?.body ? 'POST' : 'GET'),
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) return { ok: false, error: data?.error || `Request failed (${response.status})`, code: data?.code }
    // A successful change (assignment, revocation, policy, request decision) may change what this shell may show:
    // tell it to re-read its answers now instead of waiting for the next navigation or focus.
    if ((init?.method ?? (init?.body ? 'POST' : 'GET')) !== 'GET' && !init?.readOnly) notifyNavAccessChanged()
    return { ok: true, data }
  } catch {
    return { ok: false, error: 'Network error' }
  }
}

export const one = (value: any) => (Array.isArray(value) ? value[0] : value)

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

/** datetime-local input value → ISO string (or null). */
export function toIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export const SOURCE_LABELS: Record<string, { label: string; tone: string; help: string }> = {
  backfill: { label: 'Lifecycle', tone: 'bg-slate-100 text-slate-700', help: 'Derived from HR / User Management facts (compatibility or baseline access).' },
  derived: { label: 'Lifecycle', tone: 'bg-slate-100 text-slate-700', help: 'Derived from HR / User Management facts (compatibility or baseline access).' },
  manual: { label: 'Granted', tone: 'bg-blue-50 text-blue-700', help: 'Granted by a Security & Access administrator.' },
  access_request: { label: 'Approved request', tone: 'bg-violet-50 text-violet-700', help: 'Granted by an approved access request.' },
}
