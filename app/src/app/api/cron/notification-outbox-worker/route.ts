import { NextRequest, NextResponse } from 'next/server'
import { createHash, createHmac } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { getWhatsAppConfig, callGateway, sendWhatsAppMessage } from '@/app/api/settings/whatsapp/_utils'
import { expandNotificationRoleCodes } from '@/lib/notifications/recipientRoleCodes'
import { resolveSmtpEndpoint } from '@/lib/email/smtp-endpoint'
import { requireCronAuth } from '@/lib/cron/auth'
import { WORKER_NAMES, withWorkerLease } from '@/lib/cron/lease'
import { recordSmsDelivery, refreshOpenSmsStatuses, sendSmsWithActiveProvider } from '@/lib/notifications/sms-send'
import { getSmsTemplateBody, getSmsTemplatesForEvent } from '@/config/smsTemplates'
import { queueRoutingFallback } from '@/lib/notifications/outbox-fallback'
import { deliveryChainForPreset, isRoutingFallbackPayload, resolveNotificationRoutingPreset, shouldAdvanceFallback, type NotificationDeliveryChannel } from '@/lib/notifications/routing'
import { isSingleCreatorSource, ownerEmailFromPayload, ownerPhoneFromPayload, resolveRecipientTargets } from '@/lib/notifications/orderOwnerNotify'
import { notificationPhoneKey, toSmsE164 } from '@/lib/notifications/manualPhoneNumbers'
import { EMAIL_UI_TEST_REWRITE_LOOKBACK_MS, emailProviderBlockedByUiTest } from '@/lib/notifications/emailProviderReady'
import { fanoutChildKeepsAddress, fanoutChildPayload, fanoutScope, isFanoutChild, selectFanoutRecipients } from '@/lib/notifications/outboxFanout'

async function failEmailsSentWhileProviderTestBlocked(supabase: any) {
    const { data: providers } = await supabase
        .from('notification_provider_configs')
        .select('org_id, last_test_status, last_test_error, last_test_at')
        .eq('channel', 'email')
        .eq('is_active', true)

    for (const provider of providers || []) {
        const blocked = emailProviderBlockedByUiTest(provider)
        if (!blocked || !provider.last_test_at) continue
        const testAt = Date.parse(provider.last_test_at)
        if (!Number.isFinite(testAt)) continue
        const since = new Date(testAt - EMAIL_UI_TEST_REWRITE_LOOKBACK_MS).toISOString()
        const { data: rows } = await supabase
            .from('notifications_outbox')
            .select('id')
            .eq('org_id', provider.org_id)
            .eq('channel', 'email')
            .in('status', ['sent', 'delivered'])
            .gte('created_at', since)
        const ids = (rows || []).map((row: { id: string }) => row.id)
        if (ids.length === 0) continue
        await supabase
            .from('notifications_outbox')
            .update({ status: 'failed', error: blocked, sent_at: null })
            .in('id', ids)
        await supabase
            .from('notification_logs')
            .update({
                status: 'failed',
                error_message: blocked,
                failed_at: new Date().toISOString(),
                sent_at: null,
            })
            .in('outbox_id', ids)
            .in('status', ['sent', 'delivered'])
    }
}

