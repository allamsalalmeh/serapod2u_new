import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { wrapTermsLines } from '@/lib/organizations/terms'
import { formatOrderExpectedBoxes } from '@/lib/orders/packaging'
import { qrCaseTotals } from '@/lib/orders/qr-buffer'
import { resolvePartyColumnHeading } from '@/lib/documents/counterparty'
import { formatDateKeyLong, isDateKey } from '@/lib/orders/order-date'
import {
  compressSignatureForPdf,
  formatFileSize,
  type CompressionResult
} from './pdf-optimizer'

interface PaymentTerms {
  deposit_pct?: number
  deposit_percentage?: number
  depositPercent?: number
  deposit?: number
  balance_pct?: number
  balance_percentage?: number
  balancePercent?: number
  balance?: number
  use_traditional?: boolean
  traditional?: boolean
  is_traditional?: boolean
  [key: string]: any
}

interface PartyOrganization {
  org_name: string
  /** `organizations.org_type_code`, e.g. 'DIST' — drives the party label. */
  org_type_code?: string | null
  address?: string | null
  address_line2?: string | null
  city?: string | null
  state?: string | null
  state_id?: string | null
  state_code?: string | null
  state_name?: string | null
  postal_code?: string | null
  country_code?: string | null
  contact_name?: string | null
  contact_phone?: string | null
  contact_email?: string | null
}

interface RelatedDocumentSummary {
  id?: string
  doc_no?: string
  display_doc_no?: string  // New format
  status?: string
  created_at?: string
  total_amount?: number | null
  payment_percentage?: number | null
  payload?: Record<string, any> | null
}

interface OrderData {
  order_no: string
  order_type: string
  status: string
  created_at: string
  /** Business/SO date (orders.order_date, YYYY-MM-DD). Absent before the order_date migration. */
  order_date?: string | null
  approved_by?: string
  approved_at?: string
  payment_terms?: PaymentTerms | string | null
  estimated_eta?: string
  ship_to_location?: string
  ship_to_manager?: string
  approver?: {
    full_name: string
    role_name: string
    signature_url: string | null
  }
  creator?: {
    full_name: string
    signature_url: string | null
  } | null
  approval_hash?: string
  approver_signature_image?: string | null
  buyer_logo_image?: string | null
  seller_logo_image?: string | null
  warehouse_org_id?: string | null
  /**
   * The issuing organization's own Terms & Conditions
   * (organizations.settings.terms_conditions), resolved upstream so the
   * document always carries the terms of the org that issued it. Distinct from
   * `payment_terms`, which stays the deposit/balance schedule.
   */
  organization_terms?: string | null
  buyer_org: PartyOrganization
  seller_org: PartyOrganization
  warehouse_org?: PartyOrganization | null
  order_items: Array<{
    product?: { product_name: string; product_code: string }
    variant?: { variant_name: string }
    qty: number
    qty_cases?: number
    units_per_case?: number
    unit_price: number
    line_total: number
  }>
  /** `orders.units_per_case` — the order-level cases-per-box setting. */
  units_per_case?: number | null
  /** `orders.qr_buffer_percent` — the H2M manufacturer buffer percent. */
  qr_buffer_percent?: number | null
}

interface DocumentData {
  doc_no: string
  display_doc_no?: string  // New format: PO26000001
  doc_type: string
  status: string
  created_at: string
  acknowledged_at?: string
  acknowledged_by?: string
  payment_terms?: string
  estimated_eta?: string
  payment_percentage?: number  // For receipts: 50 for deposit, 100 for final
  total_amount?: number
  payload?: Record<string, any>
  linked_invoice?: RelatedDocumentSummary | null
  source_request?: RelatedDocumentSummary | null
  requested_percent?: number | null
  related_documents?: {
    deposit_invoice?: RelatedDocumentSummary | null
    deposit_payment?: RelatedDocumentSummary | null
    deposit_receipt?: RelatedDocumentSummary | null
  }
  acknowledger?: {
    full_name: string
    role_name: string
    signature_url: string | null
  }
  acknowledgement_hash?: string
  acknowledger_signature_image?: string | null
}

interface SignatureData {
  signer_name: string
  signer_role: string
  signed_at: string
  integrity_hash?: string
  signature_hash?: string
  signature_image_url: string | null
  signature_image_data?: string | null
}

// PDF compression statistics
export interface PDFCompressionStats {
  logoOriginalSize: number
  logoCompressedSize: number
  signatureOriginalSize: number
  signatureCompressedSize: number
  totalSavings: number
}

export class PDFGenerator {
  private doc: jsPDF
  private signatures: SignatureData[]
  private pageWidth: number = 210 // A4 width in mm
  private margin: number = 15
  private signatureTintCache = new Map<string, string>()

  // Compression tracking
  private compressionStats: PDFCompressionStats = {
    logoOriginalSize: 0,
    logoCompressedSize: 0,
    signatureOriginalSize: 0,
    signatureCompressedSize: 0,
    totalSavings: 0
  }

  // Cached compressed logo to avoid re-compression
  private compressedLogoCache: string | null = null

  constructor(signatures: SignatureData[] = []) {
    this.doc = new jsPDF({
      compress: true  // Enable internal PDF compression
    })
    this.signatures = signatures
  }

  // Get compression statistics after PDF generation
  public getCompressionStats(): PDFCompressionStats {
    return { ...this.compressionStats }
  }

