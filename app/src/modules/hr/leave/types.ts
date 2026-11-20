/**
 * HR Leave Management – Domain Types
 *
 * Shared across Leave Types, Leave Requests, Approval Flow, and the
 * repository layer. When Supabase tables are ready, these stay the
 * same — only the repository implementation swaps.
 */

// ── Enums / Unions ──────────────────────────────────────────────

export type LeaveTypeStatus = 'active' | 'inactive'

export type AccrualFrequency = 'yearly' | 'monthly' | 'quarterly' | 'none'

export type LeaveRequestStatus =
    | 'draft'
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'cancelled'

export type ApprovalAction = 'approve' | 'reject' | 'escalate'

export type Gender = 'male' | 'female' | 'all'

export type ApproverRole =
    | 'direct_manager'
    | 'department_head'
    | 'hr_manager'
    | 'ceo'
    | 'custom'

export type HalfDayPeriod = 'morning' | 'afternoon'

// ── Leave Type ──────────────────────────────────────────────────

export interface EntitlementTier {
    id: string
    minYearsOfService: number
    maxYearsOfService: number | null
    daysEntitled: number
}

export interface CarryForwardSettings {
    enabled: boolean
    maxDays: number
    /** Months after year-end before carried days expire */
    expiryMonths: number
}

export interface ProRataSettings {
    enabled: boolean
    basedOn: 'join_date' | 'calendar_year'
    roundingRule: 'round_up' | 'round_down' | 'round_nearest'
}

export interface LeaveType {
    id: string
    code: string
    name: string
    description: string
    color: string
    status: LeaveTypeStatus
    /** Malaysia Employment Act 1955 statutory leave */
    isStatutory: boolean
    gender: Gender
    requiresAttachment: boolean
    requiresApproval: boolean
    isPaidLeave: boolean
    maxConsecutiveDays: number | null
    minNoticeDays: number
    entitlementTiers: EntitlementTier[]
    accrualFrequency: AccrualFrequency
    carryForward: CarryForwardSettings
    proRata: ProRataSettings
    organizationId: string
    createdAt: string
    updatedAt: string
}

// ── Leave Request ───────────────────────────────────────────────

export interface LeaveRequest {
    id: string
    employeeId: string
    employeeName: string
    employeeAvatar: string | null
    departmentId: string
    departmentName: string
    leaveTypeId: string
    leaveTypeName: string
    leaveTypeColor: string
    startDate: string
    endDate: string
    totalDays: number
    isHalfDay: boolean
    halfDayPeriod: HalfDayPeriod | null
    reason: string
    attachmentUrl: string | null
    status: LeaveRequestStatus
    approvals: LeaveApprovalStep[]
    createdAt: string
    updatedAt: string
    /** Set to false only by a decision whose approval-history step could not be written (the decision itself stands). */
    approvalStepRecorded?: boolean
}

export interface LeaveApprovalStep {
    id: string
    requestId: string
    approverId: string
    approverName: string
    approverRole: string
    level: number
    action: ApprovalAction | null
    comment: string | null
    actionedAt: string | null
    dueAt: string | null
}

// ── Leave Balance ───────────────────────────────────────────────

export interface LeaveBalance {
    leaveTypeId: string
    leaveTypeName: string
    leaveTypeColor: string
    entitled: number
    taken: number
    pending: number
    remaining: number
    carriedForward: number
}

// ── Approval Chain ──────────────────────────────────────────────

export interface ApprovalChainStep {
    id: string
    level: number
    role: ApproverRole
    customApproverId: string | null
    customApproverName: string | null
    /** Auto-approve if no action within X hours (null = disabled) */
    autoApproveAfterHours: number | null
    canDelegate: boolean
}

export interface ApprovalChain {
    id: string
    name: string
    description: string
    isDefault: boolean
    /** Which leave type IDs use this chain */
    leaveTypeIds: string[]
    steps: ApprovalChainStep[]
    escalationEnabled: boolean
    /** Hours before escalation triggers */
    escalationHours: number
    organizationId: string
    createdAt: string
    updatedAt: string
}

// ── Delegation ──────────────────────────────────────────────────

export interface DelegationRule {
    id: string
    delegatorId: string
    delegatorName: string
    delegateId: string
    delegateName: string
    startDate: string
    endDate: string
    isActive: boolean
    createdAt: string
}

// ── Public Holiday ──────────────────────────────────────────────

export interface PublicHoliday {
    id: string
    name: string
    date: string
    isRecurring: boolean
    /** Malaysian state-specific (e.g. 'Selangor', 'Johor') — null = national */
    state: string | null
}

// ── Filters ─────────────────────────────────────────────────────

export interface LeaveRequestFilters {
    status?: LeaveRequestStatus | 'all'
    leaveTypeId?: string
    employeeId?: string
    departmentId?: string
    dateFrom?: string
    dateTo?: string
    scope?: 'my' | 'team' | 'all'
}

// ── Form DTOs ───────────────────────────────────────────────────

export type CreateLeaveTypeDTO = Omit<LeaveType, 'id' | 'createdAt' | 'updatedAt'>

export type UpdateLeaveTypeDTO = Partial<Omit<LeaveType, 'id' | 'createdAt' | 'updatedAt' | 'organizationId'>>

export type CreateLeaveRequestDTO = Omit<
    LeaveRequest,
    'id' | 'createdAt' | 'updatedAt' | 'approvals' | 'status'
>

export type CreateApprovalChainDTO = Omit<ApprovalChain, 'id' | 'createdAt' | 'updatedAt'>

export type CreateDelegationRuleDTO = Omit<DelegationRule, 'id' | 'createdAt'>
