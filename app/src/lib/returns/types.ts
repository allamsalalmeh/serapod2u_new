import type { ReturnStatus, ReturnSourceType } from './constants'

export interface ReturnCaseItem {
    id: string
    return_case_id: string
    product_id: string | null
    variant_id: string | null
    sku: string | null
    product_name: string | null
    variant_name: string | null
    /** Legacy total-pieces column, kept in sync with total_units. */
    quantity: number
    // Worksheet quantities (v2)
    case_qty: number
    loose_piece_qty: number
    units_per_case_snapshot: number | null
    total_units: number
    unit_cost: number
    /** Price of one stock unit to the return source; values the return. */
    unit_price?: number | null
    reason: string | null
    condition: string | null
    photo_url: string | null
    notes: string | null
    created_at?: string
}

export interface ReturnStatusHistoryEntry {
    id: string
    return_case_id: string
    from_status: string | null
    to_status: string
    changed_by: string | null
    changed_by_name?: string | null
    changed_at: string
    notes: string | null
}

export interface OrgRef {
    id: string
    org_code: string | null
    org_name: string | null
    org_type_code?: string | null
    branch?: string | null
    contact_name?: string | null
    contact_phone?: string | null
    contact_email?: string | null
    address?: string | null
    city?: string | null
    postal_code?: string | null
}

export interface ReturnCase {
    id: string
    return_no: string
    /** Whether this return originates from a Shop or a Distributor. */
    return_source_type: ReturnSourceType
    /** Authoritative source organization (Shop or Distributor). */
    return_source_organization_id: string | null
    /** LEGACY compat column — kept in sync with return_source_organization_id. */
    shop_org_id: string
    return_warehouse_id: string | null
    contact_person: string | null
    contact_phone: string | null
    contact_email: string | null
    status: ReturnStatus
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
    created_by_name?: string | null
    created_at: string
    updated_at: string
    submitted_at: string | null
    received_at: string | null
    processing_started_at: string | null
    completed_at: string | null
    cancelled_at: string | null
    // joined
    /** Source organization (Shop or Distributor) — preferred over `shop`. */
    source?: OrgRef | null
    /** LEGACY alias of `source`, kept for existing consumers. */
    shop?: OrgRef | null
    warehouse?: OrgRef | null
    items?: ReturnCaseItem[]
    status_history?: ReturnStatusHistoryEntry[]
    // computed convenience fields (list/reporting)
    total_qty?: number
    total_value?: number
    days_open?: number
    is_overdue?: boolean
}

export interface ReturnSettings {
    default_return_warehouse_id: string | null
    sla_submitted_to_received_days: number
    sla_received_to_processing_days: number
    sla_processing_to_completed_days: number
    pdf_instruction_text: string | null
    shop_self_service_enabled: boolean
}

export interface ReturnMasterItem {
    id: string
    code: string
    label: string
    sort_order: number
    is_active: boolean
}

export interface ReturnCategoryRef {
    id: string
    category_code: string | null
    category_name: string
}

export interface ReturnMeta {
    isManager: boolean
    userOrgId: string | null
    orgTypeCode: string | null
    shops: OrgRef[]
    warehouses: OrgRef[]
    reasons: ReturnMasterItem[]
    conditions: ReturnMasterItem[]
    categories: ReturnCategoryRef[]
    settings: ReturnSettings
}

/** One selectable/eligible product line for the worksheet (variant granularity). */
export interface EligibleProduct {
    product_id: string
    variant_id: string
    sku_id: string | null
    /** First active SKU code (product_skus.sku_code) — kept for persistence/back-compat. */
    sku: string | null
    /** Variant manual SKU — the user-facing "Internal SKU". */
    manual_sku: string | null
    /** Variant manufacturer SKU — tooltip + search only, never the Internal SKU. */
    manufacturer_sku: string | null
    barcode: string | null
    product_name: string
    variant_name: string | null
    /** product_variants.product_code — the variant half of the shared identity. */
    variant_product_code: string | null
    /** product_variants.alternative_name — the distributor-facing name. */
    alternative_name: string | null
    /** Hero / Zero / S.Box / S.Line / other, classified from the product name. */
    product_line: 'hero' | 'zero' | 'sbox' | 'sline' | 'other'
    image_url: string | null
    units_per_case: number
    unit_cost: number
    distributor_price?: number | null
    retailer_price?: number | null
    is_active: boolean
}

/** Program + category auto-detected from a shop, plus the eligible product list. */
export interface EligibleProductsResult {
    program: { code: string; name: string } | null
    category: ReturnCategoryRef | null
    /** True when the category was auto-resolved from the shop's program. */
    resolved: boolean
    categories: ReturnCategoryRef[]
    products: EligibleProduct[]
}