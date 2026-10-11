import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { commissionErrorOf } from '@/lib/hr/commission/errors'
import { parseCommissionAccess, type CommissionAccess, type CommissionPermission } from '@/lib/security-access/commission'

/**
 * Commission API context. Access is decided by the DATABASE (hr_commission_my_access → hr_commission_allowed: the S&A
 * decision while HR compensation is S&A-authoritative, otherwise Super Admin of the company only), the same rule every
 * hr_commission_* function and RLS policy enforces. Routes call the database with the caller's own session, so a route
 * check can never widen access: it only fails earlier with a clean status.
 */
export interface CommissionContext {
  supabase: any
  userId: string
  access: CommissionAccess
}

export async function commissionContext(): Promise<CommissionContext | NextResponse> {
  const supabase = (await createClient()) as any
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { data, error: accessError } = await supabase.rpc('hr_commission_my_access')
  if (accessError) {
    console.error('[commission] access unavailable', accessError.code)
    return NextResponse.json({ success: false, error: 'Commission access could not be checked.', code: 'commission_unavailable' }, { status: 503 })
  }
  return { supabase, userId: user.id, access: parseCommissionAccess(data) }
}

/** null when the caller holds any of the permissions, otherwise 403. */
export function requireAny(ctx: CommissionContext, ...permissions: CommissionPermission[]): NextResponse | null {
  if (permissions.some((p) => ctx.access[p])) return null
  return NextResponse.json({ success: false, error: 'You do not have permission for this commission action.', code: 'sa_forbidden', permission: permissions[0] }, { status: 403 })
}

export function dbError(error: { message?: string; code?: string } | null | undefined): NextResponse {
  const mapped = commissionErrorOf(error?.message)
  if (mapped.status === 500) console.error('[commission] database error', error?.code, error?.message)
  return NextResponse.json({ success: false, error: mapped.message, code: error?.code ?? null }, { status: mapped.status })
}

/** Calls a commission RPC with the caller's session; returns its data or an error response. */
export async function rpc<T = any>(ctx: CommissionContext, fn: string, args: Record<string, unknown>): Promise<{ data: T } | { response: NextResponse }> {
  const { data, error } = await ctx.supabase.rpc(fn, args)
  if (error) return { response: dbError(error) }
  return { data: data as T }
}

export async function readJson(request: Request): Promise<Record<string, any>> {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
export const text = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
export const badRequest = (error: string) => NextResponse.json({ success: false, error }, { status: 400 })

/** Report filters from the query string (ids only; anything else is ignored). */
export function reportFilters(url: URL) {
  const pick = (k: string) => { const v = url.searchParams.get(k); return isUuid(v) ? v : null }
  return { businessUnitId: pick('businessUnitId'), employeeId: pick('employeeId'), departmentId: pick('departmentId') }
}
