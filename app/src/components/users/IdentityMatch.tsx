'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, BadgeCheck, Loader2, UserCheck } from 'lucide-react'
import type { IdentityLookupResult } from '@/lib/identity/lookup'
import { validatePhoneNumber } from '@/lib/utils'
import { FOCUS } from '@/components/security-access/ui'

export type LookupState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** The server answered: the administrator may not create users in this organization (confirmed, explained). */
  | { phase: 'denied'; reason: string }
  /** The check itself could not run (network, service, permission service unavailable): recoverable, not a denial. */
  | { phase: 'error' }
  | { phase: 'done'; result: IdentityLookupResult }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DEBOUNCE_MS = 600

/** Only a complete email or a valid phone is looked up (never a partial entry). */
export const lookupInputs = (email?: string | null, phone?: string | null) => ({
  email: email && EMAIL.test(email.trim()) ? email.trim() : null,
  phone: phone && validatePhoneNumber(phone).isValid ? phone.trim() : null,
})

/**
 * Debounced identity lookup. A response is applied only if it still belongs to the latest request (a counter plus an
 * abort), so a slow answer for an earlier value can never overwrite the current one.
 */
export type LookupView = LookupState & { retry: () => void }

export function useIdentityLookup({ email, phone, organizationId, enabled }: { email?: string | null; phone?: string | null; organizationId?: string | null; enabled: boolean }): LookupView {
  const [state, setState] = useState<LookupState>({ phase: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(0)
  const { email: e, phone: p } = lookupInputs(email, phone)
  const key = `${e?.toLowerCase() ?? ''}|${p ?? ''}|${organizationId ?? ''}|${enabled}|${attempt}`

  useEffect(() => {
    const id = ++latest.current
    if (!enabled || !organizationId || (!e && !p)) { setState({ phase: 'idle' }); return }
    setState({ phase: 'checking' })
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/users/identity-lookup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ organizationId, email: e, phone: p }),
        })
        const json = await res.json().catch(() => null)
        if (id !== latest.current) return
        if (res.status === 403 && json?.code === 'DENIED') setState({ phase: 'denied', reason: String(json.reason || 'You may not create users in this organization.') })
        else setState(res.ok && json?.result ? { phase: 'done', result: json.result as IdentityLookupResult } : { phase: 'error' })
      } catch (error) {
        if (id === latest.current && (error as any)?.name !== 'AbortError') setState({ phase: 'error' })
      }
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { ...state, retry: () => setAttempt(n => n + 1) } as LookupView
}

export interface EmployeeLink { userId: string; name: string | null; organizationName: string | null; employeeNo: number | null; key: string }

/** Whether the lookup blocks continuing, and why (shown inline and used by step validation). */
export function lookupBlocker(state: LookupState, linked: boolean): string | null {
  if (state.phase === 'denied') return state.reason
  if (state.phase === 'checking') return 'Checking whether this person already exists…'
  if (state.phase !== 'done') return null
  const r = state.result
  if (r.status === 'conflict' || r.status === 'blocked' || r.status === 'account_exists') return r.message
  if (r.status === 'employee' && !linked) return 'An HR employee matches this email or phone. Use the employee details to link them, or change the email or phone.'
  return null
}

interface NoticeProps {
  state: LookupView
  link: EmployeeLink | null
  currentName: string
  onLink: (replaceName: boolean) => void
  onUnlink: () => void
  onOpenUser?: (userId: string) => void
  disabled?: boolean
}

export function IdentityMatchNotice({ state, link, currentName, onLink, onUnlink, onOpenUser, disabled }: NoticeProps) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => { setConfirming(false) }, [state, link])

  if (link) {
    return <div role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
      <BadgeCheck className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1"><strong>Linked to HR employee</strong>: {link.name || 'Employee'}{link.organizationName ? ` · ${link.organizationName}` : ''}. The existing login is kept; no second account is created.</span>
      <button type="button" onClick={onUnlink} disabled={disabled} className={`rounded px-2 py-0.5 text-xs font-medium underline ${FOCUS}`}>Change</button>
    </div>
  }
  if (state.phase === 'checking') return <p role="status" className="flex items-center gap-2 text-xs text-gray-500"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />Checking whether this person already exists…</p>
  if (state.phase === 'denied') return <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">{state.reason}</p>
  if (state.phase === 'error') return <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-gray-600">Unable to check for an existing person. Duplicates are still checked again when you create the user.
    <button type="button" onClick={state.retry} className={`rounded px-2 py-0.5 font-medium text-orange-700 underline ${FOCUS}`}>Retry</button></p>
  if (state.phase !== 'done') return null
  const r = state.result
  if (r.status === 'none') return null

  if (r.status === 'employee') {
    const replaces = r.fills.filter(f => (currentName || '').trim() !== f.value)
    return <div role="status" className="space-y-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-950">
      <div className="flex flex-wrap items-center gap-2">
        <UserCheck className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">Employee found: <strong>{r.name || 'Employee'}</strong>{r.organizationName ? ` · ${r.organizationName}` : ''}</span>
        {!confirming && <button type="button" disabled={disabled} onClick={() => (replaces.length ? setConfirming(true) : onLink(false))}
          className={`rounded-lg bg-orange-500 px-3 py-1 text-xs font-medium text-white hover:bg-orange-600 ${FOCUS}`}>Use employee details</button>}
      </div>
      {confirming && <div className="space-y-2 text-xs">
        <p>This links the existing employee instead of creating a duplicate, and replaces these fields:</p>
        <ul className="list-disc pl-5">{replaces.map(f => <li key={f.field}>{f.label}: “{currentName || 'empty'}” → “{f.value}”</li>)}</ul>
        <div className="flex gap-2">
          <button type="button" onClick={() => onLink(true)} className={`rounded-lg bg-orange-500 px-3 py-1 font-medium text-white hover:bg-orange-600 ${FOCUS}`}>Replace and link</button>
          <button type="button" onClick={() => onLink(false)} className={`rounded-lg border border-orange-300 px-3 py-1 font-medium ${FOCUS}`}>Link, keep my entry</button>
          <button type="button" onClick={() => setConfirming(false)} className={`rounded-lg px-3 py-1 ${FOCUS}`}>Cancel</button>
        </div>
      </div>}
    </div>
  }

  return <div role="alert" className="flex flex-wrap items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
    <span className="min-w-0 flex-1">{r.message}{r.status === 'account_exists' && r.name ? ` (${r.name}${r.organizationName ? ` · ${r.organizationName}` : ''})` : ''}</span>
    {r.status === 'account_exists' && r.openUserId && onOpenUser && <button type="button" onClick={() => onOpenUser(r.openUserId!)} className={`rounded px-2 py-0.5 text-xs font-medium underline ${FOCUS}`}>Open existing user</button>}
  </div>
}
