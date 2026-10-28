import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAttendanceAuthContext, canManageAttendance, attendanceCan } from '@/lib/server/attendanceAccess'
import { summarizeTimesheetEntries, timesheetRegenerationRefusal, timesheetRow, validateTimesheetPeriod } from '@/lib/hr/attendance-repairs'

export async function GET(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getAttendanceAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) {
            return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        }

        const ctx = ctxResult.data
        if (!ctx.organizationId) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }

        const { searchParams } = new URL(request.url)
        const scope = searchParams.get('scope') || 'mine'
        const from = searchParams.get('from')
        const to = searchParams.get('to')

        let userIds: string[] = []

        if (scope === 'team') {
            const isManager = await attendanceCan(ctx, 'hr.attendance.manage')
            const { data: directReports } = await supabase
                .from('users')
                .select('id')
                .eq('manager_user_id', ctx.userId)

            const { data: deptManaged } = await supabase
                .from('departments')
                .select('id')
                .eq('manager_user_id', ctx.userId)

            const deptIds = (deptManaged || []).map((d: any) => d.id)
            let deptUsers: any[] = []

            if (deptIds.length > 0) {
                const { data } = await supabase
                    .from('users')
                    .select('id')
                    .in('department_id', deptIds)
                deptUsers = data || []
            }

            userIds = Array.from(new Set([
                ...(directReports || []).map((u: any) => u.id),
                ...deptUsers.map((u: any) => u.id)
            ]))

            if (!isManager && userIds.length === 0) {
                return NextResponse.json({ success: true, data: [] })
            }
        }

        let query = supabase
            .from('hr_timesheets')
            .select('*, user:users(id, full_name, email, role_code)')
            .eq('organization_id', ctx.organizationId)
            .order('period_start', { ascending: false })

        if (scope === 'mine') {
            query = query.eq('user_id', ctx.userId)
        }

        if (scope === 'team' && userIds.length > 0) {
            query = query.in('user_id', userIds)
        }

        if (from) query = query.gte('period_start', from)
        if (to) query = query.lte('period_end', to)

        const { data, error } = await query

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: data || [] })
    } catch (error: any) {
        console.error('Failed to load timesheets:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}

/**
 * POST — generate (or regenerate) the caller's own timesheet for a period from closed attendance entries (B2B repair).
 * Writes only real columns (total_minutes, overtime_minutes); day/late/early counters are derived and returned, not
 * stored. A submitted, pending or approved timesheet is never reset to draft (409).
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getAttendanceAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        const ctx = ctxResult.data
        if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })

        const body = await request.json().catch(() => ({}))
        const { period_start, period_end, period_type } = body ?? {}
        const invalid = validateTimesheetPeriod(period_start, period_end)
        if (invalid) return NextResponse.json({ success: false, error: invalid.message }, { status: invalid.status })

        const { data: existing, error: existingError } = await supabase
            .from('hr_timesheets')
            .select('id, status')
            .eq('user_id', ctx.userId)
            .eq('period_start', period_start)
            .maybeSingle()
        if (existingError) return NextResponse.json({ success: false, error: 'Timesheet could not be read' }, { status: 500 })
        const locked = timesheetRegenerationRefusal(existing?.status)
        if (locked) return NextResponse.json({ success: false, error: locked.message, code: locked.code }, { status: locked.status })

        const { data: entries, error: entryError } = await supabase
            .from('hr_attendance_entries')
            .select('worked_minutes, overtime_minutes, attendance_flag, clock_in_at')
            .eq('user_id', ctx.userId)
            .eq('organization_id', ctx.organizationId)
            .gte('clock_in_at', `${period_start}T00:00:00`)
            .lte('clock_in_at', `${period_end}T23:59:59`)
            .not('clock_out_at', 'is', null)
        if (entryError) return NextResponse.json({ success: false, error: 'Attendance entries could not be read' }, { status: 500 })

        const totals = summarizeTimesheetEntries(entries || [])
        const { data, error } = await supabase
            .from('hr_timesheets')
            .upsert(timesheetRow({
                userId: ctx.userId, organizationId: ctx.organizationId,
                periodStart: period_start, periodEnd: period_end, periodType: period_type, totals,
            }), { onConflict: 'user_id,period_start' })
            .select()
            .single()

        if (error) return NextResponse.json({ success: false, error: 'Timesheet could not be saved' }, { status: 500 })
        return NextResponse.json({ success: true, data, summary: totals.derived })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
