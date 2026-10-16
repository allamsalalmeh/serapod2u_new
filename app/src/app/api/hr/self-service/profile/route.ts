import { NextRequest, NextResponse } from 'next/server'
import { noStore, requireSelfService } from '@/lib/server/hr/self-service'
import { validAddress } from '@/lib/server/hr/profile-edit'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/hr/self-service/profile — Category A direct self-edit (own record).
 *
 * Only the permitted basic fields are accepted (current address today; contact number goes through the existing verified
 * phone flow and emergency contact needs its own field). The employee is always the authenticated account; any employee
 * id in the body is ignored. Every accepted change is validated and written to hr_profile_edit_audit with the
 * before/after value. Salary, payroll and identity fields are never editable here.
 */
export async function PATCH(request: NextRequest) {
  const ctx = await requireSelfService({ requireReadyEmployee: true })
  if (!ctx.ok) return ctx.response

  const body = await request.json().catch(() => ({}))
  const address = body?.address

  if (!validAddress(address)) {
    return NextResponse.json({ success: false, error: 'A valid current address (1-255 characters) is required.' }, { status: 400, headers: noStore })
  }

  const { actor, admin } = ctx

  // Read the current value for the audit trail (before).
  const { data: current } = await admin
    .from('users')
    .select('address')
    .eq('id', actor.userId)
    .eq('organization_id', actor.organizationId)
    .maybeSingle()

  const before = current?.address ?? null
  const { error } = await admin
    .from('users')
    .update({ address: address.trim() })
    .eq('id', actor.userId)
    .eq('organization_id', actor.organizationId)

  if (error) return NextResponse.json({ success: false, error: 'Profile update failed' }, { status: 500, headers: noStore })

  await admin.from('hr_profile_edit_audit').insert({
    organization_id: actor.organizationId,
    user_id: actor.userId,
    field: 'address',
    before_value: before,
    after_value: address.trim(),
    changed_by: actor.userId,
  })

  return NextResponse.json({ success: true, address: address.trim() }, { headers: noStore })
}
