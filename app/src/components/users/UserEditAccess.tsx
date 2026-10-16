'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import GroupPolicyPicker from './GroupPolicyPicker'
import { callApi } from '@/components/security-access/client-api'
import { FOCUS, InfoPopover } from '@/components/security-access/ui'
import { scopeLabels } from '@/lib/security-access/scope-labels'
import type { ProfileChoice, SelectableProfile, SelectableScope } from '@/lib/security-access/group-policy-picker'
import {
  READ_ONLY_TEXT, classifyAccess, computePlan, isEssAssignment, normalizeSnapshot, offeredProfiles,
  type AccessSnapshot, type ClassifiedAccess, type SnapshotAssignment, type SnapshotScope,
} from '@/lib/users/edit-access'

/** What this administrator may grant in the person's organization (the Add User catalogue and scope eligibility, loaded for it). */
export interface EditAccessOptions {
  canAssign: boolean
  denial: { reason: string; permission?: string } | null
  profiles: SelectableProfile[]
  scopes: SelectableScope[]
  orgNames: Record<string, string>
  deferredProfiles: Array<{ id: string; name: string }>
  /** Policies not eligible for the person's organization type (never offered; existing grants flagged for review). */
  ineligibleProfiles: Array<{ id: string; name: string; message: string }>
  canOpenGroupPolicies: boolean
}

export type EditAccessStatus = 'idle' | 'loading' | 'ready' | 'forbidden' | 'failed'
export interface EditAccessState {
  status: EditAccessStatus
  snapshot: AccessSnapshot | null
  options: EditAccessOptions | null
  /** The catalogue / scope read failed: the current access is shown, nothing can be changed. */
  optionsFailed: boolean
  error: string | null
  /** Bumped on every completed load, so the draft restarts from what is now stored. */
  version: number
  classified: ClassifiedAccess | null
  offered: SelectableProfile[]
  refresh: () => void
}

const IDLE: Omit<EditAccessState, 'refresh' | 'classified' | 'offered'> = { status: 'idle', snapshot: null, options: null, optionsFailed: false, error: null, version: 0 }

/**
 * Loads one person's current Group Policy access (People & Access read model) together with what this administrator may
 * grant in the person's CURRENT organization. Read-only; nothing is changed until the Edit User form is saved.
 */
