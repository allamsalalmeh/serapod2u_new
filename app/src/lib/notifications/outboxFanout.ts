import { notificationPhoneKey } from '@/lib/notifications/manualPhoneNumbers'

/**
 * Marks outbox rows created by the recipient fan-out.
 *
 * The recipient list is resolved from notification settings, not from the row, so a child
 * row resolves the exact same list as the row that created it. Without this marker every
 * child fans out again on the next worker cycle and the outbox grows without bound.
 */
export const FANOUT_MARKER = '_fanout_child'

export type FanoutSibling = { to_phone?: string | null; to_email?: string | null }

/** Stable identity for a recipient, so the same person is never queued twice. */
export function recipientDedupeKey(phone?: string | null, email?: string | null): string | null {
    const phoneKey = notificationPhoneKey(phone)
    if (phoneKey) return `p:${phoneKey}`
    const emailKey = String(email || '').trim().toLowerCase()
    if (emailKey) return `e:${emailKey}`
    return null
}

export function isFanoutChild(payload: Record<string, any> | null | undefined): boolean {
    return Boolean(payload && payload[FANOUT_MARKER])
}

/** Audit record of who a row was resolved to, kept on the row across retries. */
export const RESOLVED_RECIPIENT_KEY = '_resolved_recipient'
export type ResolvedRecipientAudit = { source: string; name?: string | null; org_id?: string | null; user_id?: string | null; resolved_at: string }

export function fanoutChildPayload(
    payload: Record<string, any> | null | undefined,
    recipient?: Omit<ResolvedRecipientAudit, 'resolved_at'> | null,
): Record<string, any> {
    const child: Record<string, any> = { ...(payload || {}), [FANOUT_MARKER]: true }
    delete child[RESOLVED_RECIPIENT_KEY]
    if (recipient) child[RESOLVED_RECIPIENT_KEY] = { ...recipient, resolved_at: new Date().toISOString() }
    return child
}

/**
 * A row that already has its destination keeps it: fan-out children, and any
 * row being retried (retry_count > 0) after a destination was resolved and
 * written. Retrying never re-reads master data, so a changed organization
 * contact cannot silently retarget a message that was already queued.
 */
export function keepsQueuedAddress(input: {
    payload: Record<string, any> | null | undefined
    channel: string
    toPhone?: string | null
    toEmail?: string | null
    retryCount?: number | null
}): boolean {
    const hasAddress = Boolean(input.channel === 'email' ? input.toEmail : input.toPhone)
    if (!hasAddress) return false
    return isFanoutChild(input.payload) || Number(input.retryCount || 0) > 0
}

/**
 * A child row was queued for one recipient. Re-resolving the configured list for it
 * would hand it the list's first address, so every child would reach the same person.
 */
export function fanoutChildKeepsAddress(
    payload: Record<string, any> | null | undefined,
    channel: string,
    toPhone?: string | null,
    toEmail?: string | null,
): boolean {
    return isFanoutChild(payload) && Boolean(channel === 'email' ? toEmail : toPhone)
}

/** The rows that belong to one notification (an order, or one scheduled report run). */
export function fanoutScope(payload: Record<string, any> | null | undefined): Record<string, string> | null {
    const orderNo = String(payload?.order_no || '').trim()
    // Two documents of one order (deposit and balance payment) are two notifications.
    const docNo = String(payload?.doc_no || '').trim()
    if (orderNo && docNo) return { order_no: orderNo, doc_no: docNo }
    if (orderNo) return { order_no: orderNo }
    const reportKey = String(payload?.report_key || '').trim()
    return reportKey ? { report_key: reportKey } : null
}

/**
 * Recipients that still need their own outbox row. The first recipient is handled by the
 * row being processed, so only the remainder are candidates.
 */
export function selectFanoutRecipients(input: {
    recipientList: string[]
    channel: string
    payload?: Record<string, any> | null
    existingSiblings?: FanoutSibling[]
}): string[] {
    const { recipientList, channel, payload, existingSiblings } = input

    if (isFanoutChild(payload)) return []
    if (!Array.isArray(recipientList) || recipientList.length < 2) return []

    const isEmail = channel === 'email'
    const primary = recipientList[0]
    const covered = new Set<string>()

    for (const sibling of existingSiblings || []) {
        const key = recipientDedupeKey(sibling?.to_phone, sibling?.to_email)
        if (key) covered.add(key)
    }

    const selected: string[] = []

    for (const target of recipientList.slice(1)) {
        if (!isEmail && notificationPhoneKey(target) && notificationPhoneKey(target) === notificationPhoneKey(primary)) {
            continue
        }

        const key = isEmail
            ? recipientDedupeKey(null, target)
            : recipientDedupeKey(target, null)

        if (key) {
            if (covered.has(key)) continue
            covered.add(key)
        }

        selected.push(target)
    }

    return selected
}
