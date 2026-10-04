/**
 * PDF Document Templates
 * 
 * This module provides different PDF template styles:
 * - detailed: Comprehensive document format with full details (Image 4 - Current)
 * - classic: Traditional Purchase Order layout (Image 2 style)
 */

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { wrapTermsLines } from '@/lib/organizations/terms'
import { isBuyerIssuedDocument, resolveCounterparty } from '@/lib/documents/counterparty'
import { formatExpectedDelivery, resolveOrderCasesPerBox } from '@/lib/orders/packaging'
import { formatOrderExpectedBoxes } from '@/lib/orders/packaging'
import { qrCaseTotals } from '@/lib/orders/qr-buffer'
import { formatDateKey, isDateKey } from '@/lib/orders/order-date'
import {
  salesOrderLineDescription,
  sortSalesOrderLinesForDisplay,
} from '@/lib/orders/sales-order-line-presentation'

function pdfImageFormat(imageData: string): 'PNG' | 'JPEG' | 'WEBP' {
  if (/^data:image\/(?:jpe?g);/i.test(imageData)) return 'JPEG'
  if (/^data:image\/webp;/i.test(imageData)) return 'WEBP'
  return 'PNG'
}

export type DocumentTemplateType = 'detailed' | 'classic'

export interface TemplateOrderData {
  order_no: string
  order_type: string
  status: string
  created_at: string
  /** Business/SO date (orders.order_date, YYYY-MM-DD). Absent before the order_date migration. */
  order_date?: string | null
  approved_at?: string
  payment_terms?: any
  approver?: {
    full_name: string
    role_name?: string
    signature_url?: string | null
  }
  creator?: {
    full_name: string
    signature_url?: string | null
  } | null
  approver_signature_image?: string | null
  buyer_org: {
    org_name: string
    /** `organizations.org_type_code`, e.g. 'DIST' — drives the party label. */
    org_type_code?: string | null
    address?: string | null
    address_line2?: string | null
    city?: string | null
    state?: string | null
    postal_code?: string | null
    country_code?: string | null
    contact_name?: string | null
    contact_phone?: string | null
    contact_email?: string | null
    logo_url?: string | null
  }
  seller_org: {
    org_name: string
    /** `organizations.org_type_code`, e.g. 'DIST' — drives the party label. */
    org_type_code?: string | null
    address?: string | null
    address_line2?: string | null
    city?: string | null
    state?: string | null
    postal_code?: string | null
    country_code?: string | null
    contact_name?: string | null
    contact_phone?: string | null
    contact_email?: string | null
  }
  order_items: Array<{
    product?: { product_name: string; product_code: string }
    variant?: { variant_name: string }
    qty: number
    qty_cases?: number
    units_per_case?: number
    unit_price: number
    line_total: number
  }>
  /**
   * `orders.units_per_case` — the order-level cases-per-box setting, used when
   * the lines do not all agree on one. Legacy internal name; see packaging.ts.
   */
  units_per_case?: number | null
  /** `orders.qr_buffer_percent` — the H2M manufacturer buffer percent. */
  qr_buffer_percent?: number | null
  /**
   * The issuing organization's Terms & Conditions
   * (organizations.settings.terms_conditions), resolved upstream. Separate
   * from `payment_terms`, which remains the deposit/balance schedule.
   */
  organization_terms?: string | null
  // Dynamic image data (fetched and converted to base64)
  buyer_logo_image?: string | null
  seller_logo_image?: string | null
  buyer_signature_image?: string | null
  issuer_signature_image?: string | null
  creator_signature_image?: string | null
}

export interface TemplateDocumentData {
  doc_no: string
  display_doc_no?: string  // New format: PO26000001
  doc_type: string
  status: string
  created_at: string
  total_amount?: number
  payment_percentage?: number
  payload?: Record<string, any>
}

export interface TemplateSignatureData {
  signer_name: string
  signer_role: string
  signed_at: string
  signature_image_data?: string | null
}

interface ClassicSignatureFooterColumn {
  centerX: number
  label: string
  nameLines: string[]
}

