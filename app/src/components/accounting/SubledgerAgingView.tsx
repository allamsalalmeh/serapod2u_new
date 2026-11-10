'use client'

import { Fragment, useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import { BarChart3, RefreshCw, Loader2, Calendar, Download, ChevronDown, ChevronRight, Wallet } from 'lucide-react'
import { AGING_BUCKETS, AGING_BUCKET_LABELS, type AgingBucket } from '@/modules/finance/subledger'

interface InvoiceLine {
  documentId: string
  documentNo: string
  orderNo: string
  invoiceDate: string | null
  days: number | null
  bucket: AgingBucket | null
  total: number
  settled: number
  outstanding: number
  advance: number
  posted: boolean
}

interface AgingRow extends Record<AgingBucket, number> {
  partyId: string
  partyName: string
  total: number
  advances: number
  net: number
  openInvoices: number
  invoices: InvoiceLine[]
}

type Totals = Omit<AgingRow, 'partyId' | 'partyName' | 'invoices'>

export interface SubledgerAgingViewProps {
  side: 'AR' | 'AP'
}

const COPY = {
  AR: {
    title: 'Accounts Receivable Aging',
    party: 'Customer',
    endpoint: '/api/accounting/ar/aging',
    settled: 'Received',
    advances: 'Advances received',
    description:
      'What each distributor still owes, by days since the sales invoice was posted, after the money actually received. Advances are money received on invoices not posted yet (Customer Deposits).',
    file: 'ar-aging',
  },
  AP: {
    title: 'Accounts Payable Aging',
    party: 'Supplier',
    endpoint: '/api/accounting/ap/aging',
    settled: 'Paid',
    advances: 'Advances paid',
    description:
      'What is still owed to each supplier, by days since the supplier invoice was posted, after the money actually paid. Advances are money paid on invoices not posted yet (Supplier Deposits).',
    file: 'ap-aging',
  },
} as const

const BUCKET_COLOR: Record<AgingBucket, string> = {
  current: 'text-green-700',
  d31_60: 'text-yellow-700',
  d61_90: 'text-orange-700',
  d91_120: 'text-red-600',
  over_120: 'text-red-800',
}

const EMPTY_TOTALS: Totals = { current: 0, d31_60: 0, d61_90: 0, d91_120: 0, over_120: 0, total: 0, advances: 0, net: 0, openInvoices: 0 }

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(n || 0)
}

