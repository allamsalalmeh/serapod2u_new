/**
 * System Logs sanitization — applied on the SERVER before anything is stored (browser input is untrusted), and again
 * when a diagnostic report is copied. Isomorphic so the browser can pre-trim its own payload, but the server never
 * relies on that.
 *
 * Removes: passwords, tokens, JWTs, cookies, authorization headers, API keys, bank/card/identity numbers, phone
 * numbers, e-mail addresses, URL query strings/fragments, and request bodies. Keeps record UUIDs (needed to find the
 * row) and short codes such as order numbers.
 */
import { LIMITS } from './contract'

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
const IS_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const SECRET_NAMES = 'authorization|proxy-authorization|cookie|set-cookie|x-api-key|apikey|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|service[_-]?role(?:[_-]?key)?|token|secret|client[_-]?secret|password|passwd|pwd|new_password|otp|pin|security[_-]?code|signature|session(?:[_-]?id)?'

const TEXT_RULES: Array<[RegExp, string | ((m: string, ...rest: string[]) => string)]> = [
  // JWTs (Supabase access tokens, service-role keys).
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g, '[jwt]'],
  // Authorization schemes.
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} [redacted]`],
  // name=value / "name": "value" / name: value for secret-bearing names.
  [new RegExp(`(["']?)\\b(${SECRET_NAMES})\\b\\1(\\s*[:=]\\s*)(["']?)[^\\s"'&,;}]+\\4`, 'gi'), (_m, q, name, sep, vq) => `${q}${name}${q}${sep}${vq}[redacted]${vq}`],
  // Supabase auth cookies and provider keys.
  [/\bsb-[A-Za-z0-9]+-auth-token(?:\.\d+)?(?:=[^\s;]+)?/g, '[cookie]'],
  [/\b(?:sk|pk|rk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}/g, '[key]'],
  [/\b(?:ghp|gho|github_pat|xox[abpr])_[A-Za-z0-9_]{10,}/g, '[key]'],
  // E-mail addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // URL query strings and fragments (may carry tokens, codes, personal data).
  [/(https?:\/\/[^\s?#"'<>()]+)[?#][^\s"'<>()]*/g, (_m, base) => `${base}?[query]`],
  // Digit runs of 9+ digits (phone, bank account, card, IC/passport numbers), with spaces/dashes.
  [/(?<![\w./-])\+?\d[\d\s-]{7,}\d(?![\w-])/g, (m) => (m.replace(/\D/g, '').length >= 9 ? '[number]' : m)],
]

/** Redacts secrets and personal data from free text (messages, stack lines, detail strings). */
export function sanitizeText(input: unknown, max: number = LIMITS.message): string {
  if (input === null || input === undefined) return ''
  let text = typeof input === 'string' ? input : String(input)
  // Keep UUIDs intact (record ids) while number rules run.
  const kept: string[] = []
  text = text.replace(UUID, (m) => { kept.push(m); return `\u0000${kept.length - 1}\u0000` })
  for (const [pattern, replacement] of TEXT_RULES) text = text.replace(pattern, replacement as any)
  text = text.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)] ?? '')
  // Control characters out, whitespace collapsed (multi-line text keeps its newlines).
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const TOKEN_ROUTE_PREFIXES = ['track', 'verify', 'scan', 'auth', 'reset-password', 'invite', 's', 'rt', 'lp', 'r']

/**
 * Page path / API route without query, fragment or token-like segments.
 * '/track/product/PROD-ab12…?sc=9' → '/track/product/:token'.
 */
export function sanitizePath(input: unknown): string {
  if (typeof input !== 'string' || !input) return ''
  let path = input.trim()
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname
  } catch {
    return ''
  }
  path = path.split(/[?#]/)[0]
  const segments = path.split('/')
  const first = segments[1]?.toLowerCase() ?? ''
  const tokenRoute = TOKEN_ROUTE_PREFIXES.includes(first)
  const out = segments.map((seg, i) => {
    if (i === 0 || !seg) return seg
    let s = seg
    try { s = decodeURIComponent(seg) } catch { /* keep raw */ }
    if (IS_UUID.test(s)) return s
    // Token routes (/track/product/<code>, /verify/<code>): any segment after the first that is not a plain word.
    if (tokenRoute && i >= 2 && !/^[a-z][a-z-]{1,20}$/.test(s)) return ':token'
    if (s.length >= 24 || /^eyJ/.test(s) || s.includes('@') || s.replace(/\D/g, '').length >= 9) return ':token'
    return s.replace(/[^\w.:~-]/g, '_')
  })
  const result = out.join('/') || '/'
  return result.length > LIMITS.path ? result.slice(0, LIMITS.path) : result
}

const SENSITIVE_KEY = /pass|pwd|token|secret|auth|cookie|session|api[-_]?key|credential|bank|iban|swift|account[-_]?(no|num)|card|cvv|cvc|nric|passport|ic[-_]?(no|num)|otp|\bpin\b|signature|phone|mobile|email|address|^body$|payload|request[-_]?body|form[-_]?data|headers?$/i

/**
 * Bounded, sanitized metadata: depth ≤ 3, ≤ 25 keys per object, ≤ 10 array items, strings ≤ 300 chars, total ≤ 8 KB.
 * Keys that may carry secrets or personal data are dropped entirely (not masked).
 */
export function sanitizeDetails(value: unknown, depth = 0): Record<string, unknown> {
  const result = sanitizeValue(value, depth)
  const obj = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {}
  const json = JSON.stringify(obj)
  if (json.length <= LIMITS.detailsBytes) return obj
  // Too large: keep scalar top-level keys only.
  const trimmed: Record<string, unknown> = { _truncated: true }
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) trimmed[k] = v
    if (JSON.stringify(trimmed).length > LIMITS.detailsBytes - 200) break
  }
  return trimmed
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return sanitizeText(value, 300)
  if (typeof value === 'bigint') return value.toString()
  if (depth >= 3) return '[depth]'
  if (Array.isArray(value)) return value.slice(0, 10).map(v => sanitizeValue(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    let n = 0
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n >= 25) { out._more = true; break }
      const key = k.slice(0, 60)
      if (SENSITIVE_KEY.test(key)) continue
      out[key] = sanitizeValue(v, depth + 1)
      n++
    }
    return out
  }
  return null
}

/** Stack: ≤ 30 frames, file paths shortened to their last segments, query strings and secrets removed. */
export function sanitizeStack(input: unknown): string {
  if (typeof input !== 'string' || !input) return ''
  const lines = input.split('\n').slice(0, 31).map(line => {
    const shortened = line
      .replace(/\?[^\s:)]*/g, '')
      .replace(/(?:webpack-internal:\/\/\/|file:\/\/|turbopack:\/\/\/?)\.?/g, '')
      .replace(/(?:https?:\/\/[^\s/)]+)?((?:\/[^\s/():]+)+)(?=[:)\s]|$)/g, (_m, p: string) => {
        const parts = p.split('/').filter(Boolean)
        return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : `/${parts.join('/')}`
      })
    return sanitizeText(shortened, 400)
  })
  const text = lines.join('\n')
  return text.length > LIMITS.stack ? text.slice(0, LIMITS.stack) : text
}

/** Short label of a free-form identifier field (module/action/code). */
export function sanitizeLabel(input: unknown, max: number): string | null {
  if (typeof input !== 'string') return null
  const text = sanitizeText(input, max).replace(/[\r\n]+/g, ' ')
  return text || null
}

/** Browser/OS/device from a User-Agent header (coarse; nothing identifying). */
export function describeUserAgent(ua: string | null | undefined): { browser?: string; os?: string; device?: string } {
  if (!ua) return {}
  const s = ua.slice(0, 400)
  const browser =
    /Edg\/(\d+)/.exec(s) ? `Edge ${/Edg\/(\d+)/.exec(s)![1]}` :
    /OPR\/(\d+)/.exec(s) ? `Opera ${/OPR\/(\d+)/.exec(s)![1]}` :
    /SamsungBrowser\/(\d+)/.exec(s) ? `Samsung Internet ${/SamsungBrowser\/(\d+)/.exec(s)![1]}` :
    /Chrome\/(\d+)/.exec(s) ? `Chrome ${/Chrome\/(\d+)/.exec(s)![1]}` :
    /Firefox\/(\d+)/.exec(s) ? `Firefox ${/Firefox\/(\d+)/.exec(s)![1]}` :
    /Version\/(\d+).*Safari/.exec(s) ? `Safari ${/Version\/(\d+).*Safari/.exec(s)![1]}` : undefined
  const os = /Windows NT/.test(s) ? 'Windows' : /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android'
    : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : undefined
  const device = /iPad|Tablet/.test(s) ? 'tablet' : /Mobi|iPhone|Android/.test(s) ? 'mobile' : 'desktop'
  return { browser, os, device }
}
