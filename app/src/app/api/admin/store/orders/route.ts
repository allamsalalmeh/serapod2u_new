import { userAllowed } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { OWN_DELIVERY_LABEL } from '@/lib/storefront/delivery'
import { recordOrderEvent, staffActorLabel } from '@/lib/storefront/order-events'
import { getGatewayByProvider } from '@/lib/payments'
import { refundStripeCheckout } from '@/lib/payments/stripe-refund'
import { returnOrderStock, stockMoveNote, takeOrderStock, undoOrderStock } from '@/lib/storefront/order-stock'
import { notifyOutdoorOrderStatus, outdoorOrderEmailFor } from '@/lib/outdoor/order-status-email'
import { notifyStoreOrderShipped, storeShippingEmailFor } from '@/lib/storefront/order-shipped-email'

// ── Helpers ─────────────────────────────────────────────────────────

async function getAuthenticatedAdmin(supabase: any) {
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) return null

    const adminClient = createAdminClient()
    const { data: profile } = await adminClient
        .from('users')
        .select('id, organization_id, role_code, organizations!fk_users_organization(id, org_type_code), roles(role_level)')
        .eq('id', user.id)
        .single()

    if (!profile) return null
    const orgType = (profile.organizations as any)?.org_type_code
    const roleLevel = (profile.roles as any)?.role_level
    // HQ users with role level ≤ 30 (Admin/Manager)
    // S&A decides for the admin's organization; the HQ level<=30 rule is the legacy evaluator.
    if (!(await userAllowed(user.id, 'ecommerce.order.manage', () => orgType === 'HQ' && roleLevel != null && roleLevel <= 30 && !!profile.organization_id, { organizationId: profile.organization_id }))) return null

    return { userId: user.id, orgId: profile.organization_id as string }
}

// Storefront orders an HQ admin may see or change: their own organization's
// orders plus legacy orders created before organization_id existed (NULL),
// which belong to the single platform storefront. Applied to every read AND
// write so an order id alone can never bypass tenant filtering.
const orgScopeFilter = (orgId: string) => `organization_id.eq.${orgId},organization_id.is.null`

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MONEY_TAKEN_STATUSES = ['paid', 'processing', 'shipped', 'delivered']

function needsRefund(fromStatus: string, toStatus: string) {
    return (toStatus === 'refunded' || toStatus === 'cancelled') && MONEY_TAKEN_STATUSES.includes(fromStatus)
}

function isStripeCheckout(order: { payment_provider?: string | null; payment_ref?: string | null }) {
    return order.payment_provider === 'stripe' && String(order.payment_ref || '').startsWith('cs_')
}

function formatAmount(amount: unknown, currency: unknown) {
    const code = String(currency || 'MYR').toUpperCase()
    try {
        return new Intl.NumberFormat('en-MY', { style: 'currency', currency: code }).format(Number(amount) || 0)
    } catch {
        return `${code} ${(Number(amount) || 0).toFixed(2)}`
    }
}

// PostgREST or() filters are comma/parenthesis delimited; keep search text literal.
const sanitizeSearch = (value: string) => value.replace(/[,()\\*%]/g, ' ').trim().slice(0, 100)

// ── GET /api/admin/store/orders ─────────────────────────────────────
// List storefront orders for the admin's organization

