import { hrCan } from '@/lib/server/hrAccess'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { completeOnboarding } from '@/lib/hr/onboarding'
import { employeeProfile, saveEmployeeProfile, sessionActor } from '@/lib/hr/employment-foundation'
import { isUuid, mergeProfileForUi, splitProfilePayload } from '@/lib/hr/employment-messages'

const SELF_SERVICE_FIELDS = new Set([
    'personal_email', 'personal_phone', 'address_line1', 'address_line2', 'city', 'state', 'postcode', 'country',
    'emergency_name', 'emergency_relationship', 'emergency_phone', 'emergency_address',
    'bank_name', 'bank_account_no', 'bank_holder_name',
])

// ─── GET  /api/hr/employees/profile?user_id=xxx  ── fetch HR profile
// ─── PUT  /api/hr/employees/profile               ── upsert HR profile
// ─── POST /api/hr/employees/profile                ── onboard existing users of the organization (HR onboarding)

// GET and PUT use the HR profile entry points of migration 20261221100000 (hr_employee_profile_get / _save). The
// database decides: the employee themself (self-service fields only, read-only statutory details) or explicit HR
// (hr.employee.manage) in the EMPLOYEE's company — child organizations included through S&A scope; legacy compatibility
// access never counts. HR never edits their own statutory record. Former employees are read-only. The sheet's
// statutory fields (NRIC, passport, tax, EPF, SOCSO, EIS, gender, DOB, nationality, marital status) are stored only in
// the statutory profile (one source); the rest in the personal HR profile. (Before Wave 2 this route wrote to a table
// that never existed — every save failed, BL-17.)

export async function GET(request: NextRequest) {
    try {
        const actor = await sessionActor()
        if (!actor) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const userId = new URL(request.url).searchParams.get('user_id')
        if (!userId || !isUuid(userId)) {
            return NextResponse.json({ success: false, error: 'user_id required' }, { status: 400 })
        }

        const result = await employeeProfile(actor.id, userId)
        if (!result.ok) {
            return NextResponse.json({ success: false, error: result.message, code: result.code }, { status: result.status })
        }
        const d = result.data ?? {}

        // Basic identity and employment facts (row-level security of the caller still applies to these reads).
        const supabase = (await createClient()) as any
        const { data: userInfo } = await supabase
            .from('users')
            .select(`
                id, full_name, email, phone, avatar_url, role_code, is_active,
                department_id, manager_user_id, position_id, employee_no,
                employment_type, employment_status, join_date
            `)
            .eq('id', userId)
            .maybeSingle()
        const { data: hrEmployee } = await supabase
            .from('hr_employees')
            .select('employee_no, hire_date, probation_end, status, end_date')
            .eq('user_id', userId)
            .eq('organization_id', d.organization_id ?? actor.organizationId)
            .maybeSingle()

        return NextResponse.json({
            success: true,
            data: {
                user: userInfo ?? null,
                hr_employee: hrEmployee ?? null,
                profile: mergeProfileForUi(d.profile, d.statutory),
                permissions: {
                    can_edit_personal: !!d.can_edit_personal && !d.archived,
                    can_edit_all_personal: !!d.can_edit_all_personal && !d.archived,
                    can_edit_statutory: !!d.can_edit_statutory && !d.archived,
                    self_fields: Array.isArray(d.self_fields) ? d.self_fields : [],
                    archived: !!d.archived,
                },
            },
        })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: 'The profile could not be loaded.' }, { status: 500 })
    }
}

export async function PUT(request: NextRequest) {
    try {
        const actor = await sessionActor()
        if (!actor) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const body = await request.json().catch(() => ({}))
        const { user_id, reason, ...profileFields } = body ?? {}
        if (!user_id || !isUuid(user_id)) {
            return NextResponse.json({ success: false, error: 'user_id required' }, { status: 400 })
        }

        const isSelf = user_id === actor.id
        const { personal, statutory, errors } = splitProfilePayload(profileFields)
        // Self-service: only the self-service fields are sent (statutory details are read-only for the employee).
        const personalToSave = isSelf
            ? Object.fromEntries(Object.entries(personal).filter(([k]) => SELF_SERVICE_FIELDS.has(k)))
            : personal
        const statutoryToSave = isSelf ? {} : statutory
        const statutoryErrors = isSelf ? {} : errors
        if (Object.keys(statutoryErrors).length > 0) {
            return NextResponse.json({
                success: false, error: Object.values(statutoryErrors)[0], code: 'INVALID_STATUTORY', fields: statutoryErrors,
            }, { status: 400 })
        }
        const hasStatutory = Object.entries(statutoryToSave).some(([k, v]) => k !== 'id_type' && v !== null)

        const result = await saveEmployeeProfile(
            actor.id,
            user_id,
            Object.keys(personalToSave).length ? personalToSave : null,
            hasStatutory ? statutoryToSave : null,
            typeof reason === 'string' && reason.trim() ? reason.trim() : null,
        )
        if (!result.ok) {
            return NextResponse.json({ success: false, error: result.message, code: result.code }, { status: result.status })
        }
        return NextResponse.json({ success: true, data: result.data })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: 'The profile could not be saved.' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    // Link existing user from User Management to HR module
    try {
        const supabase = (await createClient()) as any
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const { data: callerPost } = await supabase
            .from('users')
            .select('organization_id, role_code')
            .eq('id', user.id)
            .single()

        if (!callerPost?.organization_id) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }

        // Resolve role level
        let postRoleLevel = 99
        if (callerPost.role_code) {
            const { data: rd } = await supabase.from('roles').select('role_level').eq('role_code', callerPost.role_code).maybeSingle()
            if (rd) postRoleLevel = rd.role_level
        }
        if (!(await hrCan({ userId: user.id, organizationId: callerPost.organization_id, roleCode: callerPost.role_code, roleLevel: postRoleLevel },
            'hr.employee.manage', () => postRoleLevel <= 20))) {
            return NextResponse.json({ success: false, error: 'Insufficient permissions' }, { status: 403 })
        }

        const body = await request.json()
        const { user_ids, department_id, position_id, manager_user_id, employment_type } = body
        const hire_date = body.hire_date ?? null

        if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
            return NextResponse.json({ success: false, error: 'user_ids array required' }, { status: 400 })
        }
        if (!hire_date) {
            return NextResponse.json({ success: false, error: 'The actual hire date is required.' }, { status: 400 })
        }

        // Registration is the explicit HR onboarding state (hr_onboarding_complete):
        // the same identity, employment record and employee number are reused;
        // other organizations and non-employee accounts are refused there.
        const results: { userId: string; name: string | null; employee_no: number | null; status: string }[] = []
        for (const userId of user_ids.filter((id: unknown) => typeof id === 'string')) {
            const onboarded = await completeOnboarding(user.id, callerPost.organization_id, userId, {
                departmentId: department_id || null,
                positionId: position_id || null,
                managerUserId: manager_user_id || null,
                employmentType: employment_type || null,
                hireDate: hire_date,
            }, 'hr_link_existing')
            results.push(onboarded.ok
                ? { userId, name: null, employee_no: onboarded.employeeNo, status: 'linked' }
                : { userId, name: null, employee_no: null, status: `error: ${onboarded.message}` })
        }

        return NextResponse.json({
            success: true,
            data: results,
            linked: results.filter(r => r.status === 'linked').length,
            errors: results.filter(r => r.status.startsWith('error')).length,
        })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}
