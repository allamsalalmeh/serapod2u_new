import { guardUserOperation } from '@/lib/security-access/operation'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import ExcelJS from 'exceljs'
import { format } from 'date-fns'
import {
  buildNegeriReport,
  type NegeriScanRow,
  type NegeriOrgRow,
  type NegeriStateRow,
} from '@/lib/reporting/shop-by-negeri'
import {
  buildCanonicalStates,
  resolveCanonicalStateSelection,
} from '@/lib/reporting/canonical-state'
import {
  previousReportingPeriod,
  reportingPeriodDateWindow,
  reportingPeriodFilenameLabel,
  reportingPeriodFromKey,
  reportingPeriodRangeLabel,
} from '@/lib/reporting/reporting-period'
import { fetchAccessibleReportingPeriods } from '@/lib/reporting/reporting-period-source'
import { currentReportingMonthKey } from '@/lib/reporting/consumer-analytics'
import { readShopScans } from '@/lib/reporting/shop-performance'

export const dynamic = 'force-dynamic'

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1E40AF' },
}

function styleHeader(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL
    cell.font = { color: { argb: 'FFFFFFFF' }, bold: true }
    cell.alignment = { vertical: 'middle' }
  })
}

function fmtGrowth(value: number | null): string {
  if (value === null) return 'N/A'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const periodKey = searchParams.get('period') || ''
    const region = searchParams.get('region') || 'all'
    const negeri = searchParams.get('negeri') || 'all'
    const search = searchParams.get('search') || ''

    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'reporting.analytics.view')
    if (saDenied) return saDenied

    const selectedPeriod = reportingPeriodFromKey(periodKey)
    if (!selectedPeriod) {
      return NextResponse.json({ error: 'Invalid reporting month' }, { status: 400 })
    }

    // Validate against the same supported range the selector offers: every
    // month from the earliest accessible scan month to the current month. A
    // month inside it without scans is a valid, empty report.
    const availablePeriods = await fetchAccessibleReportingPeriods(supabase)
    const currentMonth = currentReportingMonthKey()
    const earliestMonth = availablePeriods.reduce((min, period) => (period.key < min ? period.key : min), currentMonth)
    if (periodKey < earliestMonth || periodKey > currentMonth) {
      return NextResponse.json({ error: 'Reporting month is not available' }, { status: 400 })
    }

    // Reference data
    const [{ data: stateData }, { data: regionData }] = await Promise.all([
      supabase.from('states').select('id, state_name, region_id').order('state_name'),
      supabase.from('regions').select('id, region_name').order('region_name'),
    ])
    const states = (stateData as NegeriStateRow[]) || []
    const regions = (regionData as { id: string; region_name: string }[]) || []

    const previousPeriod = previousReportingPeriod(selectedPeriod)
    let scans: NegeriScanRow[]
    try {
      scans = (await readShopScans(supabase, previousPeriod.startUtc, selectedPeriod.endUtc)) as unknown as NegeriScanRow[]
    } catch (scanErr: any) {
      return NextResponse.json({ error: scanErr?.message || 'Unable to read shop scans' }, { status: 500 })
    }

    // Organizations for referenced shops
    const shopIds = [...new Set(scans.map((s) => s.shop_id).filter(Boolean))] as string[]
    const orgs: NegeriOrgRow[] = []
    const batchSize = 200
    for (let i = 0; i < shopIds.length; i += batchSize) {
      const batch = shopIds.slice(i, i + batchSize)
      const { data: orgData } = await supabase
        .from('organizations')
        .select('id, org_name, branch, state_id, contact_name, contact_phone')
        .in('id', batch)
      if (orgData) orgs.push(...(orgData as NegeriOrgRow[]))
    }

    const dateWindow = reportingPeriodDateWindow(selectedPeriod)
    const report = buildNegeriReport({
      scans,
      orgs,
      states,
      regionId: region,
      negeriId: negeri,
      search,
      window: dateWindow,
      topShopsPerState: 10,
    })

    const rangeLabel = reportingPeriodRangeLabel(selectedPeriod)
    const regionName = region === 'all' ? 'All Regions' : (regions.find((r) => r.id === region)?.region_name || region)
    // The `negeri` parameter is a canonical Negeri key (a raw states.id from an
    // older link still resolves), so the export covers every duplicate state row
    // behind that logical state — exactly like the browser report.
    const canonicalStates = buildCanonicalStates(states)
    const selectedNegeriKey = resolveCanonicalStateSelection(negeri, states)
    const negeriName = !selectedNegeriKey
      ? 'All States'
      : (canonicalStates.find((s) => s.key === selectedNegeriKey)?.name || selectedNegeriKey)

    // ── Build workbook ────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook()
    wb.creator = 'Serapod2U Reporting'
    wb.created = new Date()

    // 1) Summary
    const summary = wb.addWorksheet('Summary')
    summary.columns = [
      { header: 'Metric', key: 'metric', width: 28 },
      { header: 'Value', key: 'value', width: 36 },
    ]
    styleHeader(summary.getRow(1))
    summary.addRows([
      { metric: 'Report', value: 'Shop by Negeri' },
      { metric: 'Reporting Month', value: selectedPeriod.label },
      { metric: 'Reporting Period', value: rangeLabel },
      { metric: 'Region Type', value: regionName },
      { metric: 'Negeri / State', value: negeriName },
      { metric: 'Search Keyword', value: search || '—' },
      { metric: 'Total States Active', value: `${report.kpis.totalStatesActive} / ${report.kpis.totalStates}` },
      { metric: 'Total Shops', value: report.kpis.totalShops },
      { metric: 'Total Scans', value: report.kpis.totalScans },
      { metric: 'Total Consumers', value: report.kpis.totalConsumers },
      { metric: 'Avg Scans / Shop', value: Number(report.kpis.avgScansPerShop.toFixed(2)) },
      { metric: 'Top Performing Negeri', value: `${report.kpis.topNegeri} (${report.kpis.topNegeriScans} scans)` },
      { metric: 'Generated At', value: format(new Date(), 'yyyy-MM-dd HH:mm:ss') },
    ])

    // 2) State Ranking
    const rankSheet = wb.addWorksheet('State Ranking')
    rankSheet.columns = [
      { header: 'Rank', key: 'rank', width: 8 },
      { header: 'Negeri', key: 'negeri', width: 24 },
      { header: 'Shops', key: 'shops', width: 12 },
      { header: 'Total Scans', key: 'scans', width: 14 },
      { header: 'Consumers', key: 'consumers', width: 14 },
      { header: 'Avg Scans / Shop', key: 'avg', width: 18 },
      { header: 'Growth', key: 'growth', width: 12 },
    ]
    styleHeader(rankSheet.getRow(1))
    if (report.ranking.length === 0) {
      rankSheet.addRow({ negeri: 'No data for selected filters' })
    } else {
      report.ranking.forEach((r) => rankSheet.addRow({
        rank: r.rank,
        negeri: r.negeri,
        shops: r.shops,
        scans: r.scans,
        consumers: r.consumers,
        avg: Number(r.avgPerShop.toFixed(2)),
        growth: fmtGrowth(r.growth),
      }))
    }

    // 3) Top Shops by Negeri
    const shopSheet = wb.addWorksheet('Top Shops by Negeri')
    shopSheet.columns = [
      { header: 'Negeri', key: 'negeri', width: 24 },
      { header: 'Shop Name', key: 'shop', width: 36 },
      { header: 'Contact / Phone', key: 'phone', width: 20 },
      { header: 'Total Scans', key: 'scans', width: 14 },
      { header: 'Consumers', key: 'consumers', width: 14 },
      { header: 'Avg Scans / Consumer', key: 'avg', width: 20 },
      { header: 'Growth', key: 'growth', width: 12 },
    ]
    styleHeader(shopSheet.getRow(1))
    if (report.topShops.length === 0) {
      shopSheet.addRow({ negeri: 'No data for selected filters' })
    } else {
      report.topShops.forEach((s) => shopSheet.addRow({
        negeri: s.negeri,
        shop: s.shopName,
        phone: s.contactPhone,
        scans: s.scans,
        consumers: s.consumers,
        avg: Number(s.avgPerShop.toFixed(2)),
        growth: fmtGrowth(s.growth),
      }))
    }

    // 4) Monthly Trend (per negeri)
    const trendSheet = wb.addWorksheet('Monthly Trend')
    trendSheet.columns = [
      { header: 'Month', key: 'month', width: 14 },
      { header: 'Negeri', key: 'negeri', width: 24 },
      { header: 'Total Scans', key: 'scans', width: 14 },
      { header: 'Active Shops', key: 'shops', width: 14 },
      { header: 'Consumers', key: 'consumers', width: 14 },
    ]
    styleHeader(trendSheet.getRow(1))
    if (report.monthlyByState.length === 0) {
      trendSheet.addRow({ month: 'No data for selected filters' })
    } else {
      report.monthlyByState.forEach((m) => trendSheet.addRow({
        month: m.monthLabel,
        negeri: m.negeri,
        scans: m.scans,
        shops: m.shops,
        consumers: m.consumers,
      }))
    }

    const buffer = await wb.xlsx.writeBuffer()
    const filename = `Shop_by_Negeri_${reportingPeriodFilenameLabel(selectedPeriod)}.xlsx`

    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Export failed' }, { status: 500 })
  }
}
