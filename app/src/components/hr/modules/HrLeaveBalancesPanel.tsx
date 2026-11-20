'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { apiGet, apiPost } from '@/lib/hr/wave3/client'

/**
 * HR leave balances (Wave 3 leave ledger, 20261223100000). Balances are the database projection of an append-only
 * ledger; HR changes them only through ledger lines with a reason (entitlement, adjustment, entitlement run from the
 * leave type's own tiers/pro-rata, carry-forward capped by the leave type's own setting). Never on one's own record.
 * Explicit HR leave authority is decided by the database on every call.
 */

interface Balance { entitled: number; carried_forward: number; adjustment: number; taken: number; pending: number; available: number; has_entitlement: boolean }
interface Overview {
  year: number
  types: { id: string; code: string; name: string; is_paid: boolean; has_tiers: boolean; carry_forward: { enabled?: boolean; maxDays?: number } }[]
  employees: { employee_id: string; employee_no: number | null; name: string; hire_date: string | null; balances: Record<string, Balance> }[]
}
interface LedgerLine { id: string; leave_type: string; year: number; entry_type: string; days: number; reason: string | null; actor: string | null; created_at: string }
interface RunRow { employee_id: string; name: string; days: number; status: string; years_of_service?: number; available?: number }

const ENTRY_LABEL: Record<string, string> = {
  entitlement: 'Entitlement', carry_forward: 'Carried forward', adjustment: 'Adjustment', taken: 'Taken', taken_reversal: 'Reversal (cancelled)',
}

