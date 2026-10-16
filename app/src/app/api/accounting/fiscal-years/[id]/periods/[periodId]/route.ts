import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * PUT /api/accounting/fiscal-years/[id]/periods/[periodId]
 * Update a fiscal period (mainly status changes)
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
      .select('roles!inner(role_level)')
      .eq('id', user.id)
      .single()

    if (!userData || !(await financeAllowed(user.id, 'finance.settings.manage', () => userData.roles.role_level <= 20, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden - HQ Admin only' }, { status: 403 })
    }

    // Validate the period belongs to the fiscal year
    const { data: period, error: fetchError } = await supabase
      .from('fiscal_periods')
      .select('*, fiscal_years!inner(status)')
      .eq('id', periodId)
      .eq('fiscal_year_id', fiscalYearId)
      .single()

    if (fetchError || !period) {
      return NextResponse.json({ error: 'Period not found' }, { status: 404 })
    }

    // Check fiscal year is not locked
    if (period.fiscal_years.status === 'locked') {
      return NextResponse.json({ error: 'Fiscal year is locked' }, { status: 400 })
    }

    // Validate status transitions
    const validTransitions: Record<string, string[]> = {
      'future': ['open'],
      'open': ['closed'],
      'closed': ['open', 'locked'], // Can reopen or lock
      'locked': [] // Cannot change
    }

    if (body.status) {
      if (period.status === 'locked') {
        return NextResponse.json({ error: 'Cannot modify locked period' }, { status: 400 })
      }

      if (!validTransitions[period.status]?.includes(body.status)) {
        return NextResponse.json({ 
          error: `Invalid status transition from ${period.status} to ${body.status}` 
        }, { status: 400 })
      }
    }

    const updateData: any = {}
    if (body.status) {
      updateData.status = body.status
      if (body.status === 'closed' || body.status === 'locked') {
        updateData.closed_at = new Date().toISOString()
        updateData.closed_by = user.id
      } else if (body.status === 'open') {
        updateData.closed_at = null
        updateData.closed_by = null
      }
    }

    const { data: updatedPeriod, error: updateError } = await supabase
      .from('fiscal_periods')
      .update(updateData)
      .eq('id', periodId)
      .select()
      .single()

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 400 })
    }

    return NextResponse.json({ success: true, period: updatedPeriod })
  } catch (error) {
    console.error('Error updating fiscal period:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
