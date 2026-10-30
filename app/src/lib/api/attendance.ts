export interface AttendancePolicy {
    id: string
    organization_id: string
    workdays: string[]
    grace_minutes: number
    timezone: string
    require_shift: boolean
    allow_clock_out_without_clock_in: boolean
    max_open_entry_hours: number
    late_after_minutes: number
    early_leave_before_minutes: number
    overtime_policy_json: {
        enabled: boolean
        autoApprove: boolean
        maxDailyMinutes: number
        rate: number
    }
}

export interface AttendanceShift {
    id: string
    name: string
    start_time: string
    end_time: string
    break_minutes: number
    is_active: boolean
    grace_override_minutes: number | null
    allow_cross_midnight: boolean
    expected_work_minutes: number | null
}

export interface AttendanceEntry {
    id: string
    clock_in_at: string
    clock_out_at: string | null
    worked_minutes: number | null
    status: string
    shift_id: string | null
    attendance_flag: string
    overtime_minutes: number
    break_minutes: number
    user_id?: string
    shift?: AttendanceShift | null
}

export interface AttendanceCorrectionRequest {
    id: string
    entry_id: string
    requested_by: string
    reason: string
    original_clock_in: string | null
    original_clock_out: string | null
    original_worked_minutes: number | null
    corrected_clock_in: string | null
    corrected_clock_out: string | null
    corrected_worked_minutes: number | null
    status: string
    reviewed_by: string | null
    reviewed_at: string | null
    review_comment: string | null
    created_at: string
    requester?: { full_name: string | null; email: string }
    entry?: AttendanceEntry
}

export interface TimesheetRecord {
    id: string
    user_id: string
    period_start: string
    period_end: string
    total_days: number
    total_work_minutes: number
    total_overtime_minutes: number
    late_count: number
    early_leave_count: number
    status: string
    period_type: string
    submitted_at: string | null
    approved_at: string | null
    approved_by: string | null
    rejected_reason: string | null
    user?: { id: string; full_name: string | null; email: string; role_code: string }
}

const parseJson = async <T>(response: Response): Promise<T> => {
    const data = await response.json()
    return data as T
}

export const fetchAttendancePolicy = async () => {
    const response = await fetch('/api/hr/attendance/policy')
    const data = await parseJson<{ success: boolean; data?: AttendancePolicy; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to load policy' }
    }
    return { success: true, data: data.data as AttendancePolicy }
}

export const updateAttendancePolicy = async (payload: Partial<AttendancePolicy>) => {
    const response = await fetch('/api/hr/attendance/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: AttendancePolicy; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to update policy' }
    }
    return { success: true, data: data.data as AttendancePolicy }
}

export const fetchAttendanceShifts = async () => {
    const response = await fetch('/api/hr/attendance/shifts')
    const data = await parseJson<{ success: boolean; data?: AttendanceShift[]; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to load shifts' }
    }
    return { success: true, data: data.data || [] }
}

export const createAttendanceShift = async (payload: Partial<AttendanceShift>) => {
    const response = await fetch('/api/hr/attendance/shifts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: AttendanceShift; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to create shift' }
    }
    return { success: true, data: data.data as AttendanceShift }
}

