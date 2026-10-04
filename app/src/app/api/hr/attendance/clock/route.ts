import { hrSelfCan } from '@/lib/server/hrAccess'
import { ONBOARDING_PENDING_MESSAGE, getOwnOnboardingState, isOnboardingPendingError } from '@/lib/hr/onboarding'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAttendanceAuthContext } from '@/lib/server/attendanceAccess'

const getWeekRange = (date: Date) => {
    const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    const day = utc.getUTCDay()
    const diffToMonday = (day + 6) % 7
    const start = new Date(utc)
    start.setUTCDate(utc.getUTCDate() - diffToMonday)
    const end = new Date(start)
    end.setUTCDate(start.getUTCDate() + 6)
    return {
        start,
        end,
        startDate: start.toISOString().slice(0, 10),
        endDate: end.toISOString().slice(0, 10)
    }
}

export async function POST(request: NextRequest) {
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
        if (!(await hrSelfCan(ctx))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        // ESS records follow HR onboarding: an employee awaiting onboarding
        // (or whose registration was reset) cannot record attendance yet.
        const onboarding = await getOwnOnboardingState(ctx.userId, ctx.organizationId)
        if (onboarding === 'pending' || onboarding === 'reset' || onboarding === 'none') {
            return NextResponse.json({ success: false, error: ONBOARDING_PENDING_MESSAGE, code: 'HR_ONBOARDING_PENDING' }, { status: 409 })
        }

        const body = await request.json()
        const action = String(body.action || '')
        const now = new Date()

        const { data: openEntry } = await supabase
            .from('hr_attendance_entries')
            .select('*')
            .eq('organization_id', ctx.organizationId)
            .eq('user_id', ctx.userId)
            .is('clock_out_at', null)
            .order('clock_in_at', { ascending: false })
            .limit(1)
            .maybeSingle()

        if (action === 'clock_in') {
            if (openEntry) {
                return NextResponse.json({ success: false, error: 'You are already clocked in.' }, { status: 409 })
            }

            const { data: entry, error } = await supabase
                .from('hr_attendance_entries')
                .insert({
                    organization_id: ctx.organizationId,
                    user_id: ctx.userId,
                    shift_id: body.shift_id || null,
                    clock_in_at: now.toISOString(),
                    status: 'open',
                    source: 'web'
                })
                .select('*')
                .single()

            if (error) {
                if (isOnboardingPendingError(error)) {
                    return NextResponse.json({ success: false, error: ONBOARDING_PENDING_MESSAGE, code: 'HR_ONBOARDING_PENDING' }, { status: 409 })
                }
                return NextResponse.json({ success: false, error: error.message }, { status: 500 })
            }

            await supabase
                .from('hr_attendance_audit')
                .insert({
                    organization_id: ctx.organizationId,
                    actor_user_id: ctx.userId,
                    entity_type: 'entry',
                    entity_id: entry.id,
                    action: 'clock_in',
                    metadata: { shift_id: body.shift_id || null }
                })

            return NextResponse.json({ success: true, data: entry })
        }

        if (action === 'clock_out') {
            if (!openEntry) {
                return NextResponse.json({ success: false, error: 'No active clock-in found.' }, { status: 409 })
            }

            const clockInAt = new Date(openEntry.clock_in_at)
            const diffMinutes = Math.max(0, Math.round((now.getTime() - clockInAt.getTime()) / 60000))

            const { data: updated, error } = await supabase
                .from('hr_attendance_entries')
                .update({
                    clock_out_at: now.toISOString(),
                    worked_minutes: diffMinutes,
                    status: 'closed',
                    updated_at: now.toISOString()
                })
                .eq('id', openEntry.id)
                .select('*')
                .single()

            if (error) {
                if (isOnboardingPendingError(error)) {
                    return NextResponse.json({ success: false, error: ONBOARDING_PENDING_MESSAGE, code: 'HR_ONBOARDING_PENDING' }, { status: 409 })
                }
                return NextResponse.json({ success: false, error: error.message }, { status: 500 })
            }

            const { startDate, endDate } = getWeekRange(now)

            const { data: entries } = await supabase
                .from('hr_attendance_entries')
                .select('worked_minutes, clock_in_at')
                .eq('organization_id', ctx.organizationId)
                .eq('user_id', ctx.userId)
                .gte('clock_in_at', `${startDate}T00:00:00.000Z`)
                .lte('clock_in_at', `${endDate}T23:59:59.999Z`)

            const totalMinutes = (entries || []).reduce((acc: number, item: any) => acc + (item.worked_minutes || 0), 0)

            const { data: timesheet, error: timesheetError } = await supabase
                .from('hr_timesheets')
                .upsert({
                    organization_id: ctx.organizationId,
                    user_id: ctx.userId,
                    period_start: startDate,
                    period_end: endDate,
                    total_minutes: totalMinutes,
                    status: 'pending',
                    submitted_at: now.toISOString(),
                    updated_at: now.toISOString()
                }, { onConflict: 'user_id,period_start' })
                .select('*')
                .single()

            if (timesheetError) {
                return NextResponse.json({ success: false, error: timesheetError.message }, { status: 500 })
            }

            await supabase
                .from('hr_attendance_audit')
                .insert({
                    organization_id: ctx.organizationId,
                    actor_user_id: ctx.userId,
                    entity_type: 'entry',
                    entity_id: updated.id,
                    action: 'clock_out',
                    metadata: { worked_minutes: diffMinutes }
                })

            return NextResponse.json({ success: true, data: { entry: updated, timesheet } })
        }

        return NextResponse.json({ success: false, error: 'Invalid action' }, { status: 400 })
    } catch (error: any) {
        console.error('Failed to clock attendance:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
