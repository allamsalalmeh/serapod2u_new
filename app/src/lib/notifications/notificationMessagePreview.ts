/**
 * Notification Configure drawer — message preview helpers.
 *
 * The outbox worker fills `{{key}}` from the event payload and leaves any
 * placeholder without a payload value as literal text. The preview mirrors
 * that: keys with sample data are filled, everything else stays visible as an
 * unresolved placeholder instead of being invented.
 */
import type { NotificationRoutingPreset } from '@/lib/notifications/routing'

export interface PreviewType {
    event_code: string
    event_name?: string
    category?: string
}

/** Sample values for the preview and test sends. Fixtures only — never real data. */
export function buildNotificationSampleData(type: PreviewType, sampleId = ''): Record<string, string> {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://app.serapod2u.com'
    const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    const shortDate = new Date().toLocaleDateString('en-GB')
    const dateTime = new Date().toLocaleString('en-GB')
    return {
        // Order variables
        order_no: sampleId || 'ORD26000048',
        order_date: date,
        status: 'Approved',
        amount: '2,800.00',
        customer_name: 'Serapod Technology Sdn Bhd',
        customer_phone: '+60147519216',
        delivery_address: 'No4, Tingkat1, Lorong Perniagaan Alma Jaya 11, Taman Alma Jaya',
        approved_by: 'Admin User',
        approved_at: shortDate,
        closed_at: shortDate,
        action: 'Cancelled',
        reason: 'Out of stock',
        order_url: `${origin}/supply-chain`,
        item_list: '• Cellera Hero – Deluxe Cellera Cartridge [Keladi Cheese] × 100 units (1 case) — RM 1,400.00\n• Super Pod V2 – Classic Mint × 200 units (2 cases) — RM 1,400.00',
        total_cases: '3',
        total_items: '2',
        buyer_org: 'Serapod Technology Sdn Bhd',
        seller_org: 'Shenzen VapeHome Technologies',
        // Order creator (the worker fills both keys from the order's creator)
        created_by: 'Order Creator',
        User: 'Order Creator',
        // Order Deleted variables
        deleted_by: 'Super Admin',
        deleted_at: dateTime,
        // Manufacturer Scan Complete variables
        batch_id: 'BATCH-2024-00012',
        total_master_codes: '50',
        total_unique_codes: '5,000',
        production_completed_at: dateTime,
        completed_by: 'Manufacturing Operator',
        balance_document_no: 'PR26000012',
        // QR Batch Generated variables
        generated_at: dateTime,
        // Warehouse Received variables
        total_received: '5,000',
        warehouse_name: 'Main Warehouse KL',
        received_at: dateTime,
        // Document Workflow variables
        doc_no: 'PO26000015',
        doc_date: date,
        doc_status: 'Pending Acknowledgement',
        buyer_name: 'Serapod Technology Sdn Bhd',
        seller_name: 'Shenzen VapeHome Technologies',
        deposit_amount: '840.00',
        balance_amount: '1,960.00',
        invoice_no: 'INV26000015',
        payment_no: 'PAY26000015',
        receipt_no: 'REC26000015',
        acknowledged_by: 'Factory Manager',
        acknowledged_at: dateTime,
        document_url: `${origin}/supply-chain`,
        // Inventory variables
        product_name: 'Cellera Hero',
        variant_name: 'Deluxe Cartridge [Keladi Cheese]',
        sku: 'CLR-DLX-KC-001',
        available_qty: '15',
        reorder_point: '20',
        reorder_qty: '100',
        quantity_received: '500',
        total_on_hand: '515',
        inventory_url: `${origin}/inventory`,
        // Stock Count verification variables (safe fixture only)
        verification_code: '12345678',
        target_user_name: 'Allam Salameh',
        requester_email: 'admin@serapod2u.com',
        otp_expiry_minutes: '5',
        total_variants_counted: '4',
        variance_items: '4',
        net_quantity_adjustment: '-5,595',
        estimated_adjustment_value: 'RM -77,361.21',
        organization_name: 'Serapod2U',
        count_date: '14 Jul 2026',
        count_type: 'Full Count',
        reference_name: '—',
        requested_by: 'Admin User',
        stock_count_requested_at: '15 Jul 2026, 10:30 AM (Asia/Kuala_Lumpur)',
        posting_note: 'Scheduled warehouse reconciliation',
        // QR / Consumer variables
        qr_code: 'QR-ABC-12345',
        scan_location: 'Kuala Lumpur, MY',
        scanned_at: dateTime,
        consumer_name: 'Ahmad bin Ali',
        consumer_phone: '+60123456789',
        points_earned: '50',
        total_points: '350',
        entry_number: 'LD-2024-00042',
        entry_status: 'Confirmed',
        reward_name: 'Free Starter Kit',
        points_used: '200',
        remaining_points: '150',
        // User variables
        user_name: 'Jane Smith',
        user_email: 'jane@example.com',
        user_role: 'Admin',
        created_at: shortDate,
        activated_at: shortDate,
        deactivated_at: shortDate,
        changed_at: dateTime,
        requested_at: dateTime,
        ip_address: '203.0.113.42',
        login_location: 'Unknown Location',
        login_time: dateTime,
        // Order extras, documents, shops, RoadTour, returns
        order_type: 'Distributor',
        doc_type: 'PO',
        issued_by: 'Serapod Technology Sdn Bhd',
        issued_to: 'Shenzen VapeHome Technologies',
        shop_name: 'Kedai Vape Alma',
        shop_branch: 'Bukit Mertajam',
        shop_state: 'Pulau Pinang',
        contact_name: 'Ali bin Abu',
        contact_phone: '+60123000111',
        contact_email: 'shop@example.com',
        creator_name: 'Jane Smith',
        creator_email: 'jane@example.com',
        creator_phone: '+60123000222',
        campaign_name: 'RoadTour Penang',
        qr_url: `${origin}/roadtour/qr`,
        qr_image_url: `${origin}/roadtour/qr.png`,
        return_no: 'RT26000007',
        return_status: 'Submitted',
        return_source_type: 'Shop',
        return_source_name: 'Kedai Vape Alma',
        return_source_code: 'SH0042',
        return_warehouse_name: 'Main Warehouse KL',
        reported_date: date,
        total_quantity: '12',
        total_value: '240.00',
        updated_at: date,
        // Generic
        event_name: type.event_name || 'Order Submitted',
        reference_id: sampleId || 'ORD26000048',
        ...(type.event_code.startsWith('tiktok_shop_daily_report') ? TIKTOK_DAILY_SAMPLE : {}),
    }
}

