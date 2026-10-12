import 'server-only'
import type { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { guardUserOperation } from '@/lib/security-access/operation'
import type { LegacyEvaluator } from '@/lib/security-access/authorization'
import { decidedPerWarehouse, grantedWarehousesFrom } from '@/lib/security-access/warehouse-reach'

/**
 * The warehouses named by the person's live grants (see grantedWarehousesFrom). Read fresh on every call: a revoke,
 * expiry or restore is seen by the next request. Throws when the grants cannot be read (callers report "unavailable").
 */
export async function grantedWarehouseIds(userId: string): Promise<string[]> {
  const admin = createAdminClient() as any
  const { data, error } = await admin
    .from('sa_role_assignments')
    .select('status, effective_from, effective_until, scopes:sa_assignment_scopes(scope:sa_scope_definitions(scope_type, scope_value, status))')
    .eq('user_id', userId)
    .eq('status', 'active')
  if (error || !Array.isArray(data)) throw new Error('warehouse_reach_unavailable')
  return grantedWarehousesFrom(data)
}

/**
 * Module-entry guard for a function decided per warehouse (WAREHOUSE_REACH_PERMISSIONS): allowed on the caller's own
 * organization, or else on one of the warehouses their grants name. Use it only where the route's data is then limited
 * to the caller's scope by the database (RLS / sa_readable_organizations) or by a per-row warehouse check. Other
 * permissions behave exactly like guardUserOperation. Returns null when the operation may proceed.
 */
export async function guardUserOperationInReach(
  userId: string,
  permission: string,
  options: { legacy?: LegacyEvaluator; resourceType?: string } = {},
): Promise<NextResponse | null> {
  const denied = await guardUserOperation(userId, permission, options)
  if (!denied || denied.status !== 403 || !decidedPerWarehouse(permission)) return denied
  let warehouses: string[]
  try {
    warehouses = await grantedWarehouseIds(userId)
  } catch {
    return denied
  }
  for (const warehouseId of warehouses) {
    const again = await guardUserOperation(userId, permission, { ...options, organizationId: warehouseId, warehouseId })
    if (!again) return null
    if (again.status !== 403) return again
  }
  return denied
}
