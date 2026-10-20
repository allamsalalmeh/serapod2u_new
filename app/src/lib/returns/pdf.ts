/**
 * Serapod Return Product PDF — branded A4 "Product Return Note".
 *
 * Visual reference: the approved Product Return Note body layout.
 *   - serapod-return-header.png  → top banner (every page)
 *   - Footer.png                 → bottom footer (every page)
 *   - Text-only section headings (no product-line logos in the body).
 *   - Flavour sections (Cellera Zero / Hero): PCS · CASES · TOTAL columns.
 *   - Device sections (S.Line / S.Box): PCS · TOTAL only — never a CASES column.
 *
 * Uses jsPDF + jspdf-autotable (existing project dependencies). Only sections
 * with at least one entered item are rendered; empty rows/sections are omitted.
 */
import { RETURN_STATUS_LABELS, RETURN_SOURCE_LABELS, normalizeReturnSourceType } from './constants'
import {
    getVariantDisplayName,
    classifyProductLine,
    productLineLabel,
    formatReturnAmount,
    type ProductLine,
} from './format'
import { itemsTotalQty, itemsTotalValue } from './compute'
import type { ReturnCase, ReturnCaseItem } from './types'

// ── Section definition ────────────────────────────────────────────────────

interface ProductSection {
    line: ProductLine
    title: string // uppercase heading, e.g. "CELLERA ZERO"
    device: boolean
}

const SECTIONS: ProductSection[] = [
    { line: 'zero', title: 'CELLERA ZERO', device: false },
    { line: 'hero', title: 'CELLERA HERO', device: false },
    { line: 'sline', title: 'DEVICE S.LINE', device: true },
    { line: 'sbox', title: 'DEVICE S.BOX', device: true },
]

const ASSET_BASE = '/images/serapod-return-pdf-assets'

// ── Palette (RGB) ──────────────────────────────────────────────────────────
const INK: [number, number, number] = [26, 26, 26]
const MUTED: [number, number, number] = [120, 120, 120]
const ORANGE: [number, number, number] = [219, 109, 44]
const BAND: [number, number, number] = [243, 238, 230] // cream section band
const BAND_BORDER: [number, number, number] = [226, 219, 205]
const BOX_BORDER: [number, number, number] = [222, 222, 222]
const BOX_FILL: [number, number, number] = [249, 250, 251]
const STRIPE: [number, number, number] = [248, 248, 248]

// ── Image helpers ─────────────────────────────────────────────────────────

export interface LoadedImage { url: string; w: number; h: number }

/**
 * Load a local image → PNG data URL (via off-screen canvas).
 *
 * When `cropBlank` is set, transparent / near-white borders around the visible
 * artwork are trimmed so the banner can be placed edge-to-edge at full width
 * without distortion. `w`/`h` reflect the *cropped* pixel size, so callers keep
 * the correct aspect ratio. Cropping never stretches the image.
 */
export async function loadImageDataUrl(src: string, cropBlank = false): Promise<LoadedImage> {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload = () => {
            const W = img.naturalWidth
            const H = img.naturalHeight
            const base = document.createElement('canvas')
            base.width = W
            base.height = H
            const ctx = base.getContext('2d')
            if (!ctx) { reject(new Error('Canvas context unavailable')); return }
            ctx.drawImage(img, 0, 0)

            let sx = 0, sy = 0, sw = W, sh = H
            if (cropBlank) {
                try {
                    const { data } = ctx.getImageData(0, 0, W, H)
                    let minx = W, miny = H, maxx = -1, maxy = -1
                    for (let y = 0; y < H; y++) {
                        for (let x = 0; x < W; x++) {
                            const i = (y * W + x) * 4
                            const a = data[i + 3]
                            const r = data[i], g = data[i + 1], b = data[i + 2]
                            const blank = a < 10 || (r > 248 && g > 248 && b > 248)
                            if (blank) continue
                            if (x < minx) minx = x
                            if (y < miny) miny = y
                            if (x > maxx) maxx = x
                            if (y > maxy) maxy = y
                        }
                    }
                    if (maxx >= minx && maxy >= miny) {
                        sx = minx; sy = miny; sw = maxx - minx + 1; sh = maxy - miny + 1
                    }
                } catch { /* tainted canvas / read failure — fall back to full image */ }
            }

            if (sx === 0 && sy === 0 && sw === W && sh === H) {
                resolve({ url: base.toDataURL('image/png'), w: W, h: H })
                return
            }
            const cropped = document.createElement('canvas')
            cropped.width = sw
            cropped.height = sh
            const cctx = cropped.getContext('2d')
            if (!cctx) { resolve({ url: base.toDataURL('image/png'), w: W, h: H }); return }
            cctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
            resolve({ url: cropped.toDataURL('image/png'), w: sw, h: sh })
        }
        img.onerror = () => reject(new Error(`Failed to load image: ${src}`))
        img.src = src
    })
}

