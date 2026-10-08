'use client'

import { useMemo, useState } from 'react'
import { AlertTriangle, ShieldAlert, ShieldOff } from 'lucide-react'
import SearchableSelect from './SearchableSelect'
import { callApi, formatDate, one, toIso } from './client-api'
import { FOCUS } from './ui'
import {
  ROOT_ACCESS_CONFIRMATION, ROOT_ACCESS_MODULES, ROOT_ACCESS_ORGANIZATIONS, ROOT_ACCESS_WARNING, ROOT_REASON_MAX, ROOT_REASON_MIN,
  rootAccessCurrent, type RootAccessCapability, type RootAccessInfo,
} from '@/lib/security-access/root-access-shared'

export type AccessLevel = 'standard' | 'root'

/** Holds active (unexpired) Root Access, as the directory reported it. */
export const holdsRootAccess = (person: any): boolean => rootAccessCurrent(person?.root_access as RootAccessInfo | null)

/** Internal staff only (mirrors the database rule): an active account with an active HQ membership. */
export const rootEligible = (person: any): boolean => !!person?.is_active
  && (person.membership || []).some((m: any) => m.status === 'active' && String(one(m.organization)?.org_type_code ?? '').toUpperCase() === 'HQ')

export function RootBadge() {
  return <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-inset ring-red-200"
    title="Holds Root Access (Full System Administrator)"><ShieldAlert className="h-3 w-3" aria-hidden />Root Administrator</span>
}

/**
 * Access level for the grant form. Standard keeps the Group Policy workflow unchanged; Root Access is offered only to an
 * active Root Administrator (the database refuses anyone else regardless of what is shown here).
 */
