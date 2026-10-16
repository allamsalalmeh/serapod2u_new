import { NextResponse } from 'next/server'
import { loadMarketplaceContext } from '@/lib/marketplace/access'
import { REPORT_KINDS, REPORT_PERIODS, mytDay, type ReportKind, type ReportPeriod } from '@/lib/marketplace/tiktok-reports'
import { loadTikTokReport } from '@/lib/marketplace/tiktok-reports-server'
import { buildTikTokReportWorkbook } from '@/lib/marketplace/tiktok-reports-excel'

/**
 * GET /api/ecommerce/tiktok-shop/reports?shop_id=<id|all>&report=sales|settlement|shipping&period=day|week|month&date=YYYY-MM-DD&format=json|xlsx
 * Sales, settlement (gross → fees → net → bank) and shipping reports for one TikTok shop or all of them.
 */
export async function GET(request: Request) {
  try {
    const ctx = await loadMarketplaceContext()
    if (ctx.error) return ctx.error
    const { db, orgId } = ctx

    const { searchParams } = new URL(request.url)
    const kind = (REPORT_KINDS as string[]).includes(searchParams.get('report') || '') ? searchParams.get('report') as ReportKind : 'sales'
    const period = (REPORT_PERIODS as string[]).includes(searchParams.get('period') || '') ? searchParams.get('period') as ReportPeriod : 'day'
    const today = mytDay(Date.now())
    const date = searchParams.get('date') || today
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
    }
    if (date > today) return NextResponse.json({ error: 'The date cannot be in the future' }, { status: 400 })

    const shopParam = searchParams.get('shop_id') || ''
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

    const report = await loadTikTokReport(db, { companyId: orgId, shopIds, kind, period, date })

    if (searchParams.get('format') === 'xlsx') {
      const scope = shopParam === 'all' ? 'all-shops' : report.shops[0]?.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() || 'shop'
      const span = period === 'month' ? report.range.start.slice(0, 7) : period === 'week' ? `week-${report.range.start}` : report.range.start
      const buffer = await buildTikTokReportWorkbook(report)
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="tiktok-${kind}-${span}-${scope}.xlsx"`,
          'Cache-Control': 'no-store',
        },
      })
    }
    return NextResponse.json({ report }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('Error in TikTok reports API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
