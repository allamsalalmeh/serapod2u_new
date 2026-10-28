'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, CalendarDays, Download, FileSpreadsheet, RefreshCw, Upload } from 'lucide-react'
import { addDays, apiGet, apiPost, dateLabel, isoDay, timeOf } from '@/lib/hr/wave3/client'
import { EXCEPTION_LABELS, formatMinutes, SOURCE_LABELS } from '@/lib/hr/wave3/messages'
import { buildImportTemplate, IMPORT_MAX_ROWS, OUTCOME_LABELS, rowsFromMatrix, sha256Hex, worksheetMatrix } from '@/lib/hr/wave3/attendance-import'

/**
 * HR attendance operations (Wave 3 — Hybrid Attendance, B4a/B4b/B4c/B5). Every screen calls the HR routes; the DATABASE
 * decides each action with canonical S&A (explicit HR 'hr.attendance.manage'; direct managers only where Manager
 * Self-Service allows it), refuses self-review and enforces maker-checker. Nothing here shows success unless the server
 * stored it.
 */

interface BoardRow {
  employee_id: string; employee_no: number | null; name: string; day_type: string; on_leave: boolean; open_exceptions: number
  entries: { id: string; clock_in_at: string; clock_out_at: string | null; worked_minutes: number | null; source: string; attendance_flag: string; review_state: string }[]
}
interface ExceptionRow {
  id: string; employee_id: string; name: string; employee_no: number | null; work_date: string; code: string; details: Record<string, unknown>
  status: string; resolution: string | null; resolution_note: string | null; resolved_by: string | null; can_resolve: boolean
  entry: { clock_in_at: string; clock_out_at: string | null; source: string; worked_minutes: number | null } | null
}
interface CorrectionRow {
  id: string; name: string; employee_no: number | null; work_date: string; kind: string; status: string; reason: string; requested_by: string
  original_clock_in: string | null; original_clock_out: string | null; corrected_clock_in: string | null; corrected_clock_out: string | null
  corrected_break_minutes: number | null; review_comment: string | null; reviewed_by: string | null; can_decide: boolean
}
interface OtRow {
  id: string; employee_name: string; employee_no: number | null; request_date: string; ot_minutes: number; approved_minutes: number | null
  status: string; request_kind: string; reason: string; day_type: string; exceeds_policy_cap: boolean; exceeds_recorded_time: boolean
  approver_name: string | null; approver_comment: string | null; decided_authority: string | null; can_decide: boolean
  entry: { clock_in_at: string; clock_out_at: string | null; worked_minutes: number | null } | null
}
interface ImportBatch {
  batch: { id: string; file_name: string; status: string; row_count: number; valid_count: number; error_count: number; duplicate_count: number; conflict_count: number; imported_count: number; created_at: string }
  rows: { row_no: number; outcome: string; messages: string[]; employee_no: number | null; employee_name: string | null; work_date: string | null; clock_in_at: string | null; clock_out_at: string | null; raw: Record<string, string> }[]
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  open: 'destructive', pending: 'destructive', submitted: 'destructive', resolved: 'default', approved: 'default', cleared: 'secondary',
  rejected: 'outline', cancelled: 'secondary', valid: 'default', imported: 'default', error: 'destructive', duplicate: 'secondary', conflict: 'outline',
}
const StatusBadge = ({ s }: { s: string }) => <Badge variant={STATUS_VARIANT[s] ?? 'secondary'}>{OUTCOME_LABELS[s] ?? s}</Badge>

export const OPERATIONS_TABS = ['board', 'exceptions', 'corrections', 'manual', 'import', 'overtime', 'report'] as const
export type OperationsTab = typeof OPERATIONS_TABS[number]

/** A failed read is shown where the data would be (once, in place), never as a stack of toasts or as "nothing found". */
const LoadError = ({ message, onRetry }: { message: string | null; onRetry: () => void }) => message ? (
  <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
    <span className="min-w-0">{message}</span>
    <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="h-4 w-4 mr-1" />Try again</Button>
  </div>
) : null

type Ask = { title: string; label: string; required: boolean; confirm: string; minutes?: number; run: (text: string, minutes?: number) => Promise<void> }