export interface ClassicSignatureFooterLayout {
  creator: ClassicSignatureFooterColumn
  approver: ClassicSignatureFooterColumn
  nameY: number
  nameLineHeight: number
  signatureY: number
  signatureLineY: number
  dateY: number
  bottomY: number
  nameMaxWidth: number
}

/**
 * Keep audit names inside equal footer columns and align both signatures below
 * the taller wrapped name block.
 */
export function createClassicSignatureFooterLayout(
  pageWidth: number,
  margin: number,
  footerY: number,
  creatorName: string,
  approverName: string,
  wrapText: (text: string, maxWidth: number) => string[]
): ClassicSignatureFooterLayout {
  const columnWidth = (pageWidth - margin * 2) / 3
  const nameMaxWidth = columnWidth - 8
  const nameY = footerY + 4.5
  const nameLineHeight = 4
  const creatorNameLines = wrapText(creatorName, nameMaxWidth)
  const approverNameLines = wrapText(approverName, nameMaxWidth)
  const nameLineCount = Math.max(creatorNameLines.length, approverNameLines.length, 1)
  const signatureY = nameY + nameLineCount * nameLineHeight + 1
  const signatureLineY = signatureY + 13
  const dateY = signatureLineY + 7

  return {
    creator: {
      centerX: margin + columnWidth * 1.5,
      label: 'Created by:',
      nameLines: creatorNameLines
    },
    approver: {
      centerX: margin + columnWidth * 2.5,
      label: 'Approved by:',
      nameLines: approverNameLines
    },
    nameY,
    nameLineHeight,
    signatureY,
    signatureLineY,
    dateY,
    bottomY: dateY + 18,
    nameMaxWidth
  }
}







/**
 * Classic Template (Image 2 style)
 * Traditional Purchase Order layout
 */
export class ClassicTemplate {
  private doc: jsPDF
  private pageWidth: number = 210
  private margin: number = 15
  private signatures: TemplateSignatureData[]

  constructor(signatures: TemplateSignatureData[] = []) {
    this.doc = new jsPDF({ compress: true })
    this.signatures = signatures
  }

