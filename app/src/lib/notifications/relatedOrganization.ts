/**
 * "Related organization" recipient source for Supply Chain notifications.
 *
 * Resolves the distributor or manufacturer that is a party to the transaction
 * behind one event, from the transaction's own buyer/seller organization IDs,
 * and returns that organization's master-data contact (organizations.contact_phone
 * / organizations.contact_email). Nothing is matched by name, nothing is
 * hardcoded, the logged-in user's organization is never used as the
 * counterparty, and no organization type is ever expanded to "all of them".
 *
 * Shared by the outbox worker and the Configure drawer preview
 * (via collectConfiguredRecipients), so both resolve exactly the same contact.
 *
 * Transaction mapping (orders.order_type → party → expected org type):
 *   H2M  HQ buys from a manufacturer  → seller_org_id → MFG/MANU
 *   D2H  a distributor buys from HQ   → buyer_org_id  → DIST
 *   S2D  a shop buys from a distributor → seller_org_id → DIST
 * Document events (PO, invoice, payment, receipt) use the document's parent
 * order (documents.order_id) and the same mapping — a PO is never assumed to
 * belong to H2M.
 */
import { toSmsE164 } from '@/lib/notifications/manualPhoneNumbers'

/** Default for newly enabled "Related organization": the party linked to the transaction. */
export const RELATED_ORG_AUTO = 'transaction_counterparty'

/** Explicit choices saved before automatic resolution existed. Kept as saved. */
export const LEGACY_RELATED_ORG_TARGETS = ['manufacturer', 'distributor', 'warehouse'] as const
export type LegacyRelatedOrgTarget = typeof LEGACY_RELATED_ORG_TARGETS[number]

export type RelatedOrgTargetState =
    | { kind: 'auto' }
    | { kind: 'explicit'; target: LegacyRelatedOrgTarget }
    | { kind: 'unset' }
    | { kind: 'unknown'; value: string }

/** How a saved dynamic_target reads. Never reinterprets a saved value. */
export function relatedOrgTargetState(dynamicTarget: unknown): RelatedOrgTargetState {
    const value = String(dynamicTarget ?? '').trim()
    if (!value) return { kind: 'unset' }
    if (value === RELATED_ORG_AUTO) return { kind: 'auto' }
    if ((LEGACY_RELATED_ORG_TARGETS as readonly string[]).includes(value)) return { kind: 'explicit', target: value as LegacyRelatedOrgTarget }
    return { kind: 'unknown', value }
}

type Party = 'buyer' | 'seller'
export const COUNTERPARTY_BY_ORDER_TYPE: Record<string, { party: Party; orgTypes: string[]; description: string }> = {
    H2M: { party: 'seller', orgTypes: ['MFG', 'MANU'], description: 'Manufacturer the purchase order is placed with' },
    D2H: { party: 'buyer', orgTypes: ['DIST'], description: 'Distributor that placed the sales order' },
    S2D: { party: 'seller', orgTypes: ['DIST'], description: 'Distributor the shop ordered from' },
}

const MANUFACTURER_TYPES = ['MFG', 'MANU']
const DISTRIBUTOR_TYPES = ['DIST']

/** Events whose payload carries a document (doc_no + doc_type) rather than just an order. */
export const DOCUMENT_EVENTS = new Set([
    'po_created', 'po_acknowledged', 'invoice_created', 'invoice_acknowledged',
    'balance_request_created', 'payment_received', 'balance_payment_received', 'receipt_issued',
])

/** Events with an order behind them, so Related organization can resolve. */
export const RELATED_ORG_EVENTS = new Set([
    'order_submitted', 'order_approved', 'order_rejected', 'order_closed',
    'qr_batch_generated', 'manufacturer_scan_complete', 'warehouse_received',
    ...DOCUMENT_EVENTS,
])

export type RelatedOrgReason =
    | 'not_configured'
    | 'legacy_target_ambiguous'
    | 'unsupported_event'
    | 'transaction_not_found'
    | 'transaction_ambiguous'
    | 'outside_organization'
    | 'unsupported_transaction_type'
    | 'organization_not_found'
    | 'unexpected_organization_type'
    | 'organization_inactive'
    | 'missing_phone'
    | 'invalid_phone'
    | 'missing_email'
    | 'invalid_email'
    | 'invalid_reference'
    | 'lookup_failed'

