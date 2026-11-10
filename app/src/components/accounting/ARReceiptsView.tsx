'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import {
  CreditCard, RefreshCw, Loader2, Calendar, Filter, Search,
  ChevronLeft, ChevronRight, CheckCircle2, Undo2, FileText,
  Download, Wallet,
} from 'lucide-react'

interface ARReceiptsViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

interface ReceiptItem {
  id: string
  receipt_date: string
  document_no: string
  order_no: string
  customer_name: string
  amount: number
  stage: 'ADVANCE' | 'SETTLEMENT'
  bank_name: string
  reference: string | null
  journal_number: string | null
  status: 'POSTED' | 'REVERSED'
  reversal_journal_number: string | null
  reversal_date: string | null
  legacy: boolean
}

interface Summary {
  receipts: number
  total_received: number
  advances: number
  reversed: number
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(n)
}

function formatDate(d: string | null) {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' })
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export default function ARReceiptsView({ userProfile: _userProfile }: ARReceiptsViewProps) {
  const [receipts, setReceipts] = useState<ReceiptItem[]>([])
  const [summary, setSummary] = useState<Summary>({ receipts: 0, total_received: 0, advances: 0, reversed: 0 })
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')
  const limit = 25

  const loadReceipts = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      params.append('limit', limit.toString())
      params.append('offset', (page * limit).toString())
      if (dateFrom) params.append('from', dateFrom)
      if (dateTo) params.append('to', dateTo)
      if (status !== 'all') params.append('status', status)
      if (search.trim()) params.append('search', search.trim())

      const res = await fetch(`/api/accounting/ar/receipts?${params}`)
      if (res.ok) {
        const data = await res.json()
        setReceipts(data.receipts || [])
        setTotal(data.total || 0)
        if (data.summary) setSummary(data.summary)
      } else {
        const data = await res.json().catch(() => ({}))
        toast({ title: 'Error', description: data.error || 'Failed to load receipts', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load receipts', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [page, dateFrom, dateTo, status, search])

  useEffect(() => { loadReceipts() }, [loadReceipts])

  const totalPages = Math.ceil(total / limit)

  const handleExportCSV = () => {
    const headers = ['Receipt Date', 'Receipt #', 'Order #', 'Customer', 'Stage', 'Received Into', 'Reference', 'Journal', 'Amount', 'Status', 'Reversal Journal']
    const rows = receipts.map((r) => [
      r.receipt_date, r.document_no, r.order_no, r.customer_name,
      r.stage === 'ADVANCE' ? 'Advance' : 'Settlement', r.bank_name, r.reference || '',
      r.journal_number || '', Number(r.amount).toFixed(2), r.status, r.reversal_journal_number || '',
    ])
    const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `customer-receipts-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <CreditCard className="h-4 w-4 text-green-600" />
              <span className="text-xs font-medium text-muted-foreground">Receipts posted</span>
            </div>
            <p className="text-2xl font-bold">{summary.receipts}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <span className="text-xs font-medium text-muted-foreground">Total received</span>
            </div>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{formatCurrency(summary.total_received)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Wallet className="h-4 w-4 text-blue-600" />
              <span className="text-xs font-medium text-muted-foreground">Received before the invoice</span>
            </div>
            <p className="text-2xl font-bold text-blue-700">{formatCurrency(summary.advances)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Undo2 className="h-4 w-4 text-orange-600" />
              <span className="text-xs font-medium text-muted-foreground">Reversed</span>
            </div>
            <p className="text-2xl font-bold text-orange-700">{summary.reversed}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <CreditCard className="h-5 w-5 text-green-600" />
                Customer Receipts
              </CardTitle>
              <CardDescription>
                Money actually received from distributors, one line per receipt posted in Pending Postings.
                Before the sales invoice is posted a receipt goes to Customer Deposits (advance); after it, to Accounts Receivable.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={receipts.length === 0}>
                <Download className="h-4 w-4 mr-1.5" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={loadReceipts} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3 mb-5 p-3 bg-muted/50 rounded-lg border">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <div className="relative flex-1 min-w-[180px]">
              <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0) }}
                placeholder="Receipt, order, customer, reference, journal…"
                className="h-8 pl-8 text-sm"
              />
            </div>
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0) }}>
              <SelectTrigger className="h-8 w-36 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="POSTED">Posted</SelectItem>
                <SelectItem value="REVERSED">Reversed</SelectItem>
              </SelectContent>
            </Select>
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0) }} className="h-8 w-36 text-sm" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0) }} className="h-8 w-36 text-sm" />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-green-500" />
            </div>
          ) : receipts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <FileText className="h-12 w-12 text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground font-medium">No receipts found</p>
              <p className="text-xs text-muted-foreground mt-1">Receipts appear here once they are posted from Pending Postings.</p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead>Date</TableHead>
                      <TableHead>Receipt #</TableHead>
                      <TableHead>Order #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Received Into</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead>Journal</TableHead>
                      <TableHead className="text-right">Amount (MYR)</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {receipts.map((r) => (
                      <TableRow key={r.id} className={r.status === 'REVERSED' ? 'opacity-60' : ''}>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{formatDate(r.receipt_date)}</TableCell>
                        <TableCell className="font-mono text-sm font-medium">{r.document_no}</TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground">{r.order_no}</TableCell>
                        <TableCell className="text-sm max-w-[160px] truncate">{r.customer_name}</TableCell>
                        <TableCell>
                          {r.stage === 'ADVANCE' ? (
                            <Badge variant="outline" className="text-blue-700 border-blue-200 text-xs">Advance</Badge>
                          ) : (
                            <Badge variant="outline" className="text-emerald-700 border-emerald-200 text-xs">Settlement</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-sm max-w-[160px] truncate">{r.bank_name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-[140px] truncate">{r.reference || '-'}</TableCell>
                        <TableCell className="font-mono text-xs">{r.journal_number || '-'}</TableCell>
                        <TableCell className={`text-right font-mono text-sm ${r.status === 'REVERSED' ? 'line-through' : ''}`}>
                          {formatCurrency(Number(r.amount))}
                        </TableCell>
                        <TableCell>
                          {r.status === 'POSTED' ? (
                            <Badge className="bg-green-100 text-green-700 border-green-200 text-xs">Posted</Badge>
                          ) : (
                            <div className="flex flex-col">
                              <Badge variant="outline" className="text-orange-600 border-orange-200 text-xs w-fit">Reversed</Badge>
                              {r.reversal_journal_number && (
                                <span className="text-[11px] text-muted-foreground font-mono mt-0.5">{r.reversal_journal_number}</span>
                              )}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-muted-foreground">
                  Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
                </p>
                {totalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm">Page {page + 1} of {totalPages}</span>
                    <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
