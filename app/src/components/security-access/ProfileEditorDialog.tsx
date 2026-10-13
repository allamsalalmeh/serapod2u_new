'use client'

import { useMemo, useState } from 'react'
import { callApi } from './client-api'
import { FOCUS, SearchInput } from './ui'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, buildPermissionPicker, isForbiddenForPartner, isSensitivePermission, type ProfileSummary } from '@/lib/security-access/profiles'
import { orgTypeLabel } from '@/lib/security-access/directory-labels'
import { ELIGIBLE_ORG_TYPES, permissionAllowedForOrgType } from '@/lib/security-access/recipient-eligibility'
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 60)

interface Props {
  /** null = new profile. */
  profile: ProfileSummary | null
  permissions: any[]
  onClose: () => void
  onSaved: (message: string, submitted: boolean) => void
}

/**
 * Create or edit a custom profile as a DRAFT. The picker is navigation only
 * (module → functional area → operation): every permission is chosen one by
 * one, a module or area never implies its permissions, and permissions added
 * to the catalogue later are not selected.
 */
export default function ProfileEditorDialog({ profile, permissions, onClose, onSaved }: Props) {
  const source = profile?.draft ?? profile
  const [name, setName] = useState(source?.name ?? '')
  const [roleKey, setRoleKey] = useState(profile?.roleKey ?? '')
  const [keyTouched, setKeyTouched] = useState(false)
  const [description, setDescription] = useState(source?.description ?? '')
  const [accountTypes, setAccountTypes] = useState<string[]>(source?.accountTypes ?? [])
  const [orgTypes, setOrgTypes] = useState<string[]>(source?.orgTypes ?? [])
  const [selected, setSelected] = useState<Set<string>>(new Set(source?.permissionKeys ?? []))
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picker = useMemo(() => buildPermissionPicker(permissions.filter(p => p.status !== 'deprecated')), [permissions])
  const partner = accountTypes.includes('partner')
  const q = query.trim().toLowerCase()
  const flip = <T,>(set: T[], v: T) => (set.includes(v) ? set.filter(x => x !== v) : [...set, v])
  const toggleKey = (k: string) => setSelected(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  // A permission is unavailable when the account type or any chosen organization type may not hold it (same rule as the
  // database draft guard: e.g. Finance / HR / Security / Platform are HQ-only, a Manufacturer holds Manufacturing only).
  const blockedBy = (k: string) => orgTypes.filter(t => !permissionAllowedForOrgType(k, t))
  const blocked = (k: string) => (partner && isForbiddenForPartner(k)) || blockedBy(k).length > 0
  const effective = Array.from(selected).filter(k => !blocked(k))
  const sensitive = effective.filter(isSensitivePermission)
  const valid = name.trim().length > 0 && /^[a-z][a-z0-9_-]*$/.test(profile ? profile.roleKey : roleKey)
  // A policy is grantable only to the organization types it lists; none listed = grantable nowhere, so it cannot be submitted.
  const typesChosen = orgTypes.length > 0

  async function save(submit: boolean) {
    setBusy(true); setError(null)
    const body = { name: name.trim(), description: description.trim(), accountTypes, orgTypes, permissionKeys: effective.sort() }
    let roleId = profile?.id
    if (!roleId) {
      const created = await callApi('/api/security-access/profiles', { body: { action: 'create', roleKey, ...body } })
      if (!created.ok) { setBusy(false); setError(created.error || 'Unable to create the policy'); return }
      roleId = created.data.result
    } else {
      const saved = await callApi('/api/security-access/profiles', { body: { action: 'save_draft', roleId, ...body } })
      if (!saved.ok) { setBusy(false); setError(saved.error || 'Unable to save the draft'); return }
    }
    if (submit) {
      const submitted = await callApi('/api/security-access/profiles', { body: { action: 'submit', roleId } })
      if (!submitted.ok) { setBusy(false); setError(submitted.error || 'Saved, but it could not be submitted for review'); return }
    }
    setBusy(false)
    onSaved(submit ? 'Draft saved and submitted for review. Use “Review & publish” to see the impact.' : 'Draft saved. Nothing changes for anyone until it is published.', submit)
    if (!submit) onClose()
  }

  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="presentation">
    <div role="dialog" aria-modal="true" aria-labelledby="profile-editor-title" className="my-8 w-full max-w-4xl rounded-xl bg-white shadow-xl">
      <div className="border-b border-gray-100 p-4">
        <h2 id="profile-editor-title" className="font-semibold text-gray-950">{profile ? `Edit draft: ${profile.name}` : 'New Group Policy'}</h2>
        <p className="text-sm text-gray-500">Saved drafts never change anyone’s current access. Permissions are chosen one by one; a module or area never grants everything inside it, and permissions added later are not included.</p>
      </div>
      <div className="grid gap-3 p-4 md:grid-cols-2">
        <label className="text-sm"><span className="text-gray-600">Name</span>
          <input value={name} onChange={e => { setName(e.target.value); if (!profile && !keyTouched) setRoleKey(slug(e.target.value)) }} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <label className="text-sm"><span className="text-gray-600">Policy key {profile ? '(fixed)' : ''}</span>
          <input value={profile ? profile.roleKey : roleKey} onChange={e => { setKeyTouched(true); setRoleKey(e.target.value) }} disabled={!!profile} className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs disabled:bg-gray-50" /></label>
        <label className="text-sm md:col-span-2"><span className="text-gray-600">Description</span>
          <input value={description} onChange={e => setDescription(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <fieldset className="text-sm"><legend className="text-gray-600">Applies to account type (empty = any)</legend>
          <div className="mt-1 flex flex-wrap gap-3">{ACCOUNT_TYPES.map(t => <label key={t} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={accountTypes.includes(t)} onChange={() => setAccountTypes(flip(accountTypes, t))} />{ACCOUNT_TYPE_LABELS[t]}</label>)}</div>
          {partner && <p className="mt-1 text-xs text-amber-800">Partner policies cannot include HR, security administration, user administration or data-maintenance permissions; those are disabled below.</p>}</fieldset>
        <fieldset className="text-sm"><legend className="text-gray-600">Eligible organization types <span className="text-red-500" aria-hidden>*</span><span className="sr-only">(required to submit)</span></legend>
          <div className="mt-1 flex flex-wrap gap-3">{ELIGIBLE_ORG_TYPES.map(t => <label key={t} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={orgTypes.includes(t)} onChange={() => setOrgTypes(flip(orgTypes, t))} />{orgTypeLabel(t)}</label>)}</div>
          <p className="mt-1 text-xs text-gray-500">The policy can be granted only to memberships in these organization types. Nothing is assumed: with none chosen it cannot be submitted or granted. Warehouse is never implied by Headquarters.</p></fieldset>
      </div>
      <div className="space-y-2 border-t border-gray-100 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-900">Permissions · {effective.length} selected</h3>
          <SearchInput value={query} onChange={setQuery} placeholder="Search permissions" label="Search permissions" className="sm:w-64" />
        </div>
        {sensitive.length > 0 && <p role="note" className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">This policy includes administrative or reset permissions ({sensitive.length}). Such profiles cannot be assigned during user creation; they are assigned afterwards in People &amp; Access.</p>}
        <div className="max-h-96 overflow-auto rounded-lg border border-gray-200">
          {picker.map(m => {
            const modMatches = (a: { permissions: Array<{ key: string; label: string }> }) => a.permissions.filter(p => !q || `${p.label} ${p.key} ${m.name}`.toLowerCase().includes(q))
            const areas = m.areas.map(a => ({ ...a, shown: modMatches(a) })).filter(a => a.shown.length)
            if (!areas.length) return null
            const count = m.areas.flatMap(a => a.permissions).filter(p => selected.has(p.key) && !blocked(p.key)).length
            const mOpen = q ? true : open.has(m.id)
            return <div key={m.id} className="border-b border-gray-100 last:border-b-0">
              <button type="button" aria-expanded={mOpen} onClick={() => setOpen(prev => { const n = new Set(prev); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n })}
                className={`flex w-full items-center justify-between bg-gray-50/70 px-3 py-2 text-left text-sm font-semibold text-gray-900 ${FOCUS}`}>
                <span>{m.name}</span><span className="text-xs font-normal text-gray-500">{count} of {m.total} selected</span></button>
              {mOpen && areas.map(a => <div key={a.id} className="px-3 pb-2 pt-1">
                <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  <span>{a.name}</span>
                  <span className="space-x-2 normal-case">
                    <button type="button" className={`rounded text-orange-600 ${FOCUS}`} onClick={() => setSelected(prev => { const n = new Set(prev); a.shown.forEach(p => { if (!blocked(p.key)) n.add(p.key) }); return n })}>Select listed<span className="sr-only"> in {a.name}</span></button>
                    <button type="button" className={`rounded text-gray-500 ${FOCUS}`} onClick={() => setSelected(prev => { const n = new Set(prev); a.shown.forEach(p => n.delete(p.key)); return n })}>Clear<span className="sr-only"> {a.name}</span></button>
                  </span>
                </div>
                <ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">{a.shown.map(p => <li key={p.key}>
                  <label className={`flex items-start gap-2 text-sm ${blocked(p.key) ? 'opacity-40' : ''}`} title={blocked(p.key) ? (blockedBy(p.key).length ? `Not allowed for ${blockedBy(p.key).map(orgTypeLabel).join(', ')}` : 'Not allowed in a partner policy') : p.key}>
                    <input type="checkbox" className="mt-1" checked={selected.has(p.key) && !blocked(p.key)} disabled={blocked(p.key)} onChange={() => toggleKey(p.key)} />
                    <span>{p.label}<span className="block font-mono text-[11px] text-gray-400">{p.key}</span></span></label>
                </li>)}</ul>
              </div>)}
            </div>
          })}
        </div>
      </div>
      {!typesChosen && <p role="note" className="px-4 pb-2 text-xs text-amber-800">Choose at least one eligible organization type to submit this policy for review.</p>}
      {error && <p role="alert" className="px-4 pb-2 text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 p-4">
        <button type="button" onClick={onClose} disabled={busy} className={`rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 ${FOCUS}`}>Close</button>
        <button type="button" onClick={() => save(false)} disabled={!valid || busy} className={`rounded-lg border border-orange-300 px-3 py-1.5 text-sm font-medium text-orange-700 disabled:opacity-40 ${FOCUS}`}>Save draft</button>
        <button type="button" onClick={() => save(true)} disabled={!valid || busy || effective.length === 0 || !typesChosen} className={`rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 ${FOCUS}`}>Save &amp; submit for review</button>
      </div>
    </div>
  </div>
}
