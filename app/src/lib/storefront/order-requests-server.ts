import { sendTransactionalHtmlEmail } from '@/lib/email/transactional-html-email'
import { resolveOrgForEmail } from '@/server/auth/passwordResetService'
import { storeOrigin } from '@/lib/storefront/order-paid-email'
import { withStorageApiKey } from '@/lib/utils'
import {
  ORDER_REQUEST_CUSTOMER_LABELS,
  ORDER_REQUEST_MAX_PHOTO_BYTES,
  ORDER_REQUEST_MAX_REPLY,
  ORDER_REQUEST_PHOTO_TYPES,
  ORDER_REQUEST_TYPE_LABELS,
  OPEN_ORDER_REQUEST_STATUSES,
  canMoveOrderRequest,
  canRaiseOrderRequest,
  isOrderRequestStatus,
  validateOrderRequestInput,
  type OrderRequestStatus,
  type OrderRequestType,
  type OrderRequestView,
} from '@/lib/storefront/order-requests'

const BUCKET = 'storefront-requests'
const OUTDOOR_INBOX = 'outdoor@serapod.com'
const OUTDOOR_FROM = { fromName: 'SeraOutdoor', fromEmail: 'outdoor@serapod.com' }
const REQUESTS_PER_DAY = 10

const BASE_SELECT =
  'id, request_no, order_id, sales_channel, customer_email, customer_name, request_type, status, message, staff_reply, photo_paths, created_at, updated_at'

export type OrderRequestResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: number; error: string; available?: boolean }

export function isMissingRequestsTable(error: any) {
  const text = `${error?.message || ''} ${error?.details || ''}`
  return error?.code === '42P01' || error?.code === 'PGRST205' || /storefront_order_requests/i.test(text)
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]!))
}

function exactEmailPattern(email: string) {
  return email.trim().toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)
}

