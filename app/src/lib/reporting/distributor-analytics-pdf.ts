/**
 * Serapod Distributor Performance Report — branded A4 landscape PDF.
 *
 * Built entirely from the `DistributorAnalyticsReport` DTO that renders the web
 * report, so the two can never disagree: there is no second KPI calculation
 * anywhere in this file, only formatting. Every section of the report is
 * exported regardless of which sub-tab the user happens to be looking at.
 *
 * Generated with jsPDF + jspdf-autotable (existing project dependencies),
 * following the layout conventions of `product-analytics-pdf.ts`.
 */

import {
  ACTION_LABEL,
  HEALTH_LABEL,
  distributorReportFilename,
  statusLabel,
  type ActionKey,
  type ComparisonRow,
  type DistributorAnalyticsReport,
  type DistributorRow,
} from './distributor-analytics'

const INK: [number, number, number] = [26, 26, 26]
const MUTED: [number, number, number] = [120, 120, 120]
const ORANGE: [number, number, number] = [232, 93, 4]
const BAND: [number, number, number] = [243, 238, 230]
const BAND_BORDER: [number, number, number] = [226, 219, 205]
const BOX_BORDER: [number, number, number] = [222, 222, 222]
const BOX_FILL: [number, number, number] = [249, 250, 251]
const STRIPE: [number, number, number] = [248, 248, 248]
const POSITIVE: [number, number, number] = [22, 128, 61]
const NEGATIVE: [number, number, number] = [185, 28, 28]

export interface DistributorAnalyticsPdf {
  blob: Blob
  filename: string
  size: number
}

function formatCount(value: number | null): string {
  if (value === null) return '—'
  return Math.round(value).toLocaleString('en-MY')
}

function formatRM(value: number | null): string {
  if (value === null) return '—'
  return `RM ${value.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`
}

