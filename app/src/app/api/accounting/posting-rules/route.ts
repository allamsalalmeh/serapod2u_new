import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/accounting/posting-rules
 * List all posting rules for the user's company
 */
export async function GET(request: NextRequest) {
  try {
    if (process.env.NEXT_PUBLIC_ACCOUNTING_ENABLED !== 'true') {
      return NextResponse.json({ error: 'Accounting module is not enabled' }, { status: 403 })
    }

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
    if (!(await financeAllowed(user.id, 'finance.ledger.view', () => true, (userData as any).organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data: companyId } = await supabase
      .rpc('get_company_id', { p_org_id: userData.organization_id })

    if (!companyId) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    }

    const { data: rules, error } = await supabase
      .from('gl_posting_rules')
      .select('*')
      .eq('company_id', companyId)
      .order('document_type', { ascending: true })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Also get the posting mode from gl_settings
    const { data: settings } = await supabase
      .from('gl_settings')
      .select('posting_mode')
      .eq('company_id', companyId)
      .single()

    return NextResponse.json({
      rules: rules || [],
      posting_mode: settings?.posting_mode || 'MANUAL',
      company_id: companyId,
    })
  } catch (error) {
    console.error('Error in GET /api/accounting/posting-rules:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/accounting/posting-rules
 * Create or update a posting rule
 */
export async function POST(request: NextRequest) {
  try {
    if (process.env.NEXT_PUBLIC_ACCOUNTING_ENABLED !== 'true') {
      return NextResponse.json({ error: 'Accounting module is not enabled' }, { status: 403 })
    }

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
    if (!(await financeAllowed(user.id, 'finance.settings.manage', () => roleLevel <= 20, userData.organization_id))) {
      return NextResponse.json({ error: 'Insufficient permissions. HQ Admin required.' }, { status: 403 })
    }

    const { data: companyId } = await supabase
      .rpc('get_company_id', { p_org_id: userData.organization_id })

    if (!companyId) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    }

    const body = await request.json()
    const { rule_code, rule_name, description, document_type, posting_config, is_active } = body

    if (!rule_code || !rule_name || !document_type) {
      return NextResponse.json({ error: 'rule_code, rule_name, and document_type are required' }, { status: 400 })
    }

    // Upsert - update if rule_code exists, otherwise insert
    const { data: existing } = await supabase
      .from('gl_posting_rules')
      .select('id')
      .eq('company_id', companyId)
      .eq('rule_code', rule_code)
      .single()

    let result
    if (existing) {
      const { data, error } = await supabase
        .from('gl_posting_rules')
        .update({
          rule_name,
          description: description || null,
          document_type,
          posting_config: posting_config || {},
          is_active: is_active ?? true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single()

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      result = data
    } else {
      const { data, error } = await supabase
        .from('gl_posting_rules')
        .insert({
          company_id: companyId,
          rule_code,
          rule_name,
          description: description || null,
          document_type,
          posting_config: posting_config || {},
          is_active: is_active ?? true,
          created_by: user.id,
        })
        .select()
        .single()

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      result = data
    }

    return NextResponse.json({ rule: result })
  } catch (error) {
    console.error('Error in POST /api/accounting/posting-rules:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * PUT /api/accounting/posting-rules
 * Update posting mode (MANUAL/AUTO) in gl_settings
 */
export async function PUT(request: NextRequest) {
  try {
    if (process.env.NEXT_PUBLIC_ACCOUNTING_ENABLED !== 'true') {
      return NextResponse.json({ error: 'Accounting module is not enabled' }, { status: 403 })
    }

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
    if (!(await financeAllowed(user.id, 'finance.settings.manage', () => roleLevel <= 20, userData.organization_id))) {
      return NextResponse.json({ error: 'Insufficient permissions. HQ Admin required.' }, { status: 403 })
    }

    const { data: companyId } = await supabase
      .rpc('get_company_id', { p_org_id: userData.organization_id })

    if (!companyId) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    }

    const body = await request.json()
    const { posting_mode } = body

    // Posting is manual only (legacy automatic posting retired).
    if (posting_mode !== 'MANUAL') {
      return NextResponse.json({ error: 'Automatic posting is not available. Documents are posted from Pending Postings, where the amount actually paid or received is entered.' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('gl_settings')
      .update({ posting_mode, updated_at: new Date().toISOString(), updated_by: user.id })
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ settings: data, message: `Posting mode changed to ${posting_mode}` })
  } catch (error) {
    console.error('Error in PUT /api/accounting/posting-rules:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/accounting/posting-rules
 * Delete a posting rule by id (query param)
 */
export async function DELETE(request: NextRequest) {
  try {
    if (process.env.NEXT_PUBLIC_ACCOUNTING_ENABLED !== 'true') {
      return NextResponse.json({ error: 'Accounting module is not enabled' }, { status: 403 })
    }

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
    if (!(await financeAllowed(user.id, 'finance.settings.manage', () => roleLevel <= 20, userData.organization_id))) {
      return NextResponse.json({ error: 'Insufficient permissions. HQ Admin required.' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const ruleId = searchParams.get('id')
    if (!ruleId) {
      return NextResponse.json({ error: 'Rule ID is required' }, { status: 400 })
    }

    const { error } = await supabase
      .from('gl_posting_rules')
      .delete()
      .eq('id', ruleId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ message: 'Rule deleted successfully' })
  } catch (error) {
    console.error('Error in DELETE /api/accounting/posting-rules:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
