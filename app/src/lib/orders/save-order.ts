/**
 * Shared contract for POST /api/orders/save (public.save_order_with_items).
 *
 * The database function is atomic, so any error it returns means NOTHING was
 * written ('not_saved'). Only a transport failure (no response from the
 * server) leaves the outcome 'unknown'.
 */

export type SaveOrderOutcome = 'saved' | 'not_saved' | 'unknown'

export type SaveOrderErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_request'
  | 'order_not_found'
  | 'order_not_editable'
  | 'order_changed'
  | 'order_busy'
  | 'timeout'
  | 'configuration'
  | 'save_failed'

export interface SaveOrderRequestItem {
  product_id: string
  variant_id: string
  qty: number
  unit_price: number
  units_per_case?: number | null
}

export interface SaveOrderRequest {
  mode: 'create' | 'update'
  orderId: string
  requestedStatus: 'draft' | 'submitted'
  expectedUpdatedAt?: string | null
  sellerOrgId: string
  unitsPerCase: number
  qrBufferPercent: number
  extraQrMaster: number
  hasRfid: boolean
  hasPoints: boolean
  hasLuckyDraw: boolean
  hasRedeem: boolean
  notes: string | null
  items: SaveOrderRequestItem[]
}

export interface SaveOrderSuccess {
  success: true
  outcome: 'saved'
  correlationId: string
  order: { id: string; orderNo: string; status: string; updatedAt: string; itemCount: number; replayed: boolean }
  notification: 'queued' | 'skipped' | 'failed'
}

export interface SaveOrderFailure {
  success: false
  outcome: SaveOrderOutcome
  code: SaveOrderErrorCode
  message: string
  correlationId: string
  stage?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Shape check only; business validation and authorization live in the database. */
export function parseSaveOrderRequest(body: unknown): SaveOrderRequest | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, any>
  if (b.mode !== 'create' && b.mode !== 'update') return null
  if (b.requestedStatus !== 'draft' && b.requestedStatus !== 'submitted') return null
  if (typeof b.orderId !== 'string' || !UUID_RE.test(b.orderId)) return null
  if (typeof b.sellerOrgId !== 'string' || !UUID_RE.test(b.sellerOrgId)) return null
  if (b.mode === 'update' && (typeof b.expectedUpdatedAt !== 'string' || !b.expectedUpdatedAt)) return null
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 200) return null
  const items: SaveOrderRequestItem[] = []
  for (const raw of b.items) {
    if (!raw || typeof raw !== 'object') return null
    const { product_id, variant_id, qty, unit_price, units_per_case } = raw as Record<string, any>
    if (typeof product_id !== 'string' || typeof variant_id !== 'string') return null
    if (!Number.isInteger(qty) || qty < 1) return null
    if (typeof unit_price !== 'number' || !Number.isFinite(unit_price) || unit_price < 0) return null
    if (units_per_case != null && (!Number.isInteger(units_per_case) || units_per_case < 1)) return null
    items.push({ product_id, variant_id, qty, unit_price, units_per_case: units_per_case ?? null })
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const unitsPerCase = num(b.unitsPerCase)
  const qrBufferPercent = num(b.qrBufferPercent)
  const extraQrMaster = num(b.extraQrMaster)
  if (unitsPerCase === null || qrBufferPercent === null || extraQrMaster === null) return null
  return {
    mode: b.mode,
    orderId: b.orderId,
    requestedStatus: b.requestedStatus,
    expectedUpdatedAt: b.mode === 'update' ? b.expectedUpdatedAt : null,
    sellerOrgId: b.sellerOrgId,
    unitsPerCase,
    qrBufferPercent,
    extraQrMaster,
    hasRfid: b.hasRfid === true,
    hasPoints: b.hasPoints !== false,
    hasLuckyDraw: b.hasLuckyDraw === true,
    hasRedeem: b.hasRedeem === true,
    notes: typeof b.notes === 'string' ? b.notes : null,
    items,
  }
}

export interface PostgrestLikeError {
  code?: string | null
  message?: string | null
  details?: string | null
}

export function stageFromError(error: PostgrestLikeError): string | undefined {
  const match = /stage=([a-z_]+)/.exec(error.details || '')
  return match?.[1]
}

/**
 * Maps a database error to a stable, content-free client error. A database
 * error always means the transaction rolled back (outcome 'not_saved').
 */
export function classifySaveOrderError(error: PostgrestLikeError): {
  status: number
  code: SaveOrderErrorCode
  message: string
} {
  const sqlstate = error.code || ''
  const message = error.message || ''
  switch (sqlstate) {
    case '40001':
      return { status: 409, code: 'order_changed', message: 'This order was changed by someone else while you were editing. Nothing was saved. Reload the order and re-apply your changes.' }
    case 'P0002':
      return { status: 404, code: 'order_not_found', message: 'This order could not be found.' }
    case '55000':
      if (message.startsWith('hq_default_warehouse_missing')) {
        return { status: 422, code: 'configuration', message: 'Your organization does not have a default warehouse configured. Nothing was saved.' }
      }
      return { status: 409, code: 'order_not_editable', message: 'This order can no longer be edited because its status has changed. Nothing was saved.' }
    case '42501':
      return { status: 403, code: 'forbidden', message: 'You are not allowed to save this order. Nothing was saved.' }
    case '28000':
      return { status: 401, code: 'unauthorized', message: 'Your session has expired. Sign in again; your form is unchanged.' }
    case '22023':
      return { status: 400, code: 'invalid_request', message: 'The order details are not valid. Nothing was saved.' }
    case '23505':
      return { status: 409, code: 'order_changed', message: 'A conflicting save was detected. Nothing was saved.' }
    case '55P03':
      return { status: 409, code: 'order_busy', message: 'This order is being saved by someone else. Nothing was saved; try again in a moment.' }
    case '57014':
      return { status: 504, code: 'timeout', message: 'Saving took too long and was cancelled. Nothing was saved; your form is unchanged. Please try again.' }
    default:
      return { status: 500, code: 'save_failed', message: 'The order could not be saved. Nothing was saved; your form is unchanged.' }
  }
}
