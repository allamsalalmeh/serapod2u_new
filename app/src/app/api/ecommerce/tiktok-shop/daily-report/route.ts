import { NextResponse } from 'next/server'
import { loadMarketplaceContext } from '@/lib/marketplace/access'
import { mytDayKey, type DailyReportSlot } from '@/lib/marketplace/tiktok-daily-report'
import { loadTikTokDailyReport } from '@/lib/marketplace/tiktok-daily-report-server'
import { buildDailyReportWorkbook } from '@/lib/marketplace/tiktok-daily-report-excel'

/**
 * GET /api/ecommerce/tiktok-shop/daily-report?shop_id=<id|all>&slot=packing|shipped&date=YYYY-MM-DD&format=json|xlsx|txt
 * The daily shipping report (what to pack now, or what shipped on a day) for one shop or all TikTok shops.
 */
export async function GET(request: Request) {
  try {
    const ctx = await loadMarketplaceContext()
    if (ctx.error) return ctx.error
    const { db, orgId } = ctx

    const { searchParams } = new URL(request.url)
    const slot: DailyReportSlot = searchParams.get('slot') === 'shipped' ? 'shipped' : 'packing'
    const format = searchParams.get('format') || 'json'
    const shopParam = searchParams.get('shop_id') || ''
    const date = searchParams.get('date')
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
    const today = mytDayKey(new Date())
    if (date && date > today) return NextResponse.json({ error: 'The date cannot be in the future' }, { status: 400 })

    const { data: shops, error } = await db
      .from('marketplace_shops')
      .select('id')
      .eq('company_id', orgId)
      .eq('platform', 'tiktok_shop')
      .eq('is_active', true)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const shopIds = shopParam === 'all'
      ? (shops || []).map((s: any) => s.id)
      : (shops || []).filter((s: any) => s.id === shopParam).map((s: any) => s.id)
    if (!shopIds.length) return NextResponse.json({ error: 'Shop not found' }, { status: 404 })

    const report = await loadTikTokDailyReport(db, { companyId: orgId, shopIds, slot, day: slot === 'shipped' ? date : null })
    const scope = shopParam === 'all' ? 'all-shops' : report.shops[0]?.shop.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() || 'shop'
    const fileName = `tiktok-${slot === 'packing' ? 'to-pack' : 'shipped'}-${report.day}-${scope}`

    if (format === 'xlsx') {
      const buffer = await buildDailyReportWorkbook(report)
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${fileName}.xlsx"`,
          'Cache-Control': 'no-store',
        },
      })
    }
    if (format === 'txt') {
      return new NextResponse(report.text, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${fileName}.txt"`,
          'Cache-Control': 'no-store',
        },
      })
    }
    return NextResponse.json({ report })
  } catch (error) {
    console.error('Error in TikTok daily report API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