export interface RelatedOrganization {
    id: string
    name: string
    typeCode: string
    phone: string | null
    email: string | null
}

export type RelatedOrgResolution =
    | {
        status: 'resolved'
        organization: RelatedOrganization
        /** Which side of the order the organization is on. */
        relationship: Party | 'warehouse'
        orderId: string
        orderType: string
        documentId: string | null
    }
    | { status: 'unresolved'; reason: RelatedOrgReason; message: string }

export type RelatedOrgContact =
    | { status: 'resolved'; address: string; organization: RelatedOrganization; relationship: string; orderId: string; documentId: string | null }
    | { status: 'unresolved'; reason: RelatedOrgReason; message: string; organization?: RelatedOrganization }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A reference the producer put in the payload (order_id, document_id,
 * warehouse_org_id). orders.id, documents.id and organizations.id are uuid
 * columns and every producer sends those ids, so anything else is a malformed
 * reference: it is reported as such (never silently ignored, never sent to the
 * database as a filter that would fail and read as "not found"), and the
 * notification does not fall back to a different lookup.
 */
type Reference = { kind: 'absent' } | { kind: 'valid'; id: string } | { kind: 'malformed'; value: string }
export function referenceOf(value: unknown): Reference {
    if (value === undefined || value === null) return { kind: 'absent' }
    const text = String(value).trim()
    if (!text) return { kind: 'absent' }
    return UUID.test(text) ? { kind: 'valid', id: text.toLowerCase() } : { kind: 'malformed', value: text.slice(0, 64) }
}
const malformed = (field: string, ref: { value: string }): RelatedOrgResolution =>
    unresolved('invalid_reference', `The notification's ${field} "${ref.value}" is not a valid record id, so the related organization was not chosen.`)
const lookupFailed = (what: string, error: { message?: string }): RelatedOrgResolution =>
    unresolved('lookup_failed', `Could not read the ${what} (${error.message || 'database error'}); the related organization was not chosen.`)

const unresolved = (reason: RelatedOrgReason, message: string): RelatedOrgResolution => ({ status: 'unresolved', reason, message })

const ORDER_COLUMNS = 'id, order_type, company_id, buyer_org_id, seller_org_id, warehouse_org_id'
const ORG_COLUMNS = 'id, org_name, org_type_code, contact_phone, contact_email, is_active'

function involvesOrg(order: any, orgId: string | null | undefined): boolean {
    if (!orgId) return false
    return [order.company_id, order.buyer_org_id, order.seller_org_id].includes(orgId)
}

/** Exactly-one lookup; two hits mean the reference is not stable enough to act on. */
async function uniqueRows(query: any): Promise<{ rows: any[]; error?: string }> {
    const { data, error } = await query.limit(2)
    if (error) return { rows: [], error: error.message }
    return { rows: data || [] }
}

