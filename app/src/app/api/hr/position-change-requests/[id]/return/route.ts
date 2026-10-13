import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getHrAuthContext } from '@/lib/server/hrAccess'
import { returnChangeRequest } from '@/lib/server/hr/position-workflow'

export const dynamic = 'force-dynamic'

/** POST /api/hr/position-change-requests/[id]/return — return for correction. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = (await createClient()) as any
  const ctxResult = await getHrAuthContext(supabase)
  if (!ctxResult.success || !ctxResult.data) {
    return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
  }
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const admin = createAdminClient() as any
  const result = await returnChangeRequest(admin, ctxResult.data, id, String(body?.comment ?? ''))
  if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: result.status ?? 400 })
  return NextResponse.json({ success: true, data: result.data })
}
