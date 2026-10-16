import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/scan-issues/[id] — issue detail
 * PATCH /api/scan-issues/[id] — status / resolution updates
 *
 * Allowed PATCH body keys: status, priority, resolution_note, mark_rectified (bool)
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    const saDenied = await guardUserOperation(user.id, 'customer.support.manage')
    if (saDenied) return saDenied
    // Next 16 passes route params as a Promise; reading params.id directly is undefined.
    const { id } = await params

    const { data, error } = await supabase
        .from('consumer_scan_issues')
        .select('*')
        .eq('id', id)
        .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json({ issue: data })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    const saDenied = await guardUserOperation(user.id, 'customer.support.manage')
    if (saDenied) return saDenied
    const { id } = await params

    const body = await req.json().catch(() => ({})) as Record<string, any>
    const update: Record<string, any> = {}

    if (typeof body.status === 'string') {
        if (!['pending', 'in_progress', 'resolved', 'ignored'].includes(body.status)) {
            return NextResponse.json({ error: 'invalid status' }, { status: 400 })
        }
        update.status = body.status
        if (body.status === 'resolved') {
            update.resolved_at = new Date().toISOString()
            update.resolved_by = user.id
        }
    }
    if (typeof body.priority === 'string') {
        if (!['low', 'medium', 'high', 'urgent'].includes(body.priority)) {
            return NextResponse.json({ error: 'invalid priority' }, { status: 400 })
        }
        update.priority = body.priority
    }
    if (typeof body.resolution_note === 'string') update.resolution_note = body.resolution_note
    if (body.mark_rectified === true) {
        update.rectified_at = new Date().toISOString()
        update.rectified_by = user.id
    }

    if (Object.keys(update).length === 0) {
        return NextResponse.json({ error: 'nothing to update' }, { status: 400 })
    }

    const { data, error } = await supabase
        .from('consumer_scan_issues')
        .update(update)
        .eq('id', id)
        .select('*')
        .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ issue: data })
}
