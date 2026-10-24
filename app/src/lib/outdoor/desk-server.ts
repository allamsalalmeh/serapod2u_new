import { listOutdoorProducts } from '@/lib/outdoor/catalog'
import { countOutdoorSubscribers } from '@/lib/outdoor/notify-subscribers'
import { isOutdoorPriced } from '@/lib/outdoor/pricing'
import { sellableStock } from '@/lib/storefront/order-stock'
import { OPEN_ORDER_REQUEST_STATUSES } from '@/lib/storefront/order-requests'
import {
  isOutdoorPackshot,
  outdoorDeskProductStatus,
  type OutdoorDeskData,
  type OutdoorDeskProduct,
  type OutdoorDeskSummary,
} from '@/lib/outdoor/desk'

const TO_SEND = ['paid', 'processing']
const SOLD = ['paid', 'processing', 'shipped', 'delivered']
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000

/** Start of the current calendar month in Malaysia time, as an ISO timestamp. */
export function startOfMonthMyt(now = new Date()) {
  const myt = new Date(now.getTime() + MYT_OFFSET_MS)
  return new Date(Date.UTC(myt.getUTCFullYear(), myt.getUTCMonth(), 1) - MYT_OFFSET_MS).toISOString()
}

async function countRows(query: any): Promise<number | null> {
  const { count, error } = await query
  return error ? null : count || 0
}

async function loadSummary(admin: any): Promise<OutdoorDeskSummary> {
  const orders = () => admin.from('storefront_orders').select('id', { count: 'exact', head: true }).eq('sales_channel', 'outdoor')
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [toSend, awaitingPayment, openRequests, messagesThisWeek, sales] = await Promise.all([
    countRows(orders().in('status', TO_SEND)),
    countRows(orders().eq('status', 'pending_payment')),
    countRows(
      admin
        .from('storefront_order_requests')
        .select('id', { count: 'exact', head: true })
        .eq('sales_channel', 'outdoor')
        .in('status', OPEN_ORDER_REQUEST_STATUSES),
    ),
    countRows(admin.from('outdoor_contact_messages').select('id', { count: 'exact', head: true }).gte('created_at', weekAgo)),
    admin
      .from('storefront_orders')
      .select('total_amount')
      .eq('sales_channel', 'outdoor')
      .in('status', SOLD)
      .gte('paid_at', startOfMonthMyt())
      .limit(5000),
  ])

  const soldRows: Array<{ total_amount: number | string | null }> = sales?.error ? [] : sales?.data || []
  return {
    toSend: toSend ?? 0,
    awaitingPayment: awaitingPayment ?? 0,
    openRequests,
    messagesThisWeek,
    salesThisMonth: {
      orders: soldRows.length,
      amount: Math.round(soldRows.reduce((sum, row) => sum + (Number(row.total_amount) || 0), 0) * 100) / 100,
    },
  }
}

async function loadProducts(admin: any): Promise<OutdoorDeskProduct[]> {
  const { products } = await listOutdoorProducts({ sort: 'name_asc', limit: 48, includeUnpriced: true })
  if (products.length === 0) return []

  const { data: variantRows } = await admin
    .from('product_variants')
    .select('id, product_id, attributes')
    .in('product_id', products.map((p) => p.id))
    .eq('is_active', true)
  const sellable = (variantRows || []).filter((row: any) => !row.attributes?.outdoor_only_variant && !row.attributes?.outdoor_hidden)
  const stock = await sellableStock(admin, sellable.map((row: any) => String(row.id)), 'outdoor')

  return products.map((product) => {
    const units = stock
      ? sellable
          .filter((row: any) => String(row.product_id) === product.id)
          .reduce((sum: number, row: any) => sum + (stock.get(String(row.id)) ?? 0), 0)
      : null
    const priced = isOutdoorPriced(product)
    return {
      id: product.id,
      name: product.product_name,
      code: product.product_code,
      imageUrl: product.image_url,
      hasOwnPhoto: Boolean(product.image_url) && !isOutdoorPackshot(product.image_url),
      price: product.display_price ?? product.starting_price ?? null,
      variantCount: product.variant_count,
      stock: units,
      status: outdoorDeskProductStatus({ priced, stock: units, soldOut: product.sold_out }),
    }
  })
}

export async function loadOutdoorDesk(admin: any): Promise<OutdoorDeskData> {
  const [subscribers, summary, products] = await Promise.all([
    countOutdoorSubscribers(admin),
    loadSummary(admin),
    loadProducts(admin),
  ])
  return { subscribers, summary, products }
}