export function useEditAccess({ enabled, userId, organizationId, loader }: {
  enabled: boolean
  userId: string | undefined
  organizationId: string | null | undefined
  loader: (organizationId: string | null) => Promise<any>
}): EditAccessState {
  const [attempt, setAttempt] = useState(0)
  const [raw, setRaw] = useState(IDLE)

  useEffect(() => {
    if (!enabled || !userId) { setRaw(IDLE); return }
    let cancelled = false
    setRaw(prev => ({ ...prev, status: 'loading', error: null }))
    Promise.all([
      callApi(`/api/security-access/people/${userId}`),
      organizationId ? loader(organizationId).catch(() => null) : Promise.resolve(null),
    ]).then(([snap, opt]) => {
      if (cancelled) return
      if (!snap.ok) {
        setRaw(prev => ({ ...prev, status: snap.error === 'Forbidden' || snap.code === 'forbidden' || /forbidden/i.test(snap.error || '') ? 'forbidden' : 'failed', snapshot: null, options: null, optionsFailed: false, error: snap.error ?? 'Group Policies could not be loaded.', version: prev.version + 1 }))
        return
      }
      const snapshot = normalizeSnapshot(snap.data?.person)
      const ok = Boolean(opt?.success)
      const options: EditAccessOptions | null = ok ? {
        canAssign: Boolean(opt.canAssign),
        denial: opt.denial ? { reason: opt.denial.reason, permission: opt.denial.permission } : null,
        profiles: (opt.profiles as SelectableProfile[] | undefined) ?? [],
        scopes: (opt.scopes as SelectableScope[] | undefined) ?? [],
        orgNames: opt.orgNames ?? {},
        deferredProfiles: opt.deferredProfiles ?? [],
        ineligibleProfiles: opt.ineligibleProfiles ?? [],
        canOpenGroupPolicies: Boolean(opt.canOpenGroupPolicies),
      } : null
      setRaw(prev => ({ status: 'ready', snapshot, options, optionsFailed: Boolean(organizationId) && !ok, error: null, version: prev.version + 1 }))
    }).catch(() => { if (!cancelled) setRaw(prev => ({ ...prev, status: 'failed', error: 'Group Policies could not be loaded.', version: prev.version + 1 })) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, userId, organizationId, attempt])

  const editable = Boolean(raw.options?.canAssign)
  const classified = useMemo(
    () => (raw.snapshot ? classifyAccess(raw.snapshot, organizationId ?? null, editable ? raw.options : null) : null),
    [raw.snapshot, raw.options, organizationId, editable],
  )
  const offered = useMemo(() => (classified && editable ? offeredProfiles(classified, raw.options) : []), [classified, editable, raw.options])
  return { ...raw, classified, offered, refresh: () => setAttempt(n => n + 1) }
}

const KIND_BADGE: Record<string, { label: string; tone: string }> = {
  explicit: { label: 'Granted', tone: 'bg-blue-50 text-blue-700' },
  managed: { label: 'Managed', tone: 'bg-slate-100 text-slate-700' },
  legacy: { label: 'Legacy migration', tone: 'bg-gray-100 text-gray-600' },
}
const dateOnly = (value: string | null) => (value ? new Date(value).toLocaleDateString() : null)

interface Props {
  state: EditAccessState
  draft: ProfileChoice[]
  onDraft: (items: ProfileChoice[]) => void
  disabled?: boolean
  organizationName: string | null
  /** The organization was changed in this form: policy editing waits until it is saved. */
  organizationChanged: boolean
  error?: string
}

export default function UserEditAccess({ state, draft, onDraft, disabled, organizationName, organizationChanged, error }: Props) {
  const { status, snapshot, options, classified } = state
  const labelMap = useMemo(
    () => scopeLabels(options?.scopes ?? [], new Map(Object.entries(options?.orgNames ?? {}))),
    [options],
  )
  const scopeName = (s: SnapshotScope) => labelMap.get(s.id) ?? s.name
  const editable = Boolean(options?.canAssign) && !organizationChanged
  const plan = classified ? computePlan(classified, draft) : null
  const [openPast, setOpenPast] = useState(false)
  useEffect(() => { setOpenPast(false) }, [state.version])

  const heading = (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <h4 id="edit-access-heading" className="text-sm font-semibold text-gray-950">Group Policies</h4>
      <InfoPopover label="About Group Policies in Edit User">
        <p>Group Policies decide what this person can do. Only access granted by an administrator is edited here, through the same checks as Security &amp; Access → People &amp; Access. Nothing is changed until you save on the last step; Cancel discards your selections.</p>
        <p>Managed access (such as Employee Self Service), legacy-migration access, access held through another organization and anything you are not authorized to manage are shown for information and are never removed by this form.</p>
        <p>Unticking a policy removes it only when it is a grant you manage here. A change of scope replaces that grant (its end date is kept).</p>
      </InfoPopover>
      {organizationName ? <span className="text-xs text-gray-500 max-sm:basis-full sm:ml-auto">{organizationName}</span> : null}
    </div>
  )

  if (status === 'idle' || status === 'loading') {
    return <section aria-labelledby="edit-access-heading" className="space-y-2">{heading}
      <p role="status" className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Loading current Group Policies…</p></section>
  }
  if (status === 'forbidden') {
    return <section aria-labelledby="edit-access-heading" className="space-y-2">{heading}
      <p role="note" className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700">You do not have access to view Group Policies. Existing access is unchanged by this form; it is managed in Security &amp; Access.</p></section>
  }
  if (status === 'failed' || !snapshot || !classified) {
    return <section aria-labelledby="edit-access-heading" className="space-y-2">{heading}
      <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{state.error ?? 'Group Policies could not be loaded.'} Nothing about this person’s access is changed.</span>
        <button type="button" onClick={state.refresh} className={`rounded-lg border border-red-300 px-3 py-1 text-xs font-medium ${FOCUS}`}>Retry</button>
      </div></section>
  }

  const ineligibleReason = (roleId: string) => options?.ineligibleProfiles.find(p => p.id === roleId)?.message ?? null
  const heldRows = classified.held.slice().sort((a, b) => a.assignment.roleName.localeCompare(b.assignment.roleName))
  const grantRows = classified.manageable.slice().sort((a, b) => a.assignment.roleName.localeCompare(b.assignment.roleName))
  const row = (a: SnapshotAssignment, kind: 'explicit' | 'managed' | 'legacy', note?: string) => {
    const badge = KIND_BADGE[kind]
    const until = dateOnly(a.effectiveUntil)
    return <li key={a.id} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 py-1.5">
      <span className="min-w-0 flex-1 text-sm text-gray-900">
        <span className="font-medium">{isEssAssignment(a) ? 'Employee Self Service' : a.roleName}</span>
        <span className="text-gray-600"> — {a.scopes.length ? a.scopes.map(scopeName).join(', ') : 'no scope'}{a.organizationName ? ` · ${a.organizationName}` : ''}</span>
        {note ? <span className="block text-xs text-gray-500">{note}</span> : null}
      </span>
      {until ? <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800" title="Temporary access">Until {until}</span> : null}
      <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.tone}`}>{badge.label}</span>
    </li>
  }

  return (
    <section aria-labelledby="edit-access-heading" className="space-y-2.5">
      {heading}

      {organizationChanged ? (
        <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">
          The organization was changed in this form. Group Policy changes are paused: save the organization change first, then edit the policies for the new organization. Nothing here is moved or removed by changing the organization selection itself — see the review for what moving the person ends.
        </p>
      ) : null}
      {state.optionsFailed ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">Your authority to change Group Policies here could not be checked, so they can be viewed but not changed.</span>
          <button type="button" onClick={state.refresh} className={`rounded-lg border border-red-300 px-3 py-1 text-xs font-medium ${FOCUS}`}>Retry</button>
        </div>
      ) : null}
      {!state.optionsFailed && options && !options.canAssign ? (
        <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950">{options.denial?.reason ?? 'You cannot change Group Policies in this organization.'} Current access is shown for information.</p>
      ) : null}

      <div role="region" aria-label="Current access" className="rounded-lg border border-gray-200 px-3 py-1">
        {grantRows.length + heldRows.length === 0
          ? <p className="py-1.5 text-sm text-gray-600">No active Group Policy access.</p>
          : <ul className="divide-y divide-gray-100">
              {grantRows.map(g => row(g.assignment, 'explicit'))}
              {heldRows.map(h => row(h.assignment, h.kind === 'managed' ? 'managed' : h.kind === 'legacy' ? 'legacy' : 'explicit',
                h.kind === 'managed' ? 'Maintained automatically from HR / User Management; not removed by this form.'
                  : h.kind === 'legacy' ? 'Created from the legacy role during migration; not editable here.'
                    : h.reason === 'not_eligible' ? `${READ_ONLY_TEXT.not_eligible}${ineligibleReason(h.assignment.roleId) ? ` (${ineligibleReason(h.assignment.roleId)})` : ''}`
                      : h.reason ? READ_ONLY_TEXT[h.reason] : undefined))}
            </ul>}
      </div>

      {editable && classified ? (
        <div className="space-y-1.5">
          <h5 className="text-sm font-medium text-gray-900">Add, change or remove granted policies</h5>
          {state.offered.length > 0 || draft.length > 0
            ? <GroupPolicyPicker disabled={disabled} profiles={state.offered} scopes={options?.scopes ?? []} orgNames={options?.orgNames} items={draft} onItems={onDraft} />
            : <p role="note" className="text-xs text-gray-500">No additional Group Policy can be assigned here for this organization and account type.</p>}
          {options && options.deferredProfiles.length > 0 ? <p className="text-xs text-gray-500">{options.deferredProfiles.length} {options.deferredProfiles.length === 1 ? 'policy is' : 'policies are'} not offered here: they need an administrator who holds their permissions ({options.deferredProfiles.map(d => d.name).join(', ')}).</p> : null}
          {error ? <p role="alert" className="text-xs text-red-600">{error}</p> : null}
          {plan && !plan.empty ? <p role="status" className="text-xs text-orange-800">{plan.ops.length} pending Group Policy {plan.ops.length === 1 ? 'change' : 'changes'} — reviewed on the last step, applied only when you save.</p> : null}
        </div>
      ) : null}

      {classified.historical.length > 0 ? (
        <div className="text-xs text-gray-600">
          <button type="button" aria-expanded={openPast} onClick={() => setOpenPast(v => !v)} className={`rounded font-medium underline ${FOCUS}`}>Past access ({classified.historical.length})</button>
          {openPast ? <ul aria-label="Past access" className="mt-1 list-disc space-y-0.5 pl-5">
            {classified.historical.map(a => <li key={a.id}>{a.roleName}{a.organizationName ? ` · ${a.organizationName}` : ''} — {a.status === 'active' ? 'expired' : a.status}{a.effectiveUntil ? ` (${dateOnly(a.effectiveUntil)})` : ''}</li>)}
          </ul> : null}
        </div>
      ) : null}
    </section>
  )
}
