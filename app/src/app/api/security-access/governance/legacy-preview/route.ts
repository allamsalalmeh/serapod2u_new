import { NextRequest, NextResponse } from 'next/server'
import { requireSecurityActor } from '@/lib/security-access/admin-api'

export const dynamic = 'force-dynamic'
const KEYS = ['legacy-user', 'legacy-sa', 'legacy-hq', 'legacy-power-user', 'legacy-manager', 'legacy-shop']
/** Owner-only, read-only, paginated dry run. No retire/restore or grant operation is exposed. */
export async function GET(request: NextRequest) {
  const actor = await requireSecurityActor('security.audit.view')
  if (actor instanceof NextResponse) return actor
  const root = await actor.admin.rpc('sa_actor_is_root', { p_actor: actor.userId })
  if (root.error) return NextResponse.json({ error: 'Owner authorization unavailable' }, { status: 503 })
  if (root.data !== true) return NextResponse.json({ error: 'Root Access required' }, { status: 403 })
  const role = request.nextUrl.searchParams.get('role') ?? 'legacy-user'
  const page = Number(request.nextUrl.searchParams.get('page') ?? 0)
  if (!KEYS.includes(role) || !Number.isInteger(page) || page < 0 || page > 1000) return NextResponse.json({ error: 'Invalid preview filter' }, { status: 400 })
  const [overview, impact, version] = await Promise.all([
    actor.admin.rpc('sa_legacy_compat_overview'),
    actor.admin.rpc('sa_legacy_cutover_impact', { p_role_key: role }, { count: 'exact' }).range(page * 100, page * 100 + 99),
    actor.admin.rpc('sa_legacy_preview_version'),
  ])
  if (overview.error || impact.error) return NextResponse.json({ error: 'Legacy preview unavailable; verify owner-run SQL prerequisites' }, { status: 503 })
  return NextResponse.json({ overview: overview.data, rows: impact.data, total: impact.count, page, pageSize: 100,
    scopeCoverageVerified: !version.error && version.data === '20261216100000',
    warning: 'Read-only snapshot. No access changed. Scope coverage is conservative after the preview correction; hierarchy and delegation require manual review. Review replacements per organization before owner-controlled retirement.',
  })
}
