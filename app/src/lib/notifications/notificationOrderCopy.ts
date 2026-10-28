/**
 * Notification Types — clear copy for the order and document notifications.
 *
 * The list used to show seven events under "Order Status" and six under
 * "Order Document", with names like "Manufacture Completed His Order" and
 * descriptions that did not say when the notification fires or which
 * transaction it belongs to. This module holds the audited copy:
 *
 *   when        — what really triggers the event (proven from the emitting code)
 *   transaction — the order or document it relates to, and which flow it is on
 *
 * Presentation only. It never changes an event code, a stored category, an
 * enabled/disabled state, saved recipients or saved templates, and it is not a
 * second source of routing. Events without audited copy here keep reading
 * event_name / event_description from notification_types. The migration
 * supabase/migrations/20261027160000_notification_types_order_copy.sql writes
 * the same text into the catalog (a test keeps the two identical). The three
 * acknowledgement events (po_acknowledged, invoice_acknowledged,
 * payment_received) only fire once
 * supabase/migrations/20261030100000_supply_chain_document_notifications.sql
 * is applied; the catalog copy for them is written only when that trigger exists.
 *
 * H2M = HQ → Manufacturer purchase order.  D2H = Distributor → HQ sales order.
 * S2D = Shop → Distributor (uses the same order lifecycle events).
 */

export interface OrderEventCopy {
    /** What actually triggers it. Shown as "When: …". */
    when: string
    /** The order or document it belongs to, and the flow. Shown as "Transaction: …". */
    transaction: string
}

/** Audited "when / which transaction" copy, by event code. */
export const ORDER_EVENT_COPY: Record<string, OrderEventCopy> = {
    // ── Sales Orders (stored category: order) ────────────────────────────────
    order_submitted: {
        when: 'a new order is submitted for approval (Draft → Submitted, or saved straight to Submitted).',
        transaction: 'the order itself, on every order type — H2M purchase orders and D2H/S2D sales orders. Approval belongs to HQ, so a distributor or manufacturer is only informed.',
    },
    order_approved: {
        when: 'HQ approves a submitted order. The same approval also creates the order\'s documents.',
        transaction: 'the order itself, on every order type (H2M, D2H, S2D).',
    },
    order_rejected: {
        when: 'a submitted order is rejected, or an order is cancelled — both are sent as this one event.',
        transaction: 'the order itself, on every order type. The message says which of the two happened.',
    },
    order_closed: {
        when: 'an order reaches Closed, normally when the final payment is acknowledged.',
        transaction: 'the order itself, on every order type.',
    },

    // ── Production & Receiving (stored category: order, H2M only) ────────────
    qr_batch_generated: {
        when: 'every QR code for an order batch has been generated and the Excel file is ready.',
        transaction: 'the QR batch of an approved H2M order. H2M only — D2H orders do not generate QR batches.',
    },
    manufacturer_scan_complete: {
        when: 'the manufacturer finishes production and the batch is ready for shipment.',
        transaction: 'the QR batch of an H2M order. H2M only.',
    },
    warehouse_received: {
        when: 'warehouse receiving of a batch finishes and inventory has been updated.',
        transaction: 'the QR batch of the H2M order. H2M only.',
    },

    // ── Purchase Orders (stored category: document, H2M only) ───────────────
    po_created: {
        when: 'HQ approves an H2M order, which creates the PO document for the manufacturer.',
        transaction: 'the PO document of an H2M order (issued by HQ to the manufacturer). H2M only — D2H approval creates Sales Order, Delivery Order and Invoice documents instead.',
    },
    po_acknowledged: {
        when: 'the manufacturer acknowledges the PO document.',
        transaction: 'the PO document of an H2M order (HQ → manufacturer).',
    },

    // ── Documents & Payments (stored category: document) ────────────────────
    invoice_created: {
        when: 'an invoice document is created — for D2H when HQ approves the order (or, if none exists yet, when the warehouse marks goods Ready to Ship), and for H2M when the manufacturer acknowledges the PO.',
        transaction: 'the invoice document of the order, on both flows.',
    },
    invoice_acknowledged: {
        when: 'the invoice is acknowledged by the party it was issued to.',
        transaction: 'the invoice document. For D2H the distributor acknowledges HQ\'s invoice; for H2M HQ acknowledges the manufacturer\'s invoice.',
    },
    payment_received: {
        when: 'a payment document is acknowledged.',
        transaction: 'the payment document raised against the invoice, on both flows.',
    },
    receipt_issued: {
        when: 'a receipt is issued for money received — recorded from the order screen, or created automatically when a payment is acknowledged.',
        transaction: 'the receipt document of the order, on both flows.',
    },
}

/**
 * Names that were misleading in the catalog. Everything else keeps the stored
 * name, so existing screens, monitor filters and test labels stay valid.
 */
export const ORDER_EVENT_NAME_OVERRIDES: Record<string, string> = {
    manufacturer_scan_complete: 'Manufacture Completed',
    warehouse_received: 'Warehouse Received',
}

/**
 * What the list shows for one notification: an understandable name plus a
 * description that says when it fires and which transaction it belongs to.
 * Events outside the audited order/document set keep the stored catalog copy.
 */
export function orderEventCopy(type: {
    event_code: string
    event_name?: string | null
    event_description?: string | null
}): { name: string; description: string } {
    const storedName = String(type.event_name || type.event_code)
    const name = ORDER_EVENT_NAME_OVERRIDES[type.event_code] || storedName
    const copy = ORDER_EVENT_COPY[type.event_code]
    if (!copy) return { name, description: String(type.event_description || '') }
    return { name, description: `When: ${copy.when} · Transaction: ${copy.transaction}` }
}
