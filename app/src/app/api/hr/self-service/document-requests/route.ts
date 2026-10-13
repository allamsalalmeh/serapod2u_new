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

        // HR administrators see the organization's requests; an employee sees only their own (the verified account).
        const isManager = await hrCan(ctx, 'hr.employee.manage')
        if (!isManager && !(await hrSelfCan(ctx))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        let query = supabase
            .from('hr_document_requests')
            .select('*')
            .eq('organization_id', organizationId)
            .order('requested_at', { ascending: false })
        if (!isManager) query = query.eq('employee_user_id', ctx.userId)
        const { data, error } = await query

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: data || [] })
    } catch (error: any) {
        console.error('Failed to list document requests:', error)
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
        if (!(await hrSelfCan(ctxResult.data))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        const ctx = ctxResult.data
        if (!ctx.organizationId) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }

        const body = await request.json()
        // The requester is the authenticated account; only HR administrators may file on someone else's behalf.
        const isManager = await hrCan(ctx, 'hr.employee.manage')
        const employeeUserId = String((isManager && body.employee_user_id) || ctx.userId || '').trim()
        const documentType = String(body.document_type || '').trim()
        if (!employeeUserId || !documentType) {
            return NextResponse.json({ success: false, error: 'Employee and document type are required' }, { status: 400 })
        }

        const { data, error } = await supabase
            .from('hr_document_requests')
            .insert({
                organization_id: ctx.organizationId,
                employee_user_id: employeeUserId,
                document_type: documentType,
                status: isManager ? body.status || 'pending' : 'pending',
                fulfilled_at: isManager ? body.fulfilled_at || null : null,
                fulfilled_by: isManager ? body.fulfilled_by || null : null
            })
            .select('*')
            .single()

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        console.error('Failed to create document request:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
