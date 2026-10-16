/**
 * Commission Reporting exports — generated on the server (after reporting.commission.export is checked) from the SAME
 * CommissionReport model the screen renders, so PDF, Excel and screen totals cannot diverge (export.test.ts).
 */
import ExcelJS from 'exceljs'
import { cycleRangeLabel, CYCLE_STATUS_LABEL, type CycleStatus } from './cycle'
import { formatRate, formatRM, type CommissionReport } from './report'

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } }
const SECTION_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E8' } }
const SUBTOTAL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }
const MONEY = '#,##0.00;[Red]-#,##0.00'

const statusLabel = (s: string) => CYCLE_STATUS_LABEL[s as CycleStatus] ?? s

export function exportFilename(report: CommissionReport, ext: 'xlsx' | 'pdf') {
  return `commission-${report.cycle.code}-v${report.cycle.calcVersion}.${ext}`
}

export interface ExportMeta { generatedAt: string; generatedBy: string | null }

export async function buildCommissionWorkbook(report: CommissionReport, meta: ExportMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Serapod2U'
  wb.created = new Date(meta.generatedAt)
  const ws = wb.addWorksheet('Commission', { views: [{ state: 'frozen', ySplit: 6 }] })
  ws.columns = [
    { key: 'name', width: 38 }, { key: 'bu', width: 22 }, { key: 'sales', width: 20 }, { key: 'rate', width: 12 },
    { key: 'commission', width: 18 }, { key: 'adjustments', width: 16 }, { key: 'net', width: 18 }, { key: 'note', width: 46 },
  ]
  ws.addRow([report.cycle.label]).font = { bold: true, size: 14 }
  ws.addRow([`${cycleRangeLabel(report.cycle.startAt, report.cycle.endAt)} (Asia/Kuala_Lumpur) · ${statusLabel(report.cycle.status)} · calculation v${report.cycle.calcVersion}`])
  ws.addRow([`Generated ${meta.generatedAt}${meta.generatedBy ? ` by ${meta.generatedBy}` : ''}. Confidential — employee compensation.`]).font = { italic: true, size: 9 }
  ws.addRow([])

  // Income / Eligible Sales
  const incomeHead = ws.addRow(['Income / Eligible Sales', 'Business Unit', 'Eligible Sales', 'Lines', 'Commission'])
  incomeHead.eachCell((c) => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } } })
  ws.addRow([])
  for (const b of report.income) {
    const r = ws.addRow(['', b.name, b.eligibleSales, b.lines, b.commission])
    r.getCell(3).numFmt = MONEY; r.getCell(5).numFmt = MONEY
  }
  const incomeTotal = ws.addRow(['Total Eligible Sales', '', report.summary.eligibleSales, '', ''])
  incomeTotal.font = { bold: true }; incomeTotal.getCell(3).numFmt = MONEY
  ws.addRow([])

  const head = ws.addRow(['Employee', 'Business Unit', 'Commissionable Sales', 'Rate', 'Commission', 'Adjustments', 'Net Commission', 'Notes'])
  head.eachCell((c) => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: 'FFFFFFFF' } } })
  for (const section of report.sections) {
    const sr = ws.addRow([`${section.departmentName} Commission`])
    sr.font = { bold: true }; sr.eachCell((c) => { c.fill = SECTION_FILL })
    for (const emp of section.employees) {
      for (const row of emp.rows) {
        const r = ws.addRow([
          row.employeeName, row.businessUnit, row.commissionableSales, row.ratePercent == null ? null : row.ratePercent / 100,
          row.commission, row.adjustments, row.net, row.note ?? row.ratePeriod ?? '',
        ])
        r.getCell(3).numFmt = MONEY; r.getCell(4).numFmt = '0.00000%'
        r.getCell(5).numFmt = MONEY; r.getCell(6).numFmt = MONEY; r.getCell(7).numFmt = MONEY
      }
      if (emp.rows.length > 1) {
        const t = ws.addRow([`${emp.employeeName} — total`, '', null, null, emp.commission, emp.adjustments, emp.net, ''])
        t.font = { italic: true }
        for (const i of [5, 6, 7]) t.getCell(i).numFmt = MONEY
      }
    }
    const st = ws.addRow([`${section.departmentName} subtotal`, '', null, null, section.commission, section.adjustments, section.net, ''])
    st.font = { bold: true }; st.eachCell((c) => { c.fill = SUBTOTAL_FILL })
    for (const i of [5, 6, 7]) st.getCell(i).numFmt = MONEY
  }
  const gt = ws.addRow(['GRAND TOTAL', '', null, null, report.grandTotal.commission, report.grandTotal.adjustments, report.grandTotal.net, ''])
  gt.font = { bold: true, size: 12 }
  for (const i of [5, 6, 7]) gt.getCell(i).numFmt = MONEY
  const out = await wb.xlsx.writeBuffer()
  return Buffer.from(out as ArrayBuffer)
}