/** `null` growth means the comparison window had no baseline — never "0%", never "Infinity%". */
function formatGrowth(value: number | null): string {
  if (value === null) return 'New activity'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function formatPoints(value: number | null): string {
  if (value === null) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}pp`
}

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('en-MY', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Kuala_Lumpur',
  })
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "04 Sep" — the compact last-order form used across the report tables. */
function formatDay(value: string | null): string {
  if (!value) return '—'
  // A business date (YYYY-MM-DD) is a calendar day: format it as-is, never
  // through a UTC-midnight instant. Same rule as the web report.
  const dateKey = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (dateKey) return `${dateKey[3]} ${MONTH_SHORT[Number(dateKey[2]) - 1] ?? ''}`.trim()
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', timeZone: 'Asia/Kuala_Lumpur',
  }).format(date)
}

function comparisonValue(row: ComparisonRow, side: 'current' | 'previous'): string {
  const value = row[side]
  if (row.format === 'currency') return formatRM(value)
  if (row.format === 'percent') return formatPct(value)
  return formatCount(value)
}

function comparisonChange(row: ComparisonRow): string {
  if (row.format === 'percent') return formatPoints(row.changePoints)
  if (row.key === 'activeDistributors' && row.changePoints !== null) {
    return `${row.changePoints >= 0 ? '+' : ''}${row.changePoints}`
  }
  return formatGrowth(row.changePct)
}

/** Build the complete distributor management report PDF as a Blob. */
export async function buildDistributorAnalyticsPdf(
  report: DistributorAnalyticsReport,
  options: { generatedAt?: string | null; generatedBy?: string | null } = {},
): Promise<DistributorAnalyticsPdf> {
  const [{ default: jsPDF }, autoTableModule] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  const autoTable = autoTableModule.default

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 12
  const contentWidth = pageWidth - margin * 2
  const FOOTER_RESERVE = 14
  const CONTINUE_TOP = 22
  const contentBottom = pageHeight - FOOTER_RESERVE

  const { period, distributor, summary, comparison } = report
  const singleDistributor = !distributor.isAll
  const generatedAt = options.generatedAt ?? new Date().toISOString()

  let y = 14

  const ensureSpace = (needed: number) => {
    if (y + needed > contentBottom) {
      doc.addPage()
      y = CONTINUE_TOP
    }
  }

  const newPage = () => {
    doc.addPage()
    y = CONTINUE_TOP
  }

  const sectionBand = (title: string, note?: string) => {
    ensureSpace(24)
    doc.setDrawColor(...BAND_BORDER)
    doc.setFillColor(...BAND)
    doc.rect(margin, y, contentWidth, 8, 'FD')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9.5)
    doc.setTextColor(...INK)
    doc.text(title, margin + 3, y + 5.5)
    if (note) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor(...MUTED)
      doc.text(note, pageWidth - margin - 3, y + 5.5, { align: 'right' })
    }
    y += 11
  }

  const tableDefaults = {
    theme: 'grid' as const,
    headStyles: { fillColor: INK, textColor: 255 as any, fontStyle: 'bold' as const, fontSize: 7.5, cellPadding: 1.8 },
    styles: { fontSize: 7.5, cellPadding: 1.8, textColor: INK, lineColor: [225, 225, 225] as any, lineWidth: 0.1 },
    alternateRowStyles: { fillColor: STRIPE as any },
    margin: { left: margin, right: margin, top: CONTINUE_TOP, bottom: FOOTER_RESERVE },
    tableWidth: contentWidth,
  }

  const runTable = (tableOptions: any) => {
    autoTable(doc, { ...tableDefaults, startY: y, ...tableOptions })
    y = ((doc as any).lastAutoTable?.finalY ?? y) + 7
  }

  const emptyNote = (text: string) => {
    doc.setFont('helvetica', 'italic')
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text(text, margin + 1, y + 2)
    y += 9
  }

  /** KPI cards laid across the page width. */
  const kpiRow = (cards: { label: string; value: string; note: string; delta?: number | null }[]) => {
    if (cards.length === 0) return
    const gap = 4
    const cardW = (contentWidth - gap * (cards.length - 1)) / cards.length
    const cardH = 22
    ensureSpace(cardH + 4)
    cards.forEach((card, index) => {
      const x = margin + index * (cardW + gap)
      doc.setDrawColor(...BOX_BORDER)
      doc.setFillColor(...BOX_FILL)
      doc.roundedRect(x, y, cardW, cardH, 2, 2, 'FD')
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(6.5)
      doc.setTextColor(...MUTED)
      doc.text(card.label.toUpperCase(), x + 3, y + 5.5)
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(13)
      doc.setTextColor(...INK)
      doc.text(card.value, x + 3, y + 13)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(6.8)
      if (card.delta === undefined || card.delta === null) {
        doc.setTextColor(...MUTED)
      } else {
        doc.setTextColor(...(card.delta >= 0 ? POSITIVE : NEGATIVE))
      }
      doc.text(card.note, x + 3, y + 18.5, { maxWidth: cardW - 6 })
    })
    y += cardH + 6
  }

  const findComparison = (key: string) => comparison.find((row) => row.key === key)

  // ══ PAGE 1 — EXECUTIVE SUMMARY ═════════════════════════════════════════
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(...INK)
  doc.text('SERAPOD DISTRIBUTOR PERFORMANCE REPORT', margin, y + 4)
  doc.setFontSize(10)
  doc.setTextColor(...ORANGE)
  doc.text(
    singleDistributor ? `${distributor.name} · ${period.label}` : period.label,
    pageWidth - margin, y + 4, { align: 'right' },
  )
  y += 9
  doc.setDrawColor(...BAND_BORDER)
  doc.line(margin, y, pageWidth - margin, y)
  y += 5

  const infoPairs: Array<[string, string]> = [
    ['REPORTING MONTH', period.label],
    ['DISTRIBUTOR', distributor.name],
    ['REPORT PERIOD', period.rangeLabel + (period.isCurrentMonth ? ' (month to date)' : '')],
    ['COMPARISON PERIOD', period.comparisonRangeLabel],
    ['ORDER STATUS', report.status.label],
    ['GENERATED', formatDateTime(generatedAt)],
    ['GENERATED BY', options.generatedBy || '—'],
    ['REPORTING TIMEZONE', period.timeZone],
    ['ORDER TYPE', `${report.meta.orderType} · buyer org type ${report.meta.buyerOrgType}`],
    ['INCLUDED STATUSES', report.meta.statuses.map(statusLabel).join(', ')],
    ['REPORT DATE FIELD', report.meta.dateField],
    ['ORDER VALUE', report.meta.orderValueField],
  ]
  const infoRowH = 6
  const rowsPerCol = Math.ceil(infoPairs.length / 2)
  const infoH = infoRowH * rowsPerCol + 7
  doc.setDrawColor(...BOX_BORDER)
  doc.setFillColor(...BOX_FILL)
  doc.roundedRect(margin, y, contentWidth, infoH, 2, 2, 'FD')
  const colGap = contentWidth / 2
  infoPairs.forEach(([label, value], index) => {
    const col = Math.floor(index / rowsPerCol)
    const row = index % rowsPerCol
    const lx = margin + 4 + col * colGap
    const ly = y + 7 + row * infoRowH
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(6.8)
    doc.setTextColor(...MUTED)
    doc.text(label, lx, ly)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...INK)
    doc.text(doc.splitTextToSize(value, colGap - 48)[0], lx + 46, ly)
  })
  y += infoH + 6

  // ── Monthly Summary ────────────────────────────────────────────────────
  sectionBand('MONTHLY SUMMARY', period.rangeLabel + (period.isCurrentMonth ? ' (month to date)' : ''))
  const ordersRow = findComparison('totalOrders')
  const valueRow = findComparison('orderValue')
  const aovRow = findComparison('avgOrderValue')
  const activeRow = findComparison('activeDistributors')
  const returningRow = findComparison('returningRate')

  kpiRow([
    {
      label: 'Total Orders',
      value: formatCount(summary.totalOrders),
      note: `${formatGrowth(ordersRow?.changePct ?? null)} vs comparison  ·  avg ${summary.avgOrdersPerDay.toFixed(1)}/day`,
      delta: ordersRow?.changePct ?? null,
    },
    {
      label: 'Order Value',
      value: formatRM(summary.orderValue),
      note: `${formatGrowth(valueRow?.changePct ?? null)} vs comparison  ·  avg ${formatRM(summary.avgValuePerDay)}/day`,
      delta: valueRow?.changePct ?? null,
    },
    {
      label: 'Avg Order Value',
      value: formatRM(summary.avgOrderValue),
      note: aovRow?.previous === null
        ? 'no comparison baseline'
        : `${formatGrowth(aovRow?.changePct ?? null)}  ·  comparison ${formatRM(aovRow?.previous ?? null)}`,
      delta: aovRow?.changePct ?? null,
    },
    {
      label: 'Active Distributors',
      value: formatCount(summary.activeDistributors),
      note: `${(activeRow?.changePoints ?? 0) >= 0 ? '+' : ''}${activeRow?.changePoints ?? 0} vs comparison`
        + `  ·  ${formatCount(summary.multipleOrderDistributors)} placed more than one order`,
      delta: activeRow?.changePoints ?? null,
    },
    {
      label: 'Returning Distributor Rate',
      value: formatPct(summary.returningRatePct),
      note: `${formatCount(summary.returningDistributors)} of ${formatCount(summary.activeDistributors)} active`
        + `  ·  ${formatPoints(returningRow?.changePoints ?? null)} vs comparison`,
      delta: returningRow?.changePoints ?? null,
    },
  ])

  // ── Period comparison ──────────────────────────────────────────────────
  sectionBand('THIS PERIOD VS PREVIOUS PERIOD', `${period.rangeLabel} vs ${period.comparisonRangeLabel}`)
  runTable({
    head: [['Metric', 'Current', 'Previous', 'Change']],
    body: comparison.map((row) => [
      row.label,
      comparisonValue(row, 'current'),
      comparisonValue(row, 'previous'),
      comparisonChange(row),
    ]),
    columnStyles: {
      0: { cellWidth: contentWidth * 0.34, fontStyle: 'bold' },
      1: { cellWidth: contentWidth * 0.22, halign: 'right' },
      2: { cellWidth: contentWidth * 0.22, halign: 'right' },
      3: { cellWidth: contentWidth * 0.22, halign: 'right' },
    },
  })

  // ── Key management insights ────────────────────────────────────────────
  sectionBand('KEY MANAGEMENT INSIGHTS', `${period.rangeLabel} vs ${period.comparisonRangeLabel}`)
  // Concentration is an all-distributor statement; inside a single distributor
  // it would only ever read "100%", so it is dropped rather than printed.
  const insightCards = report.insights
    .filter((card) => !(singleDistributor && card.key === 'concentration'))
    .map((card) => ({ label: card.title, value: card.value, note: card.description }))
  kpiRow(insightCards)

  // ══ PAGE 2 — PERFORMANCE ═══════════════════════════════════════════════
  newPage()
  sectionBand('DAILY SELL-IN TREND', `${period.rangeLabel}  ·  ${period.dayCount} day${period.dayCount === 1 ? '' : 's'}`)
  if (report.dailyTrend.length === 0 || summary.totalOrders === 0) {
    emptyNote('No distributor order activity recorded for the selected period.')
  } else {
    runTable({
      head: [['Day', 'Orders', 'Order Value', 'Day', 'Orders', 'Order Value']],
      // Two column-pairs so a 31-day month stays on one page rather than
      // spilling a second table page of mostly whitespace.
      body: (() => {
        const rows = report.dailyTrend
        const half = Math.ceil(rows.length / 2)
        return Array.from({ length: half }, (_, index) => {
          const left = rows[index]
          const right = rows[index + half]
          return [
            left.label, formatCount(left.orders), formatRM(left.orderValue),
            right?.label ?? '', right ? formatCount(right.orders) : '', right ? formatRM(right.orderValue) : '',
          ]
        })
      })(),
      columnStyles: {
        0: { cellWidth: contentWidth * 0.1, fontStyle: 'bold' },
        1: { cellWidth: contentWidth * 0.1, halign: 'right' },
        2: { cellWidth: contentWidth * 0.3, halign: 'right' },
        3: { cellWidth: contentWidth * 0.1, fontStyle: 'bold' },
        4: { cellWidth: contentWidth * 0.1, halign: 'right' },
        5: { cellWidth: contentWidth * 0.3, halign: 'right' },
      },
    })
  }

  // A leaderboard and a contribution split of one distributor say nothing, so
  // the single-distributor report replaces them with its own order history.
  if (!singleDistributor) {
    sectionBand('DISTRIBUTOR LEADERBOARD', 'Ranked by Order Value')
    if (report.leaderboard.length === 0) {
      emptyNote('No distributor order activity recorded for the selected period.')
    } else {
      runTable({
        head: [['#', 'Distributor', 'Order Value', 'Orders', 'AOV', 'Share', 'vs Previous', 'Last Order']],
        body: report.leaderboard.map((row) => [
          row.rank,
          row.name,
          formatRM(row.currentValue),
          formatCount(row.currentOrders),
          formatRM(row.aov),
          formatPct(row.sharePct),
          formatGrowth(row.growthPct),
          formatDay(row.lastOrderAt),
        ]),
        columnStyles: {
          0: { cellWidth: contentWidth * 0.04, halign: 'right' },
          1: { cellWidth: contentWidth * 0.28 },
          2: { cellWidth: contentWidth * 0.15, halign: 'right' },
          3: { cellWidth: contentWidth * 0.08, halign: 'right' },
          4: { cellWidth: contentWidth * 0.13, halign: 'right' },
          5: { cellWidth: contentWidth * 0.09, halign: 'right' },
          6: { cellWidth: contentWidth * 0.12, halign: 'right' },
          7: { cellWidth: contentWidth * 0.11, halign: 'right' },
        },
      })
    }

    sectionBand(
      'DISTRIBUTOR CONTRIBUTION',
      report.contribution.topQuintileSharePct === null
        ? 'Concentration risk'
        : `Top 20% of active distributors carry ${report.contribution.topQuintileSharePct.toFixed(0)}% of Order Value`,
    )
    if (report.contribution.distributorCount === 0) {
      emptyNote('No distributor order activity recorded for the selected period.')
    } else {
      runTable({
        head: [['Band', 'Distributors', 'Order Value', 'Share of Order Value']],
        body: report.contribution.bands.map((band) => [
          band.label,
          formatCount(band.distributors),
          formatRM(band.orderValue),
          formatPct(band.sharePct),
        ]),
        columnStyles: {
          0: { cellWidth: contentWidth * 0.3, fontStyle: 'bold' },
          1: { cellWidth: contentWidth * 0.18, halign: 'right' },
          2: { cellWidth: contentWidth * 0.26, halign: 'right' },
          3: { cellWidth: contentWidth * 0.26, halign: 'right' },
        },
      })
    }
  }

  sectionBand(
    singleDistributor ? `TOP PRODUCTS — ${distributor.name.toUpperCase()}` : 'TOP PRODUCTS ACROSS DISTRIBUTORS',
    period.rangeLabel,
  )
  if (report.topProducts.length === 0) {
    emptyNote('No products were ordered by distributors in the selected period.')
  } else {
    runTable({
      head: [['#', 'Product / Variant', 'Units', 'Order Value', 'Share']],
      body: report.topProducts.map((row) => [
        row.rank,
        row.label,
        formatCount(row.units),
        formatRM(row.orderValue),
        formatPct(row.sharePct),
      ]),
      columnStyles: {
        0: { cellWidth: contentWidth * 0.05, halign: 'right' },
        1: { cellWidth: contentWidth * 0.45 },
        2: { cellWidth: contentWidth * 0.13, halign: 'right' },
        3: { cellWidth: contentWidth * 0.22, halign: 'right' },
        4: { cellWidth: contentWidth * 0.15, halign: 'right' },
      },
    })
  }

  if (singleDistributor) {
    sectionBand('RECENT ORDERS', period.rangeLabel)
    if (report.recentOrders.length === 0) {
      emptyNote('No orders recorded for this distributor in the selected period.')
    } else {
      runTable({
        head: [['Order No', 'Date', 'Status', 'Items', 'Order Value']],
        body: report.recentOrders.map((row) => [
          row.orderNo || row.orderId,
          formatDay(row.orderDate || row.createdAt),
          statusLabel(row.status),
          formatCount(row.itemCount),
          formatRM(row.orderValue),
        ]),
        columnStyles: {
          0: { cellWidth: contentWidth * 0.28 },
          1: { cellWidth: contentWidth * 0.15, halign: 'right' },
          2: { cellWidth: contentWidth * 0.2 },
          3: { cellWidth: contentWidth * 0.13, halign: 'right' },
          4: { cellWidth: contentWidth * 0.24, halign: 'right' },
        },
      })
    }
  }

  // ══ PAGE 3 — RELATIONSHIP & RISK ═══════════════════════════════════════
  newPage()
  sectionBand('RELATIONSHIP SUMMARY', `${period.rangeLabel} vs ${period.comparisonRangeLabel}`)
  kpiRow(report.relationship.rows.map((row) => ({
    label: row.label,
    value: formatCount(row.count),
    note: row.description,
  })))

  sectionBand(
    'DISTRIBUTOR HEALTH / RISK',
    `At risk beyond ${report.meta.atRiskDays} days (or twice the distributor's own cadence) · dormant from ${report.meta.dormantDays} days`,
  )
  if (report.health.rows.length === 0) {
    emptyNote('No distributor order activity recorded for the selected period.')
  } else {
    runTable({
      head: [['Distributor', 'Orders', 'Prev Orders', 'Order Value', 'Prev Value', 'Change', 'Last Order', 'Days Since', 'Status']],
      body: report.health.rows.map((row: DistributorRow) => [
        row.name,
        formatCount(row.currentOrders),
        formatCount(row.previousOrders),
        formatRM(row.currentValue),
        formatRM(row.previousValue),
        formatGrowth(row.growthPct),
        formatDay(row.lastOrderAt),
        row.daysSinceLastOrder === null ? '—' : formatCount(row.daysSinceLastOrder),
        HEALTH_LABEL[row.health],
      ]),
      columnStyles: {
        0: { cellWidth: contentWidth * 0.2 },
        1: { cellWidth: contentWidth * 0.07, halign: 'right' },
        2: { cellWidth: contentWidth * 0.08, halign: 'right' },
        3: { cellWidth: contentWidth * 0.14, halign: 'right' },
        4: { cellWidth: contentWidth * 0.14, halign: 'right' },
        5: { cellWidth: contentWidth * 0.1, halign: 'right' },
        6: { cellWidth: contentWidth * 0.09, halign: 'right' },
        7: { cellWidth: contentWidth * 0.07, halign: 'right' },
        8: { cellWidth: contentWidth * 0.11 },
      },
    })
  }

  sectionBand(
    'DISTRIBUTOR ACTION PLAN',
    report.actionPlan.summary.map((card) => `${card.label}: ${card.count}`).join('   ·   '),
  )
  if (report.actionPlan.rows.length === 0) {
    emptyNote('No management actions were raised for the selected report period.')
  } else {
    runTable({
      head: [['Priority', 'Distributor', 'Order Value', 'Previous', 'Change', 'Orders', 'Last Order', 'Status', 'Recommended Action']],
      body: report.actionPlan.rows.map((row: DistributorRow) => [
        row.actionPriority,
        row.name,
        formatRM(row.currentValue),
        formatRM(row.previousValue),
        formatGrowth(row.growthPct),
        formatCount(row.currentOrders),
        formatDay(row.lastOrderAt),
        HEALTH_LABEL[row.health],
        ACTION_LABEL[row.action as ActionKey].toUpperCase(),
      ]),
      columnStyles: {
        0: { cellWidth: contentWidth * 0.07, fontStyle: 'bold' },
        1: { cellWidth: contentWidth * 0.19 },
        2: { cellWidth: contentWidth * 0.13, halign: 'right' },
        3: { cellWidth: contentWidth * 0.13, halign: 'right' },
        4: { cellWidth: contentWidth * 0.09, halign: 'right' },
        5: { cellWidth: contentWidth * 0.06, halign: 'right' },
        6: { cellWidth: contentWidth * 0.08, halign: 'right' },
        7: { cellWidth: contentWidth * 0.11 },
        8: { cellWidth: contentWidth * 0.14 },
      },
    })
  }

  sectionBand(
    'ORDER PROCESSING HEALTH',
    'Operational status mix — not a measure of the distributor relationship',
  )
  kpiRow([
    { label: 'Orders In Period', value: formatCount(report.orderProcessing.total), note: period.rangeLabel },
    {
      label: 'Approval Rate',
      value: formatPct(report.orderProcessing.approvalRatePct),
      note: `${formatCount(report.orderProcessing.approvedOrders)} approved, packed, shipped or closed`,
    },
    {
      label: 'Completion Rate',
      value: formatPct(report.orderProcessing.completionRatePct),
      note: `${formatCount(report.orderProcessing.completedOrders)} closed`,
    },
    {
      label: 'Cancellation Rate',
      value: formatPct(report.orderProcessing.cancellationRatePct),
      note: `${formatCount(report.orderProcessing.cancelledOrders)} cancelled`,
    },
  ])
  kpiRow([
    { label: 'Approved Sales Value', value: formatRM(report.orderProcessing.approvedSalesValue), note: `${formatCount(report.orderProcessing.approvedOrders)} approved-stage orders` },
    { label: 'Order Pipeline Value', value: formatRM(report.orderProcessing.pipelineValue), note: `${formatCount(report.orderProcessing.pipelineOrders)} submitted` },
    { label: 'Cancelled Orders Value', value: formatRM(report.orderProcessing.cancelledValue), note: `${formatCount(report.orderProcessing.cancelledOrders)} cancelled — not sales` },
  ])
  if (report.orderProcessing.statuses.length === 0) {
    emptyNote('No orders recorded for the selected period.')
  } else {
    runTable({
      head: [['Status', 'Orders', 'Share of Orders', 'Order Value']],
      body: report.orderProcessing.statuses.map((row) => [
        row.label,
        formatCount(row.orders),
        formatPct(row.sharePct),
        formatRM(row.orderValue),
      ]),
      columnStyles: {
        0: { cellWidth: contentWidth * 0.3, fontStyle: 'bold' },
        1: { cellWidth: contentWidth * 0.18, halign: 'right' },
        2: { cellWidth: contentWidth * 0.22, halign: 'right' },
        3: { cellWidth: contentWidth * 0.3, halign: 'right' },
      },
    })
  }

  // ── Page chrome ────────────────────────────────────────────────────────
  const totalPages = doc.getNumberOfPages()
  for (let page = 1; page <= totalPages; page++) {
    doc.setPage(page)
    if (page > 1) {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(...INK)
      doc.text('SERAPOD DISTRIBUTOR PERFORMANCE REPORT', margin, 12)
      doc.setTextColor(...ORANGE)
      doc.text(
        `${singleDistributor ? `${distributor.name} · ` : ''}${period.label} · ${period.rangeLabel}`,
        pageWidth - margin, 12, { align: 'right' },
      )
      doc.setDrawColor(...BOX_BORDER)
      doc.line(margin, 15, pageWidth - margin, 15)
    }
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(...MUTED)
    doc.text('Generated from Serapod2U', margin, pageHeight - 5)
    doc.text(`Generated: ${formatDateTime(generatedAt)} (MYT)`, pageWidth / 2, pageHeight - 5, { align: 'center' })
    doc.text(`Page ${page} of ${totalPages}`, pageWidth - margin, pageHeight - 5, { align: 'right' })
  }

  const blob = doc.output('blob')
  return { blob, filename: distributorReportFilename(period, distributor), size: blob.size }
}
