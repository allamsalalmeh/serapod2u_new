import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildOrderEventPayload, initialOutboxAddress } from '@/lib/notifications/supplyChainEventQueue'
import { PREVIEWABLE_EVENTS, RESOLVABLE_ORDER_EVENTS, previewNotificationRecipients, sourcesNotUsedWhenSending, type RecipientDiagnostic, type ResolvableOrderEvent } from '@/lib/notifications/configuredRecipients'
import { ensureOrderOwnerContact } from '@/lib/notifications/orderOwnerContact'

/**
 * GET /api/notifications/resolve
 *
 * Who would receive this notification for one real record, on one channel,
 * using the draft recipient config from the Configure drawer. Recipients are
 * resolved by the same rules the outbox worker uses; nothing is invented.
 *
 * Query: eventCode, sampleId (order number or id; a document number for
 *        document events), channel, recipientConfig (JSON)
 *
 * The sample payload has the same shape the event's producer sends, so the
 * preview and the worker resolve the same people (including Related organization).
 *
 * Response `status`:
 *   resolved     recipients found
 *   empty        the record exists but no recipient resolves
 *   not_found    no such record in the caller's organization
 *   unsupported  this notification type has no sample-record lookup
 *   error        the lookup failed (HTTP 4xx/5xx)
 */

const CHANNELS = ['whatsapp', 'sms', 'email']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The document type behind each document event. */
const DOC_TYPE_BY_EVENT: Record<string, 'PO' | 'INVOICE' | 'PAYMENT' | 'RECEIPT'> = {
    po_created: 'PO', po_acknowledged: 'PO',
    invoice_created: 'INVOICE', invoice_acknowledged: 'INVOICE',
    payment_received: 'PAYMENT', balance_payment_received: 'PAYMENT', balance_request_created: 'PAYMENT',
    receipt_issued: 'RECEIPT',
}

const fail = (status: number, error: string) => NextResponse.json({ success: false, status: 'error', error }, { status })

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams
    const eventCode = searchParams.get('eventCode') || ''
    const sampleId = (searchParams.get('sampleId') || '').trim()
    const channel = searchParams.get('channel') || 'whatsapp'
    const recipientConfigStr = searchParams.get('recipientConfig')

    if (!eventCode) return fail(400, 'Missing eventCode')
    if (!CHANNELS.includes(channel)) return fail(400, 'Unknown channel')

    const supabase = await createClient()
    const { data: { user: saUser } } = await supabase.auth.getUser()
    if (!saUser) return fail(401, 'Unauthorized')
    const saDenied = await guardUserOperation(saUser.id, 'platform.settings.manage')
    if (saDenied) return saDenied

    if (!PREVIEWABLE_EVENTS.includes(eventCode)) {
        return NextResponse.json({
            success: true,
            status: 'unsupported',
            recipients: [],
            message: 'Recipient lookup from a sample record is available for Supply Chain order, production, receiving and document notifications only.',
        })
    }
    if (!sampleId) return fail(400, 'Enter an order number')

    let recipientConfig: Record<string, any> = {}
    if (recipientConfigStr) {
        try { recipientConfig = JSON.parse(recipientConfigStr) || {} } catch { return fail(400, 'Invalid recipient configuration') }
    }

    try {
        const { data: profile } = await supabase.from('users').select('organization_id').eq('id', saUser.id).single()
        const orgId = profile?.organization_id
        if (!orgId) return fail(404, 'Organization not found')

        // Exact matches only — never interpolate user input into a filter string.
        const orderColumns = 'id, company_id, buyer_org_id, seller_org_id, order_no, display_doc_no, warehouse_org_id'
        const lookups = UUID.test(sampleId) ? ['id'] : ['display_doc_no', 'order_no']
        const docType = DOC_TYPE_BY_EVENT[eventCode]
        let order: any = null
        let document: any = null
        if (docType && !UUID.test(sampleId)) {
            // A document number (PO-…, INV-…) identifies one document and its order.
            const { data, error } = await supabase.from('documents').select('id, order_id, doc_no, doc_type').eq('doc_no', sampleId).eq('doc_type', docType).limit(1).maybeSingle()
            if (error) throw new Error(error.message)
            if (data) {
                document = data
                const { data: parent, error: parentError } = await supabase.from('orders').select(orderColumns).eq('id', data.order_id).limit(1).maybeSingle()
                if (parentError) throw new Error(parentError.message)
                order = parent
            }
        }
        for (const column of order ? [] : lookups) {
            const { data, error } = await supabase.from('orders').select(orderColumns).eq(column, sampleId).limit(1).maybeSingle()
            if (error) throw new Error(error.message)
            if (data) { order = data; break }
        }
        const inOrg = order && [order.company_id, order.buyer_org_id, order.seller_org_id].includes(orgId)
        if (!order || !inOrg) {
            return NextResponse.json({ success: true, status: 'not_found', recipients: [], message: `No order ${sampleId} found in your organization.` })
        }

        let payload: Record<string, any>
        if ((RESOLVABLE_ORDER_EVENTS as readonly string[]).includes(eventCode)) {
            payload = (await buildOrderEventPayload(supabase, { orderId: order.id, eventCode: eventCode as ResolvableOrderEvent })).payload
        } else if (docType) {
            if (!document) {
                const { data: docs, error } = await supabase.from('documents').select('id, order_id, doc_no, doc_type').eq('order_id', order.id).eq('doc_type', docType).limit(2)
                if (error) throw new Error(error.message)
                if (!docs?.length) return NextResponse.json({ success: true, status: 'not_found', recipients: [], message: `Order ${sampleId} has no ${docType} document yet.` })
                if (docs.length > 1) return NextResponse.json({ success: true, status: 'not_found', recipients: [], message: `Order ${sampleId} has more than one ${docType} document. Enter the document number instead.` })
                document = docs[0]
            }
            // Same shape as the document trigger's payload.
            payload = { doc_type: document.doc_type, doc_no: document.doc_no, document_id: document.id, order_id: order.id, order_no: order.order_no }
            await ensureOrderOwnerContact(supabase, payload)
        } else {
            // QR batch, production and receiving producers send the order and its number.
            payload = { order_id: order.id, order_no: order.display_doc_no || order.order_no, warehouse_org_id: order.warehouse_org_id || null }
            await ensureOrderOwnerContact(supabase, payload)
        }
        const diagnostics: RecipientDiagnostic[] = []
        const recipients = await previewNotificationRecipients(supabase, {
            orgId,
            eventCode,
            channel,
            recipientConfig,
            payload,
            diagnostics,
            eventAddress: initialOutboxAddress(eventCode, channel, payload, recipientConfig),
        })

        return NextResponse.json({
            success: true,
            status: recipients.length ? 'resolved' : 'empty',
            channel,
            recipients,
            diagnostics,
            notUsedWhenSending: sourcesNotUsedWhenSending(recipientConfig),
        })
    } catch (error: any) {
        console.error('Resolve error:', error)
        return fail(500, error?.message || 'Recipient lookup failed')
    }
}
