'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useToast } from '@/components/ui/use-toast'
import { LogIn, LogOut, Loader2, CheckCircle2, Timer, Edit3, Clock, AlertTriangle, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { addDays, apiGet, apiPost, dateLabel, isoDay, newIdempotencyKey, timeOf } from '@/lib/hr/wave3/client'
import { EXCEPTION_LABELS, formatMinutes, SOURCE_LABELS } from '@/lib/hr/wave3/messages'

/**
 * Employee attendance (Wave 3, Hybrid Attendance). Everything goes through the HR routes; the DATABASE records the
 * time (server clock), the canonical identity, punctuality and review exceptions. A normal day needs no approval;
 * exceptions and corrections are reviewed by someone else; overtime is a separate request with its own approval.
 */

interface Exception { id: string; code: string; status: string; resolution: string | null; work_date?: string }
interface Entry {
  id: string; work_date: string; clock_in_at: string; clock_out_at: string | null; worked_minutes: number | null
  attendance_flag: string | null; source: string; review_state: string; break_minutes: number
  exceptions: Exception[]; pending_correction: boolean
}
interface Correction { id: string; kind: string; status: string; work_date: string; reason: string; review_comment: string | null; created_at: string }
interface Shift { id: string; name: string; start_time: string; end_time: string }
interface Overview {
  timezone: string; today: string; open_entry: Entry | null; entries: Entry[]; day_exceptions: Exception[]
  corrections: Correction[]; shifts: Shift[]
}
interface OtRequest {
  id: string; request_date: string; ot_minutes: number; approved_minutes: number | null; status: string; request_kind: string
  reason: string; day_type: string; approver_comment: string | null; exceeds_policy_cap: boolean; exceeds_recorded_time: boolean
  employee_name?: string; can_decide?: boolean
}

const FLAG: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' }> = {
  ontime: { label: 'On time', variant: 'default' }, late: { label: 'Late', variant: 'destructive' },
  early_leave: { label: 'Early', variant: 'destructive' }, late_and_early: { label: 'Late + Early', variant: 'destructive' },
}
const STATUS_TONE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800', submitted: 'bg-amber-100 text-amber-800', approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700', cancelled: 'bg-gray-100 text-gray-600',
}
const Pill = ({ status }: { status: string }) => (
  <span className={cn('text-[10px] font-medium px-2 py-0.5 rounded-full', STATUS_TONE[status] ?? 'bg-gray-100 text-gray-700')}>{status}</span>
)
const field = 'w-full h-10 px-3 rounded-xl border border-border bg-background text-sm'

type Tab = 'today' | 'history' | 'overtime' | 'approvals'

