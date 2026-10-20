'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/use-toast'
import { BookOpen, RefreshCw, Loader2, Calendar, Download, FileText, Printer } from 'lucide-react'
import ReportPrintLayout, { formatAmount, formatReportDate, type ReportCompany } from './ReportPrintLayout'

interface GLDetailViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

interface AccountOption { id: string; code: string; name: string; account_type: string }

interface GLLine { date: string; ref: string; description: string; memo: string | null; debit: number; credit: number; balance: number }
interface GLBlock {
  id: string; code: string; name: string; account_type: string
  openingBalance: number; lines: GLLine[]
  totalDebit: number; totalCredit: number; closingBalance: number
}
interface GLReport {
  company: ReportCompany
  fromDate: string
  toDate: string
  fiscalYearLabel: string | null
  accounts: GLBlock[]
  accountsList: AccountOption[]
  lineCount: number
}

export default function GLDetailView({ userProfile: _userProfile }: GLDetailViewProps) {
  const [report, setReport] = useState<GLReport | null>(null)
  const [accountsList, setAccountsList] = useState<AccountOption[]>([])
  const [loading, setLoading] = useState(true)
  const [accountId, setAccountId] = useState('') // '' = all accounts
  // `from` starts empty: the API uses the start of the fiscal year containing `to`.
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState(new Date().toISOString().split('T')[0])
  const skipNextLoad = useRef(false)

  const loadReport = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      if (accountId) params.append('account_id', accountId)
      if (dateFrom) params.append('from', dateFrom)
      if (dateTo) params.append('to', dateTo)
      const res = await fetch(`/api/accounting/reports/gl-detail?${params}`)
      if (res.ok) {
        const data: GLReport = await res.json()
        setReport(data)
        setAccountsList(data.accountsList || [])
        if (!dateFrom && data.fromDate) {
          skipNextLoad.current = true
          setDateFrom(data.fromDate)
        }
      } else {
        toast({ title: 'Error', description: 'Failed to load general ledger', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load general ledger', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [accountId, dateFrom, dateTo])

  useEffect(() => {
    if (skipNextLoad.current) { skipNextLoad.current = false; return }
    loadReport()
  }, [loadReport])

  const blocks = report?.accounts || []

  const handleExportCSV = () => {
    if (!report) return
    const q = (s: string) => `"${(s || '').replace(/"/g, '""')}"`
    const out: string[][] = [
      [q(report.company.name || '')],
      [q('GENERAL LEDGER')],
      [q(`FROM ${formatReportDate(report.fromDate)} TO ${formatReportDate(report.toDate)}`)],
      [],
      ['ACCOUNT NO.', 'ACCOUNT', 'DATE', 'REF.', 'DESCRIPTION', 'DEBIT', 'CREDIT', 'BALANCE'],
    ]
    for (const b of blocks) {
      out.push([b.code, q(b.name), '', '', 'BALANCE B/F', '', '', b.openingBalance.toFixed(2)])
      for (const l of b.lines) {
        out.push([b.code, q(b.name), l.date, q(l.ref), q([l.description, l.memo].filter(Boolean).join(' / ')),
          l.debit ? l.debit.toFixed(2) : '', l.credit ? l.credit.toFixed(2) : '', l.balance.toFixed(2)])
      }
      out.push([b.code, q(b.name), '', '', 'TOTAL', b.totalDebit.toFixed(2), b.totalCredit.toFixed(2), b.closingBalance.toFixed(2)])
    }
    const blob = new Blob([out.map((r) => r.join(',')).join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `general-ledger-${report.fromDate}-to-${report.toDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const num = 'py-1 px-2 text-right font-mono tabular-nums whitespace-nowrap w-32'

  return (
    <div className="space-y-6">
      {/* Controls */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <BookOpen className="h-5 w-5 text-emerald-600" />
                General Ledger
              </CardTitle>
              <CardDescription>
                Transactions per account with balance brought forward and running balance.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="h-8 max-w-64 rounded-md border bg-background px-2 text-sm"
                aria-label="Account"
              >
                <option value="">All accounts</option>
                {accountsList.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                ))}
              </select>
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8 w-36 text-sm" />
              <span className="text-xs text-muted-foreground">to</span>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8 w-36 text-sm" />
              <Button variant="outline" size="sm" onClick={() => window.print()} disabled={blocks.length === 0}>
                <Printer className="h-4 w-4 mr-1.5" /> Print / PDF
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={blocks.length === 0}>
                <Download className="h-4 w-4 mr-1.5" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={loadReport} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Ledger */}
      {loading && !report ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-emerald-500" /></div>
      ) : !report || blocks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <FileText className="h-12 w-12 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground font-medium">No transactions or balances for the selected account and period</p>
          </CardContent>
        </Card>
      ) : (
        <ReportPrintLayout
          company={report.company}
          title="General Ledger"
          subtitle={`From ${formatReportDate(report.fromDate)} to ${formatReportDate(report.toDate)}`}
          note={`${blocks.length} account${blocks.length === 1 ? '' : 's'} · ${report.lineCount} transaction${report.lineCount === 1 ? '' : 's'}`}
        >
          <div className={`space-y-8 ${loading ? 'opacity-50 transition-opacity' : ''}`}>
            {blocks.map((b) => (
              <section key={b.id} style={{ breakInside: 'avoid-page' }}>
                <p className="mb-2 font-semibold">
                  ACCOUNT NO. : <span className="font-mono mr-6">{b.code}</span>{b.name.toUpperCase()}
                </p>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="text-xs border-b border-zinc-400">
                      <th className="py-1 pr-2 text-left font-semibold w-24">DATE</th>
                      <th className="py-1 pr-2 text-left font-semibold w-36">REF.</th>
                      <th className="py-1 text-left font-semibold">DESCRIPTION</th>
                      <th className="py-1 px-2 text-right font-semibold">DEBIT</th>
                      <th className="py-1 px-2 text-right font-semibold">CREDIT</th>
                      <th className="py-1 px-2 text-right font-semibold">BALANCE</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td /><td />
                      <td className="py-1">BALANCE B/F</td>
                      <td /><td />
                      <td className={num}>{formatAmount(b.openingBalance)}</td>
                    </tr>
                    {b.lines.map((l, i) => (
                      <tr key={`${b.id}-${i}`} className="align-top">
                        <td className="py-1 pr-2 whitespace-nowrap">{formatReportDate(l.date)}</td>
                        <td className="py-1 pr-2 font-mono text-xs">{l.ref}</td>
                        <td className="py-1">
                          {l.description}
                          {l.memo && <div className="text-xs text-zinc-500">{l.memo}</div>}
                        </td>
                        <td className={num}>{l.debit ? formatAmount(l.debit) : ''}</td>
                        <td className={num}>{l.credit ? formatAmount(l.credit) : ''}</td>
                        <td className={num}>{formatAmount(l.balance)}</td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td /><td /><td />
                      <td className={`${num} border-t border-zinc-400`}>{formatAmount(b.totalDebit)}</td>
                      <td className={`${num} border-t border-zinc-400`}>{formatAmount(b.totalCredit)}</td>
                      <td className={`${num} border-t border-zinc-400`}>{formatAmount(b.closingBalance)}</td>
                    </tr>
                  </tbody>
                </table>
              </section>
            ))}
          </div>
        </ReportPrintLayout>
      )}
    </div>
  )
}
