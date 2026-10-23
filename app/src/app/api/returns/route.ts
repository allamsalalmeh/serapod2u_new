import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { getReturnContext, buildReturnItemRows, applyReturnSourcePrices, validateReturnSource, validateReturnWarehouse, RETURN_ORG_SELECT } from '@/lib/returns/server'
import { decorateCase } from '@/lib/returns/compute'
import { normalizeReturnSourceType, sourceTypeForOrgTypeCode } from '@/lib/returns/constants'
import { triggerReturnNotification } from '@/lib/returns/notifications'
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

/**
 * GET /api/returns
 * List return cases visible to the caller, with optional filters.
 */
export async function GET(request: NextRequest) {
    const ctx = await getReturnContext()
    if (ctx instanceof NextResponse) return ctx

    const sp = request.nextUrl.searchParams
    const status = sp.get('status')
    const shopId = sp.get('shop')
    const warehouseId = sp.get('warehouse')
    const search = sp.get('search')?.trim()
    const from = sp.get('from')
    const to = sp.get('to')

    let query = ctx.admin
        .from('return_cases')
        .select(`*, items:return_case_items (*)`)
        .order('created_at', { ascending: false })

    // Shop users only ever see their own shop's returns.
    if (!ctx.isManager) {
        query = query.eq('shop_org_id', ctx.orgId || '00000000-0000-0000-0000-000000000000')
    } else if (shopId) {
        query = query.eq('shop_org_id', shopId)
    }
    if (status) query = query.eq('status', status)
    if (warehouseId) query = query.eq('return_warehouse_id', warehouseId)
    if (from) query = query.gte('created_at', from)
    if (to) query = query.lte('created_at', to)
    if (search) query = query.ilike('return_no', `%${search}%`)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const settings = await loadSettings(ctx.admin)

    // Resolve source/warehouse names for the rows.
    const orgIds = Array.from(new Set(
        (data || []).flatMap((r: any) => [r.return_source_organization_id || r.shop_org_id, r.return_warehouse_id]).filter(Boolean),
    ))
    let orgMap: Record<string, any> = {}
    if (orgIds.length > 0) {
        const { data: orgs } = await ctx.admin.from('organizations').select(ORG_SELECT).in('id', orgIds)
        orgMap = Object.fromEntries((orgs || []).map((o: any) => [o.id, o]))
    }

    const rows = (data || []).map((r: any) => {
        const source = orgMap[r.return_source_organization_id || r.shop_org_id] || null
        return decorateCase({ ...r, source, shop: source, warehouse: orgMap[r.return_warehouse_id] || null }, settings)
    })

    return NextResponse.json({ cases: rows })
}

/**
 * POST /api/returns
 * Create a new return draft (header + optional items).
 */
export async function POST(request: NextRequest) {
    const ctx = await getReturnContext()
    if (ctx instanceof NextResponse) return ctx

    if (!ctx.isManager) {
        const saDenied = await guardUserOperation(ctx.userId, 'inventory.return.request', { organizationId: ctx.orgId })
        if (saDenied) return saDenied
    }

    const body = await request.json().catch(() => ({}))

    // Resolve the return source (Shop or Distributor). Managers choose; a shop
    // self-service user is always a Shop return from their own shop.
    let sourceType = normalizeReturnSourceType(body.return_source_type)
    let sourceOrgId: string | null = ctx.isManager
        ? (body.return_source_organization_id || body.shop_org_id || null)
        : ctx.orgId
    if (!ctx.isManager) {
        // A self-service user's own org determines the source type.
        sourceType = sourceTypeForOrgTypeCode(ctx.orgTypeCode) || 'shop'
    }

    if (!sourceOrgId) {
        return NextResponse.json(
            { error: sourceType === 'distributor' ? 'Please select a distributor.' : 'Please select a shop.' },
            { status: 400 },
        )
    }

    const sourceCheck = await validateReturnSource(ctx, sourceType, sourceOrgId)
    if (!sourceCheck.ok) {
        return NextResponse.json({ error: sourceCheck.error }, { status: 400 })
    }

    const settings = await loadSettings(ctx.admin)
    const warehouseId = body.return_warehouse_id || settings.default_return_warehouse_id || null
    if (warehouseId) {
        const warehouseCheck = await validateReturnWarehouse(ctx, warehouseId)
        if (!warehouseCheck.ok) {
            return NextResponse.json({ error: warehouseCheck.error }, { status: 400 })
        }
    }

    // Build worksheet item rows first so a bad payload fails before we create a
    // header (v2 quantity model: Case / Loose / Units-per-Case / Total Pcs).
    const { rows: itemRows, error: itemError } = buildReturnItemRows('', Array.isArray(body.items) ? body.items : [])
    if (itemError) {
        return NextResponse.json({ error: itemError }, { status: 400 })
    }

    const { data: created, error } = await ctx.admin
        .from('return_cases')
        .insert({
            return_source_type: sourceType,
            return_source_organization_id: sourceOrgId,
            shop_org_id: sourceOrgId, // legacy compat — kept in sync by trigger
            return_warehouse_id: warehouseId,
            contact_person: body.contact_person || null,
            contact_phone: body.contact_phone || null,
            contact_email: body.contact_email || null,
            reported_date: body.reported_date || null,
            program_snapshot: body.program_snapshot || null,
            category_snapshot: body.category_snapshot || null,
            notes: body.notes || null,
            status: 'return_draft',
            created_by: ctx.userId,
        })
        .select('*')
        .single()

    if (error || !created) {
        return NextResponse.json({ error: error?.message || 'Failed to create return' }, { status: 500 })
    }

    // Persist the full worksheet breakdown (case_qty, loose_piece_qty,
    // units_per_case_snapshot, total_units, …) — not just the legacy quantity.
    if (itemRows && itemRows.length > 0) {
        const pricedRows = await applyReturnSourcePrices(ctx.admin, itemRows, sourceType)
        const insertRows = pricedRows.map(({ id: _id, ...r }) => ({ ...r, return_case_id: created.id }))
        const { error: insertErr } = await ctx.admin.from('return_case_items').insert(insertRows)
        if (insertErr) {
            return NextResponse.json({ error: insertErr.message }, { status: 500 })
        }
    }

    await ctx.admin.from('return_case_status_history').insert({
        return_case_id: created.id,
        from_status: null,
        to_status: 'return_draft',
        changed_by: ctx.userId,
        notes: 'Return draft created',
    })

    // Fire the "Return Draft Created" notification once, now that the record
    // exists and has a Return No. Non-blocking: never affects this response.
    const notify = await triggerReturnNotification(ctx.admin, request.nextUrl.origin, {
        returnCaseId: created.id,
        status: 'return_draft',
    })

    return NextResponse.json(
        { id: created.id, return_no: created.return_no, notificationWarnings: notify.warnings },
        { status: 201 },
    )
}