export async function buildCommissionPdf(report: CommissionReport, meta: ExportMeta): Promise<Buffer> {
  const [{ default: jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const autoTable = autoTableModule.default
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const margin = 12
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15)
  doc.text(report.cycle.label, margin, 16)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  doc.text(`${cycleRangeLabel(report.cycle.startAt, report.cycle.endAt)} (Asia/Kuala_Lumpur) · ${statusLabel(report.cycle.status)} · calculation v${report.cycle.calcVersion}`, margin, 22)
  doc.text(`Generated ${meta.generatedAt}${meta.generatedBy ? ` by ${meta.generatedBy}` : ''} · Confidential — employee compensation`, margin, 27)
  doc.text(`Eligible sales ${formatRM(report.summary.eligibleSales)} · Commission ${formatRM(report.summary.totalCommission)} · Adjustments ${formatRM(report.summary.totalAdjustments)} · Net ${formatRM(report.summary.netCommission)} · ${report.summary.eligibleEmployees} employees`, margin, 32)

  autoTable(doc, {
    startY: 37,
    margin: { left: margin, right: margin },
    head: [['Income / Eligible Sales', 'Lines', 'Eligible Sales', 'Commission']],
    body: [
      ...report.income.map((b) => [b.name, String(b.lines), formatRM(b.eligibleSales), formatRM(b.commission)]),
      [{ content: 'Total Eligible Sales', styles: { fontStyle: 'bold' } }, '', { content: formatRM(report.summary.eligibleSales), styles: { fontStyle: 'bold' } }, ''],
    ],
    styles: { fontSize: 8 },
    headStyles: { fillColor: [31, 41, 55] },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
  })

  const body: any[] = []
  for (const section of report.sections) {
    body.push([{ content: `${section.departmentName} Commission`, colSpan: 7, styles: { fontStyle: 'bold', fillColor: [255, 243, 232] } }])
    for (const emp of section.employees) {
      for (const row of emp.rows) {
        body.push([row.employeeName, row.businessUnit, row.commissionableSales == null ? '' : formatRM(row.commissionableSales),
          row.ratePercent == null ? '' : formatRate(row.ratePercent), formatRM(row.commission), formatRM(row.adjustments), formatRM(row.net)])
        if (row.note) body.push([{ content: row.note, colSpan: 7, styles: { fontSize: 6.5, textColor: [107, 114, 128] } }])
      }
      if (emp.rows.length > 1) {
        body.push([{ content: `${emp.employeeName} — total`, colSpan: 4, styles: { fontStyle: 'italic' } }, formatRM(emp.commission), formatRM(emp.adjustments), formatRM(emp.net)])
      }
    }
    body.push([{ content: `${section.departmentName} subtotal`, colSpan: 4, styles: { fontStyle: 'bold', fillColor: [243, 244, 246] } },
      { content: formatRM(section.commission), styles: { fontStyle: 'bold', fillColor: [243, 244, 246] } },
      { content: formatRM(section.adjustments), styles: { fontStyle: 'bold', fillColor: [243, 244, 246] } },
      { content: formatRM(section.net), styles: { fontStyle: 'bold', fillColor: [243, 244, 246] } }])
  }
  body.push([{ content: 'GRAND TOTAL', colSpan: 4, styles: { fontStyle: 'bold' } },
    { content: formatRM(report.grandTotal.commission), styles: { fontStyle: 'bold' } },
    { content: formatRM(report.grandTotal.adjustments), styles: { fontStyle: 'bold' } },
    { content: formatRM(report.grandTotal.net), styles: { fontStyle: 'bold' } }])

  autoTable(doc, {
    startY: ((doc as any).lastAutoTable?.finalY ?? 60) + 6,
    margin: { left: margin, right: margin },
    head: [['Employee', 'Business Unit', 'Commissionable Sales', 'Rate', 'Commission', 'Adjustments', 'Net Commission']],
    body,
    styles: { fontSize: 7.5 },
    headStyles: { fillColor: [31, 41, 55] },
    columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
    didDrawPage: () => {
      const h = doc.internal.pageSize.getHeight()
      doc.setFontSize(7); doc.setTextColor(120)
      doc.text(`${report.cycle.label} · Confidential · page ${doc.getNumberOfPages()}`, margin, h - 6)
    },
  })
  return Buffer.from(doc.output('arraybuffer'))
}
