/**
 * The SMS OTP path records every attempt through recordSmsDelivery, which is
 * why it reaches the delivery monitor. The email path only wrote to
 * notification_events -- an auth audit table neither monitor reads -- so a
 * password reset email that sent perfectly well left no trace on the dashboard.
 */

export type EmailDeliveryOutcome = {
  success: boolean
  providerName?: string | null
  error?: string | null
  providerMessageId?: string | null
}

export type EmailDeliveryInput = {
  orgId: string
  outboxId?: string | null
  to: string
  eventCode: string
  result: EmailDeliveryOutcome
}

const EMAIL_PROVIDER_FALLBACK = 'smtp'

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function emailDeliveryLogRow(input: EmailDeliveryInput, now = new Date().toISOString()) {
  const success = Boolean(input.result.success)
  return {
    org_id: input.orgId,
    outbox_id: input.outboxId || null,
    event_code: input.eventCode,
    channel: 'email',
    recipient_value: input.to,
    recipient_type: 'email',
    status: success ? 'sent' : 'failed',
    provider_name: asString(input.result.providerName) || (success ? EMAIL_PROVIDER_FALLBACK : null),
    provider_message_id: input.result.providerMessageId || null,
    error_message: success ? null : (asString(input.result.error) || 'Email delivery failed'),
    queued_at: now,
    sent_at: success ? now : null,
    failed_at: success ? null : now,
  }
}

/**
 * Never throws: a monitor row is not worth failing a password reset over.
 */
export async function recordEmailDelivery(supabase: any, input: EmailDeliveryInput): Promise<void> {
  try {
    await supabase.from('notification_logs').insert(emailDeliveryLogRow(input))
  } catch (error) {
    console.error('[recordEmailDelivery]', error)
  }
}
