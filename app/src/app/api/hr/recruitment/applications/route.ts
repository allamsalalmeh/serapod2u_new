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
            .from('hr_applications')
            .select('*')
            .eq('organization_id', organizationId)
            .order('applied_at', { ascending: false })

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: data || [] })
    } catch (error: any) {
        console.error('Failed to list applications:', error)
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
        const jobPostingId = String(body.job_posting_id || '').trim()
        const applicantId = String(body.applicant_id || '').trim()
        if (!jobPostingId || !applicantId) {
            return NextResponse.json({ success: false, error: 'Job posting and applicant are required' }, { status: 400 })
        }

        const { data, error } = await supabase
            .from('hr_applications')
            .insert({
                organization_id: ctx.organizationId,
                job_posting_id: jobPostingId,
                applicant_id: applicantId,
                stage: body.stage || 'applied',
                score: body.score ?? null,
                status: body.status || 'active'
            })
            .select('*')
            .single()

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        console.error('Failed to create application:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
