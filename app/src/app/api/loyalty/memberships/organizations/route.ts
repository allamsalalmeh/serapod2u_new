import { guardUserOperation } from '@/lib/security-access/operation'
import { canReadOrganization, readableOrganizations } from '@/lib/security-access/scope'
import { NextRequest, NextResponse } from 'next/server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const MAX_ORGANIZATION_IDS = 1000
const SUPABASE_IN_CHUNK_SIZE = 100

function postgrestError(error: any) {
  return {
    message: typeof error?.message === 'string' ? error.message : 'Unknown Supabase error',
    code: typeof error?.code === 'string' ? error.code : null,
    details: typeof error?.details === 'string' ? error.details : null,
    hint: typeof error?.hint === 'string' ? error.hint : null,
  }
}

function uniqueStringIds(value: unknown) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(
    value
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean),
  )).slice(0, MAX_ORGANIZATION_IDS)
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

async function selectInChunks<T>(
  buildQuery: (ids: string[]) => PromiseLike<{ data: T[] | null; error: any }>,
  ids: string[],
) {
  const rows: T[] = []
  for (const idChunk of chunks(ids, SUPABASE_IN_CHUNK_SIZE)) {
    const { data, error } = await buildQuery(idChunk)
    if (error) return { data: rows, error }
    rows.push(...(data || []))
  }
  return { data: rows, error: null }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const admin = createAdminClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED', details: null, hint: null } }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'customer.program.manage')
    if (saDenied) return saDenied

    const body = await request.json().catch(() => null)
    const requestedOrgIds = uniqueStringIds(body?.organizationIds)
    if (requestedOrgIds.length === 0) {
      return NextResponse.json({ memberships: [] })
    }

    const { data: caller, error: callerError } = await admin
      .from('users')
      .select('id, organization_id, is_active, roles:role_code(role_level)')
      .eq('id', user.id)
      .maybeSingle()

    if (callerError) {
      console.error('[loyalty/memberships/organizations] caller lookup failed:', postgrestError(callerError))
      return NextResponse.json({ error: postgrestError(callerError) }, { status: 500 })
    }

    const role = Array.isArray((caller as any)?.roles) ? (caller as any).roles[0] : (caller as any)?.roles
    const roleLevel = Number(role?.role_level ?? 999)
    const callerOrgId = caller?.organization_id

    if (!caller?.is_active || !callerOrgId) {
      return NextResponse.json({ error: { message: 'Forbidden', code: 'FORBIDDEN', details: null, hint: null } }, { status: 403 })
    }

    const { data: requestedOrgs, error: orgsError } = await selectInChunks<{
      id: string
      parent_org_id: string | null
      is_active: boolean | null
    }>(
      (ids) => admin
        .from('organizations')
        .select('id, parent_org_id, is_active')
        .in('id', ids)
        .eq('is_active', true),
      requestedOrgIds,
    )

    if (orgsError) {
      console.error('[loyalty/memberships/organizations] organization scope lookup failed:', postgrestError(orgsError))
      return NextResponse.json({ error: postgrestError(orgsError) }, { status: 500 })
    }

    // Which requested organizations the caller may read is an S&A scope
    // decision (customer.program.manage readable organizations) once enforced;
    // until then the historical rule (role_level <= 50, or own / child
    // organization) decides.
    const scope = await readableOrganizations(user.id, 'customer.program.manage', () => ({
      all: false,
      organizationIds: (requestedOrgs || [])
        .filter((org) => roleLevel <= 50 || org.id === callerOrgId || org.parent_org_id === callerOrgId)
        .map((org) => org.id),
    }))
    const allowedOrgIds = (requestedOrgs || [])
      .filter((org) => canReadOrganization(scope, org.id))
      .map((org) => org.id)

    if (allowedOrgIds.length === 0) {
      return NextResponse.json({ memberships: [] })
    }

    const { data: memberships, error: membershipsError } = await selectInChunks<{
      member_organization_id: string
      status: string | null
      loyalty_program_id: string | null
      owner_organization_id: string | null
    }>(
      (ids) => (admin as any)
        .from('loyalty_program_organization_memberships')
        .select('member_organization_id, status, loyalty_program_id, owner_organization_id')
        .in('member_organization_id', ids),
      allowedOrgIds,
    )

    if (membershipsError) {
      console.error('[loyalty/memberships/organizations] membership lookup failed:', postgrestError(membershipsError))
      return NextResponse.json({ error: postgrestError(membershipsError) }, { status: 500 })
    }

    const programPairs = Array.from(new Set(
      (memberships || [])
        .map((membership: any) => `${membership.loyalty_program_id}:${membership.owner_organization_id}`),
    ))

    const programIds = Array.from(new Set((memberships || []).map((membership: any) => membership.loyalty_program_id).filter(Boolean)))
    const ownerOrgIds = Array.from(new Set((memberships || []).map((membership: any) => membership.owner_organization_id).filter(Boolean)))

    let programByPair = new Map<string, { code: string | null; name: string | null }>()
    if (programIds.length > 0 && ownerOrgIds.length > 0) {
      const { data: programs, error: programsError } = await admin
        .from('loyalty_programs')
        .select('id, organization_id, code, name')
        .in('id', programIds)
        .in('organization_id', ownerOrgIds)

      if (programsError) {
        console.error('[loyalty/memberships/organizations] program lookup failed:', postgrestError(programsError))
        return NextResponse.json({ error: postgrestError(programsError) }, { status: 500 })
      }

      programByPair = new Map(
        (programs || [])
          .filter((program) => programPairs.includes(`${program.id}:${program.organization_id}`))
          .map((program) => [`${program.id}:${program.organization_id}`, { code: program.code, name: program.name }]),
      )
    }

    return NextResponse.json({
      memberships: (memberships || []).map((membership: any) => ({
        member_organization_id: membership.member_organization_id,
        status: membership.status,
        loyalty_programs: programByPair.get(`${membership.loyalty_program_id}:${membership.owner_organization_id}`) || null,
      })),
    })
  } catch (error: any) {
    console.error('[loyalty/memberships/organizations] failed:', error)
    return NextResponse.json({
      error: {
        message: error?.message || 'Failed to load organization loyalty memberships.',
        code: error?.code || 'INTERNAL_ERROR',
        details: error?.details || null,
        hint: error?.hint || null,
      },
    }, { status: 500 })
  }
}