export default function HrLeaveBalancesPanel() {
  const { toast } = useToast()
  const [year, setYear] = useState(new Date().getFullYear())
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cell, setCell] = useState<{ employeeId: string; name: string; typeId: string; typeName: string } | null>(null)
  const [ledger, setLedger] = useState<LedgerLine[]>([])
  const [form, setForm] = useState({ mode: 'adjust' as 'adjust' | 'set', value: '', reason: '' })
  const [run, setRun] = useState<{ kind: 'entitlement_run' | 'carry_forward'; typeId: string; rows: RunRow[]; reason: string; authorized: boolean } | null>(null)

  const load = useCallback(async () => {
    const r = await apiGet<Overview>('/api/hr/leave/balances', { scope: 'organization', year })
    if (r.ok) { setData(r.data); setError(null) } else setError(r.error)
  }, [year])
  useEffect(() => { void load() }, [load])

  async function openCell(employeeId: string, name: string, typeId: string, typeName: string) {
    setCell({ employeeId, name, typeId, typeName }); setForm({ mode: 'adjust', value: '', reason: '' })
    const r = await apiGet<LedgerLine[]>('/api/hr/leave/ledger', { employee_user_id: employeeId, year })
    setLedger(r.ok ? r.data.filter((l) => l.leave_type === typeName) : [])
  }

  async function saveCell() {
    if (!cell) return
    const n = Number(form.value)
    const r = await apiPost('/api/hr/leave/admin', form.mode === 'set'
      ? { action: 'set_entitlement', employee_user_id: cell.employeeId, leave_type_id: cell.typeId, year, days: n, reason: form.reason }
      : { action: 'adjust', employee_user_id: cell.employeeId, leave_type_id: cell.typeId, year, delta: n, reason: form.reason })
    if (!r.ok) { toast({ title: 'Not saved', description: r.error, variant: 'destructive' }); return }
    toast({ title: 'Balance updated', description: 'Recorded as a ledger line with your reason.' })
    setCell(null); await load()
  }

  async function previewRun(kind: 'entitlement_run' | 'carry_forward', typeId: string) {
    const r = await apiPost<{ rows: RunRow[] }>('/api/hr/leave/admin', kind === 'entitlement_run'
      ? { action: kind, leave_type_id: typeId, year, dry_run: true }
      : { action: kind, leave_type_id: typeId, from_year: year, dry_run: true })
    if (!r.ok) { toast({ title: 'Preview not available', description: r.error, variant: 'destructive' }); return }
    setRun({ kind, typeId, rows: r.data.rows, reason: '', authorized: false })
  }
  async function applyRun() {
    if (!run || !run.authorized) return
    const r = await apiPost<{ applied: number }>('/api/hr/leave/admin', run.kind === 'entitlement_run'
      ? { action: run.kind, leave_type_id: run.typeId, year, dry_run: false, reason: run.reason }
      : { action: run.kind, leave_type_id: run.typeId, from_year: year, dry_run: false, reason: run.reason })
    if (!r.ok) { toast({ title: 'Not applied', description: r.error, variant: 'destructive' }); return }
    toast({ title: `${r.data.applied} balance(s) updated` }); setRun(null); await load()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Leave balances</CardTitle>
        <CardDescription>
          Available = entitled + carried forward + adjustments − taken − pending. Approved leave is posted automatically; cancelling approved leave reverses it. Changes need a reason and are kept in the ledger.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1"><Label>Year</Label><Input type="number" className="w-28" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} /></div>
          {data?.types.map((t) => (
            <span key={t.id} className="flex items-center gap-1 text-xs">
              <b>{t.code}</b>
              <Button size="sm" variant="outline" disabled={!t.has_tiers} title={t.has_tiers ? '' : 'Set entitlement tiers on the leave type first'}
                onClick={() => previewRun('entitlement_run', t.id)}>Preview entitlement run…</Button>
              {t.carry_forward?.enabled && <Button size="sm" variant="ghost" onClick={() => previewRun('carry_forward', t.id)}>Preview carry-forward {year} → {year + 1}…</Button>}
            </span>
          ))}
        </div>
        {error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <span className="min-w-0">{error}</span>
            <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="h-4 w-4 mr-1" />Try again</Button>
          </div>
        )}
        {data && data.types.length === 0 && (
          <p className="text-sm text-muted-foreground">No active leave types yet. Create Annual Leave (with entitlement tiers) and Unpaid Leave under Leave Management → Leave Types.</p>
        )}
        {data && data.types.length > 0 && data.employees.length === 0 && (
          <p className="text-sm text-muted-foreground">No onboarded employees in this company yet (HR → People → Employees → Add Employee).</p>
        )}
        {data && data.types.length > 0 && data.employees.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-gray-500"><th className="py-1">Employee</th>{data.types.map((t) => <th key={t.id}>{t.name}</th>)}</tr></thead>
              <tbody>{data.employees.map((e) => (
                <tr key={e.employee_id} className="border-t">
                  <td className="py-1">{e.name}<div className="text-gray-500">{e.employee_no ?? ''}</div></td>
                  {data.types.map((t) => {
                    const b = e.balances[t.id]
                    return (
                      <td key={t.id}>
                        <button className="text-left hover:underline" onClick={() => openCell(e.employee_id, e.name, t.id, t.name)}>
                          {b?.has_entitlement ? <b>{Number(b.available)}</b> : <span className="text-gray-400">not set</span>}
                          {b && (Number(b.taken) > 0 || Number(b.pending) > 0) && <span className="text-gray-500"> ({Number(b.taken)} taken, {Number(b.pending)} pending)</span>}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!cell} onOpenChange={(o) => { if (!o) setCell(null) }}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{cell?.name} — {cell?.typeName} {year}</DialogTitle><DialogDescription>Ledger lines are permanent; corrections are new lines.</DialogDescription></DialogHeader>
          <div className="max-h-56 overflow-auto text-xs">
            {ledger.length === 0 && <p className="text-gray-500">No ledger lines yet.</p>}
            {ledger.map((l) => (
              <div key={l.id} className="flex gap-2 border-t py-1">
                <span className="w-28">{ENTRY_LABEL[l.entry_type] ?? l.entry_type}</span><b className="w-12 text-right">{Number(l.days) > 0 ? '+' : ''}{Number(l.days)}</b>
                <span className="flex-1">{l.reason}</span><span className="text-gray-500">{l.actor ?? 'system'} · {new Date(l.created_at).toLocaleDateString('en-MY')}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant={form.mode === 'adjust' ? 'default' : 'outline'} onClick={() => setForm({ ...form, mode: 'adjust' })}>Adjust (±)</Button>
            <Button size="sm" variant={form.mode === 'set' ? 'default' : 'outline'} onClick={() => setForm({ ...form, mode: 'set' })}>Set entitlement</Button>
          </div>
          <div className="space-y-1"><Label>{form.mode === 'set' ? 'Entitled days for the year' : 'Days to add (negative to deduct; whole or half days)'}</Label>
            <Input type="number" step={0.5} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></div>
          <div className="space-y-1"><Label>Reason (required)</Label><Textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCell(null)}>Close</Button>
            <Button disabled={form.value === '' || form.reason.trim().length < 5} onClick={saveCell}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!run} onOpenChange={(o) => { if (!o) setRun(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{run?.kind === 'entitlement_run' ? `Entitlement run ${year}` : `Carry forward ${year} → ${year + 1}`} — preview</DialogTitle>
            <DialogDescription>{run?.kind === 'entitlement_run'
              ? 'Uses the leave type\'s own tiers (years of service at 1 January) and pro-rata setting. Employees who already have an entitlement are skipped.'
              : 'Carries unused days up to the leave type\'s cap. Expiry of carried days is not automated (owner decision pending).'}</DialogDescription>
          </DialogHeader>
          <div className="max-h-72 overflow-auto text-xs">
            {run?.rows.map((r) => (
              <div key={r.employee_id} className="flex gap-2 border-t py-1">
                <span className="flex-1">{r.name}</span>
                {r.years_of_service !== undefined && <span>{r.years_of_service} yr</span>}
                <b className="w-12 text-right">{Number(r.days)}</b>
                <Badge variant={r.status.startsWith('would') ? 'default' : 'secondary'}>{r.status.replace(/_/g, ' ')}</Badge>
              </div>
            ))}
          </div>
          <div role="note" className="flex gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <span><b>Company-wide change.</b> Nothing has been written yet — this is a preview. Applying posts ledger lines for <b>every employee listed as “would …”</b> in this company (on shared staging that includes real staff). Apply only with explicit owner authorization for this run; otherwise press Close.</span>
          </div>
          <div className="space-y-1"><Label>Reason (required to apply)</Label><Textarea value={run?.reason ?? ''} onChange={(e) => run && setRun({ ...run, reason: e.target.value })} /></div>
          <label className="flex items-start gap-2 text-xs">
            <Checkbox checked={!!run?.authorized} onCheckedChange={(c) => run && setRun({ ...run, authorized: c === true })} aria-label="I have explicit owner authorization to apply this company-wide run" />
            <span>I have explicit owner authorization to apply this company-wide run.</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRun(null)}>Close (nothing written)</Button>
            <Button variant="destructive" disabled={!run || !run.authorized || run.reason.trim().length < 5 || !run.rows.some((r) => r.status.startsWith('would'))} onClick={applyRun}>
              Apply to {run?.rows.filter((r) => r.status.startsWith('would')).length ?? 0} employee(s)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
