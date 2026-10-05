'use client'

import { useCallback, useEffect, useState } from 'react'
import { callApi } from './client-api'
import { FOCUS } from './ui'
import { permissionLabel } from '@/lib/security-access/labels'
import { orgTypeLabel } from '@/lib/security-access/directory-labels'
import type { ProfileSummary } from '@/lib/security-access/profiles'

interface Props { profile: ProfileSummary; permissions: any[]; onClose: () => void; onPublished: () => void }

/**
 * Publication impact: what is added and removed, everyone who currently holds
 * the profile (with organization and scope) and any new separation-of-duties
 * conflict. Changing a profile that people hold needs a reason and an explicit
 * confirmation; a stale preview is rejected and must be reviewed again.
 */
export default function ProfilePublishDialog({ profile, onClose, onPublished }: Props) {
  const [preview, setPreview] = useState<any | null>(null)
  const [error, setError] = useState<{ text: string; code?: string } | null>(null)
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setPreview(null); setError(null); setConfirmed(false)
    const res = await callApi('/api/security-access/profiles', { body: { action: 'preview', roleId: profile.id } })
    if (!res.ok) { setError({ text: res.error || 'The impact could not be calculated.', code: res.code }); return }
    setPreview(res.data.result)
  }, [profile.id])
  useEffect(() => { load() }, [load])

  const holders = preview?.holderCount ?? 0
  const blocking = preview?.blockingConflicts ?? 0
  const reasonOk = holders === 0 || reason.trim().length >= 10
  const canPublish = !!preview && !busy && blocking === 0 && !preview.selfPublishBlocked && reasonOk && (holders === 0 || confirmed)

  async function publish() {
    if (!canPublish) return
    setBusy(true); setError(null)
    const res = await callApi('/api/security-access/profiles', { body: { action: 'publish', roleId: profile.id, impactHash: preview.impactHash, reason: reason.trim() } })
    setBusy(false)
    if (!res.ok) { setError({ text: res.error || 'Unable to publish', code: res.code }); return }
    onPublished()
  }

  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="presentation">
    <div role="dialog" aria-modal="true" aria-labelledby="publish-title" className="my-8 w-full max-w-3xl space-y-4 rounded-xl bg-white p-4 shadow-xl">
      <div><h2 id="publish-title" className="font-semibold text-gray-950">Publish: {profile.name}</h2>
        <p className="text-sm text-gray-500">Publishing replaces the live permissions of this profile. Until you publish, nobody’s access changes.</p></div>
      {!preview && !error && <p role="status" className="text-sm text-gray-500">Calculating the impact…</p>}
      {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error.text}
        {error.code === 'stale_preview' && <button type="button" onClick={load} className={`ml-2 rounded font-medium underline ${FOCUS}`}>Refresh preview</button>}</div>}
      {preview && <>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><h3 className="text-sm font-semibold text-emerald-800">Added ({preview.added.length})</h3>
            {preview.added.length === 0 ? <p className="text-xs text-gray-500">None</p> : <ul className="mt-1 space-y-0.5 text-sm">{preview.added.map((k: string) => <li key={k}>{permissionLabel(k).label} <code className="text-[11px] text-gray-400">{k}</code></li>)}</ul>}</div>
          <div><h3 className="text-sm font-semibold text-rose-800">Removed ({preview.removed.length})</h3>
            {preview.removed.length === 0 ? <p className="text-xs text-gray-500">None</p> : <ul className="mt-1 space-y-0.5 text-sm">{preview.removed.map((k: string) => <li key={k}>{permissionLabel(k).label} <code className="text-[11px] text-gray-400">{k}</code></li>)}</ul>}</div>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Affected people ({holders})</h3>
          {holders === 0 ? <p className="text-xs text-gray-500">Nobody holds this profile yet.</p> : <ul className="mt-1 max-h-48 divide-y divide-gray-100 overflow-auto rounded-md border border-gray-200 text-xs">
            {preview.holders.map((h: any) => <li key={h.assignmentId} className="flex flex-wrap justify-between gap-2 px-2 py-1">
              <span><span className="font-medium text-gray-900">{h.name}</span> <span className="text-gray-500">{h.email}</span></span>
              <span className="text-gray-600">{h.organization} ({orgTypeLabel(h.organizationType)}) · Scope: {(h.scopes || []).join(', ') || '—'}</span></li>)}</ul>}
        </div>
        {preview.conflicts.length > 0 && <div role="alert" className={`rounded-lg border p-3 text-sm ${blocking ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
          <p className="font-medium">{blocking ? `${blocking} separation-of-duties conflict${blocking === 1 ? '' : 's'} would block this publication.` : 'Segregation-of-duties conflicts are monitored for existing holders.'}</p>
          <ul className="list-disc pl-5 text-xs">{preview.conflicts.map((c: any, i: number) => <li key={i}>{c.ruleKey} — {c.enforcement}{c.mitigated ? ' (mitigated)' : ''}</li>)}</ul></div>}
        {preview.selfPublishBlocked && <p role="alert" className="text-sm text-amber-800">You submitted this change, so someone else must publish it because it affects existing holders.</p>}
        {holders > 0 && <>
          <label className="block text-sm"><span className="text-gray-600">Reason (required, audited for every affected person)</span>
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} className="mt-1 w-full rounded-lg border p-2 text-sm" /></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
            <span>I understand this changes access for {holders} {holders === 1 ? 'person' : 'people'} immediately.</span></label>
        </>}
      </>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className={`rounded-lg border border-gray-200 px-3 py-1.5 text-sm ${FOCUS}`}>Cancel</button>
        <button type="button" onClick={publish} disabled={!canPublish} className={`rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 ${FOCUS}`}>{busy ? 'Publishing…' : 'Publish'}</button>
      </div>
    </div>
  </div>
}
