import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getHrAuthContext, hrCan, hrCanIn } from '@/lib/server/hrAccess'
import { employmentError } from '@/lib/hr/employment-messages'

const EMPLOYMENT_TYPES = new Set(['Full-time', 'Part-time', 'Contract', 'Intern'])
const EMPLOYMENT_STATUSES = new Set(['active', 'resigned', 'terminated'])

export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
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

        if (!(await hrCan(ctx, 'hr.employee.manage'))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        const { id } = await params
        const body = await request.json()

        const updateData: Record<string, any> = {}

        if ('department_id' in body) updateData.department_id = body.department_id || null
        if ('position_id' in body) updateData.position_id = body.position_id || null
        if ('manager_user_id' in body) updateData.manager_user_id = body.manager_user_id || null

        if ('employment_type' in body) {
            if (body.employment_type && !EMPLOYMENT_TYPES.has(body.employment_type)) {
                return NextResponse.json({ success: false, error: 'Invalid employment type' }, { status: 400 })
            }
            updateData.employment_type = body.employment_type || null
        }

        if ('join_date' in body) {
            if (body.join_date && Number.isNaN(Date.parse(body.join_date))) {
                return NextResponse.json({ success: false, error: 'Invalid join date' }, { status: 400 })
            }
            updateData.join_date = body.join_date || null
        }

        if ('employment_status' in body) {
            if (body.employment_status && !EMPLOYMENT_STATUSES.has(body.employment_status)) {
                return NextResponse.json({ success: false, error: 'Invalid employment status' }, { status: 400 })
            }
            updateData.employment_status = body.employment_status || 'active'
        }

        if (Object.keys(updateData).length === 0) {
            return NextResponse.json({ success: false, error: 'No updates provided' }, { status: 400 })
        }

        if (updateData.manager_user_id && updateData.manager_user_id === id) {
            return NextResponse.json({ success: false, error: 'User cannot report to themselves' }, { status: 400 })
        }

        const { data: target, error: targetError } = await supabase
            .from('users')
            .select('id, organization_id')
            .eq('id', id)
            .single()

        if (targetError || !target) {
            return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
        }

        if (target.organization_id !== ctx.organizationId
            && !(await hrCanIn(ctx, 'hr.employee.manage', target.organization_id, () => ctx.roleLevel !== null && ctx.roleLevel <= 20))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        if (updateData.department_id) {
            const { data: dept } = await supabase
                .from('departments')
                .select('id, organization_id')
                .eq('id', updateData.department_id)
                .single()

            if (!dept || (dept.organization_id !== ctx.organizationId
                && !(await hrCanIn(ctx, 'hr.employee.manage', dept.organization_id, () => ctx.roleLevel !== null && ctx.roleLevel <= 20)))) {
                return NextResponse.json({ success: false, error: 'Invalid department' }, { status: 400 })
            }
        }

        if (updateData.position_id) {
            const { data: position } = await supabase
                .from('hr_positions')
                .select('id, organization_id')
                .eq('id', updateData.position_id)
                .single()

            if (!position || (position.organization_id !== ctx.organizationId
                && !(await hrCanIn(ctx, 'hr.employee.manage', position.organization_id, () => ctx.roleLevel !== null && ctx.roleLevel <= 20)))) {
                return NextResponse.json({ success: false, error: 'Invalid position' }, { status: 400 })
            }
        }

        if (updateData.manager_user_id) {
            const { data: manager } = await supabase
                .from('users')
                .select('id, organization_id')
                .eq('id', updateData.manager_user_id)
                .single()

            if (!manager || (manager.organization_id !== ctx.organizationId
                && !(await hrCanIn(ctx, 'hr.employee.manage', manager.organization_id, () => ctx.roleLevel !== null && ctx.roleLevel <= 20)))) {
                return NextResponse.json({ success: false, error: 'Invalid manager' }, { status: 400 })
            }
        }

        const { data, error } = await supabase
            .from('users')
            .update(updateData)
            .eq('id', id)
            .select('id')
            .single()

        if (error) {
            // The HR lifecycle guard (migration 20261221100000) refuses former-employee edits, archived/inactive,
            // other-company or cyclic managers and invalid end dates with stable codes: show the reason, not the code.
            const mapped = employmentError(error, 'Failed to update HR fields')
            return NextResponse.json({ success: false, error: mapped.message, code: mapped.code }, { status: mapped.status })
        }

        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        console.error('Failed to update HR fields:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
