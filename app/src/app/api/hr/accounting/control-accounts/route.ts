import { hrCan } from '@/lib/server/hrAccess'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

async function getAuthAndCompany(supabase: any) {
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return { error: 'Unauthorized', status: 401 }

    const { data: userData } = await supabase
        .from('users')
        .select('organization_id, roles!inner(role_level)')
        .eq('id', user.id)
        .single()

    if (!userData) return { error: 'User not found', status: 404 }

    const { data: companyId } = await supabase.rpc('get_company_id', {
        p_org_id: userData.organization_id,
    })

    if (!companyId) return { error: 'Company not found', status: 404 }

    const roleLevel = (userData.roles as any)?.role_level || 999
    return { user, userData, companyId, roleLevel }
}

/**
 * GET /api/hr/accounting/control-accounts
 * List payroll clearing / bank / statutory accounts + available GL accounts
 */
export async function GET() {
    try {
        const supabase = await createClient() as any
        const ctx = await getAuthAndCompany(supabase)
        if ('error' in ctx) {
            return NextResponse.json({ error: ctx.error }, { status: ctx.status })
        }
        if (!(await hrCan({ userId: ctx.user.id, organizationId: ctx.userData.organization_id, roleCode: null, roleLevel: ctx.roleLevel },
            'finance.payroll_integration.manage'))) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
        }

        // Get clearing accounts
        const { data: clearingAccounts, error: caErr } = await supabase
            .from('payroll_clearing_accounts')
            .select('*, gl_accounts:gl_account_id(id, code, name, account_type, subtype)')
            .eq('company_id', ctx.companyId)
            .eq('is_active', true)
            .order('account_type')

        if (caErr) return NextResponse.json({ error: caErr.message }, { status: 500 })

        // Get all active GL accounts for dropdowns
        const { data: glAccounts, error: glErr } = await supabase
            .from('gl_accounts')
            .select('id, code, name, account_type, subtype')
            .eq('company_id', ctx.companyId)
            .eq('is_active', true)
            .order('code')

        if (glErr) return NextResponse.json({ error: glErr.message }, { status: 500 })

        // Also get current gl_settings (for cash_account_id fallback)
        const { data: glSettings } = await supabase
            .from('gl_settings')
            .select('cash_account_id')
            .eq('company_id', ctx.companyId)
            .maybeSingle()

        return NextResponse.json({
            clearingAccounts: clearingAccounts || [],
            glAccounts: glAccounts || [],
            cashAccountId: glSettings?.cash_account_id || null,
            company_id: ctx.companyId,
        })
    } catch (error) {
        console.error('Error in control-accounts GET:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * POST /api/hr/accounting/control-accounts
 * Save/upsert a clearing or bank account
 * Body: { account_type: 'CLEARING'|'BANK'|'STATUTORY_PAYMENT', gl_account_id, is_default?, bank_account_name? }
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient() as any
        const ctx = await getAuthAndCompany(supabase)
        if ('error' in ctx) {
            return NextResponse.json({ error: ctx.error }, { status: ctx.status })
        }

        if (!(await hrCan({ userId: ctx.user.id, organizationId: ctx.userData.organization_id, roleCode: null, roleLevel: ctx.roleLevel },
            'finance.payroll_integration.manage', () => ctx.roleLevel <= 20))) {
            return NextResponse.json({ error: 'HQ Admin required' }, { status: 403 })
        }

        const body = await request.json()
        const { account_type, gl_account_id, is_default, bank_account_name, bank_account_number } = body

        if (!account_type || !gl_account_id) {
            return NextResponse.json(
                { error: 'account_type and gl_account_id are required' },
                { status: 400 }
            )
        }

        if (!['CLEARING', 'BANK', 'STATUTORY_PAYMENT'].includes(account_type)) {
            return NextResponse.json({ error: 'Invalid account_type' }, { status: 400 })
        }

        // If setting as default, unset other defaults of same type first
        if (is_default) {
            await supabase
                .from('payroll_clearing_accounts')
                .update({ is_default: false, updated_at: new Date().toISOString() })
                .eq('company_id', ctx.companyId)
                .eq('account_type', account_type)
                .eq('is_default', true)
        }

        // Upsert
        const { data: existing } = await supabase
            .from('payroll_clearing_accounts')
            .select('id')
            .eq('company_id', ctx.companyId)
            .eq('account_type', account_type)
            .eq('gl_account_id', gl_account_id)
            .maybeSingle()

        if (existing) {
            const { error } = await supabase
                .from('payroll_clearing_accounts')
                .update({
                    is_default: is_default ?? true,
                    bank_account_name: bank_account_name || null,
                    bank_account_number: bank_account_number || null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', existing.id)

            if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        } else {
            const { error } = await supabase
                .from('payroll_clearing_accounts')
                .insert({
                    company_id: ctx.companyId,
                    account_type,
                    gl_account_id,
                    is_default: is_default ?? true,
                    bank_account_name: bank_account_name || null,
                    bank_account_number: bank_account_number || null,
                    is_active: true,
                    created_by: ctx.user.id,
                })

            if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('Error in control-accounts POST:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
