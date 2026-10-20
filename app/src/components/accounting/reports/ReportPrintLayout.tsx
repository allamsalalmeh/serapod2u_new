'use client'

import type { ReactNode } from 'react'

/**
 * Shared layout for printable financial statements.
 *
 * Mirrors the legacy UBS / SQL Account report header:
 *   SERAPOD TECHNOLOGY SDN BHD 1511495-X
 *   TRADING AND PROFIT & LOSS ACCOUNT
 *   FOR YEAR ENDING 30/09/2024                       PAGE : 1
 *
 * Printing: only the element marked `.fin-report-print` is printed (the app shell,
 * filters and buttons are hidden), on A4 portrait with page numbers in the footer.
 * Use the browser's "Save as PDF" to produce a PDF.
 */

export interface ReportCompany {
  name: string | null
  registrationNo: string | null
}

interface ReportPrintLayoutProps {
  company: ReportCompany | null
  title: string
  subtitle?: string
  /** Optional right-aligned note under the header (e.g. "Prepared on 19/10/2026") */
  note?: string
  children: ReactNode
  /** Sign-off block at the end of the statement */
  footer?: ReactNode
}

/** 2024-09-30 → 30/09/2024 */
export function formatReportDate(iso: string | null | undefined) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

/** 1234.5 → 1,234.50 ; -1234.5 → (1,234.50) ; 0 → 0.00 */
export function formatAmount(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return ''
  const abs = Math.abs(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < -0.004 ? `(${abs})` : abs
}

/** Percentage of a base (e.g. sales). Blank when the base is zero. */
export function formatPercent(value: number, base: number) {
  if (!base || Math.abs(base) < 0.005) return ''
  return ((value / base) * 100).toFixed(2)
}

const PRINT_CSS = `
@media print {
  @page { size: A4 portrait; margin: 14mm 12mm 16mm 12mm;
    @bottom-right { content: "PAGE : " counter(page); font: 9pt monospace; } }
  body * { visibility: hidden !important; }
  .fin-report-print, .fin-report-print * { visibility: visible !important; }
  .fin-report-print { position: absolute; left: 0; top: 0; width: 100%;
    border: 0 !important; box-shadow: none !important; padding: 0 !important; background: #fff !important; color: #000 !important; }
  .fin-report-print .fin-no-print { display: none !important; }
  .fin-report-print tr { break-inside: avoid; }
}
`

export default function ReportPrintLayout({ company, title, subtitle, note, children, footer }: ReportPrintLayoutProps) {
  const companyLine = [company?.name, company?.registrationNo].filter(Boolean).join(' ')

  return (
    <div className="fin-report-print rounded-lg border bg-white dark:bg-zinc-950 p-6 sm:p-8 text-[13px] text-zinc-900 dark:text-zinc-100">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <header className="text-center mb-6 space-y-0.5">
        {companyLine && <p className="font-semibold uppercase tracking-wide">{companyLine}</p>}
        <p className="font-semibold uppercase">{title}</p>
        {subtitle && <p className="uppercase">{subtitle}</p>}
        {note && <p className="text-right text-xs text-zinc-500">{note}</p>}
      </header>

      {children}

      {footer && <footer className="mt-10">{footer}</footer>}
    </div>
  )
}
