import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getAttendanceAuthContext } from '@/lib/server/attendanceAccess'

// ─── OT Calculation Engine ───────────────────────────────────────
// Deterministic function: computeOvertime(entry, policy, rules, holidays)

interface OTPolicy {
    enabled: boolean
    ot_grace_minutes: number
    auto_deduct_break: number
    rounding_mode: 'none' | 'round_down' | 'round_up' | 'nearest'
    rounding_interval: number
    max_ot_per_day_hours: number
    min_ot_block_minutes: number
}

interface OTRule {
    rule_type: 'daily' | 'weekly' | 'consecutive_days' | 'shift_based'
    threshold_minutes_t1: number
    threshold_minutes_t2: number | null
    multiplier_t1: number
    multiplier_t2: number | null
    rest_day_multiplier: number
    holiday_multiplier: number
}

interface OTResult {
    date: string
    employee_id: string
    employee_name: string
    clock_in: string
    clock_out: string | null
    total_work_minutes: number
    regular_minutes: number
    ot_minutes_t1: number
    ot_minutes_t2: number
    day_type: 'normal' | 'rest_day' | 'public_holiday'
    rate_t1: number
    rate_t2: number
    flags: {
        exceeded_cap: boolean
        missing_approval: boolean
        holiday_applied: boolean
        rest_day_applied: boolean
    }
}

function computeOvertime(
    workMinutes: number,
    policy: OTPolicy,
    rule: OTRule,
    dayType: 'normal' | 'rest_day' | 'public_holiday'
): { regular: number; ot_t1: number; ot_t2: number; rate_t1: number; rate_t2: number; exceeded_cap: boolean } {
    const threshold = rule.threshold_minutes_t1

    // Apply grace: OT starts only after grace period beyond threshold
    let rawOtMinutes = workMinutes - threshold - policy.ot_grace_minutes
    if (rawOtMinutes < 0) rawOtMinutes = 0

    // Apply break deduction
    if (rawOtMinutes > 0 && policy.auto_deduct_break > 0) {
        rawOtMinutes = Math.max(0, rawOtMinutes - policy.auto_deduct_break)
    }

    // Apply minimum block
    if (rawOtMinutes > 0 && rawOtMinutes < policy.min_ot_block_minutes) {
        rawOtMinutes = 0
    }

    // Apply rounding
    rawOtMinutes = applyRounding(rawOtMinutes, policy.rounding_mode, policy.rounding_interval)

    // Split into tier1 and tier2
    let ot_t1 = rawOtMinutes
    let ot_t2 = 0
    if (rule.threshold_minutes_t2 && workMinutes > rule.threshold_minutes_t2) {
        const t2Start = rule.threshold_minutes_t2 - threshold - policy.ot_grace_minutes
        if (t2Start > 0 && rawOtMinutes > t2Start) {
            ot_t2 = rawOtMinutes - t2Start
            ot_t1 = rawOtMinutes - ot_t2
        }
    }

    // Apply daily cap
    const maxOtMinutes = (policy.max_ot_per_day_hours || 4) * 60
    const totalOt = ot_t1 + ot_t2
    const exceededCap = totalOt > maxOtMinutes
    if (exceededCap) {
        const ratio = maxOtMinutes / totalOt
        ot_t1 = Math.round(ot_t1 * ratio)
        ot_t2 = Math.round(ot_t2 * ratio)
    }

    // Determine multipliers based on day type
    let rate_t1 = rule.multiplier_t1
    let rate_t2 = rule.multiplier_t2 || rule.multiplier_t1
    if (dayType === 'rest_day') {
        rate_t1 = rule.rest_day_multiplier || rule.multiplier_t1
        rate_t2 = rule.rest_day_multiplier || rate_t2
    } else if (dayType === 'public_holiday') {
        rate_t1 = rule.holiday_multiplier || rule.multiplier_t1
        rate_t2 = rule.holiday_multiplier || rate_t2
    }

    const regular = Math.min(workMinutes, threshold)

    return { regular, ot_t1, ot_t2, rate_t1, rate_t2, exceeded_cap: exceededCap }
}

function applyRounding(minutes: number, mode: string, interval: number): number {
    if (mode === 'none' || interval <= 0 || minutes <= 0) return minutes
    switch (mode) {
        case 'round_down':
            return Math.floor(minutes / interval) * interval
        case 'round_up':
            return Math.ceil(minutes / interval) * interval
        case 'nearest':
            return Math.round(minutes / interval) * interval
        default:
            return minutes
    }
}

