import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { normalizePointClaimSettings } from '@/lib/engagement/point-claim-settings'
import { asJsonObject } from '@/lib/supabase/json'

/**
 * Get QR code statistics for a journey (order)
 * GET /api/journey/qr-stats?order_id=xxx
 * 
 * Returns:
 * - total_valid_links: Total QR codes generated for this order
 * - links_scanned: QR codes that have been scanned
 * - lucky_draw_entries: Number of lucky draw entries from this order's QR codes
 * - redemptions: Number of redemptions from this order's QR codes
 * - points_collected: Total points collected from scans
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user: saUser } } = await supabase.auth.getUser()
    if (!saUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const saDenied = await guardUserOperation(saUser.id, 'customer.campaign.manage')
    if (saDenied) return saDenied
    const searchParams = request.nextUrl.searchParams
    const orderId = searchParams.get('order_id')

    if (!orderId) {
      return NextResponse.json(
        { success: false, error: 'Order ID is required' },
        { status: 400 }
      )
    }

    const { data: orderRow } = await supabase
      .from('orders')
      .select('company_id')
      .eq('id', orderId)
      .maybeSingle()

    let claimMode: 'single_shop' | 'dual' = 'single_shop'
    if (orderRow?.company_id) {
      const { data: orgRow } = await supabase
        .from('organizations')
        .select('settings')
        .eq('id', orderRow.company_id)
        .maybeSingle()

      claimMode = normalizePointClaimSettings(orgRow?.settings, 100).claimMode
    }

    // Get the batch for this order
    const { data: batches, error: batchError } = await supabase
      .from('qr_batches')
      .select('id, total_unique_codes')
      .eq('order_id', orderId)

    if (batchError) {
      console.error('Error fetching batches:', batchError)
      return NextResponse.json(
        { success: false, error: 'Failed to fetch batch data' },
        { status: 500 }
      )
    }

    if (!batches || batches.length === 0) {
      // No batch yet - return zeros
      return NextResponse.json({
        success: true,
        data: {
          total_valid_links: 0,
          links_scanned: 0,
          claim_mode: claimMode,
          shop_links_scanned: 0,
          consumer_links_scanned: 0,
          lucky_draw_entries: 0,
          redemptions: 0,
          points_collected: 0,
          scratch_card_plays: 0,
          failed_scans: 0,
          last_scan_at: null
        }
      })
    }

    const batchIds = batches.map(b => b.id)

    console.log(`🔍 Looking for QR codes in batches:`, batchIds)

    // Get ALL QR codes for this order by order_id (most reliable method)
    // Valid Links = All QR codes generated for this order
    const { data: allQrCodes, error: qrError } = await supabase
      .from('qr_codes')
      .select('id, code, master_code_id, order_id')
      .eq('order_id', orderId)

    if (qrError) {
      console.error('❌ Error fetching QR codes:', qrError)
    }

    console.log(`📦 Found ${allQrCodes?.length || 0} QR codes for order`)

    const qrCodeIds = allQrCodes?.map(qr => qr.id) || []
    const totalValidLinks = allQrCodes?.length || 0

    console.log(`✅ Total valid links: ${totalValidLinks}, QR code IDs count: ${qrCodeIds.length}`)

    // Use database function to efficiently get all stats
    // This avoids the "Bad Request" error from large IN clauses with 1000+ QR codes
    const { data: statsData, error: statsError } = await supabase
      .rpc('get_consumer_scan_stats', { p_order_id: orderId })
      .single()

    if (statsError) {
      console.error('❌ Error fetching consumer scan stats:', statsError)
      // Return zeros if function fails
      return NextResponse.json({
        success: true,
        data: {
          total_valid_links: totalValidLinks,
          links_scanned: 0,
          claim_mode: claimMode,
          shop_links_scanned: 0,
          consumer_links_scanned: 0,
          lucky_draw_entries: 0,
          redemptions: 0,
          points_collected: 0,
          scratch_card_plays: 0,
          failed_scans: 0,
          last_scan_at: null
        }
      })
    }

    const stats = asJsonObject(statsData)

    let shopLinksScanned = 0
    let consumerLinksScanned = 0
    try {
      const { data: claimRows, error: claimRowsError } = await supabase
        .from('consumer_qr_scans')
        .select('qr_code_id, claim_lane, qr_codes!inner(order_id)')
        .eq('collected_points', true)
        .eq('qr_codes.order_id', orderId)

      if (claimRowsError) {
        console.error('Error fetching lane scan stats:', claimRowsError)
      } else {
        const shopQrIds = new Set<string>()
        const consumerQrIds = new Set<string>()

        for (const row of claimRows || []) {
          const qrCodeId = (row as any).qr_code_id as string | null
          if (!qrCodeId) continue
          const lane = (row as any).claim_lane as string | null
          if (lane === 'consumer') {
            consumerQrIds.add(qrCodeId)
          } else {
            shopQrIds.add(qrCodeId)
          }
        }

        shopLinksScanned = shopQrIds.size
        consumerLinksScanned = consumerQrIds.size
      }
    } catch (e) {
      console.error('Exception fetching lane scan stats:', e)
    }

    // Fetch scratch card plays count separately since it's not in the RPC yet
    let scratchCardPlaysCount = 0
    try {
      const { count, error: scratchError } = await supabase
        .from('scratch_card_plays')
        .select('id, qr_codes!inner(order_id)', { count: 'exact', head: true })
        .eq('qr_codes.order_id', orderId)

      if (!scratchError) {
        scratchCardPlaysCount = count || 0
      } else {
        console.error('Error fetching scratch card plays:', scratchError)
      }
    } catch (e) {
      console.error('Exception fetching scratch card plays:', e)
    }

    let lastScanAt: string | null = null
    try {
      const { data: lastScan, error: lastScanError } = await supabase
        .from('consumer_qr_scans')
        .select('scanned_at, qr_codes!inner(order_id)')
        .eq('qr_codes.order_id', orderId)
        .order('scanned_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (lastScanError) {
        console.error('Error fetching last scan timestamp:', lastScanError)
      } else {
        lastScanAt = (lastScan as any)?.scanned_at || null
      }
    } catch (e) {
      console.error('Exception fetching last scan timestamp:', e)
    }

    console.log(`📊 Stats for order ${orderId}:`, {
      total_qr_codes: stats.total_qr_codes || 0,
      unique_consumer_scans: stats.unique_consumer_scans || 0,
      points_collected_count: stats.points_collected_count || 0,
      lucky_draw_entries: stats.lucky_draw_entries || 0,
      redemptions: stats.redemptions || 0,
      scratch_card_plays: scratchCardPlaysCount
    })

    return NextResponse.json({
      success: true,
      data: {
        total_valid_links: Number(stats.total_qr_codes || 0),
        links_scanned: Number(stats.unique_consumer_scans || 0),
        claim_mode: claimMode,
        shop_links_scanned: shopLinksScanned,
        consumer_links_scanned: consumerLinksScanned,
        lucky_draw_entries: Number(stats.lucky_draw_entries || 0),
        redemptions: Number(stats.redemptions || 0),
        points_collected: Number(stats.points_collected_count || 0),
        scratch_card_plays: scratchCardPlaysCount,
        failed_scans: 0,
        last_scan_at: lastScanAt
      }
    })

  } catch (error: any) {
    console.error('Error fetching QR statistics:', error)
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
