'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import {
  Receipt, RefreshCw, Loader2, Search, Calendar, Filter,
  ChevronLeft, ChevronRight, CheckCircle2, Clock, FileText,
  TrendingUp, Download,
} from 'lucide-react'

interface ARInvoicesViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

interface Invoice {
  id: string
  doc_type: string
  document_no: string
  order_no: string
  order_id: string
  status: string
  amount: number
  date: string
  customer_name: string
  gl_posted: boolean
  gl_posting: any
  journal_number: string | null
  received: number
  outstanding: number
  advance_held: number
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID'
}

const PAYMENT_BADGE: Record<Invoice['payment_status'], { label: string; className: string }> = {
  PAID: { label: 'Paid', className: 'bg-green-100 text-green-700 border-green-200' },
  PARTIAL: { label: 'Partly paid', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  UNPAID: { label: 'Unpaid', className: 'bg-gray-50 text-gray-600 border-gray-200' },
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(amount)
}

function formatDate(d: string) {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function ARInvoicesView({ userProfile }: ARInvoicesViewProps) {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const limit = 25

  const loadInvoices = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      params.append('limit', limit.toString())
      params.append('offset', (page * limit).toString())
      if (search) params.append('search', search)
      if (dateFrom) params.append('from', dateFrom)
      if (dateTo) params.append('to', dateTo)

      const res = await fetch(`/api/accounting/ar/invoices?${params}`)
      if (res.ok) {
        const data = await res.json()
        setInvoices(data.invoices || [])
        setTotal(data.total || 0)
      } else {
        toast({ title: 'Error', description: 'Failed to load invoices', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load invoices', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [page, search, dateFrom, dateTo])

  useEffect(() => { loadInvoices() }, [loadInvoices])

  const totalAmount = invoices.reduce((s, i) => s + (Number(i.amount) || 0), 0)
  const postedCount = invoices.filter((i) => i.gl_posted).length
  const totalReceived = invoices.reduce((s, i) => s + (Number(i.received) || 0), 0)
  const totalOutstanding = invoices.reduce((s, i) => s + (Number(i.outstanding) || 0), 0)
  const totalPages = Math.ceil(total / limit)

  const handleExportCSV = () => {
    const headers = ['Document #', 'Order #', 'Customer', 'Date', 'Amount', 'Received', 'Outstanding', 'Payment', 'Status', 'GL Posted', 'Journal']
    const rows = invoices.map((i) => [
      i.document_no, i.order_no, `"${String(i.customer_name).replace(/"/g, '""')}"`, formatDate(i.date),
      Number(i.amount).toFixed(2), Number(i.received || 0).toFixed(2), Number(i.outstanding || 0).toFixed(2),
      PAYMENT_BADGE[i.payment_status]?.label || '', i.status, i.gl_posted ? 'Yes' : 'No', i.journal_number || '',
    ])
    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ar-invoices-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Receipt className="h-4 w-4 text-blue-600" />
              <span className="text-xs font-medium text-muted-foreground">Total Invoices</span>
            </div>
            <p className="text-2xl font-bold">{invoices.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-emerald-600" />
              <span className="text-xs font-medium text-muted-foreground">Total Amount</span>
            </div>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{formatCurrency(totalAmount)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-xs font-medium text-muted-foreground">Received</span>
            </div>
            <p className="text-2xl font-bold text-green-700">{formatCurrency(totalReceived)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-orange-600" />
              <span className="text-xs font-medium text-muted-foreground">Outstanding (posted invoices)</span>
            </div>
            <p className="text-2xl font-bold text-orange-700">{formatCurrency(totalOutstanding)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{postedCount} of {invoices.length} posted to GL</p>
          </CardContent>
        </Card>
      </div>

      {/* Main Table */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Receipt className="h-5 w-5 text-blue-600" />
                Customer Invoices
              </CardTitle>
              <CardDescription>
                Sales invoices to distributors (D2H) with the money actually received. An invoice counts in
                Accounts Receivable once it is posted; money received before that is held as an advance.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={invoices.length === 0} className="flex-1 sm:flex-none">
                <Download className="h-4 w-4 mr-1.5" />
                CSV
              </Button>
              <Button variant="outline" size="sm" onClick={loadInvoices} disabled={loading} className="flex-1 sm:flex-none">
                <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="mb-5 flex flex-col gap-3 rounded-lg border bg-muted/50 p-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="flex items-center gap-2 min-w-0 w-full sm:flex-1 sm:min-w-[160px]">
              <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0) }}
                  placeholder="Search document #…"
                  className="h-8 text-sm pl-8"
                />
              </div>
            </div>
            <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
              <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0) }} className="h-8 min-w-0 flex-1 text-sm sm:w-32 sm:flex-none" />
              <span className="text-xs text-muted-foreground">to</span>
              <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0) }} className="h-8 min-w-0 flex-1 text-sm sm:w-32 sm:flex-none" />
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            </div>
          ) : invoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <FileText className="h-12 w-12 text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground font-medium">No invoices found</p>
              <p className="text-sm text-muted-foreground mt-1">Sales invoices will appear here when D2H orders generate S* documents.</p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border overflow-x-auto">
                <Table className="min-w-[960px]">
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead>Document #</TableHead>
                      <TableHead>Order #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Amount (MYR)</TableHead>
                      <TableHead className="text-right">Received</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead>Payment</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>GL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="font-mono text-sm font-medium">{inv.document_no}</TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground">{inv.order_no || '-'}</TableCell>
                        <TableCell className="text-sm max-w-[160px] truncate">{inv.customer_name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatDate(inv.date)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(Number(inv.amount))}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(Number(inv.received || 0))}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {inv.gl_posted ? formatCurrency(Number(inv.outstanding || 0)) : (
                            <span className="text-xs text-muted-foreground" title="Not in Accounts Receivable until the invoice is posted">
                              {inv.advance_held > 0 ? `advance ${formatCurrency(Number(inv.advance_held))}` : '—'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs ${PAYMENT_BADGE[inv.payment_status]?.className || ''}`}>
                            {PAYMENT_BADGE[inv.payment_status]?.label || '-'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={inv.status === 'completed' ? 'default' : 'secondary'} className="text-xs">
                            {inv.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {inv.gl_posted ? (
                            <Badge className="bg-green-100 text-green-700 border-green-200 text-xs" title={inv.journal_number || undefined}>Posted</Badge>
                          ) : (
                            <Badge variant="outline" className="text-orange-600 border-orange-200 text-xs">Pending</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm">Page {page + 1} of {totalPages}</span>
                    <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
