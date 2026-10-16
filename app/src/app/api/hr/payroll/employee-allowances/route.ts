import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { canManageHr, getHrAuthContext, hrCan } from '@/lib/server/hrAccess'

// The caller is the authenticated HR user (getHrAuthContext + hrCan); only the DATA access uses the service role, because
// hr_employee_allowances.notes is revoked from the API role at the column level (20261105100000_hr_compensation_column_grants.sql).
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
            .from('hr_employee_allowances')
            .select('*, allowance_type:hr_allowance_types(id, code, name)')
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
        const { data, error } = await admin
            .from('hr_employee_allowances')
            .insert({ ...body, organization_id: ctx.organizationId })
            .select()
            .single()

        if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
