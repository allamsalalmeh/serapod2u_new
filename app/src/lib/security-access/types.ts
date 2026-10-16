export const MIGRATION_MODES = ['LEGACY_ENFORCED', 'SHADOW', 'NEW_ENFORCED', 'LEGACY_RETIRED'] as const
export type MigrationMode = typeof MIGRATION_MODES[number]

export type AuthorizationDecisionValue = 'ALLOW' | 'DENY'

export type ScopeType =
  | 'organization'
  | 'department'
  | 'warehouse'
  | 'own_record'
  | 'direct_reports'
  | (string & {})

export interface AuthorizationResource {
  type: string
  id?: string | null
  organizationId?: string | null
  departmentId?: string | null
  warehouseId?: string | null
  ownerUserId?: string | null
  /** Generic typed-scope attributes (territory, campaign, program, ...) from trusted data. */
  attributes?: Record<string, string>
}

export interface AuthorizationContext {
  correlationId?: string | null
  requestId?: string | null
  now?: Date
  explainOnly?: boolean
  attributes?: Record<string, string | number | boolean | null>
}

export interface AuthorizationRequest {
  actorId: string
  permission: string
  resource: AuthorizationResource
  context?: AuthorizationContext
}

export interface MatchedAssignment {
  assignmentId: string
  roleId: string
  roleKey: string
  roleName: string
  membershipId: string
}

export interface ResolvedScope {
  assignmentId: string
  scopeType: ScopeType
  scopeValue: string
  matched: boolean
}

export type AuthorizationReasonCode =
  | 'ALLOWED_BY_ASSIGNMENT'
  | 'ALLOWED_BY_DELEGATION'
  | 'ALLOWED_BY_ROOT_ACCESS'
  | 'ACCOUNT_INACTIVE'
  | 'MISSING_MEMBERSHIP'
  | 'MISSING_ASSIGNMENT'
  | 'MISSING_PERMISSION'
  | 'MISSING_CONTEXT'
  | 'SCOPE_MISMATCH'
  | 'LEGACY_ALLOWED'
  | 'LEGACY_DENIED'
  | 'POLICY_ERROR'

export interface AuthorizationDecision {
  decision: AuthorizationDecisionValue
  permission: string
  actor: string
  matchedAssignments: MatchedAssignment[]
  resolvedScopes: ResolvedScope[]
  reasonCode: AuthorizationReasonCode
  policyVersion: string
  decisionId: string
  migrationMode: MigrationMode
  legacyDecision: AuthorizationDecisionValue | null
  newDecision: AuthorizationDecisionValue
  /** New-engine reason, reported for explanation only; never used to decide. */
  newReasonCode?: AuthorizationReasonCode
  auditClass?: AuditClass
  /**
   * Set when an authoritative input could not be read (account state, evaluator,
   * required audit row). The decision is still DENY (fail closed); API layers
   * answer 503 "unavailable" instead of presenting it as a confirmed denial.
   */
  unavailable?: AuthorizationUnavailableReason
}

/** Why a fail-closed decision could not be evaluated (infrastructure, not policy). */
export type AuthorizationUnavailableReason = 'account_state_unavailable' | 'policy_evaluation_failed' | 'audit_write_failed'

/** Explicit catalog attribute (sa_permissions.audit_sensitivity). */
export type AuditSensitivity = 'ordinary' | 'security_sensitive'

/**
 * Write-time retention class (sa_authorization_decisions.audit_class).
 * Only ORDINARY_SHADOW is ever purged automatically (after 90 days).
 * UNCLASSIFIED exists only on rows written before the readiness migration.
 */
export type AuditClass =
  | 'ORDINARY_SHADOW'
  | 'ENFORCED_DECISION'
  | 'SECURITY_SENSITIVE'
  | 'POLICY_ERROR'

export type ShadowComparison =
  | 'MATCH_ALLOW'
  | 'MATCH_DENY'
  | 'LEGACY_ALLOW_NEW_DENY'
  | 'LEGACY_DENY_NEW_ALLOW'
  | 'SCOPE_MISMATCH'
  | 'MISSING_ASSIGNMENT'
  | 'MISSING_CONTEXT'
  | 'POLICY_ERROR'
