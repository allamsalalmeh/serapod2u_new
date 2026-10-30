/**
 * HR Wave 3 — tiny browser client for the attendance / overtime / leave routes. Success is reported only when the
 * server answered `success: true`; every refusal carries the server's caller-safe message (never a false success).
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string; status: number }

async function parse<T>(res: Response): Promise<ApiResult<T>> {
  const json = await res.json().catch(() => null)
  if (res.ok && json && json.success === true) return { ok: true, data: json.data as T }
  return {
    ok: false,
    error: (json && typeof json.error === 'string' && json.error) || 'The request could not be completed. Please try again.',
    code: (json && typeof json.code === 'string' && json.code) || (res.status === 503 ? 'NOT_AVAILABLE' : 'ERROR'),
    status: res.status,
  }
}

export async function apiGet<T>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<ApiResult<T>> {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== null && v !== undefined && v !== '') q.set(k, String(v))
  try {
    return await parse<T>(await fetch(q.toString() ? `${path}?${q}` : path, { cache: 'no-store' }))
  } catch {
    return { ok: false, error: 'The server could not be reached. Check your connection and try again.', code: 'NETWORK', status: 0 }
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    return await parse<T>(await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
  } catch {
    return { ok: false, error: 'The server could not be reached. Check your connection and try again.', code: 'NETWORK', status: 0 }
  }
}

/** Local YYYY-MM-DD of a Date (browser time zone; the database uses the company time zone for work dates). */
export function isoDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return dt.toISOString().slice(0, 10)
}
export const timeOf = (iso: string | null | undefined, tz = 'Asia/Kuala_Lumpur') =>
  iso ? new Date(iso).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }) : '--:--'
export const dateLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric', month: 'short' })
/** A random idempotency key for one submission (retries of the same click reuse it). */
export const newIdempotencyKey = () =>
  (globalThis.crypto && 'randomUUID' in globalThis.crypto ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`)