export const updateAttendanceShift = async (id: string, payload: Partial<AttendanceShift>) => {
    const response = await fetch(`/api/hr/attendance/shifts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: AttendanceShift; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to update shift' }
    }
    return { success: true, data: data.data as AttendanceShift }
}

export const deleteAttendanceShift = async (id: string) => {
    const response = await fetch(`/api/hr/attendance/shifts/${id}`, { method: 'DELETE' })
    const data = await parseJson<{ success: boolean; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to delete shift' }
    }
    return { success: true }
}

export const clockAttendance = async (action: 'clock_in' | 'clock_out', shiftId?: string | null) => {
    const response = await fetch('/api/hr/attendance/clock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, shift_id: shiftId })
    })
    const data = await parseJson<{ success: boolean; data?: any; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to clock attendance' }
    }
    return { success: true, data: data.data }
}

export const fetchAttendanceEntries = async (payload: { userId?: string; from?: string; to?: string }) => {
    const params = new URLSearchParams()
    if (payload.userId) params.set('user_id', payload.userId)
    if (payload.from) params.set('from', payload.from)
    if (payload.to) params.set('to', payload.to)

    const response = await fetch(`/api/hr/attendance/entries?${params.toString()}`)
    const data = await parseJson<{ success: boolean; data?: AttendanceEntry[]; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to load entries' }
    }
    return { success: true, data: data.data || [] }
}

export const fetchTimesheets = async (params?: { scope?: string; user_id?: string; from?: string; to?: string }) => {
    const sp = new URLSearchParams()
    if (params?.user_id) sp.set('scope', 'mine') // when filtering by user_id, use mine scope
    else if (params?.scope) sp.set('scope', params.scope)
    else sp.set('scope', 'mine')
    if (params?.from) sp.set('from', params.from)
    if (params?.to) sp.set('to', params.to)
    const response = await fetch(`/api/hr/attendance/timesheets?${sp.toString()}`)
    const data = await parseJson<{ success: boolean; data?: TimesheetRecord[]; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to load timesheets' }
    }
    return { success: true, data: data.data || [] }
}

export const approveTimesheet = async (id: string, action: 'approve' | 'reject', reason?: string) => {
    const response = await fetch(`/api/hr/attendance/timesheets/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason })
    })
    const data = await parseJson<{ success: boolean; data?: TimesheetRecord; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to update timesheet' }
    }
    return { success: true, data: data.data as TimesheetRecord }
}

export const fetchAttendanceAudit = async () => {
    const response = await fetch('/api/hr/attendance/audit')
    const data = await parseJson<{ success: boolean; data?: any[]; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to load audit log' }
    }
    return { success: true, data: data.data || [] }
}

// ── Correction Requests ──────────────────────────────────────

export const fetchCorrectionRequests = async (params?: { status?: string; scope?: string }) => {
    const sp = new URLSearchParams()
    if (params?.status) sp.set('status', params.status)
    if (params?.scope) sp.set('scope', params.scope)
    const response = await fetch(`/api/hr/attendance/corrections?${sp.toString()}`)
    const data = await parseJson<{ success: boolean; data?: AttendanceCorrectionRequest[]; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to load corrections' }
    }
    return { success: true, data: data.data || [] }
}

export const createCorrectionRequest = async (payload: {
    entry_id: string
    reason: string
    corrected_clock_in?: string | null
    corrected_clock_out?: string | null
}) => {
    // Wave 3 route shape: times of day (the entry's own date; an earlier clock-out means the next day).
    const timePart = (v?: string | null) => (v && /T(\d{2}:\d{2})/.exec(v)?.[1]) || (v && /^\d{2}:\d{2}$/.test(v) ? v : null)
    const response = await fetch('/api/hr/attendance/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'request', entry_id: payload.entry_id, reason: payload.reason,
            clock_in: timePart(payload.corrected_clock_in), clock_out: timePart(payload.corrected_clock_out),
        })
    })
    const data = await parseJson<{ success: boolean; data?: AttendanceCorrectionRequest; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to create correction request' }
    }
    return { success: true, data: data.data }
}

export const reviewCorrectionRequest = async (id: string, action: 'approved' | 'rejected', note?: string) => {
    const response = await fetch(`/api/hr/attendance/corrections/${id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note })
    })
    const data = await parseJson<{ success: boolean; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to review correction' }
    }
    return { success: true }
}

// ── Timesheet generation ──────────────────────────────────────

export const generateTimesheet = async (payload: { period_start: string; period_end: string; period_type?: string }) => {
    const response = await fetch('/api/hr/attendance/timesheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    })
    const data = await parseJson<{ success: boolean; data?: TimesheetRecord; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to generate timesheet' }
    }
    return { success: true, data: data.data }
}

export const submitTimesheet = async (id: string) => {
    const response = await fetch(`/api/hr/attendance/timesheets/${id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    })
    const data = await parseJson<{ success: boolean; data?: TimesheetRecord; error?: string }>(response)
    if (!response.ok || !data.success) {
        return { success: false, error: data.error || 'Failed to submit timesheet' }
    }
    return { success: true, data: data.data }
}