function formatDate(d: string | null) {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' })
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function SubledgerAgingView({ side }: SubledgerAgingViewProps) {
  const copy = COPY[side]
  const [rows, setRows] = useState<AgingRow[]>([])
  const [totals, setTotals] = useState<Totals>(EMPTY_TOTALS)
  const [loading, setLoading] = useState(true)
  const [asAtDate, setAsAtDate] = useState(new Date().toISOString().split('T')[0])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const loadAging = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(`${copy.endpoint}?asAt=${asAtDate}`)
      if (res.ok) {
        const data = await res.json()
        setRows(data.aging || [])
        setTotals(data.totals || EMPTY_TOTALS)
      } else {
        const data = await res.json().catch(() => ({}))
        toast({ title: 'Error', description: data.error || `Failed to load ${copy.title}`, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: `Failed to load ${copy.title}`, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [asAtDate, copy.endpoint, copy.title])

  useEffect(() => { loadAging() }, [loadAging])

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const handleExportCSV = () => {
    const headers = [copy.party, 'Open invoices', ...AGING_BUCKETS.map((b) => AGING_BUCKET_LABELS[b]), 'Total open', copy.advances, 'Net']
    const out = rows.map((r) => [
      r.partyName, r.openInvoices, ...AGING_BUCKETS.map((b) => r[b].toFixed(2)),
      r.total.toFixed(2), r.advances.toFixed(2), r.net.toFixed(2),
    ])
    out.push(['TOTAL', totals.openInvoices, ...AGING_BUCKETS.map((b) => totals[b].toFixed(2)),
      totals.total.toFixed(2), totals.advances.toFixed(2), totals.net.toFixed(2)])
    const csv = [headers, ...out].map((r) => r.map(csvCell).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${copy.file}-${asAtDate}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {AGING_BUCKETS.map((b) => (
          <Card key={b}>
            <CardContent className="p-4">
              <span className="text-xs font-medium text-muted-foreground">{AGING_BUCKET_LABELS[b]}</span>
              <p className={`text-xl font-bold ${BUCKET_COLOR[b]} mt-1`}>{formatCurrency(totals[b])}</p>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardContent className="p-4">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <Wallet className="h-3.5 w-3.5" /> {copy.advances}
            </span>
            <p className="text-xl font-bold text-blue-700 mt-1">{formatCurrency(totals.advances)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <BarChart3 className="h-5 w-5 text-sky-600" />
                {copy.title}
              </CardTitle>
              <CardDescription className="max-w-3xl">
                {copy.description} Open total {formatCurrency(totals.total)} across {rows.length} {copy.party.toLowerCase()}s.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">As at</span>
                <Input type="date" value={asAtDate} onChange={(e) => e.target.value && setAsAtDate(e.target.value)} className="h-8 w-36 text-sm" />
              </div>
              <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={rows.length === 0}>
                <Download className="h-4 w-4 mr-1.5" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={loadAging} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-sky-500" />
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <BarChart3 className="h-12 w-12 text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground font-medium">Nothing open as at {formatDate(asAtDate)}</p>
              <p className="text-xs text-muted-foreground mt-1">Only invoices posted to the GL are aged.</p>
            </div>
          ) : (
            <div className="rounded-lg border overflow-x-auto">
              <Table className="min-w-[980px]">
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead className="w-8" />
                    <TableHead>{copy.party}</TableHead>
                    <TableHead className="text-right">Invoices</TableHead>
                    {AGING_BUCKETS.map((b) => (
                      <TableHead key={b} className="text-right">{AGING_BUCKET_LABELS[b]}</TableHead>
                    ))}
                    <TableHead className="text-right">Total open</TableHead>
                    <TableHead className="text-right">{copy.advances}</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const open = expanded.has(r.partyId)
                    return (
                      <Fragment key={r.partyId}>
                        <TableRow className="cursor-pointer hover:bg-muted/40" onClick={() => toggle(r.partyId)}>
                          <TableCell className="py-2">
                            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </TableCell>
                          <TableCell className="text-sm font-medium max-w-[200px] truncate">{r.partyName}</TableCell>
                          <TableCell className="text-right text-sm">{r.openInvoices}</TableCell>
                          {AGING_BUCKETS.map((b) => (
                            <TableCell key={b} className={`text-right font-mono text-sm ${r[b] > 0 ? BUCKET_COLOR[b] : 'text-muted-foreground'}`}>
                              {r[b] > 0 ? formatCurrency(r[b]) : '-'}
                            </TableCell>
                          ))}
                          <TableCell className="text-right font-mono text-sm font-semibold">{formatCurrency(r.total)}</TableCell>
                          <TableCell className="text-right font-mono text-sm text-blue-700">{r.advances > 0 ? formatCurrency(r.advances) : '-'}</TableCell>
                          <TableCell className="text-right font-mono text-sm font-semibold">{formatCurrency(r.net)}</TableCell>
                        </TableRow>
                        {open && (
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell />
                            <TableCell colSpan={AGING_BUCKETS.length + 5} className="py-2">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead className="h-8 text-xs">Invoice #</TableHead>
                                    <TableHead className="h-8 text-xs">Order #</TableHead>
                                    <TableHead className="h-8 text-xs">Posted</TableHead>
                                    <TableHead className="h-8 text-xs text-right">Days</TableHead>
                                    <TableHead className="h-8 text-xs text-right">Invoice</TableHead>
                                    <TableHead className="h-8 text-xs text-right">{copy.settled}</TableHead>
                                    <TableHead className="h-8 text-xs text-right">Open</TableHead>
                                    <TableHead className="h-8 text-xs text-right">Advance</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {r.invoices.map((i) => (
                                    <TableRow key={i.documentId}>
                                      <TableCell className="py-1.5 font-mono text-xs">{i.documentNo}</TableCell>
                                      <TableCell className="py-1.5 font-mono text-xs text-muted-foreground">{i.orderNo}</TableCell>
                                      <TableCell className="py-1.5 text-xs">
                                        {i.posted ? formatDate(i.invoiceDate) : (
                                          <Badge variant="outline" className="text-[10px] text-orange-600 border-orange-200">Not posted</Badge>
                                        )}
                                      </TableCell>
                                      <TableCell className="py-1.5 text-xs text-right">{i.days ?? '-'}</TableCell>
                                      <TableCell className="py-1.5 font-mono text-xs text-right">{formatCurrency(i.total)}</TableCell>
                                      <TableCell className="py-1.5 font-mono text-xs text-right">{formatCurrency(i.settled)}</TableCell>
                                      <TableCell className="py-1.5 font-mono text-xs text-right">{i.outstanding > 0 ? formatCurrency(i.outstanding) : '-'}</TableCell>
                                      <TableCell className="py-1.5 font-mono text-xs text-right text-blue-700">{i.advance > 0 ? formatCurrency(i.advance) : '-'}</TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                  <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                    <TableCell />
                    <TableCell className="text-sm">Total</TableCell>
                    <TableCell className="text-right text-sm">{totals.openInvoices}</TableCell>
                    {AGING_BUCKETS.map((b) => (
                      <TableCell key={b} className="text-right font-mono text-sm">{formatCurrency(totals[b])}</TableCell>
                    ))}
                    <TableCell className="text-right font-mono text-sm">{formatCurrency(totals.total)}</TableCell>
                    <TableCell className="text-right font-mono text-sm text-blue-700">{formatCurrency(totals.advances)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatCurrency(totals.net)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
