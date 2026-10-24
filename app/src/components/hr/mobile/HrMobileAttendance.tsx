'use client'

import { useState, useEffect, useMemo } from 'react'
import { useHrMobile } from './HrMobileContext'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import {
  LogIn,
  LogOut,
  Clock,
  ChevronRight,
  Loader2,
  CheckCircle2,
  Timer,
  Edit3,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/* ─── Types ───────────────────────────────────────────────────────── */

interface AttendanceEntry {
  id: string
  clock_in_at: string
  clock_out_at: string | null
  attendance_flag: string | null
  shift_id: string | null
  /** Canonical stored duration in minutes (see hr_attendance_entries.worked_minutes). */
  worked_minutes: number | null
  note: string | null
}

interface AttendanceShift {
  id: string
  name: string
  start_time: string
  end_time: string
}

/* ─── Helpers ─────────────────────────────────────────────────────── */

function flagBadge(flag: string | null) {
  if (!flag) return null
  const m: Record<
    string,
    { label: string; variant: 'default' | 'secondary' | 'destructive' }
  > = {
    ontime: { label: 'On Time', variant: 'default' },
    late: { label: 'Late', variant: 'destructive' },
    early_leave: { label: 'Early', variant: 'destructive' },
    late_and_early: { label: 'Late + Early', variant: 'destructive' },
  }
  const item = m[flag] || { label: flag, variant: 'secondary' as const }
  return (
    <Badge variant={item.variant} className="text-[10px]">
      {item.label}
    </Badge>
  )
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function HrMobileAttendance() {
  const { userProfile, organizationId } = useHrMobile()
  const supabase = createClient()
  const { toast } = useToast()

  const [entries, setEntries] = useState<AttendanceEntry[]>([])
  const [shifts, setShifts] = useState<AttendanceShift[]>([])
  const [selectedShift, setSelectedShift] = useState<string>('none')
  const [loading, setLoading] = useState(true)
  const [clockLoading, setClockLoading] = useState(false)

  const [showCorrection, setShowCorrection] = useState(false)
  const [correctionReason, setCorrectionReason] = useState('')

  /* ── Load ────────────────────────────────────────────────────── */

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadData() {
    try {
      const [entriesRes, shiftsRes] = await Promise.all([
        supabase
          .from('hr_attendance_entries')
          .select('*')
          .eq('user_id', userProfile.id)
          .order('clock_in_at', { ascending: false })
          .limit(10),
        supabase
          .from('hr_shifts')
          .select('id, name, start_time, end_time')
          .eq('organization_id', organizationId)
          .eq('is_active', true),
      ])
      if (entriesRes.data) setEntries(entriesRes.data)
      if (shiftsRes.data) setShifts(shiftsRes.data)
    } catch (err) {
      console.error('Error loading attendance:', err)
    } finally {
      setLoading(false)
    }
  }

  /* ── Derived state ──────────────────────────────────────────── */

  const openEntry = useMemo(
    () => entries.find((e) => !e.clock_out_at) || null,
    [entries],
  )
  const isClockedIn = !!openEntry
  const recentEntries = useMemo(() => entries.slice(0, 5), [entries])

  const todayEntries = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]
    return entries.filter((e) => e.clock_in_at.startsWith(today))
  }, [entries])

  const todayTotalHours = useMemo(() => {
    return todayEntries.reduce((sum, e) => {
      if (e.worked_minutes) return sum + e.worked_minutes / 60
      const end = e.clock_out_at
        ? new Date(e.clock_out_at).getTime()
        : Date.now()
      return sum + (end - new Date(e.clock_in_at).getTime()) / 3_600_000
    }, 0)
  }, [todayEntries])

  /* ── Clock in / out ─────────────────────────────────────────── */

  async function handleClock() {
    setClockLoading(true)
    try {
      const now = new Date().toISOString()

      if (isClockedIn) {
        const { error } = await supabase
          .from('hr_attendance_entries')
          .update({ clock_out_at: now })
          .eq('id', openEntry!.id)
        if (error) throw error
        toast({
          title: '✅ Clocked Out',
          description: `Clocked out at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        })
      } else {
        const { error } = await supabase
          .from('hr_attendance_entries')
          .insert({
            user_id: userProfile.id,
            organization_id: organizationId,
            clock_in_at: now,
            shift_id: selectedShift !== 'none' ? selectedShift : null,
          })
        if (error) throw error
        toast({
          title: '✅ Clocked In',
          description: `Welcome! Clocked in at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
        })
      }
      await loadData()
    } catch (err: any) {
      toast({
        title: 'Error',
        description: err.message || 'Failed to clock',
        variant: 'destructive',
      })
    } finally {
      setClockLoading(false)
    }
  }

  /* ── Correction request ─────────────────────────────────────── */

  async function handleCorrectionRequest() {
    if (!correctionReason.trim()) {
      toast({
        title: 'Required',
        description: 'Please enter a reason for the correction',
        variant: 'destructive',
      })
      return
    }
    if (!openEntry) {
      // hr_attendance_corrections.entry_id is NOT NULL, so a correction can only be
      // raised against an existing attendance entry.
      toast({
        title: 'No open entry',
        description:
          'Corrections can only be requested for a recorded attendance entry. Please contact HR directly for a missed clock-in.',
        variant: 'destructive',
      })
      return
    }
    try {
      // Attempt to insert into correction table — may not exist yet
      const { error } = await supabase
        .from('hr_attendance_corrections')
        .insert({
          requested_by: userProfile.id,
          organization_id: organizationId,
          entry_id: openEntry.id,
          reason: correctionReason,
          status: 'pending',
        })
      if (error) throw error
      toast({
        title: '✅ Correction Requested',
        description: 'Your manager will review this request.',
      })
      setCorrectionReason('')
      setShowCorrection(false)
    } catch {
      // Table may not exist yet — show a friendly message
      toast({
        title: 'Coming Soon',
        description:
          'Correction request feature is being set up. Please contact HR directly for now.',
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

  return (
    <div className="px-4 pt-6 space-y-5">
      <h1 className="text-xl font-bold text-foreground">Attendance</h1>

      {/* ── Big clock button ──────────────────────────────────── */}
      <div className="flex flex-col items-center py-6">
        <button
          onClick={handleClock}
          disabled={clockLoading}
          className={cn(
            'h-36 w-36 rounded-full flex flex-col items-center justify-center gap-2 shadow-xl transition-all active:scale-95',
            'border-4',
            isClockedIn
              ? 'bg-red-500 border-red-300 text-white hover:bg-red-600'
              : 'bg-blue-600 border-blue-300 text-white hover:bg-blue-700',
          )}
        >
          {clockLoading ? (
            <Loader2 className="h-10 w-10 animate-spin" />
          ) : isClockedIn ? (
            <>
              <LogOut className="h-10 w-10" />
              <span className="text-sm font-bold">CLOCK OUT</span>
            </>
          ) : (
            <>
              <LogIn className="h-10 w-10" />
              <span className="text-sm font-bold">CLOCK IN</span>
            </>
          )}
        </button>
        <p className="text-xs text-muted-foreground mt-3">
          {new Date().toLocaleDateString('en-MY', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </p>
      </div>

      {/* ── Shift selector ────────────────────────────────────── */}
      {shifts.length > 0 && !isClockedIn && (
        <div className="bg-card rounded-2xl border border-border p-4">
          <p className="text-sm font-medium text-foreground mb-2">
            Select Shift
          </p>
          <div className="flex flex-wrap gap-2">
            {shifts.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedShift(s.id)}
                className={cn(
                  'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
                  selectedShift === s.id
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-accent text-foreground border-border hover:border-blue-300',
                )}
              >
                {s.name} ({s.start_time}–{s.end_time})
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Today summary ─────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">
          Today Summary
        </h3>
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Clock In</p>
            <p className="text-sm font-bold text-foreground mt-1">
              {todayEntries.length > 0
                ? new Date(
                    todayEntries[todayEntries.length - 1].clock_in_at,
                  ).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '--:--'}
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Clock Out</p>
            <p className="text-sm font-bold text-foreground mt-1">
              {todayEntries.length > 0 && todayEntries[0].clock_out_at
                ? new Date(
                    todayEntries[0].clock_out_at,
                  ).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '--:--'}
            </p>
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-sm font-bold text-foreground mt-1">
              {todayTotalHours > 0 ? todayTotalHours.toFixed(1) + 'h' : '--'}
            </p>
          </div>
        </div>
      </div>

      {/* ── Recent entries ────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">
          Recent Entries
        </h3>
        {recentEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No attendance records yet
          </p>
        ) : (
          <div className="space-y-2">
            {recentEntries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0"
              >
                <div
                  className={cn(
                    'h-8 w-8 rounded-full flex items-center justify-center shrink-0',
                    entry.clock_out_at
                      ? 'bg-green-100 dark:bg-green-900/30'
                      : 'bg-blue-100 dark:bg-blue-900/30',
                  )}
                >
                  {entry.clock_out_at ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                  ) : (
                    <Timer className="h-4 w-4 text-blue-600" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {new Date(entry.clock_in_at).toLocaleDateString('en-MY', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </p>
                  <p className="text-sm text-foreground">
                    {new Date(entry.clock_in_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {entry.clock_out_at &&
                      ` — ${new Date(entry.clock_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                  </p>
                </div>
                {flagBadge(entry.attendance_flag)}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Correction request ────────────────────────────────── */}
      <button
        onClick={() => setShowCorrection(!showCorrection)}
        className="w-full flex items-center gap-2 px-4 py-3 rounded-xl border border-border bg-card text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <Edit3 className="h-4 w-4" />
        <span>Forgot to clock? Request correction</span>
        <ChevronRight
          className={cn(
            'h-4 w-4 ml-auto transition-transform',
            showCorrection && 'rotate-90',
          )}
        />
      </button>

      {showCorrection && (
        <div className="bg-card rounded-2xl border border-border p-4 space-y-3">
          <textarea
            value={correctionReason}
            onChange={(e) => setCorrectionReason(e.target.value)}
            placeholder="Describe what happened (e.g., forgot to clock in at 9 am)…"
            className="w-full min-h-[80px] p-3 rounded-xl border border-border bg-background text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <Button
            size="sm"
            onClick={handleCorrectionRequest}
            className="w-full"
          >
            Submit Correction Request
          </Button>
        </div>
      )}

      <div className="h-4" />
    </div>
  )
}
