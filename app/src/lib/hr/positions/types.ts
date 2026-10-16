/**
 * HR Position Management V1.1 — shared domain types.
 *
 * These mirror the additive database tables (hr01–hr05) and are the single
 * source of truth for the position-centric model on the client/server boundary.
 */

export type RelationshipType = 'PRIMARY' | 'SECOND_MANAGER' | 'MATRIX_MANAGER' | 'HR_MANAGER' | 'CUSTOM'

export type LifecycleStatus = 'active' | 'inactive' | 'frozen' | 'closed'

export type AssignmentType = 'PRIMARY' | 'SECONDARY'

export type ChangeRequestStatus =
  | 'draft'
  | 'pending'
  | 'returned'
  | 'rejected'
  | 'approved'
  | 'scheduled'
  | 'effective'
  | 'activation_failed'
  | 'cancelled'

export type ChangeRequestType =
  | 'CREATE_POSITION'
  | 'UPDATE_POSITION'
  | 'CHANGE_REPORTING'
  | 'ASSIGN_EMPLOYEE'
  | 'REASSIGN_EMPLOYEE'
  | 'END_ASSIGNMENT'
  | 'CHANGE_LIFECYCLE'

export interface JobClassification {
  id: string
  organization_id: string
  code: string
  name: string
  family: string | null
  job_grade: string | null
  description: string | null
  is_active: boolean
}

export interface PositionSlot {
  id: string
  organization_id: string
  position_code: string
  name: string
  job_classification_id: string | null
  department_id: string | null
  business_unit: string | null
  org_tier: string
  lifecycle_status: LifecycleStatus
  is_active: boolean
  incumbent_user_id?: string | null
  incumbent_name?: string | null
  occupancy?: 'FILLED' | 'VACANT'
}

export interface PositionRelationship {
  id: string
  organization_id: string
  position_id: string
  parent_position_id: string | null
  relationship_type: RelationshipType
  effective_from: string
  effective_to: string | null
  is_active: boolean
}

export interface PositionAssignment {
  id: string
  organization_id: string
  position_id: string
  employee_user_id: string
  assignment_type: AssignmentType
  effective_from: string
  effective_to: string | null
  status: 'active' | 'ended'
}

/** A date range, normalized to strings for comparison purposes. */
export interface DateRange {
  from: string
  to: string | null // null => open-ended
}

/** A single node in the multi-root position hierarchy. */
export interface PositionChartNode {
  id: string
  position_code: string
  name: string
  parent_position_id: string | null
  relationship_type: RelationshipType
  incumbent_user_id: string | null
  incumbent_name: string | null
  occupancy: 'FILLED' | 'VACANT'
  depth: number
  children: PositionChartNode[]
}