/** The order (and document) an event's payload belongs to, inside `orgId` only. */
async function findTransaction(supabase: any, orgId: string, eventCode: string, payload: Record<string, any>)
    : Promise<{ order: any; documentId: string | null } | RelatedOrgResolution> {
    const orderRef = referenceOf(payload.order_id)
    const documentRef = referenceOf(payload.document_id)
    if (orderRef.kind === 'malformed') return malformed('order_id', orderRef)
    if (documentRef.kind === 'malformed') return malformed('document_id', documentRef)
    let orderId: string | null = orderRef.kind === 'valid' ? orderRef.id : null
    let documentId: string | null = documentRef.kind === 'valid' ? documentRef.id : null

    if (DOCUMENT_EVENTS.has(eventCode) && !orderId) {
        let document: any = null
        if (documentId) {
            const { data, error } = await supabase.from('documents').select('id, order_id, company_id').eq('id', documentId).maybeSingle()
            if (error) return lookupFailed('document', error)
            document = data
            // A document of another company is not this notification's transaction.
            if (document && document.company_id && document.company_id !== orgId) {
                return unresolved('outside_organization', 'The document does not belong to the organization that owns this notification.')
            }
        } else if (payload.doc_no && payload.doc_type) {
            // Producers that predate document_id send doc_no + doc_type; doc_no is a
            // document number, not a name, and must match exactly one document.
            const { rows, error } = await uniqueRows(
                supabase.from('documents').select('id, order_id, company_id')
                    .eq('doc_no', String(payload.doc_no)).eq('doc_type', String(payload.doc_type)).eq('company_id', orgId),
            )
            if (error) return lookupFailed('document', { message: error })
            if (rows.length > 1) return unresolved('transaction_ambiguous', `More than one ${payload.doc_type} ${payload.doc_no} exists, so the related organization was not chosen.`)
            document = rows[0] || null
        }
        if (!document) return unresolved('transaction_not_found', 'The document behind this notification was not found.')
        documentId = document.id
        orderId = document.order_id
    }

    let order: any = null
    if (orderId) {
        const { data, error } = await supabase.from('orders').select(ORDER_COLUMNS).eq('id', orderId).maybeSingle()
        if (error) return lookupFailed('order', error)
        order = data
    } else {
        const orderNo = String(payload.order_no || '').trim()
        if (!orderNo) return unresolved('transaction_not_found', 'This notification does not identify an order.')
        for (const column of ['display_doc_no', 'order_no']) {
            const { rows, error } = await uniqueRows(supabase.from('orders').select(ORDER_COLUMNS).eq(column, orderNo))
            if (error) return lookupFailed('order', { message: error })
            const inOrg = rows.filter((row) => involvesOrg(row, orgId))
            if (inOrg.length > 1) return unresolved('transaction_ambiguous', `More than one order ${orderNo} exists, so the related organization was not chosen.`)
            if (inOrg.length === 1) { order = inOrg[0]; break }
        }
    }
    if (!order) return unresolved('transaction_not_found', 'The order behind this notification was not found.')
    if (!involvesOrg(order, orgId)) return unresolved('outside_organization', 'The order does not belong to the organization that owns this notification.')
    return { order, documentId }
}

/**
 * The related organization for one event, or why there is none.
 * Reads current master data every time, so a new event uses updated contacts.
 */
