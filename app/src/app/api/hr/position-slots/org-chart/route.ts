import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getHrAuthContext } from '@/lib/server/hrAccess'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/position-slots/org-chart — multi-root, as-of-date position
 * hierarchy. Supports co-equal Managing Directors (multiple roots); no dummy CEO
 * node is synthesized. Falls back to a client-side tree build when the RPC is
 * not yet applied.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = (await createClient()) as any
    const ctxResult = await getHrAuthContext(supabase)
    if (!ctxResult.success || !ctxResult.data) {
      return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
    }
    const { organizationId } = ctxResult.data
    if (!organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })

    const asOf = request.nextUrl.searchParams.get('as_of') ?? new Date().toISOString().slice(0, 10)
    const admin = createAdminClient() as any

    const { data, error } = await admin.rpc('hr_position_org_chart', {
      p_organization_id: organizationId,
      p_as_of: asOf,
    })

    if (error) {
      // RPC not applied yet — fall back to a direct query of active PRIMARY edges.
      const { data: rels, error: relError } = await admin
        .from('hr_position_relationships')
        .select('position_id, parent_position_id, relationship_type')
        .eq('organization_id', organizationId)
        .eq('is_active', true)
        .lte('effective_from', asOf)
      if (relError) return NextResponse.json({ success: false, error: relError.message }, { status: 500 })

      const { data: slots } = await admin
        .from('hr_position_slots')
        .select('id, position_code, name, org_tier, lifecycle_status')
        .eq('organization_id', organizationId)
        .eq('is_active', true)

      return NextResponse.json({
        success: true,
        edges: rels ?? [],
        nodes: slots ?? [],
      })
    }

    return NextResponse.json({ success: true, nodes: data ?? [] })
  } catch (error: any) {
    console.error('Failed to load position org chart:', error)
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
  }
}
