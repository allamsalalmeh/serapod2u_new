'use client'

import { useState, useEffect } from 'react'
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

/* ─── Types ───────────────────────────────────────────────────────── */

interface LeaveType {
  id: string
  name: string
  code: string
  max_days_per_year: number | null
}

interface LeaveBalance {
  id: string
  leave_type_id: string
  entitled: number
  taken: number
  pending: number
  carried_forward: number
  leave_type_name?: string
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
  const [formReason, setFormReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

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
          .eq('is_active', true),
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
        isManager
          ? supabase
              .from('hr_leave_requests')
              .select(
                '*, hr_leave_types(name), users!hr_leave_requests_employee_id_fkey(full_name)',
              )
              .eq('organization_id', organizationId)
              .eq('status', 'pending')
              .order('created_at', { ascending: false })
              .limit(20)
          : Promise.resolve({ data: [] as any[] }),
      ])

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
    } finally {
      setLoading(false)
    }
  }

  /* ── Submit leave request ───────────────────────────────────── */

  async function handleSubmit() {
    if (!formType || !formStart || !formEnd) {
      toast({
        title: 'Required',
        description: 'Please select leave type and dates',
        variant: 'destructive',
      })
      return
    }

    setSubmitting(true)
    try {
      const startDate = new Date(formStart)
      const endDate = new Date(formEnd)
      const diffDays = formHalfDay
        ? 0.5
        : Math.ceil(
            (endDate.getTime() - startDate.getTime()) / 86_400_000,
          ) + 1

      const { error } = await supabase.from('hr_leave_requests').insert({
        employee_id: userProfile.id,
        organization_id: organizationId,
        leave_type_id: formType,
        start_date: formStart,
        end_date: formEnd,
        total_days: diffDays,
        is_half_day: formHalfDay,
        reason: formReason || null,
        status: 'pending',
      })

      if (error) throw error

      toast({
        title: '✅ Leave Applied',
        description: 'Your request has been submitted for approval',
      })
      setFormType('')
      setFormStart('')
      setFormEnd('')
      setFormHalfDay(false)
      setFormReason('')
      setActiveTab('requests')
      await loadData()
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to submit leave request',
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
      const { error } = await supabase
        .from('hr_leave_requests')
        .update({
          status: action,
          approved_by: userProfile.id,
          approved_at: new Date().toISOString(),
        })
        .eq('id', requestId)

      if (error) throw error
      toast({
        title: action === 'approved' ? '✅ Approved' : '❌ Rejected',
      })
      await loadData()
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message,
        variant: 'destructive',
      })
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
              const remaining =
                b.entitled - b.taken - b.pending
              const percent =
                b.entitled > 0
                  ? ((b.taken + b.pending) / b.entitled) * 100
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
              onChange={(e) => setFormHalfDay(e.target.checked)}
              className="h-5 w-5 rounded border-border"
            />
            <span className="text-sm text-foreground">Half-day leave</span>
          </label>

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

          <Button
            onClick={handleSubmit}
            disabled={submitting}
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
