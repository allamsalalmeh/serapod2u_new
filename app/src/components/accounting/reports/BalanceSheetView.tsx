'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/use-toast'
import {
  Scale, RefreshCw, Loader2, Calendar, Download, FileText, Printer, ListTree,
  CheckCircle2, AlertCircle,
} from 'lucide-react'
import ReportPrintLayout, { formatAmount, formatReportDate, type ReportCompany } from './ReportPrintLayout'

interface BalanceSheetViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

type Pair = { current: number; compare: number }
interface BSLine { code: string; name: string; current: number; compare: number }
interface BSGroup { key: string; label: string; accounts: BSLine[]; current: number; compare: number }
interface BSSection { key: string; label: string; groups: BSGroup[]; current: number; compare: number }

interface BSReport {
  company: ReportCompany
  asAtDate: string
  compareMode: 'prev_fy_end' | 'none'
  compareAt: string | null
  fiscalYearLabel: string | null
  sections: {
    fixedAssets: BSSection
    currentAssets: BSSection
    currentLiabilities: BSSection
    longTermLiabilities: BSSection
    financing: BSSection
  }
  totals: { totalAssets: Pair; totalLiabilities: Pair; netCurrentAssets: Pair; netAssets: Pair; financing: Pair }
  balanced: boolean
  hasData: boolean
}

