import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canManageHr, getHrAuthContext, hrCan } from '@/lib/server/hrAccess'

export async function GET() {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) {
            return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        }

        const { organizationId } = ctxResult.data
        if (!organizationId) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }
        if (!(await hrCan(ctxResult.data, 'hr.recruitment.manage'))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        const { data, error } = await supabase
            .from('hr_job_postings')
            .select('*')
            .eq('organization_id', organizationId)
            .order('created_at', { ascending: false })

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: data || [] })
    } catch (error: any) {
        console.error('Failed to list recruitment jobs:', error)
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

        if (!(await hrCan(ctx, 'hr.recruitment.manage'))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        const body = await request.json()
        const title = String(body.title || '').trim()
        if (!title) {
            return NextResponse.json({ success: false, error: 'Title is required' }, { status: 400 })
        }

        const { data, error } = await supabase
            .from('hr_job_postings')
            .insert({
                organization_id: ctx.organizationId,
                position_id: body.position_id || null,
                title,
                department_id: body.department_id || null,
                location: body.location || null,
                employment_type: body.employment_type || null,
                seniority_level: body.seniority_level || null,
                status: body.status || 'draft',
                description: body.description || null,
                requirements: body.requirements || null,
                salary_min: body.salary_min ?? null,
                salary_max: body.salary_max ?? null,
                currency: body.currency || 'MYR',
                hiring_manager_id: body.hiring_manager_id || null,
                created_by: ctx.userId
            })
            .select('*')
            .single()

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        console.error('Failed to create recruitment job:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
