import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { authorizeOperation, organizationResource } from '@/lib/security-access/operation'
import { isReturnManagerOrgType, computeReturnTotal, type ReturnStatus, RETURN_STATUS_TIMESTAMP_COLUMN, RETURN_SOURCE_ORG_TYPE_CODE, RETURN_SOURCE_LABELS, type ReturnSourceType } from './constants'
import type { ReturnCaseRow, ReturnCaseItemRow } from './database-extension'

/** Columns selected for any source/warehouse organization reference. */
export const RETURN_ORG_SELECT =
    'id, org_code, org_name, org_type_code, branch, contact_name, contact_phone, contact_email, address, city, postal_code'

export interface ReturnContext {
    admin: ReturnType<typeof createAdminClient>
    userId: string
    orgId: string | null
    orgTypeCode: string | null
    roleCode: string | null
    isManager: boolean
}

type ReturnWarehouseQueryResult = {
    data: any[] | null
    error: { message: string } | null
}

/**
 * Load selectable Return Warehouses from Organizations Master Data.
 *
 * A return destination must be an active Warehouse whose direct parent is an
 * active HQ. This deliberately excludes distributor-managed warehouses as well
 * as HQ, distributor, shop, and manufacturer organizations themselves.
 */
export async function loadActiveHqReturnWarehouses(
    // Keep this shared dynamic-select query outside Supabase's generated select
    // inference; callers still pass the server admin client.
    admin: any,
    select = RETURN_ORG_SELECT,
): Promise<ReturnWarehouseQueryResult> {
    const { data: headquarters, error: headquartersError } = await admin
        .from('organizations')
        .select('id')
        .eq('org_type_code', 'HQ')
        .eq('is_active', true)

    if (headquartersError) return { data: null, error: headquartersError }

    const hqIds = (headquarters || []).map((organization: { id: string }) => organization.id)
    if (hqIds.length === 0) return { data: [], error: null }

    const { data, error } = await admin
        .from('organizations')
        .select(select)
        .eq('org_type_code', 'WH')
        .eq('is_active', true)
        .in('parent_org_id', hqIds)
        .order('org_name', { ascending: true })

    return { data, error }
}

/**
 * Resolve the caller's return context (auth + org type). Returns a NextResponse
 * on failure so route handlers can `if (ctx instanceof NextResponse) return ctx`.
 */
export async function getReturnContext(): Promise<ReturnContext | NextResponse> {
    const supabase = await createClient()
    const admin = createAdminClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile, error: profileErr } = await admin
        .from('users')
        .select('organization_id, role_code')
        .eq('id', user.id)
        .single()

    if (profileErr) {
        return NextResponse.json({ error: 'Unable to load user profile' }, { status: 500 })
    }

    const orgId = (profile as any)?.organization_id ?? null
    let orgTypeCode: string | null = null
    if (orgId) {
        const { data: org } = await admin
            .from('organizations')
            .select('org_type_code')
            .eq('id', orgId)
            .single()
        orgTypeCode = (org as any)?.org_type_code ?? null
    }

    const roleCode = (profile as any)?.role_code ?? null
    const legacyIsManager = roleCode === 'SA' || isReturnManagerOrgType(orgTypeCode)
    // Return management is an S&A decision in the actor's own organization;
    // the historical org-type rule is the legacy evaluator.
    const isManager = orgId
        ? await authorizeOperation({
            actorId: user.id,
            permission: 'inventory.return.manage',
            resource: organizationResource('return_case', orgId),
            legacy: () => legacyIsManager,
        }).then(d => d.decision === 'ALLOW').catch(() => false)
        : false

    return {
        admin,
        userId: user.id,
        orgId,
        orgTypeCode,
        roleCode,
        isManager,
    }
}

/**
 * Call admin.from('return_cases') — the table is not yet present in the
 * generated Database type. A thin helper keeps the cast scoped to a single
 * function while the admin client retains full typing for all other tables.
 *
 * TODO: Remove this helper after regenerating Supabase types.
 */