export default function HrMobileAttendance() {
  const { toast } = useToast()
  const [data, setData] = useState<Overview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>('today')
  const [shift, setShift] = useState('none')
  const [ot, setOt] = useState<OtRequest[]>([])
  const [queue, setQueue] = useState<{ ot: OtRequest[]; corrections: any[]; exceptions: any[] }>({ ot: [], corrections: [], exceptions: [] })

  // correction form: for an entry, or a missing day
  const [corr, setCorr] = useState<{ entry: Entry | null; date: string; inT: string; outT: string; brk: string; reason: string } | null>(null)
  // overtime form
  const [otForm, setOtForm] = useState({ kind: 'post' as 'pre' | 'post', date: isoDay(), minutes: '60', start: '', end: '', reason: '', key: newIdempotencyKey() })

  const load = useCallback(async () => {
    const today = isoDay()
    const [me, mine, qOt, qCorr, qExc] = await Promise.all([
      apiGet<Overview>('/api/hr/attendance/me', { from: addDays(today, -31), to: today }),
      apiGet<OtRequest[]>('/api/hr/attendance/overtime/requests', { scope: 'mine' }),
      apiGet<OtRequest[]>('/api/hr/attendance/overtime/requests', { scope: 'queue', status: 'submitted' }),
      apiGet<any[]>('/api/hr/attendance/corrections', { status: 'pending' }),
      apiGet<any[]>('/api/hr/attendance/exceptions', { status: 'open', from: addDays(today, -31), to: today }),
    ])
    if (me.ok) { setData(me.data); setLoadError(null) } else setLoadError(me.error)
    if (mine.ok) setOt(mine.data)
    setQueue({
      ot: qOt.ok ? qOt.data.filter((r) => r.can_decide) : [],
      corrections: qCorr.ok ? qCorr.data.filter((c: any) => c.can_decide) : [],
      exceptions: qExc.ok ? qExc.data.filter((x: any) => x.can_resolve) : [],
    })
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const open = data?.open_entry ?? null
  const todayEntries = useMemo(() => (data?.entries ?? []).filter((e) => e.work_date === data?.today), [data])
  const todayMinutes = todayEntries.reduce((s, e) => s + (e.worked_minutes ?? (e.clock_out_at ? 0 : Math.max(0, Math.round((Date.now() - Date.parse(e.clock_in_at)) / 60000)))), 0)
  const approvalsCount = queue.ot.length + queue.corrections.length + queue.exceptions.length

  async function handleClock() {
    setBusy(true)
    const res = await apiPost<{ status: string; attendance_flag?: string }>('/api/hr/attendance/clock', {
      action: open ? 'clock_out' : 'clock_in', shift_id: open ? null : (shift === 'none' ? null : shift), source: 'mobile',
      client_at: new Date().toISOString(),
    })
    setBusy(false)
    if (!res.ok) { toast({ title: 'Not recorded', description: res.error, variant: 'destructive' }); return }
    toast({ title: res.data.status === 'clocked_in' ? '✅ Clocked in' : '✅ Clocked out', description: 'Recorded with the server time.' })
    await load()
  }

  async function submitCorrection() {
    if (!corr) return
    const body = corr.entry
      ? { action: 'request', entry_id: corr.entry.id, clock_in: corr.inT || null, clock_out: corr.outT || null, break_minutes: corr.brk === '' ? null : Number(corr.brk), reason: corr.reason }
      : { action: 'request', work_date: corr.date, clock_in: corr.inT || null, clock_out: corr.outT || null, break_minutes: corr.brk === '' ? null : Number(corr.brk), reason: corr.reason }
    setBusy(true)
    const res = await apiPost('/api/hr/attendance/corrections', body)
    setBusy(false)
    if (!res.ok) { toast({ title: 'Correction not submitted', description: res.error, variant: 'destructive' }); return }
    toast({ title: '✅ Correction requested', description: 'HR or your manager will review it. Your original record is kept.' })
    setCorr(null)
    await load()
  }

  async function submitOt() {
    setBusy(true)
    const res = await apiPost<{ status: string; exceeds_policy_cap?: boolean; exceeds_recorded_time?: boolean }>('/api/hr/attendance/overtime/requests', {
      action: 'submit', kind: otForm.kind, request_date: otForm.date, ot_minutes: Number(otForm.minutes), reason: otForm.reason,
      planned_start: otForm.kind === 'pre' ? otForm.start || null : null, planned_end: otForm.kind === 'pre' ? otForm.end || null : null,
      idempotency_key: otForm.key,
    })
    setBusy(false)
    if (!res.ok) { toast({ title: 'Overtime not submitted', description: res.error, variant: 'destructive' }); return }
    const flags = [res.data.exceeds_policy_cap && 'above the daily policy cap', res.data.exceeds_recorded_time && 'more than your recorded time'].filter(Boolean)
    toast({ title: '✅ Overtime submitted for approval', description: flags.length ? `Flagged for the approver: ${flags.join(', ')}.` : undefined })
    setOtForm({ kind: 'post', date: isoDay(), minutes: '60', start: '', end: '', reason: '', key: newIdempotencyKey() })
    await load()
  }

  async function cancelOt(id: string) {
    const res = await apiPost('/api/hr/attendance/overtime/requests', { action: 'cancel', id })
    if (!res.ok) { toast({ title: 'Not cancelled', description: res.error, variant: 'destructive' }); return }
    toast({ title: 'Overtime request cancelled' })
    await load()
  }

  async function decide(kind: 'ot' | 'correction' | 'exception', id: string, approve: boolean) {
    const comment = approve ? null : window.prompt('Reason (required)')?.trim() || ''
    if (!approve && !comment) return
    const res = kind === 'ot'
      ? await apiPost('/api/hr/attendance/overtime/requests', { action: approve ? 'approve' : 'reject', id, comment })
      : kind === 'correction'
        ? await apiPost(`/api/hr/attendance/corrections/${id}/review`, { action: approve ? 'approved' : 'rejected', comment })
        : await apiPost('/api/hr/attendance/exceptions', { action: 'resolve', id, resolution: approve ? 'acknowledged' : 'dismissed', note: comment })
    if (!res.ok) { toast({ title: 'Decision not saved', description: res.error, variant: 'destructive' }); return }
    toast({ title: approve ? '✅ Approved' : 'Decision saved' })
    await load()
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="h-6 w-6 animate-spin text-blue-600" /></div>
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'today', label: 'Today' }, { key: 'history', label: 'History' }, { key: 'overtime', label: 'Overtime' },
    ...(approvalsCount > 0 ? [{ key: 'approvals' as Tab, label: `Approvals (${approvalsCount})` }] : []),
  ]

  return (
    <div className="px-4 pt-6 space-y-4">
      <h1 className="text-xl font-bold text-foreground">Attendance</h1>
      {loadError && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</div>}

      <div className="flex gap-1 bg-accent/50 rounded-xl p-1">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} aria-pressed={tab === t.key}
            className={cn('min-h-11 flex-1 py-2 px-2 rounded-lg text-xs font-medium', tab === t.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'today' && (
        <>
          <div className="flex flex-col items-center py-4">
            <button onClick={handleClock} disabled={busy || !data}
              className={cn('h-36 w-36 rounded-full flex flex-col items-center justify-center gap-2 shadow-xl transition-all active:scale-95 border-4 text-white',
                open ? 'bg-red-500 border-red-300 hover:bg-red-600' : 'bg-blue-600 border-blue-300 hover:bg-blue-700')}>
              {busy ? <Loader2 className="h-10 w-10 animate-spin" /> : open
                ? (<><LogOut className="h-10 w-10" /><span className="text-sm font-bold">CLOCK OUT</span></>)
                : (<><LogIn className="h-10 w-10" /><span className="text-sm font-bold">CLOCK IN</span></>)}
            </button>
            <p className="text-xs text-muted-foreground mt-3">
              {open ? `Clocked in at ${timeOf(open.clock_in_at, data?.timezone)}` : 'Time is recorded by the server.'}
            </p>
          </div>

          {(data?.shifts.length ?? 0) > 0 && !open && (
            <div className="bg-card rounded-2xl border border-border p-4">
              <p className="text-sm font-medium mb-2">Shift</p>
              <div className="flex flex-wrap gap-2">
                {[{ id: 'none', name: 'No shift', start_time: '', end_time: '' }, ...(data?.shifts ?? [])].map((s) => (
                  <button key={s.id} onClick={() => setShift(s.id)}
                    className={cn('px-3 py-1.5 rounded-full text-xs font-medium border', shift === s.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-accent border-border')}>
                    {s.name}{s.start_time ? ` (${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)})` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="bg-card rounded-2xl border border-border p-4 grid grid-cols-3 gap-3 text-center">
            <div><p className="text-xs text-muted-foreground">First in</p><p className="text-sm font-bold mt-1">{todayEntries.length ? timeOf(todayEntries[todayEntries.length - 1].clock_in_at, data?.timezone) : '--:--'}</p></div>
            <div><p className="text-xs text-muted-foreground">Last out</p><p className="text-sm font-bold mt-1">{todayEntries[0]?.clock_out_at ? timeOf(todayEntries[0].clock_out_at, data?.timezone) : '--:--'}</p></div>
            <div><p className="text-xs text-muted-foreground">Worked</p><p className="text-sm font-bold mt-1">{todayEntries.length ? formatMinutes(todayMinutes) : '--'}</p></div>
          </div>

          <button onClick={() => setCorr({ entry: null, date: addDays(isoDay(), -1), inT: '09:00', outT: '18:00', brk: '60', reason: '' })}
            className="w-full flex items-center gap-2 px-4 py-3 rounded-xl border border-border bg-card text-sm text-muted-foreground hover:text-foreground">
            <Edit3 className="h-4 w-4" /><span>Forgot to clock? Report a missing day</span><ChevronRight className="h-4 w-4 ml-auto" />
          </button>
        </>
      )}

      {corr && (
        <div className="bg-card rounded-2xl border border-blue-200 p-4 space-y-3" data-testid="correction-form">
          <p className="text-sm font-semibold">{corr.entry ? `Correct ${dateLabel(corr.entry.work_date)}` : 'Report a missing day'}</p>
          {!corr.entry && <input type="date" className={field} value={corr.date} max={isoDay()} onChange={(e) => setCorr({ ...corr, date: e.target.value })} aria-label="Date" />}
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs">In<input type="time" className={field} value={corr.inT} onChange={(e) => setCorr({ ...corr, inT: e.target.value })} /></label>
            <label className="text-xs">Out<input type="time" className={field} value={corr.outT} onChange={(e) => setCorr({ ...corr, outT: e.target.value })} /></label>
            <label className="text-xs">Break (min)<input type="number" min={0} max={600} className={field} value={corr.brk} onChange={(e) => setCorr({ ...corr, brk: e.target.value })} /></label>
          </div>
          <textarea className="w-full min-h-[70px] p-3 rounded-xl border border-border bg-background text-sm" placeholder="Reason (required, e.g. phone battery died)"
            value={corr.reason} onChange={(e) => setCorr({ ...corr, reason: e.target.value })} />
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setCorr(null)}>Cancel</Button>
            <Button className="flex-1" disabled={busy || corr.reason.trim().length < 5} onClick={submitCorrection}>Submit for review</Button>
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="space-y-2">
          {(data?.day_exceptions ?? []).filter((x) => x.status === 'open').map((x) => (
            <div key={x.id} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <span className="flex-1">{dateLabel(x.work_date!)} · {EXCEPTION_LABELS[x.code] ?? x.code}</span>
              <Button size="sm" variant="outline" onClick={() => setCorr({ entry: null, date: x.work_date!, inT: '09:00', outT: '18:00', brk: '60', reason: '' })}>Correct</Button>
            </div>
          ))}
          {(data?.entries ?? []).length === 0 && <p className="text-sm text-muted-foreground text-center py-6">No attendance in the last 31 days.</p>}
          {(data?.entries ?? []).map((e) => (
            <div key={e.id} className="bg-card rounded-xl border border-border p-3">
              <div className="flex items-center gap-2">
                {e.clock_out_at ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Timer className="h-4 w-4 text-blue-600" />}
                <span className="text-sm font-medium flex-1">{dateLabel(e.work_date)} · {timeOf(e.clock_in_at, data?.timezone)}–{e.clock_out_at ? timeOf(e.clock_out_at, data?.timezone) : '…'}</span>
                {e.attendance_flag && FLAG[e.attendance_flag] && <Badge variant={FLAG[e.attendance_flag].variant} className="text-[10px]">{FLAG[e.attendance_flag].label}</Badge>}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                {formatMinutes(e.worked_minutes)} · {SOURCE_LABELS[e.source] ?? e.source}
                {e.review_state === 'pending' && ' · under review'}{e.pending_correction && ' · correction pending'}
              </p>
              {e.exceptions.filter((x) => x.status !== 'cleared').map((x) => (
                <p key={x.id} className="text-[11px] mt-1"><Clock className="inline h-3 w-3 mr-1" />{EXCEPTION_LABELS[x.code] ?? x.code} — {x.status === 'open' ? 'open' : x.resolution}</p>
              ))}
              {!e.pending_correction && (
                <button className="text-[11px] text-blue-600 mt-1" onClick={() => setCorr({ entry: e, date: e.work_date, inT: '', outT: '', brk: '', reason: '' })}>Request correction</button>
              )}
            </div>
          ))}
          {(data?.corrections ?? []).length > 0 && <h3 className="text-sm font-semibold pt-2">My correction requests</h3>}
          {(data?.corrections ?? []).map((c) => (
            <div key={c.id} className="bg-card rounded-xl border border-border p-3 text-xs flex items-center gap-2">
              <span className="flex-1">{dateLabel(c.work_date)} · {c.kind === 'missing_day' ? 'Missing day' : 'Correction'} — {c.reason}{c.review_comment ? ` (${c.review_comment})` : ''}</span>
              <Pill status={c.status} />
              {c.status === 'pending' && (
                <button className="text-blue-600" onClick={async () => {
                  const r = await apiPost('/api/hr/attendance/corrections', { action: 'cancel', id: c.id })
                  if (!r.ok) toast({ title: 'Not withdrawn', description: r.error, variant: 'destructive' }); else await load()
                }}>Withdraw</button>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'overtime' && (
        <div className="space-y-3">
          <div className="bg-card rounded-2xl border border-border p-4 space-y-3" data-testid="ot-form">
            <div className="flex gap-2">
              {(['post', 'pre'] as const).map((k) => (
                <button key={k} onClick={() => setOtForm({ ...otForm, kind: k })}
                  className={cn('flex-1 py-2 rounded-lg text-xs border', otForm.kind === k ? 'bg-blue-600 text-white border-blue-600' : 'border-border')}>
                  {k === 'post' ? 'Already worked' : 'Plan ahead (pre-approval)'}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs">Date<input type="date" className={field} value={otForm.date} onChange={(e) => setOtForm({ ...otForm, date: e.target.value })} /></label>
              <label className="text-xs">Minutes<input type="number" min={15} max={720} step={15} className={field} value={otForm.minutes} onChange={(e) => setOtForm({ ...otForm, minutes: e.target.value })} /></label>
            </div>
            {otForm.kind === 'pre' && (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs">From<input type="time" className={field} value={otForm.start} onChange={(e) => setOtForm({ ...otForm, start: e.target.value })} /></label>
                <label className="text-xs">To<input type="time" className={field} value={otForm.end} onChange={(e) => setOtForm({ ...otForm, end: e.target.value })} /></label>
              </div>
            )}
            <textarea className="w-full min-h-[60px] p-3 rounded-xl border border-border bg-background text-sm" placeholder="Reason (required)"
              value={otForm.reason} onChange={(e) => setOtForm({ ...otForm, reason: e.target.value })} />
            <Button className="w-full" disabled={busy || otForm.reason.trim().length < 5} onClick={submitOt}>Submit overtime for approval</Button>
            <p className="text-[11px] text-muted-foreground">Overtime is approved separately from attendance. You cannot approve your own request.</p>
          </div>
          {ot.map((r) => (
            <div key={r.id} className="bg-card rounded-xl border border-border p-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-medium flex-1">{dateLabel(r.request_date)} · {formatMinutes(r.ot_minutes)}{r.approved_minutes !== null && r.approved_minutes !== r.ot_minutes ? ` (approved ${formatMinutes(r.approved_minutes)})` : ''}</span>
                <Pill status={r.status} />
              </div>
              <p className="text-muted-foreground mt-1">{r.request_kind === 'pre' ? 'Pre-approval' : 'Worked'} · {r.day_type.replace('_', ' ')} · {r.reason}{r.approver_comment ? ` — ${r.approver_comment}` : ''}</p>
              {(r.status === 'submitted' || r.status === 'draft') && <button className="text-blue-600 mt-1" onClick={() => cancelOt(r.id)}>Cancel request</button>}
            </div>
          ))}
        </div>
      )}

      {tab === 'approvals' && (
        <div className="space-y-2" data-testid="approvals">
          {queue.ot.map((r) => (
            <div key={r.id} className="bg-card rounded-xl border border-border p-3 text-xs space-y-2">
              <p><b>{r.employee_name}</b> · overtime {dateLabel(r.request_date)} · {formatMinutes(r.ot_minutes)} · {r.reason}</p>
              {(r.exceeds_policy_cap || r.exceeds_recorded_time) && <p className="text-amber-700">{[r.exceeds_policy_cap && 'Above policy cap', r.exceeds_recorded_time && 'More than recorded time'].filter(Boolean).join(' · ')}</p>}
              <div className="flex gap-2"><Button size="sm" className="flex-1" onClick={() => decide('ot', r.id, true)}>Approve</Button><Button size="sm" variant="outline" className="flex-1" onClick={() => decide('ot', r.id, false)}>Reject</Button></div>
            </div>
          ))}
          {queue.corrections.map((c) => (
            <div key={c.id} className="bg-card rounded-xl border border-border p-3 text-xs space-y-2">
              <p><b>{c.name}</b> · correction {dateLabel(c.work_date)} · {timeOf(c.corrected_clock_in)}–{timeOf(c.corrected_clock_out)} · {c.reason}</p>
              <div className="flex gap-2"><Button size="sm" className="flex-1" onClick={() => decide('correction', c.id, true)}>Approve</Button><Button size="sm" variant="outline" className="flex-1" onClick={() => decide('correction', c.id, false)}>Reject</Button></div>
            </div>
          ))}
          {queue.exceptions.map((x) => (
            <div key={x.id} className="bg-card rounded-xl border border-border p-3 text-xs space-y-2">
              <p><b>{x.name}</b> · {dateLabel(x.work_date)} · {EXCEPTION_LABELS[x.code] ?? x.code}</p>
              <div className="flex gap-2"><Button size="sm" className="flex-1" onClick={() => decide('exception', x.id, true)}>Acknowledge</Button><Button size="sm" variant="outline" className="flex-1" onClick={() => decide('exception', x.id, false)}>Dismiss</Button></div>
            </div>
          ))}
        </div>
      )}
      <div className="h-4" />
    </div>
  )
}
