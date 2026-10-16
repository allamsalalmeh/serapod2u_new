import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildOrderEventPayload, initialOutboxAddress } from '@/lib/notifications/supplyChainEventQueue'
import { RESOLVABLE_ORDER_EVENTS, previewNotificationRecipients, sourcesNotUsedWhenSending, type ResolvableOrderEvent } from '@/lib/notifications/configuredRecipients'

/**
 * GET /api/notifications/resolve
 *
 * Who would receive this notification for one real record, on one channel,
 * using the draft recipient config from the Configure drawer. Recipients are
 * resolved by the same rules the outbox worker uses; nothing is invented.
 *
 * Query: eventCode, sampleId (order number or id), channel, recipientConfig (JSON)
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

    if (!(RESOLVABLE_ORDER_EVENTS as readonly string[]).includes(eventCode)) {
        return NextResponse.json({
            success: true,
            status: 'unsupported',
            recipients: [],
            message: 'Recipient lookup from a sample record is available for Order Submitted, Approved, Rejected and Closed only.',
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
        const orderColumns = 'id, company_id, buyer_org_id, seller_org_id'
        const lookups = UUID.test(sampleId) ? ['id'] : ['display_doc_no', 'order_no']
        let order: any = null
        for (const column of lookups) {
            const { data, error } = await supabase.from('orders').select(orderColumns).eq(column, sampleId).limit(1).maybeSingle()
            if (error) throw new Error(error.message)
            if (data) { order = data; break }
        }
        const inOrg = order && [order.company_id, order.buyer_org_id, order.seller_org_id].includes(orgId)
        if (!order || !inOrg) {
            return NextResponse.json({ success: true, status: 'not_found', recipients: [], message: `No order ${sampleId} found in your organization.` })
        }

        const { payload } = await buildOrderEventPayload(supabase, { orderId: order.id, eventCode: eventCode as ResolvableOrderEvent })
        const recipients = await previewNotificationRecipients(supabase, {
            orgId,
            eventCode,
            channel,
            recipientConfig,
            payload,
            eventAddress: initialOutboxAddress(eventCode, channel, payload, recipientConfig),
        })

        return NextResponse.json({
            success: true,
            status: recipients.length ? 'resolved' : 'empty',
            channel,
            recipients,
            notUsedWhenSending: sourcesNotUsedWhenSending(recipientConfig),
        })
    } catch (error: any) {
        console.error('Resolve error:', error)
        return fail(500, error?.message || 'Recipient lookup failed')
    }
}