  private formatCurrency(amount: number | string): string {
    const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount
    if (isNaN(numAmount)) return 'RM 0.00'
    return `RM ${numAmount.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  private formatDate(dateString: string): string {
    const date = new Date(dateString)
    const day = String(date.getDate()).padStart(2, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const year = date.getFullYear()
    return `${day}/${month}/${year}`
  }

  private formatDateLong(dateString: string): string {
    if (!dateString) return ''
    const date = new Date(dateString)
    const day = date.getDate()
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const month = months[date.getMonth()]
    const year = date.getFullYear()
    return `${day} ${month} ${year}`
  }

  /**
   * The Expected Delivery line: a bold label and the box figure beside it, on
   * one line directly below the order total.
   *
   *   Expected Delivery: 55 Standard Boxes + 1 Small Box
   *
   * The figure is the SAME case total the totals row is built from, converted by
   * the shared `formatExpectedDelivery` the SO detail page also uses. No formula
   * or working is printed — the document states the quantity, it does not
   * explain it.
   *
   * A page break is taken first when the line would not fit above the footer,
   * so it never lands on top of the signature block.
   */
  private addExpectedDeliverySection(orderData: TemplateOrderData, yPosition: number): number {
    const totalCases = orderData.order_items.reduce((sum, item) => sum + (item.qty || 0), 0)
    const label = formatExpectedDelivery(
      totalCases,
      resolveOrderCasesPerBox(
        orderData.order_items.map((item) => item.units_per_case),
        orderData.units_per_case,
      ),
    )

    const pageHeight = this.doc.internal.pageSize.getHeight()
    let y = yPosition
    // The line + the breathing room the Terms below expect.
    if (y + 7 > pageHeight - this.margin) {
      this.doc.addPage()
      y = 20
    }

    const heading = 'Expected Delivery:'
    this.doc.setFontSize(9)
    this.doc.setTextColor(0, 0, 0)
    this.doc.setFont('helvetica', 'bold')
    this.doc.text(heading, this.margin, y)
    const valueX = this.margin + this.doc.getTextWidth(heading) + 1.5

    this.doc.setFont('helvetica', 'normal')
    this.doc.text(label, valueX, y)

    // A little air before the Terms heading, which follows at y + 6.
    return y + 2
  }

  /**
   * "Expected Boxes: 10 Standard Boxes" for an H2M / D2H purchase order, from
   * the shared `formatOrderExpectedBoxes` the order detail page also uses. An
   * H2M order adds its manufacturer buffer on the next line: buffer cases are
   * not packed into the boxes.
   */
  private addExpectedBoxesSection(orderData: TemplateOrderData, yPosition: number): number {
    const label = formatOrderExpectedBoxes(orderData.order_items, orderData.units_per_case)
    const totalCases = orderData.order_items.reduce((sum, item) => sum + (item.qty || 0), 0)
    const buffer = orderData.order_type === 'H2M' ? qrCaseTotals(totalCases, orderData.qr_buffer_percent) : null
    const showBuffer = !!buffer && buffer.bufferCases > 0

    const pageHeight = this.doc.internal.pageSize.getHeight()
    let y = yPosition
    if (y + (showBuffer ? 12 : 7) > pageHeight - this.margin) {
      this.doc.addPage()
      y = 20
    }

    const heading = 'Expected Boxes:'
    this.doc.setFontSize(9)
    this.doc.setTextColor(0, 0, 0)
    this.doc.setFont('helvetica', 'bold')
    this.doc.text(heading, this.margin, y)
    this.doc.setFont('helvetica', 'normal')
    this.doc.text(label, this.margin + this.doc.getTextWidth(heading) + 1.5, y)

    if (showBuffer && buffer) {
      y += 5
      this.doc.setFontSize(8)
      this.doc.setTextColor(90, 90, 90)
      this.doc.text(
        `Manufacturer buffer: ${buffer.bufferCases.toLocaleString('en-MY')} ${buffer.bufferCases === 1 ? 'case' : 'cases'} (${buffer.bufferPercent}%), not included in Expected Boxes`,
        this.margin,
        y,
      )
      this.doc.setTextColor(0, 0, 0)
    }

    return y + 2
  }

  async generate(orderData: TemplateOrderData, documentData: TemplateDocumentData, docTitle: string): Promise<Blob> {
    let y = 20

    const isSalesOrderDoc = (documentData.doc_type || '').toUpperCase() === 'SO'

    // 1. Header Section - 2 Column Grid
    // Left Column (65%): Logo + Company Info (Side-by-side, vertically centered)
    // Right Column (35%): Document Title + Meta Details

    // --- Right Column Content (Title + Meta) ---
    const headerRightX = this.pageWidth - this.margin

    this.doc.setTextColor(0, 0, 0)
    this.doc.setFontSize(14)
    this.doc.setFont('helvetica', 'normal')
    this.doc.text(docTitle.toUpperCase(), headerRightX, y + 5, { align: 'right' })

    let detailsY = y + 15
    this.doc.setFontSize(9)

    const details = [
      { label: 'PO#:', value: documentData.display_doc_no || documentData.doc_no },
      // A Sales Order is dated with the order's business SO date (order_date);
      // every other document keeps its own issue date.
      { label: 'Date:', value: isSalesOrderDoc && orderData.order_date && isDateKey(orderData.order_date.slice(0, 10))
        ? formatDateKey(orderData.order_date)
        : this.formatDate(documentData.created_at) },
      { label: 'By:', value: orderData.creator?.full_name || 'Not available' },
      { label: 'Ledger:', value: 'Stock Purchased / Inventory' }
    ]

    details.forEach(detail => {
      this.doc.setFont('helvetica', 'normal')
      this.doc.setTextColor(128, 128, 128) // Gray label
      this.doc.text(detail.label, headerRightX - 50, detailsY, { align: 'left' })

      this.doc.setTextColor(0, 0, 0) // Black value
      this.doc.text(detail.value, headerRightX, detailsY, { align: 'right' })
      detailsY += 5
    })

    // --- Left Column Content (Logo + Info) ---
    // Determine Issuer (Header Party) from the document kind. Shared with the
    // counterparty block below so the letterhead and the party named beneath it
    // are always the two opposite sides of the order.
    const isBuyerIssuer = isBuyerIssuedDocument(docTitle)
    const headerOrg = isBuyerIssuer ? orderData.buyer_org : orderData.seller_org
    const headerLogo = isBuyerIssuer ? orderData.buyer_logo_image : orderData.seller_logo_image

    const orgName = headerOrg.org_name.toUpperCase()
    const orgAddress = [
      headerOrg.address,
      headerOrg.address_line2,
      [headerOrg.city, headerOrg.postal_code].filter(Boolean).join(', '),
      headerOrg.state,
      headerOrg.contact_email
    ].filter(Boolean)

    // Calculate Text Block Height
    const nameHeight = 4
    const addrLineHeight = 3.5
    const textBlockHeight = nameHeight + (orgAddress.length * addrLineHeight)

    // Logo Dimensions & Positioning
    const logoMaxHeight = 22 // ~64px (100% bigger)
    let logoW = 22
    let logoH = 22
    const logoX = this.margin
    let logoY = y + 2 // Default top align if no image

    if (headerLogo) {
      try {
        const props = this.doc.getImageProperties(headerLogo)
        const ratio = props.width / props.height
        logoH = Math.min(logoMaxHeight, props.height * 0.264583) // Convert px to mm if needed, but max is 22mm
        logoH = logoMaxHeight
        logoW = logoH * ratio

        // Center vertically relative to text block
        // Ensure we don't go above y
        logoY = y + Math.max(0, (textBlockHeight - logoH) / 2)

        this.doc.addImage(headerLogo, pdfImageFormat(headerLogo), logoX, logoY, logoW, logoH)
      } catch (e) {
        console.error('Error adding buyer logo:', e)
        this.doc.setDrawColor(200, 200, 200)
        this.doc.rect(logoX, logoY, logoH, logoH)
      }
    } else {
      this.doc.setFontSize(6)
      this.doc.setTextColor(150, 150, 150)
      this.doc.text('LOGO', logoX, logoY + 5)
    }

    // Render Text Block (Offset by Logo Width + Gap)
    const textX = logoX + logoW + 5 // 5mm gap
    let currentTextY = y + 3.5 // Align text top roughly with logo top

    // Org Name
    this.doc.setFontSize(10)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(0, 0, 0)
    this.doc.text(orgName, textX, currentTextY)
    currentTextY += nameHeight

    // Address
    this.doc.setFontSize(8)
    this.doc.setFont('helvetica', 'normal')
    this.doc.setTextColor(100, 100, 100)

    orgAddress.forEach(line => {
      if (line) {
        this.doc.text(line, textX, currentTextY)
        currentTextY += addrLineHeight
      }
    })

    y = Math.max(currentTextY, detailsY) + 5

    // 2. Counterparty & Status Section
    // Draw line above the counterparty block
    this.doc.setDrawColor(230, 230, 230)
    this.doc.setLineWidth(0.1)
    this.doc.line(this.margin, y, this.pageWidth - this.margin, y)

    y += 5
    const supplierY = y

    // Counterparty (Left) — the party this document is FOR, i.e. whichever of
    // the two organizations the letterhead above is not. Labelled from that
    // organization's own type, so a distributor reads as "Distributor:" rather
    // than the previous hardcoded "Supplier:" (which, on a seller-issued
    // document such as an invoice, also repeated the letterhead org).
    const counterparty = resolveCounterparty(orderData, docTitle)

    this.doc.setFontSize(9)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(0, 0, 0)
    this.doc.text(counterparty.label, this.margin, supplierY)

    let suppAddrY = supplierY + 6

    if (counterparty.name) {
      this.doc.setFontSize(9)
      this.doc.text(counterparty.name, this.margin, suppAddrY)
      suppAddrY += 5
    }

    this.doc.setFont('helvetica', 'normal')
    this.doc.setTextColor(100, 100, 100)

    // Address then contact lines; every entry is already non-empty, so a
    // sparsely filled organization simply renders fewer lines.
    counterparty.detailLines.forEach(line => {
      this.doc.text(line, this.margin, suppAddrY)
      suppAddrY += 4
    })

    // Status Box (Right)
    // Box dimensions
    const boxWidth = 40
    const boxHeight = 15
    const boxX = this.pageWidth - this.margin - boxWidth
    const boxY = supplierY

    this.doc.setDrawColor(230, 230, 230)
    this.doc.setLineWidth(0.5)
    this.doc.rect(boxX, boxY, boxWidth, boxHeight)

    this.doc.setFontSize(7)
    this.doc.setTextColor(128, 128, 128)
    this.doc.text('STATUS', boxX + (boxWidth / 2), boxY + 5, { align: 'center' })

    this.doc.setFontSize(10)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(34, 197, 94) // Green color
    this.doc.text(orderData.status.toUpperCase(), boxX + (boxWidth / 2), boxY + 11, { align: 'center' })

    y = Math.max(suppAddrY, boxY + boxHeight) + 5

    // 3. Items Table
    // Simple table with no borders, just lines
    const headers = ['No', 'Description', 'Unit', 'Price', 'Amount']

    // Sales Orders group the lines Hero first, then Zero, then anything else;
    // every other document keeps the stored sequence. Presentation only — the
    // total below is summed from `orderData.order_items` either way.
    const lineItems = isSalesOrderDoc
      ? sortSalesOrderLinesForDisplay(orderData.order_items, (item) => item.product?.product_name)
      : orderData.order_items

    const tableData = lineItems.map((item, index) => {
      const qty = item.qty || 0
      const unitPrice = item.unit_price || 0
      const total = item.line_total || (qty * unitPrice)

      // Same description as the Order print/save view: the Product Name plus the
      // bracketed flavour, without the marketing range words master data
      // repeats inside every variant name.
      const description =
        salesOrderLineDescription(item.product?.product_name, item.variant?.variant_name) || 'Product'

      return [
        (index + 1).toString(),
        description,
        qty.toString(),
        unitPrice.toFixed(2),
        `RM ${total.toFixed(2)}`
      ]
    })

    autoTable(this.doc, {
      startY: y,
      head: [headers],
      body: tableData,
      theme: 'plain', // Minimal theme
      styles: {
        fontSize: 9,
        cellPadding: { top: 3, bottom: 3, left: 2, right: 2 },
        minCellHeight: 8,
        valign: 'middle',
        textColor: [0, 0, 0],
        font: 'helvetica',
        overflow: 'ellipsize',
        cellWidth: 'wrap'
      },
      headStyles: {
        fontStyle: 'bold',
        textColor: [0, 0, 0],
        halign: 'left',
        fontSize: 11,
        cellPadding: { top: 2, bottom: 2, left: 2, right: 2 }
      },
      columnStyles: {
        0: { cellWidth: 12, halign: 'center' },   // No column - centered
        1: { cellWidth: 'auto', halign: 'left', fontStyle: 'normal' }, // Description - left aligned, not bold
        2: { cellWidth: 18, halign: 'center' },   // Unit - center aligned (header & data)
        3: { cellWidth: 22, halign: 'right' },    // Price - right aligned (header & data)
        4: { cellWidth: 28, halign: 'right' }     // Amount - right aligned (header & data)
      },
      margin: { left: this.margin, right: this.margin },
      didParseCell: (data) => {
        // Make headers for columns 2,3,4 center/right aligned to match data
        if (data.section === 'head') {
          if (data.column.index === 2) {
            data.cell.styles.halign = 'center'
          } else if (data.column.index >= 3) {
            data.cell.styles.halign = 'right'
          }
        }
      },
      didDrawCell: (data) => {
        // Draw horizontal line after each body row
        if (data.section === 'body') {
          this.doc.setDrawColor(230, 230, 230)
          this.doc.setLineWidth(0.1)
          const lineY = data.cell.y + data.cell.height
          this.doc.line(
            this.margin,
            lineY,
            this.pageWidth - this.margin,
            lineY
          )
        }
      },
      didDrawPage: (data) => {
        // Header line
        this.doc.setDrawColor(230, 230, 230)
        this.doc.setLineWidth(0.1)
        this.doc.line(this.margin, data.settings.startY + 7, this.pageWidth - this.margin, data.settings.startY + 7)
      }
    })

    y = (this.doc as any).lastAutoTable.finalY + 5

    // 4. Footer / Totals
    const totalAmount = orderData.order_items.reduce((sum, item) => sum + (item.line_total || 0), 0)

    this.doc.setFontSize(9)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(0, 0, 0)

    const isBoxedOrder = ['H2M', 'D2H', 'DH'].includes(orderData.order_type)
    if (isSalesOrderDoc || !isBoxedOrder) {
      const totalX = this.pageWidth - this.margin - 30
      this.doc.text('Total', totalX - 20, y, { align: 'right' })
    } else {
      // H2M / D2H: "Grand Total | total cases | amount", the case total centred
      // under the Unit column and the amount under Amount (column widths from
      // the table above: Unit 18, Price 22, Amount 28).
      const unitColumnRight = this.pageWidth - this.margin - 28 - 22
      const unitColumnCenter = unitColumnRight - 18 / 2
      const totalCases = orderData.order_items.reduce((sum, item) => sum + (item.qty || 0), 0)
      this.doc.text('Grand Total', unitColumnRight - 18 - 2, y, { align: 'right' })
      this.doc.text(totalCases.toLocaleString('en-MY'), unitColumnCenter, y, { align: 'center' })
    }
    this.doc.text(this.formatCurrency(totalAmount), this.pageWidth - this.margin, y, { align: 'right' })

    // 4b. Expected Delivery - the ordered cases in boxes, between the total and
    // the Terms. Sales Orders only; a PO or an invoice states no delivery figure.
    if (isSalesOrderDoc) {
      y = this.addExpectedDeliverySection(orderData, y + 8)
    } else if (isBoxedOrder && (documentData.doc_type || '').toUpperCase() === 'PO') {
      // 4c. Expected Boxes - the H2M / D2H purchase order's counterpart.
      y = this.addExpectedBoxesSection(orderData, y + 8)
    }

    // 5. Organization Terms & Conditions - verbatim, omitted when unset
    y = this.addTermsSection(orderData.organization_terms, y + 6)

    y += 24

    // 6. Signatures / Footer
    // The block needs roughly 50mm below its top edge: the two audit names, the
    // signatures, the signature lines, the dates and the footer note. Nothing
    // above guarantees that much room is left on a long document, so it takes a
    // fresh page rather than running off the bottom or printing over the Terms.
    const footerBlockHeight = 50
    if (y + footerBlockHeight > this.doc.internal.pageSize.getHeight() - this.margin) {
      this.doc.addPage()
      y = this.margin + 10
    }
    const footerY = y

    // Issued by (Left) - Organization stamp/signature
    this.doc.setFontSize(9)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(0, 0, 0)
    this.doc.text('Issued by:', this.margin, footerY)

    // Determine Issuer Name
    const isSellerIssued = ['SO', 'INVOICE', 'DO', 'RECEIPT', 'PAYMENT_REQUEST'].includes(documentData.doc_type)
    const issuerName = isSellerIssued ? orderData.seller_org.org_name : orderData.buyer_org.org_name

    // Organization Stamp - Use dynamic signature image if available (reduced 50% - half size)
    const stampX = this.margin + 14
    const stampY = footerY + 14
    const stampSize = 16  // Reduced to half size (50% smaller)
    
    // Prefer issuer_signature_image if provided (new logic), fallback to buyer_signature_image only for legacy PO support
    const signatureImage = orderData.issuer_signature_image || (isSellerIssued ? null : orderData.buyer_signature_image)

    if (signatureImage) {
      try {
        this.doc.addImage(signatureImage, 'PNG', stampX - stampSize / 2, stampY - stampSize / 2, stampSize, stampSize)
      } catch (e) {
        console.error('Error adding organization stamp:', e)
        // Fallback to simulated stamp
        this.drawDefaultStamp(stampX, stampY, issuerName, stampSize / 2)
      }
    } else {
      // Fallback: simulated stamp (half size)
      this.drawDefaultStamp(stampX, stampY, issuerName, stampSize / 2)
    }

    // Creator and approver names stay in separate, equal-width footer columns.
    // Signatures share a row below whichever wrapped name is taller.
    const creatorName = orderData.creator?.full_name || 'Not available'
    const approverName = orderData.approver?.full_name || 'Not available'
    const footerLayout = createClassicSignatureFooterLayout(
      this.pageWidth,
      this.margin,
      footerY,
      creatorName,
      approverName,
      (text, maxWidth) => this.doc.splitTextToSize(text, maxWidth) as string[]
    )
    const centerX = footerLayout.creator.centerX
    const footerRightX = footerLayout.approver.centerX

    this.doc.setFontSize(9)
    this.doc.setFont('helvetica', 'normal')
    this.doc.setTextColor(100, 100, 100)
    this.doc.text(footerLayout.creator.label, centerX, footerY, { align: 'center' })
    this.doc.text(footerLayout.creator.nameLines, centerX, footerLayout.nameY, {
      align: 'center',
      lineHeightFactor: footerLayout.nameLineHeight / 3.175
    })

    this.doc.text(footerLayout.approver.label, footerRightX, footerY, { align: 'center' })
    this.doc.text(footerLayout.approver.nameLines, footerRightX, footerLayout.nameY, {
      align: 'center',
      lineHeightFactor: footerLayout.nameLineHeight / 3.175
    })

    // Creator signature from the same authoritative creator user row.
    if (orderData.creator_signature_image) {
      try {
        this.doc.addImage(orderData.creator_signature_image, 'PNG', centerX - 15, footerLayout.signatureY, 30, 12)
      } catch (e) {
        console.error('Error adding creator signature:', e)
        // Draw placeholder squiggle
        this.doc.setDrawColor(0, 0, 0)
        this.doc.setLineWidth(0.5)
        this.doc.lines([[2, -1], [2, 1], [2, -1], [2, 1]], centerX - 4, footerLayout.signatureY + 8)
      }
    } else {
      // Draw placeholder squiggle
      this.doc.setDrawColor(0, 0, 0)
      this.doc.setLineWidth(0.5)
      this.doc.lines([[2, -1], [2, 1], [2, -1], [2, 1]], centerX - 4, footerLayout.signatureY + 8)
    }

    // Signature Line
    this.doc.setDrawColor(200, 200, 200)
    this.doc.line(centerX - 15, footerLayout.signatureLineY, centerX + 15, footerLayout.signatureLineY)

    // Date
    this.doc.setFontSize(8)
    this.doc.setTextColor(100, 100, 100)
    this.doc.text(this.formatDateLong(documentData.created_at), centerX, footerLayout.dateY, { align: 'center' })

    // Approver Signature - Use approver signature if available  
    if (orderData.approver_signature_image) {
      try {
        this.doc.addImage(orderData.approver_signature_image, 'PNG', footerRightX - 15, footerLayout.signatureY, 30, 12)
      } catch (e) {
        console.error('Error adding approver signature:', e)
        // Draw placeholder squiggle
        this.doc.setDrawColor(0, 0, 0)
        this.doc.setLineWidth(0.5)
        this.doc.lines([[2, -1], [2, 1], [2, -1], [2, 1]], footerRightX - 4, footerLayout.signatureY + 8)
      }
    } else {
      // Draw placeholder squiggle
      this.doc.setDrawColor(0, 0, 0)
      this.doc.setLineWidth(0.5)
      this.doc.lines([[2, -1], [2, 1], [2, -1], [2, 1]], footerRightX - 4, footerLayout.signatureY + 8)
    }

    // Signature Line
    this.doc.line(footerRightX - 15, footerLayout.signatureLineY, footerRightX + 15, footerLayout.signatureLineY)

    // Date
    const approvedDate = orderData.approved_at || documentData.created_at
    this.doc.text(this.formatDateLong(approvedDate), footerRightX, footerLayout.dateY, { align: 'center' })

    // Bottom text
    this.doc.setFontSize(7)
    this.doc.setTextColor(180, 180, 180)
    this.doc.text('This is a computer generated document.', this.margin, footerLayout.bottomY)

    return this.doc.output('blob')
  }

  /**
   * The issuing organization's Terms & Conditions, rendered exactly as saved.
   *
   * Sits between the totals and the signature footer, matching the browser
   * order report's ordering. Draws nothing when no terms are stored - there is
   * no default or placeholder text - and pages long terms rather than letting
   * them run over the footer.
   */
  private addTermsSection(terms: string | null | undefined, yPosition: number): number {
    const value = (terms || '')
    if (!value.trim()) return yPosition

    const maxWidth = this.pageWidth - this.margin * 2
    const lineHeight = 4
    const bottomLimit = 250

    let y = yPosition

    if (y > bottomLimit - lineHeight * 3) {
      this.doc.addPage()
      y = this.margin + 10
    }

    this.doc.setFontSize(9)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(0, 0, 0)
    this.doc.text('TERMS & CONDITIONS', this.margin, y)
    y += 5

    this.doc.setFont('helvetica', 'normal')
    this.doc.setFontSize(8)

    const lines = wrapTermsLines(value, (text, indent) => {
      const indentWidth = this.doc.getTextWidth(indent)
      return this.doc.splitTextToSize(text, Math.max(maxWidth - indentWidth, 10)) as string[]
    })

    for (const line of lines) {
      if (y > bottomLimit) {
        this.doc.addPage()
        y = this.margin + 10
      }
      if (line) this.doc.text(line, this.margin, y)
      y += lineHeight
    }

    return y + 3
  }

  private drawDefaultStamp(centerX: number, centerY: number, orgName: string, radius: number = 14): void {
    // Draw circular stamp with configurable size
    this.doc.setDrawColor(100, 100, 100)
    this.doc.setLineWidth(0.5)
    this.doc.circle(centerX, centerY, radius)
    this.doc.circle(centerX, centerY, radius - 2)

    // Parse org name for stamp text - scale font based on radius
    const nameParts = orgName.toUpperCase().split(' ')
    const fontSize = Math.max(3, Math.min(5, radius / 3))
    this.doc.setFontSize(fontSize)
    this.doc.setTextColor(100, 100, 100)

    const lineSpacing = radius / 3
    if (nameParts.length >= 3) {
      this.doc.text(nameParts[0], centerX, centerY - lineSpacing, { align: 'center' })
      this.doc.text(nameParts[1], centerX, centerY, { align: 'center' })
      this.doc.text(nameParts.slice(2).join(' '), centerX, centerY + lineSpacing, { align: 'center' })
    } else if (nameParts.length === 2) {
      this.doc.text(nameParts[0], centerX, centerY - lineSpacing / 2, { align: 'center' })
      this.doc.text(nameParts[1], centerX, centerY + lineSpacing / 2, { align: 'center' })
    } else {
      this.doc.text(orgName.toUpperCase(), centerX, centerY, { align: 'center' })
    }
  }
}


/**
 * Get the appropriate template class based on template type
 */
export function getTemplateGenerator(
  templateType: DocumentTemplateType,
  signatures: TemplateSignatureData[] = []
): ClassicTemplate | null {
  switch (templateType) {
    case 'classic':
      return new ClassicTemplate(signatures)
    case 'detailed':
      // Return null to use the existing PDFGenerator
      return null
    default:
      return null
  }
}

/**
 * Get document title based on document type
 */
export function getDocumentTitle(docType: string): string {
  const typeMap: Record<string, string> = {
    'PO': 'Purchase Order',
    'SO': 'Sales Order',
    'DO': 'Delivery Order',
    'INVOICE': 'Invoice',
    'RECEIPT': 'Receipt',
    'PAYMENT': 'Payment Advice',
    'PAYMENT_REQUEST': 'Balance Payment Request'
  }
  return typeMap[docType?.toUpperCase()] || docType || 'Document'
}
