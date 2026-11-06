import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/accounting/settings
 * Get accounting settings (control accounts mapping) for the user's company
 */
export async function GET(request: NextRequest) {
  try {
    // Check feature flag
    if (process.env.NEXT_PUBLIC_ACCOUNTING_ENABLED !== 'true') {
      return NextResponse.json(
        { error: 'Accounting module is not enabled' },
        { status: 403 }
      )
    }

    const supabase = await createClient() as any

    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { data: financeActor } = await (supabase as any).from('users').select('organization_id').eq('id', user.id).maybeSingle()
    if (!(await financeAllowed(user.id, 'finance.ledger.view', () => true, financeActor?.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Get user details
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single()

    if (userError || !userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Get company_id
    const { data: companyId, error: companyError } = await supabase
      .rpc('get_company_id', { p_org_id: userData.organization_id })

    if (companyError || !companyId) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    }

    // Get settings with joined account details
    const { data: settings, error: settingsError } = await supabase
      .from('gl_settings')
      .select(`
        *,
        cash_account:gl_accounts!cash_account_id(id, code, name, account_type),
        ar_control_account:gl_accounts!ar_control_account_id(id, code, name, account_type),
        ap_control_account:gl_accounts!ap_control_account_id(id, code, name, account_type),
        supplier_deposit_account:gl_accounts!supplier_deposit_account_id(id, code, name, account_type),
        sales_revenue_account:gl_accounts!sales_revenue_account_id(id, code, name, account_type),
        cogs_account:gl_accounts!cogs_account_id(id, code, name, account_type),
        inventory_account:gl_accounts!inventory_account_id(id, code, name, account_type)
      `)
      .eq('company_id', companyId)
      .single()

    if (settingsError && settingsError.code !== 'PGRST116') {
      // PGRST116 = no rows found (which is okay)
      console.error('Error fetching settings:', settingsError)
      return NextResponse.json(
        { error: 'Failed to fetch settings' },
        { status: 500 }
      )
    }

    // Return settings (or null if not yet configured)
    return NextResponse.json({
      settings: settings || null,
      company_id: companyId
    })

  } catch (error) {
    console.error('Error in GET /api/accounting/settings:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * PUT /api/accounting/settings
 * Update accounting settings (HQ Admin only)
 * Creates settings record if it doesn't exist (upsert)
 */
export async function PUT(request: NextRequest) {
  try {
    // Check feature flag
    if (process.env.NEXT_PUBLIC_ACCOUNTING_ENABLED !== 'true') {
      return NextResponse.json(
        { error: 'Accounting module is not enabled' },
        { status: 403 }
      )
    }

    const supabase = await createClient() as any

    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user details and check permissions
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('organization_id, role_code, roles!inner(role_level)')
      .eq('id', user.id)
      .single()

    if (userError || !userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Check if user is HQ Admin (role_level <= 20)
    const roleLevel = (userData.roles as any)?.role_level || 999
    if (!(await financeAllowed(user.id, 'finance.settings.manage', () => roleLevel <= 20, userData.organization_id))) {
      return NextResponse.json(
        { error: 'Insufficient permissions. HQ Admin required.' },
        { status: 403 }
      )
    }

    // Get company_id
    const { data: companyId, error: companyError } = await supabase
      .rpc('get_company_id', { p_org_id: userData.organization_id })

    if (companyError || !companyId) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    }

    // Parse request body
    const body = await request.json()

    // Whitelist allowed fields
    const allowedFields = [
      'cash_account_id',
      'ar_control_account_id',
      'ap_control_account_id',
      'supplier_deposit_account_id',
      'sales_revenue_account_id',
      'cogs_account_id',
      'inventory_account_id',
      'posting_mode',  // NEW: Allow posting mode to be updated
      'require_supplier_ack_for_payment_posting'
    ]

    const updateData: Record<string, any> = {
      updated_by: user.id
    }

    for (const field of allowedFields) {
      if (field in body) {
        // Special handling for posting_mode
        if (field === 'posting_mode') {
          const validModes = ['MANUAL', 'AUTO']
          if (validModes.includes(body[field])) {
            updateData[field] = body[field]
          }
        } else if (field === 'require_supplier_ack_for_payment_posting') {
          if (typeof body[field] === 'boolean') {
            updateData[field] = body[field]
          }
        } else {
          // Allow null values to clear the mapping
          updateData[field] = body[field] || null
        }
      }
    }

    // Validate account IDs exist and belong to company (if provided)
    // Filter out values that are not account IDs (like posting_mode or updated_by)
    const accountIds = Object.entries(updateData)
      .filter(([k, v]) => 
        v && 
        typeof v === 'string' && 
        v !== user.id && 
        k !== 'posting_mode'
      )
      .map(([, v]) => v)

    if (accountIds.length > 0) {
      const { data: validAccounts, error: validationError } = await supabase
        .from('gl_accounts')
        .select('id')
        .eq('company_id', companyId)
        .in('id', accountIds)

      if (validationError) {
        console.error('Error validating accounts:', validationError)
        return NextResponse.json(
          { error: 'Failed to validate account IDs' },
          { status: 500 }
        )
      }

      const validIds = new Set(validAccounts?.map((a: any) => a.id) || [])
      const invalidIds = accountIds.filter(id => !validIds.has(id))

      if (invalidIds.length > 0) {
        return NextResponse.json(
          { error: 'Invalid account ID(s): accounts must exist and belong to your company' },
          { status: 400 }
        )
      }
    }

    // Upsert settings
    const { data: updatedSettings, error: upsertError } = await supabase
      .from('gl_settings')
      .upsert({
        company_id: companyId,
        ...updateData,
        created_by: user.id  // Only used on insert
      }, {
        onConflict: 'company_id'
      })
      .select(`
        *,
        cash_account:gl_accounts!cash_account_id(id, code, name, account_type),
        ar_control_account:gl_accounts!ar_control_account_id(id, code, name, account_type),
        ap_control_account:gl_accounts!ap_control_account_id(id, code, name, account_type),
        supplier_deposit_account:gl_accounts!supplier_deposit_account_id(id, code, name, account_type),
        sales_revenue_account:gl_accounts!sales_revenue_account_id(id, code, name, account_type),
        cogs_account:gl_accounts!cogs_account_id(id, code, name, account_type),
        inventory_account:gl_accounts!inventory_account_id(id, code, name, account_type)
      `)
      .single()

    if (upsertError) {
      console.error('Error upserting settings:', upsertError)
      return NextResponse.json(
        { error: 'Failed to save settings' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      settings: updatedSettings,
      message: 'Settings saved successfully'
    })

  } catch (error) {
    console.error('Error in PUT /api/accounting/settings:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
