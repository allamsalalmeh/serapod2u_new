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
        if (!(await hrCan(ctxResult.data, 'hr.analytics.view'))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        const { data, error } = await supabase
            .from('hr_kpi_snapshots')
            .select('*')
            .eq('organization_id', organizationId)
            .order('period_end', { ascending: false })

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data: data || [] })
    } catch (error: any) {
        console.error('Failed to list KPI snapshots:', error)
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

        if (!(await hrCan(ctx, 'hr.analytics.view'))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        const body = await request.json()
        const definitionId = String(body.kpi_definition_id || '').trim()
        const periodStart = body.period_start
        const periodEnd = body.period_end
        if (!definitionId || !periodStart || !periodEnd || body.value === undefined || body.value === null) {
            return NextResponse.json({ success: false, error: 'Definition, period, and value are required' }, { status: 400 })
        }

        const { data, error } = await supabase
            .from('hr_kpi_snapshots')
            .insert({
                organization_id: ctx.organizationId,
                kpi_definition_id: definitionId,
                period_start: periodStart,
                period_end: periodEnd,
                value: body.value,
                meta: body.meta || null
            })
            .select('*')
            .single()

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        console.error('Failed to create KPI snapshot:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
