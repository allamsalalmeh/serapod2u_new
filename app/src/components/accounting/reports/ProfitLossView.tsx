'use client'

import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/use-toast'
import {
  TrendingUp, RefreshCw, Loader2, Calendar, Download, FileText, Printer, ListTree,
} from 'lucide-react'
import ReportPrintLayout, {
  formatAmount, formatPercent, formatReportDate, type ReportCompany,
} from './ReportPrintLayout'

interface ProfitLossViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

type Amounts = { current: number; compare: number | null }
interface PLLine { code: string; name: string; current: number; compare: number }
interface PLGroup { key: string; label: string; accounts: PLLine[]; current: number; compare: number }
interface PLSection { key: 'sales' | 'cogs' | 'other_income' | 'expenses'; label: string; groups: PLGroup[]; current: number; compare: number }

interface PLReport {
  company: ReportCompany
  fromDate: string
  toDate: string
  fiscalYearLabel: string | null
  compareMode: 'prev_year' | 'none'
  compareFrom: string | null
  compareTo: string | null
  sections: PLSection[]
  totals: {
    sales: Amounts; cogs: Amounts; grossProfit: Amounts; otherIncome: Amounts
    afterOtherIncome: Amounts; expenses: Amounts; netProfit: Amounts
    retainedBF: Amounts; retainedCF: Amounts
  }
  hasData: boolean
}

