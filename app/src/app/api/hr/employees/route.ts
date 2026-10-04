import { hrCan } from '@/lib/server/hrAccess'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { provisionIdentity } from '@/lib/identity/provisioning'
import { ONBOARDING_BLOCK_MESSAGES, completeOnboarding, resolveForOnboarding } from '@/lib/hr/onboarding'

// ─── POST /api/hr/employees  ── HR onboarding (Add Employee) over one central identity
// ─── GET  /api/hr/employees  ── List employees, org-scoped, by HR onboarding state
//
// onboarding=completed (default) lists people HR has registered; awaiting
// lists automatic employment anchors and reset registrations; all lists both.

export async function GET(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        // Get caller's org
        const { data: caller } = await supabase
            .from('users')
            .select('organization_id, roles:role_code(role_level)')
            .eq('id', user.id)
            .single()

        if (!caller?.organization_id) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }

        const url = new URL(request.url)
        const search = url.searchParams.get('search') || ''
        const department_id = url.searchParams.get('department_id')
        const status = url.searchParams.get('status') || 'active' // active, resigned, terminated, all
        const onboarding = url.searchParams.get('onboarding') || 'completed' // completed, awaiting, all
        const onboardingStates = onboarding === 'awaiting' ? ['pending', 'reset'] : onboarding === 'all' ? ['pending', 'reset', 'completed'] : ['completed']
        const page = parseInt(url.searchParams.get('page') || '1', 10)
        const limit = parseInt(url.searchParams.get('limit') || '50', 10)

        let query = supabase
            .from('users')
            .select(`
                id, full_name, email, phone, avatar_url, role_code, is_active,
                department_id, manager_user_id, position_id, employee_no,
                employment_type, employment_status, join_date,
                roles:role_code (role_name, role_level),
                positions:position_id (name),
                departments:department_id (dept_name, dept_code),
                hr_employees!hr_employees_user_id_fkey!inner (organization_id, onboarding_status, hire_date, hire_date_confirmed, onboarding_reset_at)
            `, { count: 'exact' })
            .eq('organization_id', caller.organization_id)
            .eq('hr_employees.organization_id', caller.organization_id)
            .in('hr_employees.onboarding_status', onboardingStates)
            .order('full_name', { ascending: true })
            .range((page - 1) * limit, page * limit - 1)

        if (status !== 'all') {
            if (status === 'active') {
                query = query.eq('is_active', true)
            } else {
                query = query.eq('employment_status', status)
            }
        }

        if (department_id && department_id !== 'all') {
            query = query.eq('department_id', department_id)
        }

        if (search) {
            query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`)
        }

        const { data, error, count } = await query

        if (error) {
            return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        }

        // Resolve manager names
        const managerIds = [...new Set((data || []).map((u: any) => u.manager_user_id).filter(Boolean))]
        const managerMap = new Map<string, string>()
        if (managerIds.length > 0) {
            const { data: managers } = await supabase
                .from('users')
                .select('id, full_name')
                .in('id', managerIds)
                ; (managers || []).forEach((m: any) => managerMap.set(m.id, m.full_name || 'Unknown'))
        }

        const employees = (data || []).map((u: any) => {
            const employment = (Array.isArray(u.hr_employees) ? u.hr_employees : [u.hr_employees])
                .find((e: any) => e?.organization_id === caller.organization_id) || null
            return {
                id: u.id,
                full_name: u.full_name,
                email: u.email,
                phone: u.phone,
                avatar_url: u.avatar_url,
                role_code: u.role_code,
                role_name: u.roles?.role_name || null,
                role_level: u.roles?.role_level ?? null,
                is_active: u.is_active,
                department_id: u.department_id,
                department_name: u.departments?.dept_name || null,
                department_code: u.departments?.dept_code || null,
                position_id: u.position_id,
                position_name: u.positions?.name || null,
                manager_user_id: u.manager_user_id,
                manager_name: u.manager_user_id ? managerMap.get(u.manager_user_id) || null : null,
                employee_no: u.employee_no ?? null,
                employment_type: u.employment_type || null,
                employment_status: u.employment_status || 'active',
                onboarding_status: employment?.onboarding_status ?? null,
                onboarding_reset_at: employment?.onboarding_reset_at ?? null,
                // A login/creation date is never presented as a confirmed hire date.
                hire_date: employment?.hire_date_confirmed ? employment.hire_date : null,
                hire_date_confirmed: !!employment?.hire_date_confirmed,
                join_date: employment?.hire_date_confirmed ? employment.hire_date : null,
            }
        })

        return NextResponse.json({
            success: true,
            data: employees,
            pagination: {
                page,
                limit,
                total: count || 0,
                totalPages: Math.ceil((count || 0) / limit),
            },
        })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
        }

        // Get caller context
        const { data: caller } = await supabase
            .from('users')
            .select('organization_id, roles:role_code(role_level)')
            .eq('id', user.id)
            .single()

        if (!caller?.organization_id) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }

        const roleLevel = caller.roles?.role_level ?? 99
        if (!(await hrCan({ userId: user.id, organizationId: caller.organization_id, roleCode: null, roleLevel },
            'hr.employee.manage', () => roleLevel <= 20))) {
            return NextResponse.json({ success: false, error: 'Insufficient permissions. Manager level or above required.' }, { status: 403 })
        }

        const body = await request.json()
        const {
            user_id,
            full_name,
            email,
            phone,
            role_code,
            department_id,
            position_id,
            manager_user_id,
            employment_type = 'Full-time',
        } = body
        // The actual hire date is an HR fact (a login creation date is not).
        const hire_date = body.hire_date ?? body.join_date ?? null
        if (!hire_date) {
            return NextResponse.json({ success: false, error: 'The actual hire date is required.', code: 'INVALID_INPUT' }, { status: 400 })
        }
        const facts = {
            departmentId: department_id || null,
            positionId: position_id || null,
            managerUserId: manager_user_id || null,
            employmentType: employment_type || null,
            hireDate: hire_date,
        }

        // Existing person: either selected after an authorized preview
        // (user_id) or resolved from email/phone. Never matched by name.
        let targetUserId: string | null = typeof user_id === 'string' && user_id ? user_id : null
        let identityOutcome: 'CREATED' | 'REUSED' = 'REUSED'
        let tempPassword: string | null = null

        if (!targetUserId) {
            if (!full_name || !email) {
                return NextResponse.json({ success: false, error: 'full_name and email are required' }, { status: 400 })
            }
            const resolved = await resolveForOnboarding(user.id, caller.organization_id, email, phone || null)
            if (!resolved.ok) {
                return NextResponse.json({ success: false, error: resolved.message, code: resolved.code }, { status: resolved.status })
            }
            if (resolved.outcome === 'EXISTING') {
                const candidate = resolved.candidate
                if (!candidate.eligible || !candidate.user_id) {
                    const code = candidate.block_code || 'NOT_ELIGIBLE'
                    return NextResponse.json({ success: false, code,
                        error: ONBOARDING_BLOCK_MESSAGES[code] ?? 'This person cannot be onboarded here.' }, { status: 409 })
                }
                targetUserId = candidate.user_id
            } else {
                // Genuinely new person: canonical provisioning creates the one
                // identity, its login (ESS access) and organization membership.
                // HR supplies employment facts only; a legacy role above the
                // baseline is access administration, authorized separately.
                const requestedRole = typeof role_code === 'string' && role_code.trim() && role_code.trim().toLowerCase() !== 'staff'
                    ? role_code.trim()
                    : null
                const provisioned = await provisionIdentity({
                    actorId: user.id,
                    email,
                    phone: phone || null,
                    fullName: full_name,
                    organizationId: caller.organization_id,
                    accountScope: 'portal',
                    legacyRoleCode: requestedRole,
                    authorizingPermission: 'hr.employee.manage',
                    hr: {
                        departmentId: facts.departmentId,
                        positionId: facts.positionId,
                        managerUserId: facts.managerUserId,
                        employmentType: facts.employmentType,
                        joinDate: hire_date,
                    },
                    source: 'hr',
                })
                if (!provisioned.ok) {
                    return NextResponse.json({ success: false, error: provisioned.message, code: provisioned.code }, { status: provisioned.status })
                }
                targetUserId = provisioned.userId
                identityOutcome = provisioned.outcome
                tempPassword = provisioned.tempPassword ?? null
            }
        }

        const onboarded = await completeOnboarding(user.id, caller.organization_id, targetUserId, facts, 'hr_add_employee')
        if (!onboarded.ok) {
            return NextResponse.json({ success: false, error: onboarded.message, code: onboarded.code,
                data: identityOutcome === 'CREATED' ? { id: targetUserId, outcome: 'CREATED', temp_password: tempPassword } : undefined },
                { status: onboarded.status })
        }

        // Fetch the employee for the response
        const { data: newEmployee } = await supabase
            .from('users')
            .select('id, full_name, email, employee_no, employment_type, employment_status')
            .eq('id', targetUserId)
            .single()

        return NextResponse.json({
            success: true,
            data: {
                ...newEmployee,
                employee_no: onboarded.employeeNo ?? newEmployee?.employee_no ?? null,
                outcome: identityOutcome,
                onboarding: onboarded.outcome,
                temp_password: tempPassword,
            },
        })
    } catch (error: any) {
        console.error('Failed to create employee:', error)
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}