function newRequestNo() {
  return `RQ-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

function fileExtension(type: string) {
  if (type === 'image/png') return 'png'
  if (type === 'image/webp') return 'webp'
  return 'jpg'
}

async function signedPhotoMap(admin: any, rows: any[]) {
  const paths = [...new Set(rows.flatMap((row) => (Array.isArray(row.photo_paths) ? row.photo_paths : [])))]
  const map = new Map<string, string>()
  if (paths.length === 0) return map
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrls(paths, 60 * 60)
  if (error) {
    console.error('[order-requests] sign photos', error)
    return map
  }
  for (const item of data || []) {
    if (item?.path && item?.signedUrl) map.set(item.path, withStorageApiKey(item.signedUrl))
  }
  return map
}

function toView(row: any, photos: Map<string, string>): OrderRequestView {
  const order = Array.isArray(row.storefront_orders) ? row.storefront_orders[0] : row.storefront_orders
  return {
    id: row.id,
    requestNo: row.request_no,
    orderId: row.order_id,
    orderRef: order?.order_ref || '',
    orderStatus: order?.status || '',
    salesChannel: row.sales_channel || 'store',
    customerEmail: row.customer_email,
    customerName: row.customer_name || null,
    type: row.request_type as OrderRequestType,
    status: row.status as OrderRequestStatus,
    message: row.message,
    staffReply: row.staff_reply || null,
    photos: (Array.isArray(row.photo_paths) ? row.photo_paths : [])
      .map((path: string) => photos.get(path))
      .filter(Boolean) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listOrderRequests(
  admin: any,
  filters: {
    email?: string
    salesChannel?: 'outdoor' | 'store'
    orgId?: string | null
    orderIds?: string[]
    openOnly?: boolean
    limit?: number
    withOrder?: boolean
  },
): Promise<OrderRequestResult<{ requests: Array<OrderRequestView & { order?: any }> }>> {
  const orderSelect = filters.withOrder
    ? 'storefront_orders(*, storefront_order_items(*))'
    : 'storefront_orders(order_ref, status)'
  let query = admin
    .from('storefront_order_requests')
    .select(`${BASE_SELECT}, ${orderSelect}`)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(filters.limit ?? 50, 1), 200))

  if (filters.email) query = query.ilike('customer_email', exactEmailPattern(filters.email))
  if (filters.salesChannel) query = query.eq('sales_channel', filters.salesChannel)
  if (filters.orgId) query = query.or(`organization_id.eq.${filters.orgId},organization_id.is.null`)
  if (filters.orderIds) {
    if (filters.orderIds.length === 0) return { ok: true, requests: [] }
    query = query.in('order_id', filters.orderIds.slice(0, 100))
  }
  if (filters.openOnly) query = query.in('status', OPEN_ORDER_REQUEST_STATUSES)

  const { data, error } = await query
  if (error) {
    if (isMissingRequestsTable(error)) return { ok: false, status: 503, error: 'Requests are not set up yet.', available: false }
    console.error('[order-requests] list', error)
    return { ok: false, status: 500, error: 'Could not load requests.' }
  }
  const rows = data || []
  const photos = await signedPhotoMap(admin, rows)
  return {
    ok: true,
    requests: rows.map((row: any) => {
      const view = toView(row, photos)
      if (!filters.withOrder) return view
      const order = Array.isArray(row.storefront_orders) ? row.storefront_orders[0] : row.storefront_orders
      return { ...view, order: order || null }
    }),
  }
}

export async function createOrderRequest(
  admin: any,
  input: { email: string; orderRef: string; type: unknown; message: unknown; files: File[]; origin: string },
): Promise<OrderRequestResult<{ request: OrderRequestView }>> {
  const invalid = validateOrderRequestInput({ type: input.type, message: input.message, photoCount: input.files.length })
  if (invalid) return { ok: false, status: 400, error: invalid }
  for (const file of input.files) {
    if (!ORDER_REQUEST_PHOTO_TYPES.includes(file.type)) return { ok: false, status: 400, error: 'Photos must be JPG, PNG, or WebP.' }
    if (file.size > ORDER_REQUEST_MAX_PHOTO_BYTES) return { ok: false, status: 400, error: 'Each photo must be under 5 MB.' }
  }
  const type = input.type as OrderRequestType
  const message = String(input.message).trim()
  const email = input.email.trim().toLowerCase()

  const { data: order, error: orderError } = await admin
    .from('storefront_orders')
    .select('id, order_ref, status, sales_channel, organization_id, customer_name, customer_email')
    .eq('order_ref', String(input.orderRef || '').trim())
    .ilike('customer_email', exactEmailPattern(email))
    .maybeSingle()
  if (orderError) {
    console.error('[order-requests] order lookup', orderError)
    return { ok: false, status: 500, error: 'Could not find that order.' }
  }
  if (!order) return { ok: false, status: 404, error: 'Order not found on this account.' }
  if (!canRaiseOrderRequest(order.status)) {
    return { ok: false, status: 400, error: 'Requests open once the order is paid.' }
  }

  const open = await admin
    .from('storefront_order_requests')
    .select('id, request_no')
    .eq('order_id', order.id)
    .in('status', OPEN_ORDER_REQUEST_STATUSES)
    .limit(1)
  if (open.error) {
    if (isMissingRequestsTable(open.error)) return { ok: false, status: 503, error: 'Requests are not set up yet.', available: false }
    console.error('[order-requests] open check', open.error)
    return { ok: false, status: 500, error: 'Could not send your request.' }
  }
  if ((open.data || []).length > 0) {
    return { ok: false, status: 409, error: `This order already has an open request (${open.data[0].request_no}).` }
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const recent = await admin
    .from('storefront_order_requests')
    .select('id', { count: 'exact', head: true })
    .ilike('customer_email', exactEmailPattern(email))
    .gte('created_at', since)
  if (!recent.error && (recent.count || 0) >= REQUESTS_PER_DAY) {
    return { ok: false, status: 429, error: 'Too many requests today. Try again tomorrow.' }
  }

  const requestNo = newRequestNo()
  const photoPaths: string[] = []
  for (const [index, file] of input.files.entries()) {
    const path = `${order.id}/${requestNo}/${index + 1}.${fileExtension(file.type)}`
    const upload = await admin.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false })
    if (upload.error) {
      console.error('[order-requests] photo upload', upload.error)
      if (photoPaths.length > 0) await admin.storage.from(BUCKET).remove(photoPaths)
      return { ok: false, status: 500, error: 'Could not upload your photos. Try again.' }
    }
    photoPaths.push(path)
  }

  const { data: row, error: insertError } = await admin
    .from('storefront_order_requests')
    .insert({
      request_no: requestNo,
      order_id: order.id,
      organization_id: order.organization_id || null,
      sales_channel: order.sales_channel || 'store',
      customer_email: order.customer_email || email,
      customer_name: order.customer_name || null,
      request_type: type,
      message,
      photo_paths: photoPaths,
      status: 'new',
    })
    .select(`${BASE_SELECT}, storefront_orders(order_ref, status)`)
    .single()
  if (insertError || !row) {
    if (photoPaths.length > 0) await admin.storage.from(BUCKET).remove(photoPaths)
    if (isMissingRequestsTable(insertError)) return { ok: false, status: 503, error: 'Requests are not set up yet.', available: false }
    console.error('[order-requests] insert', insertError)
    return { ok: false, status: 500, error: 'Could not send your request.' }
  }

  const request = toView(row, await signedPhotoMap(admin, [row]))
  await notifyNewRequest(admin, request, input.origin).catch((err) => console.error('[order-requests] notify new', err))
  return { ok: true, request }
}

export async function updateOrderRequest(
  admin: any,
  input: {
    id: string
    status?: unknown
    staffReply?: unknown
    actorId: string
    scope: { orgId?: string | null; salesChannel?: 'outdoor' | 'store' }
    origin: string
  },
): Promise<OrderRequestResult<{ request: OrderRequestView }>> {
  let lookup = admin
    .from('storefront_order_requests')
    .select(`${BASE_SELECT}, storefront_orders(order_ref, status)`)
    .eq('id', input.id)
  if (input.scope.salesChannel) lookup = lookup.eq('sales_channel', input.scope.salesChannel)
  if (input.scope.orgId) lookup = lookup.or(`organization_id.eq.${input.scope.orgId},organization_id.is.null`)
  const { data: current, error } = await lookup.maybeSingle()
  if (error) {
    if (isMissingRequestsTable(error)) return { ok: false, status: 503, error: 'Requests are not set up yet.', available: false }
    console.error('[order-requests] update lookup', error)
    return { ok: false, status: 500, error: 'Could not update the request.' }
  }
  if (!current) return { ok: false, status: 404, error: 'Request not found.' }

  const changes: Record<string, unknown> = { updated_at: new Date().toISOString(), handled_by: input.actorId }
  let statusChanged = false
  if (input.status !== undefined && input.status !== current.status) {
    if (!isOrderRequestStatus(input.status) || !canMoveOrderRequest(current.status, input.status)) {
      return { ok: false, status: 400, error: 'That status change is not allowed.' }
    }
    changes.status = input.status
    if (['rejected', 'refunded', 'closed'].includes(input.status)) changes.closed_at = changes.updated_at
    statusChanged = true
  }
  let replyChanged = false
  if (input.staffReply !== undefined) {
    const reply = String(input.staffReply || '').trim().slice(0, ORDER_REQUEST_MAX_REPLY)
    if (reply !== (current.staff_reply || '')) {
      changes.staff_reply = reply || null
      replyChanged = Boolean(reply)
    }
  }
  if (!statusChanged && changes.staff_reply === undefined) {
    return { ok: true, request: toView(current, await signedPhotoMap(admin, [current])) }
  }

  const { data: row, error: updateError } = await admin
    .from('storefront_order_requests')
    .update(changes)
    .eq('id', current.id)
    .select(`${BASE_SELECT}, storefront_orders(order_ref, status)`)
    .single()
  if (updateError || !row) {
    console.error('[order-requests] update', updateError)
    return { ok: false, status: 500, error: 'Could not update the request.' }
  }

  const request = toView(row, await signedPhotoMap(admin, [row]))
  if (statusChanged || replyChanged) {
    await notifyCustomerUpdate(admin, request, input.origin).catch((err) => console.error('[order-requests] notify update', err))
  }
  return { ok: true, request }
}

function emailShell(title: string, paragraphs: string[], cta?: { href: string; label: string }) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.55">${p}</p>`).join('')
  const button = cta
    ? `<p style="margin:22px 0 0"><a href="${escapeHtml(cta.href)}" style="display:inline-block;background:#3f1c1f;color:#f1e6b2;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(cta.label)}</a></p>`
    : ''
  return `<div style="font-family:Arial,sans-serif;color:#333f48;max-width:560px;margin:0 auto;padding:24px"><h2 style="margin:0 0 16px;color:#3f1c1f">${escapeHtml(title)}</h2>${body}${button}</div>`
}

