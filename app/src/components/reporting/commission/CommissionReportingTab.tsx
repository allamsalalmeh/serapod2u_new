'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, Building2, Download, FileSpreadsheet, FileText, Loader2, Lock, Users, Wallet } from 'lucide-react'
import { commissionApi } from '@/lib/hr/commission/use-commission-access'
import { CYCLE_STATUS_LABEL, cycleRangeLabel, type CycleStatus } from '@/lib/hr/commission/cycle'
import { formatRate, formatRM, type CommissionReport, type EmployeeBlock } from '@/lib/hr/commission/report'

const ALL = 'all'
const STATUS_TONE: Record<string, string> = {
  open: 'bg-gray-100 text-gray-700', calculated: 'bg-sky-50 text-sky-700', under_review: 'bg-amber-50 text-amber-700',
  approved: 'bg-emerald-50 text-emerald-700', locked: 'bg-indigo-50 text-indigo-700', payroll_ready: 'bg-violet-50 text-violet-700',
}
export const statusBadge = (s: string) => (
  <Badge variant="secondary" className={`border-0 ${STATUS_TONE[s] ?? ''}`}>{CYCLE_STATUS_LABEL[s as CycleStatus] ?? s}</Badge>
)

function Kpi({ label, value, note, icon: Icon }: { label: string; value: React.ReactNode; note?: string; icon: any }) {
  return (
    <div className="rounded-xl border border-[var(--sera-line,#e8eaed)] bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--sera-muted,#6b7280)]">{label}</p>
          <p className="mt-1 truncate text-xl font-bold text-[var(--sera-ink,#111827)]">{value}</p>
          {note && <p className="mt-0.5 text-[11px] text-[var(--sera-muted,#6b7280)]">{note}</p>}
        </div>
        <Icon className="h-5 w-5 shrink-0 text-[var(--sera-orange,#f97316)]" strokeWidth={1.75} />
      </div>
    </div>
  )
}

/**
 * Reporting → Commission. Reads the stored commission ledger (never recalculates): eligible sales by Business Unit,
 * commission grouped by HR department with employee/section subtotals, drill-down to source orders, and server-built
 * PDF/Excel exports of the same model. Approval timestamps and the 28th–27th cycle decide the period, not order dates.
 */
