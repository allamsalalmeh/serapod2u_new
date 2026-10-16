import { NextRequest, NextResponse } from 'next/server'
import { requireSelfServiceActor } from '@/lib/security-access/admin-api'
import { currentMigrationMode } from '@/lib/security-access/authorization'
import { isNewAuthoritative } from '@/lib/security-access/enforcement'
import { delegatedAdministrationEnabled } from '@/lib/security-access/delegation'
import { resolveWarehouseResourceContext } from '@/lib/security-access/resource-context'

export const dynamic = 'force-dynamic'

const PERMISSION_KEY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PERMISSIONS = 20

/**
 * GET /api/security-access/me/capabilities?permissions=a.b.c,d.e.f[&organizationId=][&warehouseId=]
 *
 * Read-only view of the caller's own Security & Access answers, so the UI can
 * show what the server will allow. For each permission:
 *   allowed    the S&A decision (sa_evaluate_permission) in the organization
 *              (default: the caller's own); with warehouseId, for that
 *              warehouse (same context the warehouse routes use, so
 *              warehouse-scoped grants are answered)
 *   enforced   whether S&A is authoritative for it (NEW_ENFORCED /
 *              LEGACY_RETIRED); until then the UI keeps its legacy rule
 *   unavailable present (true) when the mode or decision could not be read;
 *              allowed is then false but it is not a denial
 * No decision audit rows are written (nothing is being authorized here) and
 * the server still decides every operation independently.
 */
export async function GET(request: NextRequest) {
  const actor = await requireSelfServiceActor()
  if (actor instanceof NextResponse) return actor

  const requested = (request.nextUrl.searchParams.get('permissions') || '')
    .split(',').map(p => p.trim()).filter(Boolean)
  const permissions = Array.from(new Set(requested)).slice(0, MAX_PERMISSIONS)
  if (permissions.length === 0 || permissions.some(p => !PERMISSION_KEY.test(p))) {
    return NextResponse.json({ error: 'permissions must be a comma-separated list of permission keys' }, { status: 400 })
  }
  const orgParam = request.nextUrl.searchParams.get('organizationId')
  if (orgParam && !UUID.test(orgParam)) {
    return NextResponse.json({ error: 'organizationId must be a UUID' }, { status: 400 })
  }
  const warehouseParam = request.nextUrl.searchParams.get('warehouseId')
  if (warehouseParam && !UUID.test(warehouseParam)) {
    return NextResponse.json({ error: 'warehouseId must be a UUID' }, { status: 400 })
  }
  let organizationId = orgParam || actor.organizationId
  let context: Record<string, string> = organizationId ? { organization_id: organizationId } : {}
  if (warehouseParam) {
    try {
      const resource = await resolveWarehouseResourceContext(actor.organizationId, warehouseParam)
      organizationId = resource.organizationId
      context = { organization_id: resource.organizationId, warehouse_id: resource.warehouseId }
    } catch {
      return NextResponse.json({ error: 'Warehouse context unavailable' }, { status: 503 })
    }
  }

  // A lookup that failed is reported as unavailable (still allowed: false), so a screen can tell
  // "could not check" from a real denial and offer a retry instead of hiding the action.
  const capabilities: Record<string, { allowed: boolean; enforced: boolean; unavailable?: true }> = {}
  await Promise.all(permissions.map(async (permission) => {
    let enforced = false
    let allowed = false
    let unavailable = false
    try {
      enforced = isNewAuthoritative(await currentMigrationMode(permission))
      const { data, error } = await actor.admin.rpc('sa_evaluate_permission', {
        p_actor: actor.userId,
        p_permission: permission,
        p_context: context,
        p_include_delegation: true,
      })
      allowed = !error && data?.decision === 'ALLOW'
      unavailable = Boolean(error)
    } catch {
      allowed = false
      unavailable = true
    }
    capabilities[permission] = unavailable ? { allowed, enforced, unavailable: true } : { allowed, enforced }
  }))

  // Whether an explicit Security & Access assignment also counts while a security.* permission is still on a legacy mode.
  const delegatedAdministration = await delegatedAdministrationEnabled(actor.admin)
  return NextResponse.json({ organizationId, capabilities, delegatedAdministration }, { headers: { 'Cache-Control': 'no-store' } })
}