// ─── POST /api/hr/attendance/overtime/preview ────────────────────
// Compute OT preview for given employee + date range.

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

        const body = await request.json()
        const { employee_id, start_date, end_date } = body

        if (!start_date || !end_date) {
            return NextResponse.json({ success: false, error: 'start_date and end_date required' }, { status: 400 })
        }

        // Load OT policy + rules
        const { data: policy } = await supabase
            .from('hr_overtime_policies')
            .select('*')
            .eq('organization_id', ctx.organizationId)
            .maybeSingle()

        if (!policy || !policy.enabled) {
            return NextResponse.json({ success: false, error: 'Overtime tracking not enabled' }, { status: 400 })
        }

        const { data: rules } = await supabase
            .from('hr_overtime_rules')
            .select('*')
            .eq('policy_id', policy.id)
            .eq('is_active', true)
            .order('priority', { ascending: true })

        if (!rules || rules.length === 0) {
            return NextResponse.json({ success: false, error: 'No overtime rules configured' }, { status: 400 })
        }

        const primaryRule = rules[0] // Use first active rule

        // Load attendance entries
        let entriesQuery = supabase
            .from('hr_attendance_entries')
            .select('id, user_id, clock_in_at, clock_out_at, worked_minutes, break_minutes, overtime_minutes, attendance_flag')
            .eq('organization_id', ctx.organizationId)
            .gte('clock_in_at', `${start_date}T00:00:00`)
            .lte('clock_in_at', `${end_date}T23:59:59`)
            .not('clock_out_at', 'is', null)
            .order('clock_in_at', { ascending: true })

        if (employee_id) {
            entriesQuery = entriesQuery.eq('user_id', employee_id)
        }

        const { data: entries, error: entriesError } = await entriesQuery
        if (entriesError) {
            return NextResponse.json({ success: false, error: entriesError.message }, { status: 500 })
        }

        // Load holidays for the date range
        const { data: holidays } = await supabase
            .from('hr_public_holidays')
            .select('date')
            .eq('organization_id', ctx.organizationId)
            .gte('date', start_date)
            .lte('date', end_date)

        const holidayDates = new Set((holidays || []).map((h: any) => h.date))

        // Load attendance policy for workdays (to determine rest days)
        const { data: attPolicy } = await supabase
            .from('hr_attendance_policies')
            .select('workdays')
            .eq('organization_id', ctx.organizationId)
            .maybeSingle()

        const workdays = new Set(attPolicy?.workdays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

        // Load employee names
        const employeeIds = [...new Set((entries || []).map((e: any) => e.user_id))]
        const { data: employees } = await supabase
            .from('users')
            .select('id, full_name')
            .in('id', employeeIds.length > 0 ? employeeIds : ['00000000-0000-0000-0000-000000000000'])

        const empMap = new Map<string, string>((employees || []).map((e: any) => [e.id, e.full_name || 'Unknown']))

        // Compute OT for each entry
        const results: OTResult[] = []
        let totalRegular = 0
        let totalOtT1 = 0
        let totalOtT2 = 0

        for (const entry of (entries || [])) {
            const clockDate = entry.clock_in_at.split('T')[0]
            const entryDate = new Date(clockDate)
            const entryDayName = dayNames[entryDate.getUTCDay()]

            // Determine day type
            let dayType: 'normal' | 'rest_day' | 'public_holiday' = 'normal'
            if (holidayDates.has(clockDate)) {
                dayType = 'public_holiday'
            } else if (!workdays.has(entryDayName)) {
                dayType = 'rest_day'
            }

            const workMinutes = entry.worked_minutes || 0  // column is worked_minutes (B2B)
            const result = computeOvertime(workMinutes, policy, primaryRule, dayType)

            totalRegular += result.regular
            totalOtT1 += result.ot_t1
            totalOtT2 += result.ot_t2

            results.push({
                date: clockDate,
                employee_id: entry.user_id,
                employee_name: empMap.get(entry.user_id) || 'Unknown',
                clock_in: entry.clock_in_at,
                clock_out: entry.clock_out_at,
                total_work_minutes: workMinutes,
                regular_minutes: result.regular,
                ot_minutes_t1: result.ot_t1,
                ot_minutes_t2: result.ot_t2,
                day_type: dayType,
                rate_t1: result.rate_t1,
                rate_t2: result.rate_t2,
                flags: {
                    exceeded_cap: result.exceeded_cap,
                    missing_approval: false, // Will be checked against request status
                    holiday_applied: dayType === 'public_holiday',
                    rest_day_applied: dayType === 'rest_day',
                },
            })
        }

        return NextResponse.json({
            success: true,
            entries: results,
            summary: {
                total_entries: results.length,
                total_regular_minutes: totalRegular,
                total_ot_t1_minutes: totalOtT1,
                total_ot_t2_minutes: totalOtT2,
                total_regular_hours: +(totalRegular / 60).toFixed(1),
                total_ot_t1_hours: +(totalOtT1 / 60).toFixed(1),
                total_ot_t2_hours: +(totalOtT2 / 60).toFixed(1),
            },
            policy_snapshot: {
                rounding_mode: policy.rounding_mode,
                rounding_interval: policy.rounding_interval,
                ot_grace_minutes: policy.ot_grace_minutes,
                max_ot_per_day_hours: policy.max_ot_per_day_hours,
            },
        })
    } catch (error: any) {
        console.error('Failed to compute OT preview:', error)
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}
