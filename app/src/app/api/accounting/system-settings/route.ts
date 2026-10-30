import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/system-settings
 * Get currency settings and fiscal year configuration
 */
export async function GET() {
  try {
    const supabase = await createClient() as any

    // Get current user
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { data: financeActor } = await (supabase as any).from('users').select('organization_id').eq('id', user.id).maybeSingle()
    if (!(await financeAllowed(user.id, 'finance.ledger.view', () => true, financeActor?.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Get user's company
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('organization_id, organizations!fk_users_organization!inner(id, org_type_code)')
      .eq('id', user.id)
      .single()

    if (userError || !userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Get company_id (HQ)
    const { data: companyId } = await supabase.rpc('get_company_id', {
      p_org_id: userData.organization_id
    })

    // Get currency settings
    const { data: currencySettings } = await supabase
      .from('accounting_currency_settings')
      .select('*')
      .eq('company_id', companyId)
      .maybeSingle()

    // Get fiscal years with periods
    const { data: fiscalYears } = await supabase
      .from('fiscal_years')
      .select(`
        *,
        fiscal_periods (
          id, period_number, period_name, start_date, end_date, status, period_type
        )
      `)
      .eq('company_id', companyId)
      .order('start_date', { ascending: false })

    // Get current fiscal year and period
    const currentFiscalYear = fiscalYears?.find((fy: any) =>
      fy.status === 'open' &&
      new Date() >= new Date(fy.start_date) &&
      new Date() <= new Date(fy.end_date)
    )

    const currentPeriod = currentFiscalYear?.fiscal_periods?.find((fp: any) =>
      fp.status === 'open' &&
      new Date() >= new Date(fp.start_date) &&
      new Date() <= new Date(fp.end_date)
    )

    return NextResponse.json({
      currency: currencySettings || {
        base_currency_code: 'MYR',
        base_currency_name: 'Malaysian Ringgit',
        base_currency_symbol: 'RM',
        decimal_places: 2,
        thousand_separator: ',',
        decimal_separator: '.',
        symbol_position: 'before'
      },
      fiscalYears: fiscalYears || [],
      currentFiscalYear,
      currentPeriod,
      company_id: companyId
    })
  } catch (error) {
    console.error('Error fetching system settings:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * PUT /api/accounting/system-settings
 * Update currency settings
 */
export async function PUT(request: Request) {
  try {
    const supabase = await createClient() as any
    const body = await request.json()

    // Get current user
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user details and check permissions
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select(`
        organization_id,
        organizations!fk_users_organization!inner(id, org_type_code),
        roles!inner(role_level)
      `)
      .eq('id', user.id)
      .single()

    if (userError || !userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Check HQ admin permission
    if (!(await financeAllowed(user.id, 'finance.settings.manage', () => userData.roles.role_level <= 20, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden - HQ Admin only' }, { status: 403 })
    }

    // Get company_id
    const { data: companyId } = await supabase.rpc('get_company_id', {
      p_org_id: userData.organization_id
    })

    // Update or insert currency settings
    const { data: currencyData, error: currencyError } = await supabase
      .from('accounting_currency_settings')
      .upsert({
        company_id: companyId,
        base_currency_code: body.base_currency_code || 'MYR',
        base_currency_name: body.base_currency_name || 'Malaysian Ringgit',
        base_currency_symbol: body.base_currency_symbol || 'RM',
        decimal_places: body.decimal_places ?? 2,
        thousand_separator: body.thousand_separator || ',',
        decimal_separator: body.decimal_separator || '.',
        symbol_position: body.symbol_position || 'before',
        updated_by: user.id
      }, {
        onConflict: 'company_id'
      })
      .select()
      .single()

    if (currencyError) {
      console.error('Error updating currency settings:', currencyError)
      return NextResponse.json({ error: currencyError.message }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      currency: currencyData
    })
  } catch (error) {
    console.error('Error updating system settings:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