export default function BalanceSheetView({ userProfile: _userProfile }: BalanceSheetViewProps) {
  const [report, setReport] = useState<BSReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [asAtDate, setAsAtDate] = useState(new Date().toISOString().split('T')[0])
  const [compareMode, setCompareMode] = useState<'prev_fy_end' | 'none'>('prev_fy_end')
  const [detailed, setDetailed] = useState(false)

  const loadReport = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      if (asAtDate) params.append('as_at', asAtDate)
      params.append('compare', compareMode)
      const res = await fetch(`/api/accounting/reports/balance-sheet?${params}`)
      if (res.ok) {
        setReport(await res.json())
      } else {
        toast({ title: 'Error', description: 'Failed to load balance sheet', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load balance sheet', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [asAtDate, compareMode])

  useEffect(() => { loadReport() }, [loadReport])

  const showCompare = report?.compareMode === 'prev_fy_end' && !!report?.compareAt
  const colCount = showCompare ? 3 : 2

  // ── CSV ──────────────────────────────────────────────────────────
  const handleExportCSV = () => {
    if (!report) return
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`
    const rows: string[][] = []
    const push = (label: string, p: Pair, code = '') => {
      const r = [code, q(label), p.current.toFixed(2)]
      if (showCompare) r.push(p.compare.toFixed(2))
      rows.push(r)
    }
    rows.push([q(report.company.name || '')])
    rows.push([q('BALANCE SHEET')])
    rows.push([q(`AS AT ${formatReportDate(report.asAtDate)}`)])
    rows.push([])
    const head = ['Code', 'Description', `${formatReportDate(report.asAtDate)} (RM)`]
    if (showCompare) head.push(`${formatReportDate(report.compareAt)} (RM)`)
    rows.push(head)
    const sec = (s: BSSection) => {
      if (s.groups.length === 0) return
      rows.push(['', q(s.label)])
      for (const g of s.groups) for (const a of g.accounts) push(a.name, a, a.code)
      push(`TOTAL ${s.label}`, s)
    }
    const S = report.sections
    sec(S.fixedAssets)
    sec(S.currentAssets)
    sec(S.currentLiabilities)
    push('NET CURRENT ASSETS', report.totals.netCurrentAssets)
    sec(S.longTermLiabilities)
    push('NET ASSETS', report.totals.netAssets)
    sec(S.financing)

    const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `balance-sheet-${report.asAtDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Rendering helpers ────────────────────────────────────────────
  const num = 'py-1 px-2 text-right font-mono tabular-nums whitespace-nowrap w-40'

  const Amounts = ({ p, bold = false, rule = '' }: { p: Pair; bold?: boolean; rule?: '' | 'single' | 'double' }) => {
    const border = rule === 'single' ? 'border-t border-zinc-400' : rule === 'double' ? 'border-t border-zinc-400 border-b-4 border-double' : ''
    return (
      <>
        <td className={`${num} ${bold ? 'font-semibold' : ''} ${border}`}>{formatAmount(p.current)}</td>
        {showCompare && <td className={`${num} ${bold ? 'font-semibold' : ''} ${border}`}>{formatAmount(p.compare)}</td>}
      </>
    )
  }

  const Heading = ({ label }: { label: string }) => (
    <tr><td colSpan={colCount} className="pt-6 pb-1 font-semibold">{label}</td></tr>
  )

  const Section = ({ s, subtotal = true }: { s: BSSection; subtotal?: boolean }) => {
    if (s.groups.length === 0) return null
    return (
      <>
        <Heading label={s.label} />
        {s.groups.map((g) => (
          <Fragment key={g.key}>
            <tr>
              <td className="py-1 pl-6">
                {detailed && g.accounts.length === 1 && g.accounts[0].code && (
                  <span className="font-mono text-xs text-zinc-500 mr-3">{g.accounts[0].code}</span>
                )}
                {g.label}
              </td>
              {detailed && g.accounts.length > 1 ? <td colSpan={colCount - 1} /> : <Amounts p={g} />}
            </tr>
            {detailed && g.accounts.length > 1 && (
              <>
                {g.accounts.map((a) => (
                  <tr key={`${g.key}-${a.code}-${a.name}`} className="text-[12px] text-zinc-600 dark:text-zinc-400">
                    <td className="py-0.5 pl-12"><span className="font-mono mr-3">{a.code}</span>{a.name}</td>
                    <Amounts p={a} />
                  </tr>
                ))}
                <tr><td /><Amounts p={g} rule="single" /></tr>
              </>
            )}
          </Fragment>
        ))}
        {subtotal && <tr><td /><Amounts p={s} rule="single" bold /></tr>}
      </>
    )
  }

  const S = report?.sections

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Scale className="h-5 w-5 text-emerald-600" />
                Balance Sheet
              </CardTitle>
              <CardDescription className="flex items-center gap-2">
                Statement of financial position as at the selected date.
                {report?.hasData && (report.balanced ? (
                  <span className="text-green-600 inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Balanced</span>
                ) : (
                  <span className="text-red-600 inline-flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Out of balance</span>
                ))}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">As at</span>
              <Input type="date" value={asAtDate} onChange={(e) => setAsAtDate(e.target.value)} className="h-8 w-36 text-sm" />
              <select
                value={compareMode}
                onChange={(e) => setCompareMode(e.target.value as 'prev_fy_end' | 'none')}
                className="h-8 rounded-md border bg-background px-2 text-sm"
                aria-label="Comparative column"
              >
                <option value="prev_fy_end">Compare: previous year end</option>
                <option value="none">No comparison</option>
              </select>
              <Button variant={detailed ? 'default' : 'outline'} size="sm" onClick={() => setDetailed((v) => !v)}>
                <ListTree className="h-4 w-4 mr-1.5" /> {detailed ? 'Detailed' : 'Summary'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!report?.hasData}>
                <Printer className="h-4 w-4 mr-1.5" /> Print / PDF
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={!report?.hasData}>
                <Download className="h-4 w-4 mr-1.5" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={loadReport} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Statement */}
      {loading && !report ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-emerald-500" /></div>
      ) : !report || !report.hasData || !S ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <FileText className="h-12 w-12 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground font-medium">No posted balances as at this date</p>
          </CardContent>
        </Card>
      ) : (
        <ReportPrintLayout
          company={report.company}
          title="Balance Sheet"
          subtitle={`As at ${formatReportDate(report.asAtDate)}`}
          note={report.fiscalYearLabel ? `Fiscal year: ${report.fiscalYearLabel}` : undefined}
          footer={
            <div className="text-xs space-y-10">
              <p className="uppercase">
                I/We hereby certify that the statement given above is true and correct to the best of my/our knowledge and belief.
              </p>
              <p>..........................................</p>
            </div>
          }
        >
          <div className={loading ? 'opacity-50 transition-opacity' : ''}>
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-xs">
                  <th />
                  <th className="px-2 text-right font-semibold">{formatReportDate(report.asAtDate)}</th>
                  {showCompare && <th className="px-2 text-right font-semibold">{formatReportDate(report.compareAt)}</th>}
                </tr>
                <tr className="text-xs text-zinc-500 border-b border-zinc-400">
                  <th />
                  <th className="px-2 pb-1 text-right font-normal">( RM )</th>
                  {showCompare && <th className="px-2 pb-1 text-right font-normal">( RM )</th>}
                </tr>
              </thead>
              <tbody>
                <Section s={S.fixedAssets} subtotal={S.fixedAssets.groups.length > 1} />
                <Section s={S.currentAssets} />
                <Section s={S.currentLiabilities} />

                <tr className="font-semibold">
                  <td className="pt-6 py-1">NET CURRENT ASSETS</td>
                  <Amounts p={report.totals.netCurrentAssets} bold />
                </tr>

                {S.longTermLiabilities.groups.length > 0 && <Section s={S.longTermLiabilities} />}

                <tr><td className="py-2" /><Amounts p={report.totals.netAssets} bold rule="double" /></tr>

                <Heading label="FINANCED BY" />
                {S.financing.groups.length > 0 && (
                  <Section s={{ ...S.financing, label: 'CAPITAL' }} subtotal={false} />
                )}
                <tr><td className="py-2" /><Amounts p={report.totals.financing} bold rule="double" /></tr>
              </tbody>
            </table>
          </div>
        </ReportPrintLayout>
      )}
    </div>
  )
}
