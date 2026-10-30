/**
 * Fills the order creator's name/phone/email into an event payload when the
 * producer did not include them (QR, production, receiving and document events
 * only carry the order). Shared by the outbox worker and the recipient preview
 * so both see the same "Order creator" address.
 */
export async function ensureOrderOwnerContact(supabase: any, payload: Record<string, any>) {
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
