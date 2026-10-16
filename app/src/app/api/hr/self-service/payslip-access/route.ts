import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getHrAuthContext, hrCan, hrSelfCan } from '@/lib/server/hrAccess'

export async function GET() {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) {
            return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        }

        const ctx = ctxResult.data
        const { organizationId } = ctx
        if (!organizationId) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }

        // The organization's access log is a payroll view; an employee sees only their own entries.
        const isManager = await hrCan(ctx, 'hr.payroll.view')
        if (!isManager && !(await hrSelfCan(ctx))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        let query = supabase
            .from('hr_payslip_access_logs')
            .select('*')
            .eq('organization_id', organizationId)
            .order('accessed_at', { ascending: false })
        if (!isManager) query = query.eq('employee_user_id', ctx.userId)
        const { data, error } = await query

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: data || [] })
    } catch (error: any) {
        console.error('Failed to list payslip access logs:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
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

        const body = await request.json()
        const employeeUserId = String(body.employee_user_id || ctx.userId || '').trim()
        if (!employeeUserId) {
            return NextResponse.json({ success: false, error: 'Employee is required' }, { status: 400 })
        }

        const isManager = await hrCan(ctx, 'hr.payroll.view')
        if (!isManager && (employeeUserId !== ctx.userId || !(await hrSelfCan(ctx)))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        const { data, error } = await supabase
            .from('hr_payslip_access_logs')
            .insert({
                organization_id: ctx.organizationId,
                employee_user_id: employeeUserId,
                payslip_id: body.payslip_id || null,
                metadata: body.metadata || null
            })
            .select('*')
            .single()

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        console.error('Failed to create payslip access log:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
