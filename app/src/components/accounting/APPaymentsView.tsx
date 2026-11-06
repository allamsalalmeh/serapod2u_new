'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { useSaCapability } from '@/hooks/useSaCapability'
import {
  Wallet, RefreshCw, Loader2, Calendar, Filter,
  ChevronLeft, ChevronRight, CheckCircle2, Clock, Download, FileText, RotateCcw,
} from 'lucide-react'

interface APPaymentsViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

interface Payment {
  id: string
  document_no: string
  order_no: string
  status: string
  amount: number
  date: string
  payment_type: 'deposit' | 'balance'
  supplier_name: string
  gl_posted: boolean
  paid_amount: number
  closed: boolean
  closure_kind: string | null
  closure_reason: string | null
  can_reopen: boolean
}

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(n)
}

function statusLabel(p: Payment) {
  if (p.closed) return 'Closed'
  return Number(p.paid_amount) > 0 ? 'Partly paid' : 'Open'
}

function formatDate(d: string) {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function APPaymentsView({ userProfile }: APPaymentsViewProps) {
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [typeFilter, setTypeFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const limit = 25
  const canReopen = useSaCapability('finance.payment.approve', userProfile.roles.role_level <= 20)
  const [reopenTarget, setReopenTarget] = useState<Payment | null>(null)
  const [reopenReason, setReopenReason] = useState('')
  const [reopening, setReopening] = useState(false)

  const loadPayments = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      params.append('limit', limit.toString())
      params.append('offset', (page * limit).toString())
      if (typeFilter !== 'all') params.append('type', typeFilter)
      if (dateFrom) params.append('from', dateFrom)
      if (dateTo) params.append('to', dateTo)

      const res = await fetch(`/api/accounting/ap/payments?${params}`)
      if (res.ok) {
        const data = await res.json()
        setPayments(data.payments || [])
        setTotal(data.total || 0)
      } else {
        toast({ title: 'Error', description: 'Failed to load payments', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load payments', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [page, typeFilter, dateFrom, dateTo])

  useEffect(() => { loadPayments() }, [loadPayments])

  const totalAmount = payments.reduce((s, p) => s + (Number(p.paid_amount) || 0), 0)

  const handleReopen = async () => {
    if (!reopenTarget || !reopenReason.trim()) return
    try {
      setReopening(true)
      const res = await fetch(`/api/accounting/payment-documents/${reopenTarget.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reopen', reason: reopenReason }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        toast({ title: 'Reopened', description: `${reopenTarget.document_no} is back in Pending Postings.` })
        setReopenTarget(null)
        setReopenReason('')
        loadPayments()
      } else {
        toast({ title: 'Cannot reopen', description: data.error || 'Reopen failed', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Reopen failed', variant: 'destructive' })
    } finally {
      setReopening(false)
    }
  }
  const depositTotal = payments.filter((p) => p.payment_type === 'deposit').reduce((s, p) => s + (Number(p.amount) || 0), 0)
  const balanceTotal = payments.filter((p) => p.payment_type === 'balance').reduce((s, p) => s + (Number(p.amount) || 0), 0)
  const totalPages = Math.ceil(total / limit)

  const handleExportCSV = () => {
    const headers = ['Document #', 'Order #', 'Supplier', 'Type', 'Date', 'Requested', 'Paid', 'Status']
    const rows = payments.map((p) => [
      p.document_no, p.order_no, p.supplier_name, p.payment_type,
      formatDate(p.date), Number(p.amount).toFixed(2), Number(p.paid_amount || 0).toFixed(2), statusLabel(p),
    ])
    const csv = [headers, ...rows].map((r) => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ap-payments-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Wallet className="h-4 w-4 text-purple-600" />
              <span className="text-xs font-medium text-muted-foreground">Total Payments</span>
            </div>
            <p className="text-2xl font-bold">{payments.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Wallet className="h-4 w-4 text-purple-600" />
              <span className="text-xs font-medium text-muted-foreground">Deposits (30%)</span>
            </div>
            <p className="text-xl font-bold text-purple-700 dark:text-purple-300">{formatCurrency(depositTotal)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Wallet className="h-4 w-4 text-orange-600" />
              <span className="text-xs font-medium text-muted-foreground">Balance (70%)</span>
            </div>
            <p className="text-xl font-bold text-orange-700 dark:text-orange-300">{formatCurrency(balanceTotal)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Wallet className="h-4 w-4 text-emerald-600" />
              <span className="text-xs font-medium text-muted-foreground">Total Paid</span>
            </div>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{formatCurrency(totalAmount)}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Wallet className="h-5 w-5 text-purple-600" />
                Payment Vouchers
              </CardTitle>
              <CardDescription>
                Supplier deposit (30%) and balance (70%) payments from ORD* purchase flow.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handleExportCSV} disabled={payments.length === 0}>
                <Download className="h-4 w-4 mr-1.5" /> CSV
              </Button>
              <Button variant="outline" size="sm" onClick={loadPayments} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3 mb-5 p-3 bg-muted/50 rounded-lg border">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <div className="w-36">
              <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(0) }}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="deposit">Deposit (30%)</SelectItem>
                  <SelectItem value="balance">Balance (70%)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0) }} className="h-8 w-32 text-sm" />
            <span className="text-xs text-muted-foreground">to</span>
            <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0) }} className="h-8 w-32 text-sm" />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
            </div>
          ) : payments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <FileText className="h-12 w-12 text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground font-medium">No payments found</p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead>Document #</TableHead>
                      <TableHead>Order #</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Requested (MYR)</TableHead>
                      <TableHead className="text-right">Paid (MYR)</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-24"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono text-sm font-medium">{p.document_no}</TableCell>
                        <TableCell className="font-mono text-sm text-muted-foreground">{p.order_no || '-'}</TableCell>
                        <TableCell className="text-sm max-w-[160px] truncate">{p.supplier_name}</TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={p.payment_type === 'deposit'
                              ? 'bg-purple-50 text-purple-700 border-purple-200 text-xs'
                              : 'bg-orange-50 text-orange-700 border-orange-200 text-xs'
                            }
                          >
                            {p.payment_type === 'deposit' ? 'Deposit (30%)' : 'Balance (70%)'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{formatDate(p.date)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(Number(p.amount))}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(Number(p.paid_amount || 0))}</TableCell>
                        <TableCell>
                          {p.closed ? (
                            <Badge className="bg-green-100 text-green-700 border-green-200 text-xs" title={p.closure_reason || undefined}>Closed</Badge>
                          ) : Number(p.paid_amount) > 0 ? (
                            <Badge variant="outline" className="text-blue-600 border-blue-200 text-xs">Partly paid</Badge>
                          ) : (
                            <Badge variant="outline" className="text-orange-600 border-orange-200 text-xs">Open</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {p.can_reopen && canReopen && (
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setReopenTarget(p); setReopenReason('') }}>
                              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reopen
                            </Button>
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

      <Dialog open={!!reopenTarget} onOpenChange={(open) => { if (!open) setReopenTarget(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reopen {reopenTarget?.document_no}</DialogTitle>
            <DialogDescription>
              The document returns to Pending Postings so another payment can be posted on it. Posted journals are not changed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reopen-reason" className="text-sm">Reason</Label>
            <Input
              id="reopen-reason"
              value={reopenReason}
              maxLength={300}
              placeholder="For example: marked as last payment by mistake"
              onChange={(e) => setReopenReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenTarget(null)}>Cancel</Button>
            <Button onClick={handleReopen} disabled={reopening || !reopenReason.trim()}>
              {reopening ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
              Reopen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
