import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { bulkRemovalPreview } from '@/lib/identity/bulk-removal'

// ─── POST /api/hr/employees/bulk-removal/preview ─────────────────────────────
//
// Read-only eligibility preview for a multi-employee selection in HR → People →
// Employees. Every identity is previewed by the canonical services
// (identity_deletion_preview / identity_archive_preview, entry=hr). The
// organization is the caller's own, loaded by the server — never a body field —
// and a target outside it is reported as blocked without description.
//
// Body: { user_ids: string[] }
// Response: { success, data: { targets: BulkRemovalEligibility[], summary } }
//
// Nothing is changed here. The confirmation contract is issued separately by
// /bulk-removal/plan and executed by /bulk-removal only.

async function currentActor() {
  const supabase = (await createClient()) as any
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  const { data: profile, error: profileError } = await supabase
    .from('users').select('id, organization_id').eq('id', user.id).single()
  if (profileError || !profile?.id || !profile.organization_id) return null
  return { id: profile.id as string, organizationId: profile.organization_id as string }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await currentActor()
    if (!actor) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const body = await request.json().catch(() => ({}))
    const result = await bulkRemovalPreview({
      actorId: actor.id,
      organizationId: actor.organizationId,
      userIds: body?.user_ids,
    })
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.message, code: result.code }, { status: result.status })
    }
    return NextResponse.json({ success: true, data: { targets: result.targets, summary: result.summary } })
  } catch {
    return NextResponse.json({ success: false, error: 'The preview did not complete. Nothing was changed.' }, { status: 500 })
  }
}
