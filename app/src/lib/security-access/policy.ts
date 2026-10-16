import type {
  AuthorizationDecisionValue,
  AuthorizationRequest,
  MatchedAssignment,
  ResolvedScope,
  ScopeType,
} from './types'

export interface PolicyMembership {
  id: string
  organizationId: string
  status: string
  effectiveFrom: string | null
  effectiveUntil: string | null
}

export interface PolicyAssignment extends MatchedAssignment {
  status: string
  effectiveFrom: string | null
  effectiveUntil: string | null
  permissions: string[]
  scopes: Array<{ type: ScopeType; value: string }>
}

export interface PolicyInput {
  actorActive: boolean
  memberships: PolicyMembership[]
  assignments: PolicyAssignment[]
}

const activeAt = (status: string, from: string | null, until: string | null, now: Date) =>
  status === 'active' && (!from || new Date(from) <= now) && (!until || new Date(until) > now)

function scopeMatches(type: ScopeType, value: string, request: AuthorizationRequest): boolean | null {
  const resource = request.resource
  if (type === 'organization') return resource.organizationId ? resource.organizationId === value : null
  if (type === 'department') return resource.departmentId ? resource.departmentId === value : null
  if (type === 'warehouse') {
    if (resource.warehouseId) return resource.warehouseId === value
    // A warehouse is an organization: a resource of exactly that organization is the warehouse's (sa_scope_matches,
    // 20261109100000). The parent HQ, a sibling or a descendant still lacks warehouse context.
    return resource.organizationId === value ? true : null
  }
  if (type === 'own_record') return resource.ownerUserId ? resource.ownerUserId === request.actorId : null
  if (type === 'direct_reports') return null // reserved for a future reporting-line resolver
  return null
}

export function evaluateNewPolicy(request: AuthorizationRequest, input: PolicyInput): {
  decision: AuthorizationDecisionValue
  reasonCode: 'ALLOWED_BY_ASSIGNMENT' | 'ACCOUNT_INACTIVE' | 'MISSING_MEMBERSHIP' | 'MISSING_ASSIGNMENT' | 'MISSING_PERMISSION' | 'MISSING_CONTEXT' | 'SCOPE_MISMATCH'
  matchedAssignments: MatchedAssignment[]
  resolvedScopes: ResolvedScope[]
} {
  const now = request.context?.now ?? new Date()
  if (!input.actorActive) return { decision: 'DENY', reasonCode: 'ACCOUNT_INACTIVE', matchedAssignments: [], resolvedScopes: [] }

  const activeMembershipIds = new Set(input.memberships
    .filter(m => activeAt(m.status, m.effectiveFrom, m.effectiveUntil, now))
    .filter(m => !request.resource.organizationId || m.organizationId === request.resource.organizationId)
    .map(m => m.id))
  if (!activeMembershipIds.size) return { decision: 'DENY', reasonCode: 'MISSING_MEMBERSHIP', matchedAssignments: [], resolvedScopes: [] }

  const activeAssignments = input.assignments.filter(a =>
    activeMembershipIds.has(a.membershipId) && activeAt(a.status, a.effectiveFrom, a.effectiveUntil, now))
  if (!activeAssignments.length) return { decision: 'DENY', reasonCode: 'MISSING_ASSIGNMENT', matchedAssignments: [], resolvedScopes: [] }

  const permitted = activeAssignments.filter(a => a.permissions.includes(request.permission))
  if (!permitted.length) return { decision: 'DENY', reasonCode: 'MISSING_PERMISSION', matchedAssignments: [], resolvedScopes: [] }

  const resolvedScopes: ResolvedScope[] = []
  let missingContext = false
  const matched = permitted.filter(assignment => {
    if (!assignment.scopes.length) return false // no implicit unscoped authority
    const results = assignment.scopes.map(scope => {
      const match = scopeMatches(scope.type, scope.value, request)
      if (match === null) missingContext = true
      resolvedScopes.push({ assignmentId: assignment.assignmentId, scopeType: scope.type, scopeValue: scope.value, matched: match === true })
      return match
    })
    return results.some(Boolean)
  })

  if (matched.length) {
    return { decision: 'ALLOW', reasonCode: 'ALLOWED_BY_ASSIGNMENT', matchedAssignments: matched, resolvedScopes }
  }
  return {
    decision: 'DENY',
    reasonCode: missingContext ? 'MISSING_CONTEXT' : 'SCOPE_MISMATCH',
    matchedAssignments: permitted,
    resolvedScopes,
  }
}
