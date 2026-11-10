'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import {
  FileText, RefreshCw, Loader2, Search, Calendar, Filter,
  ChevronLeft, ChevronRight, CheckCircle2, Clock, Download, Wallet,
} from 'lucide-react'

interface APBillsViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

interface Bill {
  id: string
  document_no: string
  order_no: string
  status: string
  amount: number
  date: string
  supplier_name: string
  gl_posted: boolean
  journal_number: string | null
  paid: number
  outstanding: number
  advance_paid: number
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID'
}

const PAYMENT_BADGE: Record<Bill['payment_status'], { label: string; className: string }> = {
  PAID: { label: 'Paid', className: 'bg-green-100 text-green-700 border-green-200' },
  PARTIAL: { label: 'Partly paid', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  UNPAID: { label: 'Unpaid', className: 'bg-gray-50 text-gray-600 border-gray-200' },
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(n)
}

function formatDate(d: string) {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function APBillsView({ userProfile }: APBillsViewProps) {
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const limit = 25

  const loadBills = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      params.append('limit', limit.toString())
      params.append('offset', (page * limit).toString())
      if (search) params.append('search', search)
      if (dateFrom) params.append('from', dateFrom)
      if (dateTo) params.append('to', dateTo)

      const res = await fetch(`/api/accounting/ap/bills?${params}`)
      if (res.ok) {
        const data = await res.json()
        setBills(data.bills || [])
        setTotal(data.total || 0)
      } else {
        toast({ title: 'Error', description: 'Failed to load supplier bills', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load supplier bills', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [page, search, dateFrom, dateTo])

  useEffect(() => { loadBills() }, [loadBills])

  const totalAmount = bills.reduce((s, b) => s + (Number(b.amount) || 0), 0)
  const postedCount = bills.filter((b) => b.gl_posted).length
  const totalPaid = bills.reduce((s, b) => s + (Number(b.paid) || 0), 0)
  const totalOutstanding = bills.reduce((s, b) => s + (Number(b.outstanding) || 0), 0)
  const totalPages = Math.ceil(total / limit)

  const handleExportCSV = () => {
    const headers = ['Document #', 'Order #', 'Supplier', 'Date', 'Amount', 'Paid', 'Outstanding', 'Payment', 'Status', 'GL Posted', 'Journal']
    const rows = bills.map((b) => [
      b.document_no, b.order_no, `"${String(b.supplier_name).replace(/"/g, '""')}"`, formatDate(b.date),
      Number(b.amount).toFixed(2), Number(b.paid || 0).toFixed(2), Number(b.outstanding || 0).toFixed(2),
      PAYMENT_BADGE[b.payment_status]?.label || '', b.status, b.gl_posted ? 'Yes' : 'No', b.journal_number || '',
    ])
    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ap-bills-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <FileText className="h-4 w-4 text-orange-600" />
              <span className="text-xs font-medium text-muted-foreground">Total Bills</span>
            </div>
            <p className="text-2xl font-bold">{bills.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Wallet className="h-4 w-4 text-orange-600" />
              <span className="text-xs font-medium text-muted-foreground">Total Amount</span>
            </div>
            <p className="text-2xl font-bold text-orange-700 dark:text-orange-300">{formatCurrency(totalAmount)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-xs font-medium text-muted-foreground">Paid</span>
            </div>
            <p className="text-2xl font-bold text-green-700">{formatCurrency(totalPaid)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-orange-600" />
              <span className="text-xs font-medium text-muted-foreground">Outstanding (posted bills)</span>
            </div>
            <p className="text-2xl font-bold text-orange-700">{formatCurrency(totalOutstanding)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{postedCount} of {bills.length} posted to GL</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <FileText className="h-5 w-5 text-orange-600" />
                Supplier Bills
              </CardTitle>
              <CardDescription>
                Supplier invoices with the money actually paid. Posting creates Dr Inventory (1300), Cr Supplier Deposits for advances paid and Cr Accounts Payable for the rest.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={bills.length === 0}>
                <Download className="h-4 w-4 mr-1.5" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={loadBills} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3 mb-5 p-3 bg-muted/50 rounded-lg border">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <div className="flex-1 min-w-[160px]">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0) }}
                  placeholder="Search document #…"
                  className="h-8 text-sm pl-8"
                />
              </div>
            </div>
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0) }} className="h-8 w-32 text-sm" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0) }} className="h-8 w-32 text-sm" />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
            </div>
          ) : bills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <FileText className="h-12 w-12 text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground font-medium">No supplier bills found</p>
              <p className="text-sm text-muted-foreground mt-1">Supplier invoices appear here from ORD* purchase document flow.</p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border overflow-x-auto">
                <Table className="min-w-[960px]">
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead>Document #</TableHead>
                      <TableHead>Order #</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Amount (MYR)</TableHead>
                      <TableHead className="text-right">Paid</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <TableHead>Payment</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>GL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bills.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="font-mono text-sm font-medium">{b.document_no}</TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground">{b.order_no || '-'}</TableCell>
                        <TableCell className="text-sm max-w-[160px] truncate">{b.supplier_name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatDate(b.date)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(Number(b.amount))}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(Number(b.paid || 0))}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {b.gl_posted ? formatCurrency(Number(b.outstanding || 0)) : (
                            <span className="text-xs text-muted-foreground" title="Not in Accounts Payable until the bill is posted">
                              {b.advance_paid > 0 ? `advance ${formatCurrency(Number(b.advance_paid))}` : '—'}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs ${PAYMENT_BADGE[b.payment_status]?.className || ''}`}>
                            {PAYMENT_BADGE[b.payment_status]?.label || '-'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={b.status === 'completed' ? 'default' : 'secondary'} className="text-xs">{b.status}</Badge>
                        </TableCell>
                        <TableCell>
                          {b.gl_posted ? (
                            <Badge className="bg-green-100 text-green-700 border-green-200 text-xs">Posted</Badge>
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
                  <p className="text-sm text-muted-foreground">Showing {page * limit + 1}–{Math.min((page + 1) * limit, total)} of {total}</p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}><ChevronLeft className="h-4 w-4" /></Button>
                    <span className="text-sm">Page {page + 1} of {totalPages}</span>
                    <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}><ChevronRight className="h-4 w-4" /></Button>
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