export default function ProfitLossView({ userProfile: _userProfile }: ProfitLossViewProps) {
  const [report, setReport] = useState<PLReport | null>(null)
  const [loading, setLoading] = useState(true)

  // `from` starts empty: the API then uses the fiscal year that contains `to`.
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState(new Date().toISOString().split('T')[0])
  const [compareMode, setCompareMode] = useState<'prev_year' | 'none'>('prev_year')
  const [detailed, setDetailed] = useState(false)
  const skipNextLoad = useRef(false)

  const loadReport = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      if (dateFrom) params.append('from', dateFrom)
      if (dateTo) params.append('to', dateTo)
      params.append('compare', compareMode)

      const res = await fetch(`/api/accounting/reports/profit-loss?${params}`)
      if (res.ok) {
        const data: PLReport = await res.json()
        setReport(data)
        if (!dateFrom && data.fromDate) {
          skipNextLoad.current = true // reflect the resolved fiscal-year start without refetching
          setDateFrom(data.fromDate)
        }
      } else {
        toast({ title: 'Error', description: 'Failed to load P&L', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load P&L', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, compareMode])

  useEffect(() => {
    if (skipNextLoad.current) { skipNextLoad.current = false; return }
    loadReport()
  }, [loadReport])

  const showCompare = report?.compareMode === 'prev_year'
  const salesCur = report?.totals.sales.current || 0
  const salesCmp = report?.totals.sales.compare || 0

  const handleExportCSV = () => {
    if (!report) return
    const rows: (string | number)[][] = []
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`
    const line = (label: string, a: { current: number; compare: number | null }, code = '') => {
      const r: (string | number)[] = [code, q(label), a.current.toFixed(2), formatPercent(a.current, salesCur)]
      if (showCompare) r.push((a.compare ?? 0).toFixed(2), formatPercent(a.compare ?? 0, salesCmp))
      rows.push(r)
    }
    rows.push([q(report.company.name || '')])
    rows.push([q('TRADING AND PROFIT & LOSS ACCOUNT')])
    rows.push([q(`FOR THE PERIOD ${formatReportDate(report.fromDate)} TO ${formatReportDate(report.toDate)}`)])
    rows.push([])
    const head: string[] = ['Code', 'Description', 'Year-to-date (RM)', '%']
    if (showCompare) head.push('Last year (RM)', '%')
    rows.push(head)
    for (const s of report.sections) {
      rows.push(['', s.label])
      for (const g of s.groups) {
        for (const a of g.accounts) line(a.name, a, a.code)
      }
      line(`TOTAL ${s.label}`, s)
      if (s.key === 'cogs') line('GROSS PROFIT/(LOSS)', report.totals.grossProfit)
      if (s.key === 'other_income') line('', report.totals.afterOtherIncome)
    }
    line('NET PROFIT/(LOSS)', report.totals.netProfit)
    rows.push(['', 'RETAINED PROFIT/(LOSS) B/F', report.totals.retainedBF.current.toFixed(2)])
    rows.push(['', 'RETAINED PROFIT/(LOSS) C/F', report.totals.retainedCF.current.toFixed(2)])

    const csv = rows.map((r) => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `profit-loss-${report.fromDate}-to-${report.toDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Row helpers ──────────────────────────────────────────────────
  const numCell = 'py-1 px-2 text-right font-mono tabular-nums whitespace-nowrap'
  const pctCell = 'py-1 px-2 text-right font-mono tabular-nums text-xs text-zinc-500 whitespace-nowrap w-16'

  const AmountCells = ({ cur, cmp, bold = false, rule = false }: { cur: number; cmp: number | null; bold?: boolean; rule?: boolean }) => (
    <>
      <td className={`${numCell} ${bold ? 'font-semibold' : ''} ${rule ? 'border-t border-zinc-400' : ''}`}>{formatAmount(cur)}</td>
      <td className={`${pctCell} ${rule ? 'border-t border-zinc-400' : ''}`}>{formatPercent(cur, salesCur)}</td>
      {showCompare && (
        <>
          <td className={`${numCell} ${bold ? 'font-semibold' : ''} ${rule ? 'border-t border-zinc-400' : ''}`}>{cmp === null ? '' : formatAmount(cmp)}</td>
          <td className={`${pctCell} ${rule ? 'border-t border-zinc-400' : ''}`}>{cmp === null ? '' : formatPercent(cmp, salesCmp)}</td>
        </>
      )}
    </>
  )

  const colCount = showCompare ? 5 : 3

  const SectionHeading = ({ label }: { label: string }) => (
    <tr><td colSpan={colCount} className="pt-5 pb-1 font-semibold">{label}</td></tr>
  )

  const SubtotalRow = ({ label, a, strong = false }: { label: string; a: Amounts; strong?: boolean }) => (
    <tr className={strong ? 'font-semibold' : ''}>
      <td className={`py-1 ${strong ? 'pt-4' : ''}`}>{label}</td>
      <AmountCells cur={a.current} cmp={a.compare} bold={strong} rule />
    </tr>
  )

  const renderSection = (s: PLSection) => {
    if (s.groups.length === 0) return null
    return (
      <Fragment key={s.key}>
        <SectionHeading label={s.label} />
        {s.groups.map((g) => (
          <Fragment key={g.key}>
            {detailed ? (
              <>
                {s.groups.length > 1 || g.label !== s.label ? (
                  <tr><td colSpan={colCount} className="pt-2 pl-6 text-xs font-semibold text-zinc-600 dark:text-zinc-400">{g.label}</td></tr>
                ) : null}
                {g.accounts.map((a) => (
                  <tr key={a.code}>
                    <td className="py-0.5 pl-6"><span className="font-mono text-xs text-zinc-500 mr-3">{a.code}</span>{a.name}</td>
                    <AmountCells cur={a.current} cmp={a.compare} />
                  </tr>
                ))}
                {s.groups.length > 1 && (
                  <tr><td className="py-0.5 pl-6 text-xs text-zinc-500">Total {g.label.toLowerCase()}</td><AmountCells cur={g.current} cmp={g.compare} rule /></tr>
                )}
              </>
            ) : (
              <tr>
                <td className="py-1 pl-6">{g.label}</td>
                <AmountCells cur={g.current} cmp={g.compare} />
              </tr>
            )}
          </Fragment>
        ))}
        {(detailed || s.groups.length > 1) && (
          <tr><td /><AmountCells cur={s.current} cmp={s.compare} bold rule /></tr>
        )}
      </Fragment>
    )
  }

  const sectionByKey = (k: PLSection['key']) => report?.sections.find((s) => s.key === k)

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <TrendingUp className="h-5 w-5 text-emerald-600" />
                Profit & Loss Statement
              </CardTitle>
              <CardDescription>
                Trading and profit &amp; loss account. Defaults to the current fiscal year.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8 w-36 text-sm" />
              <span className="text-xs text-muted-foreground">to</span>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8 w-36 text-sm" />
              <select
                value={compareMode}
                onChange={(e) => setCompareMode(e.target.value as 'prev_year' | 'none')}
                className="h-8 rounded-md border bg-background px-2 text-sm"
                aria-label="Comparative column"
              >
                <option value="prev_year">Compare: last year</option>
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
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
        </div>
      ) : !report || !report.hasData ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <FileText className="h-12 w-12 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground font-medium">No income or expense entries for this period</p>
          </CardContent>
        </Card>
      ) : (
        <ReportPrintLayout
          company={report.company}
          title="Trading and Profit & Loss Account"
          subtitle={`For the period ${formatReportDate(report.fromDate)} to ${formatReportDate(report.toDate)}`}
          note={report.fiscalYearLabel ? `Fiscal year: ${report.fiscalYearLabel}` : undefined}
        >
          <div className={loading ? 'opacity-50 transition-opacity' : ''}>
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-xs">
                  <th />
                  <th className="px-2 text-right font-semibold">YEAR-TO-DATE</th>
                  <th className="px-2 text-right font-semibold">%</th>
                  {showCompare && (
                    <>
                      <th className="px-2 text-right font-semibold">LAST YEAR</th>
                      <th className="px-2 text-right font-semibold">%</th>
                    </>
                  )}
                </tr>
                <tr className="text-xs text-zinc-500 border-b border-zinc-400">
                  <th />
                  <th className="px-2 pb-1 text-right font-normal">( RM )</th>
                  <th />
                  {showCompare && (
                    <>
                      <th className="px-2 pb-1 text-right font-normal">( RM )</th>
                      <th />
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {sectionByKey('sales') && renderSection(sectionByKey('sales')!)}
                {sectionByKey('cogs') && renderSection(sectionByKey('cogs')!)}
                <SubtotalRow label="GROSS PROFIT/(LOSS)" a={report.totals.grossProfit} strong />

                {sectionByKey('other_income')!.groups.length > 0 && (
                  <>
                    {renderSection(sectionByKey('other_income')!)}
                    <tr><td /><AmountCells cur={report.totals.afterOtherIncome.current} cmp={report.totals.afterOtherIncome.compare} bold rule /></tr>
                  </>
                )}

                {sectionByKey('expenses') && renderSection(sectionByKey('expenses')!)}

                <SubtotalRow label="NET PROFIT/(LOSS)" a={report.totals.netProfit} strong />

                <tr><td colSpan={colCount} className="h-4" /></tr>
                <tr>
                  <td className="py-1">RETAINED PROFIT/(LOSS) B/F</td>
                  <AmountCells cur={report.totals.retainedBF.current} cmp={null} />
                </tr>
                <tr className="font-semibold">
                  <td className="py-1">RETAINED PROFIT/(LOSS) C/F</td>
                  <td className={`${numCell} border-t border-b-4 border-double border-zinc-500`}>{formatAmount(report.totals.retainedCF.current)}</td>
                  <td colSpan={showCompare ? 3 : 1} />
                </tr>
              </tbody>
            </table>
            {showCompare && report.compareFrom && (
              <p className="mt-4 text-xs text-zinc-500">
                Last year column: {formatReportDate(report.compareFrom)} to {formatReportDate(report.compareTo)}.
              </p>
            )}
          </div>
        </ReportPrintLayout>
      )}
    </div>
  )
}
