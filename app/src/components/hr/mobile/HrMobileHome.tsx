'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useHrMobile } from './HrMobileContext'
import HrInstallPrompt from './HrInstallPrompt'
import { createClient } from '@/lib/supabase/client'
import {
  Clock,
  CalendarPlus,
  FileText,
  ClipboardList,
  LogIn,
  LogOut,
  Sun,
  Sunset,
  Moon,
  ChevronRight,
  AlertCircle,
  Timer,
  ListTree,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/* ─── Greeting helper ─────────────────────────────────────────────── */

function getGreeting(): { text: string; icon: typeof Sun } {
  const h = new Date().getHours()
  if (h < 12) return { text: 'Good Morning', icon: Sun }
  if (h < 17) return { text: 'Good Afternoon', icon: Sunset }
  return { text: 'Good Evening', icon: Moon }
}

/* ─── Quick action card ───────────────────────────────────────────── */

function QuickAction({
  icon: Icon,
  label,
  sublabel,
  color,
  onClick,
}: {
  icon: any
  label: string
  sublabel: string
  color: string
  onClick: () => void
}) {
  const bg: Record<string, string> = {
    blue: 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800',
    green: 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-800',
    purple: 'bg-purple-50 dark:bg-purple-950/40 border-purple-200 dark:border-purple-800',
    orange: 'bg-orange-50 dark:bg-orange-950/40 border-orange-200 dark:border-orange-800',
  }
  const fg: Record<string, string> = {
    blue: 'text-blue-600 dark:text-blue-400',
    green: 'text-green-600 dark:text-green-400',
    purple: 'text-purple-600 dark:text-purple-400',
    orange: 'text-orange-600 dark:text-orange-400',
  }
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-col items-center justify-center gap-2 p-4 rounded-2xl border transition-all active:scale-[0.97]',
        bg[color],
      )}
    >
      <Icon className={cn('h-7 w-7', fg[color])} />
      <div className="text-center">
        <p className="text-sm font-semibold text-foreground">{label}</p>
        <p className="text-[10px] text-muted-foreground">{sublabel}</p>
      </div>
    </button>
  )
}

/* ─── Main component ──────────────────────────────────────────────── */

