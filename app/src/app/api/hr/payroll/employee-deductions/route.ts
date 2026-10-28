import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canManageHr, getHrAuthContext, hrCan } from '@/lib/server/hrAccess'

export async function GET(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        const ctx = ctxResult.data
        if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        if (!(await hrCan(ctx, 'hr.compensation.view'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        const { searchParams } = new URL(request.url)
        const employeeId = searchParams.get('employee_id')

        let query = supabase
            .from('hr_employee_deductions')
            .select('*, deduction_type:hr_deduction_types(id, code, name, category)')
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

        const body = await request.json()
        const { data, error } = await supabase
            .from('hr_employee_deductions')
            .insert({ ...body, organization_id: ctx.organizationId })
            .select()
            .single()

        if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