export default function HrAttendanceOperationsView({ initialTab = 'board' }: { initialTab?: OperationsTab } = {}) {
  const { toast } = useToast()
  const today = isoDay()
  const [tab, setTab] = useState<OperationsTab>(initialTab)
  useEffect(() => { setTab(initialTab) }, [initialTab])
  const [ask, setAsk] = useState<Ask | null>(null)
  const [askText, setAskText] = useState('')
  const [askMinutes, setAskMinutes] = useState<number | undefined>(undefined)

  const fail = useCallback((title: string, error: string): void => { toast({ title, description: error, variant: 'destructive' }) }, [toast])

  /* ── Board ─────────────────────────────────────────────────── */
  const [boardDate, setBoardDate] = useState(addDays(today, -1))
  const [board, setBoard] = useState<BoardRow[]>([])
  const [boardError, setBoardError] = useState<string | null>(null)
  const loadBoard = useCallback(async () => {
    const r = await apiGet<BoardRow[]>('/api/hr/attendance/board', { date: boardDate })
    if (r.ok) { setBoard(r.data); setBoardError(null) } else setBoardError(r.error)
  }, [boardDate])
  useEffect(() => { void loadBoard() }, [loadBoard])

  /* ── Exceptions ────────────────────────────────────────────── */
  const [excStatus, setExcStatus] = useState('open')
  const [excFrom, setExcFrom] = useState(addDays(today, -14))
  const [excTo, setExcTo] = useState(today)
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([])
  const [excError, setExcError] = useState<string | null>(null)
  const loadExceptions = useCallback(async () => {
    const r = await apiGet<ExceptionRow[]>('/api/hr/attendance/exceptions', { status: excStatus || null, from: excFrom, to: excTo })
    if (r.ok) { setExceptions(r.data); setExcError(null) } else { setExceptions([]); setExcError(r.error) }
  }, [excStatus, excFrom, excTo])
  useEffect(() => { void loadExceptions() }, [loadExceptions])

  async function detect() {
    const r = await apiPost<{ new_exceptions: number; from: string; to: string }>('/api/hr/attendance/exceptions', { action: 'detect', from: excFrom, to: excTo })
    if (!r.ok) return fail('Check not run', r.error)
    toast({ title: 'Attendance checked', description: `${r.data.new_exceptions} new exception(s) between ${r.data.from} and ${r.data.to}.` })
    await Promise.all([loadExceptions(), loadBoard()])
  }
  const resolve = (x: ExceptionRow, resolution: 'acknowledged' | 'excused' | 'dismissed') => {
    const run = async (note: string) => {
      const r = await apiPost('/api/hr/attendance/exceptions', { action: 'resolve', id: x.id, resolution, note: note || null })
      if (!r.ok) return fail('Not resolved', r.error)
      toast({ title: 'Exception resolved' }); await Promise.all([loadExceptions(), loadBoard()])
    }
    if (resolution === 'acknowledged') return run('')
    setAskText(''); setAsk({ title: resolution === 'excused' ? 'Excuse exception' : 'Dismiss exception', label: 'Note (required)', required: true, confirm: 'Save', run })
  }

  /* ── Corrections ───────────────────────────────────────────── */
  const [corrStatus, setCorrStatus] = useState('pending')
  const [corrections, setCorrections] = useState<CorrectionRow[]>([])
  const [corrError, setCorrError] = useState<string | null>(null)
  const loadCorrections = useCallback(async () => {
    const r = await apiGet<CorrectionRow[]>('/api/hr/attendance/corrections', { status: corrStatus || null })
    if (r.ok) { setCorrections(r.data); setCorrError(null) } else { setCorrections([]); setCorrError(r.error) }
  }, [corrStatus])
  useEffect(() => { void loadCorrections() }, [loadCorrections])
  const decideCorrection = (c: CorrectionRow, approve: boolean) => {
    const run = async (comment: string) => {
      const r = await apiPost(`/api/hr/attendance/corrections/${c.id}/review`, { action: approve ? 'approved' : 'rejected', comment: comment || null })
      if (!r.ok) return fail('Decision not saved', r.error)
      toast({ title: approve ? 'Correction approved — entry updated, original kept in the audit' : 'Correction rejected' })
      await Promise.all([loadCorrections(), loadExceptions(), loadBoard()])
    }
    setAskText(''); setAsk({ title: approve ? 'Approve correction' : 'Reject correction', label: approve ? 'Comment (optional)' : 'Reason (required)', required: !approve, confirm: approve ? 'Approve' : 'Reject', run })
  }

  /* ── Manual entry / adjustment ─────────────────────────────── */
  const [manual, setManual] = useState({ employee: '', date: addDays(today, -1), inT: '09:00', outT: '18:00', brk: '60', reason: '' })
  async function saveManual() {
    const r = await apiPost('/api/hr/attendance/manual-entry', {
      employee_user_id: manual.employee, work_date: manual.date, clock_in: manual.inT, clock_out: manual.outT || null,
      break_minutes: manual.brk === '' ? null : Number(manual.brk), reason: manual.reason,
    })
    if (!r.ok) return fail('Entry not recorded', r.error)
    toast({ title: 'Attendance recorded', description: 'A second HR person must confirm it (Exceptions → HR manual entry).' })
    setManual({ ...manual, reason: '' }); await Promise.all([loadBoard(), loadExceptions()])
  }
  const [adjust, setAdjust] = useState<{ employee: string; name: string; entryId: string; inT: string; outT: string; brk: string; reason: string } | null>(null)
  async function saveAdjust() {
    if (!adjust) return
    const r = await apiPost('/api/hr/attendance/corrections', {
      action: 'request', entry_id: adjust.entryId, employee_user_id: adjust.employee, clock_in: adjust.inT || null, clock_out: adjust.outT || null,
      break_minutes: adjust.brk === '' ? null : Number(adjust.brk), reason: adjust.reason,
    })
    if (!r.ok) return fail('Adjustment not submitted', r.error)
    toast({ title: 'Adjustment submitted', description: 'Another HR person (or the authorized manager) must approve it.' })
    setAdjust(null); await loadCorrections()
  }

  /* ── Import ────────────────────────────────────────────────── */
  const [preview, setPreview] = useState<ImportBatch | null>(null)
  const [batches, setBatches] = useState<ImportBatch['batch'][]>([])
  const [batchError, setBatchError] = useState<string | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const loadBatches = useCallback(async () => {
    const r = await apiGet<ImportBatch['batch'][]>('/api/hr/attendance/import')
    if (r.ok) { setBatches(r.data); setBatchError(null) } else setBatchError(r.error)
  }, [])
  useEffect(() => { void loadBatches() }, [loadBatches])
  async function downloadTemplate() {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    buildImportTemplate(wb)
    const buf = await wb.xlsx.writeBuffer()
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const a = document.createElement('a'); a.href = url; a.download = 'attendance-import-template.xlsx'; a.click(); URL.revokeObjectURL(url)
  }
  async function onFile(file: File | undefined) {
    if (!file) return
    setImportBusy(true)
    try {
      const data = await file.arrayBuffer()
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(data)
      const parsed = rowsFromMatrix(worksheetMatrix(wb))
      if (parsed.missingColumns.length) return fail('Template columns missing', `Missing: ${parsed.missingColumns.join(', ')}. Download the template.`)
      if (parsed.rows.length === 0) return fail('No rows', 'The file contains no attendance rows.')
      if (parsed.rows.length > IMPORT_MAX_ROWS) return fail('File too large', `At most ${IMPORT_MAX_ROWS} rows per file.`)
      const r = await apiPost<ImportBatch>('/api/hr/attendance/import', { action: 'preview', file_name: file.name, file_sha256: await sha256Hex(data), rows: parsed.rows })
      if (!r.ok) return fail('File not accepted', r.error)
      setPreview(r.data); await loadBatches()
    } catch {
      fail('File not readable', 'Upload an .xlsx file based on the template.')
    } finally { setImportBusy(false) }
  }
  async function commitImport() {
    if (!preview) return
    setImportBusy(true)
    const r = await apiPost<{ imported: number; conflicts_at_commit: number; status: string }>('/api/hr/attendance/import', { action: 'commit', batch_id: preview.batch.id, expected_valid: preview.batch.valid_count })
    setImportBusy(false)
    if (!r.ok) return fail('Import not completed', r.error)
    toast({ title: `${r.data.imported} row(s) imported`, description: r.data.conflicts_at_commit ? `${r.data.conflicts_at_commit} row(s) changed since the preview and were skipped.` : undefined })
    const b = await apiGet<ImportBatch>('/api/hr/attendance/import', { batch_id: preview.batch.id })
    setPreview(b.ok ? b.data : null); await Promise.all([loadBatches(), loadBoard()])
  }
  async function cancelImport() {
    if (!preview) return
    const r = await apiPost('/api/hr/attendance/import', { action: 'cancel', batch_id: preview.batch.id })
    if (!r.ok) return fail('Not cancelled', r.error)
    setPreview(null); await loadBatches()
  }

  /* ── Overtime ──────────────────────────────────────────────── */
  const [otStatus, setOtStatus] = useState('submitted')
  const [ot, setOt] = useState<OtRow[]>([])
  const [otError, setOtError] = useState<string | null>(null)
  const loadOt = useCallback(async () => {
    const r = await apiGet<OtRow[]>('/api/hr/attendance/overtime/requests', { scope: 'queue', status: otStatus || null })
    if (r.ok) { setOt(r.data); setOtError(null) } else { setOt([]); setOtError(r.error) }
  }, [otStatus])
  useEffect(() => { void loadOt() }, [loadOt])
  const decideOt = (o: OtRow, action: 'approve' | 'reject' | 'cancel') => {
    const run = async (text: string, minutes?: number) => {
      const r = action === 'cancel'
        ? await apiPost('/api/hr/attendance/overtime/requests', { action: 'cancel', id: o.id, reason: text })
        : await apiPost('/api/hr/attendance/overtime/requests', { action, id: o.id, comment: text || null, approved_minutes: action === 'approve' ? minutes ?? o.ot_minutes : null })
      if (!r.ok) return fail('Decision not saved', r.error)
      toast({ title: action === 'approve' ? 'Overtime approved' : action === 'reject' ? 'Overtime rejected' : 'Approved overtime cancelled' })
      await loadOt()
    }
    setAskText(''); setAskMinutes(action === 'approve' ? o.ot_minutes : undefined)
    setAsk({ title: action === 'approve' ? 'Approve overtime' : action === 'reject' ? 'Reject overtime' : 'Cancel approved overtime',
      label: action === 'approve' ? 'Comment (optional)' : 'Reason (required)', required: action !== 'approve',
      confirm: action === 'approve' ? 'Approve' : action === 'reject' ? 'Reject' : 'Cancel overtime', minutes: action === 'approve' ? o.ot_minutes : undefined, run })
  }

  /* ── Report ────────────────────────────────────────────────── */
  const [repFrom, setRepFrom] = useState(addDays(today, -30))
  const [repTo, setRepTo] = useState(today)
  const [report, setReport] = useState<any[] | null>(null)
  async function loadReport() {
    const r = await apiGet<{ rows: any[] }>('/api/hr/attendance/report', { from: repFrom, to: repTo })
    if (r.ok) setReport(r.data.rows); else fail('Report not loaded', r.error)
  }
  function exportCsv() {
    if (!report) return
    const cols = ['employee_no', 'name', 'days_present', 'worked_minutes', 'late', 'early', 'absent', 'open_exceptions', 'manual_or_imported', 'ot_approved_minutes', 'ot_pending']
    const csv = [cols.join(','), ...report.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = `attendance-${repFrom}-${repTo}.csv`; a.click(); URL.revokeObjectURL(url)
  }

  const openCounts = useMemo(() => ({
    exceptions: exceptions.filter((x) => x.status === 'open').length,
    corrections: corrections.filter((c) => c.status === 'pending').length,
    ot: ot.filter((o) => o.status === 'submitted').length,
  }), [exceptions, corrections, ot])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Attendance operations</CardTitle>
        <CardDescription>Normal attendance is accepted automatically. Review exceptions, corrections and overtime; record or import attendance with a reason.</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as OperationsTab)}>
          <TabsList className="flex flex-wrap h-auto">
            <TabsTrigger value="board">Daily board</TabsTrigger>
            <TabsTrigger value="exceptions">Exceptions{openCounts.exceptions ? ` (${openCounts.exceptions})` : ''}</TabsTrigger>
            <TabsTrigger value="corrections">Corrections{openCounts.corrections ? ` (${openCounts.corrections})` : ''}</TabsTrigger>
            <TabsTrigger value="manual">Manual entry</TabsTrigger>
            <TabsTrigger value="import">Excel import</TabsTrigger>
            <TabsTrigger value="overtime">Overtime{openCounts.ot ? ` (${openCounts.ot})` : ''}</TabsTrigger>
            <TabsTrigger value="report">Report</TabsTrigger>
          </TabsList>

          <TabsContent value="board" className="space-y-3">
            <div className="flex items-end gap-2">
              <div className="space-y-1"><Label>Date</Label><Input type="date" value={boardDate} max={today} onChange={(e) => setBoardDate(e.target.value)} /></div>
              <Button variant="outline" onClick={() => void loadBoard()}><RefreshCw className="h-4 w-4 mr-1" />Refresh</Button>
            </div>
            <LoadError message={boardError} onRetry={() => void loadBoard()} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-gray-500"><th className="py-2">Employee</th><th>Day</th><th>Attendance</th><th>Worked</th><th>Review</th><th /></tr></thead>
                <tbody>
                  {board.map((b) => (
                    <tr key={b.employee_id} className="border-t align-top">
                      <td className="py-2">{b.name}<div className="text-xs text-gray-500">{b.employee_no ?? ''}</div></td>
                      <td>{b.on_leave ? <Badge variant="secondary">On leave</Badge> : b.day_type === 'normal' ? 'Working day' : b.day_type.replace('_', ' ')}</td>
                      <td>{b.entries.length === 0 ? <span className="text-gray-400">—</span> : b.entries.map((e) => (
                        <div key={e.id}>{timeOf(e.clock_in_at)}–{e.clock_out_at ? timeOf(e.clock_out_at) : '…'} <span className="text-xs text-gray-500">{SOURCE_LABELS[e.source] ?? e.source}</span>{e.attendance_flag !== 'ontime' && <Badge variant="destructive" className="ml-1 text-[10px]">{e.attendance_flag}</Badge>}</div>
                      ))}</td>
                      <td>{formatMinutes(b.entries.reduce((s, e) => s + (e.worked_minutes ?? 0), 0))}</td>
                      <td>{b.open_exceptions > 0 ? <Badge variant="destructive">{b.open_exceptions} open</Badge> : <span className="text-xs text-green-700">OK</span>}</td>
                      <td className="text-right space-x-1">
                        <Button size="sm" variant="ghost" onClick={() => setManual({ ...manual, employee: b.employee_id, date: boardDate })}>Add entry</Button>
                        {b.entries.map((e) => (
                          <Button key={e.id} size="sm" variant="ghost" onClick={() => setAdjust({ employee: b.employee_id, name: b.name, entryId: e.id, inT: '', outT: '', brk: '', reason: '' })}>Adjust {timeOf(e.clock_in_at)}</Button>
                        ))}
                      </td>
                    </tr>
                  ))}
                  {board.length === 0 && !boardError && <tr><td colSpan={6} className="py-6 text-center text-gray-500">No employees visible for this date.</td></tr>}
                </tbody>
              </table>
            </div>
          </TabsContent>

          <TabsContent value="exceptions" className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1"><Label>Status</Label>
                <select className="h-9 rounded border px-2 text-sm" value={excStatus} onChange={(e) => setExcStatus(e.target.value)}>
                  <option value="open">Open</option><option value="resolved">Resolved</option><option value="cleared">Cleared</option><option value="">All</option>
                </select></div>
              <div className="space-y-1"><Label>From</Label><Input type="date" value={excFrom} onChange={(e) => setExcFrom(e.target.value)} /></div>
              <div className="space-y-1"><Label>To</Label><Input type="date" value={excTo} max={today} onChange={(e) => setExcTo(e.target.value)} /></div>
              <Button variant="outline" onClick={detect}><RefreshCw className="h-4 w-4 mr-1" />Check this range</Button>
            </div>
            <LoadError message={excError} onRetry={() => void loadExceptions()} />
            <p className="text-xs text-gray-500">Exceptions come from the attendance policy (late after, early leave, maximum open hours, workdays), public holidays and approved leave. Resolving records who decided and why; it has no payroll or disciplinary effect.</p>
            {exceptions.map((x) => (
              <div key={x.id} className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <span className="font-medium">{x.name}</span><span className="text-gray-500">{dateLabel(x.work_date)}</span>
                <span>{EXCEPTION_LABELS[x.code] ?? x.code}{x.details?.late_minutes ? ` (${x.details.late_minutes} min)` : ''}{x.details?.early_minutes ? ` (${x.details.early_minutes} min)` : ''}</span>
                {x.entry && <span className="text-xs text-gray-500">{timeOf(x.entry.clock_in_at)}–{x.entry.clock_out_at ? timeOf(x.entry.clock_out_at) : '…'} · {SOURCE_LABELS[x.entry.source] ?? x.entry.source}</span>}
                <StatusBadge s={x.status} />{x.resolution && <span className="text-xs">{x.resolution}{x.resolved_by ? ` by ${x.resolved_by}` : ''}{x.resolution_note ? ` — ${x.resolution_note}` : ''}</span>}
                {x.can_resolve && (
                  <span className="ml-auto space-x-1">
                    <Button size="sm" onClick={() => resolve(x, 'acknowledged')}>{x.code === 'manual_entry' ? 'Confirm entry' : 'Acknowledge'}</Button>
                    {x.code !== 'manual_entry' && <Button size="sm" variant="outline" onClick={() => resolve(x, 'excused')}>Excuse</Button>}
                    <Button size="sm" variant="ghost" onClick={() => resolve(x, 'dismissed')}>Dismiss</Button>
                  </span>
                )}
              </div>
            ))}
            {exceptions.length === 0 && !excError && <p className="text-sm text-gray-500 py-4 text-center">No exceptions for this filter. Use “Check this range” to look for missing attendance.</p>}
          </TabsContent>

          <TabsContent value="corrections" className="space-y-3">
            <select className="h-9 rounded border px-2 text-sm" value={corrStatus} onChange={(e) => setCorrStatus(e.target.value)} aria-label="Correction status">
              <option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All</option>
            </select>
            <LoadError message={corrError} onRetry={() => void loadCorrections()} />
            <p className="text-xs text-gray-500">Employees request corrections and report missing days from My Attendance. Your own requests never appear here — another authorized person decides them.</p>
            {corrections.map((c) => (
              <div key={c.id} className="rounded border p-2 text-sm space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.name}</span><span className="text-gray-500">{dateLabel(c.work_date)}</span>
                  <Badge variant="secondary">{c.kind === 'missing_day' ? 'Missing day' : c.kind === 'hr_adjustment' ? 'HR adjustment' : 'Correction'}</Badge>
                  <StatusBadge s={c.status} /><span className="text-xs text-gray-500">requested by {c.requested_by}</span>
                </div>
                <div className="text-xs">
                  {c.kind !== 'missing_day' && <span>Recorded {timeOf(c.original_clock_in)}–{timeOf(c.original_clock_out)} → </span>}
                  Requested {c.corrected_clock_in ? timeOf(c.corrected_clock_in) : 'unchanged'}–{c.corrected_clock_out ? timeOf(c.corrected_clock_out) : 'unchanged'}
                  {c.corrected_break_minutes !== null ? ` · break ${c.corrected_break_minutes} min` : ''} · “{c.reason}”
                  {c.review_comment ? ` · decision: ${c.review_comment}${c.reviewed_by ? ` (${c.reviewed_by})` : ''}` : ''}
                </div>
                {c.can_decide && (
                  <div className="space-x-1"><Button size="sm" onClick={() => decideCorrection(c, true)}>Approve</Button><Button size="sm" variant="outline" onClick={() => decideCorrection(c, false)}>Reject</Button></div>
                )}
              </div>
            ))}
            {corrections.length === 0 && !corrError && <p className="text-sm text-gray-500 py-4 text-center">No corrections for this filter.</p>}
          </TabsContent>

          <TabsContent value="manual" className="space-y-3 max-w-xl">
            <p className="text-xs text-gray-500">Records attendance for an employee immediately, with your name and reason. A second HR person confirms it under Exceptions. You cannot record your own attendance. To change an existing entry use “Adjust” on the daily board (approved by someone else).</p>
            <div className="space-y-1"><Label>Employee</Label>
              <select className="h-9 w-full rounded border px-2 text-sm" value={manual.employee} onChange={(e) => setManual({ ...manual, employee: e.target.value })}>
                <option value="">Select…</option>{board.map((b) => <option key={b.employee_id} value={b.employee_id}>{b.name}{b.employee_no ? ` (${b.employee_no})` : ''}</option>)}
              </select></div>
            <div className="grid grid-cols-4 gap-2">
              <div className="space-y-1"><Label>Date</Label><Input type="date" max={today} value={manual.date} onChange={(e) => setManual({ ...manual, date: e.target.value })} /></div>
              <div className="space-y-1"><Label>Clock in</Label><Input type="time" value={manual.inT} onChange={(e) => setManual({ ...manual, inT: e.target.value })} /></div>
              <div className="space-y-1"><Label>Clock out</Label><Input type="time" value={manual.outT} onChange={(e) => setManual({ ...manual, outT: e.target.value })} /></div>
              <div className="space-y-1"><Label>Break (min)</Label><Input type="number" min={0} max={600} value={manual.brk} onChange={(e) => setManual({ ...manual, brk: e.target.value })} /></div>
            </div>
            <div className="space-y-1"><Label>Reason (required)</Label><Textarea value={manual.reason} onChange={(e) => setManual({ ...manual, reason: e.target.value })} placeholder="e.g. Card reader offline on site" /></div>
            {board.length === 0 && <p className="text-xs text-amber-700">The employee list comes from the Daily board. If it is empty, check the board date or the error shown there.</p>}
            <Button disabled={!manual.employee || manual.reason.trim().length < 5} onClick={saveManual}><CalendarDays className="h-4 w-4 mr-1" />Record attendance</Button>
          </TabsContent>

          <TabsContent value="import" className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={downloadTemplate}><Download className="h-4 w-4 mr-1" />Download template</Button>
              <label className="inline-flex items-center gap-2 rounded border px-3 py-2 text-sm cursor-pointer">
                <Upload className="h-4 w-4" />{importBusy ? 'Checking…' : 'Upload .xlsx for preview'}
                <input type="file" accept=".xlsx" className="hidden" disabled={importBusy} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
              </label>
            </div>
            <p className="text-xs text-gray-500">The preview checks every row (employee number / e-mail, date and time formats, duplicates, overlaps with attendance already recorded). Nothing is saved until you confirm; recorded attendance is never overwritten and the same file can be imported only once.</p>
            {preview && (
              <div className="space-y-2 rounded border p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <FileSpreadsheet className="h-4 w-4" /><b>{preview.batch.file_name}</b><StatusBadge s={preview.batch.status === 'previewed' ? 'valid' : preview.batch.status} />
                  <span>{preview.batch.row_count} rows · {preview.batch.valid_count} ready · {preview.batch.error_count} errors · {preview.batch.duplicate_count} duplicates · {preview.batch.conflict_count} conflicts{preview.batch.status === 'committed' ? ` · ${preview.batch.imported_count} imported` : ''}</span>
                  {preview.batch.status === 'previewed' && (
                    <span className="ml-auto space-x-1">
                      <Button size="sm" disabled={importBusy || preview.batch.valid_count === 0} onClick={commitImport}>Import {preview.batch.valid_count} row(s)</Button>
                      <Button size="sm" variant="ghost" onClick={cancelImport}>Discard</Button>
                    </span>
                  )}
                </div>
                <div className="max-h-96 overflow-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-gray-500"><th>Row</th><th>Outcome</th><th>Employee</th><th>Date</th><th>In–Out</th><th>Details</th></tr></thead>
                    <tbody>{preview.rows.map((r) => (
                      <tr key={r.row_no} className="border-t">
                        <td className="py-1">{r.row_no}</td><td><StatusBadge s={r.outcome} /></td>
                        <td>{r.employee_name ?? r.raw.employee_no ?? r.raw.email ?? ''}</td><td>{r.work_date ?? r.raw.work_date ?? ''}</td>
                        <td>{r.clock_in_at ? `${timeOf(r.clock_in_at)}–${timeOf(r.clock_out_at)}` : `${r.raw.clock_in ?? ''}–${r.raw.clock_out ?? ''}`}</td>
                        <td>{r.messages.join(' ')}</td>
                      </tr>))}</tbody>
                  </table>
                </div>
              </div>
            )}
            <div>
              <h4 className="text-sm font-semibold mb-1">Recent imports</h4>
              <LoadError message={batchError} onRetry={() => void loadBatches()} />
              {batches.map((b) => (
                <button key={b.id} className="flex w-full items-center gap-2 border-t py-1 text-xs text-left" onClick={async () => { const r = await apiGet<ImportBatch>('/api/hr/attendance/import', { batch_id: b.id }); if (r.ok) setPreview(r.data) }}>
                  <span className="flex-1">{b.file_name}</span><StatusBadge s={b.status === 'previewed' ? 'valid' : b.status} /><span>{b.imported_count}/{b.row_count}</span><span className="text-gray-500">{new Date(b.created_at).toLocaleString('en-MY')}</span>
                </button>
              ))}
              {batches.length === 0 && !batchError && <p className="text-xs text-gray-500">No imports yet.</p>}
            </div>
          </TabsContent>

          <TabsContent value="overtime" className="space-y-3">
            <select className="h-9 rounded border px-2 text-sm" value={otStatus} onChange={(e) => setOtStatus(e.target.value)} aria-label="Overtime status">
              <option value="submitted">Waiting for decision</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option><option value="">All</option>
            </select>
            <LoadError message={otError} onRetry={() => void loadOt()} />
            <p className="text-xs text-gray-500">Overtime is approved separately from attendance. The requester can never approve; the day type is set by the calendar. No pay is calculated here (payroll phase).</p>
            {ot.map((o) => (
              <div key={o.id} className="rounded border p-2 text-sm space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{o.employee_name}</span><span className="text-gray-500">{dateLabel(o.request_date)}</span>
                  <span>{formatMinutes(o.ot_minutes)}{o.approved_minutes !== null && o.approved_minutes !== o.ot_minutes ? ` → ${formatMinutes(o.approved_minutes)}` : ''}</span>
                  <Badge variant="secondary">{o.request_kind === 'pre' ? 'Pre-approval' : 'Worked'}</Badge><Badge variant="outline">{o.day_type.replace('_', ' ')}</Badge>
                  <StatusBadge s={o.status} />
                  {o.exceeds_policy_cap && <Badge variant="destructive">Above daily cap</Badge>}
                  {o.exceeds_recorded_time && <Badge variant="destructive">More than recorded time</Badge>}
                </div>
                <div className="text-xs text-gray-600">“{o.reason}”{o.entry ? ` · attendance ${timeOf(o.entry.clock_in_at)}–${timeOf(o.entry.clock_out_at)} (${formatMinutes(o.entry.worked_minutes)})` : ' · no attendance linked'}{o.approver_name ? ` · decided by ${o.approver_name} (${o.decided_authority})` : ''}{o.approver_comment ? ` — ${o.approver_comment}` : ''}</div>
                <div className="space-x-1">
                  {o.status === 'submitted' && o.can_decide && <><Button size="sm" onClick={() => decideOt(o, 'approve')}>Approve</Button><Button size="sm" variant="outline" onClick={() => decideOt(o, 'reject')}>Reject</Button></>}
                  {o.status === 'approved' && <Button size="sm" variant="ghost" onClick={() => decideOt(o, 'cancel')}>Cancel (HR)</Button>}
                </div>
              </div>
            ))}
            {ot.length === 0 && !otError && <p className="text-sm text-gray-500 py-4 text-center">No overtime requests for this filter.</p>}
          </TabsContent>

          <TabsContent value="report" className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1"><Label>From</Label><Input type="date" value={repFrom} onChange={(e) => setRepFrom(e.target.value)} /></div>
              <div className="space-y-1"><Label>To</Label><Input type="date" value={repTo} onChange={(e) => setRepTo(e.target.value)} /></div>
              <Button onClick={loadReport}>Show</Button>
              {report && <Button variant="outline" onClick={exportCsv}><Download className="h-4 w-4 mr-1" />CSV</Button>}
            </div>
            {report && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-gray-500"><th className="py-1">Employee</th><th>Days</th><th>Worked</th><th>Late</th><th>Early</th><th>No record</th><th>Open</th><th>Manual/import</th><th>OT approved</th><th>OT waiting</th></tr></thead>
                  <tbody>{report.map((r) => (
                    <tr key={r.employee_id} className="border-t"><td className="py-1">{r.name}</td><td>{r.days_present}</td><td>{formatMinutes(r.worked_minutes)}</td><td>{r.late}</td><td>{r.early}</td><td>{r.absent}</td><td>{r.open_exceptions}</td><td>{r.manual_or_imported}</td><td>{formatMinutes(r.ot_approved_minutes)}</td><td>{r.ot_pending}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      <Dialog open={!!ask} onOpenChange={(o) => { if (!o) setAsk(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{ask?.title}</DialogTitle><DialogDescription>Your name, the time and this text are recorded.</DialogDescription></DialogHeader>
          {ask?.minutes !== undefined && (
            <div className="space-y-1"><Label>Approved minutes (up to {ask.minutes})</Label><Input type="number" min={1} max={ask.minutes} value={askMinutes ?? ''} onChange={(e) => setAskMinutes(Number(e.target.value))} /></div>
          )}
          <div className="space-y-1"><Label>{ask?.label}</Label><Textarea value={askText} onChange={(e) => setAskText(e.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsk(null)}>Back</Button>
            <Button disabled={!!ask?.required && askText.trim().length < (ask?.title.startsWith('Cancel') ? 5 : 3)}
              onClick={async () => { const a = ask; setAsk(null); if (a) await a.run(askText.trim(), askMinutes) }}>{ask?.confirm}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!adjust} onOpenChange={(o) => { if (!o) setAdjust(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Adjust attendance — {adjust?.name}</DialogTitle><DialogDescription>Submitted for approval by another person; the original stays in the audit.</DialogDescription></DialogHeader>
          {adjust && (<>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1"><Label>Clock in</Label><Input type="time" value={adjust.inT} onChange={(e) => setAdjust({ ...adjust, inT: e.target.value })} /></div>
              <div className="space-y-1"><Label>Clock out</Label><Input type="time" value={adjust.outT} onChange={(e) => setAdjust({ ...adjust, outT: e.target.value })} /></div>
              <div className="space-y-1"><Label>Break</Label><Input type="number" min={0} max={600} value={adjust.brk} onChange={(e) => setAdjust({ ...adjust, brk: e.target.value })} /></div>
            </div>
            <div className="space-y-1"><Label>Reason (required)</Label><Textarea value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} /></div>
          </>)}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjust(null)}>Back</Button>
            <Button disabled={!adjust || adjust.reason.trim().length < 5 || (!adjust.inT && !adjust.outT && adjust.brk === '')} onClick={saveAdjust}>Submit adjustment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