export function AccessLevelSelector({ value, onChange, capability }: { value: AccessLevel; onChange: (level: AccessLevel) => void; capability: RootAccessCapability }) {
  const rootAllowed = capability.viewerIsRoot
  const option = (level: AccessLevel, title: string, help: string, disabled = false) => {
    const selected = value === level
    return <label className={`flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${selected ? (level === 'root' ? 'border-red-300 bg-red-50/60' : 'border-orange-300 bg-orange-50/50') : 'border-gray-200 bg-white'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
      <input type="radio" name="access-level" value={level} checked={selected} disabled={disabled} onChange={() => onChange(level)} className="mt-0.5" />
      <span className="min-w-0"><span className="block font-medium text-gray-900">{title}</span><span className="block text-xs text-gray-500">{help}</span></span>
    </label>
  }
  return <fieldset className="px-4 pt-3">
    <legend className="text-sm text-gray-600">Access level</legend>
    <div className="mt-1 flex flex-col gap-2 sm:flex-row">
      {option('standard', 'Standard Access', 'A Group Policy for one membership, with a module and a scope.')}
      {option('root', 'Root Access — Full System Administrator', 'Every module and organization. Granted by Root Administrators only.', !rootAllowed)}
    </div>
    {!rootAllowed && <p role="note" className="mt-1 text-xs text-gray-500">Only an active Root Administrator can grant Root Access. Level 1 / Super Admin and Group Policies are not enough.</p>}
  </fieldset>
}

/**
 * Root Access grant: person, mandatory reason, optional expiry, then an explicit typed confirmation. The server and the
 * database re-check everything (Root Administrator, no self-grant, internal staff, reason, expiry).
 */
export function RootGrantForm({ candidates, viewerId, onQueryChange, searching, onGranted, onCancel }: {
  candidates: any[]; viewerId: string | undefined; onQueryChange?: (q: string) => void; searching?: boolean
  onGranted: (message: string) => void; onCancel: () => void
}) {
  const [userId, setUserId] = useState('')
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestKey, setRequestKey] = useState('')

  const options = useMemo(() => candidates.filter(p => p.id !== viewerId).map(p => {
    const held = holdsRootAccess(p)
    const eligible = rootEligible(p)
    return { value: p.id, label: p.full_name || p.email, disabled: held || !eligible,
      description: held ? 'Already a Root Administrator' : eligible ? p.email : `${p.email} · Internal staff with an active HQ membership only` }
  }), [candidates, viewerId])
  const person = candidates.find(p => p.id === userId)
  const trimmed = reason.trim()
  const reasonValid = trimmed.length >= ROOT_REASON_MIN && trimmed.length <= ROOT_REASON_MAX
  const untilIso = toIso(until)
  const ready = !!person && options.some(o => o.value === userId && !o.disabled) && reasonValid && (!until || !!untilIso)
  const who = person?.full_name || person?.email || 'this person'

  const openConfirm = () => {
    if (!ready) return
    setError(null); setPhrase('')
    // One idempotency key per confirmation: a double click or retry cannot create a second grant.
    setRequestKey(globalThis.crypto?.randomUUID?.() ?? '')
    setConfirming(true)
  }
  async function submit() {
    if (!ready || phrase !== ROOT_ACCESS_CONFIRMATION || busy || !requestKey) return
    setBusy(true); setError(null)
    const res = await callApi('/api/security-access/root-access', { body: {
      action: 'grant', userId, reason: trimmed, effectiveUntil: untilIso, confirmation: phrase, requestKey,
    } })
    setBusy(false)
    if (!res.ok) { setError(`${res.error || 'Root Access could not be granted.'}${/nothing was changed/i.test(res.error || '') ? '' : ' Nothing was changed.'}`); setConfirming(false); return }
    onGranted(`Root Access granted to ${who} and recorded in the access change log.`)
  }

  return <div className="space-y-4 p-4">
    <div role="alert" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p className="font-semibold">Privileged access</p>
        <p>{ROOT_ACCESS_WARNING}</p>
        <p className="text-xs text-red-800"><span className="font-medium">Modules:</span> {ROOT_ACCESS_MODULES.join(', ')}, and any module added later.</p>
        <p className="text-xs text-red-800"><span className="font-medium">Scope:</span> Global — {ROOT_ACCESS_ORGANIZATIONS}.</p>
      </div>
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <SearchableSelect label="Person" value={userId} onChange={v => { setUserId(v); setConfirming(false) }} onQueryChange={onQueryChange} loading={searching}
        options={options} placeholder="Search internal staff" emptyText="No matching person." />
      <label className="text-sm"><span className="text-gray-600">Ends (optional)</span>
        <input type="datetime-local" value={until} onChange={e => { setUntil(e.target.value); setConfirming(false) }} aria-label="Root Access ends"
          className="mt-1 w-full rounded-lg border px-3 py-2" />
        <span className="mt-1 block text-xs text-gray-500">Leave empty for no expiry. Root Access ends at this time automatically.</span></label>
      <div className="text-sm md:col-span-2">
        <label htmlFor="root-reason" className="text-gray-600">Reason (required)</label>
        <textarea id="root-reason" rows={2} maxLength={ROOT_REASON_MAX} value={reason} onChange={e => { setReason(e.target.value); setConfirming(false) }}
          aria-describedby="root-reason-help" placeholder="Why this person needs full system access, e.g. an approval or ticket reference" className="mt-1 w-full rounded-lg border px-3 py-2" />
        <p id="root-reason-help" className="text-xs text-gray-400">{trimmed.length}/{ROOT_REASON_MAX} · At least {ROOT_REASON_MIN} characters. Recorded in the access change log.</p>
      </div>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
    {!confirming
      ? <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={!ready} onClick={openConfirm}
            className={`inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40 ${FOCUS}`}>
            <ShieldAlert className="h-4 w-4" aria-hidden />Grant Root Access…</button>
          <button type="button" onClick={onCancel} className={`rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 ${FOCUS}`}>Cancel</button>
          <span role="status" className="text-xs text-gray-500">{!person ? 'Choose a person to continue.' : !reasonValid ? `Enter a reason of at least ${ROOT_REASON_MIN} characters.` : until && !untilIso ? 'Enter a valid end time.' : 'You will be asked to confirm.'}</span>
        </div>
      : <div role="group" aria-label="Confirm Root Access" className="space-y-2 rounded-lg border border-red-300 bg-white p-3">
          <p className="text-sm text-gray-900">Grant <span className="font-semibold">Root Access</span> to <span className="font-semibold">{who}</span>{untilIso ? <> until {formatDate(untilIso)}</> : ' with no expiry'}? Their existing Group Policies stay as they are.</p>
          <label className="block text-sm"><span className="text-gray-600">Type <span className="font-mono font-semibold">{ROOT_ACCESS_CONFIRMATION}</span> to confirm</span>
            <input value={phrase} onChange={e => setPhrase(e.target.value)} autoFocus aria-label="Confirmation phrase" className="mt-1 w-full rounded-lg border px-3 py-2 font-mono" /></label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || phrase !== ROOT_ACCESS_CONFIRMATION} onClick={submit}
              className={`rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40 ${FOCUS}`}>{busy ? 'Granting…' : 'Confirm and grant Root Access'}</button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={`rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 ${FOCUS}`}>Back</button>
          </div>
        </div>}
  </div>
}

/** Root Access status in a person's access detail, with Revoke for another Root Administrator. */
export function RootAccessCard({ person, viewerIsRoot, isViewer, onChanged }: { person: any; viewerIsRoot: boolean; isViewer: boolean; onChanged: (message: { tone: 'ok' | 'error'; text: string }) => void }) {
  const info: RootAccessInfo | null = person.root_access ?? null
  const [busy, setBusy] = useState(false)
  if (!info || !rootAccessCurrent(info)) return null
  const who = person.full_name || person.email
  const grantedBy = info.method === 'bootstrap' ? 'Initial setup (database owner)' : info.grantedBy ? (info.grantedBy.name || info.grantedBy.email || 'Root Administrator') : 'Former administrator'
  async function revoke() {
    const reason = window.prompt(`Revoke Root Access from ${who}? Only Root Access ends; their Group Policies and other access stay in place. Reason (at least ${ROOT_REASON_MIN} characters)?`)
    if (!reason || reason.trim().length < ROOT_REASON_MIN) return
    setBusy(true)
    const res = await callApi('/api/security-access/root-access', { body: { action: 'revoke', userId: person.id, reason: reason.trim() } })
    setBusy(false)
    onChanged(res.ok ? { tone: 'ok', text: `Root Access revoked from ${who}. Their other access is unchanged.` } : { tone: 'error', text: res.error || 'Root Access could not be revoked.' })
  }
  const row = (label: string, value: React.ReactNode) => <div className="min-w-0"><dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</dt><dd className="break-words text-sm text-gray-800">{value}</dd></div>
  return <section aria-label="Root Access" className="rounded-lg border border-red-200 bg-white">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-100 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-gray-900">Root Access</h3><RootBadge />
        <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${info.effectiveUntil ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>{info.effectiveUntil ? 'Temporary' : 'Active'}</span></div>
      {viewerIsRoot && !isViewer && <button type="button" onClick={revoke} disabled={busy}
        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 ${FOCUS}`}>
        <ShieldOff className="h-3 w-3" aria-hidden />{busy ? 'Revoking…' : 'Revoke Root Access'}</button>}
      {viewerIsRoot && isViewer && <span className="text-xs text-gray-500">You cannot revoke your own Root Access.</span>}
    </div>
    <dl className="grid gap-3 px-3 py-2.5 sm:grid-cols-2 lg:grid-cols-4">
      {row('Granted by', grantedBy)}
      {row('Granted', formatDate(info.grantedAt))}
      {row('Expires', info.effectiveUntil ? formatDate(info.effectiveUntil) : 'No expiry')}
      {row('Scope', 'Global — all modules and organizations')}
      <div className="min-w-0 sm:col-span-2 lg:col-span-4"><dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Reason</dt><dd className="whitespace-pre-wrap break-words text-sm text-gray-800">{info.reason}</dd></div>
    </dl>
    <p className="border-t border-red-100 px-3 py-2 text-xs text-gray-500">Group Policies below are kept and stay in force if Root Access ends.</p>
  </section>
}
