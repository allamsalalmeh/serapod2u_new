import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { asJsonObject } from '@/lib/supabase/json'

export async function POST(request: Request) {
    const supabase = await createClient()
    const body = await request.json()
    const { campaignId, journeyConfigId, consumerPhone, qrCodeId, qrCode } = body

    if ((!campaignId && !journeyConfigId) || !consumerPhone) {
        return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    let resolvedQrCodeId = qrCodeId

    // Resolve QR Code string to ID if needed
    if (!resolvedQrCodeId && qrCode) {
        // Resolve the id server-side: anonymous/consumer sessions cannot read qr_codes.
        const { data: qrData } = await createAdminClient()
            .from('qr_codes')
            .select('id')
            .eq('code', qrCode)
            .single()
        
        if (qrData) {
            resolvedQrCodeId = qrData.id
        }
    }

    try {
        const { data, error } = await supabase.rpc('play_scratch_card_turn', {
            p_campaign_id: campaignId || null,
            p_journey_config_id: journeyConfigId || null,
            p_consumer_phone: consumerPhone,
            p_qr_code_id: resolvedQrCodeId || null
        })

        if (error) {
            console.error('RPC Error:', error)
            return NextResponse.json({ error: error.message }, { status: 500 })
        }

        // Every return path of play_scratch_card_turn is a jsonb_build_object.
        const result = asJsonObject(data)
        if (result.error) {
            return NextResponse.json({ error: result.error, code: result.code }, { status: 400 })
        }

        return NextResponse.json(data)

    } catch (e) {
        console.error('Unexpected Error:', e)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}