function returnCasesTable(ctx: ReturnContext) {
    return (ctx.admin as any).from('return_cases')
}

/**
 * Call admin.from('return_case_items') — same rationale as returnCasesTable.
 *
 * TODO: Remove this helper after regenerating Supabase types.
 */
function returnCaseItemsTable(ctx: ReturnContext) {
    return (ctx.admin as any).from('return_case_items')
}

/** Fetch a case and verify the caller may access it. Returns the case row or a NextResponse error. */
export async function loadAccessibleCase(ctx: ReturnContext, id: string) {
    const { data, error } = await returnCasesTable(ctx)
        .select('*')
        .eq('id', id)
        .single()

    if (error || !data) {
        return NextResponse.json({ error: 'Return case not found' }, { status: 404 })
    }

    const row = data as unknown as ReturnCaseRow
    if (!ctx.isManager && row.shop_org_id !== ctx.orgId) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    return row
}

/** Column that stamps the moment a case entered `status`. */
export function statusTimestampColumn(status: ReturnStatus): string | null {
    return RETURN_STATUS_TIMESTAMP_COLUMN[status] ?? null
}

/**
 * Authoritative server-side check that a submitted `return_warehouse_id` is a
 * usable return destination: it exists, is active, is a Warehouse
 * (org_type_code = 'WH'), and belongs directly to an active HQ organization.
 */
export async function validateReturnWarehouse(
    ctx: ReturnContext,
    warehouseId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const { data: org, error } = await ctx.admin
        .from('organizations')
        .select('id, org_type_code, is_active, parent_org_id')
        .eq('id', warehouseId)
        .maybeSingle()

    if (error) return { ok: false, error: 'Unable to validate the selected Return Warehouse.' }
    if (!org) return { ok: false, error: 'The selected Return Warehouse does not exist.' }
    if ((org as any).org_type_code !== 'WH') {
        return { ok: false, error: 'The selected organization is not a Warehouse and cannot be used as a Return Warehouse.' }
    }
    if ((org as any).is_active !== true) {
        return { ok: false, error: 'The selected Return Warehouse is inactive.' }
    }

    if (!(org as any).parent_org_id) {
        return { ok: false, error: 'The selected Return Warehouse is not managed under Serapod HQ.' }
    }

    const { data: parent, error: parentError } = await ctx.admin
        .from('organizations')
        .select('id, org_type_code, is_active')
        .eq('id', (org as any).parent_org_id)
        .maybeSingle()

    if (parentError) return { ok: false, error: 'Unable to validate the selected Return Warehouse.' }
    if (!parent || (parent as any).org_type_code !== 'HQ' || (parent as any).is_active !== true) {
        return { ok: false, error: 'The selected Return Warehouse is not managed under an active Serapod HQ.' }
    }
    return { ok: true }
}

/**
 * Authoritative server-side check that a submitted return source organization is
 * usable: it exists, is active, and its org type matches the declared source
 * type (Shop -> SHOP, Distributor -> DIST). Returns the org row on success so
 * callers can snapshot its contact details.
 */
export async function validateReturnSource(
    ctx: ReturnContext,
    sourceType: ReturnSourceType,
    organizationId: string,
): Promise<{ ok: true; org: any } | { ok: false; error: string }> {
    const label = RETURN_SOURCE_LABELS[sourceType]
    const { data: org, error } = await ctx.admin
        .from('organizations')
        .select(RETURN_ORG_SELECT + ', is_active')
        .eq('id', organizationId)
        .maybeSingle()

    if (error) return { ok: false, error: `Unable to validate the selected ${label}.` }
    if (!org) return { ok: false, error: `The selected ${label} does not exist.` }
    if ((org as any).org_type_code !== RETURN_SOURCE_ORG_TYPE_CODE[sourceType]) {
        return { ok: false, error: `The selected organization is not a ${label}.` }
    }
    if ((org as any).is_active === false) {
        return { ok: false, error: `The selected ${label} is inactive.` }
    }
    return { ok: true, org }
}

