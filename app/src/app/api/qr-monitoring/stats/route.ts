import { createClient as createSessionClient } from '@/lib/supabase/server'
import { legacyRoleLevelAtMost } from '@/lib/security-access/legacy-rules'
import { guardUserOperation, userAllowed } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isPartnerOrgType } from '@/lib/qr-batch-access'

/**
 * GET /api/qr-monitoring/stats
 *
 * Returns aggregated QR verification statistics for the recovery monitor dashboard.
 * Requires HQ admin (role_level <= 50) — enforced via RLS on the views.
 *
 * Note: The views (v_qr_recovery_summary, etc.) are created by migration
 * 20260404_qr_verification_log.sql and are not yet in the generated TypeScript types.
 * We use `as any` to bypass the typed client until types are regenerated.
 */
export async function GET(request: NextRequest) {
  try {
    {
      const sessionClient = await createSessionClient()
      const { data: { user: actor } } = await sessionClient.auth.getUser()
      if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      // Service-role read: authorize explicitly (it previously served any
      // signed-in account).
      const saDenied = await guardUserOperation(actor.id, 'qr.batch.manage', { legacy: () => legacyRoleLevelAtMost(actor.id, 50) })
      if (saDenied) return saDenied
      // These are system-wide verification statistics (not scoped to any order). qr.batch.manage is
      // also held by manufacturers for their own batches, so partners never receive this view.
      const { data: actorOrg } = await (createAdminClient() as any).from('users').select('organizations:organization_id(org_type_code)').eq('id', actor.id).maybeSingle()
      if (isPartnerOrgType(String(actorOrg?.organizations?.org_type_code || ''))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }
    const supabaseAdmin = createAdminClient() as any

    // Fetch all three views in parallel
    const [summaryRes, candidatesRes, hourlyRes] = await Promise.all([
      supabaseAdmin
        .from('v_qr_recovery_summary')
        .select('*'),
      supabaseAdmin
        .from('v_qr_recovery_candidates')
        .select('*')
        .limit(200),
      supabaseAdmin
        .from('v_qr_scan_hourly_stats')
        .select('*')
        .limit(720), // 30 days × 24 hours
    ])

    if (summaryRes.error) {
      console.error('Error fetching summary:', summaryRes.error)
    }
    if (candidatesRes.error) {
      console.error('Error fetching candidates:', candidatesRes.error)
    }

    return NextResponse.json({
      success: true,
      data: {
        summary: summaryRes.data ?? [],
        candidates: candidatesRes.data ?? [],
        hourly: hourlyRes.data ?? [],
      },
    })
  } catch (error) {
    console.error('Error in qr-monitoring stats:', error)
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}
