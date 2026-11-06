'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  BookOpen,
  FileText,
  RefreshCw,
  Eye,
  CheckCircle2,
  Clock,
  ArrowUpDown,
  Loader2,
  Calendar,
  Filter,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  Plus,
  Pencil,
  Trash2,
  Undo2
} from 'lucide-react'
import { useSaCapability } from '@/hooks/useSaCapability'
import { defaultPostingDate } from '@/modules/finance/postingDate'
import { canReverseJournal } from '@/modules/finance/manualJournal'
import ManualJournalDialog, { ManualJournalDraft } from '@/components/accounting/ManualJournalDialog'
import ReverseJournalDialog from '@/components/accounting/ReverseJournalDialog'

interface GLJournalViewProps {
  userProfile: {
    id: string
    organizations: {
      id: string
      org_type_code: string
    }
    roles: {
      role_level: number
    }
  }
}

interface Journal {
  id: string
  journal_number: string
  journal_date: string
  posting_date: string
  description: string
  journal_type: string
  status: string
  total_debit: number
  total_credit: number
  company_name: string
  created_by_name: string
  created_at: string
  is_manual?: boolean
  reference?: string | null
  is_reversal?: boolean
  reversal_reason?: string | null
  reversal_journal_id?: string | null
  reversal_journal_number?: string | null
  reversed_journal_id?: string | null
  reversed_journal_number?: string | null
}

interface JournalLine {
  id: string
  line_number: number
  account_code: string
  account_name: string
  description: string
  debit_amount: number
  credit_amount: number
  entity_type: string | null
  entity_name: string | null
}

interface JournalDetail {
  journal: Journal
  lines: JournalLine[]
  posting: {
    document_type: string
    document_id: string
    document_number: string
    posted_amount: number
  } | null
  edit_lines?: Array<{ account_id: string; description: string | null; debit_amount: number; credit_amount: number }>
}

interface PendingPosting {
  document_id: string
  document_type: string
  document_no: string
  display_doc_no: string | null  // New document number format
  order_id: string
  document_status: string
  order_no: string
  order_display_doc_no: string | null  // New order number format (ORD26000017)
  document_date: string
  gl_doc_type: string  // The GL document type for posting
  posting_label: string
  amount: number
  supplier_name: string
  buyer_name: string
}

const JOURNAL_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  SALES_INVOICE: { label: 'Sales Invoice', color: 'blue' },
  RECEIPT: { label: 'Receipt', color: 'green' },
  SUPPLIER_DEPOSIT: { label: 'Supplier Deposit', color: 'purple' },
  SUPPLIER_PAYMENT: { label: 'Supplier Payment', color: 'orange' },
  REVERSAL: { label: 'Reversal', color: 'red' },
  ADJUSTMENT: { label: 'Adjustment', color: 'gray' },
  OPENING: { label: 'Opening', color: 'indigo' }
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: 'gray' },
  POSTED: { label: 'Posted', color: 'green' },
  REVERSED: { label: 'Reversed', color: 'red' }
}

