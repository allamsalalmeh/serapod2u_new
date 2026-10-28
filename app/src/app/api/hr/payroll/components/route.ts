import { hrCan } from '@/lib/server/hrAccess'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/hr/payroll/components
 * List payroll components for the current company
 */
export async function GET(request: NextRequest) {
    try {
        const supabase = await createClient() as any
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabase
            .from('users')
            .select('organization_id')
            .eq('id', user.id)
            .single()

        if (!userData?.organization_id) {
            return NextResponse.json({ error: 'User has no organization' }, { status: 400 })
        }
        if (!(await hrCan({ userId: user.id, organizationId: userData.organization_id, roleCode: null, roleLevel: null }, 'hr.compensation.view'))) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
        }

        const { data: companyId } = await supabase.rpc('get_company_id', {
            p_org_id: userData.organization_id,
        })

        if (!companyId) {
            return NextResponse.json({ error: 'Company not found' }, { status: 404 })
        }

        // Get components with their GL mappings
        const { data: components, error } = await supabase
            .from('payroll_components')
            .select(`
        *,
        payroll_component_gl_map (
          id,
          debit_gl_account_id,
          credit_gl_account_id,
          is_active,
          effective_from,
          effective_to
        )
      `)
            .eq('company_id', companyId)
            .eq('is_active', true)
            .order('sort_order', { ascending: true })

        if (error) {
            console.error('Error fetching payroll components:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        // Get clearing accounts
        const { data: clearingAccounts } = await supabase
            .from('payroll_clearing_accounts')
            .select('*, gl_accounts:gl_account_id(code, name, account_type)')
            .eq('company_id', companyId)
            .eq('is_active', true)

        return NextResponse.json({
            components: components || [],
            clearingAccounts: clearingAccounts || [],
            company_id: companyId,
        })
    } catch (error) {
        console.error('Error in payroll components API:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * POST /api/hr/payroll/components
 * Seed default payroll components and mappings
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient() as any
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabase
            .from('users')
            .select('organization_id, roles!inner(role_level)')
            .eq('id', user.id)
            .single()

        if (!userData) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        const roleLevel = (userData.roles as any)?.role_level || 999
        if (!(await hrCan({ userId: user.id, organizationId: userData.organization_id, roleCode: null, roleLevel },
            'hr.compensation.manage', () => roleLevel <= 20))) {
            return NextResponse.json({ error: 'HQ Admin required' }, { status: 403 })
        }

        const { data: companyId } = await supabase.rpc('get_company_id', {
            p_org_id: userData.organization_id,
        })

        if (!companyId) {
            return NextResponse.json({ error: 'Company not found' }, { status: 404 })
        }

        const body = await request.json()
        const { action } = body

        if (action === 'seed_accounts') {
            const { data, error } = await supabase.rpc('seed_hr_gl_accounts', { p_company_id: companyId })
            if (error) return NextResponse.json({ error: error.message }, { status: 500 })
            return NextResponse.json(data)
        }

        if (action === 'seed_components') {
            const { data, error } = await supabase.rpc('seed_payroll_components', { p_company_id: companyId })
            if (error) return NextResponse.json({ error: error.message }, { status: 500 })
            return NextResponse.json(data)
        }

        if (action === 'seed_mappings') {
            const { data, error } = await supabase.rpc('seed_payroll_gl_mappings', { p_company_id: companyId })
            if (error) return NextResponse.json({ error: error.message }, { status: 500 })
            return NextResponse.json(data)
        }

        if (action === 'seed_all') {
            // Seed accounts, then components, then mappings
            const { data: accts, error: e1 } = await supabase.rpc('seed_hr_gl_accounts', { p_company_id: companyId })
            if (e1) return NextResponse.json({ error: e1.message }, { status: 500 })

            const { data: comps, error: e2 } = await supabase.rpc('seed_payroll_components', { p_company_id: companyId })
            if (e2) return NextResponse.json({ error: e2.message }, { status: 500 })

            const { data: maps, error: e3 } = await supabase.rpc('seed_payroll_gl_mappings', { p_company_id: companyId })
            if (e3) return NextResponse.json({ error: e3.message }, { status: 500 })

            return NextResponse.json({
                success: true,
                accounts: accts,
                components: comps,
                mappings: maps,
            })
        }

        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    } catch (error) {
        console.error('Error in payroll components seed API:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * PUT /api/hr/payroll/components
 * Update a component GL mapping
 */
export async function PUT(request: NextRequest) {
    try {
        const supabase = await createClient() as any
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabase
            .from('users')
            .select('organization_id, roles!inner(role_level)')
            .eq('id', user.id)
            .single()

        if (!userData) {
            return NextResponse.json({ error: 'User not found' }, { status: 404 })
        }

        const roleLevel = (userData.roles as any)?.role_level || 999
        if (!(await hrCan({ userId: user.id, organizationId: userData.organization_id, roleCode: null, roleLevel },
            'hr.compensation.manage', () => roleLevel <= 20))) {
            return NextResponse.json({ error: 'HQ Admin required' }, { status: 403 })
        }

        const { data: companyId } = await supabase.rpc('get_company_id', {
            p_org_id: userData.organization_id,
        })

        if (!companyId) {
            return NextResponse.json({ error: 'Company not found' }, { status: 404 })
        }

        const body = await request.json()
        const { component_id, debit_gl_account_id, credit_gl_account_id } = body

        if (!component_id) {
            return NextResponse.json({ error: 'component_id is required' }, { status: 400 })
        }

        // Upsert the GL mapping
        const { data: existing } = await supabase
            .from('payroll_component_gl_map')
            .select('id')
            .eq('company_id', companyId)
            .eq('component_id', component_id)
            .is('effective_from', null)
            .maybeSingle()

        if (existing) {
            const { error } = await supabase
                .from('payroll_component_gl_map')
                .update({
                    debit_gl_account_id: debit_gl_account_id || null,
                    credit_gl_account_id: credit_gl_account_id || null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', existing.id)

            if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        } else {
            const { error } = await supabase
                .from('payroll_component_gl_map')
                .insert({
                    company_id: companyId,
                    component_id,
                    debit_gl_account_id: debit_gl_account_id || null,
                    credit_gl_account_id: credit_gl_account_id || null,
                    is_active: true,
                    created_by: user.id,
                })

            if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true })
    } catch (error) {
        console.error('Error updating payroll GL mapping:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
