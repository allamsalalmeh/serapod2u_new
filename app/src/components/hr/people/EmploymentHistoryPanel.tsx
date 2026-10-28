'use client'

import { useEffect, useState } from 'react'
import { Loader2, History, PencilLine } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { CHANGE_KIND_LABELS } from '@/lib/hr/employment-messages'

/**
 * Effective-dated employment history of one person (Wave 2, migration 20261221100000). Read-only: history is
 * append-only in the database. Who may read it is decided by the database (the employee, or explicit HR).
 */
export interface EmploymentVersion {
  version_no: number
  change_kind: string
  effective_date: string
  recorded_at: string
  status: string | null
  employment_type: string | null
  department_name: string | null
  position_name: string | null
  manager_name: string | null
  hire_date: string | null
  end_date: string | null
  changed_columns: string[]
  reason: string | null
  actor_name: string | null
}

const FIELD_LABELS: Record<string, string> = {
  status: 'status', employment_type: 'employment type', department_id: 'department', position_id: 'position',
  manager_user_id: 'manager', hire_date: 'hire date', end_date: 'end date', probation_end: 'probation end',
  organization_id: 'company', onboarding_status: 'onboarding',
}

/** Options for a controlled employment change (shown only to HR who may change this employee). */
export interface EmploymentChangeOptions {
  departments: { id: string; dept_name: string }[]
  positions: { id: string; name: string }[]
  managers: { id: string; name: string }[]
}

const UNCHANGED = ''
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Intern']
const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Only the fields HR actually changed are sent; the database refuses everything else (future dates, self, other company). */
export function buildEmploymentChange(form: { department: string; position: string; manager: string; type: string; probationEnd: string; status: string }) {
  const changes: Record<string, string | null> = {}
  if (form.department !== UNCHANGED) changes.department_id = form.department === 'none' ? null : form.department
  if (form.position !== UNCHANGED) changes.position_id = form.position === 'none' ? null : form.position
  if (form.manager !== UNCHANGED) changes.manager_user_id = form.manager === 'none' ? null : form.manager
  if (form.type !== UNCHANGED) changes.employment_type = form.type
  if (form.probationEnd !== UNCHANGED) changes.probation_end = form.probationEnd
  if (form.status !== UNCHANGED) changes.status = form.status
  return changes
}

const EMPTY_FORM = { department: UNCHANGED, position: UNCHANGED, manager: UNCHANGED, type: UNCHANGED, probationEnd: UNCHANGED, status: UNCHANGED }