  private formatCurrency(amount: number | string): string {
    const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount
    if (isNaN(numAmount)) return 'RM 0.00'
    return `RM ${numAmount.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  /**
   * The order's business date for an order/SO header: orders.order_date as a
   * calendar date (never shifted through a UTC instant), falling back to the
   * legacy timestamp for rows read before the order_date migration.
   */
  private formatOrderBusinessDate(orderDate: string | null | undefined, legacyTimestamp: string): string {
    return orderDate && isDateKey(orderDate.slice(0, 10))
      ? formatDateKeyLong(orderDate)
      : this.formatDate(legacyTimestamp)
  }

  private formatDate(dateString: string): string {
    const date = new Date(dateString)
    const day = date.getDate()
    const month = date.toLocaleDateString('en-MY', { month: 'short' })
    const year = date.getFullYear()
    return `${day} ${month} ${year}`
  }

  private parseNumeric(value: unknown): number | undefined {
    if (value === null || value === undefined) {
      return undefined
    }

    if (typeof value === 'number') {
      return isFinite(value) ? value : undefined
    }

    if (typeof value === 'string') {
      const normalized = value.replace(/[^0-9.,+-]/g, '').replace(/,/g, '')
      const parsed = parseFloat(normalized)
      return isFinite(parsed) ? parsed : undefined
    }

    return undefined
  }

  private normalizePercentage(value: unknown): number | undefined {
    const numeric = this.parseNumeric(value)
    if (numeric === undefined || !isFinite(numeric)) {
      return undefined
    }

    if (numeric < 0) {
      return 0
    }

    if (numeric <= 1) {
      return Math.min(Math.max(numeric * 100, 0), 100)
    }

    return Math.min(Math.max(numeric, 0), 100)
  }

  private normalizePaymentTerms(paymentTerms: OrderData['payment_terms']): {
    depositPercentage?: number
    balancePercentage?: number
    useTraditional?: boolean
  } {
    if (!paymentTerms) {
      return {}
    }

    let terms: PaymentTerms | null = null

    if (typeof paymentTerms === 'string') {
      try {
        terms = JSON.parse(paymentTerms) as PaymentTerms
      } catch {
        return {}
      }
    } else if (typeof paymentTerms === 'object' && !Array.isArray(paymentTerms)) {
      terms = paymentTerms as PaymentTerms
    }

    if (!terms) {
      return {}
    }

    const toPercentage = (value: unknown): number | undefined => {
      if (value === null || value === undefined) return undefined
      const numeric = typeof value === 'string' ? parseFloat(value) : Number(value)
      if (!isFinite(numeric)) return undefined
      if (numeric < 0) return 0
      if (numeric > 100 && numeric <= 1000) {
        // Already expressed as percentage (>100 handled separately)
        return Math.min(numeric, 100)
      }
      if (numeric > 1) {
        return Math.min(numeric, 100)
      }
      return Math.min(Math.max(numeric * 100, 0), 100)
    }

    const depositRaw =
      terms.deposit_percentage ??
      terms.deposit_pct ??
      terms.depositPercent ??
      terms.deposit

    const balanceRaw =
      terms.balance_percentage ??
      terms.balance_pct ??
      terms.balancePercent ??
      terms.balance

    const depositPercentage = toPercentage(depositRaw)
    const balancePercentage =
      toPercentage(balanceRaw) ??
      (typeof depositPercentage === 'number'
        ? Math.max(100 - depositPercentage, 0)
        : undefined)

    const useTraditional = Boolean(
      terms.use_traditional ?? terms.traditional ?? terms.is_traditional ?? false
    )

    return {
      depositPercentage,
      balancePercentage,
      useTraditional
    }
  }

  private formatPaymentTermsLabel(paymentTerms: OrderData['payment_terms']): string {
    if (!paymentTerms) {
      return 'Net 30 Days'
    }

    if (typeof paymentTerms === 'string') {
      const trimmed = paymentTerms.trim()
      if (!trimmed) {
        return 'Net 30 Days'
      }

      try {
        const parsed = JSON.parse(trimmed)
        return this.formatPaymentTermsLabel(parsed)
      } catch {
        return trimmed
      }
    }

    const normalized = this.normalizePaymentTerms(paymentTerms)

    if (normalized.useTraditional) {
      return 'Traditional credit terms'
    }

    const segments: string[] = []

    if (typeof normalized.depositPercentage === 'number') {
      segments.push(`${normalized.depositPercentage}% deposit`)
    }

    if (typeof normalized.balancePercentage === 'number') {
      segments.push(`${normalized.balancePercentage}% balance`)
    }

    if (segments.length > 0) {
      return segments.join(', ')
    }

    return 'Net 30 Days'
  }

  private buildAddressLines(org?: Partial<PartyOrganization> | null, fallbackAddress?: string[]): string[] {
    const lines: string[] = []

    if (org?.address) {
      lines.push(org.address)
    }

    if (org?.address_line2) {
      lines.push(org.address_line2)
    }

    const localityParts: string[] = []
    if (org?.postal_code) localityParts.push(org.postal_code)
    if (org?.city) localityParts.push(org.city)
    if (localityParts.length > 0) {
      lines.push(localityParts.join(' '))
    }

    const regionParts: string[] = []
    const normalizedState = this.normalizeStateValue(org)
    if (normalizedState) {
      regionParts.push(normalizedState)
    }
    if (org?.country_code) regionParts.push(org.country_code)
    if (regionParts.length > 0) {
      lines.push(regionParts.join(', '))
    }

    if (lines.length === 0 && fallbackAddress?.length) {
      lines.push(...fallbackAddress)
    }

    return lines
  }

  private buildPartyLines(
    org?: PartyOrganization | null,
    options?: {
      fallbackName?: string
      fallbackAddress?: string[]
      fallbackAttention?: string
    }
  ): string[] {
    const lines: string[] = []
    const name = org?.org_name || options?.fallbackName
    if (name) {
      lines.push(name)
    }

    lines.push(...this.buildAddressLines(org, options?.fallbackAddress))

    const attention = org?.contact_name || options?.fallbackAttention
    if (attention) {
      lines.push(`Attn: ${attention}`)
    }

    if (org?.contact_email) {
      lines.push(`Email: ${org.contact_email}`)
    }

    if (org?.contact_phone) {
      lines.push(`Phone: ${org.contact_phone}`)
    }

    return lines
  }

  private resolveInvoiceStage(payload?: Record<string, any> | null): 'deposit' | 'balance' | 'full' {
    if (!payload) {
      return 'full'
    }

    if (payload.is_deposit_invoice === true) return 'deposit'
    if (payload.is_balance_invoice === true) return 'balance'
    if (payload.is_final_invoice === true) return 'balance'
    if (payload.is_full_invoice === true) return 'full'

    const candidateStrings = [
      payload.invoice_stage,
      payload.stage,
      payload.payment_stage,
      payload.type,
      payload.flow_stage,
      payload.phase,
      payload.step
    ]
      .filter((value) => typeof value === 'string' && value.length > 0)
      .map((value) => value.toLowerCase())

    if (candidateStrings.some((value) => value.includes('balance') || value.includes('final') || value.includes('completion'))) {
      return 'balance'
    }

    if (candidateStrings.some((value) => value.includes('deposit') || value.includes('initial') || value.includes('50'))) {
      return 'deposit'
    }

    const percentageCandidates = [payload.percentage, payload.coverage_pct, payload.invoice_percentage]
      .map((value) => (typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : undefined))
      .filter((value) => typeof value === 'number' && isFinite(value)) as number[]

    if (percentageCandidates.length > 0) {
      const pct = percentageCandidates[0]
      if (pct >= 100) return 'full'
      if (pct > 0) return 'deposit'
    }

    return 'full'
  }

  private looksLikeIdentifier(value?: string | null): boolean {
    if (typeof value !== 'string') {
      return false
    }

    const trimmed = value.trim()
    if (trimmed.length === 0) {
      return false
    }

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const longHexRegex = /^[0-9a-f]{16,}$/i

    return uuidRegex.test(trimmed) || longHexRegex.test(trimmed)
  }

  private normalizeStateValue(org?: Partial<PartyOrganization> | null): string | null {
    if (!org) {
      return null
    }

    const candidates = [org.state_name, org.state, org.state_code, org.state_id]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0 && !this.looksLikeIdentifier(candidate)) {
        return candidate.trim()
      }
    }

    return null
  }

  private toTitleCase(value: string): string {
    return value
      .toLowerCase()
      .split(' ')
      .filter((segment) => segment.length > 0)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ')
  }

  private formatRequestReason(reason?: string | null, paymentTerms?: OrderData['payment_terms']): string {
    // If reason is provided, use it
    if (reason) {
      const normalized = reason.toString().toUpperCase()
      switch (normalized) {
        case 'BALANCE_50_AFTER_RECEIVE':
          return 'Balance 50% payment'
        case 'MANUAL_REQUEST':
          return 'Manual balance payment request'
        case 'ADJUSTMENT_REQUEST':
          return 'Balance payment adjustment requested by HQ'
        default:
          return this.toTitleCase(reason.toString().replace(/[_-]+/g, ' '))
      }
    }

    // If no reason provided, derive from payment terms
    if (paymentTerms) {
      const normalized = this.normalizePaymentTerms(paymentTerms)
      if (normalized.balancePercentage) {
        return `Balance ${Math.round(normalized.balancePercentage)}% payment`
      }
    }

    return 'Balance payment'
  }

  private formatTriggerMode(mode?: string | null): string {
    if (!mode) {
      return 'Manual trigger'
    }

    const normalized = mode.toString().toLowerCase()
    switch (normalized) {
      case 'on_first_receive':
        return 'Auto-triggered when production complete'
      case 'on_production_complete':
        return 'Auto-triggered when production complete'
      case 'on_all_receive':
        return 'Triggered after all warehouse receives are completed'
      case 'manual':
        return 'Manual trigger'
      case 'api':
        return 'Triggered via API integration'
      default:
        return this.toTitleCase(mode.toString().replace(/[_-]+/g, ' '))
    }
  }

  private measureInfoLines(lines: Array<string | null | undefined>, maxWidth: number): number {
    let height = 0

    lines
      .map((line) => (typeof line === 'string' ? line.trim() : ''))
      .filter((line) => line.length > 0)
      .forEach((line) => {
        const parts = line.replace(/\r\n/g, '\n').split(/\n+/)
        parts.forEach((part, index) => {
          const trimmedPart = part.trim()
          if (trimmedPart.length === 0) return

          const wrapped = this.doc.splitTextToSize(trimmedPart, maxWidth) as string[]
          if (wrapped.length === 0) return

          height += wrapped.length * 4

          if (index < parts.length - 1) {
            height += 2
          }
        })
      })

    return height
  }

  private renderInfoLines(lines: Array<string | null | undefined>, x: number, startY: number, maxWidth: number): number {
    let y = startY

    lines
      .map((line) => (typeof line === 'string' ? line.trim() : ''))
      .filter((line) => line.length > 0)
      .forEach((line) => {
        const parts = line.replace(/\r\n/g, '\n').split(/\n+/)
        parts.forEach((part, index) => {
          if (part.trim().length === 0) return
          const wrapped = this.doc.splitTextToSize(part.trim(), maxWidth) as string[]
          wrapped.forEach((segment) => {
            this.doc.text(segment, x, y, { maxWidth })
            y += 4
          })
          if (index < parts.length - 1) {
            y += 2
          }
        })
      })

    return y
  }

  private drawWrappedText(text: string, x: number, startY: number, maxWidth: number, lineHeight: number = 4): number {
    if (!text) return startY

    const lines = this.doc.splitTextToSize(text, maxWidth) as string[]
    let currentY = startY

    lines.forEach((line: string, index: number) => {
      this.doc.text(line, x, currentY + index * lineHeight, { maxWidth })
    })

    return currentY + lines.length * lineHeight
  }

  private format12HourTime(dateString: string): string {
    const date = new Date(dateString)
    return date.toLocaleString('en-MY', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  }

  private normalizeSignatureDataUrl(imageData: string): string {
    if (!imageData) {
      return imageData
    }

    if (imageData.startsWith('data:')) {
      return imageData
    }

    if (imageData.startsWith('http')) {
      return imageData
    }

    return `data:image/png;base64,${imageData}`
  }

  private clampColor(value: number): number {
    if (!Number.isFinite(value)) {
      return 0
    }
    return Math.max(0, Math.min(Math.round(value), 255))
  }

  private applyBlueTintToPixelArray(data: Uint8ClampedArray | Uint8Array): void {
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]
      if (alpha === 0) {
        continue
      }

      const red = data[i]
      const green = data[i + 1]
      const blue = data[i + 2]

      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue

      if (luminance >= 250 && red >= 240 && green >= 240 && blue >= 240) {
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
        continue
      }

      data[i] = this.clampColor(luminance * 0.05)
      data[i + 1] = this.clampColor(luminance * 0.35)
      data[i + 2] = this.clampColor(luminance)
    }
  }

  private async tintSignatureImageBlue(imageData: string): Promise<string> {
    const normalized = this.normalizeSignatureDataUrl(imageData)
    const cached = this.signatureTintCache.get(normalized)
    if (cached) {
      return cached
    }

    try {
      const tinted = typeof window !== 'undefined' && typeof document !== 'undefined'
        ? await this.tintSignatureImageBlueBrowser(normalized)
        : await this.tintSignatureImageBlueServer(normalized)

      this.signatureTintCache.set(normalized, tinted)
      return tinted
    } catch (error) {
      console.error('Failed to tint signature image to blue:', error)
      this.signatureTintCache.set(normalized, normalized)
      return normalized
    }
  }

  private async tintSignatureImageBlueBrowser(imageData: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth || image.width
          canvas.height = image.naturalHeight || image.height

          const context = canvas.getContext('2d')
          if (!context) {
            reject(new Error('Canvas context unavailable for signature tinting'))
            return
          }

          context.drawImage(image, 0, 0)
          const imageDataObject = context.getImageData(0, 0, canvas.width, canvas.height)
          this.applyBlueTintToPixelArray(imageDataObject.data)
          context.putImageData(imageDataObject, 0, 0)

          resolve(canvas.toDataURL('image/png', 0.5))  // More aggressive compression with quality 0.5
        } catch (canvasError) {
          reject(canvasError)
        }
      }

      image.onerror = () => reject(new Error('Failed to load signature image for tinting'))
      image.src = imageData
    })
  }

  private async tintSignatureImageBlueServer(imageData: string): Promise<string> {
    const normalized = this.normalizeSignatureDataUrl(imageData)
    const base64 = normalized.includes('base64,')
      ? normalized.substring(normalized.indexOf('base64,') + 7)
      : normalized.replace(/^data:image\/[a-zA-Z+]+;base64,/, '')

    const { PNG } = await import('pngjs')
    const originalBuffer = Buffer.from(base64, 'base64')
    const originalSize = originalBuffer.length

    const png = PNG.sync.read(originalBuffer)
    this.applyBlueTintToPixelArray(png.data)

    // Write with maximum compression
    const tintedBuffer = PNG.sync.write(png, {
      filterType: 4,      // Paeth filter for best compression
      deflateLevel: 9,    // Maximum compression level
      deflateStrategy: 1  // Filtered strategy
    })

    // Track signature compression stats
    const compressedSize = tintedBuffer.length
    this.compressionStats.signatureOriginalSize += originalSize
    this.compressionStats.signatureCompressedSize += compressedSize
    this.compressionStats.totalSavings += Math.max(0, originalSize - compressedSize)

    return `data:image/png;base64,${tintedBuffer.toString('base64')}`
  }

  private async drawSignatureImageBlue(imageData: string, x: number, y: number, width: number, height: number): Promise<boolean> {
    try {
      // Compress signature first, then tint
      const compressed = await compressSignatureForPdf(imageData)
      const tinted = await this.tintSignatureImageBlue(compressed.data)
      this.doc.addImage(tinted, 'PNG', x, y, width, height)
      return true
    } catch (error) {
      console.error('Error adding tinted signature image:', error)
      try {
        const normalized = this.normalizeSignatureDataUrl(imageData)
        this.doc.addImage(normalized, 'PNG', x, y, width, height)
        return true
      } catch (fallbackError) {
        console.error('Fallback signature image render failed:', fallbackError)
        return false
      }
    }
  }

  private imageFormat(imageData: string): 'PNG' | 'JPEG' | 'WEBP' {
    if (/^data:image\/(?:jpe?g);/i.test(imageData)) return 'JPEG'
    if (/^data:image\/webp;/i.test(imageData)) return 'WEBP'
    return 'PNG'
  }

  private dataUrlByteLength(imageData: string): number {
    const base64 = imageData.includes('base64,')
      ? imageData.slice(imageData.indexOf('base64,') + 7)
      : imageData
    return Buffer.from(base64, 'base64').length
  }

  private async addCompanyLogo(yPosition: number, logoImage?: string | null): Promise<number> {
    const imgWidth = 40
    const imgMaxHeight = 15

    try {
      // Use cached compressed logo if available
      if (this.compressedLogoCache) {
        logoImage = this.compressedLogoCache
      }

      if (logoImage) {
        const props = this.doc.getImageProperties(logoImage)
        const ratio = props.width / props.height
        const renderedWidth = Math.min(imgWidth, imgMaxHeight * ratio)
        const renderedHeight = renderedWidth / ratio
        const xPos = (this.pageWidth - renderedWidth) / 2
        const byteLength = this.dataUrlByteLength(logoImage)

        this.compressedLogoCache = logoImage
        this.compressionStats.logoOriginalSize = byteLength
        this.compressionStats.logoCompressedSize = byteLength
        this.doc.addImage(logoImage, this.imageFormat(logoImage), xPos, yPosition, renderedWidth, renderedHeight)
        return yPosition + renderedHeight + 5
      }
    } catch (error) {
      console.error('Error rendering organization logo:', error)
    }

    // Graceful fallback only when the issuer has no usable organization logo.
    this.doc.setFontSize(8)
    this.doc.setFont('helvetica', 'normal')
    this.doc.setTextColor(150, 150, 150)
    this.doc.text('LOGO', this.pageWidth / 2, yPosition + 5, { align: 'center' })
    return yPosition + 10
  }

  private addDocumentHeader(title: string, yPosition: number): number {
    // Professional document title
    this.doc.setFontSize(16)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(0, 0, 0)
    this.doc.text(title, this.margin, yPosition)

    // Underline
    this.doc.setLineWidth(0.5)
    this.doc.line(this.margin, yPosition + 2, this.pageWidth - this.margin, yPosition + 2)

    return yPosition + 8
  }

  private addInfoTable(data: Array<{ label: string, value: string }>, yPosition: number, columns: number = 2): number {
    const colWidth = (this.pageWidth - 2 * this.margin) / columns
    const rowHeight = 7
    let y = yPosition

    // Draw border
    const tableHeight = Math.ceil(data.length / columns) * rowHeight
    this.doc.setDrawColor(180, 180, 180)
    this.doc.setLineWidth(0.3)
    this.doc.rect(this.margin, y, this.pageWidth - 2 * this.margin, tableHeight)

    // Draw grid lines
    for (let i = 0; i < data.length; i++) {
      const col = i % columns
      const row = Math.floor(i / columns)
      const x = this.margin + col * colWidth
      const cellY = y + row * rowHeight

      // Vertical divider
      if (col > 0) {
        this.doc.line(x, cellY, x, cellY + rowHeight)
      }

      // Horizontal divider
      if (row > 0 && col === 0) {
        this.doc.line(this.margin, cellY, this.pageWidth - this.margin, cellY)
      }

      // Label (bold)
      this.doc.setFontSize(9)
      this.doc.setFont('helvetica', 'bold')
      this.doc.setTextColor(0, 0, 0)
      this.doc.text(data[i].label, x + 2, cellY + 5)

      // Value (normal) - with spacing gap
      this.doc.setFont('helvetica', 'normal')
      const labelWidth = this.doc.getTextWidth(data[i].label)
      this.doc.text(data[i].value, x + 2 + labelWidth + 2, cellY + 5)
    }

    return y + tableHeight + 5
  }

  private addPartiesSection(orderData: OrderData, yPosition: number, docType: string): number {
    let y = yPosition

    // PARTIES Section Header
    this.doc.setFontSize(11)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(0, 0, 0)
    this.doc.text('PARTIES', this.margin, y)
    y += 7

    // Table header
    const colWidths = [58, 58, 64]
    const startX = this.margin
    const tableWidth = this.pageWidth - 2 * this.margin
    const cellPaddingX = 2
    const cellPaddingY = 4

    // Header row
    this.doc.setFillColor(220, 220, 220)
    this.doc.rect(startX, y, tableWidth, 7, 'F')
    this.doc.setDrawColor(100, 100, 100)
    this.doc.setLineWidth(0.3)
    this.doc.rect(startX, y, tableWidth, 7)

    this.doc.setFontSize(9)
    this.doc.setFont('helvetica', 'bold')

    // Column headers. Each party is named by its own organization type, so a
    // distributor buyer reads as DISTRIBUTOR rather than the generic BUYER (HQ).
    let colX = startX
    this.doc.text(resolvePartyColumnHeading(orderData.buyer_org, 'BUYER (HQ)'), colX + cellPaddingX, y + 5)
    colX += colWidths[0]
    this.doc.line(colX, y, colX, y + 7)
    this.doc.text(
      resolvePartyColumnHeading(orderData.seller_org, 'SUPPLIER / MANUFACTURER'),
      colX + cellPaddingX,
      y + 5
    )
    colX += colWidths[1]
    this.doc.line(colX, y, colX, y + 7)
    this.doc.text('SHIP TO / DELIVERY LOCATION', colX + cellPaddingX, y + 5)

    y += 7

    // Prepare column content
    const buyerLines = this.buildPartyLines(orderData.buyer_org)
    const sellerLines = this.buildPartyLines(orderData.seller_org)
    const shipToFallbackAddress = orderData.ship_to_location ? [orderData.ship_to_location] : undefined
    // Use buyer_org for Ship To location as requested
    const shipToLines = this.buildPartyLines(orderData.buyer_org, {
      fallbackName: orderData.ship_to_location || orderData.buyer_org?.org_name,
      fallbackAddress: shipToFallbackAddress,
      fallbackAttention: orderData.ship_to_manager || undefined
    })

    const buyerContentHeight = this.measureInfoLines(buyerLines, colWidths[0] - cellPaddingX * 2)
    const sellerContentHeight = this.measureInfoLines(sellerLines, colWidths[1] - cellPaddingX * 2)
    const shipToContentHeight = this.measureInfoLines(shipToLines, colWidths[2] - cellPaddingX * 2)

    const minContentHeight = 12
    const contentHeight = Math.max(buyerContentHeight, sellerContentHeight, shipToContentHeight, minContentHeight) + cellPaddingY * 2

    // Content row
    this.doc.rect(startX, y, tableWidth, contentHeight)

    this.doc.setFont('helvetica', 'normal')
    this.doc.setFontSize(8)

    // Buyer column
    colX = startX
    this.renderInfoLines(buyerLines, colX + cellPaddingX, y + cellPaddingY, colWidths[0] - cellPaddingX * 2)

    // Vertical line
    colX += colWidths[0]
    this.doc.line(colX, y, colX, y + contentHeight)

    // Seller column
    this.renderInfoLines(sellerLines, colX + cellPaddingX, y + cellPaddingY, colWidths[1] - cellPaddingX * 2)

    // Vertical line
    colX += colWidths[1]
    this.doc.line(colX, y, colX, y + contentHeight)

    // Ship to column
    this.renderInfoLines(shipToLines, colX + cellPaddingX, y + cellPaddingY, colWidths[2] - cellPaddingX * 2)

    return y + contentHeight + 10
  }

  private addOrderLinesSection(orderData: OrderData, yPosition: number): number {
    let y = yPosition

    // ORDER LINES Section Header
    this.doc.setFontSize(11)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(0, 0, 0)
    this.doc.text('ORDER LINES', this.margin, y)
    y += 7

    // Prepare table data
    const tableData = orderData.order_items.map((item, index) => {
      // Column 2: Product Name
      const productName = item.product?.product_name || 'Product'

      // Column 3: Variant Name
      const variantName = item.variant?.variant_name || ''

      // The ordered quantity is counted in cases; 100 cases fill one box. The
      // stored columns still read qty_cases / units_per_case — only the
      // customer-facing vocabulary changed, not the data.
      const qtyCases = Number(item.qty || 0).toLocaleString()
      const boxes = item.qty_cases || Math.ceil((item.qty || 0) / (item.units_per_case || 100))

      return [
        (index + 1).toString(),
        productName,
        variantName,
        qtyCases,
        boxes.toString(),
        this.formatCurrency(item.unit_price || 0),
        (item.line_total || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      ]
    })

    autoTable(this.doc, {
      startY: y,
      head: [[
        '#',
        'Product Name',
        'Description',
        'Qty Cases',
        'Boxes',
        'Price/Case (RM)',
        'Total (RM)'
      ]],
      body: tableData,
      theme: 'grid',
      styles: {
        fontSize: 8,
        cellPadding: 2,
        lineColor: [100, 100, 100],
        lineWidth: 0.3
      },
      headStyles: {
        fillColor: [255, 255, 255],
        textColor: [0, 0, 0],
        fontStyle: 'bold',
        halign: 'left',
        lineWidth: 0.3,
        lineColor: [100, 100, 100]
      },
      columnStyles: {
        0: { cellWidth: 8, halign: 'center' },
        1: { cellWidth: 28 },
        2: { cellWidth: 60 },
        3: { cellWidth: 26, halign: 'right' },
        4: { cellWidth: 20, halign: 'right' },
        5: { cellWidth: 19, halign: 'right' },
        6: { cellWidth: 19, halign: 'right', fontSize: 7 }
      },
      margin: { left: this.margin, right: this.margin },
      tableWidth: this.pageWidth - 2 * this.margin
    })

    return (this.doc as any).lastAutoTable.finalY + 8
  }

  private addNotesSection(yPosition: number): number {
    let y = yPosition

    this.doc.setFontSize(9)
    this.doc.setFont('helvetica', 'bold')
    this.doc.text('Notes to Manufacturer:', this.margin, y)
    y += 5

    this.doc.setFont('helvetica', 'normal')
    this.doc.setFontSize(8)
    const notes = [
      '- Each master carton must include printed QR master + internal unit QRs.',
      '- First scan at shop will trigger reward points.',
      '- Do not mix flavors in the same carton.'
    ]

    notes.forEach(note => {
      this.doc.text(note, this.margin, y)
      y += 4
    })

    return y + 5
  }

  private addSummarySection(orderData: OrderData, yPosition: number, options?: {
    customRows?: Array<[string, string]>
    grandTotalOverride?: number
    grandTotalLabel?: string
    spacingAfterTable?: number
  }): number {
    let y = yPosition

    // Calculate totals
    const subtotal = orderData.order_items.reduce((sum, item) => sum + (parseFloat(item.line_total.toString()) || 0), 0)
    const tax = subtotal * 0.00 // 0% tax as per image
    const grandTotal = typeof options?.grandTotalOverride === 'number'
      ? options.grandTotalOverride
      : subtotal + tax

    // SUMMARY Header
    this.doc.setFontSize(11)
    this.doc.setFont('helvetica', 'bold')
    this.doc.text('SUMMARY', this.margin, y)
    y += 7

    // Summary table
    const summaryTableWidth = this.pageWidth - 2 * this.margin
    const labelColumnWidth = summaryTableWidth * 0.65
    const valueColumnWidth = summaryTableWidth - labelColumnWidth

    const summaryData = options?.customRows ?? [
      ['Subtotal', this.formatCurrency(subtotal)],
      ['Discount / Campaign', 'RM 0.00'],
      ['Tax (0%)', this.formatCurrency(tax)]
    ]

    const grandTotalLabel = options?.grandTotalLabel ?? 'GRAND TOTAL'
    const rowsWithGrandTotal: Array<[string, string]> = [
      ...summaryData,
      [grandTotalLabel, this.formatCurrency(grandTotal)]
    ]

    autoTable(this.doc, {
      startY: y,
      body: rowsWithGrandTotal,
      theme: 'grid',
      styles: {
        fontSize: 9,
        cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
        lineColor: [100, 100, 100],
        lineWidth: 0.3
      },
      columnStyles: {
        0: { cellWidth: labelColumnWidth, halign: 'left', fontStyle: 'normal' },
        1: { cellWidth: valueColumnWidth, halign: 'right', fontStyle: 'normal' }
      },
      margin: { left: this.margin, right: this.margin },
      tableWidth: summaryTableWidth,
      didParseCell: (data) => {
        if (data.row.index === rowsWithGrandTotal.length - 1) {
          data.cell.styles.fontSize = 10
          data.cell.styles.fontStyle = 'bold'
          data.cell.styles.fillColor = [220, 220, 220]
          data.cell.styles.textColor = [0, 0, 0]
        }
      }
    })

    const summaryTable = (this.doc as any).lastAutoTable
    y = summaryTable.finalY

    // Determine alignment using the rendered table metrics
    // Preserve return value semantics using the rendered table height plus spacing
    const spacingAfterTable = options?.spacingAfterTable ?? 10
    return summaryTable.finalY + spacingAfterTable
  }

  /**
   * "Expected Boxes: 55 Standard Boxes + 1 Small Box" below the summary of an
   * H2M / D2H order document — the same shared figure the order detail page
   * prints (`formatOrderExpectedBoxes`). An H2M order also states its
   * manufacturer buffer, which is not boxed. Other order types draw nothing.
   */
  private addExpectedBoxesSection(orderData: OrderData, yPosition: number): number {
    if (!['H2M', 'D2H', 'DH'].includes(orderData.order_type)) return yPosition

    const label = formatOrderExpectedBoxes(orderData.order_items, orderData.units_per_case)
    const totalCases = orderData.order_items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)
    const buffer = orderData.order_type === 'H2M' ? qrCaseTotals(totalCases, orderData.qr_buffer_percent) : null
    const showBuffer = !!buffer && buffer.bufferCases > 0

    let y = yPosition
    const needed = showBuffer ? 12 : 7
    if (y + needed > this.doc.internal.pageSize.getHeight() - this.margin) {
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

    return y + 8
  }

  /**
   * The issuing organization's Terms & Conditions, rendered verbatim.
   *
   * Mirrors the browser order report: its own heading, sitting after the
   * totals and before the signature trail. Nothing is drawn when the
   * organization has not saved any terms - there is deliberately no default
   * or placeholder text. Long terms wrap to the page width and spill onto
   * further pages rather than overrunning the footer or the signature boxes.
   */
  private addTermsSection(terms: string | null | undefined, yPosition: number): number {
    const value = (terms || '')
    if (!value.trim()) return yPosition

    const maxWidth = this.pageWidth - this.margin * 2
    const lineHeight = 4
    // Keep the heading with at least a couple of lines of text.
    const bottomLimit = 275

    let y = yPosition + 4

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
      // Blank source lines advance the cursor without drawing, preserving the
      // author's paragraph breaks.
      if (line) this.doc.text(line, this.margin, y)
      y += lineHeight
    }

    return y + 3
  }

  private async addSignaturesApprovalTrail(yPosition: number, orderData?: OrderData, documentData?: DocumentData): Promise<number> {
    let y = yPosition

    const normalizedDocType = documentData?.doc_type?.toLowerCase?.() ?? ''
    const isBalancePaymentRequestDoc = normalizedDocType.includes('balance') && normalizedDocType.includes('request')
    const orderType = orderData?.order_type || ''
    const isD2HorS2D = orderType === 'D2H' || orderType === 'S2D'

    // Check if we need a new page - ensure enough space for both sections (about 120mm)
    if (y > 150) {
      this.doc.addPage()
      y = this.margin + 10
    }

    // SIGNATURES / APPROVAL TRAIL Header
    this.doc.setFontSize(11)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(0, 0, 0)
    this.doc.text('SIGNATURES / APPROVAL TRAIL', this.margin, y)
    y += 7

    // Signature boxes
    for (const sig of this.signatures) {
      // Box border
      const boxHeight = 30
      this.doc.setDrawColor(100, 100, 100)
      this.doc.setLineWidth(0.3)
      this.doc.rect(this.margin, y, this.pageWidth - 2 * this.margin, boxHeight)

      // Draw table-like structure
      const col1Width = 50
      const col2Width = this.pageWidth - 2 * this.margin - col1Width

      // Name row
      this.doc.line(this.margin, y + 7, this.pageWidth - this.margin, y + 7)
      this.doc.setFontSize(8)
      this.doc.setFont('helvetica', 'bold')
      this.doc.text('Name:', this.margin + 2, y + 5)
      this.doc.setFont('helvetica', 'normal')
      this.doc.text(sig.signer_name, this.margin + col1Width + 2, y + 5)

      // Signed At row (moved up - Role row removed)
      this.doc.line(this.margin, y + 14, this.pageWidth - this.margin, y + 14)
      this.doc.setFont('helvetica', 'bold')
      this.doc.text('Signed At:', this.margin + 2, y + 12)
      this.doc.setFont('helvetica', 'normal')
      this.doc.text(this.formatDate(sig.signed_at) + ' ' + new Date(sig.signed_at).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' }), this.margin + col1Width + 2, y + 12)

      // Integrity Hash row (moved up)
      this.doc.line(this.margin, y + 21, this.pageWidth - this.margin, y + 21)
      this.doc.setFont('helvetica', 'bold')
      this.doc.text('Integrity Hash:', this.margin + 2, y + 19)
      this.doc.setFont('helvetica', 'normal')
      this.doc.setFontSize(7)
      const signatureHash = sig.integrity_hash || sig.signature_hash || '—'
      this.doc.text(signatureHash, this.margin + col1Width + 2, y + 19)

      // Signature Image placeholder
      this.doc.setFontSize(8)
      this.doc.setFont('helvetica', 'bold')
      this.doc.text('Signature Image:', this.margin + 2, y + boxHeight + 5)

      // Signature box
      const sigBoxY = y + boxHeight + 8
      const sigBoxHeight = 20
      this.doc.rect(this.margin, sigBoxY, this.pageWidth - 2 * this.margin, sigBoxHeight)

      let signatureRendered = false

      const renderSignatureImage = async (dataUrl: string | null): Promise<boolean> => {
        if (!dataUrl) return false
        try {
          const imgHeight = 18
          const imgWidth = 60
          return await this.drawSignatureImageBlue(dataUrl, (this.pageWidth - imgWidth) / 2, sigBoxY + 1, imgWidth, imgHeight)
        } catch (error) {
          console.error('Error adding signature image to PDF:', error)
          return false
        }
      }

      signatureRendered = await renderSignatureImage(sig.signature_image_data ?? null)

      if (!signatureRendered && sig.signature_image_url && typeof window !== 'undefined') {
        try {
          const response = await fetch(sig.signature_image_url)
          if (response.ok) {
            const blob = await response.blob()
            const reader = new FileReader()
            await new Promise<void>((resolve, reject) => {
              reader.onloadend = async () => {
                try {
                  const base64data = reader.result as string
                  if (await renderSignatureImage(base64data)) {
                    signatureRendered = true
                  }
                  resolve()
                } catch (error) {
                  reject(error as Error)
                }
              }
              reader.onerror = () => reject(new Error('Failed to load signature image'))
              reader.readAsDataURL(blob)
            })
          }
        } catch (clientError) {
          console.error('Error fetching signature image in browser:', clientError)
        }
      }

      if (!signatureRendered) {
        this.doc.setFont('helvetica', 'italic')
        this.doc.setFontSize(9)
        const message = sig.signature_image_url
          ? 'Signature image unavailable. Please ensure your digital signature is uploaded.'
          : '(awaiting acknowledgement)'
        this.doc.text(message, this.pageWidth / 2, sigBoxY + sigBoxHeight / 2 + 2, { align: 'center' })
      }

      y += boxHeight + sigBoxHeight + 15
    }

    // If no signatures yet, show HQ Approval and Manufacturer Acknowledgement sections
    if (this.signatures.length === 0) {
      const boxHeight = 30
      const col1Width = 50
      this.doc.setDrawColor(100, 100, 100)
      this.doc.setLineWidth(0.3)

      if (!isBalancePaymentRequestDoc) {
        // HQ Approval Section
        this.doc.setFontSize(9)
        this.doc.setFont('helvetica', 'bold')
        this.doc.text('HQ Approval', this.margin, y)
        y += 5

        this.doc.rect(this.margin, y, this.pageWidth - 2 * this.margin, boxHeight)

        // Name row
        this.doc.line(this.margin, y + 7, this.pageWidth - this.margin, y + 7)
        this.doc.setFontSize(8)
        this.doc.setFont('helvetica', 'bold')
        this.doc.text('Name:', this.margin + 2, y + 5)
        this.doc.setFont('helvetica', 'normal')
        const approverName = orderData?.approver?.full_name || ''
        this.doc.text(approverName, this.margin + col1Width + 2, y + 5)

        // Approved At row (Role row removed)
        this.doc.line(this.margin, y + 14, this.pageWidth - this.margin, y + 14)
        this.doc.setFont('helvetica', 'bold')
        this.doc.text('Approved At:', this.margin + 2, y + 12)
        this.doc.setFont('helvetica', 'normal')
        const approvedAt = orderData?.approved_at ? this.format12HourTime(orderData.approved_at) : ''
        this.doc.text(approvedAt, this.margin + col1Width + 2, y + 12)

        // Integrity Hash row (moved up)
        this.doc.line(this.margin, y + 21, this.pageWidth - this.margin, y + 21)
        this.doc.setFont('helvetica', 'bold')
        this.doc.text('Integrity Hash:', this.margin + 2, y + 19)
        this.doc.setFont('helvetica', 'normal')
        this.doc.setFontSize(7)
        const integrityHash = orderData?.approval_hash || ''
        this.doc.text(integrityHash, this.margin + col1Width + 2, y + 19)

        y += boxHeight + 5

        // Signature Image
        this.doc.setFontSize(8)
        this.doc.setFont('helvetica', 'bold')
        this.doc.text('Signature Image:', this.margin + 2, y)
        y += 3
        this.doc.rect(this.margin, y, this.pageWidth - 2 * this.margin, 20)

        // Check if signature image exists and load it
        const approverSignatureImage = orderData?.approver_signature_image
        if (approverSignatureImage && orderData?.approved_at) {
          try {
            const imgHeight = 18
            const imgWidth = 60
            const xPos = (this.pageWidth - imgWidth) / 2
            const rendered = await this.drawSignatureImageBlue(approverSignatureImage, xPos, y + 1, imgWidth, imgHeight)
            if (!rendered) {
              this.doc.setFont('helvetica', 'italic')
              this.doc.setFontSize(9)
              this.doc.text('[signature image here]', this.pageWidth / 2, y + 12, { align: 'center' })
            }
          } catch (error) {
            console.error('Error adding approver signature image:', error)
            this.doc.setFont('helvetica', 'italic')
            this.doc.setFontSize(9)
            this.doc.text('[signature image here]', this.pageWidth / 2, y + 12, { align: 'center' })
          }
        } else {
          let signatureRendered = false
          const approverSignatureUrl = orderData?.approver?.signature_url
          if (approverSignatureUrl && orderData?.approved_at && typeof window !== 'undefined') {
            try {
              const response = await fetch(approverSignatureUrl)
              if (response.ok) {
                const blob = await response.blob()
                const reader = new FileReader()
                await new Promise<void>((resolve, reject) => {
                  reader.onloadend = async () => {
                    try {
                      const base64data = reader.result as string
                      const imgHeight = 18
                      const imgWidth = 60
                      const xPos = (this.pageWidth - imgWidth) / 2
                      signatureRendered = await this.drawSignatureImageBlue(base64data, xPos, y + 1, imgWidth, imgHeight)
                      resolve()
                    } catch (err) {
                      reject(err as Error)
                    }
                  }
                  reader.onerror = () => reject(new Error('Failed to load approver signature'))
                  reader.readAsDataURL(blob)
                })
              }
            } catch (clientError) {
              console.error('Error loading approver signature in browser:', clientError)
            }
          }

          if (!signatureRendered) {
            this.doc.setFont('helvetica', 'italic')
            this.doc.setFontSize(9)
            this.doc.text('Upload digital signature in My Profile to display here.', this.pageWidth / 2, y + 12, { align: 'center' })
          }
        }

        y += 30
      }

      // Manufacturer Acknowledgement Section - Only show for orders that involve manufacturer (not D2H or S2D)
      if (!isD2HorS2D) {
        this.doc.setFontSize(9)
        this.doc.setFont('helvetica', 'bold')
        this.doc.text('Manufacturer Acknowledgement', this.margin, y)
        y += 5

        this.doc.rect(this.margin, y, this.pageWidth - 2 * this.margin, boxHeight)

        // Name row
        this.doc.line(this.margin, y + 7, this.pageWidth - this.margin, y + 7)
        this.doc.setFontSize(8)
        this.doc.setFont('helvetica', 'bold')
        this.doc.text('Name:', this.margin + 2, y + 5)
        this.doc.setFont('helvetica', 'normal')
        const mfgAckName = documentData?.acknowledger?.full_name || '—'
        this.doc.text(mfgAckName, this.margin + col1Width + 2, y + 5)

        // Acknowledged At row (Role row removed)
        this.doc.line(this.margin, y + 14, this.pageWidth - this.margin, y + 14)
        this.doc.setFont('helvetica', 'bold')
        this.doc.text('Acknowledged At:', this.margin + 2, y + 12)
        this.doc.setFont('helvetica', 'normal')
        const acknowledgedAt = documentData?.acknowledged_at ? this.format12HourTime(documentData.acknowledged_at) : '—'
        this.doc.text(acknowledgedAt, this.margin + col1Width + 2, y + 12)

        // Integrity Hash row (moved up)
        this.doc.line(this.margin, y + 21, this.pageWidth - this.margin, y + 21)
        this.doc.setFont('helvetica', 'bold')
        this.doc.text('Integrity Hash:', this.margin + 2, y + 19)
        this.doc.setFont('helvetica', 'normal')
        this.doc.setFontSize(7)
        const mfgIntegrityHash = documentData?.acknowledgement_hash || '—'
        this.doc.text(mfgIntegrityHash, this.margin + col1Width + 2, y + 19)

        y += boxHeight + 5

        // Signature Image
        this.doc.setFontSize(8)
        this.doc.setFont('helvetica', 'bold')
        this.doc.text('Signature Image:', this.margin + 2, y)
        y += 3
        this.doc.rect(this.margin, y, this.pageWidth - 2 * this.margin, 20)

        // Check if manufacturer acknowledgement signature exists
        const mfgSignatureImage = documentData?.acknowledger_signature_image
        if (mfgSignatureImage && documentData?.acknowledged_at) {
          try {
            const imgHeight = 18
            const imgWidth = 60
            const xPos = (this.pageWidth - imgWidth) / 2
            const rendered = await this.drawSignatureImageBlue(mfgSignatureImage, xPos, y + 1, imgWidth, imgHeight)
            if (!rendered) {
              this.doc.setFont('helvetica', 'italic')
              this.doc.setFontSize(9)
              this.doc.text('(awaiting acknowledgement)', this.pageWidth / 2, y + 12, { align: 'center' })
            }
          } catch (error) {
            console.error('Error adding manufacturer signature image:', error)
            this.doc.setFont('helvetica', 'italic')
            this.doc.setFontSize(9)
            this.doc.text('(awaiting acknowledgement)', this.pageWidth / 2, y + 12, { align: 'center' })
          }
        } else {
          let signatureRendered = false
          const manufacturerSignatureUrl = documentData?.acknowledger?.signature_url
          if (manufacturerSignatureUrl && documentData?.acknowledged_at && typeof window !== 'undefined') {
            try {
              const response = await fetch(manufacturerSignatureUrl)
              if (response.ok) {
                const blob = await response.blob()
                const reader = new FileReader()
                await new Promise<void>((resolve, reject) => {
                  reader.onloadend = async () => {
                    try {
                      const base64data = reader.result as string
                      const imgHeight = 18
                      const imgWidth = 60
                      const xPos = (this.pageWidth - imgWidth) / 2
                      signatureRendered = await this.drawSignatureImageBlue(base64data, xPos, y + 1, imgWidth, imgHeight)
                      resolve()
                    } catch (err) {
                      reject(err as Error)
                    }
                  }
                  reader.onerror = () => reject(new Error('Failed to load manufacturer signature'))
                  reader.readAsDataURL(blob)
                })
              }
            } catch (clientError) {
              console.error('Error loading manufacturer signature in browser:', clientError)
            }
          }

          if (!signatureRendered) {
            const message = documentData?.acknowledged_at
              ? 'Signature missing. Please upload your digital signature in My Profile.'
              : 'Awaiting acknowledgement. Upload digital signature in My Profile before acknowledging.'
            this.doc.setFont('helvetica', 'italic')
            this.doc.setFontSize(9)
            this.doc.text(message, this.pageWidth / 2, y + 12, { align: 'center' })
          }
        }

        y += 25
      }
    }

    return y
  }

  async generateOrderPDF(orderData: OrderData): Promise<Blob> {
    let y = 15

    // Company Logo
    y = await this.addCompanyLogo(y, orderData.buyer_logo_image)
    y += 5

    // Document Title
    y = this.addDocumentHeader('PURCHASE ORDER (PO)', y)
    y += 3

    // PO Information Table
    const poInfo = [
      { label: 'PO Number:', value: orderData.order_no },
      { label: 'PO Date:', value: this.formatOrderBusinessDate(orderData.order_date, orderData.created_at) },
      { label: 'Status:', value: orderData.status.toUpperCase() },
      { label: 'Estimated ETA:', value: orderData.estimated_eta || 'TBD' },
      { label: 'Payment Terms:', value: this.formatPaymentTermsLabel(orderData.payment_terms) },
      { label: '', value: '' }
    ]
    y = this.addInfoTable(poInfo, y, 2)

    // Parties Section
    y = this.addPartiesSection(orderData, y, 'PO')

    // Order Lines Section
    y = this.addOrderLinesSection(orderData, y)

    // Summary Section
    y = this.addSummarySection(orderData, y)

    // Expected Boxes (H2M / D2H)
    y = this.addExpectedBoxesSection(orderData, y)

    // Organization Terms & Conditions (verbatim, omitted when unset)
    y = this.addTermsSection(orderData.organization_terms, y)

    // Signatures / Approval Trail
    y = await this.addSignaturesApprovalTrail(y, orderData)

    return this.doc.output('blob')
  }

  async generatePurchaseOrderPDF(orderData: OrderData, documentData: DocumentData): Promise<Blob> {
    let y = 15

    // Company Logo
    y = await this.addCompanyLogo(y, orderData.buyer_logo_image)
    y += 5

    // Document Title
    y = this.addDocumentHeader('PURCHASE ORDER (PO)', y)
    y += 3

    // PO Information Table
    const poInfo = [
      { label: 'PO Number:', value: documentData.display_doc_no || documentData.doc_no },
      { label: 'PO Date:', value: this.formatDate(documentData.created_at) },
      { label: 'Status:', value: documentData.status.toUpperCase() },
      { label: 'Estimated ETA:', value: documentData.estimated_eta || '30 Oct 2025' },
      { label: 'Payment Terms:', value: this.formatPaymentTermsLabel(orderData.payment_terms) },
      { label: '', value: '' }
    ]
    y = this.addInfoTable(poInfo, y, 2)

    // Parties Section
    y = this.addPartiesSection(orderData, y, 'PO')

    // Order Lines Section
    y = this.addOrderLinesSection(orderData, y)

    // Summary Section
    y = this.addSummarySection(orderData, y)

    // Expected Boxes (H2M / D2H)
    y = this.addExpectedBoxesSection(orderData, y)

    // Organization Terms & Conditions (verbatim, omitted when unset)
    y = this.addTermsSection(orderData.organization_terms, y)

    // Signatures / Approval Trail
    y = await this.addSignaturesApprovalTrail(y, orderData, documentData)

    return this.doc.output('blob')
  }

  async generateInvoicePDF(orderData: OrderData, documentData: DocumentData): Promise<Blob> {
    let y = 15

    // Company Logo
    y = await this.addCompanyLogo(y, orderData.seller_logo_image)
    y += 5

    // Document Title
    y = this.addDocumentHeader('INVOICE', y)
    y += 3

    // Invoice Information Table
    const invoiceInfo = [
      { label: 'Invoice Number:', value: documentData.display_doc_no || documentData.doc_no },
      { label: 'Invoice Date:', value: this.formatDate(documentData.created_at) },
      { label: 'Status:', value: documentData.status.toUpperCase() },
      { label: 'Payment Terms:', value: documentData.payment_terms || 'Net 30 Days' },
      { label: 'Acknowledged:', value: documentData.acknowledged_at ? this.formatDate(documentData.acknowledged_at) : 'Pending' },
      { label: '', value: '' }
    ]
    y = this.addInfoTable(invoiceInfo, y, 2)

    // Parties Section
    y = this.addPartiesSection(orderData, y, 'INVOICE')

    // Order Lines Section
    y = this.addOrderLinesSection(orderData, y)

    // Summary Section
    const paymentTerms = this.normalizePaymentTerms(orderData.payment_terms)
    const hasSplit = (paymentTerms.depositPercentage ?? 0) > 0 && (paymentTerms.depositPercentage ?? 0) < 100
    let stage: 'deposit' | 'balance' | 'full' = 'full'

    if (hasSplit) {
      const inferredStage = this.resolveInvoiceStage(documentData.payload)
      if (inferredStage === 'full') {
        const payload = documentData.payload || {}
        const sequenceCandidate = payload?.invoice_index ?? payload?.sequence ?? payload?.order ?? payload?.step_index
        const parsedSequence = typeof sequenceCandidate === 'string' ? parseInt(sequenceCandidate, 10) : sequenceCandidate

        if (payload?.is_balance === true || payload?.is_balance_payment === true) {
          stage = 'balance'
        } else if (typeof parsedSequence === 'number' && parsedSequence > 1) {
          stage = 'balance'
        } else {
          const percentageCandidates = [payload?.percentage, payload?.coverage_pct, payload?.invoice_percentage]
            .map((value) => (typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : undefined))
            .filter((value) => typeof value === 'number' && isFinite(value)) as number[]

          if (percentageCandidates.length > 0) {
            const pct = percentageCandidates[0]
            if (pct >= 100) {
              stage = 'full'
            } else if (pct > 0) {
              stage = 'deposit'
            } else {
              stage = 'deposit'
            }
          } else {
            stage = 'deposit'
          }
        }
      } else {
        stage = inferredStage
      }
    }

    if (stage !== 'full') {
      const orderSubtotal = orderData.order_items.reduce((sum, item) => sum + (parseFloat(item.line_total.toString()) || 0), 0)
      const depositPercentage = paymentTerms.depositPercentage ?? 50
      const balancePercentage = paymentTerms.balancePercentage ?? Math.max(100 - depositPercentage, 0)
      const invoicePercentage = stage === 'deposit' ? depositPercentage : balancePercentage || 100
      const normalizedPercentage = Math.min(Math.max(invoicePercentage, 0), 100)
      const rawInvoiceAmount = (orderSubtotal * normalizedPercentage) / 100
      const invoiceAmount = Math.round((rawInvoiceAmount + Number.EPSILON) * 100) / 100
      const previousPayment = stage === 'balance'
        ? Math.round(((orderSubtotal - invoiceAmount) + Number.EPSILON) * 100) / 100
        : Math.round(((orderSubtotal * (depositPercentage / 100)) + Number.EPSILON) * 100) / 100
      const balanceRemaining = Math.max(Math.round(((orderSubtotal - invoiceAmount - (stage === 'deposit' ? 0 : previousPayment)) + Number.EPSILON) * 100) / 100, 0)

      const amountLabel = stage === 'deposit'
        ? `Deposit Due (${normalizedPercentage.toFixed(0)}%)`
        : `Balance Due (${normalizedPercentage.toFixed(0)}%)`

      const summaryRows: Array<[string, string]> = [
        ['Order Total (100%)', this.formatCurrency(orderSubtotal)],
        [amountLabel, this.formatCurrency(invoiceAmount)]
      ]

      if (stage === 'deposit') {
        summaryRows.push(['Balance Remaining', this.formatCurrency(Math.max(orderSubtotal - invoiceAmount, 0))])
      } else {
        summaryRows.push(['Previously Paid (Deposit)', this.formatCurrency(previousPayment)])
      }

      summaryRows.push(['Discount / Campaign', this.formatCurrency(0)])
      summaryRows.push(['Tax (0%)', this.formatCurrency(0)])

      y = this.addSummarySection(orderData, y, {
        customRows: summaryRows,
        grandTotalOverride: invoiceAmount,
        grandTotalLabel: 'AMOUNT DUE NOW'
      })
    } else {
      y = this.addSummarySection(orderData, y)
    }

    // Organization Terms & Conditions (verbatim, omitted when unset)
    y = this.addTermsSection(orderData.organization_terms, y)

    // Signatures / Approval Trail
    y = await this.addSignaturesApprovalTrail(y, orderData, documentData)

    return this.doc.output('blob')
  }

  async generatePaymentPDF(orderData: OrderData, documentData: DocumentData): Promise<Blob> {
    let y = 15

    // Company Logo
    y = await this.addCompanyLogo(y, orderData.buyer_logo_image)
    y += 5

    const paymentTerms = this.normalizePaymentTerms(orderData.payment_terms)
    const payload = (documentData.payload || {}) as Record<string, any>
    const linkedInvoice = documentData.linked_invoice || null
    const sourceRequest = documentData.source_request || null
    const orderSubtotal = orderData.order_items.reduce((sum, item) => sum + (parseFloat(item.line_total.toString()) || 0), 0)

    const parsePercentage = (value: unknown): number | undefined => {
      const numeric = this.parseNumeric(value)
      if (numeric === undefined || !isFinite(numeric)) {
        return undefined
      }
      if (numeric < 0) {
        return 0
      }
      if (numeric > 100 && numeric <= 1000) {
        return Math.min(numeric, 100)
      }
      if (numeric > 1) {
        return Math.min(numeric, 100)
      }
      if (numeric <= 1) {
        return Math.max(Math.min(numeric * 100, 100), 0)
      }
      return Math.min(Math.max(numeric, 0), 100)
    }

    const percentageCandidates: Array<unknown> = [
      documentData.payment_percentage,
      linkedInvoice?.payment_percentage,
      payload?.payment_percentage,
      payload?.percentage,
      payload?.coverage_pct,
      payload?.amount_percentage,
      payload?.payment_pct,
      payload?.payment_percent
    ]

    let paymentPercentage: number | undefined
    for (const candidate of percentageCandidates) {
      const parsed = parsePercentage(candidate)
      if (typeof parsed === 'number' && isFinite(parsed)) {
        paymentPercentage = parsed
        break
      }
    }

    const splitEnabled = typeof paymentTerms.depositPercentage === 'number'
      && paymentTerms.depositPercentage > 0
      && paymentTerms.depositPercentage < 100

    let stage: 'deposit' | 'balance' | 'full' = splitEnabled ? 'deposit' : 'full'

    if (sourceRequest || payload?.source_request_id || payload?.payment_stage === 'balance' || payload?.is_balance_payment === true) {
      stage = splitEnabled ? 'balance' : 'full'
    } else if (linkedInvoice || payload?.invoice_id || payload?.is_deposit_payment === true) {
      stage = splitEnabled ? 'deposit' : 'full'
    } else if (typeof paymentPercentage === 'number') {
      if (paymentPercentage >= 99.5) {
        stage = splitEnabled ? 'balance' : 'full'
      } else if (paymentPercentage > 0 && paymentPercentage < 99.5 && splitEnabled) {
        stage = 'deposit'
      }
    }

    const depositPercentage = Math.min(Math.max(paymentTerms.depositPercentage ?? (splitEnabled ? 50 : paymentPercentage ?? 100), 0), 100)
    const balancePercentage = Math.min(Math.max(
      paymentTerms.balancePercentage ?? (splitEnabled ? Math.max(100 - depositPercentage, 0) : paymentPercentage ?? 100),
      0
    ), 100)

    let stagePercentage: number | undefined
    if (stage === 'deposit') {
      stagePercentage = paymentPercentage ?? depositPercentage
    } else if (stage === 'balance') {
      stagePercentage = paymentPercentage ?? balancePercentage
    } else {
      stagePercentage = paymentPercentage ?? 100
    }

    const amountCandidates: Array<unknown> = [
      documentData.total_amount,
      payload?.amount,
      payload?.requested_amount,
      payload?.balance_amount,
      stage === 'deposit' ? linkedInvoice?.total_amount : undefined
    ]

    let paymentAmount: number | undefined
    for (const candidate of amountCandidates) {
      const parsed = this.parseNumeric(candidate)
      if (typeof parsed === 'number' && isFinite(parsed) && parsed > 0) {
        paymentAmount = parsed
        break
      }
    }

    if (paymentAmount === undefined && typeof stagePercentage === 'number' && isFinite(stagePercentage)) {
      paymentAmount = (orderSubtotal * stagePercentage) / 100
    }

    if (paymentAmount === undefined) {
      paymentAmount = orderSubtotal
    }

    const normalizedPaymentAmount = Math.round((paymentAmount + Number.EPSILON) * 100) / 100

    const depositAmount = Math.round(((orderSubtotal * depositPercentage) / 100 + Number.EPSILON) * 100) / 100
    const previousPaid = stage === 'balance' ? Math.min(orderSubtotal, depositAmount) : 0
    const projectedPaid = Math.min(orderSubtotal, previousPaid + normalizedPaymentAmount)
    const balanceRemaining = Math.max(Math.round(((orderSubtotal - projectedPaid) + Number.EPSILON) * 100) / 100, 0)

    const paymentStageLabel = stage === 'deposit'
      ? `Deposit Payment (${Math.round(stagePercentage ?? depositPercentage)}%)`
      : stage === 'balance'
        ? `Balance Payment (${Math.round(stagePercentage ?? balancePercentage)}%)`
        : typeof stagePercentage === 'number' && stagePercentage < 100
          ? `Partial Payment (${Math.round(stagePercentage)}%)`
          : 'Full Payment (100%)'

    const paymentTitle = stage === 'deposit'
      ? `PAYMENT ADVICE - DEPOSIT (${Math.round(stagePercentage ?? depositPercentage)}%)`
      : stage === 'balance'
        ? `PAYMENT ADVICE - BALANCE (${Math.round(stagePercentage ?? balancePercentage)}%)`
        : 'PAYMENT ADVICE'

    y = this.addDocumentHeader(paymentTitle, y)
    y += 3

    const currency = typeof payload?.currency === 'string' && payload.currency.trim().length > 0
      ? payload.currency.toUpperCase()
      : 'MYR'

    const infoRows = [
      { label: 'Payment Number:', value: documentData.display_doc_no || documentData.doc_no },
      { label: 'Payment Date:', value: this.formatDate(documentData.created_at) },
      { label: 'Status:', value: documentData.status?.toUpperCase?.() || documentData.status },
      { label: 'Payment Stage:', value: paymentStageLabel },
      { label: 'Payment Terms:', value: this.formatPaymentTermsLabel(orderData.payment_terms) },
      { label: 'Currency:', value: currency },
      { label: 'Amount Due:', value: this.formatCurrency(normalizedPaymentAmount) },
      linkedInvoice?.doc_no ? { label: 'Related Invoice:', value: linkedInvoice.display_doc_no || linkedInvoice.doc_no } : null,
      sourceRequest?.doc_no ? { label: 'Source Request:', value: sourceRequest.display_doc_no || sourceRequest.doc_no } : null
    ].filter((row): row is { label: string; value: string } => Boolean(row?.value))

    y = this.addInfoTable(infoRows, y, 2)

    // Parties Section
    y = this.addPartiesSection(orderData, y, 'PAYMENT')

    // Order Lines Section
    y = this.addOrderLinesSection(orderData, y)

    const summaryRows: Array<[string, string]> = [
      ['Order Total (100%)', this.formatCurrency(orderSubtotal)]
    ]

    if (stage === 'deposit') {
      summaryRows.push([
        `Deposit Payment (${Math.round(stagePercentage ?? depositPercentage)}%)`,
        this.formatCurrency(normalizedPaymentAmount)
      ])
      summaryRows.push([
        'Balance Remaining After Payment',
        this.formatCurrency(balanceRemaining)
      ])
    } else if (stage === 'balance') {
      summaryRows.push([
        `Deposit Previously Paid (${Math.round(depositPercentage)}%)`,
        this.formatCurrency(previousPaid)
      ])
      summaryRows.push([
        `Balance Payment (${Math.round(stagePercentage ?? balancePercentage)}%)`,
        this.formatCurrency(normalizedPaymentAmount)
      ])
      summaryRows.push([
        'Total Paid After This',
        this.formatCurrency(projectedPaid)
      ])
      summaryRows.push([
        'Outstanding Balance',
        this.formatCurrency(balanceRemaining)
      ])
    } else {
      summaryRows.push(['Payment Amount', this.formatCurrency(normalizedPaymentAmount)])
      summaryRows.push(['Outstanding Balance', this.formatCurrency(balanceRemaining)])
    }

    const grandTotalLabel = stage === 'balance'
      ? 'BALANCE AMOUNT DUE'
      : stage === 'deposit'
        ? 'DEPOSIT AMOUNT DUE'
        : 'PAYMENT AMOUNT DUE'

    y = this.addSummarySection(orderData, y, {
      customRows: summaryRows,
      grandTotalOverride: normalizedPaymentAmount,
      grandTotalLabel
    })

    // Organization Terms & Conditions (verbatim, omitted when unset)
    y = this.addTermsSection(orderData.organization_terms, y)

    // Signatures / Approval Trail
    y = await this.addSignaturesApprovalTrail(y, orderData, documentData)

    return this.doc.output('blob')
  }

  async generateReceiptPDF(orderData: OrderData, documentData: DocumentData): Promise<Blob> {
    let y = 15

    // Company Logo
    y = await this.addCompanyLogo(y, orderData.seller_logo_image)
    y += 5

    // Determine payment percentage from document - now dynamic based on payment terms
    const paymentPercentage = documentData.payment_percentage || 100
    const isFinalReceipt = paymentPercentage === 100
    const isDepositReceipt = paymentPercentage < 100

    // Document Title with dynamic payment percentage
    const receiptTitle = isFinalReceipt
      ? 'RECEIPT - FINAL PAYMENT (100%)'
      : `RECEIPT - DEPOSIT PAYMENT (${paymentPercentage}%)`
    y = this.addDocumentHeader(receiptTitle, y)
    y += 3

    // Receipt Information Table with dynamic percentage
    const paymentStatus = isFinalReceipt
      ? '100% PAYMENT COMPLETED'
      : `${paymentPercentage}% PAYMENT RECEIVED`

    const receiptInfo = [
      { label: 'Receipt Number:', value: documentData.display_doc_no || documentData.doc_no },
      { label: 'Receipt Date:', value: this.formatDate(documentData.created_at) },
      { label: 'Payment Status:', value: paymentStatus },
      { label: 'Payment Method:', value: 'Bank Transfer' }
    ]
    y = this.addInfoTable(receiptInfo, y, 2)

    // Parties Section
    y = this.addPartiesSection(orderData, y, 'RECEIPT')

    // Order Lines Section
    y = this.addOrderLinesSection(orderData, y)

    // Summary Section
    y = this.addSummarySection(orderData, y)

    // Pre-calculate totals for receipt summary - now using dynamic payment percentage
    const orderTotal = orderData.order_items.reduce((sum, item) => sum + (parseFloat(item.line_total.toString()) || 0), 0)

    // Use the payment_percentage from the document (30, 50, 70, etc.) instead of hardcoded 50
    const receiptPortionPercentage = paymentPercentage

    let receiptAmount = typeof documentData.total_amount === 'number'
      ? documentData.total_amount
      : receiptPortionPercentage
        ? (orderTotal * receiptPortionPercentage) / 100
        : orderTotal

    // Guard against floating point issues
    receiptAmount = Math.round((receiptAmount + Number.EPSILON) * 100) / 100

    const totalPaidToDate = isFinalReceipt ? orderTotal : receiptAmount
    const balanceRemaining = Math.max(orderTotal - totalPaidToDate, 0)

    // Summary Section tailored for receipts
    y = this.addReceiptSummarySection({
      yPosition: y,
      orderTotal,
      receiptAmount,
      receiptPortionPercentage: receiptPortionPercentage ?? 100,
      totalPaidToDate,
      balanceRemaining,
      isDepositReceipt,
      isFinalReceipt
    })
    y += 5

    // Organization Terms & Conditions (verbatim, omitted when unset)
    y = this.addTermsSection(orderData.organization_terms, y)

    // Signatures / Approval Trail
    y = await this.addSignaturesApprovalTrail(y, orderData, documentData)

    return this.doc.output('blob')
  }

  async generatePaymentRequestPDF(orderData: OrderData, documentData: DocumentData): Promise<Blob> {
    let y = 15

    // Company Logo
    y = await this.addCompanyLogo(y, orderData.seller_logo_image)
    y += 5

    const payload = (documentData.payload || {}) as Record<string, any>
    const orderTotal = orderData.order_items.reduce((sum, item) => sum + (parseFloat(item.line_total.toString()) || 0), 0)

    const requestedAmountRaw = payload.requested_amount ?? payload.balance_amount ?? documentData.total_amount
    const requestedAmount = this.parseNumeric(requestedAmountRaw) ?? 0
    const normalizedRequestedAmount = Math.round((requestedAmount + Number.EPSILON) * 100) / 100

    const paymentTerms = this.normalizePaymentTerms(orderData.payment_terms)

    let balancePercentage = this.normalizePercentage(
      documentData.requested_percent ??
      payload.requested_percent ??
      payload.requested_percentage ??
      payload.balance_pct ??
      payload.balance_percentage ??
      documentData.payment_percentage
    )

    if (balancePercentage === undefined && orderTotal > 0) {
      balancePercentage = Math.min(Math.max((normalizedRequestedAmount / orderTotal) * 100, 0), 100)
    }

    if (balancePercentage === undefined && typeof paymentTerms.balancePercentage === 'number') {
      balancePercentage = paymentTerms.balancePercentage
    }

    let depositPercentage = typeof paymentTerms.depositPercentage === 'number'
      ? paymentTerms.depositPercentage
      : undefined

    if (depositPercentage === undefined && typeof balancePercentage === 'number') {
      depositPercentage = Math.max(100 - balancePercentage, 0)
    }

    const depositAmount = typeof depositPercentage === 'number'
      ? Math.round(((orderTotal * depositPercentage) / 100 + Number.EPSILON) * 100) / 100
      : Math.max(orderTotal - normalizedRequestedAmount, 0)

    const outstandingAfterApproval = Math.max(orderTotal - (depositAmount + normalizedRequestedAmount), 0)

    const requestTitle = typeof balancePercentage === 'number'
      ? `BALANCE PAYMENT REQUEST (${Math.round(balancePercentage)}%)`
      : 'BALANCE PAYMENT REQUEST'

    y = this.addDocumentHeader(requestTitle, y)
    y += 3

    const currency = typeof payload.currency === 'string' && payload.currency.trim().length > 0
      ? payload.currency.toUpperCase()
      : 'MYR'

    const requestedAmountDisplay = `${this.formatCurrency(normalizedRequestedAmount)}${currency !== 'MYR' ? ` (${currency})` : ''}`

    const infoRows = [
      { label: 'Request Number:', value: documentData.display_doc_no || documentData.doc_no },
      { label: 'Request Date:', value: this.formatDate(documentData.created_at) },
      { label: 'Status:', value: documentData.status?.toUpperCase?.() || documentData.status },
      {
        label: 'Requested Amount:',
        value: requestedAmountDisplay
      },
      balancePercentage !== undefined
        ? { label: 'Balance Percentage:', value: `${Math.round(balancePercentage)}% of order total` }
        : null,
      { label: 'Payment Terms:', value: this.formatPaymentTermsLabel(orderData.payment_terms) },
      payload.po_no ? { label: 'PO Reference:', value: payload.po_no } : { label: 'PO Reference:', value: orderData.order_no },
      { label: 'Trigger Mode:', value: this.formatTriggerMode(payload.trigger_mode as string | undefined) },
      { label: 'Reason:', value: this.formatRequestReason(payload.reason as string | undefined, orderData.payment_terms) },
      { label: 'Currency:', value: currency }
    ].filter((row): row is { label: string; value: string } => Boolean(row?.value))

    y = this.addInfoTable(infoRows, y, 2)

    // Parties Section
    y = this.addPartiesSection(orderData, y, 'PAYMENT_REQUEST')

    // Deposit documentation summary
    const relatedDocs = documentData.related_documents || {}
    const depositLines: string[] = []

    if (relatedDocs.deposit_invoice) {
      const createdAt = relatedDocs.deposit_invoice.created_at
        ? this.formatDate(relatedDocs.deposit_invoice.created_at)
        : 'Date TBD'
      depositLines.push(
        `Deposit Invoice ${relatedDocs.deposit_invoice.display_doc_no || relatedDocs.deposit_invoice.doc_no} (${createdAt}) • ${relatedDocs.deposit_invoice.status?.toUpperCase?.() || relatedDocs.deposit_invoice.status || 'Status unknown'
        }`
      )
    }

    if (relatedDocs.deposit_payment) {
      const createdAt = relatedDocs.deposit_payment.created_at
        ? this.formatDate(relatedDocs.deposit_payment.created_at)
        : 'Date TBD'
      depositLines.push(
        `Deposit Payment ${relatedDocs.deposit_payment.display_doc_no || relatedDocs.deposit_payment.doc_no} (${createdAt}) • ${relatedDocs.deposit_payment.status?.toUpperCase?.() || relatedDocs.deposit_payment.status || 'Status unknown'
        }`
      )
    }

    if (relatedDocs.deposit_receipt) {
      const createdAt = relatedDocs.deposit_receipt.created_at
        ? this.formatDate(relatedDocs.deposit_receipt.created_at)
        : 'Date TBD'
      depositLines.push(
        `Deposit Receipt ${relatedDocs.deposit_receipt.display_doc_no || relatedDocs.deposit_receipt.doc_no} (${createdAt}) • ${relatedDocs.deposit_receipt.status?.toUpperCase?.() || relatedDocs.deposit_receipt.status || 'Status unknown'
        }`
      )
    }

    if (depositLines.length > 0) {
      this.doc.setFontSize(9)
      this.doc.setFont('helvetica', 'bold')
      this.doc.text('Deposit Documentation', this.margin, y)
      y += 5

      this.doc.setFont('helvetica', 'normal')
      this.doc.setFontSize(8)
      depositLines.forEach((line) => {
        const wrapped = this.doc.splitTextToSize(`• ${line}`, this.pageWidth - 2 * this.margin) as string[]
        wrapped.forEach((segment) => {
          this.doc.text(segment, this.margin, y)
          y += 4
        })
        y += 1
      })

      y += 4
    }

    // Order Lines Section (reuse to show items context)
    y = this.addOrderLinesSection(orderData, y)

    // Summary Section tailored for balance request
    const summaryRows: Array<[string, string]> = [
      ['Order Total (100%)', this.formatCurrency(orderTotal)]
    ]

    if (depositAmount > 0) {
      const depositLabel = relatedDocs.deposit_payment?.doc_no
        ? `Deposit Paid (${relatedDocs.deposit_payment.display_doc_no || relatedDocs.deposit_payment.doc_no})`
        : 'Deposit Paid'
      summaryRows.push([depositLabel, this.formatCurrency(depositAmount)])
    }

    const balanceLabel = typeof balancePercentage === 'number'
      ? `Balance Requested (${Math.round(balancePercentage)}%)`
      : 'Balance Requested'
    summaryRows.push([balanceLabel, this.formatCurrency(normalizedRequestedAmount)])

    summaryRows.push(['Outstanding After Approval', this.formatCurrency(outstandingAfterApproval)])

    y = this.addSummarySection(orderData, y, {
      customRows: summaryRows,
      grandTotalOverride: normalizedRequestedAmount,
      grandTotalLabel: 'BALANCE AMOUNT REQUESTED',
      spacingAfterTable: 12
    })

    y += 4

    // Request Notes
    const notes: string[] = []
    const autoGeneratedAt = payload?.warehouse_receive_snapshot?.created_at
    const reasonLabel = this.formatRequestReason(payload.reason as string | undefined)
    const triggerLabel = this.formatTriggerMode(payload.trigger_mode as string | undefined)

    notes.push(reasonLabel)
    notes.push(`Trigger: ${triggerLabel}`)

    if (autoGeneratedAt) {
      notes.push(`Auto-generated on ${this.format12HourTime(autoGeneratedAt)}`)
    }

    this.doc.setFontSize(9)
    this.doc.setFont('helvetica', 'bold')
    this.doc.text('Request Notes', this.margin, y)
    y += 5

    this.doc.setFont('helvetica', 'normal')
    this.doc.setFontSize(8)
    notes.forEach((note) => {
      const wrapped = this.doc.splitTextToSize(`• ${note}`, this.pageWidth - 2 * this.margin) as string[]
      wrapped.forEach((segment) => {
        this.doc.text(segment, this.margin, y)
        y += 4
      })
      y += 1
    })

    y += 4

    // Organization Terms & Conditions (verbatim, omitted when unset)
    y = this.addTermsSection(orderData.organization_terms, y)

    // Signatures / Approval Trail
    y = await this.addSignaturesApprovalTrail(y, orderData, documentData)

    return this.doc.output('blob')
  }

  private addReceiptSummarySection(params: {
    yPosition: number
    orderTotal: number
    receiptAmount: number
    receiptPortionPercentage: number
    totalPaidToDate: number
    balanceRemaining: number
    isDepositReceipt: boolean
    isFinalReceipt: boolean
  }): number {
    const {
      yPosition,
      orderTotal,
      receiptAmount,
      receiptPortionPercentage,
      totalPaidToDate,
      balanceRemaining,
      isDepositReceipt,
      isFinalReceipt
    } = params

    let y = yPosition

    // SUMMARY Header
    this.doc.setFontSize(11)
    this.doc.setFont('helvetica', 'bold')
    this.doc.text('SUMMARY', this.margin, y)
    y += 7

    const summaryTableWidth = this.pageWidth - 2 * this.margin
    const labelColumnWidth = summaryTableWidth * 0.65
    const valueColumnWidth = summaryTableWidth - labelColumnWidth

    const normalizedPortion = typeof receiptPortionPercentage === 'number' && isFinite(receiptPortionPercentage)
      ? receiptPortionPercentage
      : isFinalReceipt
        ? 100
        : 0
    const roundedPortion = Math.round(normalizedPortion)

    const paymentLabel = isFinalReceipt
      ? 'This Receipt (Final Payment)'
      : `This Receipt (Deposit ${roundedPortion}%)`

    const percentageLabel = isFinalReceipt
      ? 'Final Payment 100%'
      : `Deposit Payment ${roundedPortion}%`

    const summaryRows: [string, string][] = [
      ['Order Total', this.formatCurrency(orderTotal)],
      ['Payment Coverage', percentageLabel],
      [paymentLabel, this.formatCurrency(receiptAmount)],
      ['Total Paid To Date', this.formatCurrency(totalPaidToDate)],
      ['Balance Remaining', this.formatCurrency(balanceRemaining)]
    ]

    const rowsWithAmountReceived: [string, string][] = [
      ...summaryRows,
      ['AMOUNT RECEIVED (THIS RECEIPT)', this.formatCurrency(receiptAmount)]
    ]

    autoTable(this.doc, {
      startY: y,
      body: rowsWithAmountReceived,
      theme: 'grid',
      styles: {
        fontSize: 9,
        cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
        lineColor: [100, 100, 100],
        lineWidth: 0.3
      },
      columnStyles: {
        0: { cellWidth: labelColumnWidth, halign: 'left', fontStyle: 'normal' },
        1: { cellWidth: valueColumnWidth, halign: 'right', fontStyle: 'normal' }
      },
      margin: { left: this.margin, right: this.margin },
      tableWidth: summaryTableWidth,
      didParseCell: (data) => {
        if (data.row.index === rowsWithAmountReceived.length - 1) {
          data.cell.styles.fontSize = 10
          data.cell.styles.fontStyle = 'bold'
          data.cell.styles.fillColor = [220, 220, 220]
          data.cell.styles.textColor = [0, 0, 0]
        }
      }
    })

    const summaryTable = (this.doc as any).lastAutoTable

    return summaryTable.finalY + 10
  }

  async generateSalesOrderPDF(orderData: OrderData, documentData: DocumentData): Promise<Blob> {
    let y = 15

    // Company Logo
    y = await this.addCompanyLogo(y, orderData.seller_logo_image)
    y += 5

    // Document Title
    y = this.addDocumentHeader('SALES ORDER (SO)', y)
    y += 3

    // SO Information Table
    const soInfo = [
      { label: 'SO Number:', value: documentData.display_doc_no || documentData.doc_no },
      // SO Date is the order's business date, not the SO document's creation time.
      { label: 'SO Date:', value: this.formatOrderBusinessDate(orderData.order_date, documentData.created_at) },
      { label: 'Status:', value: documentData.status.toUpperCase() },
      { label: 'Estimated ETA:', value: documentData.estimated_eta || '30 Oct 2025' },
      { label: 'Payment Terms:', value: this.formatPaymentTermsLabel(orderData.payment_terms) },
      { label: '', value: '' }
    ]
    y = this.addInfoTable(soInfo, y, 2)

    // Parties Section
    y = this.addPartiesSection(orderData, y, 'SO')

    // Order Lines Section
    y = this.addOrderLinesSection(orderData, y)

    // Summary Section
    y = this.addSummarySection(orderData, y)

    // Organization Terms & Conditions (verbatim, omitted when unset)
    y = this.addTermsSection(orderData.organization_terms, y)

    // Signatures / Approval Trail
    y = await this.addSignaturesApprovalTrail(y, orderData, documentData)

    return this.doc.output('blob')
  }

  async generateDeliveryOrderPDF(orderData: OrderData, documentData: DocumentData): Promise<Blob> {
    let y = 15

    // Company Logo
    y = await this.addCompanyLogo(y, orderData.seller_logo_image)
    y += 5

    // Document Title
    y = this.addDocumentHeader('DELIVERY ORDER (DO)', y)
    y += 3

    // DO Information Table
    const doInfo = [
      { label: 'DO Number:', value: documentData.display_doc_no || documentData.doc_no },
      { label: 'DO Date:', value: this.formatDate(documentData.created_at) },
      { label: 'Status:', value: documentData.status.toUpperCase() },
      { label: 'Estimated ETA:', value: documentData.estimated_eta || '30 Oct 2025' },
      { label: '', value: '' },
      { label: '', value: '' }
    ]
    y = this.addInfoTable(doInfo, y, 2)

    // Parties Section
    y = this.addPartiesSection(orderData, y, 'DO')

    // Check if this is a DH (D2H) order - DO should not show pricing info for DH orders
    const isDHOrder = orderData.order_type === 'DH' || orderData.order_type === 'D2H'

    // Order Lines Section - use simplified version for DH orders (no pricing)
    if (isDHOrder) {
      y = this.addOrderLinesSectionNoPricing(orderData, y)
      // Skip Summary Section for DH orders - DO is just for delivery tracking
    } else {
      y = this.addOrderLinesSection(orderData, y)
      // Summary Section - only for non-DH orders
      y = this.addSummarySection(orderData, y)
    }

    // Organization Terms & Conditions (verbatim, omitted when unset)
    y = this.addTermsSection(orderData.organization_terms, y)

    // Signatures / Approval Trail
    y = await this.addSignaturesApprovalTrail(y, orderData, documentData)

    return this.doc.output('blob')
  }

  /**
   * Order Lines Section without pricing columns - used for DH Delivery Orders
   * DH orders use DO purely for delivery tracking, not for pricing
   */
  private addOrderLinesSectionNoPricing(orderData: OrderData, yPosition: number): number {
    let y = yPosition

    // ORDER LINES Section Header
    this.doc.setFontSize(11)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setTextColor(0, 0, 0)
    this.doc.text('ORDER LINES', this.margin, y)
    y += 7

    // Prepare table data - without pricing columns
    const tableData = orderData.order_items.map((item, index) => {
      // Column 2: Product Name
      const productName = item.product?.product_name || 'Product'

      // Column 3: Variant Name
      const variantName = item.variant?.variant_name || ''

      // The ordered quantity is counted in cases; 100 cases fill one box. The
      // stored columns still read qty_cases / units_per_case — only the
      // customer-facing vocabulary changed, not the data.
      const qtyCases = Number(item.qty || 0).toLocaleString()
      const boxes = item.qty_cases || Math.ceil((item.qty || 0) / (item.units_per_case || 100))

      return [
        (index + 1).toString(),
        productName,
        variantName,
        qtyCases,
        boxes.toString()
      ]
    })

    autoTable(this.doc, {
      startY: y,
      head: [[
        '#',
        'Product Name',
        'Description',
        'Qty Cases',
        'Boxes'
      ]],
      body: tableData,
      theme: 'grid',
      styles: {
        fontSize: 8,
        cellPadding: 2,
        lineColor: [100, 100, 100],
        lineWidth: 0.3
      },
      headStyles: {
        fillColor: [255, 255, 255],
        textColor: [0, 0, 0],
        fontStyle: 'bold',
        halign: 'left',
        lineWidth: 0.3,
        lineColor: [100, 100, 100]
      },
      columnStyles: {
        0: { cellWidth: 12, halign: 'center' },
        1: { cellWidth: 45 },
        2: { cellWidth: 80 },
        3: { cellWidth: 25, halign: 'right' },
        4: { cellWidth: 25, halign: 'right' }
      },
      margin: { left: this.margin, right: this.margin },
      tableWidth: this.pageWidth - 2 * this.margin
    })

    return (this.doc as any).lastAutoTable.finalY + 8
  }
}
