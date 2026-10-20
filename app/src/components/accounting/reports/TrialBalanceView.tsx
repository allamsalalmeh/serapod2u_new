'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/use-toast'
import {
  Calculator, RefreshCw, Loader2, Calendar, Download, FileText, Printer,
  CheckCircle2, AlertCircle,
} from 'lucide-react'
import ReportPrintLayout, { formatAmount, formatReportDate, type ReportCompany } from './ReportPrintLayout'

interface TrialBalanceViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

interface TBRow {
  account_id: string | null
  code: string
  name: string
  account_type: string
  debit: number
  credit: number
}

interface TBReport {
  company: ReportCompany
  asAtDate: string
  fiscalYearStart: string
  fiscalYearLabel: string | null
  rows: TBRow[]
  totals: { debit: number; credit: number }
  balanced: boolean
}

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']

/** 2024-09-30 → "SEPTEMBER 2024" */
function monthTitle(iso: string) {
  const [y, m] = iso.split('-').map(Number)
  return `${MONTHS[m - 1]} ${y}`
}

export default function TrialBalanceView({ userProfile: _userProfile }: TrialBalanceViewProps) {
  const [report, setReport] = useState<TBReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [asAtDate, setAsAtDate] = useState(new Date().toISOString().split('T')[0])
  const [accountTypeFilter, setAccountTypeFilter] = useState('all')

  const loadReport = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      if (asAtDate) params.append('as_at', asAtDate)
      if (accountTypeFilter !== 'all') params.append('accountType', accountTypeFilter)
      const res = await fetch(`/api/accounting/reports/trial-balance?${params}`)
      if (res.ok) {
        setReport(await res.json())
      } else {
        toast({ title: 'Error', description: 'Failed to load trial balance', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load trial balance', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [asAtDate, accountTypeFilter])

  useEffect(() => { loadReport() }, [loadReport])

  const rows = report?.rows || []
  const filtered = accountTypeFilter !== 'all'

  const handleExportCSV = () => {
    if (!report) return
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`
    const out: string[][] = [
      [q(report.company.name || '')],
      [q(`TRIAL BALANCE - FOR THE MONTH OF ${monthTitle(report.asAtDate)}`)],
      [],
      ['A/C NO.', 'DESCRIPTION', 'DEBIT (YTD)', 'CREDIT (YTD)'],
      ...rows.map((r) => [r.code, q(r.name), r.debit ? r.debit.toFixed(2) : '', r.credit ? r.credit.toFixed(2) : '']),
      ['', 'TOTAL', report.totals.debit.toFixed(2), report.totals.credit.toFixed(2)],
    ]
    const blob = new Blob([out.map((r) => r.join(',')).join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `trial-balance-${report.asAtDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const num = 'py-1 px-2 text-right font-mono tabular-nums whitespace-nowrap w-40'

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Calculator className="h-5 w-5 text-violet-600" />
                Trial Balance
              </CardTitle>
              <CardDescription className="flex items-center gap-2">
                Year-to-date balance of every account as at the selected date.
                {report && rows.length > 0 && !filtered && (report.balanced ? (
                  <span className="text-green-600 inline-flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Balanced</span>
                ) : (
                  <span className="text-red-600 inline-flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" /> Out of balance by {formatAmount(Math.abs(report.totals.debit - report.totals.credit))}
                  </span>
                ))}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">As at</span>
              <Input type="date" value={asAtDate} onChange={(e) => setAsAtDate(e.target.value)} className="h-8 w-36 text-sm" />
              <select
                value={accountTypeFilter}
                onChange={(e) => setAccountTypeFilter(e.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-sm"
                aria-label="Account type"
              >
                <option value="all">All types</option>
                <option value="ASSET">Asset</option>
                <option value="LIABILITY">Liability</option>
                <option value="EQUITY">Equity</option>
                <option value="INCOME">Income</option>
                <option value="EXPENSE">Expense</option>
              </select>
              <Button variant="outline" size="sm" onClick={() => window.print()} disabled={rows.length === 0}>
                <Printer className="h-4 w-4 mr-1.5" /> Print / PDF
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={rows.length === 0}>
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
        <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-violet-500" /></div>
      ) : !report || rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <FileText className="h-12 w-12 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground font-medium">No posted balances as at this date</p>
            <p className="text-sm text-muted-foreground mt-1">Post documents to GL to see the trial balance.</p>
          </CardContent>
        </Card>
      ) : (
        <ReportPrintLayout
          company={report.company}
          title={`Trial Balance - For the month of ${monthTitle(report.asAtDate)}`}
          subtitle={`As at ${formatReportDate(report.asAtDate)}`}
          note={`Income & expense accounts from ${formatReportDate(report.fiscalYearStart)}${report.fiscalYearLabel ? ` (${report.fiscalYearLabel})` : ''}`}
        >
          <div className={loading ? 'opacity-50 transition-opacity' : ''}>
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-xs">
                  <th />
                  <th />
                  <th colSpan={2} className="px-2 text-center font-semibold">YEAR-TO-DATE</th>
                </tr>
                <tr className="text-xs border-b border-zinc-400">
                  <th className="py-1 pr-2 text-left font-semibold w-28">A/C NO.</th>
                  <th className="py-1 text-left font-semibold">DESCRIPTION</th>
                  <th className="py-1 px-2 text-right font-semibold">DEBIT</th>
                  <th className="py-1 px-2 text-right font-semibold">CREDIT</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.account_id || `bf-${r.name}`}>
                    <td className="py-1 pr-2 font-mono text-xs">{r.code}</td>
                    <td className="py-1">{r.name}</td>
                    <td className={num}>{r.debit ? formatAmount(r.debit) : ''}</td>
                    <td className={num}>{r.credit ? formatAmount(r.credit) : ''}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td />
                  <td className="py-2 text-right pr-4">TOTAL :</td>
                  <td className={`${num} border-t border-zinc-400 border-b-4 border-double`}>{formatAmount(report.totals.debit)}</td>
                  <td className={`${num} border-t border-zinc-400 border-b-4 border-double`}>{formatAmount(report.totals.credit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </ReportPrintLayout>
      )}
    </div>
  )
}
