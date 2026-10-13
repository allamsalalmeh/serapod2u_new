import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'
import { listJobClassifications } from '@/lib/server/hr/position-management'

export const dynamic = 'force-dynamic'

/** GET /api/hr/job-classifications — list job classifications for the caller's org. */
export async function GET() {
  try {
    const supabase = (await createClient()) as any
    const ctxResult = await getHrAuthContext(supabase)
    if (!ctxResult.success || !ctxResult.data) {
      return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
    }
    const { organizationId } = ctxResult.data
    if (!organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })

    const admin = createAdminClient() as any
    const result = await listJobClassifications(admin, organizationId)
    if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
    return NextResponse.json({ success: true, data: result.data })
  } catch (error: any) {
    console.error('Failed to list job classifications:', error)
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
  }
}

/** POST /api/hr/job-classifications — create a job classification (reference data). */
export async function POST(request: NextRequest) {
  try {
    const supabase = (await createClient()) as any
    const ctxResult = await getHrAuthContext(supabase)
    if (!ctxResult.success || !ctxResult.data) {
      return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
    }
    const ctx = ctxResult.data
    if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
    if (!(await hrCan(ctx, 'hr.employee.manage'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

    const body = await request.json()
    const code = String(body.code || '').trim().toUpperCase()
    const name = String(body.name || '').trim()
    if (!code || !name) return NextResponse.json({ success: false, error: 'Code and name are required' }, { status: 400 })

    const admin = createAdminClient() as any
    const { data, error } = await admin
      .from('hr_job_classifications')
      .insert({
        organization_id: ctx.organizationId,
        code,
        name,
        family: body.family ? String(body.family) : null,
        job_grade: body.job_grade ? String(body.job_grade) : null,
        description: body.description ? String(body.description) : null,
        is_active: body.is_active === undefined ? true : !!body.is_active,
      })
      .select('*')
      .single()

    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data })
  } catch (error: any) {
    console.error('Failed to create job classification:', error)
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
  }
}