const TIKTOK_DAILY_SAMPLE: Record<string, string> = {
    report_title: 'to pack',
    report_date: '7/10/2026',
    report_time: '9:35 am',
    shop_counts: 'SeraOutdoor 3 parcels/8 items; Ellbow 4 parcels/5 items',
    total_parcels: '7',
    total_items: '13',
    summary_text: '[Serapod2U] TikTok to pack 7/10/2026 9:35 am: SeraOutdoor 3 parcels/8 items; Ellbow 4 parcels/5 items.',
    email_subject: 'TikTok Shop - to pack (7/10/2026, 9:35 am)',
    report_text: 'TIKTOK SHOP - TO PACK\n7/10/2026, 9:35 am\n\nSERAOUTDOOR\nACCOUNT : TIKTOK SERAOUTDOOR\nORDER : 6/10/2026\n------------------------------\nTOTAL ITEMS : 8\nTOTAL PARCEL : 3\n------------------------------\nITEMS\nHIGHBACK : 4\nTUMBLER 1L : 3\nMOONCHAIR : 1\n...',
}

// Payload keys taken from each notification's actual producer. Keep in sync
// when a producer changes; the drawer offers exactly these as variables.
//  - Order status: buildOrderEventPayload (supplyChainEventQueue.ts) and the
//    trigger_order_notification SQL trigger send the same keys.
//  - User / created_by: the outbox worker's ensureOrderOwnerContact fills them
//    from the order whose display number is in `order_no`.
const ORDER_PAYLOAD = ['order_no', 'order_date', 'order_type', 'status', 'buyer_org', 'seller_org', 'customer_name', 'customer_phone', 'delivery_address', 'amount', 'total_cases', 'total_items', 'item_list', 'order_url']
const ORDER_CREATOR = ['User', 'created_by']
const TIKTOK_DAILY_PAYLOAD = ['report_title', 'report_date', 'report_time', 'shop_counts', 'total_parcels', 'total_items', 'summary_text']
const RETURN_PAYLOAD = ['return_no', 'return_status', 'return_source_type', 'return_source_name', 'return_source_code', 'return_warehouse_name', 'reported_date', 'total_quantity', 'total_value', 'contact_name', 'updated_at']

