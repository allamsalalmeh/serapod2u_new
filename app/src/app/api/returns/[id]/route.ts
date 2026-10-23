import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { getReturnContext, loadAccessibleCase, buildReturnItemRows, applyReturnSourcePrices, validateReturnSource, validateReturnWarehouse, RETURN_ORG_SELECT } from '@/lib/returns/server'
import { decorateCase } from '@/lib/returns/compute'
import { normalizeReturnSourceType } from '@/lib/returns/constants'
import type { ReturnSettings } from '@/lib/returns/types'

const ORG_SELECT = RETURN_ORG_SELECT

async function loadSettings(admin: any): Promise<ReturnSettings> {
    const { data } = await admin.from('return_settings').select('*').eq('id', 1).maybeSingle()
    return data || {
        default_return_warehouse_id: null,
        sla_submitted_to_received_days: 3,
        sla_received_to_processing_days: 2,
        sla_processing_to_completed_days: 5,
        pdf_instruction_text: null,
        shop_self_service_enabled: true,
    }
}

/** GET /api/returns/[id] — full case detail. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const ctx = await getReturnContext()
    if (ctx instanceof NextResponse) return ctx

    const rc = await loadAccessibleCase(ctx, id)
    if (rc instanceof NextResponse) return rc

    const [itemsRes, historyRes, settings] = await Promise.all([
        ctx.admin.from('return_case_items').select('*').eq('return_case_id', id).order('created_at'),
        ctx.admin.from('return_case_status_history').select('*').eq('return_case_id', id).order('changed_at'),
        loadSettings(ctx.admin),
    ])

    const sourceOrgId = rc.return_source_organization_id || rc.shop_org_id
    const orgIds = [sourceOrgId, rc.return_warehouse_id].filter(Boolean)
    const { data: orgs } = await ctx.admin.from('organizations').select(ORG_SELECT).in('id', orgIds)
    const orgMap = Object.fromEntries((orgs || []).map((o: any) => [o.id, o]))

    // Resolve changer names for the history log.
    const changerIds = Array.from(new Set((historyRes.data || []).map((h: any) => h.changed_by).filter(Boolean)))
    let userMap: Record<string, string> = {}
    if (changerIds.length > 0) {
        const { data: users } = await ctx.admin.from('users').select('id, full_name').in('id', changerIds)
        userMap = Object.fromEntries((users || []).map((u: any) => [u.id, u.full_name]))
    }

    const createdByName = rc.created_by ? (userMap[rc.created_by] || null) : null
    let creatorName = createdByName
    if (rc.created_by && !creatorName) {
        const { data: creator } = await ctx.admin.from('users').select('full_name').eq('id', rc.created_by).maybeSingle()
        creatorName = (creator as any)?.full_name || null
    }

    const decorated = decorateCase({
        ...(rc as any),
        items: itemsRes.data || [],
        status_history: (historyRes.data || []).map((h: any) => ({ ...h, changed_by_name: h.changed_by ? userMap[h.changed_by] || null : null })),
        source: orgMap[sourceOrgId] || null,
        shop: orgMap[sourceOrgId] || null,
        warehouse: rc.return_warehouse_id ? orgMap[rc.return_warehouse_id] || null : null,
        created_by_name: creatorName,
    }, settings)

    return NextResponse.json({ case: decorated })
}

/** PATCH /api/returns/[id] — update header, items (draft only), or warehouse processing fields. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const ctx = await getReturnContext()
    if (ctx instanceof NextResponse) return ctx
    if (!ctx.isManager) {
        const saDenied = await guardUserOperation(ctx.userId, 'inventory.return.request', { organizationId: ctx.orgId })
        if (saDenied) return saDenied
    }

    const rc = await loadAccessibleCase(ctx, id)
    if (rc instanceof NextResponse) return rc

    if (rc.status === 'return_completed' || rc.status === 'return_cancelled') {
        return NextResponse.json({ error: 'Completed or cancelled returns are read-only' }, { status: 409 })
    }

    const body = await request.json().catch(() => ({}))
    const patch: Record<string, any> = {}

    // Header fields — editable while not terminal.
    if ('contact_person' in body) patch.contact_person = body.contact_person || null
    if ('contact_phone' in body) patch.contact_phone = body.contact_phone || null
    if ('contact_email' in body) patch.contact_email = body.contact_email || null
    if ('notes' in body) patch.notes = body.notes || null
    if ('return_warehouse_id' in body) {
        const warehouseId = body.return_warehouse_id || null
        if (
            warehouseId !== rc.return_warehouse_id
            && rc.status !== 'return_draft'
            && rc.status !== 'return_submitted'
        ) {
            return NextResponse.json(
                { error: 'Return warehouse cannot be changed after inventory receipt/posting has started.' },
                { status: 409 },
            )
        }
        // Revalidate only a changed selection. This keeps historical returns
        // editable/displayable when their original warehouse was later made
        // inactive or moved, without allowing that warehouse on new returns.
        if (warehouseId && warehouseId !== rc.return_warehouse_id) {
            const warehouseCheck = await validateReturnWarehouse(ctx, warehouseId)
            if (!warehouseCheck.ok) {
                return NextResponse.json({ error: warehouseCheck.error }, { status: 400 })
            }
        }
        patch.return_warehouse_id = warehouseId
    }
    // Worksheet context snapshots — editable while in draft.
    if (rc.status === 'return_draft') {
        if ('reported_date' in body) patch.reported_date = body.reported_date || null
        if ('program_snapshot' in body) patch.program_snapshot = body.program_snapshot || null
        if ('category_snapshot' in body) patch.category_snapshot = body.category_snapshot || null
    }
    // Source (Shop/Distributor) — managers may change it while still in draft.
    if (ctx.isManager && rc.status === 'return_draft' && ('return_source_organization_id' in body || 'shop_org_id' in body || 'return_source_type' in body)) {
        const newSourceType = normalizeReturnSourceType(body.return_source_type ?? rc.return_source_type)
        const newSourceOrgId = body.return_source_organization_id || body.shop_org_id || null
        if (newSourceOrgId) {
            const sourceCheck = await validateReturnSource(ctx, newSourceType, newSourceOrgId)
            if (!sourceCheck.ok) return NextResponse.json({ error: sourceCheck.error }, { status: 400 })
            patch.return_source_type = newSourceType
            patch.return_source_organization_id = newSourceOrgId
            patch.shop_org_id = newSourceOrgId // legacy compat — trigger keeps in sync
        }
    }

    // Warehouse processing fields — managers only, once received.
    if (ctx.isManager && (rc.status === 'return_received' || rc.status === 'return_processing')) {
        for (const f of ['received_by', 'received_date', 'processing_notes', 'action_taken', 'return_courier', 'tracking_no', 'completed_date']) {
            if (f in body) patch[f] = body[f] || null
        }
    }

    if (Object.keys(patch).length > 0) {
        const { error } = await ctx.admin.from('return_cases').update(patch).eq('id', id)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Items — full replace, only while in draft. Persist the full worksheet
    // breakdown via the shared builder (v2 quantity model), not just `quantity`.
    if (Array.isArray(body.items) && rc.status === 'return_draft') {
        const { rows: itemRows, error: itemError } = buildReturnItemRows(id, body.items)
        if (itemError) return NextResponse.json({ error: itemError }, { status: 400 })

        const sourceType = normalizeReturnSourceType(patch.return_source_type ?? rc.return_source_type)
        const pricedRows = itemRows && itemRows.length > 0
            ? await applyReturnSourcePrices(ctx.admin, itemRows, sourceType)
            : []

        await ctx.admin.from('return_case_items').delete().eq('return_case_id', id)
        if (pricedRows.length > 0) {
            const insertRows = pricedRows.map(({ id: _id, ...r }) => r)
            const { error: itemsErr } = await ctx.admin.from('return_case_items').insert(insertRows)
            if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 })
        }
    }

    return NextResponse.json({ ok: true })
}

/** DELETE /api/returns/[id] — cancel a return (only before completion). */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const ctx = await getReturnContext()
    if (ctx instanceof NextResponse) return ctx
    if (!ctx.isManager) {
        const saDenied = await guardUserOperation(ctx.userId, 'inventory.return.request', { organizationId: ctx.orgId })
        if (saDenied) return saDenied
    }

    const rc = await loadAccessibleCase(ctx, id)
    if (rc instanceof NextResponse) return rc

    if (rc.status === 'return_completed' || rc.status === 'return_cancelled') {
        return NextResponse.json({ error: 'This return can no longer be cancelled' }, { status: 409 })
    }
    // Shop users may only cancel their own draft.
    if (!ctx.isManager && rc.status !== 'return_draft') {
        return NextResponse.json({ error: 'Only warehouse/support can cancel a submitted return' }, { status: 403 })
    }

    const now = new Date().toISOString()
    const { error } = await ctx.admin
        .from('return_cases')
        .update({ status: 'return_cancelled', cancelled_at: now })
        .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await ctx.admin.from('return_case_status_history').insert({
        return_case_id: id,
        from_status: rc.status,
        to_status: 'return_cancelled',
        changed_by: ctx.userId,
        notes: 'Return cancelled',
    })

    return NextResponse.json({ ok: true })
}