export default function GLJournalView({ userProfile }: GLJournalViewProps) {
  const [activeTab, setActiveTab] = useState('posted')
  const [journals, setJournals] = useState<Journal[]>([])
  const [pendingPostings, setPendingPostings] = useState<PendingPosting[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingPending, setLoadingPending] = useState(true)
  const [total, setTotal] = useState(0)
  const [pendingTotal, setPendingTotal] = useState(0)

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('POSTED')
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [fromDate, setFromDate] = useState<string>('')
  const [toDate, setToDate] = useState<string>('')

  // Pagination
  const [page, setPage] = useState(0)
  const [pendingPage, setPendingPage] = useState(0)
  const limit = 20

  // Detail modal
  const [selectedJournal, setSelectedJournal] = useState<JournalDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Posting modal
  const [postingPreview, setPostingPreview] = useState<any>(null)
  const [postingLoading, setPostingLoading] = useState(false)
  const [selectedPending, setSelectedPending] = useState<PendingPosting | null>(null)

  // Shown when Security & Access allows finance.journal.post (the server decides the
  // operation); the historical role-level rule applies until it is enforced.
  const canPost = useSaCapability('finance.journal.post', userProfile.roles.role_level <= 20)
  const canReverse = useSaCapability('finance.payment.approve', userProfile.roles.role_level <= 20)

  // Manual journals and reversal
  const [journalFormOpen, setJournalFormOpen] = useState(false)
  const [editingDraft, setEditingDraft] = useState<ManualJournalDraft | null>(null)
  const [reverseTarget, setReverseTarget] = useState<{ id: string; journal_number: string; journal_date: string } | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  const openNewJournal = () => {
    setEditingDraft(null)
    setJournalFormOpen(true)
  }

  const openEditDraft = (detail: JournalDetail) => {
    setEditingDraft({
      id: detail.journal.id,
      journal_date: detail.journal.journal_date?.slice(0, 10),
      description: detail.journal.description,
      reference: detail.journal.reference ?? null,
      lines: detail.edit_lines || [],
    })
    setSelectedJournal(null)
    setJournalFormOpen(true)
  }

  const postDraft = async (journalId: string) => {
    try {
      setActionLoading(true)
      const res = await fetch(`/api/accounting/journals/${journalId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'post' }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        toast({ title: 'Cannot post', description: data.error || 'Failed to post the journal', variant: 'destructive' })
        return
      }
      toast({ title: 'Journal posted', description: `Journal ${data.journal_number}` })
      setSelectedJournal(null)
      loadJournals()
    } finally {
      setActionLoading(false)
    }
  }

  const deleteDraft = async (journalId: string) => {
    try {
      setActionLoading(true)
      const res = await fetch(`/api/accounting/journals/${journalId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok || !data.success) {
        toast({ title: 'Cannot delete', description: data.error || 'Failed to delete the draft', variant: 'destructive' })
        return
      }
      toast({ title: 'Draft deleted' })
      setSelectedJournal(null)
      loadJournals()
    } finally {
      setActionLoading(false)
    }
  }

  useEffect(() => {
    if (activeTab === 'posted') {
      loadJournals()
    } else {
      loadPendingPostings()
    }
  }, [activeTab, statusFilter, typeFilter, fromDate, toDate, page, pendingPage])

  const loadJournals = async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      if (statusFilter) params.append('status', statusFilter)
      if (typeFilter) params.append('type', typeFilter)
      if (fromDate) params.append('from', fromDate)
      if (toDate) params.append('to', toDate)
      params.append('limit', limit.toString())
      params.append('offset', (page * limit).toString())

      const response = await fetch(`/api/accounting/journals?${params}`)
      if (response.ok) {
        const data = await response.json()
        setJournals(data.journals)
        setTotal(data.total)
      } else {
        toast({ title: 'Error', description: 'Failed to load journals', variant: 'destructive' })
      }
    } catch (error) {
      console.error('Error loading journals:', error)
      toast({ title: 'Error', description: 'Failed to load journals', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const loadPendingPostings = async () => {
    try {
      setLoadingPending(true)
      const params = new URLSearchParams()
      params.append('limit', limit.toString())
      params.append('offset', (pendingPage * limit).toString())

      const response = await fetch(`/api/accounting/pending-postings?${params}`)
      if (response.ok) {
        const data = await response.json()
        setPendingPostings(data.pendingPostings)
        setPendingTotal(data.total)
      } else {
        toast({ title: 'Error', description: 'Failed to load pending postings', variant: 'destructive' })
      }
    } catch (error) {
      console.error('Error loading pending postings:', error)
      toast({ title: 'Error', description: 'Failed to load pending postings', variant: 'destructive' })
    } finally {
      setLoadingPending(false)
    }
  }

  const loadJournalDetail = async (journalId: string) => {
    try {
      setDetailLoading(true)
      const response = await fetch(`/api/accounting/journals/${journalId}`)
      if (response.ok) {
        const data = await response.json()
        setSelectedJournal(data)
      } else {
        toast({ title: 'Error', description: 'Failed to load journal details', variant: 'destructive' })
      }
    } catch (error) {
      console.error('Error loading journal detail:', error)
      toast({ title: 'Error', description: 'Failed to load journal details', variant: 'destructive' })
    } finally {
      setDetailLoading(false)
    }
  }

  const loadPostingPreview = async (pending: PendingPosting) => {
    try {
      setPostingLoading(true)
      setSelectedPending(pending)
      const response = await fetch(
        `/api/accounting/posting?documentType=${pending.gl_doc_type}&documentId=${pending.document_id}`
      )
      if (response.ok) {
        const data = await response.json()
        setPostingPreview(data)
      } else {
        const data = await response.json()
        toast({ title: 'Error', description: data.error || 'Failed to load preview', variant: 'destructive' })
        setPostingPreview(null)
      }
    } catch (error) {
      console.error('Error loading posting preview:', error)
      toast({ title: 'Error', description: 'Failed to load preview', variant: 'destructive' })
    } finally {
      setPostingLoading(false)
    }
  }

  const handlePostToGL = async () => {
    if (!selectedPending || !canPost) return

    try {
      setPostingLoading(true)
      const response = await fetch('/api/accounting/posting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentType: selectedPending.gl_doc_type,
          documentId: selectedPending.document_id,
          // Post on the document's own date (Malaysia time), as Pending Postings does.
          postingDate: defaultPostingDate(selectedPending.document_date)
        })
      })

      const data = await response.json()

      if (response.ok && data.success) {
        toast({
          title: 'Success',
          description: `Posted to GL. Journal: ${data.journal_number}`
        })
        setPostingPreview(null)
        setSelectedPending(null)
        loadPendingPostings()
        // Refresh journals tab too
        loadJournals()
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to post to GL',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error posting to GL:', error)
      toast({ title: 'Error', description: 'Failed to post to GL', variant: 'destructive' })
    } finally {
      setPostingLoading(false)
    }
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-MY', {
      style: 'currency',
      currency: 'MYR'
    }).format(amount)
  }

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '-'
    return new Date(dateStr).toLocaleDateString('en-MY', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  const totalPages = Math.ceil(total / limit)
  const pendingTotalPages = Math.ceil(pendingTotal / limit)

  return (
    <div className="space-y-6">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2 lg:w-auto lg:inline-flex">
          <TabsTrigger value="posted" className="flex items-center gap-2">
            <BookOpen className="w-4 h-4" />
            GL Journals
            {total > 0 && (
              <Badge variant="secondary" className="ml-1">{total}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="pending" className="flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Pending Postings
            {pendingTotal > 0 && (
              <Badge variant="destructive" className="ml-1">{pendingTotal}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Posted Journals Tab */}
        <TabsContent value="posted" className="mt-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <BookOpen className="w-5 h-5" />
                    General Ledger Journals
                  </CardTitle>
                  <CardDescription>
                    View journal entries, add manual journals and reverse posted ones
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {canPost && (
                    <Button size="sm" onClick={openNewJournal}>
                      <Plus className="w-4 h-4 mr-2" />
                      New Journal
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={loadJournals}>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refresh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Filters */}
              <div className="flex flex-wrap gap-4 mb-6 p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-gray-500" />
                  <span className="text-sm font-medium">Filters:</span>
                </div>
                <div className="flex-1 flex flex-wrap gap-4">
                  <div className="w-40">
                    <Select value={statusFilter || 'all'} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Status</SelectItem>
                        <SelectItem value="POSTED">Posted</SelectItem>
                        <SelectItem value="DRAFT">Draft</SelectItem>
                        <SelectItem value="REVERSED">Reversed</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="w-48">
                    <Select value={typeFilter || 'all'} onValueChange={(v) => setTypeFilter(v === 'all' ? '' : v)}>
                      <SelectTrigger>
                        <SelectValue placeholder="Journal Type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Types</SelectItem>
                        <SelectItem value="SUPPLIER_DEPOSIT">Supplier Deposit</SelectItem>
                        <SelectItem value="SUPPLIER_PAYMENT">Supplier Payment</SelectItem>
                        <SelectItem value="SALES_INVOICE">Sales Invoice</SelectItem>
                        <SelectItem value="RECEIPT">Receipt</SelectItem>
                        <SelectItem value="ADJUSTMENT">Adjustment (Manual)</SelectItem>
                        <SelectItem value="REVERSAL">Reversal</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-gray-500" />
                    <Input
                      type="date"
                      value={fromDate}
                      onChange={(e) => setFromDate(e.target.value)}
                      className="w-36"
                      placeholder="From"
                    />
                    <span className="text-gray-500">to</span>
                    <Input
                      type="date"
                      value={toDate}
                      onChange={(e) => setToDate(e.target.value)}
                      className="w-36"
                      placeholder="To"
                    />
                  </div>
                </div>
              </div>

              {/* Journals Table */}
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                </div>
              ) : journals.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <BookOpen className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>No journal entries found</p>
                </div>
              ) : (
                <>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Journal #</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead className="text-right">Debit</TableHead>
                          <TableHead className="text-right">Credit</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="w-20"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {journals.map((journal) => {
                          const typeInfo = JOURNAL_TYPE_LABELS[journal.journal_type] || { label: journal.journal_type, color: 'gray' }
                          const statusInfo = STATUS_LABELS[journal.status] || { label: journal.status, color: 'gray' }
                          return (
                            <TableRow key={journal.id}>
                              <TableCell className="font-mono text-sm">
                                {journal.journal_number}
                              </TableCell>
                              <TableCell>{formatDate(journal.journal_date)}</TableCell>
                              <TableCell>
                                <Badge variant="outline" className={`bg-${typeInfo.color}-50 text-${typeInfo.color}-700 border-${typeInfo.color}-200`}>
                                  {typeInfo.label}
                                </Badge>
                              </TableCell>
                              <TableCell className="max-w-xs truncate">
                                {journal.is_manual && (
                                  <Badge variant="outline" className="mr-2 text-xs">Manual</Badge>
                                )}
                                {journal.description}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatCurrency(journal.total_debit)}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatCurrency(journal.total_credit)}
                              </TableCell>
                              <TableCell>
                                <Badge variant={journal.status === 'POSTED' ? 'default' : 'secondary'}>
                                  {statusInfo.label}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => loadJournalDetail(journal.id)}
                                >
                                  <Eye className="w-4 h-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-between mt-4">
                      <p className="text-sm text-gray-600">
                        Showing {page * limit + 1} - {Math.min((page + 1) * limit, total)} of {total}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPage(p => Math.max(0, p - 1))}
                          disabled={page === 0}
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </Button>
                        <span className="text-sm">
                          Page {page + 1} of {totalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                          disabled={page >= totalPages - 1}
                        >
                          <ChevronRight className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Pending Postings Tab */}
        <TabsContent value="pending" className="mt-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Clock className="w-5 h-5 text-orange-500" />
                    Pending GL Postings
                  </CardTitle>
                  <CardDescription>
                    Receipts that are ready to be posted to GL
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={loadPendingPostings}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {loadingPending ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                </div>
              ) : pendingPostings.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  <CheckCircle2 className="w-12 h-12 mx-auto mb-4 text-green-500" />
                  <p className="text-green-600 font-medium">All caught up!</p>
                  <p className="text-sm">No receipts pending GL posting</p>
                </div>
              ) : (
                <>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Document #</TableHead>
                          <TableHead>Order #</TableHead>
                          <TableHead>Posting Type</TableHead>
                          <TableHead>Supplier</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead className="w-32"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pendingPostings.map((pending) => (
                          <TableRow key={`${pending.gl_doc_type}-${pending.document_id}`}>
                            <TableCell className="font-mono text-sm">
                              {pending.display_doc_no || pending.document_no}
                            </TableCell>
                            <TableCell className="font-mono text-sm">
                              {pending.order_display_doc_no || pending.order_no || '-'}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={
                                  pending.gl_doc_type === 'SUPPLIER_DEPOSIT_PAYMENT'
                                    ? 'bg-purple-50 text-purple-700 border-purple-200'
                                    : pending.gl_doc_type === 'SUPPLIER_INVOICE_RECOGNITION'
                                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                                      : 'bg-orange-50 text-orange-700 border-orange-200'
                                }
                              >
                                {pending.posting_label}
                              </Badge>
                            </TableCell>
                            <TableCell>{pending.supplier_name || '-'}</TableCell>
                            <TableCell>{formatDate(pending.document_date)}</TableCell>
                            <TableCell className="text-right font-mono">
                              {pending.amount ? formatCurrency(Number(pending.amount)) : '-'}
                            </TableCell>
                            <TableCell>
                              <Button
                                size="sm"
                                onClick={() => loadPostingPreview(pending)}
                                disabled={!canPost}
                              >
                                Post to GL
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Pagination */}
                  {pendingTotalPages > 1 && (
                    <div className="flex items-center justify-between mt-4">
                      <p className="text-sm text-gray-600">
                        Showing {pendingPage * limit + 1} - {Math.min((pendingPage + 1) * limit, pendingTotal)} of {pendingTotal}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPendingPage(p => Math.max(0, p - 1))}
                          disabled={pendingPage === 0}
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </Button>
                        <span className="text-sm">
                          Page {pendingPage + 1} of {pendingTotalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setPendingPage(p => Math.min(pendingTotalPages - 1, p + 1))}
                          disabled={pendingPage >= pendingTotalPages - 1}
                        >
                          <ChevronRight className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Journal Detail Modal */}
      <Dialog open={!!selectedJournal} onOpenChange={() => setSelectedJournal(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5" />
              Journal Entry: {selectedJournal?.journal.journal_number}
            </DialogTitle>
            <DialogDescription>
              {selectedJournal?.journal.description}
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
            </div>
          ) : selectedJournal && (
            <div className="space-y-6">
              {/* Header Info */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <Label className="text-gray-500">Journal Date</Label>
                  <p className="font-medium">{formatDate(selectedJournal.journal.journal_date)}</p>
                </div>
                <div>
                  <Label className="text-gray-500">Posting Date</Label>
                  <p className="font-medium">{formatDate(selectedJournal.journal.posting_date)}</p>
                </div>
                <div>
                  <Label className="text-gray-500">Type</Label>
                  <p className="font-medium">
                    {JOURNAL_TYPE_LABELS[selectedJournal.journal.journal_type]?.label || selectedJournal.journal.journal_type}
                  </p>
                </div>
                <div>
                  <Label className="text-gray-500">Status</Label>
                  <Badge variant={selectedJournal.journal.status === 'POSTED' ? 'default' : 'secondary'}>
                    {selectedJournal.journal.status}
                  </Badge>
                </div>
              </div>

              {/* Source Document */}
              {selectedJournal.posting && (
                <div className="p-3 bg-blue-50 rounded-lg">
                  <Label className="text-blue-700">Source Document</Label>
                  <p className="text-sm">
                    {selectedJournal.posting.document_type}: {selectedJournal.posting.document_number}
                  </p>
                </div>
              )}

              {selectedJournal.journal.reference && (
                <div className="text-sm">
                  <Label className="text-gray-500">Reference</Label>
                  <p className="font-medium">{selectedJournal.journal.reference}</p>
                </div>
              )}

              {/* Reversal links */}
              {selectedJournal.journal.reversal_journal_id && (
                <div className="p-3 bg-red-50 rounded-lg text-sm">
                  <Label className="text-red-700">Reversed</Label>
                  <p>
                    Reversed by {selectedJournal.journal.reversal_journal_number || 'a reversal journal'}
                    {selectedJournal.journal.reversal_reason ? ` — ${selectedJournal.journal.reversal_reason}` : ''}
                  </p>
                </div>
              )}
              {selectedJournal.journal.is_reversal && (
                <div className="p-3 bg-red-50 rounded-lg text-sm">
                  <Label className="text-red-700">Reversal Journal</Label>
                  <p>
                    Reverses {selectedJournal.journal.reversed_journal_number || 'the original journal'}
                    {selectedJournal.journal.reversal_reason ? ` — ${selectedJournal.journal.reversal_reason}` : ''}
                  </p>
                </div>
              )}

              {/* Journal Lines */}
              <div>
                <Label className="text-gray-500 mb-2 block">Journal Lines</Label>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Account</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selectedJournal.lines.map((line) => (
                        <TableRow key={line.id}>
                          <TableCell>{line.line_number}</TableCell>
                          <TableCell>
                            <span className="font-mono text-sm">{line.account_code}</span>
                            <br />
                            <span className="text-gray-500 text-sm">{line.account_name}</span>
                          </TableCell>
                          <TableCell className="text-sm">
                            {line.description && <span className="block">{line.description}</span>}
                            {line.entity_name && (
                              <span className="text-blue-600">[{line.entity_type}: {line.entity_name}]</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {line.debit_amount > 0 ? formatCurrency(line.debit_amount) : '-'}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {line.credit_amount > 0 ? formatCurrency(line.credit_amount) : '-'}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-gray-50 font-medium">
                        <TableCell colSpan={3} className="text-right">Total:</TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(selectedJournal.journal.total_debit)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(selectedJournal.journal.total_credit)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Actions */}
              {(() => {
                const j = selectedJournal.journal
                const isDraft = j.is_manual && j.status === 'DRAFT'
                const reversible = canReverse && canReverseJournal(j)
                if (!(isDraft && canPost) && !reversible) return null
                return (
                  <div className="flex justify-end gap-3 border-t pt-4">
                    {isDraft && canPost && (
                      <>
                        <Button variant="outline" onClick={() => deleteDraft(j.id)} disabled={actionLoading}>
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete Draft
                        </Button>
                        <Button variant="outline" onClick={() => openEditDraft(selectedJournal)} disabled={actionLoading}>
                          <Pencil className="w-4 h-4 mr-2" />
                          Edit
                        </Button>
                        <Button onClick={() => postDraft(j.id)} disabled={actionLoading}>
                          {actionLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                          Post Journal
                        </Button>
                      </>
                    )}
                    {reversible && (
                      <Button
                        variant="destructive"
                        onClick={() => {
                          setReverseTarget({ id: j.id, journal_number: j.journal_number, journal_date: j.journal_date })
                          setSelectedJournal(null)
                        }}
                      >
                        <Undo2 className="w-4 h-4 mr-2" />
                        Reverse
                      </Button>
                    )}
                  </div>
                )
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ManualJournalDialog
        open={journalFormOpen}
        draft={editingDraft}
        onClose={() => { setJournalFormOpen(false); setEditingDraft(null) }}
        onSaved={() => { setJournalFormOpen(false); setEditingDraft(null); setStatusFilter(''); loadJournals() }}
      />

      <ReverseJournalDialog
        journal={reverseTarget}
        onClose={() => setReverseTarget(null)}
        onReversed={() => { setReverseTarget(null); loadJournals(); loadPendingPostings() }}
      />

      {/* Posting Preview Modal */}
      <Dialog open={!!postingPreview || !!selectedPending} onOpenChange={() => { setPostingPreview(null); setSelectedPending(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowUpDown className="w-5 h-5" />
              Post to General Ledger
            </DialogTitle>
            <DialogDescription>
              Review the journal entry before posting
            </DialogDescription>
          </DialogHeader>

          {postingLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
            </div>
          ) : postingPreview?.success === false ? (
            <div className="p-4 bg-red-50 rounded-lg flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-500 mt-0.5" />
              <div>
                <p className="font-medium text-red-700">Cannot Post</p>
                <p className="text-sm text-red-600">{postingPreview.error}</p>
              </div>
            </div>
          ) : postingPreview && (
            <div className="space-y-6">
              {/* Preview Info */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <Label className="text-gray-500">Document Type</Label>
                  <p className="font-medium">
                    {JOURNAL_TYPE_LABELS[postingPreview.document_type]?.label || postingPreview.document_type}
                  </p>
                </div>
                <div>
                  <Label className="text-gray-500">Total Amount</Label>
                  <p className="font-medium">{formatCurrency(postingPreview.total_amount)}</p>
                </div>
              </div>

              <div>
                <Label className="text-gray-500">Description</Label>
                <p className="text-sm">{postingPreview.description}</p>
              </div>

              {/* Preview Lines */}
              <div>
                <Label className="text-gray-500 mb-2 block">Journal Lines (Preview)</Label>
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead className="text-right">Debit</TableHead>
                        <TableHead className="text-right">Credit</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {postingPreview.lines?.map((line: any, idx: number) => (
                        <TableRow key={idx}>
                          <TableCell>
                            <span className="font-mono text-sm">{line.account_code}</span>
                            <br />
                            <span className="text-gray-500 text-sm">{line.account_name}</span>
                            {line.entity_name && (
                              <span className="text-blue-600 text-xs block">
                                [{line.entity_type}: {line.entity_name}]
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {line.debit > 0 ? formatCurrency(line.debit) : '-'}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {line.credit > 0 ? formatCurrency(line.credit) : '-'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>

              {/* Confirm Button */}
              <div className="flex justify-end gap-3">
                <Button variant="outline" onClick={() => { setPostingPreview(null); setSelectedPending(null); }}>
                  Cancel
                </Button>
                <Button onClick={handlePostToGL} disabled={postingLoading}>
                  {postingLoading ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                  )}
                  Confirm & Post to GL
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
