/**
 * HR Leave – Supabase Repository Implementation
 *
 * Real database-backed implementation of ILeaveRepository.
 * Queries hr_leave_requests, hr_leave_types, hr_leave_balances, etc.
 * Joins to users table for employee names.
 */

import { createClient } from '@/lib/supabase/client'
import type { ILeaveRepository } from './repository'
import { assertLeaveRowsChanged, leaveErrorMessage } from './leaveErrors'
import type {
  LeaveType,
  LeaveRequest,
  LeaveBalance,
  ApprovalChain,
  DelegationRule,
  PublicHoliday,
  LeaveRequestFilters,
  CreateLeaveTypeDTO,
  UpdateLeaveTypeDTO,
  CreateLeaveRequestDTO,
  CreateApprovalChainDTO,
  CreateDelegationRuleDTO,
  LeaveRequestStatus,
  LeaveApprovalStep,
} from './types'

// ── Supabase Repository ──────────────────────────────────────────

export class SupabaseLeaveRepository implements ILeaveRepository {
  private organizationId: string
  private userId: string

  constructor(organizationId: string, userId: string) {
    this.organizationId = organizationId
    this.userId = userId
  }

  private get supabase(): any {
    return createClient()
  }

  // ── Leave Types ──────────────────────────────────────────────

  async getLeaveTypes(): Promise<LeaveType[]> {
    const { data, error } = await this.supabase
      .from('hr_leave_types')
      .select('*')
      .eq('organization_id', this.organizationId)
      .eq('status', 'active')
      .order('code', { ascending: true })

    if (error) {
      console.error('Failed to load leave types:', error)
      return []
    }

    return (data || []).map(mapDbLeaveType)
  }

  async getLeaveTypeById(id: string): Promise<LeaveType | null> {
    const { data, error } = await this.supabase
      .from('hr_leave_types')
      .select('*')
      .eq('id', id)
      .eq('organization_id', this.organizationId)
      .single()

    if (error || !data) return null
    return mapDbLeaveType(data)
  }

  async createLeaveType(dto: CreateLeaveTypeDTO): Promise<LeaveType> {
    const { data, error } = await this.supabase
      .from('hr_leave_types')
      .insert({
        organization_id: this.organizationId,
        code: dto.code,
        name: dto.name,
        description: dto.description,
        color: dto.color,
        status: dto.status || 'active',
        is_statutory: dto.isStatutory,
        gender: dto.gender,
        requires_attachment: dto.requiresAttachment,
        requires_approval: dto.requiresApproval,
        is_paid_leave: dto.isPaidLeave,
        max_consecutive_days: dto.maxConsecutiveDays,
        min_notice_days: dto.minNoticeDays,
        entitlement_tiers: dto.entitlementTiers,
        accrual_frequency: dto.accrualFrequency,
        carry_forward: dto.carryForward,
        pro_rata: dto.proRata,
      })
      .select()
      .single()

    if (error || !data) throw new Error(error?.message || 'Failed to create leave type')
    return mapDbLeaveType(data)
  }

  async updateLeaveType(id: string, dto: UpdateLeaveTypeDTO): Promise<LeaveType> {
    const updateObj: Record<string, any> = {}
    if (dto.name !== undefined) updateObj.name = dto.name
    if (dto.description !== undefined) updateObj.description = dto.description
    if (dto.color !== undefined) updateObj.color = dto.color
    if (dto.status !== undefined) updateObj.status = dto.status
    if (dto.requiresAttachment !== undefined) updateObj.requires_attachment = dto.requiresAttachment
    if (dto.requiresApproval !== undefined) updateObj.requires_approval = dto.requiresApproval
    if (dto.isPaidLeave !== undefined) updateObj.is_paid_leave = dto.isPaidLeave
    if (dto.maxConsecutiveDays !== undefined) updateObj.max_consecutive_days = dto.maxConsecutiveDays
    if (dto.minNoticeDays !== undefined) updateObj.min_notice_days = dto.minNoticeDays
    if (dto.entitlementTiers !== undefined) updateObj.entitlement_tiers = dto.entitlementTiers
    if (dto.carryForward !== undefined) updateObj.carry_forward = dto.carryForward
    if (dto.proRata !== undefined) updateObj.pro_rata = dto.proRata

    const { data, error } = await this.supabase
      .from('hr_leave_types')
      .update(updateObj)
      .eq('id', id)
      .eq('organization_id', this.organizationId)
      .select()
      .single()

    if (error || !data) throw new Error(error?.message || 'Failed to update leave type')
    return mapDbLeaveType(data)
  }

  async deleteLeaveType(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('hr_leave_types')
      .update({ status: 'inactive' })
      .eq('id', id)
      .eq('organization_id', this.organizationId)

    if (error) throw new Error(error.message)
  }