const EVENT_VARIABLES: Record<string, string[]> = {
    order_submitted: [...ORDER_PAYLOAD, ...ORDER_CREATOR],
    order_approved: [...ORDER_PAYLOAD, 'approved_by', 'approved_at', ...ORDER_CREATOR],
    order_rejected: [...ORDER_PAYLOAD, 'reason', 'action', ...ORDER_CREATOR],
    order_closed: [...ORDER_PAYLOAD, 'closed_at', ...ORDER_CREATOR],
    // api/orders/delete — the order is gone before sending, so no creator lookup.
    order_deleted: ['order_no', 'order_date', 'customer_name', 'status', 'deleted_by', 'deleted_at', 'order_url'],
    // api/manufacturer/complete-production
    manufacturer_scan_complete: ['order_no', 'batch_id', 'total_master_codes', 'total_unique_codes', 'production_completed_at', 'completed_by', 'customer_name', 'balance_document_no', 'order_url', ...ORDER_CREATOR],
    // lib/qr-batch-generation
    qr_batch_generated: ['order_no', 'batch_id', 'total_master_codes', 'total_unique_codes', 'generated_at', 'order_url', ...ORDER_CREATOR],
    // cron/warehouse-receiving-worker
    warehouse_received: ['order_no', 'batch_id', 'total_received', 'warehouse_name', 'received_at', 'order_url', ...ORDER_CREATOR],
    // api/shops/create
    user_created_shop: ['shop_name', 'shop_branch', 'shop_state', 'contact_name', 'contact_phone', 'contact_email', 'creator_name', 'creator_email', 'creator_phone', 'created_at'],
    // api/roadtour/send-qr-whatsapp
    roadtour_qr_delivery: ['campaign_name', 'reference_name', 'qr_url', 'qr_image_url'],
    // lib/notifications/transactional-otp-router
    delete_user_otp: ['verification_code', 'target_user_name', 'requester_email', 'otp_expiry_minutes'],
    // server/auth buildPasswordResetOtpSms / buildRegistrationOtpSms (SMS)
    password_reset_otp: ['verification_code', 'otp_expiry_minutes'],
    registration_otp: ['verification_code', 'otp_expiry_minutes'],
    // api/notifications/sms-check sends the saved SMS text as is
    system_sms_check: [],
    // lib/returns/notifications
    return_draft_created: RETURN_PAYLOAD,
    return_submitted: RETURN_PAYLOAD,
    return_received: RETURN_PAYLOAD,
    return_processing: RETURN_PAYLOAD,
    return_completed: RETURN_PAYLOAD,
    // lib/marketplace/tiktok-daily-report-server
    tiktok_shop_daily_report: [...TIKTOK_DAILY_PAYLOAD, 'report_text', 'email_subject'],
    tiktok_shop_daily_report_sms: TIKTOK_DAILY_PAYLOAD,
}

// trigger_document_notification (SQL) sends only these. Its order_no is the
// internal number, so the creator lookup by display number does not apply.
const DOCUMENT_PAYLOAD = ['doc_type', 'doc_no', 'order_no', 'issued_by', 'issued_to']

/**
 * Notifications whose sender builds the message itself, so saved templates
 * are never used.
 */
