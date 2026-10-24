'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertTriangle, Archive, Check, Loader2, ShieldCheck, Trash2 } from 'lucide-react'
import {
  BULK_CLASSIFICATION_LABELS, BULK_OUTCOME_LABELS, bulkActionLabel,
} from '@/lib/identity/bulk-removal-labels'
import type {
  BulkRemovalEligibility, BulkRemovalPlanEntry, BulkRemovalSummary, BulkEmploymentEnd,
} from '@/lib/identity/bulk-removal-plan'

/**
 * Bulk employee removal for HR → People → Employees.
 *
 * Flow: authoritative per-employee eligibility preview (read-only) → review the
 * operation for every selected identity → server-issued confirmation contract
 * (phrase + short-lived signed plan) → typed phrase → execution through the
 * canonical per-identity delete/archive services. Nothing is changed when the
 * dialog opens, and no permanent deletion is ever silently turned into an
 * archive (or the reverse).
 */

type Step = 'preview' | 'review' | 'confirm' | 'done'
type Choice = 'delete' | 'archive' | 'skip'

export interface BulkRemovalDialogProps {
  targets: Array<{ id: string; name: string; employeeNo?: number | null }>
  onClose: () => void
  /** Called once after a processed batch; refresh lists/counts and clear completed selections. */
  onCompleted: (result: {
    outcomes: Array<{ userId: string; name: string; outcome: string }>
    complete: boolean
  }) => void | Promise<void>
  notify?: (message: { title: string; description: string; variant?: 'destructive' }) => void
}

interface PlanResponse {
  token: string
  request_id: string
  phrase: string
  plan_ref: string
  expires_at: string
  targets: BulkRemovalEligibility[]
  summary: BulkRemovalSummary
}

interface ExecutionSummary {
  total: number
  deleted: number
  archived: number
  blocked: number
  failed: number
  stale: number
  conflict: number
  unconfirmed: number
}

interface ExecutionResult {
  request_id: string
  summary: ExecutionSummary
  complete: boolean
  results: Array<{
    user_id: string
    name: string
    action: 'delete' | 'archive'
    outcome: 'deleted' | 'archived' | 'blocked' | 'failed' | 'stale' | 'conflict' | 'unconfirmed'
    detail: string | null
    released?: boolean
    replayed?: boolean
    retryable?: boolean
  }>
}

const employeeLabel = (target: { full_name: string | null; user_id?: string }, fallback?: string) =>
  target.full_name || fallback || 'Unnamed employee'

const formatEmployeeNo = (no: number | null | undefined) =>
  no ? `EMP-${String(no).padStart(4, '0')}` : 'No employee number'

const statusLabel = (row: BulkRemovalEligibility) => {
  if (row.account_status === 'ARCHIVED') return 'Former employee (archived)'
  if (row.onboarding_status === 'pending') return 'Awaiting onboarding'
  if (row.onboarding_status === 'reset') return 'HR registration reset'
  if (row.onboarding_status === 'completed') return 'Onboarded'
  return row.account_status || 'Unknown status'
}

const defaultChoice = (row: BulkRemovalEligibility): Choice =>
  row.classification === 'DELETE_ELIGIBLE' ? 'delete'
    : row.classification === 'ARCHIVE_ELIGIBLE' ? 'archive' : 'skip'

const normalizePhrase = (value: string) => value.trim().replace(/\s+/g, ' ').toUpperCase()