  // ── Leave Requests ─────────────────────────────────────────────

  async getLeaveRequests(filters?: LeaveRequestFilters): Promise<LeaveRequest[]> {
    let query = this.supabase
      .from('hr_leave_requests')
      .select(`
        *,
        hr_leave_types ( id, name, code, color ),
        users!employee_id ( id, full_name, avatar_url, department_id ),
        hr_leave_approvals ( id, request_id, approver_id, approver_role, level, action, comment, actioned_at, due_at )
      `)
      .eq('organization_id', this.organizationId)

    // Scope filtering
    if (filters?.scope === 'my') {
      query = query.eq('employee_id', this.userId)
    }
    // For 'team' and 'all', we show all org requests (permission checked at page level)

    if (filters?.status && filters.status !== 'all') {
      query = query.eq('status', filters.status)
    }
    if (filters?.leaveTypeId) {
      query = query.eq('leave_type_id', filters.leaveTypeId)
    }
    if (filters?.employeeId) {
      query = query.eq('employee_id', filters.employeeId)
    }

    query = query.order('created_at', { ascending: false }).limit(100)

    const { data, error } = await query

    if (error) {
      console.error('Failed to load leave requests:', error)
      return []
    }

    return (data || []).map((row: any) => mapDbLeaveRequest(row))
  }

  async getLeaveRequestById(id: string): Promise<LeaveRequest | null> {
    const { data, error } = await this.supabase
      .from('hr_leave_requests')
      .select(`
        *,
        hr_leave_types ( id, name, code, color ),
        users!employee_id ( id, full_name, avatar_url, department_id ),
        hr_leave_approvals ( id, request_id, approver_id, approver_role, level, action, comment, actioned_at, due_at )
      `)
      .eq('id', id)
      .single()

    if (error || !data) return null
    return mapDbLeaveRequest(data)
  }

  async createLeaveRequest(dto: CreateLeaveRequestDTO): Promise<LeaveRequest> {
    const { data, error } = await this.supabase
      .from('hr_leave_requests')
      .insert({
        organization_id: this.organizationId,
        employee_id: this.userId,
        department_id: dto.departmentId || null,
        leave_type_id: dto.leaveTypeId,
        start_date: dto.startDate,
        end_date: dto.endDate,
        total_days: dto.totalDays,
        is_half_day: dto.isHalfDay,
        half_day_period: dto.halfDayPeriod,
        reason: dto.reason,
        attachment_url: dto.attachmentUrl,
        status: 'pending',
      })
      .select(`
        *,
        hr_leave_types ( id, name, code, color ),
        users!employee_id ( id, full_name, avatar_url, department_id ),
        hr_leave_approvals ( id, request_id, approver_id, approver_role, level, action, comment, actioned_at, due_at )
      `)
      .single()

    if (error || !data) throw new Error(leaveErrorMessage(error, 'Failed to create leave request'))
    return mapDbLeaveRequest(data)
  }

  async updateLeaveRequestStatus(
    id: string,
    status: LeaveRequestStatus,
    comment?: string
  ): Promise<LeaveRequest> {
    // Update the request status. The database (B2A guard) stamps approver/time and cancellation time, refuses
    // self-approval and unauthorized decisions; a row filtered out by row-level security is a refusal too.
    const decided = status === 'approved' || status === 'rejected'
    const { data: changed, error: updateError } = await this.supabase
      .from('hr_leave_requests')
      .update({
        status,
        ...(decided && comment ? { approval_comment: comment } : {}),
        ...(status === 'cancelled' ? { cancelled_at: new Date().toISOString() } : {}),
      })
      .eq('id', id)
      .select('id')

    if (updateError) throw new Error(leaveErrorMessage(updateError))
    assertLeaveRowsChanged(changed)

    // Record the approval step. The decision above is already saved (and audited by the database in
    // hr_leave_request_events), so a refused step must not turn a real decision into an error, but it is reported.
    let stepRecorded = true
    if (decided) {
      const { error: stepError } = await this.supabase.from('hr_leave_approvals').insert({
        organization_id: this.organizationId,
        request_id: id,
        approver_id: this.userId,
        approver_role: 'custom',
        level: 1,
        action: status === 'approved' ? 'approve' : 'reject',
        comment: comment || null,
        actioned_at: new Date().toISOString(),
      })
      if (stepError) {
        stepRecorded = false
        console.warn('Leave approval step not recorded:', stepError.message)
      }
    }

    const result = await this.getLeaveRequestById(id)
    if (!result) throw new Error('Request not found after update')
    // Report what the database actually stored, never the requested status.
    return stepRecorded ? result : { ...result, approvalStepRecorded: false }
  }

  // ── Leave Balances ─────────────────────────────────────────────

