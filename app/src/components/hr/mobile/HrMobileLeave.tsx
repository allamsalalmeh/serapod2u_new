'use client'

import { useState, useEffect, useRef } from 'react'
import { useHrMobile } from './HrMobileContext'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import {
  CalendarDays,
  Plus,
  Clock,
  CheckCircle2,
  XCircle,
  FileText,
  Loader2,
  User,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { leaveErrorMessage } from '@/modules/hr/leave/leaveErrors'
import { assertDecisionStored, buildMobileLeaveRequest, type HalfDayPeriod } from '@/modules/hr/leave/mobileLeave'

/* ─── Types ───────────────────────────────────────────────────────── */

interface LeaveType {
  id: string
  name: string
  code: string
  max_consecutive_days: number | null
}

interface LeaveBalance {
  id: string
  leave_type_id: string
  entitled: number
  taken: number
  pending: number
  carried_forward: number
  adjustment?: number
  leave_type_name?: string
}

/** Server quote (Wave 3 leave ledger): working days by the database calendar, balance after, warnings, blocking errors. */
interface LeaveQuote {
  working_days: number
  warnings: string[]
  errors: string[]
  non_working_dates: { date: string; day_type: string }[]
  per_year: { year: number; days: number; available_after: number; balance: { has_entitlement: boolean; available: number } }[]
}

interface LeaveRequest {
  id: string
  leave_type_id: string
  start_date: string
  end_date: string
  total_days: number
  status: string
  reason: string | null
  is_half_day: boolean
  created_at: string
  leave_type_name?: string
  user_name?: string
  employee_id?: string
}

const STATUS_COLORS: Record<string, string> = {
  pending:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  approved:
    'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  rejected: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  cancelled:
    'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  draft: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function HrMobileLeave() {
  const { userProfile, isManager, organizationId } = useHrMobile()
  const supabase = createClient()
  const { toast } = useToast()

  const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([])
  const [balances, setBalances] = useState<LeaveBalance[]>([])
  const [myRequests, setMyRequests] = useState<LeaveRequest[]>([])
  const [teamRequests, setTeamRequests] = useState<LeaveRequest[]>([])
  const [loading, setLoading] = useState(true)

  const [activeTab, setActiveTab] = useState<
    'balance' | 'requests' | 'apply' | 'approvals'
  >('balance')

  // Apply form state
  const [formType, setFormType] = useState('')
  const [formStart, setFormStart] = useState('')
  const [formEnd, setFormEnd] = useState('')
  const [formHalfDay, setFormHalfDay] = useState(false)
  const [formHalfDayPeriod, setFormHalfDayPeriod] = useState<HalfDayPeriod | ''>('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formReason, setFormReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [quote, setQuote] = useState<LeaveQuote | null>(null)
  const quoteSeq = useRef(0)

  /* ── Server quote (working days, balance) — informational; the database decides on submission ── */
  useEffect(() => {
    const halfOk = !formHalfDay || (formStart && formStart === formEnd)
    if (!formType || !formStart || !formEnd || formEnd < formStart || !halfOk) { setQuote(null); return }
    const seq = ++quoteSeq.current
    const params = new URLSearchParams({ leave_type_id: formType, start_date: formStart, end_date: formEnd, ...(formHalfDay ? { half_day: '1' } : {}) })
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/hr/leave/quote?${params.toString()}`)
        const json = await res.json().catch(() => null)
        if (seq !== quoteSeq.current) return
        setQuote(res.ok && json?.success ? (json.data as LeaveQuote) : null)
      } catch {
        if (seq === quoteSeq.current) setQuote(null)   // quote is optional (e.g. ledger not installed yet)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [formType, formStart, formEnd, formHalfDay])

  /* ── Load data ──────────────────────────────────────────────── */

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadData() {
    try {
      const year = new Date().getFullYear()

      const [typesRes, balancesRes, myRes, teamRes] = await Promise.all([
        supabase
          .from('hr_leave_types')
          .select('*')
          .eq('organization_id', organizationId)
          .eq('status', 'active'),
        supabase
          .from('hr_leave_balances')
          .select('*, hr_leave_types(name)')
          .eq('employee_id', userProfile.id)
          .eq('year', year),
        supabase
          .from('hr_leave_requests')
          .select('*, hr_leave_types(name)')
          .eq('employee_id', userProfile.id)
          .order('created_at', { ascending: false })
          .limit(20),
        // Row-level security (B2A) returns only requests this account may see: its direct reports when it holds
        // Manager Self-Service, the company when it is explicitly authorized HR. Own requests are listed separately.
        isManager
          ? supabase
              .from('hr_leave_requests')
              .select(
                '*, hr_leave_types(name), users!hr_leave_requests_employee_id_fkey(full_name)',
              )
              .eq('organization_id', organizationId)
              .eq('status', 'pending')
              .neq('employee_id', userProfile.id)
              .order('created_at', { ascending: false })
              .limit(20)
          : Promise.resolve({ data: [] as any[] }),
      ])

      // Surface read failures instead of showing an empty screen (a refused or failed read is not "no data").
      const failed = [typesRes, balancesRes, myRes, teamRes].find((r: any) => r && r.error) as any
      setLoadError(failed ? leaveErrorMessage(failed.error, 'Some leave information could not be loaded.') : null)
      if (typesRes.data) setLeaveTypes(typesRes.data)
      if (balancesRes.data) {
        setBalances(
          balancesRes.data.map((b: any) => ({
            ...b,
            leave_type_name: b.hr_leave_types?.name || 'Leave',
          })),
        )
      }
      if (myRes.data) {
        setMyRequests(
          myRes.data.map((r: any) => ({
            ...r,
            leave_type_name: r.hr_leave_types?.name || 'Leave',
          })),
        )
      }
      if (teamRes.data) {
        setTeamRequests(
          (teamRes.data as any[]).map((r: any) => ({
            ...r,
            leave_type_name: r.hr_leave_types?.name || 'Leave',
            user_name: r.users?.full_name || 'Employee',
          })),
        )
      }
    } catch (err) {
      console.error('Error loading leave data:', err)
      setLoadError(leaveErrorMessage(err, 'Leave information could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }

  /* ── Submit leave request ───────────────────────────────────── */

  async function handleSubmit() {
    const built = buildMobileLeaveRequest(
      {
        leaveTypeId: formType,
        startDate: formStart,
        endDate: formEnd,
        halfDay: formHalfDay,
        halfDayPeriod: formHalfDayPeriod,
        reason: formReason,
      },
      { employeeId: userProfile.id, organizationId },
    )
    if (!built.ok) {
      toast({ title: 'Required', description: built.message, variant: 'destructive' })
      return
    }

    setSubmitting(true)
    try {
      // The database refuses on-behalf, non-pending and non-onboarded submissions (B2A guard); the returned row
      // proves the request was stored before success is shown.
      const { data, error } = await supabase.from('hr_leave_requests').insert(built.row).select('id, status')

      if (error) throw error
      if (!data || data.length === 0 || data[0].status !== 'pending') {
        throw new Error('The leave request was not saved. Please refresh and try again.')
      }

      toast({
        title: '✅ Leave Applied',
        description: 'Your request has been submitted for approval',
      })
      setQuote(null)
      setFormType('')
      setFormStart('')
      setFormEnd('')
      setFormHalfDay(false)
      setFormHalfDayPeriod('')
      setFormReason('')
      setActiveTab('requests')
      await loadData()
    } catch (err: any) {
      toast({
        title: 'Leave not submitted',
        description: leaveErrorMessage(err, err?.message || 'Failed to submit leave request'),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  /* ── Approve / Reject ───────────────────────────────────────── */

  async function handleApproval(
    requestId: string,
    action: 'approved' | 'rejected',
  ) {
    try {
      // The database stamps the approver and time (B2A guard) and refuses self-approval; send only the decision.
      const { data, error } = await supabase
        .from('hr_leave_requests')
        .update({ status: action })
        .eq('id', requestId)
        .select('id, status')

      if (error) throw error
      assertDecisionStored(data, action)
      toast({
        title: action === 'approved' ? '✅ Approved' : '❌ Rejected',
      })
      await loadData()
    } catch (err: any) {
      toast({
        title: 'Decision not saved',
        description: leaveErrorMessage(err, err?.message || 'The decision could not be saved.'),
        variant: 'destructive',
      })
    }
  }

  /* ── Withdraw own undecided request ─────────────────────────── */

  const [withdrawing, setWithdrawing] = useState<string | null>(null)
  async function handleWithdraw(requestId: string) {
    setWithdrawing(requestId)
    try {
      // B2A SELF rule: the employee may cancel their own draft/pending request; approved leave is cancelled only by HR.
      const { data, error } = await supabase
        .from('hr_leave_requests')
        .update({ status: 'cancelled' })
        .eq('id', requestId)
        .eq('employee_id', userProfile.id)
        .select('id, status')
      if (error) throw error
      assertDecisionStored(data, 'cancelled')
      toast({ title: 'Request withdrawn', description: 'Your leave request was cancelled before a decision.' })
      await loadData()
    } catch (err: any) {
      toast({
        title: 'Request not withdrawn',
        description: leaveErrorMessage(err, err?.message || 'The request could not be withdrawn.'),
        variant: 'destructive',
      })
    } finally {
      setWithdrawing(null)
    }
  }

  /* ── Render ─────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  const tabs = [
    { key: 'balance' as const, label: 'Balance' },
    { key: 'requests' as const, label: 'Requests' },
    { key: 'apply' as const, label: 'Apply' },
    ...(isManager
      ? [
          {
            key: 'approvals' as const,
            label: `Approvals${teamRequests.length > 0 ? ` (${teamRequests.length})` : ''}`,
          },
        ]
      : []),
  ]

  return (
    <div className="px-4 pt-6 space-y-4">
      <h1 className="text-xl font-bold text-foreground">Leave</h1>

      {loadError && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {loadError}
        </div>
      )}

      {/* ── Tab bar ───────────────────────────────────────────── */}
      <div className="flex gap-1 bg-accent/50 rounded-xl p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            aria-pressed={activeTab === t.key}
            className={cn(
              'min-h-11 flex-1 py-2 px-2 rounded-lg text-xs font-medium transition-colors',
              activeTab === t.key
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Balance tab ───────────────────────────────────────── */}
      {activeTab === 'balance' && (
        <div className="space-y-3">
          {balances.length === 0 ? (
            <div className="text-center py-8">
              <CalendarDays className="h-10 w-10 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No leave balances found
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Contact HR to set up your leave entitlements
              </p>
            </div>
          ) : (
            balances.map((b) => {
              // entitled + carried forward + adjustment − taken − pending (the ledger projection's rule)
              const total = Number(b.entitled) + Number(b.carried_forward || 0) + Number(b.adjustment || 0)
              const remaining = total - Number(b.taken) - Number(b.pending)
              const percent =
                total > 0
                  ? ((Number(b.taken) + Number(b.pending)) / total) * 100
                  : 0
              return (
                <div
                  key={b.id}
                  className="bg-card rounded-2xl border border-border p-4"
                >
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      {b.leave_type_name}
                    </h3>
                    <span className="text-lg font-bold text-foreground">
                      {remaining}
                    </span>
                  </div>
                  <div className="h-2 bg-accent rounded-full overflow-hidden mb-2">
                    <div
                      className="h-full bg-blue-600 rounded-full transition-all"
                      style={{ width: `${Math.min(percent, 100)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>Entitled: {b.entitled}</span>
                    <span>Taken: {b.taken}</span>
                    <span>Pending: {b.pending}</span>
                    {b.carried_forward > 0 && (
                      <span>C/F: {b.carried_forward}</span>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}

      {/* ── Requests tab ──────────────────────────────────────── */}
      {activeTab === 'requests' && (
        <div className="space-y-2">
          {myRequests.length === 0 ? (
            <div className="text-center py-8">
              <FileText className="h-10 w-10 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                No leave requests yet
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => setActiveTab('apply')}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Apply Leave
              </Button>
            </div>
          ) : (
            myRequests.map((r) => (
              <div
                key={r.id}
                className="bg-card rounded-xl border border-border p-3"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-foreground">
                    {r.leave_type_name}
                  </span>
                  <span
                    className={cn(
                      'text-[10px] font-medium px-2 py-0.5 rounded-full',
                      STATUS_COLORS[r.status] || STATUS_COLORS.draft,
                    )}
                  >
                    {r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(r.start_date).toLocaleDateString('en-MY', {
                    day: 'numeric',
                    month: 'short',
                  })}
                  {r.start_date !== r.end_date &&
                    ` — ${new Date(r.end_date).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })}`}
                  {r.is_half_day && ' (Half day)'}
                  {' · '}
                  {r.total_days} day{r.total_days !== 1 ? 's' : ''}
                </p>
                {r.reason && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                    {r.reason}
                  </p>
                )}
                {(r.status === 'pending' || r.status === 'draft') && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 min-h-11 w-full"
                    disabled={withdrawing === r.id}
                    onClick={() => handleWithdraw(r.id)}
                  >
                    {withdrawing === r.id ? 'Withdrawing…' : 'Withdraw request'}
                  </Button>
                )}
                {r.status === 'approved' && (
                  <p className="mt-1 text-[11px] text-muted-foreground">Approved leave can only be cancelled by HR.</p>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Apply tab ─────────────────────────────────────────── */}
      {activeTab === 'apply' && (
        <div className="bg-card rounded-2xl border border-border p-4 space-y-4">
          {/* Leave type */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">
              Leave Type
            </label>
            <select
              value={formType}
              onChange={(e) => setFormType(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-border bg-background text-sm"
            >
              <option value="">Select type…</option>
              {leaveTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-foreground mb-1 block">
                Start Date
              </label>
              <input
                type="date"
                value={formStart}
                onChange={(e) => setFormStart(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-border bg-background text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-foreground mb-1 block">
                End Date
              </label>
              <input
                type="date"
                value={formEnd}
                onChange={(e) => setFormEnd(e.target.value)}
                min={formStart}
                className="w-full h-10 px-3 rounded-xl border border-border bg-background text-sm"
              />
            </div>
          </div>

          {/* Half day */}
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              checked={formHalfDay}
              onChange={(e) => {
                setFormHalfDay(e.target.checked)
                if (e.target.checked && formStart) setFormEnd(formStart)
                if (!e.target.checked) setFormHalfDayPeriod('')
              }}
              className="h-5 w-5 rounded border-border"
            />
            <span className="text-sm text-foreground">Half-day leave</span>
          </label>
          {formHalfDay && (
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Half-day period">
              {(['morning', 'afternoon'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={formHalfDayPeriod === p}
                  onClick={() => setFormHalfDayPeriod(p)}
                  className={cn(
                    'h-10 rounded-xl border text-sm',
                    formHalfDayPeriod === p
                      ? 'border-blue-600 bg-blue-50 text-blue-700 dark:bg-blue-900/30'
                      : 'border-border bg-background text-foreground',
                  )}
                >
                  {p === 'morning' ? 'Morning' : 'Afternoon'}
                </button>
              ))}
            </div>
          )}

          {/* Reason */}
          <div>
            <label className="text-xs font-medium text-foreground mb-1 block">
              Reason (optional)
            </label>
            <textarea
              value={formReason}
              onChange={(e) => setFormReason(e.target.value)}
              placeholder="Enter reason…"
              className="w-full min-h-[60px] p-3 rounded-xl border border-border bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {quote && (
            <div className="rounded-xl border border-border bg-accent/40 p-3 text-xs space-y-1" data-testid="leave-quote">
              <p className="font-medium text-foreground">
                {quote.working_days} working day{Number(quote.working_days) !== 1 ? 's' : ''}
                {quote.per_year.filter((y) => y.balance?.has_entitlement).map((y) => (
                  <span key={y.year} className="font-normal text-muted-foreground"> · {y.available_after} left in {y.year} after this</span>
                ))}
              </p>
              {quote.non_working_dates.length > 0 && (
                <p className="text-muted-foreground">
                  Not counted: {quote.non_working_dates.map((d) => `${d.date} (${d.day_type === 'public_holiday' ? 'public holiday' : 'rest day'})`).join(', ')}
                </p>
              )}
              {quote.warnings.map((w) => <p key={w} className="text-amber-700 dark:text-amber-300">{w}</p>)}
              {quote.errors.map((e) => <p key={e} role="alert" className="text-red-700 dark:text-red-300">{e}</p>)}
            </div>
          )}

          <Button
            onClick={handleSubmit}
            disabled={submitting || (quote?.errors?.length ?? 0) > 0}
            className="w-full"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Submit Leave Request
          </Button>
        </div>
      )}

      {/* ── Approvals tab (managers) ──────────────────────────── */}
      {activeTab === 'approvals' && isManager && (
        <div className="space-y-2">
          {teamRequests.length === 0 ? (
            <div className="text-center py-8">
              <CheckCircle2 className="h-10 w-10 text-green-400 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                All caught up! No pending approvals.
              </p>
            </div>
          ) : (
            teamRequests.map((r) => (
              <div
                key={r.id}
                className="bg-card rounded-xl border border-border p-4 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-full bg-accent flex items-center justify-center">
                    <User className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {r.user_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.leave_type_name}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(r.start_date).toLocaleDateString('en-MY', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                  {r.start_date !== r.end_date &&
                    ` — ${new Date(r.end_date).toLocaleDateString('en-MY', { day: 'numeric', month: 'short' })}`}
                  {' · '}
                  {r.total_days} day{r.total_days !== 1 ? 's' : ''}
                </p>
                {r.reason && (
                  <p className="text-xs text-muted-foreground italic">
                    &quot;{r.reason}&quot;
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 gap-1"
                    onClick={() => handleApproval(r.id, 'approved')}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="flex-1 gap-1"
                    onClick={() => handleApproval(r.id, 'rejected')}
                  >
                    <XCircle className="h-3.5 w-3.5" /> Reject
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      <div className="h-4" />
    </div>
  )
}
