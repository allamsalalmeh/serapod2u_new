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
            .from('hr_offers')
            .select('*')
            .eq('organization_id', organizationId)
            .order('created_at', { ascending: false })

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: data || [] })
    } catch (error: any) {
        console.error('Failed to list offers:', error)
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
        const applicationId = String(body.application_id || '').trim()
        if (!applicationId) {
            return NextResponse.json({ success: false, error: 'Application is required' }, { status: 400 })
        }

        const { data, error } = await supabase
            .from('hr_offers')
            .insert({
                organization_id: ctx.organizationId,
                application_id: applicationId,
                offer_status: body.offer_status || 'draft',
                offer_letter_url: body.offer_letter_url || null,
                compensation_amount: body.compensation_amount ?? null,
                compensation_currency: body.compensation_currency || 'MYR',
                start_date: body.start_date || null,
                expiry_date: body.expiry_date || null,
                signed_at: body.signed_at || null
            })
            .select('*')
            .single()

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        console.error('Failed to create offer:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