  async getLeaveBalances(employeeId: string): Promise<LeaveBalance[]> {
    const currentYear = new Date().getFullYear()

    const { data, error } = await this.supabase
      .from('hr_leave_balances')
      .select('*, hr_leave_types ( id, name, color )')
      .eq('employee_id', employeeId || this.userId)
      .eq('year', currentYear)

    if (error) {
      console.error('Failed to load leave balances:', error)
      return []
    }

    return (data || []).map((row: any) => ({
      leaveTypeId: row.leave_type_id,
      leaveTypeName: row.hr_leave_types?.name || 'Unknown',
      leaveTypeColor: row.hr_leave_types?.color || '#6b7280',
      entitled: Number(row.entitled || 0),
      taken: Number(row.taken || 0),
      pending: Number(row.pending || 0),
      // Table rule (and the Wave 3 ledger projection): entitled + carried forward + adjustment − taken − pending.
      remaining: Number(row.entitled || 0) + Number(row.carried_forward || 0) + Number(row.adjustment || 0)
        - Number(row.taken || 0) - Number(row.pending || 0),
      carriedForward: Number(row.carried_forward || 0),
    }))
  }

  // ── Approval Chains ────────────────────────────────────────────

  async getApprovalChains(): Promise<ApprovalChain[]> {
    const { data, error } = await this.supabase
      .from('hr_approval_chains')
      .select('*, hr_approval_chain_steps ( * )')
      .eq('organization_id', this.organizationId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Failed to load approval chains:', error)
      return []
    }

    return (data || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      isDefault: row.is_default || false,
      leaveTypeIds: row.leave_type_ids || [],
      steps: (row.hr_approval_chain_steps || [])
        .sort((a: any, b: any) => a.level - b.level)
        .map((s: any) => ({
          id: s.id,
          level: s.level,
          role: s.role,
          customApproverId: s.custom_approver_id,
          customApproverName: null,
          autoApproveAfterHours: s.auto_approve_after_hours,
          canDelegate: s.can_delegate ?? true,
        })),
      escalationEnabled: row.escalation_enabled || false,
      escalationHours: row.escalation_hours || 0,
      organizationId: row.organization_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async getApprovalChainById(id: string): Promise<ApprovalChain | null> {
    const chains = await this.getApprovalChains()
    return chains.find((c) => c.id === id) || null
  }

  async createApprovalChain(dto: CreateApprovalChainDTO): Promise<ApprovalChain> {
    const { data, error } = await this.supabase
      .from('hr_approval_chains')
      .insert({
        organization_id: this.organizationId,
        name: dto.name,
        description: dto.description,
        is_default: dto.isDefault,
        leave_type_ids: dto.leaveTypeIds,
        escalation_enabled: dto.escalationEnabled,
        escalation_hours: dto.escalationHours,
      })
      .select()
      .single()

    if (error || !data) throw new Error(error?.message || 'Failed to create approval chain')

    // Insert steps
    if (dto.steps.length > 0) {
      await this.supabase.from('hr_approval_chain_steps').insert(
        dto.steps.map((s) => ({
          chain_id: data.id,
          level: s.level,
          role: s.role,
          custom_approver_id: s.customApproverId,
          auto_approve_after_hours: s.autoApproveAfterHours,
          can_delegate: s.canDelegate,
        }))
      )
    }

    const result = await this.getApprovalChainById(data.id)
    if (!result) throw new Error('Chain not found after create')
    return result
  }

  async updateApprovalChain(id: string, updates: Partial<ApprovalChain>): Promise<ApprovalChain> {
    const updateObj: Record<string, any> = {}
    if (updates.name !== undefined) updateObj.name = updates.name
    if (updates.description !== undefined) updateObj.description = updates.description
    if (updates.isDefault !== undefined) updateObj.is_default = updates.isDefault
    if (updates.leaveTypeIds !== undefined) updateObj.leave_type_ids = updates.leaveTypeIds
    if (updates.escalationEnabled !== undefined) updateObj.escalation_enabled = updates.escalationEnabled
    if (updates.escalationHours !== undefined) updateObj.escalation_hours = updates.escalationHours

    const { error } = await this.supabase
      .from('hr_approval_chains')
      .update(updateObj)
      .eq('id', id)

    if (error) throw new Error(error.message)

    const result = await this.getApprovalChainById(id)
    if (!result) throw new Error('Chain not found after update')
    return result
  }

  async deleteApprovalChain(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('hr_approval_chains')
      .delete()
      .eq('id', id)

    if (error) throw new Error(error.message)
  }

  // ── Delegation Rules ───────────────────────────────────────────

  async getDelegationRules(): Promise<DelegationRule[]> {
    const { data, error } = await this.supabase
      .from('hr_delegation_rules')
      .select('*, delegator:delegator_id ( full_name ), delegate:delegate_id ( full_name )')
      .eq('organization_id', this.organizationId)
      .order('start_date', { ascending: false })

    if (error) {
      console.error('Failed to load delegation rules:', error)
      return []
    }

    return (data || []).map((row: any) => ({
      id: row.id,
      delegatorId: row.delegator_id,
      delegatorName: row.delegator?.full_name || 'Unknown',
      delegateId: row.delegate_id,
      delegateName: row.delegate?.full_name || 'Unknown',
      startDate: row.start_date,
      endDate: row.end_date,
      isActive: row.is_active,
      createdAt: row.created_at,
    }))
  }

  async createDelegationRule(dto: CreateDelegationRuleDTO): Promise<DelegationRule> {
    const { data, error } = await this.supabase
      .from('hr_delegation_rules')
      .insert({
        organization_id: this.organizationId,
        delegator_id: dto.delegatorId,
        delegate_id: dto.delegateId,
        start_date: dto.startDate,
        end_date: dto.endDate,
        is_active: dto.isActive,
      })
      .select('*, delegator:delegator_id ( full_name ), delegate:delegate_id ( full_name )')
      .single()

    if (error || !data) throw new Error(error?.message || 'Failed to create delegation rule')
    return {
      id: data.id,
      delegatorId: data.delegator_id,
      delegatorName: (data as any).delegator?.full_name || dto.delegatorName,
      delegateId: data.delegate_id,
      delegateName: (data as any).delegate?.full_name || dto.delegateName,
      startDate: data.start_date,
      endDate: data.end_date,
      isActive: data.is_active,
      createdAt: data.created_at,
    }
  }

  async deleteDelegationRule(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('hr_delegation_rules')
      .delete()
      .eq('id', id)

    if (error) throw new Error(error.message)
  }

  // ── Public Holidays ────────────────────────────────────────────

  async getPublicHolidays(year?: number): Promise<PublicHoliday[]> {
    let query = this.supabase
      .from('hr_public_holidays')
      .select('*')
      .eq('organization_id', this.organizationId)
      .order('date', { ascending: true })

    if (year) {
      query = query
        .gte('date', `${year}-01-01`)
        .lte('date', `${year}-12-31`)
    }

    const { data, error } = await query

    if (error) {
      console.error('Failed to load public holidays:', error)
      return []
    }

    return (data || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      date: row.date,
      isRecurring: row.is_recurring || false,
      state: row.state || null,
    }))
  }
}