/**
 * CRON: /api/cron/notification-outbox-worker
 * Background worker to process queued notification outbox messages.
 * Picks up pending items from notifications_outbox, resolves recipients,
 * renders templates, and sends via WhatsApp/SMS/Email.
 * 
 * Runs every minute via internal cron scheduler or can be called manually.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Simple template renderer
function renderTemplate(template: string, payload: Record<string, any>): string {
    let result = template
    for (const [key, value] of Object.entries(payload)) {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value ?? ''))
    }
    return result
}

function splitConfiguredRecipients(value?: string | null): string[] {
    return String(value || '')
        .split(/[\n,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
}

async function ensureOrderOwnerContact(supabase: any, payload: Record<string, any>) {
    const nameAlready = String(payload.created_by || payload.User || '').trim()
    const hasPhone = String(payload.created_by_phone || '').trim()
    const hasEmail = String(payload.created_by_email || '').trim()
    let creatorId = String(payload.created_by_id || '').trim() || null

    if (!creatorId) {
        if (payload.order_id) {
            const { data: order } = await supabase
                .from('orders')
                .select('created_by')
                .eq('id', payload.order_id)
                .maybeSingle()
            creatorId = order?.created_by || null
        } else if (payload.order_no) {
            const { data: order } = await supabase
                .from('orders')
                .select('created_by')
                .eq('display_doc_no', String(payload.order_no))
                .maybeSingle()
            creatorId = order?.created_by || null
        }
    }

    if (!creatorId) {
        if (!nameAlready || nameAlready === '{{created_by}}' || nameAlready === '{{User}}') {
            payload.created_by = payload.created_by || 'Unknown'
            payload.User = payload.created_by
        }
        return
    }

    payload.created_by_id = creatorId
    if (hasPhone && hasEmail && nameAlready && nameAlready !== '{{created_by}}' && nameAlready !== '{{User}}') {
        payload.created_by = nameAlready
        payload.User = nameAlready
        return
    }

    const { data: creator } = await supabase
        .from('users')
        .select('full_name, email, phone')
        .eq('id', creatorId)
        .maybeSingle()
    const name = String(creator?.full_name || creator?.email || nameAlready || 'Unknown').trim() || 'Unknown'
    payload.created_by = name
    payload.User = name
    if (!hasPhone && creator?.phone) payload.created_by_phone = String(creator.phone).trim()
    if (!hasEmail && creator?.email) payload.created_by_email = String(creator.email).trim()
}

function payloadPhone(payload: Record<string, any>): string | null {
    const value = String(
        payload.customer_phone || payload.contact_phone || payload.phone || payload.phone_number || ''
    ).trim()
    return value || null
}

async function outboxStatusAfterAttempt(supabase: any, id: string): Promise<string | null> {
    const { data } = await supabase
        .from('notifications_outbox')
        .select('status')
        .eq('id', id)
        .maybeSingle()
    return data?.status || null
}

async function maybeQueueFallback(
    supabase: any,
    item: any,
    failedChannel: NotificationDeliveryChannel,
    recipientPhone: string | null,
    reason: string,
    options?: { providerMissing?: boolean; outboxStatus?: string | null },
) {
    if (!shouldAdvanceFallback({
        retryCount: item.retry_count,
        maxRetries: item.max_retries,
        outboxStatus: options?.outboxStatus,
        providerMissing: options?.providerMissing,
    })) {
        return false
    }
    return queueRoutingFallback(supabase, item, failedChannel, recipientPhone, reason)
}

function parseProviderSecrets(value: unknown): Record<string, any> {
    if (!value) return {}
    if (typeof value === 'object') return value as Record<string, any>
    try { return JSON.parse(String(value)) } catch { return {} }
}

function hmac(key: Buffer | string, value: string) {
    return createHmac('sha256', key).update(value).digest()
}

async function sendViaAwsSes(publicConfig: Record<string, any>, secrets: Record<string, any>, to: string, subject: string, body: string, fromEmail: string) {
    const region = publicConfig.aws_region || 'us-east-1'
    const host = `email.${region}.amazonaws.com`
    const payload = JSON.stringify({
        FromEmailAddress: fromEmail,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: body, Charset: 'UTF-8' } } } },
        ...(publicConfig.config_set ? { ConfigurationSetName: publicConfig.config_set } : {}),
    })
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = createHash('sha256').update(payload).digest('hex')
    const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'
    const canonicalRequest = `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
    const credentialScope = `${dateStamp}/${region}/ses/aws4_request`
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secrets.aws_secret_access_key}`, dateStamp), region), 'ses'), 'aws4_request')
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
    const response = await fetch(`https://${host}/v2/email/outbound-emails`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Amz-Date': amzDate,
            'X-Amz-Content-Sha256': payloadHash,
            Authorization: `AWS4-HMAC-SHA256 Credential=${secrets.aws_access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
            ...(secrets.aws_session_token ? { 'X-Amz-Security-Token': secrets.aws_session_token } : {}),
        },
        body: payload,
    })
    const responseBody = await response.text()
    if (!response.ok) return { success: false, error: `aws_ses returned ${response.status}: ${responseBody}` }
    try { return { success: true, messageId: JSON.parse(responseBody)?.MessageId || null } } catch { return { success: true, messageId: null } }
}

async function sendEmailWithActiveProvider(supabase: any, orgId: string, to: string, subject: string, body: string) {
    const { data: config } = await supabase
        .from('notification_provider_configs')
        .select('*')
        .eq('org_id', orgId)
        .eq('channel', 'email')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    if (!config) return { success: false, error: 'Email provider not configured' }
    const blocked = emailProviderBlockedByUiTest(config)
    if (blocked) return { success: false, error: blocked }
    const publicConfig = config.config_public || {}
    const secrets = parseProviderSecrets(config.config_encrypted)
    const fromEmail = publicConfig.from_email || publicConfig.gmail_email
    const fromName = publicConfig.from_name || 'Serapod2U'

    try {
        if (config.provider_name === 'aws_ses') {
            return await sendViaAwsSes(publicConfig, secrets, to, subject, body, fromEmail)
        }

        if (config.provider_name === 'smtp') {
            const smtpHost = String(publicConfig.smtp_host || '').trim()
            const security = String(publicConfig.security || 'starttls').toLowerCase()
            const endpoint = await resolveSmtpEndpoint(smtpHost)
            const nodemailer = require('nodemailer')
            const transporter = nodemailer.createTransport({
                host: endpoint.connectHost,
                port: Number(publicConfig.port || 587),
                secure: security === 'ssl',
                requireTLS: security === 'starttls',
                tls: { servername: endpoint.tlsServername },
                auth: { user: publicConfig.username || secrets.username, pass: secrets.password },
            })
            const result = await transporter.sendMail({ from: `"${fromName}" <${fromEmail}>`, to, subject, text: body })
            if (Array.isArray(result.rejected) && result.rejected.length > 0) {
                return { success: false, error: `SMTP rejected: ${result.rejected.join(', ')}` }
            }
            return { success: true, messageId: result.messageId }
        }

        if (config.provider_name === 'gmail') {
            const params = new URLSearchParams({
                client_id: publicConfig.oauth_client_id,
                client_secret: secrets.oauth_client_secret || publicConfig.oauth_client_secret,
                refresh_token: secrets.oauth_refresh_token || publicConfig.oauth_refresh_token,
                grant_type: 'refresh_token',
            })
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params })
            const token = await tokenResponse.json()
            if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || 'Unable to refresh Gmail access token')
            const nodemailer = require('nodemailer')
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { type: 'OAuth2', user: publicConfig.gmail_email, clientId: publicConfig.oauth_client_id, clientSecret: secrets.oauth_client_secret, refreshToken: secrets.oauth_refresh_token, accessToken: token.access_token },
            })
            const result = await transporter.sendMail({ from: `"${fromName}" <${publicConfig.gmail_email}>`, to, subject, text: body })
            if (Array.isArray(result.rejected) && result.rejected.length > 0) {
                return { success: false, error: `Gmail rejected: ${result.rejected.join(', ')}` }
            }
            return { success: true, messageId: result.messageId }
        }

        let response: Response
        if (config.provider_name === 'sendgrid') {
            response = await fetch('https://api.sendgrid.com/v3/mail/send', {
                method: 'POST', headers: { Authorization: `Bearer ${secrets.api_key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: fromEmail, name: fromName }, subject, content: [{ type: 'text/plain', value: body }] }),
            })
        } else if (config.provider_name === 'resend') {
            response = await fetch('https://api.resend.com/emails', {
                method: 'POST', headers: { Authorization: `Bearer ${secrets.api_key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: `${fromName} <${fromEmail}>`, to: [to], subject, text: body }),
            })
        } else if (config.provider_name === 'postmark') {
            response = await fetch('https://api.postmarkapp.com/email', {
                method: 'POST', headers: { 'X-Postmark-Server-Token': secrets.api_token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ From: `${fromName} <${fromEmail}>`, To: to, Subject: subject, TextBody: body }),
            })
        } else if (config.provider_name === 'mailgun') {
            const regionHost = publicConfig.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net'
            const form = new FormData()
            form.set('from', `${fromName} <${fromEmail}>`); form.set('to', to); form.set('subject', subject); form.set('text', body)
            response = await fetch(`https://${regionHost}/v3/${publicConfig.domain}/messages`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`api:${secrets.api_key}`).toString('base64')}` }, body: form })
        } else {
            return { success: false, error: `Email provider ${config.provider_name} is not supported by the notification worker` }
        }

        const responseBody = await response.text()
        if (!response.ok) return { success: false, error: `${config.provider_name} returned ${response.status}: ${responseBody}` }
        let messageId: string | null = response.headers.get('x-message-id')
        try { messageId ||= JSON.parse(responseBody)?.id || null } catch { }
        return { success: true, messageId }
    } catch (error: any) {
        return { success: false, error: error.message || 'Email delivery failed' }
    }
}

const WORKER = WORKER_NAMES.notificationOutbox

export async function GET(request: NextRequest) {
    const unauthorized = requireCronAuth(request, WORKER)
    if (unauthorized) return unauthorized

    const supabase = createAdminClient()
    const outcome = await withWorkerLease(supabase, WORKER, () => runOutbox(supabase))
    return outcome.status === 'ran' ? outcome.result : outcome.response
}

async function runOutbox(supabase: ReturnType<typeof createAdminClient>): Promise<NextResponse> {
    const startTime = Date.now()

    try {
        // Re-queue SMS/Email cancelled by the old "do not send after WhatsApp failed" rule.
        await supabase
            .from('notifications_outbox')
            .update({ status: 'queued', error: null })
            .eq('status', 'cancelled')
            .eq('error', 'Not sent because WhatsApp already failed. No extra SMS/Email is generated after a failed send.')

        await failEmailsSentWhileProviderTestBlocked(supabase).catch((err: any) => {
            console.warn('[NotifWorker] Email UI-test status rewrite failed:', err?.message || err)
        })

        // 1. Fetch pending notifications from outbox.
        // NOTE: get_pending_notifications uses FOR UPDATE SKIP LOCKED, but those
        // row locks are released as soon as this RPC's transaction commits -
        // i.e. BEFORE anything is dispatched. It therefore does NOT prevent two
        // executions from sending the same message. The worker lease around this
        // function is what guarantees single-dispatch.
        const { data: pendingItems, error: fetchError } = await supabase
            .rpc('get_pending_notifications', { p_limit: 20 })

        const smsStatus = await refreshOpenSmsStatuses(supabase).catch((err) => {
            console.warn('[NotifWorker] SMS status refresh failed:', err?.message || err)
            return { checked: 0, updated: 0, timedOut: false }
        })

        if (fetchError) {
            // Graceful handling: RPC may not exist on staging or network may be flaky
            console.warn('[NotifWorker] Error fetching pending:', fetchError.message)
            return NextResponse.json({ processed: 0, message: 'Skipped: ' + fetchError.message, sms_status: smsStatus })
        }

        if (!pendingItems || pendingItems.length === 0) {
            return NextResponse.json({ processed: 0, message: 'No pending notifications', sms_status: smsStatus })
        }

        console.log(`[NotifWorker] Processing ${pendingItems.length} notification(s)`)

        let sent = 0
        let failed = 0

        for (const item of pendingItems) {
            try {
                const { id, org_id, event_code, channel, to_phone, to_email, template_code, payload_json, provider_name } = item

                // Atomic claim: flip queued -> processing in a single conditional UPDATE
                // so only one concurrent worker run can "win" this item. The immediate
                // fire-and-forget trigger (fetch right after queuing) and the standing
                // */1 * * * * cron both hit this same endpoint, and can overlap within
                // seconds of each other. The previous approach (SELECT status, decide,
                // send, THEN update status) left a window between the read and the
                // post-send write during which a second run would also see "queued" and
                // send again -- that's what caused duplicate SMS/WhatsApp sends for a
                // single queued notification even though only one row existed.
                const { data: claimedRows, error: claimError } = await supabase
                    .from('notifications_outbox')
                    .update({ status: 'processing' })
                    .eq('id', id)
                    .eq('status', 'queued')
                    .is('provider_message_id', null)
                    .select('id')

                if (claimError) {
                    console.warn('[NotifWorker] Claim failed for item', id, claimError.message)
                    continue
                }
                if (!claimedRows || claimedRows.length === 0) {
                    // Another concurrent run already claimed (or finished) this item.
                    continue
                }

                // 2. Get the notification template
                let templateBody = ''

                // Fetch notification settings (use 'any' cast since DB has extra jsonb cols not in TypeScript types)
                let { data: rawSetting } = await supabase
                    .from('notification_settings')
                    .select('*')
                    .eq('org_id', org_id)
                    .eq('event_code', event_code)
                    .maybeSingle()

                if (!rawSetting) {
                    const { data: hq } = await supabase
                        .from('organizations')
                        .select('id')
                        .eq('org_type_code', 'HQ')
                        .eq('is_active', true)
                        .order('created_at', { ascending: true })
                        .limit(1)
                        .maybeSingle()
                    if (hq?.id) {
                        const { data: hqSetting } = await supabase
                            .from('notification_settings')
                            .select('*')
                            .eq('org_id', hq.id)
                            .eq('event_code', event_code)
                            .maybeSingle()
                        rawSetting = hqSetting
                    }
                }

                const notifSetting = rawSetting as any

                // Try DB message_templates first
                const effectiveTemplateCode = notifSetting?.template_code || template_code
                if (effectiveTemplateCode) {
                    const { data: dbTemplate } = await supabase
                        .from('message_templates')
                        .select('body')
                        .eq('org_id', org_id)
                        .eq('code', effectiveTemplateCode)
                        .eq('channel', channel)
                        .eq('is_active', true)
                        .single()

                    if (dbTemplate?.body) {
                        templateBody = dbTemplate.body
                    }
                }

                // Check notification_settings.templates jsonb column (set via the UI drawer)
                if (!templateBody && notifSetting?.templates && notifSetting.templates[channel]) {
                    const saved = String(notifSetting.templates[channel] || '').trim()
                    if (channel === 'sms') {
                        const byId = getSmsTemplatesForEvent(event_code).find((template) => template.id === saved)
                        templateBody = byId?.body || saved
                    } else {
                        templateBody = saved
                    }
                }

                if (!templateBody && channel === 'sms') {
                    templateBody = getSmsTemplateBody(event_code)
                }

                // Last fallback — use a built-in default
                if (!templateBody) {
                    if (event_code === 'order_submitted') {
                        templateBody = `📋 *New Order Pending Approval*\n\n*Order:* #{{order_no}}\n*Date:* {{order_date}}\n*Customer:* {{customer_name}}\n*Total:* RM {{amount}}\n\nThis order requires your review and approval.`
                    } else if (event_code === 'order_approved') {
                        templateBody = `✅ Order #{{order_no}} has been approved.\nAmount: RM {{amount}}\nStatus: {{status}}`
                    } else if (event_code === 'user_created_shop') {
                        templateBody = `🏪 *User Created New Shop*\n\n*Shop:* {{shop_name}}\n*Branch:* {{shop_branch}}\n*State:* {{shop_state}}\n*Created by:* {{creator_name}}\n*Creator email:* {{creator_email}}\n*Contact phone:* {{contact_phone}}\n*Created at:* {{created_at}}`
                    } else if (event_code === 'roadtour_qr_delivery') {
                        templateBody = `Your RoadTour QR is ready.\n\nCampaign: {{campaign_name}}\nReference: {{reference_name}}\n\nOpen QR: {{qr_url}}\nQR image: {{qr_image_url}}`
                    } else if (event_code === 'return_draft_created') {
                        templateBody = `📝 Return {{return_no}} has been created for {{return_source_name}} ({{return_source_code}}).\nWarehouse: {{return_warehouse_name}}\nItems: {{total_quantity}} pcs`
                    } else if (event_code === 'return_submitted') {
                        templateBody = `📦 Your product return {{return_no}} has been submitted to {{return_warehouse_name}}.`
                    } else if (event_code === 'return_received') {
                        templateBody = `✅ Your product return {{return_no}} has been received by {{return_warehouse_name}}.`
                    } else if (event_code === 'return_processing') {
                        templateBody = `⚙️ Your product return {{return_no}} is now being processed.`
                    } else if (event_code === 'return_completed') {
                        templateBody = `🎉 Your product return {{return_no}} has been completed.`
                    } else if (event_code === 'system_sms_check') {
                        templateBody = `Serapod2U SMS check. If you received this, Local Malaysian SMS is working.`
                    } else if (event_code === 'tiktok_shop_daily_report') {
                        templateBody = `{{report_text}}`
                    } else if (event_code === 'tiktok_shop_daily_report_sms') {
                        templateBody = `{{summary_text}}`
                    } else {
                        templateBody = `Update: ${event_code} occurred.\nOrder: {{order_no}}\nStatus: {{status}}`
                    }
                }

                // 3. Render the template with payload
                const payload = (typeof payload_json === 'object' && payload_json !== null && !Array.isArray(payload_json))
                    ? payload_json as Record<string, any>
                    : {}
                await ensureOrderOwnerContact(supabase, payload)

                const routingPreset = resolveNotificationRoutingPreset(notifSetting)
                const isFallbackHop = isRoutingFallbackPayload(payload)
                const settingsFirstHopEvent = event_code === 'order_rejected' || event_code === 'order_approved'
                if (settingsFirstHopEvent && !isFallbackHop && notifSetting) {
                    const firstChannel = deliveryChainForPreset(routingPreset)[0]
                    if (channel !== firstChannel) {
                        await supabase.from('notifications_outbox').update({
                            status: 'cancelled',
                            error: `Order ${event_code === 'order_approved' ? 'approve' : 'reject'} follows notification settings: only ${firstChannel} is sent first. Other channels run only if that hop fails.`,
                        }).eq('id', id)
                        continue
                    }
                }

                const editedSmsBody = channel === 'sms' ? String(payload._sms_body || '').trim() : ''
                const messageBody = editedSmsBody || renderTemplate(templateBody, payload)

                // 4. Recipients follow Notification Types (recipient_targets), not a hardcoded event list.
                let recipientPhone = to_phone
                let recipientEmail = to_email
                const recipientConfig = notifSetting?.recipient_config || {}
                const targets = resolveRecipientTargets(event_code, recipientConfig)
                const creatorOnly = isSingleCreatorSource(event_code, recipientConfig)

                if (creatorOnly) {
                    if (channel === 'email') {
                        recipientEmail = ownerEmailFromPayload(payload) || recipientEmail
                    } else {
                        recipientPhone = ownerPhoneFromPayload(payload)
                    }
                } else if (notifSetting && !isFallbackHop && !fanoutChildKeepsAddress(payload, channel, to_phone, to_email)) {
                    const recipients = new Set<string>()
                    const recipientTargets = recipientConfig.recipient_targets || {}

                    const addRecipients = (values: Array<string | null | undefined>) => {
                        for (const value of values) {
                            let normalized = String(value || '').trim()
                            if (!normalized) continue
                            if (channel !== 'email') {
                                const parsed = toSmsE164(normalized)
                                if ('e164' in parsed) normalized = parsed.e164
                            }
                            recipients.add(normalized)
                        }
                    }

                    if (targets.order_creator) {
                        if (channel === 'email') addRecipients([ownerEmailFromPayload(payload)])
                        else addRecipients([ownerPhoneFromPayload(payload)])
                    }

                    const configUsers = notifSetting.recipient_config?.recipient_users
                    const legacyUsers = notifSetting.recipient_users
                    const userIds = configUsers?.length ? configUsers : legacyUsers?.length ? legacyUsers : []

                    if (targets.users && userIds.length) {
                        const { data: users } = await supabase
                            .from('users')
                            .select('phone, email')
                            .in('id', userIds)
                            .eq('is_active', true)

                        if (users) {
                            addRecipients(users.map((u) => channel === 'email' ? u.email : u.phone))
                        }
                    }

                    const configuredRoles = Array.isArray(recipientConfig.roles) && recipientConfig.roles.length > 0
                        ? recipientConfig.roles
                        : Array.isArray(notifSetting.recipient_roles) && notifSetting.recipient_roles.length > 0
                            ? notifSetting.recipient_roles
                            : []
                    const resolvedRoleCodes = expandNotificationRoleCodes(configuredRoles)
                    const hasExplicitRecipientTargets = Object.keys(recipientTargets).length > 0
                    const rolesEnabled = targets.roles && configuredRoles.length > 0 && (
                        hasExplicitRecipientTargets
                            ? recipientTargets.roles === true
                            : recipientConfig.type === 'roles' || Boolean(notifSetting.recipient_roles?.length)
                    )

                    if (rolesEnabled && resolvedRoleCodes.length > 0) {
                        const { data: roleUsers } = await supabase
                            .from('users')
                            .select('phone, email')
                            .eq('organization_id', org_id)
                            .in('role_code', resolvedRoleCodes)
                            .eq('is_active', true)

                        if (roleUsers) {
                            addRecipients(roleUsers.map((user) => channel === 'email' ? user.email : user.phone))
                        }
                    }

                    if (notifSetting.recipient_custom?.length) {
                        addRecipients(notifSetting.recipient_custom)
                    }

                    if (channel === 'email') {
                        addRecipients(splitConfiguredRecipients(recipientConfig.custom_emails))
                        if (Array.isArray(recipientConfig.manual_email_addresses)) {
                            const { normalizeAndDedupeManualEmails } = await import('@/lib/notifications/manualEmailAddresses')
                            addRecipients(normalizeAndDedupeManualEmails(recipientConfig.manual_email_addresses))
                        }
                    } else {
                        addRecipients(splitConfiguredRecipients(recipientConfig.custom_phones))
                    }

                    if (channel === 'sms' && targets.consumer) {
                        addRecipients([
                            payload.customer_phone,
                            payload.contact_phone,
                            payload.phone,
                            payload.phone_number,
                        ])
                    }

                    if (channel === 'whatsapp' && Array.isArray(recipientConfig.manual_whatsapp_numbers)) {
                        const { normalizeAndDedupeManualPhones } = await import('@/lib/notifications/manualPhoneNumbers')
                        const cleaned = normalizeAndDedupeManualPhones(recipientConfig.manual_whatsapp_numbers)
                        addRecipients(cleaned)
                    }

                    if (recipientPhone) addRecipients([recipientPhone])
                    if (recipientEmail) addRecipients([recipientEmail])

                    const recipientList = Array.from(recipients)

                    if (recipientList.length > 0) {
                        if (channel === 'email') {
                            recipientEmail = recipientList[0]
                            recipientPhone = null
                        } else {
                            recipientPhone = recipientList[0]
                        }

                        // Only an origin row may fan out, and only to recipients that do not
                        // already have a row for this order. Both guards are required: the marker
                        // stops new children from re-expanding, and the sibling lookup stops rows
                        // queued before this fix from expanding again.
                        const siblingScope = fanoutScope(payload)
                        let existingSiblings: { to_phone?: string | null; to_email?: string | null }[] = []

                        if (!isFanoutChild(payload) && siblingScope) {
                            const { data: siblingRows } = await supabase
                                .from('notifications_outbox')
                                .select('to_phone, to_email')
                                .eq('org_id', org_id)
                                .eq('event_code', event_code)
                                .eq('channel', channel)
                                .contains('payload_json', siblingScope)
                            existingSiblings = siblingRows || []
                        }

                        const fanoutTargets = selectFanoutRecipients({
                            recipientList,
                            channel,
                            payload,
                            existingSiblings,
                        })

                        for (const target of fanoutTargets) {
                            await supabase.from('notifications_outbox').insert({
                                org_id,
                                event_code,
                                channel,
                                to_phone: channel !== 'email' ? target : null,
                                to_email: channel === 'email' ? target : null,
                                template_code,
                                payload_json: fanoutChildPayload(payload),
                                priority: 'normal',
                                provider_name,
                                status: 'queued',
                                retry_count: 0,
                                max_retries: 3,
                                created_at: new Date().toISOString()
                            })
                        }
                    }
                }

                if (channel === 'sms' && !recipientPhone && targets.consumer) {
                    recipientPhone = payloadPhone(payload)
                }

                if ((recipientPhone || recipientEmail) && (recipientPhone !== to_phone || recipientEmail !== to_email)) {
                    const recipientUpdate: Record<string, string | null> = {}

                    if (recipientPhone !== to_phone) {
                        recipientUpdate.to_phone = recipientPhone || null
                    }
                    if (recipientEmail !== to_email) {
                        recipientUpdate.to_email = recipientEmail || null
                    }

                    if (Object.keys(recipientUpdate).length > 0) {
                        const { error: recipientUpdateError } = await supabase
                            .from('notifications_outbox')
                            .update(recipientUpdate)
                            .eq('id', id)

                        if (recipientUpdateError) {
                            console.warn(`[NotifWorker] Failed to persist resolved recipient for ${id}: ${recipientUpdateError.message}`)
                        }
                    }
                }

                const duplicateScope = fanoutScope(payload)
                if (duplicateScope && (recipientPhone || recipientEmail)) {
                    const { data: siblings } = await supabase
                        .from('notifications_outbox')
                        .select('id, to_phone, to_email, status')
                        .eq('org_id', org_id)
                        .eq('event_code', event_code)
                        .eq('channel', channel)
                        .contains('payload_json', duplicateScope)
                        .in('status', ['queued', 'processing', 'sent', 'delivered', 'failed'])
                    const phoneKey = notificationPhoneKey(recipientPhone)
                    const emailKey = String(recipientEmail || '').trim().toLowerCase()
                    const duplicate = (siblings || []).some((row: { id: string; to_phone?: string | null; to_email?: string | null }) => {
                        if (String(row.id) === String(id)) return false
                        if (phoneKey && notificationPhoneKey(row.to_phone) === phoneKey) return true
                        if (emailKey && String(row.to_email || '').trim().toLowerCase() === emailKey) return true
                        return false
                    })
                    if (duplicate) {
                        await supabase.from('notifications_outbox').update({
                            status: 'cancelled',
                            error: 'Duplicate notification for this recipient',
                        }).eq('id', id)
                        continue
                    }
                }

                // If still no recipient, mark as failed
                if (!recipientPhone && !recipientEmail) {
                    const fallbackPayload = payload_json && typeof payload_json === 'object' && !Array.isArray(payload_json)
                        ? payload_json as Record<string, any>
                        : {}
                    const isFallbackEmail = channel === 'email' && Boolean(fallbackPayload._routing_fallback || fallbackPayload._routing_fallback_for)
                    await supabase.rpc('log_notification_attempt', {
                        p_outbox_id: id,
                        p_status: 'failed',
                        p_error_message: isFallbackEmail
                            ? 'Fallback Email required, but the recipient has no email address. Ask the admin or user to update the email first.'
                            : channel === 'sms'
                                ? 'No SMS recipient found. Add a phone on the order customer, or in Notification Types → Details → custom phones.'
                                : 'No recipient found — check notification settings recipients'
                    })
                    if (channel === 'whatsapp' || channel === 'sms') {
                        await maybeQueueFallback(
                            supabase,
                            item,
                            channel,
                            null,
                            `${channel}_no_recipient`,
                            { outboxStatus: 'failed' },
                        )
                    }
                    failed++
                    continue
                }

                // 5. Send via the appropriate channel
                if (channel === 'whatsapp' && recipientPhone) {
                    const config = await getWhatsAppConfig(supabase, org_id)

                    if (!config) {
                        await supabase.rpc('log_notification_attempt', {
                            p_outbox_id: id,
                            p_status: 'failed',
                            p_error_message: 'No default WhatsApp provider configured for this organization'
                        })
                        await maybeQueueFallback(
                            supabase,
                            item,
                            'whatsapp',
                            recipientPhone,
                            'whatsapp_unavailable',
                            { providerMissing: true },
                        )
                        await supabase.from('notifications_outbox').update({ status: 'cancelled' }).eq('id', id)
                        failed++
                        continue
                    }

                    try {
                        const sentResult = await sendWhatsAppMessage(supabase, org_id, { to: recipientPhone, text: messageBody })
                        const gwResult = sentResult.response

                        if (gwResult.ok || gwResult.success || gwResult.jid || gwResult.messageId) {
                            await supabase.rpc('log_notification_attempt', {
                                p_outbox_id: id,
                                p_status: 'sent',
                                p_provider_message_id: gwResult.jid || gwResult.messageId || null,
                                p_provider_response: gwResult
                            })
                            sent++
                        } else {
                            await supabase.rpc('log_notification_attempt', {
                                p_outbox_id: id,
                                p_status: 'failed',
                                p_error_message: gwResult.error || 'Gateway returned error',
                                p_provider_response: gwResult
                            })
                            await maybeQueueFallback(
                                supabase,
                                item,
                                'whatsapp',
                                recipientPhone,
                                'whatsapp_delivery_failed',
                                { outboxStatus: await outboxStatusAfterAttempt(supabase, id) },
                            )
                            failed++
                        }
                    } catch (gwError: any) {
                        await supabase.rpc('log_notification_attempt', {
                            p_outbox_id: id,
                            p_status: 'failed',
                            p_error_message: gwError.message || 'Gateway request failed'
                        })
                        await maybeQueueFallback(
                            supabase,
                            item,
                            'whatsapp',
                            recipientPhone,
                            'whatsapp_delivery_failed',
                            { outboxStatus: await outboxStatusAfterAttempt(supabase, id) },
                        )
                        failed++
                    }
                } else if (channel === 'sms') {
                    if (!recipientPhone) {
                        await recordSmsDelivery(supabase, {
                            orgId: org_id,
                            outboxId: id,
                            to: '',
                            eventCode: event_code,
                            result: { success: false, error: 'No phone number found for SMS delivery' },
                        })
                        await maybeQueueFallback(
                            supabase,
                            item,
                            'sms',
                            null,
                            'sms_no_recipient',
                            { outboxStatus: 'failed' },
                        )
                        failed++
                        continue
                    }

                    if (!editedSmsBody && messageBody) {
                        await supabase.from('notifications_outbox').update({
                            payload_json: { ...payload, _sms_body: messageBody },
                        }).eq('id', id)
                    }

                    const smsResult = await sendSmsWithActiveProvider(
                        supabase,
                        org_id,
                        recipientPhone,
                        messageBody
                    )
                    await recordSmsDelivery(supabase, {
                        orgId: org_id,
                        outboxId: id,
                        to: recipientPhone,
                        eventCode: event_code,
                        result: smsResult,
                    })
                    if (smsResult.success) {
                        sent++
                    } else {
                        await maybeQueueFallback(
                            supabase,
                            item,
                            'sms',
                            recipientPhone,
                            smsResult.error === 'SMS provider not configured' ? 'sms_unavailable' : 'sms_delivery_failed',
                            { providerMissing: smsResult.error === 'SMS provider not configured', outboxStatus: 'failed' },
                        )
                        failed++
                    }
                } else if (channel === 'email') {
                    const emailSubject = String(event_code).startsWith('tiktok_shop_daily_report') && payload.email_subject
                        ? String(payload.email_subject)
                        : event_code === 'roadtour_qr_delivery'
                        ? `RoadTour QR — ${String(payload.campaign_name || 'Campaign')}`
                        : String(event_code).startsWith('return_')
                            ? `Product Return ${String(payload.return_no || '')} — ${String(payload.return_status || 'Update')}`.trim()
                            : `Serapod2U notification: ${String(event_code).replace(/_/g, ' ')}`
                    const emailResult = await sendEmailWithActiveProvider(
                        supabase,
                        org_id,
                        recipientEmail!,
                        emailSubject,
                        messageBody
                    )
                    await supabase.rpc('log_notification_attempt', emailResult.success ? {
                        p_outbox_id: id,
                        p_status: 'sent',
                        p_provider_message_id: 'messageId' in emailResult ? emailResult.messageId || null : null,
                        p_provider_response: { provider: provider_name },
                    } : {
                        p_outbox_id: id,
                        p_status: 'failed',
                        p_error_message: emailResult.error || 'Email delivery failed',
                    })
                    if (emailResult.success) sent++
                    else failed++
                } else {
                    await supabase.rpc('log_notification_attempt', {
                        p_outbox_id: id,
                        p_status: 'failed',
                        p_error_message: `Unsupported channel: ${channel} or missing recipient`
                    })
                    failed++
                }

            } catch (itemError: any) {
                console.error(`[NotifWorker] Error processing item ${item.id}:`, itemError)
                try {
                    await supabase.rpc('log_notification_attempt', {
                        p_outbox_id: item.id,
                        p_status: 'failed',
                        p_error_message: itemError.message || 'Processing error'
                    })
                } catch { }
                failed++
            }
        }

        const elapsed = Date.now() - startTime
        console.log(`[NotifWorker] Done: ${sent} sent, ${failed} failed in ${elapsed}ms`)

        return NextResponse.json({
            processed: pendingItems.length,
            sent,
            failed,
            elapsed_ms: elapsed
        })

    } catch (error: any) {
        console.error('[NotifWorker] Fatal error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