export async function GET(request: NextRequest) {
    try {
        const supabase = await createClient()
        const admin = await getAuthenticatedAdmin(supabase)
        if (!admin) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { searchParams } = new URL(request.url)
        const status = searchParams.get('status')
        const search = searchParams.get('search')
        const salesChannel = searchParams.get('salesChannel')
        const page = parseInt(searchParams.get('page') || '1', 10)
        const limit = parseInt(searchParams.get('limit') || '25', 10)
        const offset = (page - 1) * limit

        const adminClient: any = createAdminClient()

        // History of one order, only when that order is inside the admin's scope.
        const eventsFor = searchParams.get('eventsFor')
        if (eventsFor) {
            if (!UUID_PATTERN.test(eventsFor)) {
                return NextResponse.json({ error: 'Order not found' }, { status: 404 })
            }
            const { data: scoped } = await adminClient
                .from('storefront_orders')
                .select('id')
                .eq('id', eventsFor)
                .or(orgScopeFilter(admin.orgId))
                .maybeSingle()
            if (!scoped) {
                return NextResponse.json({ error: 'Order not found' }, { status: 404 })
            }
            const { data: events, error: eventsError } = await adminClient
                .from('storefront_order_events')
                .select('id, event_type, from_status, to_status, actor_type, actor_label, note, created_at')
                .eq('order_id', eventsFor)
                .order('created_at', { ascending: true })
                .limit(200)
            if (eventsError) {
                console.warn('[admin/store/orders] history unavailable:', eventsError.message)
                return NextResponse.json({ events: [], historyAvailable: false })
            }
            return NextResponse.json({ events: events ?? [], historyAvailable: true })
        }

        // Build query
        let query = adminClient
            .from('storefront_orders')
            .select('*, storefront_order_items(*)', { count: 'exact' })

        // Tenant scope (same filter as PUT)
        query = query.or(orgScopeFilter(admin.orgId))

        if (salesChannel === 'outdoor' || salesChannel === 'store') {
            query = query.eq('sales_channel', salesChannel)
        }

        // Status filter
        if (status && status !== 'all') {
            query = query.eq('status', status)
        }

        // Search by order ref, customer name, or email
        const safeSearch = search ? sanitizeSearch(search) : ''
        if (safeSearch) {
            query = query.or(
                `order_ref.ilike.%${safeSearch}%,customer_name.ilike.%${safeSearch}%,customer_email.ilike.%${safeSearch}%,shipping_tracking_no.ilike.%${safeSearch}%`
            )
        }

        // Pagination & ordering
        query = query
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1)

        const { data, error, count } = await query

        if (error) {
            console.error('[admin/store/orders] GET error:', error)
            throw error
        }

        return NextResponse.json({
            orders: data ?? [],
            total: count ?? 0,
            page,
            limit,
            totalPages: Math.ceil((count ?? 0) / limit),
        })
    } catch (err) {
        console.error('[admin/store/orders] GET error:', err)
        return NextResponse.json({ error: 'Failed to fetch orders' }, { status: 500 })
    }
}

// ── PUT /api/admin/store/orders ─────────────────────────────────────
// Update order status

