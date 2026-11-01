import { financeAllowed } from '@/lib/security-access/finance'
import { fiscalLegacyAllowed, fiscalPermissionFor } from '@/lib/security-access/fiscal-period-catalog'
import { permissionLabel } from '@/lib/security-access/labels'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * PUT /api/accounting/fiscal-years/[id]/periods/[periodId]
 * Change an accounting period's status. Each transition has its own permission:
 *   future → open   finance.period.open
 *   open   → closed finance.period.close
 *   closed → open   finance.period.reopen
 *   closed → locked finance.fiscal_year.lock
 * The database function fiscal_period_set_status re-checks the same permission and records the change.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; periodId: string }> }
) {
  try {
    const supabase = await createClient() as any
    const { id: fiscalYearId, periodId } = await params
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

    // Validate the period belongs to the fiscal year
    const { data: period, error: fetchError } = await supabase
      .from('fiscal_periods')
      .select('id, status, fiscal_years!inner(status)')
      .eq('id', periodId)
      .eq('fiscal_year_id', fiscalYearId)
      .single()

    if (fetchError || !period) {
      return NextResponse.json({ error: 'Period not found' }, { status: 404 })
    }

    if (period.fiscal_years.status === 'locked') {
      return NextResponse.json({ error: 'Fiscal year is locked' }, { status: 400 })
    }
    if (period.status === 'locked') {
      return NextResponse.json({ error: 'Cannot modify locked period' }, { status: 400 })
    }
    if (!body.status) {
      return NextResponse.json({ error: 'status is required' }, { status: 400 })
    }

    const permission = fiscalPermissionFor('period', period.status, body.status)
    if (!permission) {
      return NextResponse.json({ error: `Invalid status transition from ${period.status} to ${body.status}` }, { status: 400 })
    }

    // Dedicated permission (Security & Access); while not enforced: central Super Admin only.
    if (!(await financeAllowed(user.id, permission, () => fiscalLegacyAllowed(userData.roles.role_level), userData.organization_id))) {
      return NextResponse.json({ error: `You do not have permission for this action (${permissionLabel(permission).label}).` }, { status: 403 })
    }

    const { error: updateError } = await supabase.rpc('fiscal_period_set_status', {
      p_period_id: periodId,
      p_status: body.status,
    })

    if (updateError) {
      const denied = updateError.code === '42501'
      return NextResponse.json(
        { error: denied ? `You do not have permission for this action (${permissionLabel(permission).label}).` : updateError.message },
        { status: denied ? 403 : 400 }
      )
    }

    const { data: updatedPeriod } = await supabase
      .from('fiscal_periods')
      .select('*')
      .eq('id', periodId)
      .single()

    return NextResponse.json({ success: true, period: updatedPeriod })
  } catch (error) {
    console.error('Error updating fiscal period:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
