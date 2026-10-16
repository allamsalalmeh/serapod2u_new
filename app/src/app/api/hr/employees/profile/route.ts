import { hrCan } from '@/lib/server/hrAccess'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { completeOnboarding } from '@/lib/hr/onboarding'

// ─── GET  /api/hr/employees/profile?user_id=xxx  ── fetch HR profile
// ─── PUT  /api/hr/employees/profile               ── upsert HR profile
// ─── POST /api/hr/employees/profile                ── onboard existing users of the organization (HR onboarding)

export async function GET(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const { data: caller } = await supabase
            .from('users')
            .select('organization_id, role_code')
            .eq('id', user.id)
            .single()

        if (!caller?.organization_id) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }

        // Resolve role level
        let roleLevel = 99
        if (caller.role_code) {
            const { data: roleData } = await supabase.from('roles').select('role_level').eq('role_code', caller.role_code).maybeSingle()
            if (roleData) roleLevel = roleData.role_level
        }

        const url = new URL(request.url)
        const userId = url.searchParams.get('user_id')

        if (!userId) {
            return NextResponse.json({ success: false, error: 'user_id required' }, { status: 400 })
        }

        // Check permission: own profile or HR employee administration (S&A)
        if (userId !== user.id && !(await hrCan({ userId: user.id, organizationId: caller.organization_id, roleCode: caller.role_code, roleLevel },
            'hr.employee.manage', () => roleLevel <= 20))) {
            return NextResponse.json({ success: false, error: 'Insufficient permissions' }, { status: 403 })
        }

        const { data: profile, error } = await supabase
            .from('hr_employee_profiles')
            .select('*')
            .eq('user_id', userId)
            .eq('organization_id', caller.organization_id)
            .maybeSingle()

        // If table doesn't exist yet (migration not run), gracefully return null
        if (error && (error.code === '42P01' || error.message?.includes('does not exist'))) {
            // table not yet created — continue with null profile
        } else if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        // Also fetch the user's basic info + hr_employees data
        const { data: userInfo, error: userError } = await supabase
            .from('users')
            .select(`
                id, full_name, email, phone, avatar_url, role_code, is_active,
                department_id, manager_user_id, position_id, employee_no,
                employment_type, employment_status, join_date
            `)
            .eq('id', userId)
            .single()

        if (userError) {
            return NextResponse.json({ success: false, error: 'User not found: ' + userError.message }, { status: 404 })
        }

        const { data: hrEmployee } = await supabase
            .from('hr_employees')
            .select('employee_no, hire_date, probation_end, status, notes')
            .eq('user_id', userId)
            .eq('organization_id', caller.organization_id)
            .maybeSingle()

        return NextResponse.json({
            success: true,
            data: {
                user: userInfo,
                hr_employee: hrEmployee,
                profile: profile || null,
            },
        })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}

export async function PUT(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        const { data: caller } = await supabase
            .from('users')
            .select('organization_id, role_code')
            .eq('id', user.id)
            .single()

        if (!caller?.organization_id) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }

        // Resolve role level
        let roleLevel = 99
        if (caller.role_code) {
            const { data: roleData } = await supabase.from('roles').select('role_level').eq('role_code', caller.role_code).maybeSingle()
            if (roleData) roleLevel = roleData.role_level
        }

        const body = await request.json()
        const { user_id, ...profileFields } = body

        if (!user_id) {
            return NextResponse.json({ success: false, error: 'user_id required' }, { status: 400 })
        }

        // Only managers can edit other profiles, employees can edit their own limited fields
        const isSelf = user_id === user.id
        const isManager = await hrCan({ userId: user.id, organizationId: caller.organization_id, roleCode: caller.role_code, roleLevel },
            'hr.employee.manage', () => roleLevel <= 20)

        if (!isManager && !isSelf) {
            return NextResponse.json({ success: false, error: 'Insufficient permissions' }, { status: 403 })
        }

        // Self-service: limit editable fields
        const allowedSelfFields = [
            'personal_email', 'personal_phone', 'address_line1', 'address_line2',
            'city', 'state', 'postcode', 'country',
            'emergency_name', 'emergency_relationship', 'emergency_phone', 'emergency_address',
            'bank_name', 'bank_account_no', 'bank_holder_name',
        ]

        const sanitized: Record<string, any> = {}
        for (const [key, value] of Object.entries(profileFields)) {
            if (isManager || allowedSelfFields.includes(key)) {
                sanitized[key] = value
            }
        }

        // Upsert profile
        const { data, error } = await supabase
            .from('hr_employee_profiles')
            .upsert({
                user_id,
                organization_id: caller.organization_id,
                ...sanitized,
            }, { onConflict: 'user_id,organization_id' })
            .select()
            .single()

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        return NextResponse.json({ success: true, data })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
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