function EmploymentChangeForm({ userId, options, onSaved }: { userId: string; options: EmploymentChangeOptions; onSaved: () => void }) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [effectiveDate, setEffectiveDate] = useState(todayIso())
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const changes = buildEmploymentChange(form)
  const nothingChanged = Object.keys(changes).length === 0

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/hr/employees/${userId}/employment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes, effective_date: effectiveDate, reason: reason.trim() }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        toast({ title: 'Change not recorded', description: json.error || 'The employment change could not be recorded.', variant: 'destructive' })
        return
      }
      toast({ title: 'Employment change recorded', description: `Effective ${fmt(effectiveDate)} — a new history version was written with your reason.` })
      setForm(EMPTY_FORM); setReason(''); setEffectiveDate(todayIso()); setOpen(false)
      onSaved()
    } catch {
      toast({ title: 'Change not recorded', description: 'The server could not be reached. Check your connection and try again.', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="w-full" onClick={() => setOpen(true)}>
        <PencilLine className="mr-1 h-4 w-4" />Record employment change (effective-dated)
      </Button>
    )
  }
  const select = 'h-9 w-full rounded-md border bg-background px-2 text-sm'
  return (
    <div className="space-y-3 rounded-lg border p-3" aria-label="Record employment change">
      <p className="text-xs text-muted-foreground">Transfer, promotion, new manager or employment type. Leave a field on “No change”. The effective date can be today or earlier (back-dated); ending employment is done with Archive &amp; Revoke Access.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="ec-date">Effective date</Label><Input id="ec-date" type="date" max={todayIso()} value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="ec-dept">Department</Label>
          <select id="ec-dept" className={select} value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
            <option value={UNCHANGED}>No change</option><option value="none">No department</option>
            {options.departments.map((d) => <option key={d.id} value={d.id}>{d.dept_name}</option>)}
          </select></div>
        <div className="space-y-1"><Label htmlFor="ec-pos">Position</Label>
          <select id="ec-pos" className={select} value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })}>
            <option value={UNCHANGED}>No change</option><option value="none">No position</option>
            {options.positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <div className="space-y-1"><Label htmlFor="ec-mgr">Manager</Label>
          <select id="ec-mgr" className={select} value={form.manager} onChange={(e) => setForm({ ...form, manager: e.target.value })}>
            <option value={UNCHANGED}>No change</option><option value="none">No manager (top leader)</option>
            {options.managers.filter((m) => m.id !== userId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select></div>
        <div className="space-y-1"><Label htmlFor="ec-type">Employment type</Label>
          <select id="ec-type" className={select} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value={UNCHANGED}>No change</option>{EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select></div>
        <div className="space-y-1"><Label htmlFor="ec-status">Status</Label>
          <select id="ec-status" className={select} value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value={UNCHANGED}>No change</option><option value="active">Active</option><option value="probation">Probation</option><option value="suspended">Suspended</option>
          </select></div>
        <div className="space-y-1"><Label htmlFor="ec-prob">Probation end</Label><Input id="ec-prob" type="date" value={form.probationEnd} onChange={(e) => setForm({ ...form, probationEnd: e.target.value })} /></div>
      </div>
      <div className="space-y-1"><Label htmlFor="ec-reason">Reason (required)</Label><Textarea id="ec-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Transfer to Operations approved by GM" /></div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => { setOpen(false); setForm(EMPTY_FORM); setReason('') }}>Back</Button>
        <Button size="sm" disabled={saving || nothingChanged || reason.trim().length < 5 || !effectiveDate || effectiveDate > todayIso()} onClick={save}>
          {saving ? 'Recording…' : 'Record change'}
        </Button>
      </div>
    </div>
  )
}

const fmt = (d: string | null) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

export default function EmploymentHistoryPanel({ userId, change, onChanged }: {
  userId: string
  /** When set (HR who may change this employee), an effective-dated change can be recorded here. */
  change?: EmploymentChangeOptions
  onChanged?: () => void
}) {
  const [rows, setRows] = useState<EmploymentVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    setRows(null)
    setError(null)
    fetch(`/api/hr/employees/${userId}/history`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok || !json.success) {
          setError(json.error || 'The employment history could not be loaded.')
          setRows([])
        } else {
          setRows(json.data as EmploymentVersion[])
        }
      })
      .catch(() => { if (!cancelled) { setError('The employment history could not be loaded.'); setRows([]) } })
    return () => { cancelled = true }
  }, [userId, reload])

  const changeForm = change ? <EmploymentChangeForm userId={userId} options={change} onSaved={() => { setReload((n) => n + 1); onChanged?.() }} /> : null

  if (rows === null) {
    return <div className="py-8 text-center text-sm text-muted-foreground"><Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />Loading history…</div>
  }
  if (error) return <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{error}</div>
  if (rows.length === 0) return <div className="space-y-3">{changeForm}<p className="py-6 text-center text-sm text-muted-foreground">No employment history recorded yet.</p></div>

  return (
    <div className="space-y-3">
    {changeForm}
    <ol className="space-y-3" aria-label="Employment history">
      {rows.map((v) => (
        <li key={`${v.version_no}-${v.effective_date}`} className="rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-medium">
              <History className="h-3.5 w-3.5 text-muted-foreground" />
              {CHANGE_KIND_LABELS[v.change_kind] ?? v.change_kind}
            </div>
            <Badge variant="outline" className="text-xs">Effective {fmt(v.effective_date)}</Badge>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <dt>Status</dt><dd className="text-foreground">{v.status ?? '—'}{v.end_date ? ` (ended ${fmt(v.end_date)})` : ''}</dd>
            <dt>Department</dt><dd className="text-foreground">{v.department_name ?? '—'}</dd>
            <dt>Position</dt><dd className="text-foreground">{v.position_name ?? '—'}</dd>
            <dt>Manager</dt><dd className="text-foreground">{v.manager_name ?? '—'}</dd>
            <dt>Type</dt><dd className="text-foreground">{v.employment_type ?? '—'}</dd>
          </dl>
          {v.changed_columns?.length > 0 && v.change_kind !== 'hire' && (
            <p className="mt-2 text-xs text-muted-foreground">Changed: {v.changed_columns.map((c) => FIELD_LABELS[c] ?? c).join(', ')}</p>
          )}
          {v.reason && <p className="mt-1 text-xs">Reason: {v.reason}</p>}
          <p className="mt-1 text-[11px] text-muted-foreground">Recorded {fmt(v.recorded_at)}{v.actor_name ? ` by ${v.actor_name}` : ''} · version {v.version_no}</p>
        </li>
      ))}
    </ol>
    </div>
  )
}