// ── Formatting ─────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "12 Jul 2026, 07:31 PM" */
function formatDateTime(value?: string | null): string {
    if (!value) return '—'
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value)
    const day = String(d.getDate()).padStart(2, '0')
    const mon = MONTHS[d.getMonth()]
    const year = d.getFullYear()
    let h = d.getHours()
    const ampm = h >= 12 ? 'PM' : 'AM'
    h = h % 12 || 12
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${day} ${mon} ${year}, ${String(h).padStart(2, '0')}:${min} ${ampm}`
}

function joinAddress(org?: { address?: string | null; city?: string | null; postal_code?: string | null } | null): string {
    if (!org) return '—'
    return [org.address, org.postal_code ? `${org.postal_code}` : null, org.city].filter(Boolean).join(', ') || '—'
}

/** Total full cases (sum of case_qty) — flavour rows only carry cases. */
function itemsTotalBoxes(items: ReturnCaseItem[]): number {
    return items.reduce((sum, it) => sum + Math.max(0, Math.floor(Number(it.case_qty || 0))), 0)
}

// ── PDF Generation ─────────────────────────────────────────────────────────

export async function generateReturnPdf(
    rc: ReturnCase,
    opts: { instructionText?: string | null; preview?: boolean } = {},
): Promise<void> {
    const [{ default: jsPDF }, autoTableModule] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
    ])
    const autoTable = autoTableModule.default
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageWidth = doc.internal.pageSize.getWidth()   // 210
    const pageHeight = doc.internal.pageSize.getHeight() // 297
    const margin = 12
    const contentWidth = pageWidth - margin * 2

    // ── Preload banner + footer (best-effort) ──────────────────────────────
    // Header content fills its frame (no crop needed); footer has thin blank
    // borders that we trim so the gradient strip reaches full width.
    let header: LoadedImage | null = null
    let footer: LoadedImage | null = null
    try { header = await loadImageDataUrl(`${ASSET_BASE}/serapod-return-header.png`) } catch { /* optional */ }
    try { footer = await loadImageDataUrl(`${ASSET_BASE}/Footer.png`, true) } catch { /* optional */ }

    // Both banners render at the FULL content width, aspect ratio preserved.
    const headerImgH = header ? contentWidth * (header.h / header.w) : 0
    const footerImgH = footer ? contentWidth * (footer.h / footer.w) : 0

    // Vertical budget: every page reserves footer space (image + page number)
    // so tables never overlap the footer; continuation pages reserve a compact
    // top band for the repeated document title.
    const CONTINUE_TOP = 20
    const PAGENUM_BAND = 8 // clear strip below the footer for "Page X of Y"
    const FOOTER_RESERVE = (footerImgH || 12) + PAGENUM_BAND + 4
    const footerTopY = pageHeight - PAGENUM_BAND - (footerImgH || 12)
    const contentBottom = pageHeight - FOOTER_RESERVE

    // ── Group items by product line ────────────────────────────────────────
    const items = rc.items || []
    const grouped = new Map<ProductLine, ReturnCaseItem[]>()
    for (const it of items) {
        const line = classifyProductLine(it.product_name)
        if (!grouped.has(line)) grouped.set(line, [])
        grouped.get(line)!.push(it)
    }
    // 'other' items fall back into the flavour table (rare/edge master data).
    const visibleSections = SECTIONS.filter((sec) => (grouped.get(sec.line)?.length ?? 0) > 0)

    // ── Page 1 full-width header banner, then title row below it ───────────
    let y = 10
    if (header && headerImgH > 0) {
        try { doc.addImage(header.url, 'PNG', margin, y, contentWidth, headerImgH) } catch { /* skip */ }
        y += headerImgH + 6
    }
    // Title row: "PRODUCT RETURN NOTE" left, "Return No: …" right — below header.
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(15)
    doc.setTextColor(...INK)
    doc.text('PRODUCT RETURN NOTE', margin, y + 4)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(10)
    doc.setTextColor(...ORANGE)
    doc.text(`Return No: ${rc.return_no}`, pageWidth - margin, y + 4, { align: 'right' })
    y += 9
    doc.setDrawColor(...BAND_BORDER)
    doc.line(margin, y, pageWidth - margin, y)
    y += 5

    // ── Information block (two columns) ─────────────────────────────────────
    const statusLabel = RETURN_STATUS_LABELS[rc.status] || rc.status
    const source = rc.source || rc.shop || null
    const sourceLabel = RETURN_SOURCE_LABELS[normalizeReturnSourceType(rc.return_source_type)].toUpperCase()
    const sourceName = source?.org_name
        ? `${source.org_name}${source.org_code ? ` (${source.org_code})` : ''}`
        : '—'
    const contactName = rc.contact_person || source?.contact_name || '—'
    const contactPhone = rc.contact_phone || source?.contact_phone || ''
    const contactValue = contactPhone ? `${contactName} — ${contactPhone}` : contactName
    const contactEmail = rc.contact_email || source?.contact_email || '—'
    const whName = rc.warehouse?.org_name || '—'
    const createdBy = rc.created_by_name || '—'

    const reference = rc.tracking_no || '-'
    const leftPairs: Array<[string, string]> = [
        ['RETURN NO.', rc.return_no || '—'],
        ['CREATED', formatDateTime(rc.created_at || rc.reported_date)],
        [sourceLabel, sourceName],
        ['CONTACT', contactValue],
        ['EMAIL', contactEmail],
    ]
    const rightPairs: Array<[string, string]> = [
        ['STATUS', statusLabel],
        ['WAREHOUSE', whName],
        ['REFERENCE', reference],
        ['CREATED BY', createdBy],
        ['', ''],
    ]

    const infoRowH = 7
    const infoPadY = 4
    const infoH = infoRowH * leftPairs.length + infoPadY * 2
    doc.setDrawColor(...BOX_BORDER)
    doc.setFillColor(...BOX_FILL)
    doc.roundedRect(margin, y, contentWidth, infoH, 2, 2, 'FD')

    const labelW = 26
    const colGap = contentWidth / 2
    const leftLabelX = margin + 4
    const leftValX = leftLabelX + labelW
    const rightLabelX = margin + colGap + 2
    const rightValX = rightLabelX + labelW

    const drawPair = (labelX: number, valX: number, rowY: number, label: string, value: string, maxValW: number) => {
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(7)
        doc.setTextColor(...MUTED)
        doc.text(label, labelX, rowY)
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(8.5)
        doc.setTextColor(...INK)
        const lines = doc.splitTextToSize(value || '—', maxValW)
        doc.text(lines[0], valX, rowY)
    }

    let infoY = y + infoPadY + 3
    for (let i = 0; i < leftPairs.length; i++) {
        drawPair(leftLabelX, leftValX, infoY, leftPairs[i][0], leftPairs[i][1], colGap - labelW - 8)
        drawPair(rightLabelX, rightValX, infoY, rightPairs[i][0], rightPairs[i][1], colGap - labelW - 8)
        infoY += infoRowH
    }
    y += infoH + 3

    // ── Address block (source address + return-to) ─────────────────────────
    const shopAddr = joinAddress(source)
    const returnTo = [rc.warehouse?.org_name, joinAddress(rc.warehouse) !== '—' ? joinAddress(rc.warehouse) : null]
        .filter(Boolean).join(', ') || '—'
    doc.setFontSize(8)
    const shopAddrLines = doc.splitTextToSize(shopAddr, contentWidth - labelW - 10)
    const returnToLines = doc.splitTextToSize(returnTo, contentWidth - labelW - 10)
    const addrRowsH = (shopAddrLines.length + returnToLines.length) * 4.2
    const addrH = addrRowsH + 8
    doc.setDrawColor(...BOX_BORDER)
    doc.setFillColor(255, 255, 255)
    doc.roundedRect(margin, y, contentWidth, addrH, 2, 2, 'FD')

    let addrY = y + 5
    const drawAddrRow = (label: string, lines: string[]) => {
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(7)
        doc.setTextColor(...MUTED)
        doc.text(label, leftLabelX, addrY)
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(8)
        doc.setTextColor(...INK)
        doc.text(lines, leftValX, addrY)
        addrY += lines.length * 4.2
    }
    drawAddrRow(`${sourceLabel} ADDRESS`, shopAddrLines)
    drawAddrRow('RETURN TO', returnToLines)
    y += addrH + 5

    // ── Product sections ────────────────────────────────────────────────────
    let grandLines = 0
    let grandPcs = 0
    let grandBoxes = 0 // flavour only

    for (const sec of visibleSections) {
        const secItems = grouped.get(sec.line) || []
        if (secItems.length === 0) continue

        const secPcs = itemsTotalQty(secItems)
        const secBoxes = itemsTotalBoxes(secItems)
        grandLines += secItems.length
        grandPcs += secPcs
        if (!sec.device) grandBoxes += secBoxes

        // Keep the band with at least its header + one row on the same page.
        const bandH = 8
        if (y + bandH + 18 > contentBottom) {
            doc.addPage()
            y = CONTINUE_TOP
        }

        // Section band (cream) — text heading only.
        doc.setDrawColor(...BAND_BORDER)
        doc.setFillColor(...BAND)
        doc.rect(margin, y, contentWidth, bandH, 'FD')
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(9.5)
        doc.setTextColor(...INK)
        doc.text(sec.title, margin + 3, y + 5.5)
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(7.5)
        doc.setTextColor(...MUTED)
        doc.text(`${secItems.length} item line(s)`, pageWidth - margin - 3, y + 5.5, { align: 'right' })
        y += bandH

        // Build table body
        const head = sec.device
            ? [['PRODUCT / VARIANT', 'RETURN REASON', 'PCS', 'TOTAL']]
            : [['PRODUCT / FLAVOUR', 'RETURN REASON', 'PCS', 'CASES', 'TOTAL']]

        const body: Array<Array<string>> = []
        for (const it of secItems) {
            const caseQty = Math.max(0, Math.floor(Number(it.case_qty || 0)))
            const looseQty = Math.max(0, Math.floor(Number(it.loose_piece_qty || 0)))
            const total = Number(it.total_units || it.quantity || 0)
            const flavour = getVariantDisplayName(it.variant_name) || it.variant_name || it.product_name || '—'
            if (sec.device) {
                // Device: PCS only — total equals entered pieces directly.
                body.push([`${productLineLabel(sec.line)} - ${flavour}`, it.reason || '—', String(total), String(total)])
            } else {
                body.push([flavour, it.reason || '—', String(looseQty), String(caseQty), String(total)])
            }
        }

        const subtotalText = `SUBTOTAL ${sec.title}: ${secPcs} PCS`
        const nCols = sec.device ? 4 : 5

        const columnStyles: { [key: string]: { cellWidth: number; halign: 'left' | 'center' } } = sec.device
            ? {
                0: { cellWidth: contentWidth * 0.42, halign: 'left' },
                1: { cellWidth: contentWidth * 0.34, halign: 'left' },
                2: { cellWidth: contentWidth * 0.12, halign: 'center' },
                3: { cellWidth: contentWidth * 0.12, halign: 'center' },
            }
            : {
                0: { cellWidth: contentWidth * 0.34, halign: 'left' },
                1: { cellWidth: contentWidth * 0.30, halign: 'left' },
                2: { cellWidth: contentWidth * 0.12, halign: 'center' },
                3: { cellWidth: contentWidth * 0.12, halign: 'center' },
                4: { cellWidth: contentWidth * 0.12, halign: 'center' },
            }

        autoTable(doc, {
            startY: y,
            head,
            body,
            foot: [[{
                content: subtotalText,
                colSpan: nCols,
                styles: { halign: 'right', fontStyle: 'bold', fillColor: [255, 255, 255], textColor: INK },
            }]],
            showHead: 'everyPage', // repeat header when a section spans pages
            showFoot: 'lastPage',  // subtotal prints once, at the end of the section
            theme: 'grid',
            headStyles: {
                fillColor: INK,
                textColor: 255,
                fontStyle: 'bold',
                fontSize: 8,
                halign: 'left',
                cellPadding: 2,
            },
            styles: {
                fontSize: 8,
                cellPadding: 2,
                valign: 'middle',
                textColor: INK,
                lineColor: [225, 225, 225],
                lineWidth: 0.1,
            },
            alternateRowStyles: { fillColor: STRIPE },
            columnStyles,
            margin: { left: margin, right: margin, top: CONTINUE_TOP, bottom: FOOTER_RESERVE },
            tableWidth: contentWidth,
        })

        y = ((doc as any).lastAutoTable?.finalY ?? y) + 6
    }

    // ── Bottom summary cards ────────────────────────────────────────────────
    const cardsH = 18
    if (y + cardsH + 4 > contentBottom) { doc.addPage(); y = CONTINUE_TOP }
    const cardGap = 4
    const cards: Array<[string, string]> = [
        ['TOTAL ITEM LINES', String(grandLines)],
        ['TOTAL PCS', String(grandPcs)],
        ['TOTAL CASES', String(grandBoxes)],
        ['TOTAL VALUE (RM)', formatReturnAmount(itemsTotalValue(items))],
    ]
    const cardW = (contentWidth - cardGap * (cards.length - 1)) / cards.length
    cards.forEach(([label, value], i) => {
        const cx = margin + i * (cardW + cardGap)
        doc.setDrawColor(...BOX_BORDER)
        doc.setFillColor(...BOX_FILL)
        doc.roundedRect(cx, y, cardW, cardsH, 2, 2, 'FD')
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(7)
        doc.setTextColor(...MUTED)
        doc.text(label, cx + 4, y + 6)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(15)
        doc.setTextColor(...INK)
        doc.text(value, cx + 4, y + 14)
    })
    y += cardsH + 5

    // ── Notes + Shop confirmation ───────────────────────────────────────────
    const notesH = 30
    if (y + notesH + 2 > contentBottom) { doc.addPage(); y = CONTINUE_TOP }
    const halfW = (contentWidth - cardGap) / 2

    // Notes box (left)
    doc.setDrawColor(...BOX_BORDER)
    doc.setFillColor(255, 255, 255)
    doc.roundedRect(margin, y, halfW, notesH, 2, 2, 'FD')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7)
    doc.setTextColor(...MUTED)
    doc.text('NOTES', margin + 4, y + 6)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...INK)
    const noteLines: string[] = []
    if (rc.notes) noteLines.push(...doc.splitTextToSize(rc.notes, halfW - 8))
    const boilerplate = opts.instructionText
        || 'Verify quantities upon warehouse receipt.\nOnly entered products are printed; empty rows are omitted.'
    noteLines.push(...doc.splitTextToSize(boilerplate, halfW - 8))
    doc.text(noteLines.slice(0, 5), margin + 4, y + 12)

    // Shop confirmation box (right)
    const rx = margin + halfW + cardGap
    doc.setDrawColor(...BOX_BORDER)
    doc.setFillColor(255, 255, 255)
    doc.roundedRect(rx, y, halfW, notesH, 2, 2, 'FD')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(7)
    doc.setTextColor(...MUTED)
    doc.text(`${sourceLabel} CONFIRMATION`, rx + 4, y + 6)
    doc.setDrawColor(180)
    doc.line(rx + 4, y + 20, rx + halfW - 4, y + 20)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    doc.text('Name / Signature / Date', rx + 4, y + 25)
    y += notesH

    // ── Page chrome: compact header (pages ≥ 2) + footer image + page number ─
    const totalPages = doc.getNumberOfPages()
    for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p)

        if (p > 1) {
            doc.setFont('helvetica', 'bold')
            doc.setFontSize(9)
            doc.setTextColor(...INK)
            doc.text('PRODUCT RETURN NOTE', margin, 12)
            doc.setTextColor(...ORANGE)
            doc.text(`Return No: ${rc.return_no}`, pageWidth - margin, 12, { align: 'right' })
            doc.setDrawColor(...BOX_BORDER)
            doc.line(margin, 15, pageWidth - margin, 15)
        }

        // Full-width footer banner (same position on every page) + page number
        // in the clear band just below it.
        if (footer && footerImgH > 0) {
            try { doc.addImage(footer.url, 'PNG', margin, footerTopY, contentWidth, footerImgH) } catch { /* skip */ }
        }
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(7)
        doc.setTextColor(...MUTED)
        doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin, pageHeight - 3, { align: 'right' })
    }

    // ── Output ─────────────────────────────────────────────────────────────
    const filename = `Return-${rc.return_no}.pdf`
    if (opts.preview) {
        const url = doc.output('bloburl')
        window.open(url as unknown as string, '_blank')
    } else {
        doc.save(filename)
    }
}