export const FIXED_MESSAGE_EVENTS: Record<string, string> = {
    delete_organization_verification_code: 'The verification message is built by the deletion flow.',
    stock_count_posting_verification: 'The verification email is built by the Stock Count posting flow.',
    return_report_email: 'The subject and message are written when the report is sent.',
}

// Category lists kept for notifications with no producer in this app. They
// are documented intent, not a verified payload.
const UNVERIFIED_CATEGORY_VARIABLES: Record<string, string[]> = {
    inventory: ['product_name', 'variant_name', 'sku', 'warehouse_name', 'available_qty', 'reorder_point', 'reorder_qty', 'quantity_received', 'total_on_hand', 'inventory_url'],
    qr: ['product_name', 'variant_name', 'qr_code', 'scan_location', 'scanned_at', 'consumer_name', 'consumer_phone', 'points_earned', 'total_points', 'entry_number', 'entry_status', 'reward_name', 'points_used', 'remaining_points'],
    user: ['user_name', 'user_email', 'user_role', 'created_at', 'activated_at', 'deactivated_at', 'changed_at', 'requested_at', 'ip_address', 'login_location', 'login_time'],
}

/** Variables this notification's sender supplies, and whether that was verified against the sender. */
export function notificationVariableContract(type: PreviewType): { variables: string[]; verified: boolean } {
    const own = EVENT_VARIABLES[type.event_code]
    if (own) return { variables: own, verified: true }
    if (type.category === 'document') return { variables: DOCUMENT_PAYLOAD, verified: true }
    if (type.category === 'return') return { variables: RETURN_PAYLOAD, verified: true }
    return { variables: UNVERIFIED_CATEGORY_VARIABLES[type.category || ''] || [], verified: false }
}

export const notificationVariables = (type: PreviewType) => notificationVariableContract(type).variables

const PLACEHOLDER = /\{\{(\w+)\}\}/g

/** Placeholder names used in a template, in order of first use. */
export function templatePlaceholders(template: string): string[] {
    return Array.from(new Set(Array.from(template.matchAll(PLACEHOLDER), (match) => match[1])))
}

/** Placeholders the template uses that this notification's variable list does not include. */
export function unknownPlaceholders(template: string, variables: string[]): string[] {
    const known = new Set(variables)
    return templatePlaceholders(template).filter((name) => !known.has(name))
}

export type PreviewSegment =
    | { kind: 'text'; text: string }
    | { kind: 'value'; text: string; name: string }
    | { kind: 'unresolved'; text: string; name: string }

/**
 * Split a template into literal text, sample-filled values and unresolved
 * placeholders. Only names in `variables` are filled — a placeholder outside
 * the notification's contract stays unresolved even if some other event has
 * sample data for it, because the worker would send it as literal text.
 */
export function renderPreviewSegments(template: string, sample: Record<string, string>, variables: string[]): PreviewSegment[] {
    const allowed = new Set(variables)
    const segments: PreviewSegment[] = []
    let last = 0
    for (const match of template.matchAll(PLACEHOLDER)) {
        const index = match.index ?? 0
        if (index > last) segments.push({ kind: 'text', text: template.slice(last, index) })
        const name = match[1]
        const value = allowed.has(name) ? sample[name] : undefined
        segments.push(value !== undefined ? { kind: 'value', text: value, name } : { kind: 'unresolved', text: match[0], name })
        last = index + match[0].length
    }
    if (last < template.length) segments.push({ kind: 'text', text: template.slice(last) })
    return segments
}

export type NotificationChannel = 'whatsapp' | 'sms' | 'email'

/** Channels in the order a preset attempts them (later ones are fallbacks). */
export const PRESET_CHANNELS: Record<NotificationRoutingPreset, NotificationChannel[]> = {
    whatsapp_only: ['whatsapp'],
    email_only: ['email'],
    sms_only: ['sms'],
    whatsapp_email_fallback: ['whatsapp', 'email'],
    whatsapp_sms_email_fallback: ['whatsapp', 'sms', 'email'],
}