export async function resolveRelatedOrganization(supabase: any, input: {
    orgId: string
    eventCode: string
    dynamicTarget: unknown
    payload: Record<string, any>
}): Promise<RelatedOrgResolution> {
    const { orgId, eventCode, payload } = input
    const state = relatedOrgTargetState(input.dynamicTarget)
    if (state.kind === 'unset') {
        return unresolved('not_configured', 'Related organization is on but no organization is chosen. Choose "Linked to this transaction".')
    }
    if (state.kind === 'unknown') {
        return unresolved('legacy_target_ambiguous', `Saved organization choice "${state.value}" is not supported. Choose "Linked to this transaction".`)
    }
    if (!RELATED_ORG_EVENTS.has(eventCode)) {
        return unresolved('unsupported_event', 'This notification has no transaction, so Related organization adds nobody.')
    }

    const found = await findTransaction(supabase, orgId, eventCode, payload)
    if ('status' in found) return found
    const { order, documentId } = found
    const orderType = String(order.order_type || '')

    // Which organization ID, from the transaction itself.
    let targetId: string | null = null
    let relationship: Party | 'warehouse' = 'seller'
    let expectedTypes: string[] | null = null
    let candidates: any[] | null = null

    if (state.kind === 'auto') {
        const mapping = COUNTERPARTY_BY_ORDER_TYPE[orderType]
        if (!mapping) return unresolved('unsupported_transaction_type', `Order type ${orderType || 'unknown'} has no related distributor or manufacturer.`)
        relationship = mapping.party
        targetId = mapping.party === 'buyer' ? order.buyer_org_id : order.seller_org_id
        expectedTypes = mapping.orgTypes
    } else if (state.target === 'warehouse') {
        relationship = 'warehouse'
        const warehouseRef = referenceOf(payload.warehouse_org_id)
        if (warehouseRef.kind === 'malformed') return malformed('warehouse_org_id', warehouseRef)
        // The payload's warehouse is used only if it is the order's own warehouse (or the order has none recorded).
        if (warehouseRef.kind === 'valid' && order.warehouse_org_id && warehouseRef.id !== String(order.warehouse_org_id).toLowerCase()) {
            return unresolved('transaction_ambiguous', 'The notification names a different warehouse from the order, so neither was chosen.')
        }
        targetId = (warehouseRef.kind === 'valid' ? warehouseRef.id : null) || order.warehouse_org_id || null
        if (!targetId) return unresolved('organization_not_found', 'This order has no warehouse.')
    } else {
        // Legacy explicit choice: the party of that type on this order (never "all of that type").
        const { data, error } = await supabase.from('organizations').select(ORG_COLUMNS).in('id', [order.buyer_org_id, order.seller_org_id].filter(Boolean))
        if (error) return lookupFailed('organization', error)
        const types = state.target === 'manufacturer' ? MANUFACTURER_TYPES : DISTRIBUTOR_TYPES
        const parties: any[] = (data || []).filter((org: any) => types.includes(String(org.org_type_code)))
        if (parties.length === 0) return unresolved('unexpected_organization_type', `This order has no ${state.target} party.`)
        if (parties.length > 1) return unresolved('transaction_ambiguous', `Both parties of this order are ${state.target}s, so neither was chosen.`)
        candidates = parties
        targetId = parties[0].id
        relationship = targetId === order.buyer_org_id ? 'buyer' : 'seller'
    }

    let org = candidates?.find((row) => row.id === targetId) || null
    if (!org) {
        const { data, error } = await supabase.from('organizations').select(ORG_COLUMNS).eq('id', targetId).maybeSingle()
        if (error) return lookupFailed('organization', error)
        org = data
    }
    if (!org) return unresolved('organization_not_found', 'The related organization was not found.')
    if (expectedTypes && !expectedTypes.includes(String(org.org_type_code))) {
        return unresolved('unexpected_organization_type', `${org.org_name} is not a ${expectedTypes.includes('DIST') ? 'distributor' : 'manufacturer'}, so it was not notified.`)
    }
    if (org.is_active === false) return unresolved('organization_inactive', `${org.org_name} is inactive, so it was not notified.`)

    return {
        status: 'resolved',
        organization: {
            id: org.id,
            name: org.org_name,
            typeCode: org.org_type_code,
            phone: String(org.contact_phone || '').trim() || null,
            email: String(org.contact_email || '').trim() || null,
        },
        relationship,
        orderId: order.id,
        orderType,
        documentId,
    }
}

/** The organization's master-data contact for one channel: phone for SMS/WhatsApp, email for Email. */
export function relatedOrgContactForChannel(resolution: RelatedOrgResolution, channel: string): RelatedOrgContact {
    if (resolution.status !== 'resolved') return resolution
    const { organization, relationship, orderId, documentId } = resolution
    if (channel === 'email') {
        if (!organization.email) return { status: 'unresolved', reason: 'missing_email', organization, message: `${organization.name} has no contact email in organization master data.` }
        if (!EMAIL.test(organization.email)) return { status: 'unresolved', reason: 'invalid_email', organization, message: `${organization.name}'s contact email "${organization.email}" is not valid.` }
        return { status: 'resolved', address: organization.email.toLowerCase(), organization, relationship, orderId, documentId }
    }
    if (!organization.phone) return { status: 'unresolved', reason: 'missing_phone', organization, message: `${organization.name} has no contact phone in organization master data.` }
    const parsed = toSmsE164(organization.phone)
    if (!('e164' in parsed)) return { status: 'unresolved', reason: 'invalid_phone', organization, message: `${organization.name}'s contact phone "${organization.phone}" is not a valid number.` }
    return { status: 'resolved', address: parsed.e164, organization, relationship, orderId, documentId }
}

/** One call for one channel; used by collectConfiguredRecipients. */
export async function resolveRelatedOrgContact(supabase: any, input: {
    orgId: string
    eventCode: string
    channel: string
    dynamicTarget: unknown
    payload: Record<string, any>
}): Promise<RelatedOrgContact> {
    try {
        const resolution = await resolveRelatedOrganization(supabase, input)
        return relatedOrgContactForChannel(resolution, input.channel)
    } catch (error: any) {
        return { status: 'unresolved', reason: 'lookup_failed', message: `Related organization lookup failed: ${error?.message || 'unknown error'}` }
    }
}
