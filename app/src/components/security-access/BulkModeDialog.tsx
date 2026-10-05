'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MODE_LABELS, modeLabel } from '@/lib/security-access/labels'
import { callApi } from './client-api'
import { FOCUS } from './ui'

const MODES = ['LEGACY_ENFORCED', 'SHADOW', 'NEW_ENFORCED', 'LEGACY_RETIRED'] as const
type Selection = 'all' | 'eligible_only'

interface PreviewRow { permissionKey: string; label: string; currentMode: string; targetMode: string; status: 'change' | 'unchanged' | 'blocked'; blockers: Array<{ code: string; message: string }> }
interface Preview {
  group: { id: string; name: string; total: number }
  targetMode: string
  rows: PreviewRow[]
  counts: { change: number; unchanged: number; blocked: number }
  previewHash: string
  canApplyAll: boolean
  canApplyEligibleOnly: boolean
}
interface Result { batchId: string; changed: number; unchanged: number; skipped: number; replayed: boolean; items: Array<{ permissionKey: string; status: string }> }

const newKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`)
const STATUS_TEXT = { change: 'Will change', unchanged: 'Already in target mode', blocked: 'Blocked' } as const
const STATUS_TONE = { change: 'text-emerald-700', unchanged: 'text-gray-500', blocked: 'text-rose-700' } as const

interface Props {
  groupId: string
  groupName: string
  /** Full group size (never the search-filtered size). */
  total: number
  onClose: () => void
  /** Called after a successful batch so the parent refreshes counts and rows. */
  onChanged: () => void
}

/**
 * Preview → confirm dialog for changing the migration mode of a whole module
 * group. The server resolves the group; this component only sends the group id.
 */
export default function BulkModeDialog({ groupId, groupName, total, onClose, onChanged }: Props) {
  const [target, setTarget] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<Selection>('all')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ text: string; code?: string } | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  // One key per (preview, selection): a retry of the same submission replays instead of repeating.
  const idempotencyKey = useRef(newKey())
  const submittingRef = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submittingRef.current) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const loadPreview = useCallback(async (mode: string) => {
    setTarget(mode); setLoading(true); setError(null); setPreview(null); setResult(null)
    const res = await callApi('/api/security-access/modes/bulk', { body: { action: 'preview', groupId, mode } })
    setLoading(false)
    if (!res.ok) { setError({ text: res.error || 'Unable to preview this change.', code: res.code }); return }
    const p: Preview = res.data.preview
    setPreview(p)
    setSelection('all')
    idempotencyKey.current = newKey()
  }, [groupId])

  const reasonOk = reason.trim().length >= 10
  const applicable = !!preview && (selection === 'all' ? preview.canApplyAll : preview.canApplyEligibleOnly)
  const toApply = preview ? preview.counts.change : 0

  async function apply() {
    if (!preview || !applicable || !reasonOk || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true); setError(null)
    const res = await callApi('/api/security-access/modes/bulk', {
      body: { action: 'apply', groupId, mode: preview.targetMode, selection, reason: reason.trim(), previewHash: preview.previewHash, idempotencyKey: idempotencyKey.current },
    })
    submittingRef.current = false
    setSubmitting(false)
    if (!res.ok) { setError({ text: res.error || 'Unable to apply this change.', code: res.code }); return }
    setResult(res.data.result)
    onChanged()
  }

  const pickSelection = (next: Selection) => { setSelection(next); idempotencyKey.current = newKey() }
  const missingMigration = error?.code === 'bulk_migration_missing'

  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="presentation">
    <div role="dialog" aria-modal="true" aria-labelledby="bulk-mode-title" className="my-8 w-full max-w-3xl rounded-xl bg-white shadow-xl">
      <div className="flex items-start justify-between gap-3 border-b border-gray-100 p-4">
        <div className="min-w-0">
          <h2 id="bulk-mode-title" className="font-semibold text-gray-950">Change group mode: {groupName}</h2>
          <p className="text-sm text-gray-500">Applies to all {total} permission{total === 1 ? '' : 's'} in this group, including any hidden by collapsed rows or search. Single permissions can still be changed individually.</p>
        </div>
        <button type="button" onClick={onClose} disabled={submitting} className={`rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 ${FOCUS}`}>Close</button>
      </div>

      <div className="space-y-4 p-4">
        {missingMigration && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-medium">Group mode changes are not available in this environment yet.</p>
          <p>The database migration <code>20261004100000_sa_bulk_migration_mode.sql</code> has not been applied. Apply it, then reopen this dialog. Individual permission changes are unaffected.</p>
        </div>}

        {!result && <fieldset>
          <legend className="text-sm font-medium text-gray-900">Target mode for {groupName} ({total})</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {MODES.map(m => <label key={m} className={`flex cursor-pointer gap-2 rounded-lg border p-2.5 text-sm ${target === m ? 'border-orange-400 bg-orange-50/50' : 'border-gray-200'}`}>
              <input type="radio" name="bulk-target-mode" value={m} checked={target === m} disabled={loading || submitting} onChange={() => loadPreview(m)} className="mt-1" />
              <span><span className="font-medium text-gray-900">{MODE_LABELS[m].label}</span><span className="block text-xs text-gray-500">{MODE_LABELS[m].help}</span></span>
            </label>)}
          </div>
        </fieldset>}

        {loading && <p role="status" className="text-sm text-gray-500">Checking every permission in {groupName}…</p>}
        {error && !missingMigration && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error.text}
          {(error.code === 'stale_preview') && target && <button type="button" onClick={() => loadPreview(target)} className={`ml-2 rounded font-medium underline ${FOCUS}`}>Refresh preview</button>}
        </div>}

        {preview && !result && <>
          <div role="status" className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <span className="font-medium text-gray-900">{preview.group.name} → {modeLabel(preview.targetMode).label}</span>
            <span className="text-emerald-700">{preview.counts.change} will change</span>
            <span className="text-gray-600">{preview.counts.unchanged} already in target mode</span>
            <span className={preview.counts.blocked ? 'text-rose-700' : 'text-gray-600'}>{preview.counts.blocked} blocked</span>
          </div>

          <div className="max-h-72 overflow-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <caption className="sr-only">Permissions in {preview.group.name}</caption>
              <thead className="sticky top-0 bg-gray-50 text-left text-xs font-medium text-gray-500">
                <tr><th scope="col" className="px-3 py-2">Permission</th><th scope="col" className="px-3 py-2">Current → target</th><th scope="col" className="px-3 py-2">Result</th></tr>
              </thead>
              <tbody>{preview.rows.map(r => <tr key={r.permissionKey} className="border-t border-gray-100 align-top">
                <th scope="row" className="px-3 py-1.5 text-left font-normal"><div className="text-gray-900">{r.label}</div><code className="text-[11px] text-gray-400">{r.permissionKey}</code></th>
                <td className="px-3 py-1.5 text-xs text-gray-700">{modeLabel(r.currentMode).label} → {modeLabel(r.targetMode).label}</td>
                <td className="px-3 py-1.5 text-xs">
                  <span className={`font-medium ${STATUS_TONE[r.status]}`}>{STATUS_TEXT[r.status]}</span>
                  {r.blockers.map(b => <div key={b.code} className="text-rose-700">{b.message}</div>)}
                </td>
              </tr>)}</tbody>
            </table>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-gray-900">What should be applied?</legend>
            <label className="flex gap-2 text-sm">
              <input type="radio" name="bulk-selection" checked={selection === 'all'} onChange={() => pickSelection('all')} className="mt-1" />
              <span><span className="font-medium text-gray-900">All permissions</span>
                <span className="block text-xs text-gray-500">{preview.counts.blocked > 0 ? 'Disabled while any permission is blocked: nothing will change.' : 'Every permission that is not already in the target mode changes together.'}</span></span>
            </label>
            {preview.counts.blocked > 0 && <label className={`flex gap-2 text-sm ${preview.canApplyEligibleOnly ? '' : 'opacity-50'}`}>
              <input type="radio" name="bulk-selection" checked={selection === 'eligible_only'} disabled={!preview.canApplyEligibleOnly} onChange={() => pickSelection('eligible_only')} className="mt-1" />
              <span><span className="font-medium text-gray-900">Eligible permissions only</span>
                <span className="block text-xs text-gray-500">Changes the {preview.counts.change} eligible permission{preview.counts.change === 1 ? '' : 's'}, skips the {preview.counts.blocked} blocked one{preview.counts.blocked === 1 ? '' : 's'} (left unchanged). Already-matching permissions are not touched.</span></span>
            </label>}
          </fieldset>

          <div>
            <label htmlFor="bulk-reason" className="text-sm font-medium text-gray-900">Reason (recorded in the audit log)</label>
            <textarea id="bulk-reason" value={reason} onChange={e => setReason(e.target.value)} rows={2} maxLength={500}
              className="mt-1 w-full rounded-lg border border-gray-200 p-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100" />
            {!reasonOk && <p className="text-xs text-gray-500">At least 10 characters.</p>}
          </div>

          {!applicable && <p role="status" className="text-sm text-gray-600">
            {preview.counts.change === 0 ? 'No changes remain: every permission is already in the target mode or blocked.' : 'Apply is disabled because some permissions are blocked and “All permissions” is selected. Nothing will change.'}
          </p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={submitting} className={`rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 ${FOCUS}`}>Cancel</button>
            <button type="button" onClick={apply} disabled={!applicable || !reasonOk || submitting}
              className={`rounded-lg bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}>
              {submitting ? 'Applying…' : `Apply to ${toApply} permission${toApply === 1 ? '' : 's'}`}
            </button>
          </div>
        </>}

        {result && <div role="status" className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <p className="font-medium">{result.replayed ? 'This change was already applied; nothing was repeated.' : 'Group mode changed and audited.'}</p>
          <p>{result.changed} changed · {result.unchanged} unchanged · {result.skipped} skipped</p>
          <p className="text-xs text-emerald-800">Batch {result.batchId}</p>
          <div className="flex justify-end"><button type="button" onClick={onClose} className={`rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-sm ${FOCUS}`}>Done</button></div>
        </div>}
      </div>
    </div>
  </div>
}
