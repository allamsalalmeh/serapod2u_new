import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'
import { isStatutoryCertified, mergeStatutoryRates, readStatutoryRates, sanitizeStatutoryRatesInput } from '@/lib/hr/payroll-calculation'

/**
 * Statutory rates live in the organization's single hr_settings.config document under `statutory_rates`
 * (hr_settings has no config_key column). The certification flag (`payroll.statutory_certified`) is read-only here.
 */
export async function GET(_request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        const ctx = ctxResult.data
        if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        if (!(await hrCan(ctx, 'hr.compensation.view'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        const { data, error } = await supabase
            .from('hr_settings')
            .select('config')
            .eq('organization_id', ctx.organizationId)
            .maybeSingle()
        if (error) return NextResponse.json({ success: false, error: 'Statutory settings could not be read' }, { status: 500 })

        return NextResponse.json({ success: true, data: readStatutoryRates(data?.config), statutoryCertified: isStatutoryCertified(data?.config) })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

export async function PUT(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        const ctx = ctxResult.data
        if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        if (!(await hrCan(ctx, 'hr.compensation.manage'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        const parsed = sanitizeStatutoryRatesInput(await request.json().catch(() => null))
        if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 })

        const { data: current, error: readError } = await supabase
            .from('hr_settings')
            .select('config')
            .eq('organization_id', ctx.organizationId)
            .maybeSingle()
        if (readError) return NextResponse.json({ success: false, error: 'Statutory settings could not be read' }, { status: 500 })

        const { data, error } = await supabase
            .from('hr_settings')
            .upsert({
                organization_id: ctx.organizationId,
                config: mergeStatutoryRates(current?.config, parsed.rates),
                updated_at: new Date().toISOString(),
            }, { onConflict: 'organization_id' })
            .select('config')
            .single()
        if (error) return NextResponse.json({ success: false, error: 'Statutory settings could not be saved' }, { status: 500 })
        return NextResponse.json({ success: true, data: readStatutoryRates(data?.config), statutoryCertified: isStatutoryCertified(data?.config) })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
