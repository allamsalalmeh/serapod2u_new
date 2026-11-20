/**
 * Built-in messages for an external party (the distributor or manufacturer
 * reached through "Related organization").
 *
 * The system defaults for some events are written for HQ approvers ("requires
 * your review and approval"). Approval belongs to HQ, so a distributor or
 * manufacturer must not be told to approve. These replace the built-in default
 * only — a template saved in Notification Types is always sent as saved.
 */
const PARTNER_DEFAULTS: Record<string, Partial<Record<'whatsapp' | 'sms' | 'email', string>>> = {
    order_submitted: {
        whatsapp: `📋 *Order Submitted*\n\n*Order:* #{{order_no}}\n*Date:* {{order_date}}\n*Total:* RM {{amount}}\n*Cases:* {{total_cases}}\n\nThis order is awaiting approval by HQ. No action is needed from you yet — you will be notified when it is approved.`,
        email: `Order #{{order_no}} has been submitted.\n\nDate: {{order_date}}\nTotal: RM {{amount}}\nCases: {{total_cases}}\n\nThe order is awaiting approval by HQ. No action is needed from you yet; you will be notified when it is approved.\n\nRegards,\nSerapod2U`,
        sms: `[Serapod2U] Order #{{order_no}} submitted (RM {{amount}}). Awaiting HQ approval; no action needed yet.`,
    },
}

/** The partner-safe default for this event/channel, or null when the normal default is already safe. */
export function partnerDefaultTemplate(eventCode: string, channel: string): string | null {
    return PARTNER_DEFAULTS[eventCode]?.[channel as 'whatsapp' | 'sms' | 'email'] || null
}

/** Phrases that ask the reader to approve. Used to warn when such a template reaches a partner. */
const APPROVAL_INSTRUCTIONS = [
    /pending your approval/i,
    /requires? your (review and )?approval/i,
    /needs? your approval/i,
    /awaiting your approval/i,
    /dear approver/i,
    /approve now/i,
    /please review and (approve|take action)/i,
    /needs approval/i,
]

export function asksReaderToApprove(template: string | null | undefined): boolean {
    const text = String(template || '')
    return APPROVAL_INSTRUCTIONS.some((pattern) => pattern.test(text))
}
