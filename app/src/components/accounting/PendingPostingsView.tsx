'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { toast } from '@/components/ui/use-toast'
import {
  Clock,
  RefreshCw,
  CheckCircle2,
  Loader2,
  Calendar,
  Filter,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  ArrowUpDown,
  Search,
  FileText,
  Receipt,
  Wallet,
  Zap,
  CreditCard,
  BarChart3,
  ArrowUpFromLine,
  ArrowDownToLine,
  Eye,
} from 'lucide-react'
import { POSTING_TYPE_COLORS, getPostingType } from '@/modules/finance/postingMap'
import { orderDocumentsCompletion, type OrderCompletion } from '@/lib/orders/order-completion'
import { useSaCapability } from '@/hooks/useSaCapability'
import { createClient } from '@/lib/supabase/client'
import { FileText as FileTextIcon } from 'lucide-react'
import OrderDocumentsDialogEnhanced from '@/components/dashboard/views/orders/OrderDocumentsDialogEnhanced'
import { defaultPostingDate, financeToday, isValidPostingDate } from '@/modules/finance/postingDate'
import { MAX_REFERENCE_LENGTH, toAmount } from '@/modules/finance/supplierPayment'

// ── Types ────────────────────────────────────────────────────────

interface PendingPostingsViewProps {
  userProfile: {
    id: string
    organizations: { id: string; org_type_code: string }
    roles: { role_level: number }
  }
}

interface PendingPosting {
  document_id: string
  document_type: string
  document_no: string
  display_doc_no: string | null
  order_id: string
  document_status: string
  order_no: string
  order_display_doc_no: string | null
  document_date: string
  company_id: string
  gl_doc_type: string
  posting_label: string
  amount: number
  supplier_name: string
  buyer_name: string
  paid_amount?: number
}

interface PostingPreview {
  success: boolean
  error?: string
  document_type: string
  total_amount: number
  description: string
  // Supplier payments (OUT) and customer receipts (IN): the actual amount is entered at posting.
  is_payment?: boolean
  direction?: 'IN' | 'OUT'
  stage?: 'ADVANCE' | 'SETTLEMENT'
  order_total?: number
  order_paid_total?: number
  // Sales invoices
  revenue?: number
  cost_of_sales?: number
  gross_profit?: number
  advances_applied?: number
  requested_amount?: number
  paid_on_document?: number
  remaining_requested?: number
  receipt_remaining?: number
  order_unpaid?: number
  max_amount?: number
  lines: {
    account_code: string
    account_name: string
    debit: number
    credit: number
    entity_type?: string
    entity_name?: string
  }[]
}

// ── Helpers ──────────────────────────────────────────────────────

const POSTING_TYPES_FILTER = [
  { value: 'all', label: 'All Types' },
  { value: 'SALES_INVOICE', label: 'Sales Invoice' },
  { value: 'RECEIPT', label: 'Customer Receipt' },
  { value: 'SUPPLIER_DEPOSIT_PAYMENT', label: 'Supplier Deposit' },
  { value: 'SUPPLIER_INVOICE_RECOGNITION', label: 'Supplier Invoice' },
  { value: 'SUPPLIER_BALANCE_PAYMENT', label: 'Balance Payment' },
]

const POSTING_ICONS: Record<string, React.ElementType> = {
  SALES_INVOICE: Receipt,
  RECEIPT: CreditCard,
  SUPPLIER_DEPOSIT_PAYMENT: ArrowUpFromLine,
  SUPPLIER_INVOICE_RECOGNITION: FileText,
  SUPPLIER_BALANCE_PAYMENT: Wallet,
}

interface BankAccountOption {
  id: string
  account_name: string
  bank_name: string
  is_active: boolean
  is_default: boolean
  gl_account: { code: string; name: string } | null
}

/** Money direction of a posting: IN from customers, OUT to suppliers; invoices move no money. */
function postingFlow(glDocType: string): 'IN' | 'OUT' | null {
  if (glDocType === 'RECEIPT') return 'IN'
  if (glDocType === 'SUPPLIER_DEPOSIT_PAYMENT' || glDocType === 'SUPPLIER_BALANCE_PAYMENT') return 'OUT'
  return null
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(amount)
}

function formatDate(dateStr: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' })
}

// ── Component ────────────────────────────────────────────────────