async function send(admin: any, request: OrderRequestView, to: string, subject: string, text: string, html: string) {
  const orgId = await resolveOrgForEmail(admin)
  if (!orgId) return
  const from = request.salesChannel === 'outdoor' ? OUTDOOR_FROM : {}
  const sent = await sendTransactionalHtmlEmail(admin, orgId, { to, subject, text, html, ...from })
  if (!sent.success) console.error('[order-requests] email failed:', sent.error)
}

function accountLink(request: OrderRequestView, origin: string) {
  return request.salesChannel === 'outdoor' ? `${origin}/outdoor/account?tab=orders` : `${storeOrigin()}/store/orders`
}

async function notifyNewRequest(admin: any, request: OrderRequestView, origin: string) {
  const typeLabel = ORDER_REQUEST_TYPE_LABELS[request.type]
  const link = accountLink(request, origin)
  const greeting = request.customerName ? `Hi ${escapeHtml(request.customerName)},` : 'Hi,'
  await send(
    admin,
    request,
    request.customerEmail,
    `We received your request ${request.requestNo}`,
    [
      greeting,
      `We received your request ${request.requestNo} for order ${request.orderRef} (${typeLabel}).`,
      'Our team will review it and reply by email.',
      link ? `Follow it here: ${link}` : '',
    ].filter(Boolean).join('\n\n'),
    emailShell(
      'We received your request',
      [
        greeting,
        `Request <strong>${escapeHtml(request.requestNo)}</strong> for order <strong>${escapeHtml(request.orderRef)}</strong> · ${escapeHtml(typeLabel)}.`,
        'Our team will review it and reply by email.',
      ],
      link ? { href: link, label: 'View my orders' } : undefined,
    ),
  )

  if (request.salesChannel !== 'outdoor') return
  const deskLink = `${origin}/outdoor/fulfilment?tab=requests`
  await send(
    admin,
    request,
    OUTDOOR_INBOX,
    `New ${typeLabel.toLowerCase()} request ${request.requestNo} · ${request.orderRef}`,
    [
      `Order: ${request.orderRef}`,
      `Customer: ${request.customerName || ''} <${request.customerEmail}>`,
      `Type: ${typeLabel}`,
      `Photos: ${request.photos.length}`,
      '',
      request.message,
      '',
      `Open: ${deskLink}`,
    ].join('\n'),
    emailShell(
      `New request ${request.requestNo}`,
      [
        `<strong>Order:</strong> ${escapeHtml(request.orderRef)}<br><strong>Customer:</strong> ${escapeHtml(request.customerName || '')} &lt;${escapeHtml(request.customerEmail)}&gt;<br><strong>Type:</strong> ${escapeHtml(typeLabel)}<br><strong>Photos:</strong> ${request.photos.length}`,
        escapeHtml(request.message).replace(/\n/g, '<br>'),
      ],
      { href: deskLink, label: 'Open requests' },
    ),
  )
}