export async function PUT(request: NextRequest) {
    try {
        const supabase = await createClient()
        const admin = await getAuthenticatedAdmin(supabase)
        if (!admin) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const body = await request.json()
        const { id, status, notes } = body

        if (!id || !status) {
            return NextResponse.json({ error: 'Missing order id or status' }, { status: 400 })
        }

        if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 })
        }

        // Validate status transition
        const validStatuses = [
            'pending_payment', 'paid', 'payment_failed',
            'processing', 'shipped', 'delivered', 'cancelled', 'refunded',
        ]
        if (!validStatuses.includes(status)) {
            return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
        }

        const adminClient: any = createAdminClient()

        const ownDelivery = body.deliveryMethod === 'own'
        const trackingNo = ownDelivery ? '' : String(body.trackingNo ?? '').trim().slice(0, 60)
        const courierName = ownDelivery ? OWN_DELIVERY_LABEL : String(body.courierName ?? '').trim().slice(0, 120)

        const { data: current } = await adminClient
            .from('storefront_orders')
            .select('id, order_ref, status, sales_channel, shipping_tracking_no, shipping_courier_name, payment_provider, payment_ref, total_amount, currency')
            .eq('id', id)
            .or(orgScopeFilter(admin.orgId))
            .maybeSingle()
        if (!current) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 })
        }

        // Refunding or cancelling an order the customer already paid for returns the money
        // first; the status only changes once the refund went through.
        let refundNote: string | null = null
        if (needsRefund(current.status, status)) {
            if (isStripeCheckout(current)) {
                const gateway = await getGatewayByProvider('stripe')
                const refund = await refundStripeCheckout({
                    sessionId: String(current.payment_ref),
                    secretKey: String((gateway?.credentials as Record<string, string> | undefined)?.secret_key || ''),
                    orderId: id,
                    orderRef: String(current.order_ref || id),
                })
                if (!refund.ok) {
                    return NextResponse.json(
                        { error: `Stripe did not return the money (${refund.error}). The order was not changed.` },
                        { status: 502 },
                    )
                }
                refundNote = refund.alreadyRefunded
                    ? 'Payment was already refunded on Stripe'
                    : `Refunded ${formatAmount(refund.amountCents != null ? refund.amountCents / 100 : current.total_amount, current.currency)} to the customer on Stripe${refund.refundId ? ` (${refund.refundId})` : ''}`
            } else if (body.refundedOutside === true) {
                refundNote = `Money returned outside the dashboard${current.payment_provider ? ` via ${current.payment_provider}` : ''} (confirmed by staff)`
            } else {
                return NextResponse.json(
                    {
                        error: `This order was paid with ${current.payment_provider || 'another method'}, so the money can't be returned from here. Refund it there first, then confirm.`,
                        needsManualRefund: true,
                    },
                    { status: 409 },
                )
            }
        }

        // An Outdoor order only counts as shipped once we know how it left: our own
        // team, or a courier with a tracking number (same rule as the Outdoor staff desk).
        if (status === 'shipped' && current.sales_channel === 'outdoor' && !ownDelivery) {
            const hasTracking = Boolean(trackingNo || String(current.shipping_tracking_no || '').trim())
            const hasCourier = Boolean(courierName || String(current.shipping_courier_name || '').trim())
            if (!hasTracking || !hasCourier) {
                return NextResponse.json(
                    { error: 'Choose our own delivery, or add the courier and tracking number, before marking this order shipped.' },
                    { status: 400 },
                )
            }
        }

        // Stock leaves the warehouse when a paid order ships; nothing changes if it can't.
        let stockNote: string | null = null
        const shipsNow = ['shipped', 'delivered'].includes(status) && ['paid', 'processing'].includes(current.status)
        if (shipsNow) {
            const taken = await takeOrderStock(adminClient, id, admin.userId)
            if (!taken.ok) {
                return NextResponse.json({ error: `${taken.error} The order was not changed.` }, { status: 409 })
            }
            stockNote = stockMoveNote(taken, 'out')
        }

        const updateData: Record<string, any> = { status }
        if (notes !== undefined) updateData.admin_notes = notes
        if (status === 'shipped' && ownDelivery) {
            updateData.shipping_courier_name = OWN_DELIVERY_LABEL
            updateData.shipping_tracking_no = null
        } else {
            if (status === 'shipped' && trackingNo) updateData.shipping_tracking_no = trackingNo
            if (status === 'shipped' && courierName) updateData.shipping_courier_name = courierName
        }

        // The tenant scope is part of the UPDATE itself, so an order outside the
        // admin's scope is indistinguishable from a non-existent one.
        const { data, error } = await adminClient
            .from('storefront_orders')
            .update(updateData)
            .eq('id', id)
            .or(orgScopeFilter(admin.orgId))
            .select('*')
            .maybeSingle()

        if ((error || !data) && stockNote) {
            await undoOrderStock(adminClient, id, admin.userId)
        }

        if (error) {
            console.error('[admin/store/orders] PUT error:', error, refundNote ? `— after: ${refundNote}` : '')
            if (refundNote) {
                return NextResponse.json(
                    { error: `${refundNote}, but the order status could not be saved. Try again — the customer will not be refunded twice.` },
                    { status: 500 },
                )
            }
            throw error
        }

        if (!data) {
            return NextResponse.json({ error: 'Order not found' }, { status: 404 })
        }

        // Goods only go back on the shelf when staff confirm they came back.
        let stockWarning: string | null = null
        if (refundNote && body.restock === true) {
            const returned = await returnOrderStock(adminClient, id, admin.userId)
            if (returned.ok) {
                stockNote = stockMoveNote(returned, 'back')
            } else {
                stockWarning = `The refund went through, but the stock was not put back: ${returned.error}`
            }
        }

        const shippingNote = status !== 'shipped'
            ? null
            : ownDelivery
                ? 'Out for delivery with our own team'
                : trackingNo
                    ? `Sent by ${courierName || 'courier'} · tracking ${trackingNo}`
                    : null
        await recordOrderEvent(adminClient, {
            orderId: id,
            eventType: 'status_changed',
            fromStatus: current.status,
            toStatus: status,
            actorType: 'staff',
            actorId: admin.userId,
            actorLabel: await staffActorLabel(adminClient, admin.userId),
            note: [shippingNote, refundNote, stockNote, stockWarning, 'Changed in dashboard'].filter(Boolean).join(' — '),
        })

        const moneyReturned = Boolean(refundNote)
        await notifyOutdoorOrderStatus(
            id,
            outdoorOrderEmailFor({
                salesChannel: current.sales_channel,
                fromStatus: current.status,
                toStatus: status,
                fromTracking: current.shipping_tracking_no,
                toTracking: data.shipping_tracking_no,
                moneyReturned,
            }),
            { moneyReturned },
        )
        await notifyStoreOrderShipped(
            id,
            storeShippingEmailFor({
                salesChannel: current.sales_channel,
                fromStatus: current.status,
                toStatus: status,
                fromTracking: current.shipping_tracking_no,
                toTracking: data.shipping_tracking_no,
            }),
        )

        return NextResponse.json(stockWarning ? { order: data, warning: stockWarning } : { order: data })
    } catch (err) {
        console.error('[admin/store/orders] PUT error:', err)
        return NextResponse.json({ error: 'Failed to update order' }, { status: 500 })
    }
}
