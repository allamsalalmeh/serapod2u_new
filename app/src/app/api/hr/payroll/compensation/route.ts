import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { canManageHr, getHrAuthContext, hrCan } from '@/lib/server/hrAccess'

// HR/Payroll compensation reads include hourly_rate, salary_band_id, pay_type, ot_eligible and notes, which are revoked
// from the API role at the column level (20261105100000_hr_compensation_column_grants.sql). The caller is still the
// authenticated HR user (getHrAuthContext + hrCan); only the DATA access uses the service role, so the column grants
// never restrict a legitimate HR/Payroll workflow.
export async function GET(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        const ctx = ctxResult.data
        if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        if (!(await hrCan(ctx, 'hr.compensation.view', () => true))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        const admin = createAdminClient() as any
        const { searchParams } = new URL(request.url)
        const employeeId = searchParams.get('employee_id')

        let query = admin
            .from('hr_employee_compensation')
            .select('*, salary_band:hr_salary_bands(id, code, name)')
            .eq('organization_id', ctx.organizationId)
            .order('effective_date', { ascending: false })

        if (employeeId) query = query.eq('employee_id', employeeId)

        const { data, error } = await query
        if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        return NextResponse.json({ success: true, data: data || [] })
    } catch (error: any) {
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
        if (!(await hrCan(ctx, 'hr.compensation.manage'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        const admin = createAdminClient() as any
        const body = await request.json()

        // Supersede any existing active compensation for this employee
        if (body.employee_id) {
            await admin
                .from('hr_employee_compensation')
                .update({ status: 'superseded', end_date: body.effective_date })
                .eq('employee_id', body.employee_id)
                .eq('organization_id', ctx.organizationId)
                .eq('status', 'active')
        }

        const { data, error } = await admin
            .from('hr_employee_compensation')
            .insert({ ...body, organization_id: ctx.organizationId, status: 'active' })
            .select()
            .single()

        if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
