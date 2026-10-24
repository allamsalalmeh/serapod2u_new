/**
 * TEMPORARY TYPE EXTENSION — REMOVE AFTER SUPABASE TYPE REGENERATION
 *
 * The `return_cases` and `return_case_items` tables exist in the database
 * (created by migration 20260708_return_product_module_01.sql and extended
 * by 20260712_return_product_worksheet_v2.sql) but are currently **missing**
 * from the generated Database type at `app/src/types/database.ts`.
 *
 * After applying the pending migrations and running the project's type-
 * generation command (e.g. `supabase gen types typescript`), delete this file
 * and remove all imports referencing it.
 *
 * Do NOT use these types to cast the entire Supabase client to `any`.
 */

// ── Row types matching the actual DB columns (snapshot as of 2026-07-12) ──

export interface ReturnCaseRow {
    id: string
    return_no: string
    return_source_type: string
    return_source_organization_id: string | null
    /** LEGACY compat column — kept in sync with return_source_organization_id. */
    shop_org_id: string
    return_warehouse_id: string | null
    contact_person: string | null
    contact_phone: string | null
    contact_email: string | null
    status: string
    notes: string | null
    reported_date: string | null
    program_snapshot: string | null
    category_snapshot: string | null
    received_by: string | null
    received_date: string | null
    processing_notes: string | null
    action_taken: string | null
    return_courier: string | null
    tracking_no: string | null
    completed_date: string | null
    created_by: string | null
    created_at: string
    updated_at: string
    submitted_at: string | null
    received_at: string | null
    processing_started_at: string | null
    completed_at: string | null
    cancelled_at: string | null
}

export interface ReturnCaseItemRow {
    id: string
    return_case_id: string
    product_id: string | null
    variant_id: string | null
    sku: string | null
    product_name: string | null
    variant_name: string | null
    /** Legacy total-pieces column, kept in sync with total_units. */
    quantity: number
    case_qty: number
    loose_piece_qty: number
    units_per_case_snapshot: number | null
    total_units: number
    unit_cost: number
    unit_price?: number | null
    reason: string | null
    condition: string | null
    photo_url: string | null
    notes: string | null
    created_at?: string
}