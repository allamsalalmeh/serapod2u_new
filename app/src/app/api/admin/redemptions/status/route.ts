import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { guardUserOperation } from '@/lib/security-access/operation'
import { planRedemptionStatusChange } from '@/lib/engagement/redemption-status'

/**
 * POST /api/admin/redemptions/status
 * Body: { transaction_id, status, notes? }
 *
 * Moves a redemption one step (Process / Fulfill / Cancel) for staff holding
 * customer.redemption.manage. Redemption rows carry no company_id, so the
 * points_transactions update policy refuses them under S&A new mode; the change
 * is made server-side after the permission check, and only for a redemption in
 * the caller's own Redemption History.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'customer.redemption.manage')
    if (saDenied) return saDenied

    const admin = createAdminClient() as any
    const { data: profile } = await admin.from('users').select('organization_id').eq('id', user.id).maybeSingle()
    if (!profile?.organization_id) {
      return NextResponse.json({ success: false, error: 'User has no organization assigned' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const transactionId = typeof body.transaction_id === 'string' ? body.transaction_id : ''
    const status = typeof body.status === 'string' ? body.status : ''
    if (!transactionId || !status) {
      return NextResponse.json({ success: false, error: 'transaction_id and status are required' }, { status: 400 })
    }

    const { data: visible } = await admin
      .from('v_admin_redemptions')
      .select('id')
      .eq('id', transactionId)
      .eq('company_id', profile.organization_id)
      .maybeSingle()
    if (!visible) {
      return NextResponse.json({ success: false, error: 'Redemption not found' }, { status: 404 })
    }

    const { data: row } = await admin
      .from('points_transactions')
      .select('id, fulfillment_status')
      .eq('id', transactionId)
      .eq('transaction_type', 'redeem')
      .maybeSingle()
    if (!row) {
      return NextResponse.json({ success: false, error: 'Redemption not found' }, { status: 404 })
    }

    const plan = planRedemptionStatusChange({
      current: row.fulfillment_status,
      next: status,
      actorId: user.id,
      now: new Date().toISOString(),
      notes: body.notes,
    })
    if ('error' in plan) {
      return NextResponse.json({ success: false, error: plan.error }, { status: 409 })
    }

    // Only if nobody changed it in the meantime.
    let update = admin.from('points_transactions').update(plan.update).eq('id', transactionId).eq('transaction_type', 'redeem')
    update = row.fulfillment_status == null ? update.is('fulfillment_status', null) : update.eq('fulfillment_status', row.fulfillment_status)
    const { data: updated, error } = await update.select('id, fulfillment_status')
    if (error) {
      console.error('[admin/redemptions/status] update failed:', error.message)
      return NextResponse.json({ success: false, error: 'Failed to update the redemption' }, { status: 500 })
    }
    if (!updated || updated.length !== 1) {
      return NextResponse.json({ success: false, error: 'This redemption was just changed by someone else. Refresh and try again.' }, { status: 409 })
    }

    return NextResponse.json({ success: true, status: updated[0].fulfillment_status })
  } catch (error: any) {
    console.error('[admin/redemptions/status] error:', error?.message || error)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
