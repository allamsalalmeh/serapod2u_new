import { NextResponse } from 'next/server'
import { commissionContext } from '@/lib/server/commission/route-kit'

export const dynamic = 'force-dynamic'

/** GET /api/hr/commission/access — the caller's commission permissions, as the database enforces them. */
export async function GET() {
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  return NextResponse.json({ success: true, access: ctx.access })
}
