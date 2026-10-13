'use client'

import { useEffect, useRef, useState } from 'react'
import { modeLabel, permissionLabel } from '@/lib/security-access/labels'
import { MODE_NOTE_MAX, MODE_REASON_MIN, reasonRequiredFor } from '@/lib/security-access/mode-change-rules'
import { callApi } from './client-api'
import { FOCUS } from './ui'

interface Props {
  permissionKey: string
  currentMode: string
  targetMode: string
  onClose: () => void
  /** Called after the server confirmed the change. */
  onChanged: () => void
}

/**
 * Confirms one permission's mode change. Moving back to Legacy enforced or Monitoring / Shadow asks for a reason;
 * moving to New Access Active or Legacy Retired takes an optional note (collapsed under “Add note”). The server and
 * the database apply the same rule and record actor, time, old/new mode and the note (or a generated description).
 */
export default function ModeChangeDialog({ permissionKey, currentMode, targetMode, onClose, onChanged }: Props) {
  const reasonRequired = reasonRequiredFor(currentMode, targetMode)
  const [noteOpen, setNoteOpen] = useState(reasonRequired)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const label = permissionLabel(permissionKey).label

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submittingRef.current) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const trimmed = text.trim()
  const valid = trimmed.length <= MODE_NOTE_MAX && (!reasonRequired || trimmed.length >= MODE_REASON_MIN)

  async function submit() {
    if (!valid || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true); setError(null)
    const result = await callApi('/api/security-access/modes', { body: { permissionKey, mode: targetMode, ...(trimmed ? { reason: trimmed } : {}) } })
    submittingRef.current = false
    setSubmitting(false)
    if (!result.ok) { setError(result.error || 'Unable to change mode'); return }
    onChanged()
  }

  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="presentation">
    <div role="dialog" aria-modal="true" aria-labelledby="mode-change-title" className="my-8 w-full max-w-lg rounded-xl bg-white shadow-xl">
      <div className="border-b border-gray-100 p-4">
        <h2 id="mode-change-title" className="font-semibold text-gray-950">Change mode: {label}</h2>
        <p className="text-sm text-gray-500"><code className="text-xs">{permissionKey}</code></p>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <p className="text-gray-900">{modeLabel(currentMode).label} → <span className="font-medium">{modeLabel(targetMode).label}</span></p>
        <p className="text-xs text-gray-500">{modeLabel(targetMode).help}</p>

        {reasonRequired
          ? <div>
            <label htmlFor="mode-change-reason" className="font-medium text-gray-900">Reason (required, recorded in the audit log)</label>
            <textarea id="mode-change-reason" value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={MODE_NOTE_MAX} autoFocus
              className="mt-1 w-full rounded-lg border border-gray-200 p-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100" />
            <p className="text-xs text-gray-500">Moving back to {modeLabel(targetMode).label} needs a reason of at least {MODE_REASON_MIN} characters.</p>
          </div>
          : <div>
            <p className="text-xs text-gray-500">Your name, the time and the old and new mode are recorded automatically.</p>
            {!noteOpen
              ? <button type="button" onClick={() => setNoteOpen(true)} className={`mt-1 rounded text-sm font-medium text-orange-700 underline ${FOCUS}`}>Add note</button>
              : <div className="mt-1">
                <label htmlFor="mode-change-note" className="font-medium text-gray-900">Note (optional)</label>
                <textarea id="mode-change-note" value={text} onChange={e => setText(e.target.value)} rows={2} maxLength={MODE_NOTE_MAX} autoFocus
                  className="mt-1 w-full rounded-lg border border-gray-200 p-2 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100" />
              </div>}
          </div>}

        {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={submitting} className={`rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 ${FOCUS}`}>Cancel</button>
          <button type="button" onClick={submit} disabled={!valid || submitting}
            className={`rounded-lg bg-orange-600 px-3 py-1.5 font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}>
            {submitting ? 'Changing…' : `Change to ${modeLabel(targetMode).label}`}
          </button>
        </div>
      </div>
    </div>
  </div>
}
