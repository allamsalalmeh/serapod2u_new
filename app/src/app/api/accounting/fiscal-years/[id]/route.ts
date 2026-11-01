import { financeAllowed } from '@/lib/security-access/finance'
import { fiscalLegacyAllowed, fiscalPermissionFor } from '@/lib/security-access/fiscal-period-catalog'
import { permissionLabel } from '@/lib/security-access/labels'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/fiscal-years/[id]
 * Get a specific fiscal year with periods
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient() as any
    const { id } = await params

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { data: financeActor } = await (supabase as any).from('users').select('organization_id').eq('id', user.id).maybeSingle()
    if (!(await financeAllowed(user.id, 'finance.ledger.view', () => true, financeActor?.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data: fiscalYear, error } = await supabase
      .from('fiscal_years')
      .select(`
        *,
        fiscal_periods (
          id, period_number, period_name, start_date, end_date, status, period_type,
          closed_at, closed_by
        )
      `)
      .eq('id', id)
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }

    // Sort periods
    if (fiscalYear.fiscal_periods) {
      fiscalYear.fiscal_periods.sort((a: any, b: any) => a.period_number - b.period_number)
    }

    return NextResponse.json({ fiscalYear })
  } catch (error) {
    console.error('Error fetching fiscal year:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * PUT /api/accounting/fiscal-years/[id]
 * Update a fiscal year (limited fields)
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient() as any
    const { id } = await params
    const body = await request.json()

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

    // Get existing fiscal year
    const { data: existing, error: fetchError } = await supabase
      .from('fiscal_years')
      .select('status')
      .eq('id', id)
      .single()

    if (fetchError || !existing) {
      return NextResponse.json({ error: 'Fiscal year not found' }, { status: 404 })
    }

    // Can only update name if locked
    if (existing.status === 'locked' && (body.start_date || body.end_date || body.status)) {
      return NextResponse.json({ error: 'Cannot modify locked fiscal year' }, { status: 400 })
    }

    // Status change: each transition has its own permission (close / reopen / lock).
    if (body.status && body.status !== existing.status) {
      const permission = fiscalPermissionFor('year', existing.status, body.status)
      if (!permission) {
        return NextResponse.json({ error: `Invalid status transition from ${existing.status} to ${body.status}` }, { status: 400 })
      }
      if (!(await financeAllowed(user.id, permission, () => fiscalLegacyAllowed(userData.roles.role_level), userData.organization_id))) {
        return NextResponse.json({ error: `You do not have permission for this action (${permissionLabel(permission).label}).` }, { status: 403 })
      }
      // The database function re-checks the permission and records the change.
      const { error: statusError } = await supabase.rpc('fiscal_year_set_status', { p_year_id: id, p_status: body.status })
      if (statusError) {
        const denied = statusError.code === '42501'
        return NextResponse.json(
          { error: denied ? `You do not have permission for this action (${permissionLabel(permission).label}).` : statusError.message },
          { status: denied ? 403 : 400 }
        )
      }
    }

    // Renaming stays a Finance settings action.
    if (body.fiscal_year_name) {
      if (!(await financeAllowed(user.id, 'finance.settings.manage', () => userData.roles.role_level <= 20, userData.organization_id))) {
        return NextResponse.json({ error: 'Forbidden - HQ Admin only' }, { status: 403 })
      }
      const { error: renameError } = await supabase
        .from('fiscal_years')
        .update({ fiscal_year_name: body.fiscal_year_name })
        .eq('id', id)
      if (renameError) {
        return NextResponse.json({ error: renameError.message }, { status: 400 })
      }
    }

    const { data: fiscalYear } = await supabase
      .from('fiscal_years')
      .select('*')
      .eq('id', id)
      .single()

    return NextResponse.json({ success: true, fiscalYear })
  } catch (error) {
    console.error('Error updating fiscal year:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/accounting/fiscal-years/[id]
 * Delete a fiscal year (only if open and no journals)
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient() as any
    const { id } = await params

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: userData } = await supabase
      .from('users')
      .select('organization_id, roles!inner(role_level)')
      .eq('id', user.id)
      .single()

    if (!userData || !(await financeAllowed(user.id, 'finance.settings.manage', () => userData.roles.role_level <= 20, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden - HQ Admin only' }, { status: 403 })
    }

    // Check if fiscal year can be deleted
    const { data: existing } = await supabase
      .from('fiscal_years')
      .select('status, start_date, end_date')
      .eq('id', id)
      .single()

    if (!existing) {
      return NextResponse.json({ error: 'Fiscal year not found' }, { status: 404 })
    }

    if (existing.status !== 'open') {
      return NextResponse.json({ error: 'Can only delete open fiscal years' }, { status: 400 })
    }

    // Check for journals in this period
    const { data: journals } = await supabase
      .from('gl_journals')
      .select('id')
      .gte('journal_date', existing.start_date)
      .lte('journal_date', existing.end_date)
      .limit(1)

    if (journals && journals.length > 0) {
      return NextResponse.json({ error: 'Cannot delete fiscal year with posted journals' }, { status: 400 })
    }

    // Delete fiscal year (periods cascade)
    const { error: deleteError } = await supabase
      .from('fiscal_years')
      .delete()
      .eq('id', id)

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 400 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting fiscal year:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
