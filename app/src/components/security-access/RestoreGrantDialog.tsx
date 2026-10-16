'use client'

import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { callApi, formatDate } from './client-api'
import { FOCUS } from './ui'

/** The revoked grant to restore, described with what the administrator already sees in Access history. */
export interface RestoreTarget {
  assignmentId: string
  personName: string
  personEmail: string | null
  policyName: string
  organizationName: string
  scopeText: string
  /** The validity the restored grant carries (from the server's restore status): original start if still ahead, original end. */
  effectiveFrom: string | null
  effectiveUntil: string | null
}

interface Props {
  target: RestoreTarget
  onClose: () => void
  /** Called after the server confirmed the restore, with the new grant's id. */
  onRestored: (newAssignmentId: string) => void
}

/**
 * Confirms a one-click restore of a revoked Group Policy grant: no configuration, just what will be granted. The server
 * re-checks the administrator's authority and every grant rule, then creates a NEW grant; the revoked entry stays in
 * Access history. Confirm is disabled while the request runs so a double click cannot submit twice.
 */
export default function RestoreGrantDialog({ target, onClose, onRestored }: Props) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submittingRef.current) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function confirm() {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true); setError(null)
    const result = await callApi('/api/security-access/assignments', { body: { action: 'restore_grant', assignmentId: target.assignmentId } })
    submittingRef.current = false
    setSubmitting(false)
    if (!result.ok) { setError(result.error || 'Unable to restore this grant. Nothing was changed.'); return }
    onRestored(String(result.data?.assignmentId || ''))
  }

  const validity = target.effectiveUntil
    ? `Until ${formatDate(target.effectiveUntil)} — the original end date (not extended)`
    : 'No end date (as originally granted)'
  const rows: Array<[string, React.ReactNode]> = [
    ['Person', <><span className="font-medium text-gray-900">{target.personName}</span>{target.personEmail && target.personEmail !== target.personName && <span className="block text-xs text-gray-500">{target.personEmail}</span>}</>],
    ['Group Policy', <span className="font-medium text-gray-900">{target.policyName}</span>],
    ['Organization', target.organizationName],
    ['Data scope', target.scopeText],
    ['Validity', <>{target.effectiveFrom && <span className="block">Starts {formatDate(target.effectiveFrom)}</span>}{validity}</>],
  ]

  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="presentation">
    <div role="dialog" aria-modal="true" aria-labelledby="restore-grant-title" aria-describedby="restore-grant-desc" className="my-8 w-full max-w-lg rounded-xl bg-white shadow-xl">
      <div className="border-b border-gray-100 p-4">
        <h2 id="restore-grant-title" className="font-semibold text-gray-950">Restore revoked access</h2>
        <p id="restore-grant-desc" className="text-sm text-gray-500">A new grant is created from this revoked entry. The revoked entry stays in Access history.</p>
      </div>
      <div className="space-y-3 p-4 text-sm">
        <dl className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-2">
          {rows.map(([label, value]) => <div key={label} className="contents">
            <dt className="text-gray-500">{label}</dt><dd className="min-w-0 break-words text-gray-800">{value}</dd>
          </div>)}
        </dl>
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          The policy&apos;s <span className="font-semibold">current</span> permissions apply, including any changes made since this access was revoked. Your name and the time are recorded in the access change log.
        </p>
        {error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={submitting} className={`rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-40 ${FOCUS}`}>Cancel</button>
          <button type="button" onClick={confirm} disabled={submitting} autoFocus
            className={`inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 font-medium text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />{submitting ? 'Restoring…' : 'Confirm Restore'}
          </button>
        </div>
      </div>
    </div>
  </div>
}
