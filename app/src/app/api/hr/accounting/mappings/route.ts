import { hrCan } from '@/lib/server/hrAccess'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/hr/accounting/mappings
 * Bulk upsert component → GL mappings
 *
 * Body: { mappings: Array<{ component_id, debit_gl_account_id?, credit_gl_account_id? }> }
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

        if (!userData) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        const roleLevel = (userData.roles as any)?.role_level || 999
        if (!(await hrCan({ userId: user.id, organizationId: userData.organization_id, roleCode: null, roleLevel },
            'finance.payroll_integration.manage', () => roleLevel <= 20))) {
            return NextResponse.json({ error: 'HQ Admin required' }, { status: 403 })
        }

        const { data: companyId } = await supabase.rpc('get_company_id', {
            p_org_id: userData.organization_id,
        })
        if (!companyId) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

        const body = await request.json()
        const { mappings } = body

        if (!Array.isArray(mappings) || mappings.length === 0) {
            return NextResponse.json({ error: 'mappings array is required' }, { status: 400 })
        }

        let updated = 0
        let created = 0
        const errors: string[] = []

        for (const m of mappings) {
            if (!m.component_id) {
                errors.push('Missing component_id in one mapping')
                continue
            }

            if (!m.debit_gl_account_id && !m.credit_gl_account_id) {
                errors.push(`Component ${m.component_id}: at least one GL account side required`)
                continue
            }

            // Check if existing mapping
            const { data: existing } = await supabase
                .from('payroll_component_gl_map')
                .select('id')
                .eq('company_id', companyId)
                .eq('component_id', m.component_id)
                .is('effective_from', null)
                .maybeSingle()

            if (existing) {
                const { error } = await supabase
                    .from('payroll_component_gl_map')
                    .update({
                        debit_gl_account_id: m.debit_gl_account_id || null,
                        credit_gl_account_id: m.credit_gl_account_id || null,
                        is_active: m.is_active !== false,
                        updated_at: new Date().toISOString(),
                    })
                    .eq('id', existing.id)

                if (error) {
                    errors.push(`Component ${m.component_id}: ${error.message}`)
                } else {
                    updated++
                }
            } else {
                const { error } = await supabase
                    .from('payroll_component_gl_map')
                    .insert({
                        company_id: companyId,
                        component_id: m.component_id,
                        debit_gl_account_id: m.debit_gl_account_id || null,
                        credit_gl_account_id: m.credit_gl_account_id || null,
                        is_active: m.is_active !== false,
                        created_by: user.id,
                    })

                if (error) {
                    errors.push(`Component ${m.component_id}: ${error.message}`)
                } else {
                    created++
                }
            }
        }

        return NextResponse.json({
            success: errors.length === 0,
            created,
            updated,
            errors: errors.length > 0 ? errors : undefined,
        })
    } catch (error) {
        console.error('Error in mappings POST:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

/**
 * GET /api/hr/accounting/mappings
 * List all component → GL mappings for the company
 * (alias — same data can also be retrieved from /api/hr/payroll/components GET)
 */
export async function GET() {
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
        if (!(await hrCan({ userId: user.id, organizationId: userData.organization_id, roleCode: null, roleLevel: null },
            'finance.payroll_integration.manage'))) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
        }

        const { data: companyId } = await supabase.rpc('get_company_id', {
            p_org_id: userData.organization_id,
        })
        if (!companyId) return NextResponse.json({ error: 'Company not found' }, { status: 404 })

        const { data: components, error } = await supabase
            .from('payroll_components')
            .select(`
        id, code, name, category, is_statutory, is_active, sort_order,
        payroll_component_gl_map (
          id, debit_gl_account_id, credit_gl_account_id, is_active, effective_from, effective_to
        )
      `)
            .eq('company_id', companyId)
            .order('sort_order', { ascending: true })

        if (error) return NextResponse.json({ error: error.message }, { status: 500 })

        // Get GL account names for display
        const accountIds = new Set<string>()
        for (const c of (components || [])) {
            for (const m of (c.payroll_component_gl_map || [])) {
                if (m.debit_gl_account_id) accountIds.add(m.debit_gl_account_id)
                if (m.credit_gl_account_id) accountIds.add(m.credit_gl_account_id)
            }
        }

        let accountMap: Record<string, { code: string; name: string }> = {}
        if (accountIds.size > 0) {
            const { data: accounts } = await supabase
                .from('gl_accounts')
                .select('id, code, name')
                .in('id', Array.from(accountIds))

            for (const a of (accounts || [])) {
                accountMap[a.id] = { code: a.code, name: a.name }
            }
        }

        return NextResponse.json({
            components: components || [],
            accountMap,
            company_id: companyId,
        })
    } catch (error) {
        console.error('Error in mappings GET:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
