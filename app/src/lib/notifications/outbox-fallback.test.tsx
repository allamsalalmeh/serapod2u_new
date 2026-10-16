import { describe, expect, it } from 'vitest'
import { queueRoutingFallback } from './outbox-fallback'

function makeSupabase(input: {
    preset: string
    providers: Array<{ channel: string; provider_name: string }>
    existing?: Array<{ id: string; to_phone?: string }>
    userEmail?: string | null
    insertError?: string | null
}) {
    const inserted: any[] = []
    const from = (table: string) => {
        const builder: any = {
            select: () => builder,
            eq: () => builder,
            in: () => builder,
            contains: () => builder,
            order: () => builder,
            limit: () => builder,
            maybeSingle: async () => {
                if (table === 'notification_settings') {
                    return { data: { recipient_config: { routing: { preset: input.preset } } } }
                }
                if (table === 'users') {
                    return { data: input.userEmail ? { email: input.userEmail } : null }
                }
                return { data: null }
            },
            then: (resolve: any) => {
                if (table === 'notification_provider_configs') {
                    return resolve({ data: input.providers, error: null })
                }
                if (table === 'notifications_outbox') {
                    return resolve({ data: input.existing || [], error: null })
                }
                return resolve({ data: [], error: null })
            },
            insert: async (row: any) => {
                inserted.push(row)
                return { error: input.insertError ? { message: input.insertError } : null }
            },
        }
        return builder
    }
    return { supabase: { from } as any, inserted }
}

const item = {
    id: 'wa-1',
    org_id: 'org-1',
    event_code: 'order_submitted',
    template_code: null,
    payload_json: { order_no: 'SO-1' },
    priority: 'normal',
    to_phone: '60123456789',
}

describe('queueRoutingFallback', () => {
    it('queues SMS after WhatsApp fails for WhatsApp → SMS → Email', async () => {
        const { supabase, inserted } = makeSupabase({
            preset: 'whatsapp_sms_email_fallback',
            providers: [
                { channel: 'sms', provider_name: 'local_my' },
                { channel: 'email', provider_name: 'gmail' },
            ],
        })
        const queued = await queueRoutingFallback(supabase, item, 'whatsapp', '60123456789', 'whatsapp_delivery_failed')
        expect(queued).toBe(true)
        expect(inserted).toHaveLength(1)
        expect(inserted[0]).toMatchObject({
            channel: 'sms',
            to_phone: '60123456789',
            status: 'queued',
            payload_json: expect.objectContaining({
                _routing_fallback_for: 'wa-1',
                _routing_fallback_channel: 'sms',
            }),
        })
    })

    it('queues Email after SMS fails', async () => {
        const { supabase, inserted } = makeSupabase({
            preset: 'whatsapp_sms_email_fallback',
            providers: [{ channel: 'email', provider_name: 'gmail' }],
            userEmail: 'buyer@shop.test',
        })
        const queued = await queueRoutingFallback(
            supabase,
            { ...item, id: 'sms-1', to_phone: '60123456789' },
            'sms',
            '60123456789',
            'sms_delivery_failed',
        )
        expect(queued).toBe(true)
        expect(inserted[0]).toMatchObject({
            channel: 'email',
            to_email: 'buyer@shop.test',
            to_phone: null,
        })
    })

    it('skips SMS and queues Email when SMS provider is missing', async () => {
        const { supabase, inserted } = makeSupabase({
            preset: 'whatsapp_sms_email_fallback',
            providers: [{ channel: 'email', provider_name: 'gmail' }],
            userEmail: 'buyer@shop.test',
        })
        await queueRoutingFallback(supabase, item, 'whatsapp', '60123456789', 'whatsapp_unavailable')
        expect(inserted[0].channel).toBe('email')
    })

    it('does not queue SMS for WhatsApp → Email', async () => {
        const { supabase, inserted } = makeSupabase({
            preset: 'whatsapp_email_fallback',
            providers: [
                { channel: 'sms', provider_name: 'local_my' },
                { channel: 'email', provider_name: 'gmail' },
            ],
            userEmail: 'buyer@shop.test',
        })
        await queueRoutingFallback(supabase, item, 'whatsapp', '60123456789', 'whatsapp_delivery_failed')
        expect(inserted[0].channel).toBe('email')
    })

    it('sends order_rejected SMS fallback to the order owner only', async () => {
        const { supabase, inserted } = makeSupabase({
            preset: 'whatsapp_sms_email_fallback',
            providers: [{ channel: 'sms', provider_name: 'local_my' }],
        })
        await queueRoutingFallback(
            supabase,
            {
                ...item,
                event_code: 'order_rejected',
                to_phone: '60111111111',
                payload_json: { order_no: 'SO-9', created_by_phone: '60192277233' },
            },
            'whatsapp',
            '60111111111',
            'whatsapp_delivery_failed',
        )
        expect(inserted).toHaveLength(1)
        expect(inserted[0]).toMatchObject({
            channel: 'sms',
            to_phone: '60192277233',
        })
    })

    it('does not queue a second SMS fallback to the same phone for one order', async () => {
        const { supabase, inserted } = makeSupabase({
            preset: 'whatsapp_sms_email_fallback',
            providers: [{ channel: 'sms', provider_name: 'local_my' }],
            existing: [{ id: 'sms-already', to_phone: '+60123456789' }],
        })
        await queueRoutingFallback(supabase, item, 'whatsapp', '60123456789', 'whatsapp_delivery_failed')
        expect(inserted).toHaveLength(0)
    })
})
