'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, CalendarRange, Check, Loader2, Lock, Plus, RefreshCw, Send, ShieldCheck, Undo2, Wallet } from 'lucide-react'
import { commissionApi, useCommissionAccess } from '@/lib/hr/commission/use-commission-access'
import { cycleBounds, cycleLabel, cycleRangeLabel, periodFor, DEFAULT_START_DAY } from '@/lib/hr/commission/cycle'
import { formatRate, formatRM } from '@/lib/hr/commission/report'
import { APPROVED_SALES_STATUSES } from '@/lib/reporting/sales-kpi'
import { statusBadge } from '@/components/reporting/commission/CommissionReportingTab'

const FLAG_LABEL: Record<string, string> = {
  approval_timestamp_missing: 'Approved order without any approval timestamp (excluded)',
  unattributed_brand: 'Brand not mapped to a Business Unit on the approval date (excluded)',
  status_reverted: 'Approved in this cycle but now back before approval (excluded)',
  claimed_by_other_cycle: 'Order line already paid by another cycle (excluded)',
  source_value_changed: 'Order line changed after it was paid in an approved cycle',
  source_line_removed: 'Order line removed after it was paid in an approved cycle',
  late_approval_in_final_cycle: 'Approval falls in an already approved cycle (not moved)',
  no_eligible_employee: 'Business Unit sales with no eligible employee (information)',
}
const STATUS_LABEL: Record<string, string> = { approved: 'Approved', warehouse_packed: 'Warehouse Packed', shipped_distributor: 'Shipped Distributor', closed: 'Closed' }

export default function CommissionSettingsView() {
  const { toast } = useToast()
  const { can, loaded } = useCommissionAccess()
  const canView = can('hr.commission.view')
  const canManage = can('hr.commission.manage')
  const canApprove = can('hr.commission.approve')
  const [tab, setTab] = useState('cycles')

  if (!loaded) return <div className="py-16 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
  if (!canView) {
    return (
      <Card className="border-dashed shadow-none">
        <CardContent className="py-12 text-center text-sm text-gray-500"><ShieldCheck className="mx-auto mb-2 h-6 w-6" />Commission Settings is available to people granted commission access in Security &amp; Access.</CardContent>
      </Card>
    )
  }
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Commission Settings</h2>
        <p className="text-sm text-gray-500">Staff sales commission: cycles (28th–27th by first approval date, Malaysia time), approvals, Business Units and cycle settings. Commission is separate from salary payment and payroll posting dates.</p>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="cycles">Cycles</TabsTrigger>
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          <TabsTrigger value="units">Business Units</TabsTrigger>
          <TabsTrigger value="settings">Cycle Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="cycles" className="mt-4">{tab === 'cycles' && <CyclesPanel canManage={canManage} canApprove={canApprove} toast={toast} />}</TabsContent>
        <TabsContent value="approvals" className="mt-4">{tab === 'approvals' && <ApprovalsPanel canApprove={canApprove} toast={toast} />}</TabsContent>
        <TabsContent value="units" className="mt-4">{tab === 'units' && <UnitsPanel canManage={canManage} toast={toast} />}</TabsContent>
        <TabsContent value="settings" className="mt-4">{tab === 'settings' && <SettingsPanel canManage={canManage} toast={toast} />}</TabsContent>
      </Tabs>
    </div>
  )
}

type Toast = ReturnType<typeof useToast>['toast']

function useRunner(toast: Toast, after: () => Promise<void> | void) {
  const [busy, setBusy] = useState(false)
  const run = useCallback(async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try { await fn(); toast({ title: success }); await after(); return true }
    catch (e: any) { toast({ title: 'Not completed', description: e.message, variant: 'destructive' }); return false }
    finally { setBusy(false) }
  }, [toast, after])
  return { busy, run }
}

