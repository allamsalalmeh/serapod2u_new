'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { REPORTING_ISSUE_LABELS } from '@/lib/hr/employment-messages'

/**
 * Reporting-line check (Wave 2, migration 20261221100000): lists employees whose manager is a former/inactive person,
 * in another company, part of a cycle, missing, or different from the position hierarchy — and lets explicit HR fix
 * one line at a time with a reason. Nothing is changed automatically. The database validates and logs every change;
 * the leave approver (B2A) follows the new line immediately.
 */
export interface ReportingFinding {
  employee_user_id: string
  employee_name: string | null
  employee_no: number | null
  manager_user_id: string | null
  manager_name: string | null
  issue_code: string
  expected_manager_user_id: string | null
  expected_manager_name: string | null
}

export interface ManagerOption { id: string; name: string }

export default function ReportingLinesReviewDialog({ open, onOpenChange, managers, onChanged }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Active, onboarded people offered as managers (the database still validates). */
  managers: ManagerOption[]
  onChanged?: () => void
}) {
  const { toast } = useToast()
  const [findings, setFindings] = useState<ReportingFinding[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(async () => {
    setFindings(null)
    setError(null)
    try {
      const res = await fetch('/api/hr/reporting-lines')
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) { setError(json.error || 'The reporting-line check could not be loaded.'); setFindings([]); return }
      setFindings(json.data as ReportingFinding[])
      setChoice(Object.fromEntries((json.data as ReportingFinding[]).filter((f) => f.expected_manager_user_id).map((f) => [f.employee_user_id, f.expected_manager_user_id!])))
    } catch {
      setError('The reporting-line check could not be loaded.')
      setFindings([])
    }
  }, [])

  useEffect(() => { if (open) void load() }, [open, load])

  const apply = async (f: ReportingFinding) => {
    const target = choice[f.employee_user_id]
    if (!target) { toast({ title: 'Choose a manager', variant: 'destructive' }); return }
    if (reason.trim().length < 5) { toast({ title: 'Reason required', description: 'Enter a reason (at least 5 characters).', variant: 'destructive' }); return }
    setSaving(f.employee_user_id)
    try {
      const res = await fetch('/api/hr/reporting-lines', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set', employee_user_id: f.employee_user_id, manager_user_id: target === 'none' ? null : target, reason: reason.trim() }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        toast({ title: 'Reporting line not changed', description: json.error || 'The change could not be saved.', variant: 'destructive' })
      } else {
        toast({ title: 'Reporting line updated', description: `${f.employee_name ?? 'Employee'} now reports to ${managers.find((m) => m.id === target)?.name ?? 'nobody'}.` })
        onChanged?.()
        await load()
      }
    } finally {
      setSaving(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Reporting-line check</DialogTitle>
          <DialogDescription>
            Employees whose reporting line needs HR attention. Leave approval by the direct manager follows this line, so fix
            former or inactive managers first. Nothing changes until you apply a row.
          </DialogDescription>
        </DialogHeader>
        {findings === null ? (
          <div className="py-8 text-center text-sm text-muted-foreground"><Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />Checking reporting lines…</div>
        ) : error ? (
          <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{error}</div>
        ) : findings.length === 0 ? (
          <div className="flex items-center gap-2 py-6 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" />No reporting-line issues found.</div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="rl-reason" className="text-xs">Reason for the change (recorded in history)</Label>
              <Input id="rl-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Previous manager resigned" />
            </div>
            <ul className="space-y-2" aria-label="Reporting-line findings">
              {findings.map((f) => (
                <li key={f.employee_user_id} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium">{f.employee_name ?? 'Employee'}{f.employee_no ? ` · EMP-${String(f.employee_no).padStart(4, '0')}` : ''}</div>
                      <div className="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3 w-3" />{REPORTING_ISSUE_LABELS[f.issue_code] ?? f.issue_code}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        Current manager: {f.manager_name ?? 'none'}{f.expected_manager_name ? ` · position hierarchy suggests ${f.expected_manager_name}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <Select value={choice[f.employee_user_id] ?? ''} onValueChange={(v) => setChoice((c) => ({ ...c, [f.employee_user_id]: v }))}>
                      <SelectTrigger className="h-9 sm:w-72" aria-label={`New manager for ${f.employee_name ?? 'employee'}`}><SelectValue placeholder="Choose new manager" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No manager</SelectItem>
                        {managers.filter((m) => m.id !== f.employee_user_id).map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button size="sm" onClick={() => apply(f)} disabled={saving !== null}>
                      {saving === f.employee_user_id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Apply'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