export default function CommissionReportingTab({ canExport }: { canExport: boolean }) {
  const { toast } = useToast()
  const [cycles, setCycles] = useState<any[]>([])
  const [statusFilter, setStatusFilter] = useState(ALL)
  const [cycleId, setCycleId] = useState<string>('')
  const [bu, setBu] = useState(ALL)
  const [employee, setEmployee] = useState(ALL)
  const [department, setDepartment] = useState(ALL)
  const [report, setReport] = useState<CommissionReport | null>(null)
  const [fullReport, setFullReport] = useState<CommissionReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState<string | null>(null)
  const [drill, setDrill] = useState<{ employee: EmployeeBlock; data: any | null } | null>(null)

  useEffect(() => {
    commissionApi('/api/hr/commission/cycles')
      .then((json) => {
        setCycles(json.cycles ?? [])
        const first = (json.cycles ?? []).find((c: any) => c.status !== 'open') ?? json.cycles?.[0]
        if (first) setCycleId(first.id)
        else setLoading(false)
      })
      .catch((e) => { toast({ title: 'Commission cycles unavailable', description: e.message, variant: 'destructive' }); setLoading(false) })
  }, [toast])

  const query = useCallback((extra: Record<string, string> = {}) => {
    const p = new URLSearchParams({ cycleId })
    if (bu !== ALL) p.set('businessUnitId', bu)
    if (employee !== ALL) p.set('employeeId', employee)
    if (department !== ALL) p.set('departmentId', department)
    for (const [k, v] of Object.entries(extra)) p.set(k, v)
    return p.toString()
  }, [cycleId, bu, employee, department])

  useEffect(() => {
    if (!cycleId) return
    setLoading(true)
    commissionApi(`/api/hr/commission/report?${query()}`)
      .then((json) => setReport(json.report))
      .catch((e) => toast({ title: 'Report unavailable', description: e.message, variant: 'destructive' }))
      .finally(() => setLoading(false))
  }, [cycleId, query, toast])

  // Filter options come from the unfiltered cycle report.
  useEffect(() => {
    if (!cycleId) return
    setBu(ALL); setEmployee(ALL); setDepartment(ALL)
    commissionApi(`/api/hr/commission/report?cycleId=${cycleId}`).then((json) => setFullReport(json.report)).catch(() => setFullReport(null))
  }, [cycleId])

  const visibleCycles = useMemo(() => cycles.filter((c) => statusFilter === ALL || c.status === statusFilter), [cycles, statusFilter])
  const options = useMemo(() => {
    const r = fullReport
    if (!r) return { units: [], employees: [], departments: [] }
    return {
      units: r.income.map((b) => ({ id: b.businessUnitId, name: b.name })),
      employees: r.sections.flatMap((s) => s.employees.map((e) => ({ id: e.employeeId, name: e.employeeName }))).sort((a, b) => a.name.localeCompare(b.name)),
      departments: r.sections.filter((s) => s.departmentId).map((s) => ({ id: s.departmentId as string, name: s.departmentName })),
    }
  }, [fullReport])

  const download = async (format: 'xlsx' | 'pdf') => {
    setExporting(format)
    try {
      const res = await fetch(`/api/hr/commission/report/export?${query({ format })}`, { credentials: 'include' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Export failed (${res.status})`)
      const blob = await res.blob()
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `commission.${format}`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = name; a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      toast({ title: 'Export failed', description: e.message, variant: 'destructive' })
    } finally {
      setExporting(null)
    }
  }

  const openDrill = async (emp: EmployeeBlock) => {
    setDrill({ employee: emp, data: null })
    try {
      const json = await commissionApi(`/api/hr/commission/report/drilldown?cycleId=${cycleId}&employeeId=${emp.employeeId}`)
      setDrill({ employee: emp, data: json })
    } catch (e: any) {
      toast({ title: 'Details unavailable', description: e.message, variant: 'destructive' })
      setDrill(null)
    }
  }

  if (!loading && cycles.length === 0) {
    return (
      <Card className="border-dashed shadow-none">
        <CardContent className="py-12 text-center text-sm text-[var(--sera-muted)]">
          <Wallet className="mx-auto mb-2 h-6 w-6" />No commission cycles yet. HR opens and calculates cycles under HR → Payroll → Commission Settings.
        </CardContent>
      </Card>
    )
  }

  const r = report
  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Commission status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {Object.entries(CYCLE_STATUS_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={cycleId} onValueChange={setCycleId}>
          <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Commission cycle" /></SelectTrigger>
          <SelectContent>{visibleCycles.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={bu} onValueChange={setBu}>
          <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Business Unit" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Business Units</SelectItem>
            {options.units.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={department} onValueChange={setDepartment}>
          <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Team / Department" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All teams</SelectItem>
            {options.departments.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={employee} onValueChange={setEmployee}>
          <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Employee" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All employees</SelectItem>
            {options.employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading || !r ? (
        <div className="py-16 text-center text-sm text-[var(--sera-muted)]"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />Loading commission report…</div>
      ) : (
        <>
          <div className="flex flex-col gap-3 rounded-xl border border-[var(--sera-line,#e8eaed)] bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold">{r.cycle.label}</h3>
                {statusBadge(r.cycle.status)}
                {(r.cycle.status === 'locked' || r.cycle.status === 'payroll_ready') && <Lock className="h-4 w-4 text-indigo-600" aria-label="Locked" />}
              </div>
              <p className="text-xs text-[var(--sera-muted)]">
                {cycleRangeLabel(r.cycle.startAt, r.cycle.endAt)} · by first approval date (MYT) · calculation v{r.cycle.calcVersion}
                {r.cycle.status === 'calculated' || r.cycle.status === 'under_review' ? ' · provisional until approved' : ''}
              </p>
            </div>
            {canExport && (
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={!!exporting} onClick={() => download('pdf')}>
                  {exporting === 'pdf' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileText className="mr-1.5 h-4 w-4" />}PDF
                </Button>
                <Button variant="outline" size="sm" disabled={!!exporting} onClick={() => download('xlsx')}>
                  {exporting === 'xlsx' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-1.5 h-4 w-4" />}Excel
                </Button>
              </div>
            )}
          </div>

          {r.cycle.reviewFlags > 0 && (
            <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {r.cycle.reviewFlags} item(s) flagged for review in this calculation (for example a brand without a Business Unit or an order without an approval timestamp). They are excluded, never guessed.
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi label="Total Eligible Sales" value={formatRM(r.summary.eligibleSales)} icon={Building2} />
            <Kpi label="Total Commission" value={formatRM(r.summary.totalCommission)} icon={Wallet} />
            <Kpi label="Adjustments" value={formatRM(r.summary.totalAdjustments)} note={r.summary.pendingAdjustments ? `${r.summary.pendingAdjustments} pending (not included)` : undefined} icon={Wallet} />
            <Kpi label="Eligible Employees" value={r.summary.eligibleEmployees} icon={Users} />
            <Kpi label="Average Commission" value={formatRM(r.summary.averageCommission)} note="per eligible employee" icon={Users} />
          </div>

          {/* Income / Eligible Sales by Business Unit */}
          <Card className="border border-[var(--sera-line)] shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Income / Eligible Sales</CardTitle>
              <CardDescription>Approved D2H sales by Business Unit (brand on the approval date). H2M purchases are never included.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead className="text-left text-xs text-[var(--sera-muted)]"><tr><th className="py-2">Business Unit</th><th className="text-right">Lines</th><th className="text-right">Eligible Sales</th><th className="text-right">Commission</th></tr></thead>
                <tbody>
                  {r.income.map((b) => (
                    <tr key={b.businessUnitId} className="border-t"><td className="py-2">{b.name}</td><td className="text-right">{b.lines}</td><td className="text-right">{formatRM(b.eligibleSales)}</td><td className="text-right">{formatRM(b.commission)}</td></tr>
                  ))}
                  <tr className="border-t font-semibold"><td className="py-2">Total</td><td /><td className="text-right">{formatRM(r.summary.eligibleSales)}</td><td className="text-right">{formatRM(r.summary.totalCommission)}</td></tr>
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* Commission breakdown */}
          <Card className="border border-[var(--sera-line)] shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Commission Breakdown</CardTitle>
              <CardDescription>Grouped by HR department. Select an employee for source orders, rates, adjustments and approvals.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {r.sections.length === 0 ? (
                <p className="py-8 text-center text-sm text-[var(--sera-muted)]">No commission for this selection.</p>
              ) : (
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="text-left text-xs text-[var(--sera-muted)]">
                    <tr><th className="py-2">Employee</th><th>Business Unit</th><th className="text-right">Commissionable Sales</th><th className="text-right">Rate</th><th className="text-right">Commission</th><th className="text-right">Adjustments</th><th className="text-right">Net Commission</th></tr>
                  </thead>
                  <tbody>
                    {r.sections.map((s) => (
                      <Fragment key={s.departmentId ?? 'none'}>
                        <tr className="bg-orange-50/60"><td colSpan={7} className="px-1 py-2 font-semibold">{s.departmentName} Commission</td></tr>
                        {s.employees.map((e) => (
                          <Fragment key={e.employeeId}>
                            {e.rows.map((row, idx) => (
                              <tr key={idx} className="border-t align-top">
                                <td className="py-2">
                                  {idx === 0 ? <button type="button" className="text-left font-medium text-[var(--sera-orange,#ea580c)] hover:underline" onClick={() => openDrill(e)}>{e.employeeName}</button> : null}
                                  {row.note && <p className="text-[11px] text-[var(--sera-muted)]">{row.note}</p>}
                                </td>
                                <td>{row.businessUnit}</td>
                                <td className="text-right">{row.commissionableSales == null ? '' : formatRM(row.commissionableSales)}</td>
                                <td className="text-right font-mono text-xs">{row.ratePercent == null ? '' : formatRate(row.ratePercent)}</td>
                                <td className="text-right">{formatRM(row.commission)}</td>
                                <td className="text-right">{row.adjustments ? formatRM(row.adjustments) : ''}</td>
                                <td className="text-right">{formatRM(row.net)}</td>
                              </tr>
                            ))}
                            {e.rows.length > 1 && (
                              <tr className="text-xs italic text-[var(--sera-muted)]"><td className="pb-2" colSpan={4}>{e.employeeName} — total</td><td className="text-right">{formatRM(e.commission)}</td><td className="text-right">{formatRM(e.adjustments)}</td><td className="text-right">{formatRM(e.net)}</td></tr>
                            )}
                          </Fragment>
                        ))}
                        <tr className="border-t bg-gray-50 font-semibold"><td className="py-2" colSpan={4}>{s.departmentName} subtotal</td><td className="text-right">{formatRM(s.commission)}</td><td className="text-right">{formatRM(s.adjustments)}</td><td className="text-right">{formatRM(s.net)}</td></tr>
                      </Fragment>
                    ))}
                    <tr className="border-t-2 text-base font-bold"><td className="py-3" colSpan={4}>Grand Total</td><td className="text-right">{formatRM(r.grandTotal.commission)}</td><td className="text-right">{formatRM(r.grandTotal.adjustments)}</td><td className="text-right">{formatRM(r.grandTotal.net)}</td></tr>
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Sheet open={!!drill} onOpenChange={(o) => { if (!o) setDrill(null) }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-[640px]">
          <SheetHeader>
            <SheetTitle>{drill?.employee.employeeName}</SheetTitle>
            <SheetDescription>{r?.cycle.label} · net {formatRM(drill?.employee.net)}</SheetDescription>
          </SheetHeader>
          {!drill?.data ? (
            <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
          ) : (
            <div className="mt-4 space-y-5 text-sm">
              {drill.data.items.map((item: any) => (
                <section key={item.id} className="space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold">{item.business_unit_name} · <span className="font-mono">{formatRate(Number(item.rate_percent))}</span></p>
                    <p className="text-xs text-[var(--sera-muted)]">rate {item.rule_effective_from} → {item.rule_effective_to ?? 'open'}</p>
                  </div>
                  <p className="text-xs">{formatRM(Number(item.eligible_sales))} × {formatRate(Number(item.rate_percent))} = <b>{formatRM(Number(item.commission_amount))}</b></p>
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full min-w-[480px] text-xs">
                      <thead className="bg-gray-50 text-left"><tr><th className="p-2">Order</th><th>First approved (MYT)</th><th>Product</th><th className="pr-2 text-right">Line value</th></tr></thead>
                      <tbody>
                        {item.sources.map((s: any) => (
                          <tr key={s.id} className="border-t">
                            <td className="p-2">{s.order_no}<p className="text-[10px] text-gray-500">{s.buyer_name} · {s.order_status}</p></td>
                            <td>{new Date(s.approval_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })}{s.approval_source === 'recorded_approved_at' && <p className="text-[10px] text-amber-700">recorded before the approval ledger</p>}</td>
                            <td>{s.product_name}<p className="text-[10px] text-gray-500">{s.brand_name} · {s.qty} × {formatRM(Number(s.unit_price))}</p></td>
                            <td className="pr-2 text-right">{formatRM(Number(s.line_value))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
              {drill.data.adjustments.length > 0 && (
                <section className="space-y-1">
                  <p className="font-semibold">Adjustments</p>
                  {drill.data.adjustments.map((a: any) => (
                    <div key={a.id} className="flex justify-between gap-2 rounded-lg border p-2 text-xs">
                      <span>{a.kind === 'cancellation_reversal' ? 'Reversal' : 'Adjustment'}: {a.reason}{a.source_order_no ? ` (${a.source_order_no})` : ''} · <i>{a.status}</i></span>
                      <span className="font-medium">{formatRM(Number(a.amount))}</span>
                    </div>
                  ))}
                </section>
              )}
              <section className="space-y-1 text-xs">
                <p className="text-sm font-semibold">Approval history</p>
                {[
                  ['Calculated', drill.data.cycle.calculated_by, drill.data.cycle.calculated_at],
                  ['Submitted for review', drill.data.cycle.submitted_by, drill.data.cycle.submitted_at],
                  ['Approved', drill.data.cycle.approved_by, drill.data.cycle.approved_at],
                  ['Locked', drill.data.cycle.locked_by, drill.data.cycle.locked_at],
                  ['Payroll ready', drill.data.cycle.payroll_ready_by, drill.data.cycle.payroll_ready_at],
                ].filter(([, , at]) => at).map(([label, by, at]) => (
                  <p key={label as string}>{label} by {drill.data.names?.[by as string] ?? '—'} on {new Date(at as string).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })}</p>
                ))}
              </section>
            </div>
          )}
        </SheetContent>
      </Sheet>
      {!canExport && <p className="text-[11px] text-[var(--sera-muted)]"><Download className="mr-1 inline h-3 w-3" />Exports need the Commission export permission.</p>}
    </div>
  )
}
