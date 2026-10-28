import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canManageHr, getHrAuthContext, hrCan } from '@/lib/server/hrAccess'

export async function GET(_request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) {
            return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        }

        const ctx = ctxResult.data
        if (!ctx.organizationId) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }

        if (!(await hrCan(ctx, 'hr.payroll.view'))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        const { data, error } = await supabase
            .from('hr_payroll_runs')
            .select('id, period_start, period_end, payroll_date, status, currency, total_net, total_gross, total_deductions, total_employer_contributions, created_at')
            .eq('organization_id', ctx.organizationId)
            .order('created_at', { ascending: false })

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: data || [] })
    } catch (error: any) {
        console.error('Failed to load payroll runs:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        const ctx = ctxResult.data
        if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        if (!(await hrCan(ctx, 'hr.payroll.prepare'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        const body = await request.json().catch(() => ({}))
        const iso = /^\d{4}-\d{2}-\d{2}$/
        if (!iso.test(String(body?.period_start ?? '')) || !iso.test(String(body?.period_end ?? '')) || body.period_end < body.period_start) {
            return NextResponse.json({ success: false, error: 'period_start and period_end (YYYY-MM-DD, end on/after start) are required' }, { status: 400 })
        }

        // B2B column contract: hr_payroll_runs has no name/employee_count columns. The run label is kept in notes;
        // the employee count is known only after calculation.
        const label = [typeof body.name === 'string' ? body.name.trim() : '', typeof body.notes === 'string' ? body.notes.trim() : '']
            .filter(Boolean).join(' — ')
        const { data, error } = await supabase
            .from('hr_payroll_runs')
            .insert({
                organization_id: ctx.organizationId,
                period_start: body.period_start,
                period_end: body.period_end,
                payroll_date: body.payroll_date || body.period_end,
                status: 'draft',
                currency: 'MYR',
                notes: label || null
            })
            .select()
            .single()

        if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