export default function HrMobileHome() {
  const router = useRouter()
  const { userProfile, isManager, isAdmin, canViewOrgChart, organizationId } = useHrMobile()
  const greeting = useMemo(() => getGreeting(), [])
  const supabase = createClient()

  const [attendanceStatus, setAttendanceStatus] = useState<
    'clocked-in' | 'clocked-out' | 'loading'
  >('loading')
  const [clockInTime, setClockInTime] = useState<string | null>(null)
  const [leaveBalances, setLeaveBalances] = useState<
    { type: string; balance: number; entitled: number }[]
  >([])
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [loading, setLoading] = useState(true)

  /* ── Fetch dashboard data ─────────────────────────────────────── */

  useEffect(() => {
    loadDashboardData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadDashboardData() {
    try {
      const today = new Date().toISOString().split('T')[0]

      // 1. Today's attendance
      const { data: entries } = await supabase
        .from('hr_attendance_entries')
        .select('id, clock_in_at, clock_out_at')
        .eq('user_id', userProfile.id)
        .gte('clock_in_at', today + 'T00:00:00')
        .order('clock_in_at', { ascending: false })
        .limit(1)

      if (entries && entries.length > 0) {
        const latest = entries[0]
        if (!latest.clock_out_at) {
          setAttendanceStatus('clocked-in')
          setClockInTime(
            new Date(latest.clock_in_at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            }),
          )
        } else {
          setAttendanceStatus('clocked-out')
        }
      } else {
        setAttendanceStatus('clocked-out')
      }

      // 2. Leave balances (top 4 types)
      const { data: balances } = await supabase
        .from('hr_leave_balances')
        .select('entitled, taken, pending, hr_leave_types(name)')
        .eq('employee_id', userProfile.id)
        .eq('year', new Date().getFullYear())
        .limit(4)

      if (balances) {
        setLeaveBalances(
          balances.map((b: any) => ({
            type: b.hr_leave_types?.name || 'Leave',
            balance:
              (b.entitled || 0) -
              (b.taken || 0) -
              (b.pending || 0),
            entitled: b.entitled || 0,
          })),
        )
      }

      // 3. Pending approvals (managers only)
      if (isManager) {
        const { count } = await supabase
          .from('hr_leave_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending')
          .eq('organization_id', organizationId)
        setPendingApprovals(count || 0)
      }
    } catch (err) {
      console.error('Error loading HR dashboard:', err)
    } finally {
      setLoading(false)
    }
  }

  /* ── Render ───────────────────────────────────────────────────── */

  const GreetingIcon = greeting.icon
  const firstName = userProfile.full_name?.split(' ')[0] || 'there'

  return (
    <div className="px-4 pt-6 space-y-5">
      {/* ── Greeting ───────────────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <GreetingIcon className="h-5 w-5 text-amber-500" />
          <span className="text-sm text-muted-foreground">{greeting.text}</span>
        </div>
        <h1 className="text-2xl font-bold text-foreground">{firstName} 👋</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          {userProfile.organizations?.org_name}
        </p>
      </div>

      {/* ── Install CTA ────────────────────────────────────────── */}
      <HrInstallPrompt />

      {/* ── Quick Actions ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <QuickAction
          icon={attendanceStatus === 'clocked-in' ? LogOut : LogIn}
          label={attendanceStatus === 'clocked-in' ? 'Clock Out' : 'Clock In'}
          sublabel={
            attendanceStatus === 'clocked-in'
              ? `Since ${clockInTime}`
              : 'Start your day'
          }
          color="blue"
          onClick={() => router.push('/hr/mobile/attendance')}
        />
        <QuickAction
          icon={CalendarPlus}
          label="Apply Leave"
          sublabel="Request time off"
          color="green"
          onClick={() => router.push('/hr/mobile/leave')}
        />
        <QuickAction
          icon={FileText}
          label="My Payslip"
          sublabel="View salary"
          color="purple"
          onClick={() => router.push('/hr/mobile/payslip')}
        />
        <QuickAction
          icon={ClipboardList}
          label="My Timesheet"
          sublabel="Work hours"
          color="orange"
          onClick={() => router.push('/hr/mobile/attendance')}
        />
      </div>

      {/* ── Today Attendance Card ──────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">
            Today&apos;s Attendance
          </h3>
          <button
            onClick={() => router.push('/hr/mobile/attendance')}
            className="min-h-11 px-2 text-xs font-medium text-blue-600"
          >
            View All
          </button>
        </div>

        {loading ? (
          <div className="h-12 flex items-center justify-center">
            <div className="h-5 w-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'h-10 w-10 rounded-full flex items-center justify-center',
                attendanceStatus === 'clocked-in'
                  ? 'bg-green-100 dark:bg-green-900/30'
                  : 'bg-gray-100 dark:bg-gray-800',
              )}
            >
              {attendanceStatus === 'clocked-in' ? (
                <Timer className="h-5 w-5 text-green-600" />
              ) : (
                <Clock className="h-5 w-5 text-gray-500" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                {attendanceStatus === 'clocked-in'
                  ? 'Clocked In'
                  : 'Not Clocked In'}
              </p>
              <p className="text-xs text-muted-foreground">
                {attendanceStatus === 'clocked-in'
                  ? `Since ${clockInTime}`
                  : 'Tap to clock in'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Leave Balance Summary ──────────────────────────────── */}
      {leaveBalances.length > 0 && (
        <div className="bg-card rounded-2xl border border-border p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">
              Leave Balance
            </h3>
            <button
              onClick={() => router.push('/hr/mobile/leave')}
              className="min-h-11 px-2 text-xs font-medium text-blue-600"
            >
              View All
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {leaveBalances.map((b, i) => (
              <div key={i} className="bg-accent/50 rounded-xl px-3 py-2.5">
                <p className="text-xs text-muted-foreground truncate">
                  {b.type}
                </p>
                <p className="text-lg font-bold text-foreground">{b.balance}</p>
                <p className="text-[10px] text-muted-foreground">
                  of {b.entitled} days
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Pending Approvals (manager only) ───────────────────── */}
      {isManager && pendingApprovals > 0 && (
        <button
          onClick={() => router.push('/hr/mobile/leave')}
          className="w-full bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 flex items-center gap-3"
        >
          <div className="h-10 w-10 rounded-full bg-amber-100 dark:bg-amber-900/50 flex items-center justify-center">
            <AlertCircle className="h-5 w-5 text-amber-600" />
          </div>
          <div className="flex-1 text-left">
            <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
              {pendingApprovals} Pending Approval
              {pendingApprovals > 1 ? 's' : ''}
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Tap to review leave requests
            </p>
          </div>
          <ChevronRight className="h-5 w-5 text-amber-400" />
        </button>
      )}

      {/* ── Organization chart (read-only staff view) ───────────── */}
      {canViewOrgChart && (
        <button
          onClick={() => router.push('/hr/people/org-chart')}
          className="flex min-h-11 w-full items-center gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-accent/50"
        >
          <ListTree className="h-5 w-5 shrink-0 text-blue-600" aria-hidden />
          <span className="flex-1 text-sm font-medium text-foreground">Organization Chart</span>
          <ChevronRight className="h-5 w-5 text-muted-foreground" aria-hidden />
        </button>
      )}

      {/* ── Admin shortcut ─────────────────────────────────────── */}
      {isAdmin && (
        <button
          onClick={() => router.push('/hr')}
          className="min-h-11 w-full py-2 text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          Switch to Admin View →
        </button>
      )}

      {/* spacer for bottom nav */}
      <div className="h-4" />
    </div>
  )
}
