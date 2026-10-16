import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getWhatsAppConfig, sendWhatsAppMessage } from '@/app/api/settings/whatsapp/_utils'
import { sendSmsWithActiveProvider } from '@/lib/notifications/sms-send'

// Helper to replace variables
function applyTemplate(template: string, variables: any) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || `{{${key}}}`)
}

export async function POST(request: NextRequest) {
    const supabase = await createClient()

    try {
        // Auth check
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const saDenied = await guardUserOperation(user.id, 'platform.settings.manage')
        if (saDenied) return saDenied

        // Get user org
        const { data: userProfile } = await supabase
            .from('users')
            .select('organization_id')
            .eq('id', user.id)
            .single()

        if (!userProfile?.organization_id) {
            return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
        }

        const body = await request.json()
        const {
            eventCode,
            channel,
            recipient, // { phone, email, full_name }
            template,
            sampleData  // { order_no, amount, customer_name, ... }
        } = body

        // Email has no test sender here. Say so instead of reporting a send
        // that never happened, and record nothing.
        if (channel === 'email') {
            return NextResponse.json({
                success: false,
                status: 'unsupported',
                error: 'Email test sending is not available. No email was sent.',
            }, { status: 501 })
        }
        if (channel !== 'whatsapp' && channel !== 'sms') {
            return NextResponse.json({ success: false, status: 'error', error: 'Unknown channel' }, { status: 400 })
        }

        // Prepare message body with variable substitution
        const messageBody = applyTemplate(template || '', sampleData || {})

        if (!messageBody.trim()) {
            return NextResponse.json({ error: 'No template content. Please set a template first.' }, { status: 400 })
        }

        let result: any = { status: 'failed' }
        let resolvedProviderName: string | undefined

        if (channel === 'whatsapp') {
            // Use the same working utility as /api/settings/whatsapp/test
            const config = await getWhatsAppConfig(supabase, userProfile.organization_id)

            if (!config) {
                return NextResponse.json({ error: 'No default WhatsApp provider is configured. Go to Providers and set one as default.' }, { status: 400 })
            }
            resolvedProviderName = config.providerName

            const phoneNumber = recipient?.phone || recipient?.phone_number
            if (!phoneNumber) {
                return NextResponse.json({ error: 'Recipient has no phone number' }, { status: 400 })
            }

            try {
                const sent = await sendWhatsAppMessage(supabase, userProfile.organization_id, { to: phoneNumber, text: messageBody })
                const gwResult = sent.response

                if (gwResult.ok || gwResult.success || gwResult.jid) {
                    result = { status: 'sent', provider_id: gwResult.jid || gwResult.messageId || 'sent', message: 'WhatsApp message sent successfully' }
                } else {
                    result = { status: 'failed', error: gwResult.error || gwResult.message || 'Gateway returned error' }
                }
            } catch (err: any) {
                result = { status: 'failed', error: err.message || 'Failed to reach WhatsApp gateway' }
            }
        } else if (channel === 'sms') {
            const phoneNumber = recipient?.phone || recipient?.phone_number
            if (!phoneNumber) {
                return NextResponse.json({ error: 'Recipient has no phone number' }, { status: 400 })
            }

            const sent = await sendSmsWithActiveProvider(
                supabase,
                userProfile.organization_id,
                phoneNumber,
                messageBody
            )
            resolvedProviderName = 'local_my'
            if (sent.success) {
                result = { status: 'sent', provider_id: sent.messageId || 'sent', message: 'SMS sent via Local Malaysian Provider' }
            } else {
                result = { status: 'failed', error: sent.error || 'SMS gateway returned error' }
            }
        }

        // Log the test send
        try {
            await supabase.from('notification_logs').insert({
                org_id: userProfile.organization_id,
                event_code: eventCode || 'test',
                channel: channel,
                recipient_value: recipient?.phone || recipient?.phone_number,
                recipient_type: 'phone',
                status: result.status,
                provider_name: resolvedProviderName || channel,
                provider_message_id: result.provider_id || null,
                sent_at: result.status === 'sent' ? new Date().toISOString() : null,
                failed_at: result.status === 'failed' ? new Date().toISOString() : null,
                provider_response: result,
                queued_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
            })
        } catch (logErr) {
            console.error('Failed to log test send:', logErr)
        }

        const success = result.status === 'sent'
        return NextResponse.json({ success, result, error: success ? undefined : result.error })

    } catch (error: any) {
        console.error('Test send error:', error)
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}
