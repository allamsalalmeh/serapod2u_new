import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { bulkRemovalReviewPlan } from '@/lib/identity/bulk-removal'

// ─── POST /api/hr/employees/bulk-removal/plan ────────────────────────────────
//
// Validates the administrator's reviewed per-target actions against fresh,
// authoritative previews and issues the bulk confirmation contract:
//   - one server-generated phrase (REMOVE <n> EMPLOYEES),
//   - a plan reference and a server-set expiry,
//   - a signed, short-lived token bound to actor, organization, request id,
//     exact target UUIDs, each chosen action and each target's preview state.
//
// A plan that asks for permanent deletion where the database does not allow it
// is refused. No archive substitution is ever proposed automatically.
//
// Body: { plan: [{ user_id, action: 'delete'|'archive', employment_end, release_identifiers }] }

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
    const result = await bulkRemovalReviewPlan({
      actorId: actor.id,
      organizationId: actor.organizationId,
      plan: body?.plan,
    })
    if (!result.ok) {
      return NextResponse.json({
        success: false, error: result.message, code: result.code,
        data: { problems: result.problems, targets: result.targets },
      }, { status: result.status })
    }
    return NextResponse.json({ success: true, data: result })
  } catch {
    return NextResponse.json({ success: false, error: 'The confirmation could not be prepared. Nothing was changed.' }, { status: 500 })
  }
}
