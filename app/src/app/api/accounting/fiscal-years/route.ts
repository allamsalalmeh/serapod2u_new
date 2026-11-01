import { financeAllowed } from '@/lib/security-access/finance'
import { fiscalLegacyAllowed } from '@/lib/security-access/fiscal-period-catalog'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/fiscal-years
 * Get all fiscal years for the company
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

    if (!userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }
    if (!(await financeAllowed(user.id, 'finance.ledger.view', () => true, (userData as any).organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data: companyId } = await supabase.rpc('get_company_id', {
      p_org_id: userData.organization_id
    })

    const { data: fiscalYears, error } = await supabase
      .from('fiscal_years')
      .select(`
        *,
        fiscal_periods (
          id, period_number, period_name, start_date, end_date, status, period_type,
          closed_at, closed_by
        )
      `)
      .eq('company_id', companyId)
      .order('start_date', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    // Sort periods within each fiscal year
    const sortedFiscalYears = fiscalYears?.map((fy: any) => ({
      ...fy,
      fiscal_periods: fy.fiscal_periods?.sort((a: any, b: any) => a.period_number - b.period_number)
    }))

    return NextResponse.json({ fiscalYears: sortedFiscalYears || [] })
  } catch (error) {
    console.error('Error fetching fiscal years:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/accounting/fiscal-years
 * Create a new fiscal year
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient() as any
    const body = await request.json()
    
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: userData } = await supabase
      .from('users')
      .select(`
        organization_id,
        roles!inner(role_level)
      `)
      .eq('id', user.id)
      .single()

    if (!userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Dedicated permission (Security & Access); while not enforced: central Super Admin only.
    if (!(await financeAllowed(user.id, 'finance.fiscal_year.create', () => fiscalLegacyAllowed(userData.roles.role_level), userData.organization_id))) {
      return NextResponse.json({ error: 'You do not have permission to create a fiscal year (Create Fiscal Year).' }, { status: 403 })
    }

    // Validate required fields
    if (!body.fiscal_year_name || !body.fiscal_year_code || !body.start_date || !body.end_date) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    // Validate dates
    const startDate = new Date(body.start_date)
    const endDate = new Date(body.end_date)
    if (endDate <= startDate) {
      return NextResponse.json({ error: 'End date must be after start date' }, { status: 400 })
    }

    // The database function re-checks the permission, refuses overlaps, creates the year and its
    // periods (all Future) and records the change in fiscal_period_events.
    const { data: created, error: createError } = await supabase.rpc('fiscal_year_create', {
      p_code: body.fiscal_year_code,
      p_name: body.fiscal_year_name,
      p_start: body.start_date,
      p_end: body.end_date,
      p_period_type: body.period_type || 'monthly',
    })

    if (createError) {
      console.error('Error creating fiscal year:', createError)
      const denied = createError.code === '42501'
      return NextResponse.json(
        { error: denied ? 'You do not have permission to create a fiscal year (Create Fiscal Year).' : createError.message },
        { status: denied ? 403 : 400 }
      )
    }

    const { data: fiscalYear } = await supabase
      .from('fiscal_years')
      .select('*')
      .eq('id', created?.fiscal_year_id)
      .single()
    const periodsCreated = created?.periods_created || 0

    return NextResponse.json({
      success: true,
      fiscalYear,
      periodsCreated
    })
  } catch (error) {
    console.error('Error creating fiscal year:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
