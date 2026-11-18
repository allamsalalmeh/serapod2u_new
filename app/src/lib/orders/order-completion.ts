/**
 * Whether an order's documents are complete (Supply Chain side), for the small
 * green / yellow indicator next to "Documents" in Finance screens.
 * Same steps as the Document Workflow in Order Documents.
 */

export interface CompletionOrder {
  order_type: string | null
  status: string | null
}

export interface CompletionDoc {
  doc_type: string
  status: string | null
  payment_percentage?: number | null
}

export interface OrderCompletion {
  complete: boolean
  /** One line for the tooltip. */
  reason: string
}

const ACK = 'acknowledged'

function first(docs: CompletionDoc[], type: string): CompletionDoc | undefined {
  return docs.find((d) => d.doc_type === type)
}

function acknowledged(doc: CompletionDoc | undefined): boolean {
  return !!doc && (doc.status === ACK || doc.status === 'completed')
}

/** A receipt for the whole remaining amount: 100%, or legacy receipts without a %. */
function isFinalReceipt(doc: CompletionDoc): boolean {
  return doc.doc_type === 'RECEIPT' && (doc.payment_percentage == null || Number(doc.payment_percentage) >= 100)
}

export function orderDocumentsCompletion(order: CompletionOrder, docs: CompletionDoc[]): OrderCompletion {
  if (order.status === 'cancelled') return { complete: false, reason: 'Order cancelled' }

  const pendingPayment = docs.some((d) => d.doc_type === 'PAYMENT' && d.status === 'pending')
  const receipts = docs.filter((d) => d.doc_type === 'RECEIPT')
  const finalReceipt = receipts.some(isFinalReceipt)

  if (order.order_type === 'D2H' || order.order_type === 'S2D') {
    if (!acknowledged(first(docs, 'SO'))) return { complete: false, reason: 'Sales Order not acknowledged' }
    if (!acknowledged(first(docs, 'DO'))) return { complete: false, reason: 'Delivery Order not acknowledged' }
    if (!acknowledged(first(docs, 'INVOICE'))) return { complete: false, reason: 'Invoice not acknowledged' }
    if (pendingPayment) return { complete: false, reason: 'Payment awaiting acknowledgment' }
    if (finalReceipt) return { complete: true, reason: 'All documents complete' }
    if (receipts.length > 0) return { complete: false, reason: 'Partially paid, balance pending' }
    return { complete: false, reason: 'Not paid yet' }
  }

  // H2M (purchase from manufacturer)
  if (!acknowledged(first(docs, 'PO'))) return { complete: false, reason: 'Purchase Order not acknowledged' }
  if (pendingPayment) return { complete: false, reason: 'Payment awaiting acknowledgment' }
  if (docs.some((d) => d.doc_type === 'PAYMENT_REQUEST' && d.status === 'pending')) {
    return { complete: false, reason: 'Balance request awaiting acknowledgment' }
  }
  if (finalReceipt || order.status === 'closed') return { complete: true, reason: 'All documents complete' }
  if (!acknowledged(first(docs, 'INVOICE'))) return { complete: false, reason: 'Invoice not acknowledged' }
  if (receipts.length > 0) return { complete: false, reason: 'Deposit paid, balance pending' }
  return { complete: false, reason: 'Not paid yet' }
}
