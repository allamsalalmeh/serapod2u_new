'use client'

import { useEffect, useRef, useState } from 'react'
import { RotateCcw, ShieldOff } from 'lucide-react'
import { callApi } from './client-api'
import { FOCUS } from './ui'

/** Same minimum as the API schema and sa_revoke_assignment / sa_restore_assignment (trimmed length). */
export const ASSIGNMENT_REASON_MIN = 5
const ASSIGNMENT_REASON_MAX = 500

export type ReasonAction = 'revoke' | 'restore'

/** The one assignment to revoke or restore, described with what the administrator already sees in the person's access list. */
export interface ReasonTarget {
  action: ReasonAction
  assignmentId: string
  personName: string
  personEmail: string | null
  policyName: string
  organizationName: string
  scopeText: string
  /** Revoke: the automatic (lifecycle) source it overrides, null for an administrator grant. Restore: the source it returns to. */
  automaticSource: string | null
}

interface Props {
  target: ReasonTarget
  onClose: () => void
  /** Called only after the server confirmed the change. */
  onDone: () => void
}

const TEXT: Record<ReasonAction, { title: string; desc: string; reasonLabel: string; confirm: string; busy: string; fallbackError: string }> = {
  revoke: {
    title: 'Revoke access', desc: 'Only this entry is revoked; other granted, automatic or legacy access stays in place.',
    reasonLabel: 'Reason for revoking', confirm: 'Confirm Revoke', busy: 'Revoking…', fallbackError: 'Unable to revoke this access.',
  },
  restore: {
    title: 'Restore automatic access', desc: 'This entry returns to automatic management; other access stays in place.',
    reasonLabel: 'Reason for restoring', confirm: 'Confirm Restore', busy: 'Restoring…', fallbackError: 'Unable to restore this access.',
  },
}

/**
 * Confirms revoking, or restoring to automatic management, exactly one assignment, with a required reason. The server
 * re-checks the administrator's authority in the membership organization and records the reason in the access change
 * log; any refusal is shown here and nothing is reported as changed. Confirm is disabled while the request runs so a
 * double click cannot submit twice.
 */
export default function AssignmentReasonDialog({ target, onClose, onDone }: Props) {
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)
  const text = TEXT[target.action]
  const trimmed = reason.trim()
  const reasonValid = trimmed.length >= ASSIGNMENT_REASON_MIN

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submittingRef.current) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function confirm() {
    setTouched(true)
    if (!reasonValid || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true); setError(null)
    const result = await callApi('/api/security-access/assignments', { body: { action: target.action, assignmentId: target.assignmentId, reason: trimmed } })
    submittingRef.current = false
    setSubmitting(false)
    if (!result.ok) { setError(`${result.error || text.fallbackError}${/nothing was changed/i.test(result.error || '') ? '' : ' Nothing was changed.'}`); return }
    onDone()
  }

  const rows: Array<[string, React.ReactNode]> = [
    ['Person', <><span className="font-medium text-gray-900">{target.personName}</span>{target.personEmail && target.personEmail !== target.personName && <span className="block text-xs text-gray-500">{target.personEmail}</span>}</>],
    ['Group Policy', <span className="font-medium text-gray-900">{target.policyName}</span>],
    ['Organization', target.organizationName],
    ['Data scope', target.scopeText],
  ]
  const showReasonError = touched && !reasonValid
  const Icon = target.action === 'revoke' ? ShieldOff : RotateCcw

  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="presentation">
    <div role="dialog" aria-modal="true" aria-labelledby="assignment-reason-title" aria-describedby="assignment-reason-desc" className="my-8 w-full max-w-lg rounded-xl bg-white shadow-xl">
      <div className="border-b border-gray-100 p-4">
        <h2 id="assignment-reason-title" className="font-semibold text-gray-950">{text.title}</h2>
        <p id="assignment-reason-desc" className="text-sm text-gray-500">{text.desc}</p>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-2">
          {rows.map(([label, value]) => <div key={label} className="contents">
            <dt className="text-gray-500">{label}</dt><dd className="min-w-0 break-words text-gray-800">{value}</dd>
          </div>)}
        </dl>
        {target.automaticSource && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          {target.action === 'revoke'
            ? <>This is automatic access ({target.automaticSource}). Revoking overrides the automatic rule for this person; it will not be re-added automatically (an administrator can restore it later).</>
            : <>It returns to automatic access ({target.automaticSource}) and follows that rule again from now on.</>}
        </p>}
        <label className="block">
          <span className="text-gray-700">{text.reasonLabel} <span className="text-gray-400">(required)</span></span>
          <textarea rows={2} maxLength={ASSIGNMENT_REASON_MAX} value={reason} autoFocus disabled={submitting}
            onChange={e => setReason(e.target.value)} onBlur={() => setTouched(true)}
            aria-invalid={showReasonError} aria-describedby="assignment-reason-help"
            className={`mt-1 w-full rounded-lg border px-3 py-2 ${showReasonError ? 'border-rose-300' : ''}`} />
          <span id="assignment-reason-help" className={`block text-xs ${showReasonError ? 'text-rose-700' : 'text-gray-500'}`}>
            {showReasonError ? `Enter a reason of at least ${ASSIGNMENT_REASON_MIN} characters.` : `At least ${ASSIGNMENT_REASON_MIN} characters. Recorded in the access change log with your name and the time.`}
          </span>
        </label>
        {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={submitting} className={`rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-40 ${FOCUS}`}>Cancel</button>
          <button type="button" onClick={confirm} disabled={submitting || (touched && !reasonValid)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 ${target.action === 'revoke' ? 'bg-red-600 hover:bg-red-700' : 'bg-orange-600 hover:bg-orange-700'} ${FOCUS}`}>
            <Icon className="h-3.5 w-3.5" aria-hidden />{submitting ? text.busy : text.confirm}
          </button>
        </div>
      </div>
    </div>
  </div>
}