/**
 * Validate + normalize worksheet items into insertable return_case_items rows.
 *
 * Server-side authority for the quantity model: Total Pcs is recomputed from
 * Case + Loose Pcs + Units-per-Case (never trusting the client's totals), rows
 * with Total Pcs = 0 are dropped, quantities must be non-negative integers, and
 * duplicate variants/SKUs are rejected. Returns `{ error }` on invalid input.
 */
export function buildReturnItemRows(
    returnCaseId: string,
    items: any[],
): { rows?: ReturnCaseItemRow[]; error?: string } {
    const seen = new Set<string>()
    const rows: ReturnCaseItemRow[] = []

    for (const it of Array.isArray(items) ? items : []) {
        const caseQty = Number(it.case_qty ?? 0)
        const looseQty = Number(it.loose_piece_qty ?? 0)

        if (!Number.isInteger(caseQty) || !Number.isInteger(looseQty) || caseQty < 0 || looseQty < 0) {
            return { error: 'Return quantities must be non-negative whole numbers.' }
        }

        // Server authority: recompute Total Pcs from the physical breakdown; never
        // trust the client total. Case/Loose are preserved as submitted (no carry).
        const norm = computeReturnTotal(caseQty, looseQty, it.units_per_case_snapshot)
        if (norm.total_units <= 0) continue // never store empty rows

        // Reject duplicate SKUs / variants within a single case.
        const key = it.variant_id || it.sku || it.product_name || null
        if (key) {
            const k = String(key).toLowerCase()
            if (seen.has(k)) return { error: 'Duplicate product / SKU rows are not allowed.' }
            seen.add(k)
        }

        rows.push({
            id: '', // placeholder — assigned by DB on insert
            return_case_id: returnCaseId,
            product_id: it.product_id || null,
            variant_id: it.variant_id || null,
            sku: it.sku || null,
            product_name: it.product_name || null,
            variant_name: it.variant_name || null,
            case_qty: norm.case_qty,
            loose_piece_qty: norm.loose_piece_qty,
            units_per_case_snapshot: norm.units_per_case,
            total_units: norm.total_units,
            quantity: norm.total_units, // legacy mirror
            unit_cost: Number(it.unit_cost) >= 0 ? Number(it.unit_cost) : 0,
            reason: it.reason || null,
            condition: it.condition || null,
            photo_url: it.photo_url || null,
            notes: it.notes || null,
        })
    }

    return { rows }
}

/**
 * Sets each line's unit_price from master data for the return source: distributor
 * returns at distributor_price, shop returns at retailer_price. Never taken from the
 * client. A variant without that price keeps unit_price null.
 */
export async function applyReturnSourcePrices(
    admin: any,
    rows: ReturnCaseItemRow[],
    sourceType: ReturnSourceType,
): Promise<ReturnCaseItemRow[]> {
    const ids = [...new Set(rows.map((r) => r.variant_id).filter((id): id is string => Boolean(id)))]
    if (ids.length === 0) return rows.map((r) => ({ ...r, unit_price: null }))
    const { data, error } = await admin
        .from('product_variants')
        .select('id, distributor_price, retailer_price')
        .in('id', ids)
    if (error) throw new Error(`Could not load product prices: ${error.message}`)
    const prices = new Map<string, any>((data || []).map((v: any) => [String(v.id), v]))
    return rows.map((r) => {
        const v = r.variant_id ? prices.get(r.variant_id) : null
        const raw = sourceType === 'distributor' ? v?.distributor_price : v?.retailer_price
        const price = raw == null ? NaN : Number(raw)
        return { ...r, unit_price: Number.isFinite(price) && price >= 0 ? price : null }
    })
}