// ── Cycles ────────────────────────────────────────────────────────────────────
function CyclesPanel({ canManage, canApprove, toast }: { canManage: boolean; canApprove: boolean; toast: Toast }) {
  const [cycles, setCycles] = useState<any[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const currentMonth = periodFor(new Date())
  const [month, setMonth] = useState(currentMonth.slice(0, 7))
  const load = useCallback(async () => {
    const json = await commissionApi('/api/hr/commission/cycles')
    setCycles(json.cycles ?? []); setNames(json.names ?? {})
    setLoading(false)
  }, [])
  useEffect(() => { load().catch((e) => { toast({ title: 'Cycles unavailable', description: e.message, variant: 'destructive' }); setLoading(false) }) }, [load, toast])
  const { busy, run } = useRunner(toast, load)
  const preview = useMemo(() => { try { const b = cycleBounds(`${month}-01`, DEFAULT_START_DAY); return cycleRangeLabel(b.startAt, b.endAt) } catch { return '' } }, [month])

  if (loading) return <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <div className="space-y-3">
        {canManage && (
          <Card className="shadow-none">
            <CardContent className="space-y-2 p-3">
              <Label className="text-xs">Open a cycle</Label>
              <div className="flex gap-2">
                <Input type="month" className="h-9" value={month} onChange={(e) => setMonth(e.target.value)} />
                <Button size="sm" className="h-9" disabled={busy || !month}
                  onClick={() => run(() => commissionApi('/api/hr/commission/cycles', { method: 'POST', json: { periodMonth: `${month}-01` } }), 'Cycle ready')}>
                  <Plus className="mr-1 h-4 w-4" />Open
                </Button>
              </div>
              <p className="text-[11px] text-gray-500">{cycleLabel(`${month}-01`)}: {preview} (default settings; saved settings decide the persisted boundaries).</p>
            </CardContent>
          </Card>
        )}
        <div className="space-y-2">
          {cycles.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-gray-500">No cycles yet.</p>}
          {cycles.map((c) => (
            <button key={c.id} type="button" onClick={() => setSelected(c.id)}
              className={`w-full rounded-lg border p-3 text-left transition-colors ${selected === c.id ? 'border-orange-400 bg-orange-50/50' : 'bg-white hover:border-orange-200'}`}>
              <div className="flex items-center justify-between gap-2"><span className="text-sm font-semibold">{c.label}</span>{statusBadge(c.status)}</div>
              <p className="text-[11px] text-gray-500">{cycleRangeLabel(c.start_at, c.end_at)}</p>
              <p className="mt-1 text-xs">Net {formatRM(Number(c.net_commission))} · sales {formatRM(Number(c.eligible_sales))}</p>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0">
        {selected ? <CycleDetail key={selected} cycleId={selected} canManage={canManage} canApprove={canApprove} toast={toast} onChange={load} names={names} />
          : <p className="rounded-lg border border-dashed p-10 text-center text-sm text-gray-500"><CalendarRange className="mx-auto mb-2 h-6 w-6" />Select a cycle.</p>}
      </div>
    </div>
  )
}

function CycleDetail({ cycleId, canManage, canApprove, toast, onChange }: { cycleId: string; canManage: boolean; canApprove: boolean; toast: Toast; onChange: () => Promise<void>; names: Record<string, string> }) {
  const [d, setD] = useState<any>(null)
  const [items, setItems] = useState<any[]>([])
  const [ack, setAck] = useState(false)
  const [note, setNote] = useState('')
  const [period, setPeriod] = useState({ start: '', end: '' })
  const [adj, setAdj] = useState({ employeeId: '', businessUnitId: '', amount: '', reason: '', sourceOrderNo: '' })
  const load = useCallback(async () => {
    const [json, rep] = await Promise.all([
      commissionApi(`/api/hr/commission/cycles/${cycleId}`),
      commissionApi(`/api/hr/commission/report?cycleId=${cycleId}`).catch(() => null),
    ])
    setD(json)
    setItems(rep?.report?.sections?.flatMap((s: any) => s.employees) ?? [])
  }, [cycleId])
  useEffect(() => { load().catch((e) => toast({ title: 'Cycle unavailable', description: e.message, variant: 'destructive' })) }, [load, toast])
  const after = useCallback(async () => { await load(); await onChange() }, [load, onChange])
  const { busy, run } = useRunner(toast, after)
  const post = (json: Record<string, unknown>) => commissionApi(`/api/hr/commission/cycles/${cycleId}`, { method: 'POST', json })

  if (!d) return <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
  const c = d.cycle
  const n = (id: string | null) => (id ? d.names?.[id] ?? 'Unknown user' : '—')
  const open = ['open', 'calculated', 'under_review'].includes(c.status)
  const ended = Date.now() >= new Date(c.end_at).getTime()
  const reviewFlags = d.flags.filter((f: any) => f.severity === 'review')
  const pendingAdj = d.adjustments.filter((a: any) => a.status === 'pending')
  const units = [...new Map(items.flatMap((e: any) => e.rows).filter((r: any) => r.businessUnitId).map((r: any) => [r.businessUnitId, r.businessUnit])).entries()]

  return (
    <div className="space-y-4">
      <Card className="shadow-none">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">{c.label}</CardTitle>{statusBadge(c.status)}</div>
          <CardDescription>{cycleRangeLabel(c.start_at, c.end_at)} · [{new Date(c.start_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })} – {new Date(c.end_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })}) MYT · settings: {c.settings_snapshot?.source === 'default' ? 'default 28th–27th' : `version from ${c.settings_snapshot?.effective_from}`}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div><p className="text-xs text-gray-500">Eligible sales</p><p className="font-semibold">{formatRM(Number(c.eligible_sales))}</p></div>
            <div><p className="text-xs text-gray-500">Commission</p><p className="font-semibold">{formatRM(Number(c.total_commission))}</p></div>
            <div><p className="text-xs text-gray-500">Adjustments</p><p className="font-semibold">{formatRM(Number(c.total_adjustments))}</p></div>
            <div><p className="text-xs text-gray-500">Net</p><p className="font-semibold">{formatRM(Number(c.net_commission))}</p></div>
          </div>
          <p className="text-xs text-gray-500">
            {c.calculated_at ? `Calculated v${c.calc_version} by ${n(c.calculated_by)}` : 'Not calculated'}{c.submitted_at ? ` · submitted by ${n(c.submitted_by)}` : ''}{c.approved_at ? ` · approved by ${n(c.approved_by)}` : ''}{c.locked_at ? ` · locked by ${n(c.locked_by)}` : ''}{c.payroll_ready_at ? ` · payroll ready (${c.payroll_period_start} – ${c.payroll_period_end})` : ''}
          </p>

          {/* Workflow actions */}
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {canManage && open && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => post({ action: 'calculate' }), 'Cycle calculated')}>
                <RefreshCw className="mr-1 h-4 w-4" />{c.calc_version ? 'Recalculate' : 'Calculate'}
              </Button>
            )}
            {canManage && c.status === 'calculated' && (
              <Button size="sm" disabled={busy} onClick={() => run(() => post({ action: 'submit', note }), 'Submitted for review')}><Send className="mr-1 h-4 w-4" />Submit for review</Button>
            )}
            {canApprove && (c.status === 'under_review' || c.status === 'approved') && (
              <Button size="sm" variant="outline" disabled={busy || note.trim().length < 5} onClick={() => run(() => post({ action: 'return', reason: note }), 'Cycle returned')}><Undo2 className="mr-1 h-4 w-4" />Return</Button>
            )}
            {canApprove && c.status === 'under_review' && (
              <Button size="sm" disabled={busy || !ended || (reviewFlags.length > 0 && !ack) || pendingAdj.length > 0}
                onClick={() => run(() => post({ action: 'approve', acknowledgeFlags: ack, note }), 'Cycle approved')}><Check className="mr-1 h-4 w-4" />Approve</Button>
            )}
            {canApprove && c.status === 'approved' && (
              <Button size="sm" disabled={busy} onClick={() => run(() => post({ action: 'lock', note }), 'Cycle locked')}><Lock className="mr-1 h-4 w-4" />Lock</Button>
            )}
          </div>
          {(canManage || canApprove) && !['locked', 'payroll_ready'].includes(c.status) && (
            <Input className="h-9" placeholder="Note (required to return a cycle)" value={note} onChange={(e) => setNote(e.target.value)} />
          )}
          {canApprove && c.status === 'under_review' && (
            <div className="space-y-1 text-xs text-gray-600">
              {!ended && <p className="text-amber-700">Approval opens after the cycle ends ({cycleRangeLabel(c.start_at, c.end_at).split('– ')[1]}).</p>}
              {pendingAdj.length > 0 && <p className="text-amber-700">Decide {pendingAdj.length} pending adjustment(s) first (Approvals tab).</p>}
              {reviewFlags.length > 0 && (
                <label className="flex items-center gap-2"><Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} />I reviewed the {reviewFlags.length} flagged item(s) below.</label>
              )}
              <p>The person who calculated or submitted this cycle cannot approve it.</p>
            </div>
          )}
          {canApprove && c.status === 'locked' && (
            <div className="grid gap-2 rounded-lg bg-violet-50/50 p-3 sm:grid-cols-[1fr_1fr_auto]">
              <div><Label className="text-xs">Payroll period start</Label><Input type="date" className="h-9" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} /></div>
              <div><Label className="text-xs">Payroll period end</Label><Input type="date" className="h-9" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} /></div>
              <Button size="sm" className="self-end" disabled={busy || !period.start || !period.end}
                onClick={() => run(() => post({ action: 'payroll_ready', payrollPeriodStart: period.start, payrollPeriodEnd: period.end, note }), 'Marked Payroll Ready')}><Wallet className="mr-1 h-4 w-4" />Mark Payroll Ready</Button>
              <p className="text-[11px] text-gray-500 sm:col-span-3">Prepares one COMMISSION hand-off record per employee for a future payroll run. No payroll run, payroll item, payslip or journal is created.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {d.flags.length > 0 && (
        <Card className="shadow-none">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-1.5 text-sm"><AlertTriangle className="h-4 w-4 text-amber-600" />Review flags ({d.flags.length})</CardTitle></CardHeader>
          <CardContent className="max-h-72 space-y-1 overflow-y-auto text-xs">
            {d.flags.map((f: any) => (
              <div key={f.id} className="rounded border p-2">
                <p className="font-medium">{FLAG_LABEL[f.flag_type] ?? f.flag_type}{f.order_no ? ` — ${f.order_no}` : ''}</p>
                <p className="break-all text-gray-500">{Object.entries(f.detail ?? {}).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="shadow-none">
        <CardHeader className="pb-2"><CardTitle className="text-sm">Adjustments</CardTitle><CardDescription>Approved adjustments count in this cycle. Cancellations after approval appear here automatically as pending reversals (once per order line and employee).</CardDescription></CardHeader>
        <CardContent className="space-y-2 text-xs">
          {d.adjustments.length === 0 && <p className="text-gray-500">None.</p>}
          {d.adjustments.map((a: any) => (
            <div key={a.id} className="flex flex-wrap justify-between gap-2 rounded border p-2">
              <span>{a.employee_name} · {a.kind === 'cancellation_reversal' ? 'Reversal' : 'Manual'} · {a.reason}{a.source_order_no ? ` (${a.source_order_no})` : ''}</span>
              <span><b>{formatRM(Number(a.amount))}</b> · <i>{a.status}</i></span>
            </div>
          ))}
          {canManage && open && items.length > 0 && (
            <div className="grid gap-2 rounded-lg bg-gray-50 p-3 sm:grid-cols-2">
              <Select value={adj.employeeId} onValueChange={(v) => setAdj({ ...adj, employeeId: v })}>
                <SelectTrigger className="h-9 bg-white"><SelectValue placeholder="Employee" /></SelectTrigger>
                <SelectContent>{items.map((e: any) => <SelectItem key={e.employeeId} value={e.employeeId}>{e.employeeName}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={adj.businessUnitId || 'none'} onValueChange={(v) => setAdj({ ...adj, businessUnitId: v === 'none' ? '' : v })}>
                <SelectTrigger className="h-9 bg-white"><SelectValue placeholder="Business Unit" /></SelectTrigger>
                <SelectContent><SelectItem value="none">All Business Units</SelectItem>{units.map(([id, name]) => <SelectItem key={id as string} value={id as string}>{name as string}</SelectItem>)}</SelectContent>
              </Select>
              <Input className="h-9 bg-white" inputMode="decimal" placeholder="Amount (negative to deduct)" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value.replace(/[^0-9.-]/g, '') })} />
              <Input className="h-9 bg-white" placeholder="Source order no. (optional)" value={adj.sourceOrderNo} onChange={(e) => setAdj({ ...adj, sourceOrderNo: e.target.value })} />
              <Textarea className="bg-white sm:col-span-2" rows={2} placeholder="Reason (required)" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />
              <div className="flex justify-end sm:col-span-2">
                <Button size="sm" disabled={busy || !adj.employeeId || !/^-?\d+(\.\d{1,2})?$/.test(adj.amount) || Number(adj.amount) === 0 || adj.reason.trim().length < 5}
                  onClick={async () => { if (await run(() => post({ action: 'request_adjustment', ...adj }), 'Adjustment submitted for approval')) setAdj({ employeeId: '', businessUnitId: '', amount: '', reason: '', sourceOrderNo: '' }) }}>
                  Request adjustment
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {d.history.length > 0 && (
        <Card className="shadow-none">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Audit trail</CardTitle></CardHeader>
          <CardContent className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {d.history.map((h: any) => (
              <p key={h.id}>{new Date(h.occurred_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })} · {h.action.replace('cycle.', '')} by {n(h.actor_id)}{h.reason ? ` — ${h.reason}` : ''}</p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

// ── Approvals ─────────────────────────────────────────────────────────────────
function ApprovalsPanel({ canApprove, toast }: { canApprove: boolean; toast: Toast }) {
  const [d, setD] = useState<any>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const load = useCallback(async () => setD(await commissionApi('/api/hr/commission/requests')), [])
  useEffect(() => { load().catch((e) => toast({ title: 'Approvals unavailable', description: e.message, variant: 'destructive' })) }, [load, toast])
  const { busy, run } = useRunner(toast, load)
  if (!d) return <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
  const decide = (kind: 'rate' | 'adjustment', id: string, approve: boolean) =>
    run(() => commissionApi('/api/hr/commission/requests', { method: 'POST', json: { kind, id, approve, note: notes[id] ?? '' } }), approve ? 'Approved' : 'Rejected')
  const Row = ({ r, kind, title }: { r: any; kind: 'rate' | 'adjustment'; title: string }) => {
    const blocked = r.is_mine || r.is_about_me
    return (
      <div className="space-y-2 rounded-lg border p-3 text-sm">
        <p className="font-medium">{title}</p>
        <p className="text-xs text-gray-500">{r.reason} · requested by {r.requested_by_name ?? '—'} on {new Date(r.requested_at).toLocaleDateString('en-MY')}</p>
        {canApprove && (blocked ? (
          <p className="text-xs text-amber-700">{r.is_mine ? 'You requested this — another approver must decide.' : 'This concerns your own commission — another approver must decide.'}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Input className="h-8 flex-1" placeholder="Note (required to reject)" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
            <Button size="sm" className="h-8" disabled={busy} onClick={() => decide(kind, r.id, true)}>Approve</Button>
            <Button size="sm" variant="outline" className="h-8" disabled={busy || (notes[r.id] ?? '').trim().length < 5} onClick={() => decide(kind, r.id, false)}>Reject</Button>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Rate changes ({d.rateRequests.length})</h3>
        {d.rateRequests.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-xs text-gray-500">Nothing pending.</p>}
        {d.rateRequests.map((r: any) => (
          <Row key={r.id} r={r} kind="rate" title={r.kind === 'set_rate'
            ? `${r.employee_name}: ${r.business_unit_name ?? 'Business Unit'} ${formatRate(Number(r.rate_percent))} from ${r.effective_from}${r.effective_to ? ` to ${r.effective_to}` : ''}`
            : `${r.employee_name}: end rate on ${r.effective_to}`} />
        ))}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Adjustments ({d.adjustments.length})</h3>
        {d.adjustments.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-xs text-gray-500">Nothing pending.</p>}
        {d.adjustments.map((a: any) => (
          <Row key={a.id} r={a} kind="adjustment" title={`${a.employee_name}: ${formatRM(Number(a.amount))} in ${a.target_cycle_label ?? 'cycle'}${a.kind === 'cancellation_reversal' ? ' (cancellation reversal)' : ''}`} />
        ))}
      </div>
    </div>
  )
}

// ── Business Units & brands ──────────────────────────────────────────────────
function UnitsPanel({ canManage, toast }: { canManage: boolean; toast: Toast }) {
  const [d, setD] = useState<any>(null)
  const [form, setForm] = useState({ code: '', name: '', description: '' })
  const [map, setMap] = useState<Record<string, { brandId: string; effectiveFrom: string }>>({})
  const [endMap, setEndMap] = useState<Record<string, string>>({})
  const load = useCallback(async () => setD(await commissionApi('/api/hr/commission/reference')), [])
  useEffect(() => { load().catch((e) => toast({ title: 'Business Units unavailable', description: e.message, variant: 'destructive' })) }, [load, toast])
  const { busy, run } = useRunner(toast, load)
  if (!d) return <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
  const post = (json: Record<string, unknown>) => commissionApi('/api/hr/commission/business-units', { method: 'POST', json })
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">A sale is attributed to a Business Unit through its product&apos;s brand on the approval date. One brand belongs to one Business Unit at a time; unmapped brands are flagged and earn no commission.</p>
      {canManage && (
        <Card className="shadow-none">
          <CardContent className="grid gap-2 p-3 sm:grid-cols-[140px_1fr_1fr_auto]">
            <Input className="h-9" placeholder="Code (e.g. CELLERA)" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
            <Input className="h-9" placeholder="Name (e.g. Cellera)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input className="h-9" placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <Button size="sm" className="h-9" disabled={busy || form.code.length < 2 || form.name.trim().length < 2}
              onClick={async () => { if (await run(() => post({ action: 'save', ...form, reason: 'Business Unit created' }), 'Business Unit created')) setForm({ code: '', name: '', description: '' }) }}>
              <Plus className="mr-1 h-4 w-4" />Add
            </Button>
          </CardContent>
        </Card>
      )}
      {d.businessUnits.length === 0 && <p className="rounded-lg border border-dashed p-8 text-center text-sm text-gray-500">No Business Units yet.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {d.businessUnits.map((u: any) => (
          <Card key={u.id} className="shadow-none">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">{u.name} <span className="font-mono text-xs text-gray-500">{u.code}</span></CardTitle>
                <div className="flex items-center gap-2">
                  {!u.is_active && <Badge variant="secondary">Inactive</Badge>}
                  {canManage && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy}
                      onClick={() => run(() => post({ action: 'save', id: u.id, name: u.name, description: u.description, isActive: !u.is_active, reason: u.is_active ? 'Deactivated' : 'Reactivated' }), u.is_active ? 'Deactivated' : 'Reactivated')}>
                      {u.is_active ? 'Deactivate' : 'Activate'}
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {u.brands.length === 0 && <p className="text-gray-500">No brands mapped.</p>}
              {u.brands.map((m: any) => (
                <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2">
                  <span>{m.brand_name} · {m.effective_from} → {m.effective_to ?? 'open'}</span>
                  {canManage && !m.effective_to && (
                    <span className="flex gap-1">
                      <Input type="date" className="h-7 w-36" value={endMap[m.id] ?? today} onChange={(e) => setEndMap({ ...endMap, [m.id]: e.target.value })} />
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy}
                        onClick={() => run(() => post({ action: 'end_mapping', mappingId: m.id, effectiveTo: endMap[m.id] ?? today, reason: 'Brand mapping ended' }), 'Mapping ended')}>End</Button>
                    </span>
                  )}
                </div>
              ))}
              {canManage && u.is_active && (
                <div className="flex flex-wrap gap-1 pt-1">
                  <Select value={map[u.id]?.brandId ?? ''} onValueChange={(v) => setMap({ ...map, [u.id]: { brandId: v, effectiveFrom: map[u.id]?.effectiveFrom ?? today } })}>
                    <SelectTrigger className="h-8 min-w-[140px] flex-1"><SelectValue placeholder="Brand" /></SelectTrigger>
                    <SelectContent>{d.brands.map((b: any) => <SelectItem key={b.id} value={b.id}>{b.brand_name}</SelectItem>)}</SelectContent>
                  </Select>
                  <Input type="date" className="h-8 w-36" value={map[u.id]?.effectiveFrom ?? today} onChange={(e) => setMap({ ...map, [u.id]: { brandId: map[u.id]?.brandId ?? '', effectiveFrom: e.target.value } })} />
                  <Button size="sm" className="h-8" disabled={busy || !map[u.id]?.brandId}
                    onClick={() => run(() => post({ action: 'map_brand', businessUnitId: u.id, brandId: map[u.id].brandId, effectiveFrom: map[u.id].effectiveFrom ?? today, reason: 'Brand mapped' }), 'Brand mapped')}>Map</Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ── Cycle settings ────────────────────────────────────────────────────────────
function SettingsPanel({ canManage, toast }: { canManage: boolean; toast: Toast }) {
  const [versions, setVersions] = useState<any[] | null>(null)
  const [units, setUnits] = useState<any[]>([])
  const nextMonth = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7) })()
  const [form, setForm] = useState({ effectiveMonth: nextMonth, cycleType: 'custom', startDay: '28', cycleLabelFormat: '{month} {year} Commission Cycle', statuses: [...APPROVED_SALES_STATUSES] as string[], businessUnitIds: [] as string[], notes: '' })
  const load = useCallback(async () => {
    const [s, r] = await Promise.all([commissionApi('/api/hr/commission/settings'), commissionApi('/api/hr/commission/reference')])
    setVersions(s.settings ?? []); setUnits(r.businessUnits ?? [])
  }, [])
  useEffect(() => { load().catch((e) => toast({ title: 'Settings unavailable', description: e.message, variant: 'destructive' })) }, [load, toast])
  const { busy, run } = useRunner(toast, load)
  if (!versions) return <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
  const startDay = form.cycleType === 'calendar_month' ? 1 : Number(form.startDay)
  const preview = (() => { try { const b = cycleBounds(`${form.effectiveMonth}-01`, startDay); return cycleRangeLabel(b.startAt, b.endAt) } catch { return '—' } })()
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="shadow-none">
        <CardHeader className="pb-2"><CardTitle className="text-sm">Settings versions</CardTitle><CardDescription>Without a saved version the default applies: 28th of the previous month to the 27th, D2H sales, approved-stage statuses, maker-checker approval. A version never changes existing cycles.</CardDescription></CardHeader>
        <CardContent className="space-y-2 text-xs">
          {versions.length === 0 && <p className="text-gray-500">Using the default settings.</p>}
          {versions.map((v) => (
            <div key={v.id} className="rounded border p-2">
              <p className="font-medium">From {v.effective_from}: {v.cycle_type === 'calendar_month' ? 'calendar month' : `day ${v.start_day} → day ${v.end_day}`}</p>
              <p className="text-gray-500">Statuses: {v.eligible_statuses.map((s: string) => STATUS_LABEL[s] ?? s).join(', ')} · Order types: {v.order_types.join(', ')} · Business Units: {v.business_unit_ids?.length ? `${v.business_unit_ids.length} selected` : 'all'} · by {v.created_by_name ?? '—'}</p>
              {v.notes && <p className="text-gray-500">{v.notes}</p>}
            </div>
          ))}
        </CardContent>
      </Card>
      {canManage && (
        <Card className="shadow-none">
          <CardHeader className="pb-2"><CardTitle className="text-sm">New settings version</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label className="text-xs">Effective from (month)</Label><Input type="month" className="h-9" value={form.effectiveMonth} onChange={(e) => setForm({ ...form, effectiveMonth: e.target.value })} /></div>
              <div><Label className="text-xs">Cycle type</Label>
                <Select value={form.cycleType} onValueChange={(v) => setForm({ ...form, cycleType: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="custom">Custom (start day → day before)</SelectItem><SelectItem value="calendar_month">Calendar month</SelectItem></SelectContent>
                </Select>
              </div>
              {form.cycleType === 'custom' && (
                <div><Label className="text-xs">Start day (2–28)</Label><Input className="h-9" inputMode="numeric" value={form.startDay} onChange={(e) => setForm({ ...form, startDay: e.target.value.replace(/\D/g, '') })} /><p className="text-[10px] text-gray-500">End day: {Number(form.startDay) > 1 ? Number(form.startDay) - 1 : '—'}</p></div>
              )}
              <div><Label className="text-xs">Cycle label</Label><Input className="h-9" value={form.cycleLabelFormat} onChange={(e) => setForm({ ...form, cycleLabelFormat: e.target.value })} /></div>
            </div>
            <p className="text-xs text-gray-500">Preview: {cycleLabel(`${form.effectiveMonth}-01`, form.cycleLabelFormat)} = {preview} (Asia/Kuala_Lumpur, inclusive start, exclusive end).</p>
            <div>
              <Label className="text-xs">Eligible order statuses (approved stage only)</Label>
              <div className="mt-1 flex flex-wrap gap-3">{APPROVED_SALES_STATUSES.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-xs"><Checkbox checked={form.statuses.includes(s)} onCheckedChange={() => setForm({ ...form, statuses: toggle(form.statuses, s) })} />{STATUS_LABEL[s]}</label>
              ))}</div>
              <p className="mt-1 text-[10px] text-gray-500">Draft, Submitted and Cancelled are never eligible. Order type: D2H only.</p>
            </div>
            {units.length > 0 && (
              <div>
                <Label className="text-xs">Business Unit scope (none selected = all)</Label>
                <div className="mt-1 flex flex-wrap gap-3">{units.map((u) => (
                  <label key={u.id} className="flex items-center gap-1.5 text-xs"><Checkbox checked={form.businessUnitIds.includes(u.id)} onCheckedChange={() => setForm({ ...form, businessUnitIds: toggle(form.businessUnitIds, u.id) })} />{u.name}</label>
                ))}</div>
              </div>
            )}
            <div><Label className="text-xs">Approval workflow</Label><p className="text-xs text-gray-600">Maker-checker: HR calculates and submits; a different approver approves and locks.</p></div>
            <div><Label className="text-xs">Payroll mapping</Label><p className="text-xs text-gray-600">Earning component COMMISSION (future use — no payroll is created).</p></div>
            <Textarea rows={2} placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <div className="flex justify-end">
              <Button size="sm" disabled={busy || form.statuses.length === 0 || (form.cycleType === 'custom' && (startDay < 2 || startDay > 28))}
                onClick={() => run(() => commissionApi('/api/hr/commission/settings', { method: 'POST', json: {
                  effectiveFrom: `${form.effectiveMonth}-01`, cycleType: form.cycleType, startDay, cycleLabelFormat: form.cycleLabelFormat,
                  eligibleStatuses: form.statuses, businessUnitIds: form.businessUnitIds, notes: form.notes } }), 'Settings saved')}>
                Save version
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