async function notifyCustomerUpdate(admin: any, request: OrderRequestView, origin: string) {
  const statusLabel = ORDER_REQUEST_CUSTOMER_LABELS[request.status]
  const link = accountLink(request, origin)
  const greeting = request.customerName ? `Hi ${escapeHtml(request.customerName)},` : 'Hi,'
  const paragraphs = [
    greeting,
    `Your request <strong>${escapeHtml(request.requestNo)}</strong> for order <strong>${escapeHtml(request.orderRef)}</strong> is now: <strong>${escapeHtml(statusLabel)}</strong>.`,
  ]
  if (request.staffReply) paragraphs.push(`Message from our team:<br>${escapeHtml(request.staffReply).replace(/\n/g, '<br>')}`)
  await send(
    admin,
    request,
    request.customerEmail,
    `Update on your request ${request.requestNo}: ${statusLabel}`,
    [
      greeting,
      `Your request ${request.requestNo} for order ${request.orderRef} is now: ${statusLabel}.`,
      request.staffReply ? `Message from our team:\n${request.staffReply}` : '',
      link ? `Follow it here: ${link}` : '',
    ].filter(Boolean).join('\n\n'),
    emailShell('Update on your request', paragraphs, link ? { href: link, label: 'View my orders' } : undefined),
  )
}
