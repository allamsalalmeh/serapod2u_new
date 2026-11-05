/**
 * What a Delivery Order says, shared by both PDF templates so they cannot disagree.
 *
 * Delivery information only: no price, amount, payment terms or bank detail is read here. Everything comes from stored
 * records, and whatever is not stored stays empty. The templates leave those fields blank, never a placeholder.
 */
import {
  buildCounterpartyAddressLines,
  resolveCounterpartyLabel,
  type CounterpartyOrganization,
} from '@/lib/documents/counterparty'
import { salesOrderLineDescription, sortSalesOrderLinesForDisplay } from '@/lib/orders/sales-order-line-presentation'

export const DELIVERY_NOTES_HEADING = 'DELIVERY NOTES'

/** Printed on every Delivery Order. */
export const STANDARD_DELIVERY_NOTES = [
  'Please verify quantities and product condition upon receipt.',
  'Any shortage or damage should be recorded before acknowledgement.',
  'Acknowledgement confirms receipt of goods, not payment.',
] as const

export interface OrderDeliveryNotes {
  contactName: string | null
  phone: string | null
  address: string | null
  /** Free text the user wrote instead of the structured customer details. */
  remarks: string | null
}

const clean = (value: unknown): string | null => {
  const text = String(value ?? '').trim()
  return text && text.toLowerCase() !== 'undefined' && text.toLowerCase() !== 'null' ? text : null
}

/** orders.notes holds either "Customer: …, Phone: …, Address: …" (order form default) or the user's own free text. */
export function parseOrderDeliveryNotes(notes: string | null | undefined): OrderDeliveryNotes {
  const text = String(notes ?? '')
  if (!/Customer:/.test(text) || !/Address:/.test(text)) {
    return { contactName: null, phone: null, address: null, remarks: clean(text) }
  }
  return {
    contactName: clean(text.match(/Customer:\s*([^,]*)/)?.[1]),
    phone: clean(text.match(/Phone:\s*([^,]*)/)?.[1]),
    address: clean(text.match(/Address:\s*([\s\S]*)/)?.[1]),
    remarks: null,
  }
}

/** The standard notes, then any remark written on the order. */
export function buildDeliveryNotes(notes: string | null | undefined): string {
  const { remarks } = parseOrderDeliveryNotes(notes)
  return [...STANDARD_DELIVERY_NOTES.map((note) => `\u2022 ${note}`), ...(remarks ? [remarks] : [])].join('\n')
}

export interface DeliveryRecipient {
  label: string
  name: string | null
  /** Address, then contact person and telephone. Lines without a stored value are absent. */
  detailLines: string[]
}

/** The buyer, delivered to the address given on the order, else its organization address. */
export function resolveDeliveryRecipient(order: {
  buyer_org?: CounterpartyOrganization | null
  notes?: string | null
}): DeliveryRecipient {
  const org = order.buyer_org
  const notes = parseOrderDeliveryNotes(order.notes)
  const contact = notes.contactName ?? clean(org?.contact_name)
  const phone = notes.phone ?? clean(org?.contact_phone)
  return {
    label: resolveCounterpartyLabel(org, false),
    name: clean(org?.org_name)?.toUpperCase() ?? null,
    detailLines: [
      ...(notes.address ? [notes.address] : buildCounterpartyAddressLines(org)),
      ...(contact ? [`Attn: ${contact}`] : []),
      ...(phone ? [`Tel: ${phone}`] : []),
    ],
  }
}

export interface DeliveryLineItem {
  qty?: number | null
  product?: { product_name?: string | null } | null
  variant?: { variant_name?: string | null } | null
}

export interface DeliveryLineRow {
  no: string
  description: string
  quantity: string
  unit: string
}

const formatQuantity = (quantity: number) => quantity.toLocaleString('en-MY')

/** Order quantities are counted in cases. Lines read in the same order and wording as the related Sales Order. */
export function buildDeliveryLines(items: readonly DeliveryLineItem[] | null | undefined): { rows: DeliveryLineRow[]; totalQuantity: string } {
  const sorted = sortSalesOrderLinesForDisplay([...(items ?? [])], (item) => item.product?.product_name)
  const rows = sorted.map((item, index) => {
    const quantity = Number(item.qty) || 0
    return {
      no: String(index + 1),
      description: salesOrderLineDescription(item.product?.product_name, item.variant?.variant_name) || 'Product',
      quantity: formatQuantity(quantity),
      unit: quantity === 1 ? 'Case' : 'Cases',
    }
  })
  const total = sorted.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)
  return { rows, totalQuantity: formatQuantity(total) }
}

export interface DeliveryAcknowledgementParty {
  label: string
  name: string
  signatureImage: string | null
  date: string | null
}

/**
 * Prepared By is whoever created the DO. Received By is the recorded acknowledgement. Nothing stores who delivered, so
 * Delivered By is for signing on paper.
 */
export function buildDeliveryAcknowledgement(document: {
  created_at?: string | null
  acknowledged_at?: string | null
  prepared_by?: { full_name?: string | null; signature_image?: string | null } | null
  acknowledger?: { full_name?: string | null } | null
  acknowledger_signature_image?: string | null
}): DeliveryAcknowledgementParty[] {
  const preparedName = clean(document.prepared_by?.full_name)
  const receivedName = clean(document.acknowledger?.full_name)
  return [
    { label: 'Prepared By:', name: preparedName ?? '', signatureImage: document.prepared_by?.signature_image ?? null, date: preparedName ? document.created_at ?? null : null },
    { label: 'Delivered By:', name: '', signatureImage: null, date: null },
    { label: 'Received By:', name: receivedName ?? '', signatureImage: receivedName ? document.acknowledger_signature_image ?? null : null, date: receivedName ? document.acknowledged_at ?? null : null },
  ]
}

/** The Sales Order this DO belongs to: the order's own number, as printed on its SO. */
export const relatedSalesOrderNo = (order: { display_doc_no?: string | null; order_no?: string | null }) =>
  clean(order.display_doc_no) ?? clean(order.order_no) ?? ''