// ── DB → Domain Type Mappers ─────────────────────────────────────

function mapDbLeaveType(row: any): LeaveType {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || '',
    color: row.color || '#3b82f6',
    status: row.status || 'active',
    isStatutory: row.is_statutory || false,
    gender: row.gender || 'all',
    requiresAttachment: row.requires_attachment || false,
    requiresApproval: row.requires_approval ?? true,
    isPaidLeave: row.is_paid_leave ?? true,
    maxConsecutiveDays: row.max_consecutive_days || null,
    minNoticeDays: row.min_notice_days || 0,
    entitlementTiers: row.entitlement_tiers || [],
    accrualFrequency: row.accrual_frequency || 'yearly',
    carryForward: row.carry_forward || { enabled: false, maxDays: 0, expiryMonths: 0 },
    proRata: row.pro_rata || { enabled: false, basedOn: 'calendar_year', roundingRule: 'round_nearest' },
    organizationId: row.organization_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapDbLeaveRequest(row: any): LeaveRequest {
  const leaveType = row.hr_leave_types || {}
  const employee = row.users || {}
  const approvals: LeaveApprovalStep[] = (row.hr_leave_approvals || [])
    .sort((a: any, b: any) => (a.level || 1) - (b.level || 1))
    .map((ap: any) => ({
      id: ap.id,
      requestId: ap.request_id,
      approverId: ap.approver_id,
      approverName: 'Approver',
      approverRole: ap.approver_role || 'custom',
      level: ap.level || 1,
      action: ap.action || null,
      comment: ap.comment || null,
      actionedAt: ap.actioned_at || null,
      dueAt: ap.due_at || null,
    }))

  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: employee.full_name || 'Employee',
    employeeAvatar: employee.avatar_url || null,
    departmentId: employee.department_id || row.department_id || '',
    departmentName: '',
    leaveTypeId: row.leave_type_id,
    leaveTypeName: leaveType.name || 'Leave',
    leaveTypeColor: leaveType.color || '#6b7280',
    startDate: row.start_date,
    endDate: row.end_date,
    totalDays: Number(row.total_days || 0),
    isHalfDay: row.is_half_day || false,
    halfDayPeriod: row.half_day_period || null,
    reason: row.reason || '',
    attachmentUrl: row.attachment_url || null,
    status: row.status || 'draft',
    approvals,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