export default function BulkRemovalDialog({ targets, onClose, onCompleted, notify }: BulkRemovalDialogProps) {
  const [step, setStep] = useState<Step>('preview')
  const [eligibility, setEligibility] = useState<BulkRemovalEligibility[]>([])
  const [summary, setSummary] = useState<BulkRemovalSummary | null>(null)
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [employment, setEmployment] = useState<Record<string, BulkEmploymentEnd>>({})
  const [release, setRelease] = useState<Record<string, boolean>>({})
  const [defaultEmployment, setDefaultEmployment] = useState<BulkEmploymentEnd>('resigned')
  const [defaultRelease, setDefaultRelease] = useState(true)
  const [plan, setPlan] = useState<(PlanResponse & { entries: BulkRemovalPlanEntry[] }) | null>(null)
  const [reason, setReason] = useState('')
  const [typed, setTyped] = useState('')
  const [results, setResults] = useState<ExecutionResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The selection being reviewed. On a safe retry this becomes the unchanged subset only.
  const [activeTargets, setActiveTargets] = useState(targets)

  const userIds = useMemo(() => activeTargets.map(target => target.id), [activeTargets])

  /** Refresh authoritative rows without leaving a now-invalid operation selected. */
  const applyEligibility = (rows: BulkRemovalEligibility[], nextSummary: BulkRemovalSummary | null) => {
    setEligibility(rows)
    setSummary(nextSummary)
    setChoices(previous => Object.fromEntries(rows.map(row => {
      const current = previous[row.user_id]
      const stillAllowed = current === 'delete' ? row.delete_allowed
        : current === 'archive' ? row.archive_allowed
          : current === 'skip'
      return [row.user_id, stillAllowed ? current! : defaultChoice(row)]
    })) as Record<string, Choice>)
    setEmployment(previous => Object.fromEntries(rows.map(row => [row.user_id, previous[row.user_id] ?? 'resigned'])))
    setRelease(previous => Object.fromEntries(rows.map(row => [row.user_id, previous[row.user_id] ?? row.releasable])))
  }

  const loadPreview = async (ids: string[] = userIds, prefill: BulkRemovalPlanEntry[] = []) => {
    setLoading(true)
    setError(null)
    setPlan(null)
    setTyped('')
    try {
      const res = await fetch('/api/hr/employees/bulk-removal/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: ids }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setEligibility([])
        setSummary(null)
        setError(json.error || 'The eligibility check failed. Nothing was changed.')
      } else {
        const rows = (json.data?.targets ?? []) as BulkRemovalEligibility[]
        setEligibility(rows)
        setSummary(json.data?.summary ?? null)
        setChoices(Object.fromEntries(rows.map(row => {
          const previous = prefill.find(entry => entry.user_id === row.user_id)
          if (!previous) return [row.user_id, defaultChoice(row)]
          const stillAllowed = previous.action === 'delete' ? row.delete_allowed : row.archive_allowed
          return [row.user_id, stillAllowed ? previous.action : defaultChoice(row)]
        })) as Record<string, Choice>)
        setEmployment(Object.fromEntries(rows.map(row => [
          row.user_id, prefill.find(entry => entry.user_id === row.user_id)?.employment_end ?? 'resigned',
        ])))
        setRelease(Object.fromEntries(rows.map(row => [
          row.user_id,
          prefill.find(entry => entry.user_id === row.user_id)
            ? prefill.find(entry => entry.user_id === row.user_id)!.release_identifiers && row.releasable
            : row.releasable,
        ])))
      }
    } catch {
      setEligibility([])
      setError('The eligibility check did not complete. Nothing was changed.')
    } finally {
      setLoading(false)
      setStep('review')
    }
  }

  useEffect(() => {
    loadPreview()
    // The dialog is mounted per selection; the target list is fixed while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const planEntries = useMemo<BulkRemovalPlanEntry[]>(() => eligibility
    .filter(row => (choices[row.user_id] ?? 'skip') !== 'skip')
    .map(row => ({
      user_id: row.user_id,
      action: choices[row.user_id] === 'archive' ? 'archive' : 'delete',
      employment_end: employment[row.user_id] ?? 'resigned',
      release_identifiers: (choices[row.user_id] === 'archive') && (release[row.user_id] === true),
    })), [eligibility, choices, employment, release])

  const deleteCount = planEntries.filter(entry => entry.action === 'delete').length
  const archiveCount = planEntries.filter(entry => entry.action === 'archive').length
  const skippedCount = eligibility.length - planEntries.length

  const applyDefaultEmployment = (value: BulkEmploymentEnd) => {
    setDefaultEmployment(value)
    setEmployment(Object.fromEntries(eligibility.map(row => [row.user_id, value])))
  }
  const applyDefaultRelease = (value: boolean) => {
    setDefaultRelease(value)
    setRelease(Object.fromEntries(eligibility.map(row => [row.user_id, value && row.releasable])))
  }

  const choose = (row: BulkRemovalEligibility, value: Choice) => {
    setChoices(previous => ({
      ...previous,
      [row.user_id]: value === 'delete' && !row.delete_allowed ? 'skip'
        : value === 'archive' && !row.archive_allowed ? 'skip' : value,
    }))
  }


  const requestPlan = async () => {
    if (planEntries.length === 0) {
      setError('Choose at least one employee to remove.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/hr/employees/bulk-removal/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planEntries }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        // The server re-checked and refused: show the current authoritative state.
        if (Array.isArray(json.data?.targets) && json.data.targets.length > 0) {
          applyEligibility(json.data.targets as BulkRemovalEligibility[], null)
        }
        setError(json.error || 'The confirmation could not be prepared. Nothing was changed.')
        notify?.({ title: 'Not changed', description: json.error || 'Nothing was changed.', variant: 'destructive' })
        return
      }
      setPlan({ ...(json.data as PlanResponse), entries: planEntries })
      setTyped('')
      setReason('')
      setStep('confirm')
    } catch {
      setError('The confirmation could not be prepared. Nothing was changed.')
    } finally {
      setSubmitting(false)
    }
  }

  const backToReview = () => {
    // Any change after confirmation invalidates the token: it is not kept.
    setPlan(null)
    setTyped('')
    setError(null)
    setStep('review')
  }

  const phraseOk = !!plan && normalizePhrase(typed) === normalizePhrase(plan.phrase)
  const reasonOk = deleteCount === 0 || reason.trim().length >= 10
  const canExecute = !!plan && phraseOk && reasonOk && !submitting

  const execute = async () => {
    if (!plan || !canExecute) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/hr/employees/bulk-removal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: plan.request_id,
          batch_token: plan.token,
          confirmation: typed,
          reason: reason.trim(),
          plan: plan.entries,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (json?.data?.results) {
        const execution = json.data as ExecutionResult
        setResults(execution)
        setStep('done')
        const outcomes = execution.results.map(result => ({ userId: result.user_id, name: result.name, outcome: result.outcome }))
        await onCompleted({ outcomes, complete: execution.complete })
        notify?.({
          title: execution.complete ? 'Employees removed' : 'Bulk removal finished with exceptions',
          description: `${execution.summary.deleted} deleted · ${execution.summary.archived} archived · `
            + `${execution.summary.conflict} temporary conflict · ${execution.summary.unconfirmed} unconfirmed · `
            + `${execution.summary.blocked + execution.summary.stale} unchanged · ${execution.summary.failed} failed.`,
          variant: execution.complete ? undefined : 'destructive',
        })
        return
      }
      if (json.code === 'PREVIEW_STALE' || json.code === 'PLAN_CHANGED' || json.code === 'PLAN_NOT_ALLOWED'
        || json.code === 'TOKEN_EXPIRED' || json.code === 'INVALID_TOKEN') {
        notify?.({ title: 'Review again', description: json.error || 'The plan changed.', variant: 'destructive' })
        await loadPreview()
        return
      }
      setError(json.error || 'Nothing was changed.')
      notify?.({ title: 'Not changed', description: json.error || 'Nothing was changed.', variant: 'destructive' })
    } catch {
      setError('The result could not be confirmed. Submit again to check — repeating the same request is safe.')
    } finally {
      setSubmitting(false)
    }
  }

  const retryableResults = results?.results.filter(result => result.retryable) ?? []

  /**
   * Safe retry: only employees the server marked retryable (proven unchanged),
   * only their previously reviewed operation, and always through a fresh
   * authoritative preview + new confirmation phrase. Never an automatic repeat
   * of a destructive call from the browser.
   */
  const retryUnchanged = async () => {
    if (!results || !plan || retryableResults.length === 0) return
    const entries = plan.entries.filter(entry => retryableResults.some(result => result.user_id === entry.user_id))
    if (entries.length === 0) return
    setActiveTargets(retryableResults.map(result => ({ id: result.user_id, name: result.name })))
    setResults(null)
    setReason('')
    setTyped('')
    setError(null)
    await loadPreview(entries.map(entry => entry.user_id), entries)
  }

  const close = () => { if (!submitting) onClose() }


  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="sm:max-w-[720px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4" /> Remove employees
          </DialogTitle>
          <DialogDescription>
            Review the planned action for every selected employee. Nothing is changed until the confirmed
            operation is submitted, and the server re-checks every person again at that moment.
          </DialogDescription>
        </DialogHeader>

        {loading || step === 'preview' ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking each selected employee…
          </div>
        ) : step === 'review' ? (
          <div className="space-y-4">
            {summary && (
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div className="rounded-lg border px-3 py-2">
                  <div className="text-muted-foreground">Selected</div>
                  <div className="text-base font-semibold">{summary.total}</div>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <div className="text-muted-foreground">Permanent deletion</div>
                  <div className="text-base font-semibold">{deleteCount}</div>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <div className="text-muted-foreground">Archive &amp; revoke</div>
                  <div className="text-base font-semibold">{archiveCount}</div>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <div className="text-muted-foreground">Skipped / blocked</div>
                  <div className="text-base font-semibold">{skippedCount}</div>
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 px-3 py-2 sm:flex-row sm:items-end">
              <div className="space-y-1">
                <Label htmlFor="bulk-default-employment" className="text-xs">Employment outcome for archived employees</Label>
                <select
                  id="bulk-default-employment"
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  value={defaultEmployment}
                  onChange={(event) => applyDefaultEmployment(event.target.value as BulkEmploymentEnd)}
                >
                  <option value="resigned">Resigned</option>
                  <option value="terminated">Terminated</option>
                </select>
              </div>
              <label className="flex items-start gap-2 text-xs">
                <Checkbox
                  checked={defaultRelease}
                  onCheckedChange={(checked) => applyDefaultRelease(checked === true)}
                  className="mt-0.5"
                  aria-label="Release email and phone for archived employees"
                />
                <span>Release email and phone for archived employees (default; each employee can be overridden)</span>
              </label>
            </div>

            <div className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                <ShieldCheck className="h-3.5 w-3.5" /> What happens to each identity
              </div>
              <ul className="list-disc space-y-0.5 pl-5">
                <li>Permanent deletion: login, user account and HR anchor are removed. It is offered only when the database finds no protected history.</li>
                <li>Archive &amp; Revoke Access: sign-in, sessions and effective Security &amp; Access end immediately. UUID, employee number, historical transactions and audit records are kept.</li>
                <li>Skip: the identity is left completely unchanged.</li>
              </ul>
            </div>

            <div className="space-y-2">

              {eligibility.map(row => {
                const choice = choices[row.user_id] ?? 'skip'
                const blockers = [...new Set(row.blockers.map(blocker => blocker.message || blocker.code))]
                return (
                  <div key={row.user_id} className="rounded-lg border px-3 py-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{employeeLabel(row, activeTargets.find(t => t.id === row.user_id)?.name)}</div>
                        <div className="text-xs text-muted-foreground">
                          {formatEmployeeNo(row.employee_no)} · {row.organization_name || 'No organization'}
                        </div>
                        <div className="text-xs text-muted-foreground">{statusLabel(row)}</div>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${row.classification === 'DELETE_ELIGIBLE' ? 'border-red-200 bg-red-50 text-red-700'
                        : row.classification === 'ARCHIVE_ELIGIBLE' ? 'border-amber-200 bg-amber-50 text-amber-800'
                          : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                        {BULK_CLASSIFICATION_LABELS[row.classification]}
                      </span>
                    </div>

                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <div className="space-y-1">
                        <Label htmlFor={`bulk-operation-${row.user_id}`} className="text-xs">Operation</Label>
                        <select
                          id={`bulk-operation-${row.user_id}`}
                          aria-label={`Operation for ${employeeLabel(row)}`}
                          className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                          value={choice}
                          onChange={(event) => choose(row, event.target.value as Choice)}
                        >
                          {row.delete_allowed && <option value="delete">Permanently delete</option>}
                          {row.archive_allowed && <option value="archive">Archive &amp; revoke access</option>}
                          <option value="skip">Skip this employee</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`bulk-employment-${row.user_id}`} className="text-xs">Employment outcome</Label>
                        <select
                          id={`bulk-employment-${row.user_id}`}
                          aria-label={`Employment outcome for ${employeeLabel(row)}`}
                          className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                          value={employment[row.user_id] ?? 'resigned'}
                          disabled={choice !== 'archive'}
                          onChange={(event) => setEmployment(previous => ({ ...previous, [row.user_id]: event.target.value as BulkEmploymentEnd }))}
                        >
                          <option value="resigned">Resigned</option>
                          <option value="terminated">Terminated</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Email &amp; phone</Label>
                        <label className="flex h-8 items-center gap-2 text-xs">
                          <Checkbox
                            checked={choice === 'archive' && release[row.user_id] === true}
                            disabled={choice !== 'archive' || !row.releasable}
                            onCheckedChange={(checked) => setRelease(previous => ({ ...previous, [row.user_id]: checked === true }))}
                            aria-label={`Release email and phone for ${employeeLabel(row)}`}
                          />
                          <span>Release for reuse</span>
                        </label>
                      </div>
                    </div>

                    {blockers.length > 0 && (
                      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-muted-foreground">
                        {blockers.map(blocker => <li key={blocker}>{blocker}</li>)}
                      </ul>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {choice === 'delete'
                        ? 'Removes the login and identity; only available when no protected history exists.'
                        : choice === 'archive'
                          ? 'Keeps the UUID, employee number and all history; access ends immediately.'
                          : 'Left unchanged.'}
                    </p>
                    {row.classification === 'UNVERIFIED' && (
                      <p className="mt-1 text-[11px] text-red-600">Eligibility could not be verified, so this employee is skipped.</p>
                    )}
                  </div>
                )
              })}
            </div>

            {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
          </div>
        ) : step === 'confirm' && plan ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              <div className="mb-1 flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5" /> Review the confirmed plan</div>
              <ul className="list-disc space-y-0.5 pl-5">
                {deleteCount > 0 && <li>{deleteCount} account{deleteCount === 1 ? '' : 's'} will be permanently deleted. This cannot be undone.</li>}
                {archiveCount > 0 && <li>{archiveCount} account{archiveCount === 1 ? '' : 's'} will be archived: sign-in and access end immediately, history is kept.</li>}
                {skippedCount > 0 && <li>{skippedCount} selected {skippedCount === 1 ? 'employee is' : 'employees are'} skipped and remain unchanged.</li>}
                <li>Archived identities lose login, sessions and effective Security &amp; Access; historical records are never changed.</li>
              </ul>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">Plan reference</span>
              <span className="font-mono font-semibold">{plan.plan_ref}</span>
            </div>

            <div className="rounded-lg border divide-y">
              {plan.entries.map(entry => {
                const row = plan.targets.find(target => target.user_id === entry.user_id)
                return (
                  <div key={entry.user_id} className="flex flex-col gap-1 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-medium">{row ? employeeLabel(row, activeTargets.find(t => t.id === entry.user_id)?.name) : entry.user_id}</div>
                      <div className="text-muted-foreground">
                        {formatEmployeeNo(row?.employee_no)} · {row?.organization_name || 'No organization'}
                        {entry.action === 'archive' && ` · ${entry.employment_end === 'terminated' ? 'Terminated' : 'Resigned'} · identifiers ${entry.release_identifiers ? 'released' : 'kept'}`}
                      </div>
                    </div>
                    <span className={`rounded-full border px-2 py-0.5 ${entry.action === 'delete' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                      {bulkActionLabel(entry.action)}
                    </span>
                  </div>
                )
              })}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bulk-removal-reason" className="text-xs">
                Reason {deleteCount > 0 ? '(required for permanent deletion)' : '(optional)'}
              </Label>
              <Textarea
                id="bulk-removal-reason"
                rows={2}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={deleteCount > 0 ? 'e.g. Duplicate test accounts created before go-live' : 'Optional — e.g. Contract ended 31 Oct 2026'}
              />
              {deleteCount > 0 && reason.trim().length > 0 && reason.trim().length < 10 && (
                <p className="text-[11px] text-red-600">Enter at least 10 characters.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bulk-removal-phrase" className="text-xs">
                Type <span className="font-mono font-semibold text-foreground">{plan.phrase}</span> to confirm
              </Label>
              <Input
                id="bulk-removal-phrase"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                Expires {new Date(plan.expires_at).toLocaleTimeString()}. Any change to the selection or plan requires a new confirmation.
              </p>
            </div>

            {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
          </div>
        ) : step === 'done' && results ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {([
                ['Deleted', results.summary.deleted],
                ['Archived', results.summary.archived],
                ['Conflict', results.summary.conflict],
                ['Unconfirmed', results.summary.unconfirmed],
                ['Blocked', results.summary.blocked],
                ['Changed', results.summary.stale],
                ['Failed', results.summary.failed],
              ] as const).map(([label, count]) => (
                <div key={label} className="rounded-lg border px-3 py-2">
                  <div className="text-muted-foreground">{label}</div>
                  <div className="text-base font-semibold">{count}</div>
                </div>
              ))}
            </div>

            <div className="rounded-lg border divide-y">
              {results.results.map(result => (
                <div key={result.user_id} className="px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{result.name}</span>
                    <span className={`rounded-full border px-2 py-0.5 ${result.outcome === 'deleted' || result.outcome === 'archived'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                      {BULK_OUTCOME_LABELS[result.outcome] ?? result.outcome}
                    </span>
                  </div>
                  <div className="text-muted-foreground">
                    {bulkActionLabel(result.action)}
                    {result.released ? ' · email and phone released' : ''}
                    {result.replayed ? ' · previous result reused (safe retry)' : ''}
                  </div>
                  {result.detail && <div className="mt-0.5 text-[11px] text-muted-foreground">{result.detail}</div>}
                </div>
              ))}
            </div>

            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" /> Every result above is recorded per employee in the audit history.
              {retryableResults.length > 0 && ' Employees marked as a temporary conflict were not changed; retrying them is safe.'}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {step === 'review' ? (
            <>
              <Button variant="outline" onClick={close} disabled={submitting}>Cancel</Button>
              <Button onClick={requestPlan} disabled={submitting || loading || planEntries.length === 0}>
                {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
                Review confirmation
              </Button>
            </>
          ) : step === 'confirm' ? (
            <>
              <Button variant="outline" onClick={backToReview} disabled={submitting}>Back</Button>
              <Button variant="destructive" onClick={execute} disabled={!canExecute}>
                {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1" />}
                Remove employees
              </Button>
            </>
          ) : step === 'done' ? (
            <>
              {retryableResults.length > 0 && (
                <Button variant="outline" onClick={retryUnchanged} disabled={submitting || loading}>
                  Retry unchanged employees ({retryableResults.length})
                </Button>
              )}
              <Button onClick={close} disabled={submitting}>Close</Button>
            </>
          ) : (
            <Button variant="outline" onClick={close} disabled={submitting}>Cancel</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