export default function PendingPostingsView({ userProfile }: PendingPostingsViewProps) {
  // Data
  const [pendingPostings, setPendingPostings] = useState<PendingPosting[]>([])
  const [loading, setLoading] = useState(true)
  const [total, setTotal] = useState(0)

  // Filters
  const [typeFilter, setTypeFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  // Pagination
  const [page, setPage] = useState(0)
  const limit = 25

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Preview modal
  const [previewLoading, setPreviewLoading] = useState(false)
  const [postingPreview, setPostingPreview] = useState<PostingPreview | null>(null)
  const [selectedPending, setSelectedPending] = useState<PendingPosting | null>(null)
  // Order whose documents are shown (Order Documents dialog)
  const [docsOrder, setDocsOrder] = useState<{ id: string; orderNo: string; displayNo: string | null } | null>(null)
  const [postingDate, setPostingDate] = useState('')
  const today = financeToday()
  const postingDateValid = isValidPostingDate(postingDate) && postingDate <= today

  // Actual payment (supplier deposit / balance documents)
  const [bankAccounts, setBankAccounts] = useState<BankAccountOption[]>([])
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentBankId, setPaymentBankId] = useState('')
  const [paymentReference, setPaymentReference] = useState('')
  const [closesDocument, setClosesDocument] = useState(true)
  const [completeOpen, setCompleteOpen] = useState(false)
  const [completeReason, setCompleteReason] = useState('')
  const [completing, setCompleting] = useState(false)
  const isPayment = !!postingPreview?.is_payment
  // Customer receipt (money in): the bank is the debit line; supplier payment: the credit line.
  const isReceipt = isPayment && postingPreview?.direction === 'IN'
  const paymentAmountValue = toAmount(paymentAmount)
  const paymentMax = Number(postingPreview?.max_amount ?? 0)
  const paymentAmountValid =
    !isPayment || (Number.isFinite(paymentAmountValue) && paymentAmountValue > 0 && paymentAmountValue <= paymentMax)
  const selectedBank = bankAccounts.find((b) => b.id === paymentBankId) || null

  // For a payment, the preview shows the amount typed and the bank chosen.
  const previewLines = useMemo(() => {
    const lines = postingPreview?.lines || []
    if (!isPayment) return lines
    const amount = Number.isFinite(paymentAmountValue) ? paymentAmountValue : 0
    const bank = selectedBank?.gl_account
      ? { account_code: selectedBank.gl_account.code, account_name: selectedBank.gl_account.name }
      : {}
    return lines.map((line) =>
      line.debit > 0
        ? { ...line, debit: amount, ...(isReceipt ? bank : {}) }
        : { ...line, credit: amount, ...(isReceipt ? {} : bank) }
    )
  }, [postingPreview, isPayment, isReceipt, paymentAmountValue, selectedBank])

  // Batch posting
  const [batchPosting, setBatchPosting] = useState(false)
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false)
  const [batchResults, setBatchResults] = useState<{ success: number; failed: number; errors: string[] } | null>(null)

  // Warehouse receipt of the orders behind supplier invoices (Finance posts after the goods arrive).
  const [receivedByOrder, setReceivedByOrder] = useState<Record<string, boolean>>({})
  // Supply Chain documents of each order: complete (green) or not (yellow).
  const [completionByOrder, setCompletionByOrder] = useState<Record<string, OrderCompletion>>({})

  // Shown when Security & Access allows finance.journal.post (the server decides the
  // operation); the historical role-level rule applies until it is enforced.
  const canPost = useSaCapability('finance.journal.post', userProfile.roles.role_level <= 20)

  // ── Data Loading ──────────────────────────────────────────────

  useEffect(() => {
    const orderIds = Array.from(new Set(
      pendingPostings
        .filter((p) => p.gl_doc_type === 'SUPPLIER_INVOICE_RECOGNITION' && p.order_id)
        .map((p) => p.order_id),
    ))
    if (orderIds.length === 0) return
    let cancelled = false
    ;(async () => {
      const { data, error } = await (createClient() as any).rpc('fin_orders_warehouse_received', { p_order_ids: orderIds })
      if (cancelled || error || !Array.isArray(data)) return
      const map: Record<string, boolean> = {}
      for (const row of data) map[row.order_id] = !!row.received
      setReceivedByOrder(map)
    })()
    return () => { cancelled = true }
  }, [pendingPostings])

  useEffect(() => {
    const orderIds = Array.from(new Set(pendingPostings.map((p) => p.order_id).filter(Boolean)))
    if (orderIds.length === 0) return
    let cancelled = false
    ;(async () => {
      const supabase = createClient() as any
      const orders: any[] = []
      const docs: any[] = []
      for (let i = 0; i < orderIds.length; i += 100) {
        const chunk = orderIds.slice(i, i + 100)
        const [o, d] = await Promise.all([
          supabase.from('orders').select('id, order_type, status').in('id', chunk),
          supabase.from('documents').select('order_id, doc_type, status, payment_percentage').in('order_id', chunk),
        ])
        if (o.error || d.error) return
        orders.push(...(o.data || []))
        docs.push(...(d.data || []))
      }
      if (cancelled) return
      const map: Record<string, OrderCompletion> = {}
      for (const order of orders) {
        map[order.id] = orderDocumentsCompletion(order, docs.filter((x) => x.order_id === order.id))
      }
      setCompletionByOrder(map)
    })()
    return () => { cancelled = true }
  }, [pendingPostings])

  const loadPendingPostings = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      params.append('limit', '200') // Fetch all for client-side filtering
      params.append('offset', '0')

      const response = await fetch(`/api/accounting/pending-postings?${params}`)
      if (response.ok) {
        const data = await response.json()
        setPendingPostings(data.pendingPostings || [])
        setTotal(data.total || 0)
      } else {
        toast({ title: 'Error', description: 'Failed to load pending postings', variant: 'destructive' })
      }
    } catch (error) {
      console.error('Error loading pending postings:', error)
      toast({ title: 'Error', description: 'Failed to load pending postings', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadPendingPostings()
  }, [loadPendingPostings])

  // Bank accounts for the actual-payment form. Without access the default bank is used.
  useEffect(() => {
    if (!canPost) return
    let cancelled = false
    fetch('/api/accounting/cash/bank-accounts')
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((data) => {
        if (!cancelled) setBankAccounts((data.accounts || []).filter((a: BankAccountOption) => a.is_active))
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [canPost])

  // ── Client-side Filtering ─────────────────────────────────────

  const filteredPostings = useMemo(() => {
    let result = pendingPostings

    if (typeFilter !== 'all') {
      result = result.filter((p) => p.gl_doc_type === typeFilter)
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (p) =>
          (p.display_doc_no || p.document_no || '').toLowerCase().includes(q) ||
          (p.order_display_doc_no || p.order_no || '').toLowerCase().includes(q) ||
          (p.supplier_name || '').toLowerCase().includes(q) ||
          (p.buyer_name || '').toLowerCase().includes(q) ||
          (p.posting_label || '').toLowerCase().includes(q)
      )
    }

    if (dateFrom) {
      result = result.filter((p) => p.document_date >= dateFrom)
    }
    if (dateTo) {
      result = result.filter((p) => p.document_date <= dateTo + 'T23:59:59')
    }

    return result
  }, [pendingPostings, typeFilter, searchQuery, dateFrom, dateTo])

  // Paginated subset
  const paginatedPostings = useMemo(() => {
    const start = page * limit
    return filteredPostings.slice(start, start + limit)
  }, [filteredPostings, page, limit])

  const totalPages = Math.ceil(filteredPostings.length / limit)

  // ── Summary Stats ─────────────────────────────────────────────

  const summaryStats = useMemo(() => {
    const stats: Record<string, { count: number; total: number }> = {}
    for (const p of pendingPostings) {
      if (!stats[p.gl_doc_type]) stats[p.gl_doc_type] = { count: 0, total: 0 }
      stats[p.gl_doc_type].count++
      stats[p.gl_doc_type].total += Number(p.amount) || 0
    }
    return stats
  }, [pendingPostings])

  // ── Selection Handlers ────────────────────────────────────────

  const uniqueKey = (p: PendingPosting) => `${p.gl_doc_type}::${p.document_id}`

  const toggleSelect = (p: PendingPosting) => {
    const key = uniqueKey(p)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredPostings.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredPostings.map(uniqueKey)))
    }
  }

  const allSelected = filteredPostings.length > 0 && selectedIds.size === filteredPostings.length

  // ── Preview ───────────────────────────────────────────────────

  const loadPreview = async (pending: PendingPosting) => {
    try {
      setPreviewLoading(true)
      setSelectedPending(pending)
      setPostingDate(defaultPostingDate(pending.document_date))
      const response = await fetch(
        `/api/accounting/posting?documentType=${pending.gl_doc_type}&documentId=${pending.document_id}`
      )
      if (response.ok) {
        const data = await response.json()
        setPostingPreview(data)
        if (data?.is_payment) {
          // Default: what remains requested on this document, to the default bank.
          setPaymentAmount(String(Number(data.total_amount || 0).toFixed(2)))
          setPaymentReference('')
          // A customer receipt stays open for more receipts; it closes by itself when the order is fully received.
          setClosesDocument(data.direction !== 'IN')
          setCompleteOpen(false)
          setCompleteReason('')
          setPaymentBankId((bankAccounts.find((b) => b.is_default) || bankAccounts[0])?.id || '')
        }
      } else {
        const data = await response.json()
        toast({ title: 'Error', description: data.error || 'Failed to load preview', variant: 'destructive' })
        setPostingPreview(null)
      }
    } catch (error) {
      console.error('Error loading preview:', error)
      toast({ title: 'Error', description: 'Failed to load preview', variant: 'destructive' })
    } finally {
      setPreviewLoading(false)
    }
  }

  // ── Single Post ───────────────────────────────────────────────

  const handlePostSingle = async () => {
    if (!selectedPending || !canPost || !postingDateValid || !paymentAmountValid) return
    try {
      setPreviewLoading(true)
      const response = await fetch('/api/accounting/posting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentType: selectedPending.gl_doc_type,
          documentId: selectedPending.document_id,
          postingDate,
          ...(isPayment
            ? {
                amount: paymentAmountValue,
                bankAccountId: paymentBankId || null,
                reference: paymentReference,
                closesDocument,
              }
            : {}),
        }),
      })
      const data = await response.json()
      if (response.ok && data.success) {
        toast({
          title: 'Posted',
          description: data.document_closed === false
            ? `Journal ${data.journal_number} created. The document stays open for the remaining amount.`
            : `Journal ${data.journal_number} created successfully.`,
        })
        setPostingPreview(null)
        setSelectedPending(null)
        setSelectedIds((prev) => {
          const next = new Set(prev)
          next.delete(uniqueKey(selectedPending))
          return next
        })
        loadPendingPostings()
      } else {
        toast({ title: 'Posting Failed', description: data.error || 'Failed to post', variant: 'destructive' })
      }
    } catch (error) {
      console.error('Error posting:', error)
      toast({ title: 'Error', description: 'Failed to post to GL', variant: 'destructive' })
    } finally {
      setPreviewLoading(false)
    }
  }

  // ── Mark a payment document complete (no further payment) ─────

  const handleMarkComplete = async () => {
    if (!selectedPending || !canPost || !completeReason.trim()) return
    try {
      setCompleting(true)
      const response = await fetch(`/api/accounting/payment-documents/${selectedPending.document_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close', reason: completeReason }),
      })
      const data = await response.json()
      if (response.ok && data.success) {
        toast({ title: 'Closed', description: `${selectedPending.display_doc_no || selectedPending.document_no} is complete and left Pending Postings.` })
        setPostingPreview(null)
        setSelectedPending(null)
        loadPendingPostings()
      } else {
        toast({ title: 'Cannot close', description: data.error || 'Failed to close the document', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to close the document', variant: 'destructive' })
    } finally {
      setCompleting(false)
    }
  }

  // ── Batch Post ────────────────────────────────────────────────

  const handleBatchPost = async () => {
    if (selectedIds.size === 0 || !canPost) return
    setBatchPosting(true)
    setBatchConfirmOpen(false)

    const results = { success: 0, failed: 0, errors: [] as string[] }

    // Resolve selected items
    const items = filteredPostings.filter((p) => selectedIds.has(uniqueKey(p)))

    for (const item of items) {
      try {
        const response = await fetch('/api/accounting/posting', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentType: item.gl_doc_type,
            documentId: item.document_id,
            // Each document is posted on its own date.
            postingDate: defaultPostingDate(item.document_date),
          }),
        })
        const data = await response.json()
        if (response.ok && data.success) {
          results.success++
        } else {
          results.failed++
          results.errors.push(`${item.display_doc_no || item.document_no}: ${data.error || 'Unknown error'}`)
        }
      } catch {
        results.failed++
        results.errors.push(`${item.display_doc_no || item.document_no}: Network error`)
      }
    }

    setBatchResults(results)
    setBatchPosting(false)
    setSelectedIds(new Set())
    loadPendingPostings()

    if (results.success > 0) {
      toast({
        title: 'Batch Posting Complete',
        description: `${results.success} posted, ${results.failed} failed.`,
        variant: results.failed > 0 ? 'destructive' : 'default',
      })
    }
  }

  // ── Render ────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* ── Summary Cards ──────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Total */}
        <Card className="border-emerald-200 dark:border-emerald-800">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-emerald-600" />
              <span className="text-xs font-medium text-muted-foreground">Total Pending</span>
            </div>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{pendingPostings.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {formatCurrency(pendingPostings.reduce((s, p) => s + (Number(p.amount) || 0), 0))}
            </p>
          </CardContent>
        </Card>

        {POSTING_TYPES_FILTER.filter((t) => t.value !== 'all').map((type) => {
          const stat = summaryStats[type.value]
          const colors = POSTING_TYPE_COLORS[type.value]
          const Icon = POSTING_ICONS[type.value] || FileText

          return (
            <Card
              key={type.value}
              className={`cursor-pointer transition-all ${typeFilter === type.value ? 'ring-2 ring-emerald-500' : 'hover:shadow-sm'}`}
              onClick={() => setTypeFilter(typeFilter === type.value ? 'all' : type.value)}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Icon className={`h-4 w-4 ${colors?.text || 'text-muted-foreground'}`} />
                  <span className="text-xs font-medium text-muted-foreground truncate">{type.label}</span>
                </div>
                <p className="text-2xl font-bold">{stat?.count || 0}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatCurrency(stat?.total || 0)}
                </p>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* ── Main Card ──────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock className="h-5 w-5 text-orange-500" />
                Pending GL Postings
              </CardTitle>
              <CardDescription>
                Documents awaiting GL journal creation. Preview entries before posting.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {selectedIds.size > 0 && canPost && (
                <Button
                  size="sm"
                  onClick={() => setBatchConfirmOpen(true)}
                  disabled={batchPosting}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  {batchPosting ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <Zap className="h-4 w-4 mr-1.5" />
                  )}
                  Post Selected ({selectedIds.size})
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={loadPendingPostings} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {/* ── Filter Bar ──────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3 mb-5 p-3 bg-muted/50 rounded-lg border">
            <Filter className="h-4 w-4 text-muted-foreground shrink-0" />

            <div className="w-44">
              <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(0) }}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Posting Type" />
                </SelectTrigger>
                <SelectContent>
                  {POSTING_TYPES_FILTER.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-1.5">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(0) }}
                className="h-8 w-32 text-sm"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(0) }}
                className="h-8 w-32 text-sm"
              />
            </div>

            <div className="flex-1 min-w-[160px]">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setPage(0) }}
                  placeholder="Search doc #, order #, entity…"
                  className="h-8 text-sm pl-8"
                />
              </div>
            </div>

            {(typeFilter !== 'all' || dateFrom || dateTo || searchQuery) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => { setTypeFilter('all'); setDateFrom(''); setDateTo(''); setSearchQuery(''); setPage(0) }}
              >
                Clear filters
              </Button>
            )}
          </div>

          {/* ── Table ───────────────────────────────────────────── */}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-500 mb-3" />
              <p className="text-sm text-muted-foreground">Loading pending postings…</p>
            </div>
          ) : filteredPostings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <CheckCircle2 className="h-12 w-12 text-emerald-500 mb-3" />
              <p className="text-emerald-700 dark:text-emerald-300 font-semibold">All caught up!</p>
              <p className="text-sm text-muted-foreground mt-1">
                {pendingPostings.length === 0
                  ? 'No documents pending GL posting.'
                  : 'No items match your current filters.'}
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30">
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={toggleSelectAll}
                          aria-label="Select all"
                        />
                      </TableHead>
                      <TableHead>Document #</TableHead>
                      <TableHead>Order #</TableHead>
                      <TableHead>Posting Type</TableHead>
                      <TableHead className="text-center">Flow</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead className="text-right">Amount (MYR)</TableHead>
                      <TableHead className="w-28 text-center">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedPostings.map((pending) => {
                      const key = uniqueKey(pending)
                      const selected = selectedIds.has(key)
                      const colors = POSTING_TYPE_COLORS[pending.gl_doc_type]
                      // Supplier documents (H2M) show the supplier; sales documents the customer.
                      const entityName = (pending.gl_doc_type.startsWith('SUPPLIER_')
                        ? pending.supplier_name || pending.buyer_name
                        : pending.buyer_name || pending.supplier_name) || '-'

                      return (
                        <TableRow
                          key={key}
                          className={selected ? 'bg-emerald-50/50 dark:bg-emerald-950/20' : undefined}
                        >
                          <TableCell>
                            <Checkbox
                              checked={selected}
                              onCheckedChange={() => toggleSelect(pending)}
                              aria-label={`Select ${pending.display_doc_no || pending.document_no}`}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-sm font-medium">
                            {pending.display_doc_no || pending.document_no}
                          </TableCell>
                          <TableCell className="font-mono text-sm text-muted-foreground">
                            {pending.order_display_doc_no || pending.order_no || '-'}
                            {pending.order_id && (
                              (() => {
                                const completion = completionByOrder[pending.order_id]
                                const tone = !completion
                                  ? { text: 'text-blue-600', box: 'bg-blue-300' }
                                  : completion.complete
                                    ? { text: 'text-emerald-700', box: 'bg-emerald-500' }
                                    : { text: 'text-amber-700', box: 'bg-amber-500' }
                                const title = completion
                                  ? (completion.complete ? 'Order complete' : `Order not complete: ${completion.reason}`)
                                  : 'View order documents'
                                return (
                                  <button
                                    type="button"
                                    title={title}
                                    aria-label={`Documents. ${title}`}
                                    className={`mt-0.5 flex items-center gap-1.5 font-sans text-xs font-medium hover:underline ${tone.text}`}
                                    onClick={() => setDocsOrder({ id: pending.order_id, orderNo: pending.order_no, displayNo: pending.order_display_doc_no })}
                                  >
                                    <span className={`inline-block h-2.5 w-2.5 rounded-[2px] ${tone.box}`} aria-hidden="true" />
                                    Documents
                                  </button>
                                )
                              })()
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={`${colors?.bg || ''} ${colors?.text || ''} ${colors?.border || ''} text-xs`}
                            >
                              {pending.posting_label}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-center">
                            {(() => {
                              const flow = postingFlow(pending.gl_doc_type)
                              if (flow === 'IN') return (
                                <span title="Money in: received from the customer" className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-700">
                                  <ArrowDownToLine className="h-3 w-3" aria-hidden="true" />IN
                                </span>
                              )
                              if (flow === 'OUT') return (
                                <span title="Money out: paid to the supplier" className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-xs font-semibold text-red-700">
                                  <ArrowUpFromLine className="h-3 w-3" aria-hidden="true" />OUT
                                </span>
                              )
                              return <span title="Invoice: no money moves" className="text-xs text-muted-foreground">—</span>
                            })()}
                          </TableCell>
                          <TableCell className="text-sm max-w-[160px] truncate">
                            {entityName}
                            {pending.gl_doc_type === 'SUPPLIER_INVOICE_RECOGNITION' && pending.order_id in receivedByOrder && (
                              <div className={`text-xs ${receivedByOrder[pending.order_id] ? 'text-emerald-700' : 'text-amber-700'}`}>
                                {receivedByOrder[pending.order_id] ? 'Goods received' : 'Goods not received yet'}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDate(pending.document_date)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {pending.amount ? formatCurrency(Number(pending.amount)) : '-'}
                            {Number(pending.paid_amount) > 0 && (
                              <span className="block text-xs text-muted-foreground font-sans">
                                paid {formatCurrency(Number(pending.paid_amount))}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0"
                                onClick={() => loadPreview(pending)}
                                title="Preview & Post"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </Button>
                              {canPost && (
                                <Button
                                  size="sm"
                                  className="h-7 text-xs px-2 bg-emerald-600 hover:bg-emerald-700"
                                  onClick={() => loadPreview(pending)}
                                >
                                  Post
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* ── Pagination ──────────────────────────────────── */}
              <div className="flex items-center justify-between mt-4">
                <p className="text-sm text-muted-foreground">
                  Showing {page * limit + 1}–{Math.min((page + 1) * limit, filteredPostings.length)} of {filteredPostings.length}
                  {filteredPostings.length !== pendingPostings.length && (
                    <span className="ml-1">({pendingPostings.length} total)</span>
                  )}
                </p>
                {totalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      Page {page + 1} of {totalPages}
                    </span>
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

      {/* ── Preview & Post Modal ─────────────────────────────── */}
      <Dialog
        open={!!postingPreview || !!selectedPending}
        onOpenChange={() => { setPostingPreview(null); setSelectedPending(null) }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowUpDown className="h-5 w-5 text-emerald-600" />
              Post to General Ledger
            </DialogTitle>
            <DialogDescription>
              Review the journal entry that will be created, then confirm posting.
            </DialogDescription>
          </DialogHeader>

          {previewLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
            </div>
          ) : postingPreview?.success === false ? (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-red-700 dark:text-red-300">Cannot Post</p>
                <p className="text-sm text-red-600 dark:text-red-400">{postingPreview.error}</p>
              </div>
            </div>
          ) : postingPreview ? (
            <div className="space-y-5">
              {/* Document info */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground">Document</Label>
                  <p className="font-mono text-sm font-medium">
                    {selectedPending?.display_doc_no || selectedPending?.document_no}
                  </p>
                </div>
                {selectedPending?.order_id && (
                  <div>
                    <Label className="text-xs text-muted-foreground">Order</Label>
                    <p className="font-mono text-sm font-medium">
                      {selectedPending.order_display_doc_no || selectedPending.order_no}
                    </p>
                    <button
                      type="button"
                      className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
                      onClick={() => {
                        const p = selectedPending
                        // Close this dialog first: the documents dialog opens on top of the page.
                        setPostingPreview(null)
                        setSelectedPending(null)
                        setDocsOrder({ id: p.order_id, orderNo: p.order_no, displayNo: p.order_display_doc_no })
                      }}
                    >
                      <FileTextIcon className="h-3 w-3" />
                      View order documents
                    </button>
                  </div>
                )}
                <div>
                  <Label className="text-xs text-muted-foreground">Posting Type</Label>
                  <p className="text-sm font-medium">
                    {getPostingType(selectedPending?.gl_doc_type || '')?.label || selectedPending?.gl_doc_type}
                  </p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{isReceipt ? 'Amount Received' : isPayment ? 'Amount Paid' : 'Total Amount'}</Label>
                  <p className="font-mono text-sm font-medium">
                    {formatCurrency(isPayment ? (Number.isFinite(paymentAmountValue) ? paymentAmountValue : 0) : postingPreview.total_amount)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-2">
                  <Label className="text-xs text-muted-foreground">Description</Label>
                  <p className="text-sm">{postingPreview.description}</p>
                </div>
                <div>
                  <Label htmlFor="posting-date" className="text-xs text-muted-foreground">{isReceipt ? 'Receipt Date' : isPayment ? 'Payment Date' : 'Posting Date'}</Label>
                  <Input
                    id="posting-date"
                    type="date"
                    value={postingDate}
                    max={today}
                    onChange={(e) => setPostingDate(e.target.value)}
                    className="h-8 text-sm mt-1"
                  />
                  <p className={`text-xs mt-1 ${postingDateValid ? 'text-muted-foreground' : 'text-red-600'}`}>
                    {postingDateValid
                      ? `Document date: ${formatDate(selectedPending?.document_date || '')}`
                      : 'Enter a valid date that is not in the future.'}
                  </p>
                </div>
              </div>

              {/* Sales invoice: revenue, cost of goods sold and advances applied */}
              {postingPreview.document_type === 'SALES_INVOICE' && postingPreview.revenue !== undefined && (
                <div className="rounded-lg border p-3 bg-muted/20">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">Revenue</p>
                      <p className="font-mono">{formatCurrency(Number(postingPreview.revenue || 0))}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Cost of goods sold</p>
                      <p className="font-mono">{formatCurrency(Number(postingPreview.cost_of_sales || 0))}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Gross profit</p>
                      <p className="font-mono">{formatCurrency(Number(postingPreview.gross_profit || 0))}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Advances applied</p>
                      <p className="font-mono">{formatCurrency(Number(postingPreview.advances_applied || 0))}</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Cost of goods sold uses each product&apos;s fixed cost. Money received from the customer before this invoice moves from Customer Deposits to Accounts Receivable.
                  </p>
                </div>
              )}

              {/* Actual payment (supplier deposit / balance) or customer receipt */}
              {isPayment && (
                <div className="rounded-lg border p-3 space-y-3 bg-muted/20">
                  {isReceipt ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                      <div>
                        <p className="text-muted-foreground">Order total</p>
                        <p className="font-mono">{formatCurrency(Number(postingPreview.order_total || 0))}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Requested on this receipt</p>
                        <p className="font-mono">{formatCurrency(Number(postingPreview.requested_amount || 0))}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Posted on this receipt</p>
                        <p className="font-mono">{formatCurrency(Number(postingPreview.paid_on_document || 0))}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Unpaid on order</p>
                        <p className="font-mono">{formatCurrency(Number(postingPreview.order_unpaid ?? paymentMax))}</p>
                      </div>
                    </div>
                  ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">Requested (terms)</p>
                      <p className="font-mono">{formatCurrency(Number(postingPreview.requested_amount || 0))}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Paid on this document</p>
                      <p className="font-mono">{formatCurrency(Number(postingPreview.paid_on_document || 0))}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Remaining requested</p>
                      <p className="font-mono">{formatCurrency(Number(postingPreview.remaining_requested || 0))}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Unpaid on order</p>
                      <p className="font-mono">{formatCurrency(paymentMax)}</p>
                    </div>
                  </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {isReceipt
                      ? postingPreview.stage === 'ADVANCE'
                        ? 'The sales invoice is not posted yet, so this receipt is an advance (Customer Deposits). It is applied when the invoice is posted.'
                        : 'The sales invoice is posted, so this receipt settles Accounts Receivable.'
                      : postingPreview.stage === 'ADVANCE'
                        ? 'The supplier invoice is not posted yet, so this payment is an advance (Supplier Deposits).'
                        : 'The supplier invoice is posted, so this payment settles Accounts Payable.'}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <Label htmlFor="payment-amount" className="text-xs text-muted-foreground">{isReceipt ? 'Amount Actually Received (MYR)' : 'Amount Actually Paid (MYR)'}</Label>
                      <Input
                        id="payment-amount"
                        type="number"
                        inputMode="decimal"
                        min="0.01"
                        step="0.01"
                        max={paymentMax}
                        value={paymentAmount}
                        onChange={(e) => setPaymentAmount(e.target.value)}
                        className="h-8 text-sm mt-1 font-mono"
                      />
                      {isReceipt && (
                        <p className="text-xs mt-1 text-muted-foreground">
                          At most {formatCurrency(paymentMax)}: the amount on this receipt not yet posted.
                        </p>
                      )}
                      {!paymentAmountValid && (
                        <p className="text-xs mt-1 text-red-600">
                          Enter an amount above zero and at most {formatCurrency(paymentMax)}.
                        </p>
                      )}
                    </div>
                    <div>
                      <Label htmlFor="payment-bank" className="text-xs text-muted-foreground">{isReceipt ? 'Received Into' : 'Paid From'}</Label>
                      {bankAccounts.length > 0 ? (
                        <Select value={paymentBankId} onValueChange={setPaymentBankId}>
                          <SelectTrigger id="payment-bank" className="h-8 text-sm mt-1">
                            <SelectValue placeholder="Default bank account" />
                          </SelectTrigger>
                          <SelectContent>
                            {bankAccounts.map((b) => (
                              <SelectItem key={b.id} value={b.id}>
                                {b.account_name}{b.gl_account ? ` (${b.gl_account.code})` : ''}{b.is_default ? ' – default' : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <p className="text-sm mt-2 text-muted-foreground">Default bank account</p>
                      )}
                    </div>
                    <div>
                      <Label htmlFor="payment-reference" className="text-xs text-muted-foreground">Reference</Label>
                      <Input
                        id="payment-reference"
                        value={paymentReference}
                        maxLength={MAX_REFERENCE_LENGTH}
                        placeholder="Bank / transfer reference"
                        onChange={(e) => setPaymentReference(e.target.value)}
                        className="h-8 text-sm mt-1"
                      />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={closesDocument} onCheckedChange={(v) => setClosesDocument(v === true)} />
                    {isReceipt
                      ? 'Last receipt for this order (it leaves Pending Postings)'
                      : 'Last payment on this document (it leaves Pending Postings)'}
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {isReceipt
                      ? 'The receipt also closes by itself once the whole order is received. Leave this unticked if more money is expected.'
                      : 'The document also closes by itself once its requested amount, or the whole order, is paid.'}
                  </p>
                  {canPost && (
                    <div className="border-t pt-2">
                      {!completeOpen ? (
                        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setCompleteOpen(true)}>
                          {isReceipt ? 'Mark as complete without another receipt…' : 'Mark as complete without another payment…'}
                        </Button>
                      ) : (
                        <div className="flex flex-col sm:flex-row gap-2">
                          <Input
                            value={completeReason}
                            maxLength={300}
                            placeholder={isReceipt ? 'Reason (required), e.g. customer given a discount' : 'Reason (required), e.g. supplier agreed a discount'}
                            onChange={(e) => setCompleteReason(e.target.value)}
                            className="h-8 text-sm"
                          />
                          <Button size="sm" variant="outline" onClick={handleMarkComplete} disabled={completing || !completeReason.trim()}>
                            {completing && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                            Close document
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setCompleteOpen(false)}>Cancel</Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {selectedPending?.gl_doc_type === 'SUPPLIER_INVOICE_RECOGNITION'
                && receivedByOrder[selectedPending.order_id] === false && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  The goods of this order have not been received in the warehouse yet.
                  Confirm the receipt before posting the supplier invoice to inventory.
                </div>
              )}

              <Separator />

              {/* Journal lines preview */}
              <div>
                <Label className="text-xs text-muted-foreground mb-2 block">Journal Lines (Preview)</Label>
                <div className="rounded-lg border overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/30">
                        <TableHead>Account</TableHead>
                        <TableHead className="text-right w-32">Debit (MYR)</TableHead>
                        <TableHead className="text-right w-32">Credit (MYR)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {previewLines.map((line: PostingPreview['lines'][0], idx: number) => (
                        <TableRow key={idx}>
                          <TableCell>
                            <span className="font-mono text-sm">{line.account_code}</span>
                            <span className="text-muted-foreground text-sm ml-2">{line.account_name}</span>
                            {line.entity_name && (
                              <span className="text-blue-600 dark:text-blue-400 text-xs block ml-0">
                                [{line.entity_type}: {line.entity_name}]
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {line.debit > 0 ? formatCurrency(line.debit) : '-'}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {line.credit > 0 ? formatCurrency(line.credit) : '-'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => { setPostingPreview(null); setSelectedPending(null) }}>
                  Cancel
                </Button>
                {canPost && (
                  <Button onClick={handlePostSingle} disabled={previewLoading || !postingDateValid || !paymentAmountValid} className="bg-emerald-600 hover:bg-emerald-700">
                    {previewLoading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                    )}
                    Confirm & Post to GL
                  </Button>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ── Batch Confirm Modal ──────────────────────────────── */}
      <Dialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-amber-500" />
              Confirm Batch Posting
            </DialogTitle>
            <DialogDescription>
              This will post {selectedIds.size} document(s) to the General Ledger.
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <div className="text-sm text-amber-700 dark:text-amber-300">
                  <p className="font-medium">Batch posting will:</p>
                  <ul className="list-disc list-inside mt-1 space-y-0.5 text-xs">
                    <li>Create {selectedIds.size} GL journal entries</li>
                    <li>Each posting is idempotent (safe to retry)</li>
                    <li>Post each document on its own document date</li>
                    <li>Post supplier payments and customer receipts at the suggested amount, to or from the default bank (open one to enter a different amount)</li>
                    <li>Fail for any document dated in a closed period</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setBatchConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleBatchPost} className="bg-emerald-600 hover:bg-emerald-700">
              <Zap className="h-4 w-4 mr-2" />
              Post {selectedIds.size} Documents
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Batch Results Modal ──────────────────────────────── */}
      <Dialog open={!!batchResults} onOpenChange={() => setBatchResults(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-emerald-600" />
              Batch Posting Results
            </DialogTitle>
          </DialogHeader>

          {batchResults && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-lg p-3 text-center">
                  <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{batchResults.success}</p>
                  <p className="text-xs text-emerald-600 dark:text-emerald-400">Successfully Posted</p>
                </div>
                <div className={`rounded-lg p-3 text-center ${batchResults.failed > 0 ? 'bg-red-50 dark:bg-red-900/20' : 'bg-gray-50 dark:bg-gray-900/20'}`}>
                  <p className={`text-2xl font-bold ${batchResults.failed > 0 ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground'}`}>
                    {batchResults.failed}
                  </p>
                  <p className="text-xs text-muted-foreground">Failed</p>
                </div>
              </div>

              {batchResults.errors.length > 0 && (
                <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
                  <p className="text-sm font-medium text-red-700 dark:text-red-300 mb-1">Errors:</p>
                  <ul className="text-xs text-red-600 dark:text-red-400 space-y-0.5 max-h-32 overflow-y-auto">
                    {batchResults.errors.map((err, i) => (
                      <li key={i}>• {err}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex justify-end">
                <Button onClick={() => setBatchResults(null)}>Close</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {docsOrder && (
        <OrderDocumentsDialogEnhanced
          open={!!docsOrder}
          onClose={() => setDocsOrder(null)}
          orderId={docsOrder.id}
          orderNo={docsOrder.orderNo}
          displayOrderNo={docsOrder.displayNo}
          userProfile={userProfile as any}
        />
      )}
    </div>
  )
}
