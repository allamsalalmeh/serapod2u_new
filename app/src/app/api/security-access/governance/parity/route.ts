import { NextResponse } from 'next/server'
import { finishTrace, requireSecurityActor, unavailableResponse } from '@/lib/security-access/admin-api'
import { createTrace, isSchemaMissing } from '@/lib/security-access/diagnostics'

export const dynamic = 'force-dynamic'

/**
 * Parity evidence (security.audit.view), requested only when the Parity section
 * is opened: sa_compat_parity_report evaluates every identity × permission and
 * took 4–8 s per call on staging, so it no longer runs on every page load.
 * A function that is verified absent reports `available: false`; any other
 * failure is 503, never an empty "no differences" result.
 */
export async function GET() {
  const trace = createTrace('security-access/governance/parity')
  const actor = await requireSecurityActor('security.audit.view', trace)
  if (actor instanceof NextResponse) return finishTrace(trace, actor)
  const admin = actor.admin
  const [parity, compat] = await trace.time('parity_reads', () => Promise.all([
    admin.rpc('sa_shadow_parity_summary', { p_since: '30 days' }),
    admin.rpc('sa_compat_parity_report', { p_permission: null }),
  ]))
  for (const [name, r] of [['shadow', parity], ['compat', compat]] as const) {
    if (r.error && !isSchemaMissing(r.error)) {
      trace.fail(`parity_${name}`, r.error)
      return finishTrace(trace, unavailableResponse(trace, 'parity_unavailable'))
    }
  }
  const compatRows: any[] = compat.error ? [] : compat.data || []
  return finishTrace(trace, NextResponse.json({
    shadowParity: parity.error ? [] : parity.data || [],
    shadowParityAvailable: !parity.error,
    compatParity: compat.error ? null : {
      checked: compatRows.length,
      legacyAllowNewDeny: compatRows.filter(r => r.classification === 'LEGACY_ALLOW_NEW_DENY').length,
      legacyDenyNewAllow: compatRows.filter(r => r.classification === 'LEGACY_DENY_NEW_ALLOW').length,
    },
  }, { headers: { 'Cache-Control': 'no-store' } }))
}
