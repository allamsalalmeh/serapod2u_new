'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatNumber } from '@/lib/utils/formatters'
import {
  QrCode,
  Download,
  Plus,
  Search,
  Filter,
  RefreshCw,
  FileSpreadsheet,
  CheckCircle,
  Clock,
  AlertCircle,
  Package,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ArrowUpDown
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import SupplyChainPageHeader from '@/modules/supply-chain/components/SupplyChainPageHeader'
import { triggerQRBatchProcessing } from './qrBatchProcessingClient'
import { qrCaseTotals } from '@/lib/orders/qr-buffer'

/** Upper bound on processing calls per batch from one click; the cron keeps going after that. */
const MAX_WORKER_RUNS = 120

interface UserProfile {
  id: string
  email: string
  role_code: string
  organization_id: string
  organizations: {
    id: string
    org_name: string
    org_type_code: string
  }
  roles: {
    role_name: string
  }
}

interface QRBatchesViewProps {
  userProfile: UserProfile
  onViewChange: (view: string) => void
}

export default function QRBatchesView({ userProfile, onViewChange }: QRBatchesViewProps) {
  const [batches, setBatches] = useState<any[]>([])
  const [approvedOrders, setApprovedOrders] = useState<any[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState<string | null>(null)
  const generatingRef = useRef(false)
  const [workerRunning, setWorkerRunning] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  // Pagination & Sorting
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null)
  const [customPageSize, setCustomPageSize] = useState('')

  const { toast } = useToast()
  const supabase = createClient()

  useEffect(() => {
    loadBatches()
    loadApprovedOrders()
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll for updates when batches are processing
  useEffect(() => {
    const hasActiveBatches = batches.some(b => ['queued', 'processing'].includes(b.status))

    if (hasActiveBatches) {
      const intervalId = setInterval(() => {
        loadBatches(true)
      }, 2000) // Poll every 2 seconds

      return () => clearInterval(intervalId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches])

  const loadApprovedOrders = async () => {
    try {
      // Get approved H2M orders for this manufacturer
      const { data, error } = await supabase
        .from('orders')
        .select(`
          id,
          order_no,
          display_doc_no,
          order_type,
          status,
          qr_buffer_percent,
          approved_at,
          created_at,
          order_items:order_items(id, qty),
          qr_batches:qr_batches(id, excel_file_url, status)
        `)
        .eq('order_type', 'H2M')
        .in('status', ['approved', 'closed'])
        .eq('seller_org_id', userProfile.organization_id)
        .order('approved_at', { ascending: false })

      if (error) throw error

      console.log('✅ Approved Orders loaded:', data)
      console.log('📊 Total approved orders:', data?.length || 0)
      console.log('🆕 Orders without batches:', data?.filter(o => !o.qr_batches).length || 0)
      setApprovedOrders(data || [])
    } catch (error: any) {
      console.error('Error loading approved orders:', error)
      toast({
        title: 'Error',
        description: 'Failed to load approved orders',
        variant: 'destructive'
      })
    }
  }

  const loadBatches = async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      const { data, error } = await supabase
        .from('qr_batches')
        .select(`
          *,
          orders!inner (
            order_no,
            display_doc_no,
            status,
            order_type,
            seller_org_id
          )
        `)
        .eq('orders.seller_org_id', userProfile.organization_id)
        .order('created_at', { ascending: false })

      if (error) throw error

      // Fetch packed counts for each batch
      // Progress counts master codes that are packed or beyond (warehouse_packed, ready_to_ship, completed, received_warehouse, shipped_distributor, opened)
      const batchesWithProgress = await Promise.all(
        (data || []).map(async (batch) => {
          // Use head:true to get count without fetching data (more efficient for large batches)
          const { count: packedCount } = await supabase
            .from('qr_master_codes')
            .select('*', { count: 'exact', head: true })
            .eq('batch_id', batch.id)
            .in('status', ['packed', 'warehouse_packed', 'ready_to_ship', 'completed', 'received_warehouse', 'shipped_distributor', 'opened'])

          const totalCount = batch.total_master_codes || 0
          const progressPercentage = totalCount > 0 ? Math.round(((packedCount || 0) / totalCount) * 100) : 0

          return {
            ...batch,
            packed_master_codes: packedCount || 0,
            progress_percentage: progressPercentage
          }
        })
      )

      setBatches(batchesWithProgress)
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive'
      })
    } finally {
      if (!silent) setLoading(false)
    }
  }

  /**
   * Fast path / debug fallback: process specific batches this organization
   * owns via /api/qr-batches/process. The scheduled cron processes queued
   * batches on its own; this only saves waiting for the next tick.
   */
  const runWorker = async (batchIds: string[], showToast = true) => {
    if (workerRunning) return

    if (batchIds.length === 0) {
      if (showToast) {
        toast({ title: 'Worker Idle', description: 'No queued batches found to process.' })
      }
      return
    }

    try {
      setWorkerRunning(true)
      if (showToast) {
        toast({
          title: 'Starting Worker',
          description: 'Processing queued batch...'
        })
      }

      let finished = 0
      for (const batchId of batchIds) {
        for (let runCount = 1; runCount <= MAX_WORKER_RUNS; runCount++) {
          // Throws on any non-2xx response (401/403/404/409/500/503) with the server's message.
          const outcome = await triggerQRBatchProcessing(batchId)
          await loadBatches(true)

          if (outcome === 'complete' || outcome === 'idle') {
            finished++
            break
          }

          // 'progress' yielded with work left; 'busy' means another run (usually the cron) holds the lease.
          await new Promise(resolve => setTimeout(resolve, outcome === 'busy' ? 3000 : 1000))
        }
      }

      if (showToast) {
        toast(finished === batchIds.length
          ? { title: 'Worker Run Complete', description: 'Batch processing completed.' }
          : { title: 'Still Processing', description: 'The batch is still being generated in the background. Refresh to check progress.' })
      }
    } catch (error: any) {
      console.error('Worker trigger error:', error)
      toast({
        title: 'Worker Error',
        description: `${error?.message || 'Failed to process the QR batch.'} The batch stays in the queue for the scheduled worker; use Run Worker to retry.`,
        variant: 'destructive'
      })
      await loadBatches(true)
    } finally {
      setWorkerRunning(false)
    }
  }

  const handleTriggerWorker = () =>
    runWorker(batches.filter(b => ['queued', 'processing'].includes(b.status)).map(b => b.id), true)

  const handleOrderSelect = (orderId: string) => {
    setSelectedOrderId(orderId)
  }

  const handleGenerateBatchForSelectedOrder = async () => {
    if (!selectedOrderId) {
      toast({
        title: 'Error',
        description: 'Please select an order first',
        variant: 'destructive'
      })
      return
    }

    const queued = await handleGenerateBatch(selectedOrderId)
    // Keep the order selected when generation failed so it can be retried.
    if (queued) setSelectedOrderId('')
  }

  /** Queue (or resume) the order's batch. Resolves true once a batch exists. */
  const handleGenerateBatch = async (orderId: string): Promise<boolean> => {
    // Ignore repeat clicks while a request is in flight (the server is also
    // idempotent per order, this just avoids the extra round trip).
    if (generatingRef.current) return false
    generatingRef.current = true
    try {
      setGenerating(orderId)
      const response = await fetch('/api/qr-batches/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId })
      })

      const result = await response.json().catch(() => ({} as any))
      if (!response.ok) {
        const reason = result?.error || `Failed to generate QR batch (HTTP ${response.status})`
        throw new Error(result?.details && result.details !== reason ? `${reason} (${result.details})` : reason)
      }

      toast({
        title: result.existing ? 'Batch Already Exists' : 'Success',
        description: result.message || 'Batch queued for generation'
      })

      await loadBatches()
      await loadApprovedOrders() // Refresh approved orders list

      // Process this batch right away instead of waiting for the next cron tick.
      const queuedBatchId = result.batch_id || result.batch?.id
      if (queuedBatchId && ['queued', 'processing'].includes(result.status || result.batch?.status || 'queued')) {
        runWorker([queuedBatchId], true)
      }
      return true
    } catch (error: any) {
      toast({
        title: 'QR batch not generated',
        description: `${error?.message || 'Failed to generate QR batch'}. The order is still selected; you can try again.`,
        variant: 'destructive'
      })
      // A partial attempt may have created a batch; refresh so the lists show it.
      await Promise.all([loadBatches(true), loadApprovedOrders()])
      return false
    } finally {
      generatingRef.current = false
      setGenerating(null)
    }
  }

  const handleRefresh = async () => {
    await Promise.all([loadBatches(), loadApprovedOrders()])
  }

  const handleDownloadExcel = async (batch: any) => {
    try {
      if (!batch.excel_file_url) {
        toast({
          title: 'Error',
          description: 'Excel file not available',
          variant: 'destructive'
        })
        return
      }

      const response = await fetch('/api/qr-batches/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: batch.id })
      })

      const payload = await response.json()

      if (!response.ok || !payload?.url) {
        throw new Error(payload?.error || 'Failed to prepare download link')
      }

      // Use direct window.open for better Vercel/production compatibility
      // Signed URLs from Supabase include Content-Disposition header for download
      const downloadUrl = payload.url as string

      // Open in new window/tab - browser will handle download automatically
      // This works better on Vercel than anchor.click()
      const downloadWindow = window.open(downloadUrl, '_blank')

      // Fallback: if popup blocked, try anchor method
      if (!downloadWindow) {
        const anchor = document.createElement('a')
        anchor.href = downloadUrl
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer'
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
      }

      // Check status again to ensure it hasn't changed
      const { data: currentBatch } = await supabase
        .from('qr_batches')
        .select('status')
        .eq('id', batch.id)
        .single()

      if (currentBatch?.status !== 'generated') {
        console.warn('Batch status changed, skipping update:', currentBatch?.status)
        return
      }

      // Update batch status to 'printing' after download
      // AND update all QR codes (master + unique) to 'printed' status
      if (batch.status === 'generated') {
        console.log('🔄 Updating batch status via RPC...')

        // Use RPC function to update everything in chunks
        // This handles large datasets efficiently with internal batching
        const { data: rpcData, error: rpcError } = await supabase.rpc('mark_batch_as_printed', {
          p_batch_id: batch.id
        })

        if (rpcError) {
          console.error('Failed to update batch status via RPC:', {
            message: rpcError.message,
            code: rpcError.code,
            details: rpcError.details,
            hint: rpcError.hint
          })

          // Fallback to client-side chunked updates if RPC fails
          console.warn('⚠️ Falling back to client-side chunked updates...')

          // Update batch status first (fast operation)
          const { error: updateError } = await supabase
            .from('qr_batches')
            .update({
              status: 'printing',
              updated_at: new Date().toISOString()
            })
            .eq('id', batch.id)

          if (updateError) {
            console.error('Fallback: Failed to update batch:', updateError)
          } else {
            console.log('✅ Batch status updated')
          }

          // Update master codes (typically small number, can do in one go)
          const { error: masterError } = await supabase
            .from('qr_master_codes')
            .update({
              status: 'printed',
              updated_at: new Date().toISOString()
            })
            .eq('batch_id', batch.id)
            .eq('status', 'generated')

          if (masterError) {
            console.error('Fallback: Failed to update master codes:', masterError)
          } else {
            console.log('✅ Master codes updated')
          }

          // Update unique codes with optimized chunking
          if (batch.total_unique_codes > 0) {
            const CHUNK_SIZE = 500 // Update 500 codes at a time (safe batch size)
            let totalUpdated = 0
            let chunkIndex = 0

            console.log(`Fallback: Updating ${batch.total_unique_codes} unique codes in chunks of ${CHUNK_SIZE}...`)

            // Use limit-offset pagination for reliable chunking
            while (true) {
              const offset = chunkIndex * CHUNK_SIZE

              // First, get the IDs of codes to update in this chunk
              const { data: codesToUpdate, error: fetchError } = await supabase
                .from('qr_codes')
                .select('id')
                .eq('batch_id', batch.id)
                .eq('status', 'generated')
                .range(offset, offset + CHUNK_SIZE - 1)

              if (fetchError) {
                console.error(`Fallback: Failed to fetch chunk ${chunkIndex + 1}:`, fetchError)
                break
              }

              if (!codesToUpdate || codesToUpdate.length === 0) {
                console.log(`✅ All unique codes updated (${totalUpdated} total)`)
                break
              }

              // Update this chunk by IDs
              const { error: chunkError, count } = await supabase
                .from('qr_codes')
                .update({
                  status: 'printed',
                  updated_at: new Date().toISOString()
                })
                .in('id', codesToUpdate.map(c => c.id))
                .eq('status', 'generated') // Double-check status to avoid race conditions

              if (chunkError) {
                console.error(`Fallback: Failed to update chunk ${chunkIndex + 1} (offset ${offset}):`, chunkError)
                // Continue with next chunk despite error
              } else {
                totalUpdated += codesToUpdate.length
                console.log(`Chunk ${chunkIndex + 1}: Updated ${codesToUpdate.length} codes (${totalUpdated}/${batch.total_unique_codes})`)
              }

              chunkIndex++

              // Safety limit: max 1000 chunks (500k codes)
              if (chunkIndex >= 1000) {
                console.warn('Reached maximum chunk limit, stopping updates')
                break
              }
            }
          }
        } else {
          // RPC succeeded, check the response
          if (rpcData?.success) {
            console.log('✅ Batch and codes updated via RPC:', {
              batchUpdated: rpcData.batch_updated,
              masterCodes: rpcData.master_codes_updated,
              uniqueCodes: rpcData.unique_codes_updated
            })
          } else if (rpcData?.error) {
            console.error('RPC returned error:', rpcData.error)
            console.warn('Partial update occurred:', {
              batchUpdated: rpcData.batch_updated,
              masterCodes: rpcData.master_codes_updated,
              uniqueCodes: rpcData.unique_codes_updated
            })
          } else {
            console.log('✅ Batch and codes updated to "printed" via RPC')
          }
        }

        await loadBatches() // Refresh the batches list
      }

      toast({
        title: 'Download Started',
        description: 'Your Excel file is downloading. Please check your browser downloads.'
      })
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive'
      })
    }
  }

  // Get orders that need QR batch generation
  const ordersNeedingBatch = useMemo(() => {
    return approvedOrders.filter(order => {
      // Check if qr_batches is null/undefined OR empty array
      if (!order.qr_batches) return true
      if (Array.isArray(order.qr_batches) && order.qr_batches.length === 0) return true
      // A batch that failed can be retried from here (the API re-queues it).
      if (Array.isArray(order.qr_batches) && order.qr_batches.every((b: any) => b?.status === 'failed')) return true
      return false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvedOrders])

  const getDuration = (batch: any) => {
    if (!batch.processing_started_at || !batch.processing_finished_at) return null

    const start = new Date(batch.processing_started_at).getTime()
    const end = new Date(batch.processing_finished_at).getTime()
    const diff = end - start

    if (diff < 0) return null

    const minutes = Math.floor(diff / 60000)
    const seconds = Math.floor((diff % 60000) / 1000)

    if (minutes === 0) return `${seconds}s`
    return `${minutes}m ${seconds}s`
  }

  const getStatusBadge = (status: string) => {
    const statusConfig: any = {
      queued: { label: 'Queued', variant: 'secondary', icon: Clock },
      processing: { label: 'Processing', variant: 'default', icon: RefreshCw, className: 'animate-spin' },
      failed: { label: 'Failed', variant: 'destructive', icon: AlertCircle },
      pending: { label: 'Pending', variant: 'secondary', icon: Clock },
      generated: { label: 'Generated', variant: 'default', icon: CheckCircle },
      printing: { label: 'Printing', variant: 'default', icon: Clock },
      in_production: { label: 'In Production', variant: 'default', icon: Clock },
      completed: { label: 'Completed', variant: 'default', icon: CheckCircle }
    }

    const config = statusConfig[status] || statusConfig.pending
    const Icon = config.icon

    return (
      <Badge variant={config.variant} className="flex items-center gap-1">
        <Icon className={`h-3 w-3 ${config.className || ''}`} />
        {config.label}
      </Badge>
    )
  }

  const filteredBatches = useMemo(() => {
    let result = batches.filter(batch => {
      const matchesSearch = !searchTerm ||
        batch.orders?.order_no?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        batch.orders?.display_doc_no?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        batch.id.toLowerCase().includes(searchTerm.toLowerCase())

      const matchesStatus = statusFilter === 'all' || batch.status === statusFilter

      return matchesSearch && matchesStatus
    })

    // Sorting
    if (sortConfig) {
      result.sort((a, b) => {
        let aValue: any = ''
        let bValue: any = ''

        switch (sortConfig.key) {
          case 'order_no':
            aValue = a.orders?.display_doc_no || a.orders?.order_no || ''
            bValue = b.orders?.display_doc_no || b.orders?.order_no || ''
            break
          case 'progress':
            // Calculate progress
            const aTotal = a.total_unique_codes || 0
            const aGenerated = a.qr_codes?.length || 0 // This might be inaccurate if not loaded, but using what we have
            // Better to use status for progress approximation if counts aren't available
            aValue = a.status === 'completed' ? 100 : 0
            bValue = b.status === 'completed' ? 100 : 0
            break
          case 'master_codes':
            aValue = a.total_master_codes || 0
            bValue = b.total_master_codes || 0
            break
          case 'unique_codes':
            aValue = a.total_unique_codes || 0
            bValue = b.total_unique_codes || 0
            break
          case 'status':
            aValue = a.status || ''
            bValue = b.status || ''
            break
          case 'date':
            aValue = new Date(a.created_at).getTime()
            bValue = new Date(b.created_at).getTime()
            break
          default:
            break
        }

        if (aValue < bValue) return sortConfig.direction === 'asc' ? -1 : 1
        if (aValue > bValue) return sortConfig.direction === 'asc' ? 1 : -1
        return 0
      })
    } else {
      // Default sort by date desc
      result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    }

    return result
  }, [batches, searchTerm, statusFilter, sortConfig])

  // Pagination
  const paginatedBatches = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize
    return filteredBatches.slice(startIndex, startIndex + pageSize)
  }, [filteredBatches, currentPage, pageSize])

  const totalPages = Math.ceil(filteredBatches.length / pageSize)

  const handleSort = (key: string) => {
    setSortConfig(current => {
      if (current?.key === key) {
        return current.direction === 'asc'
          ? { key, direction: 'desc' }
          : null
      }
      return { key, direction: 'asc' }
    })
  }

  const handlePageSizeChange = (value: string) => {
    if (value === 'custom') {
      // Focus custom input?
      return
    }
    setPageSize(Number(value))
    setCurrentPage(1)
  }

  const handleCustomPageSizeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setCustomPageSize(val)
    if (val && !isNaN(Number(val)) && Number(val) > 0) {
      setPageSize(Number(val))
      setCurrentPage(1)
    }
  }



  return (
    <div className="sera-sc-page">
      <SupplyChainPageHeader
        title="QR Code Batches"
        description="Manage QR code generation for approved H2M orders"
        actions={
          <>
            <Button
              onClick={handleTriggerWorker}
              disabled={workerRunning}
              variant="secondary"
              className="bg-[var(--sera-mist)] hover:bg-[var(--sera-line)] text-[var(--sera-ink-soft)]"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${workerRunning ? 'animate-spin' : ''}`} />
              {workerRunning ? 'Running...' : 'Run Worker (Debug)'}
            </Button>
            <Button onClick={handleRefresh} variant="outline" className="border-[var(--sera-line)]">
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </>
        }
      />

      {/* Filters */}
      <Card className="sera-sc-panel shadow-none">
        <CardContent className="pt-6">
          <div className="flex gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[var(--sera-muted)] h-4 w-4" />
              <input
                type="text"
                placeholder="Search by order number or batch ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="sera-sc-select pl-10"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="sera-sc-select w-auto min-w-[160px]"
            >
              <option value="all">All Status</option>
              <option value="pending">Pending</option>
              <option value="generated">Generated</option>
              <option value="printing">Printing</option>
              <option value="in_production">In Production</option>
              <option value="completed">Completed</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {/* Approved Orders Section - NEW */}
      {ordersNeedingBatch.length > 0 && (
        <Card className="border-[var(--sera-orange)]/25 bg-[var(--sera-orange)]/[0.04] shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-[var(--sera-ink)]">
              <Package className="h-5 w-5 text-[var(--sera-orange)]" strokeWidth={1.75} />
              Orders Ready for QR Generation
            </CardTitle>
            <CardDescription className="text-[var(--sera-muted)]">
              Select an approved or closed H2M order to generate QR codes and download Excel
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-4 items-stretch sm:items-end">
              <div className="flex-1">
                <label className="text-sm font-medium text-[var(--sera-ink-soft)] mb-2 block">
                  Select Order
                </label>
                <Select value={selectedOrderId} onValueChange={handleOrderSelect}>
                  <SelectTrigger className="bg-white border-[var(--sera-line)]">
                    <SelectValue placeholder="Choose an approved order..." />
                  </SelectTrigger>
                  <SelectContent>
                    {ordersNeedingBatch
                      .map((order) => {
                        const totalItems = order.order_items?.length || 0
                        const totalQuantity = order.order_items?.reduce((sum: number, item: any) => sum + (item.qty || 0), 0) || 0
                        // Cases, not pieces: one unique QR per case, plus the buffer cases.
                        const { uniqueCaseQr: qrCodes } = qrCaseTotals(totalQuantity, order.qr_buffer_percent)
                        const displayOrderNo = order.display_doc_no || order.order_no

                        return (
                          <SelectItem key={order.id} value={order.id}>
                            <div className="flex flex-col">
                              <span className="font-medium">{displayOrderNo}</span>
                              <span className="text-xs text-[var(--sera-muted)]">
                                {totalItems} items • {totalQuantity.toLocaleString()} {totalQuantity === 1 ? 'Case' : 'Cases'} • {qrCodes.toLocaleString()} unique case QR codes
                              </span>
                            </div>
                          </SelectItem>
                        )
                      })}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleGenerateBatchForSelectedOrder}
                disabled={!selectedOrderId || generating !== null}
                className="bg-[var(--sera-ink)] text-white hover:bg-[var(--sera-ink-soft)] whitespace-nowrap"
              >
                {generating === selectedOrderId ? (
                  <>
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <QrCode className="h-4 w-4 mr-2" />
                    Generate QR Batch & Excel
                  </>
                )}
              </Button>
            </div>

            {/* Order Details Preview */}
            {selectedOrderId && (() => {
              const selectedOrder = approvedOrders.find(o => o.id === selectedOrderId)
              if (!selectedOrder) return null

              const totalItems = selectedOrder.order_items?.length || 0
              const totalQuantity = selectedOrder.order_items?.reduce((sum: number, item: any) => sum + (item.qty || 0), 0) || 0
              // Quantities are cases: one unique QR per case (never × pcs per
              // case) plus the manufacturer buffer cases, rounded as QR
              // generation rounds them. Master (box) QR codes are separate.
              const {
                bufferPercent,
                bufferCases: bufferQty,
                uniqueCaseQr: qrCodes,
              } = qrCaseTotals(totalQuantity, selectedOrder.qr_buffer_percent)
              const displayOrderNo = selectedOrder.display_doc_no || selectedOrder.order_no

              return (
                <div className="bg-white p-4 rounded-lg border border-blue-200">
                  <h4 className="font-medium text-gray-900 mb-3">Order Details</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 text-sm">
                    <div>
                      <p className="text-gray-600 text-xs sm:text-sm">Order Number</p>
                      <p className="font-medium text-gray-900 truncate">{displayOrderNo}</p>
                    </div>
                    <div>
                      <p className="text-gray-600 text-xs sm:text-sm">Total Items</p>
                      <p className="font-medium text-gray-900">{totalItems} products</p>
                    </div>
                    <div>
                      <p className="text-gray-600 text-xs sm:text-sm">Ordered Cases</p>
                      <p className="font-medium text-gray-900">{totalQuantity.toLocaleString()} {totalQuantity === 1 ? 'Case' : 'Cases'}</p>
                    </div>
                    <div>
                      <p className="text-gray-600 text-xs sm:text-sm">Unique Case QR Codes</p>
                      <p className="font-medium text-blue-600 text-xs sm:text-sm">
                        {qrCodes.toLocaleString()} ({totalQuantity.toLocaleString()} ordered + {bufferQty.toLocaleString()} buffer {bufferQty === 1 ? 'case' : 'cases'}, {bufferPercent}%)
                      </p>
                    </div>
                  </div>
                </div>
              )
            })()}
          </CardContent>
        </Card>
      )}

      {/* Statistics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Card>
          <CardContent className="pt-3 sm:pt-4 lg:pt-6 px-3 sm:px-4 lg:px-6 pb-3 sm:pb-4 lg:pb-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs sm:text-sm text-gray-600">Total Batches</p>
                <p className="text-lg sm:text-xl lg:text-2xl font-bold text-gray-900">{batches.length}</p>
              </div>
              <QrCode className="h-6 w-6 sm:h-8 sm:w-8 text-blue-600" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 sm:pt-4 lg:pt-6 px-3 sm:px-4 lg:px-6 pb-3 sm:pb-4 lg:pb-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs sm:text-sm text-gray-600">Generated</p>
                <p className="text-lg sm:text-xl lg:text-2xl font-bold text-green-600">
                  {batches.filter(b => ['generated', 'printing'].includes(b.status)).length}
                </p>
              </div>
              <CheckCircle className="h-6 w-6 sm:h-8 sm:w-8 text-green-600" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 sm:pt-4 lg:pt-6 px-3 sm:px-4 lg:px-6 pb-3 sm:pb-4 lg:pb-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs sm:text-sm text-gray-600">In Progress</p>
                <p className="text-lg sm:text-xl lg:text-2xl font-bold text-orange-600">
                  {batches.filter(b => b.status === 'in_production').length}
                </p>
              </div>
              <Clock className="h-6 w-6 sm:h-8 sm:w-8 text-orange-600" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-3 sm:pt-4 lg:pt-6 px-3 sm:px-4 lg:px-6 pb-3 sm:pb-4 lg:pb-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs sm:text-sm text-gray-600">Completed</p>
                <p className="text-lg sm:text-xl lg:text-2xl font-bold text-blue-600">
                  {batches.filter(b => b.status === 'completed').length}
                </p>
              </div>
              <CheckCircle className="h-6 w-6 sm:h-8 sm:w-8 text-blue-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Batches List */}
      <Card>
        <CardHeader>
          <CardTitle>QR Batches</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-8 w-8 animate-spin text-blue-600" />
            </div>
          ) : filteredBatches.length === 0 ? (
            <div className="text-center py-12">
              <QrCode className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">No QR batches found</p>
              <p className="text-sm text-gray-500 mt-1">
                Approve H2M orders to generate QR codes
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">No.</th>
                    <th
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('order_no')}
                    >
                      <div className="flex items-center gap-1">
                        Order No
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('progress')}
                    >
                      <div className="flex items-center gap-1">
                        Progress
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('master_codes')}
                    >
                      <div className="flex items-center gap-1">
                        Master Codes
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('unique_codes')}
                    >
                      <div className="flex items-center gap-1">
                        Unique Codes
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('status')}
                    >
                      <div className="flex items-center gap-1">
                        Status
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th
                      className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:bg-gray-100"
                      onClick={() => handleSort('date')}
                    >
                      <div className="flex items-center gap-1">
                        Date
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {paginatedBatches.map((batch, index) => {
                    const progress = batch.status === 'completed' ? 100 :
                      batch.status === 'generated' ? 100 : 0

                    return (
                      <tr key={batch.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {(currentPage - 1) * pageSize + index + 1}
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          <button
                            className="hover:underline text-blue-600 hover:text-blue-800 transition-colors"
                            onClick={() => {
                              if (batch.order_id) {
                                sessionStorage.setItem('viewOrderId', batch.order_id)
                                onViewChange('view-order')
                              }
                            }}
                          >
                            {batch.orders?.display_doc_no || batch.orders?.order_no || 'N/A'}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="relative w-12 h-12">
                              <svg className="w-12 h-12 transform -rotate-90">
                                <circle
                                  cx="24"
                                  cy="24"
                                  r="20"
                                  stroke="#E5E7EB"
                                  strokeWidth="4"
                                  fill="none"
                                />
                                <circle
                                  cx="24"
                                  cy="24"
                                  r="20"
                                  stroke={batch.progress_percentage === 100 ? '#10B981' : '#3B82F6'}
                                  strokeWidth="4"
                                  fill="none"
                                  strokeDasharray={`${2 * Math.PI * 20}`}
                                  strokeDashoffset={`${2 * Math.PI * 20 * (1 - batch.progress_percentage / 100)}`}
                                  strokeLinecap="round"
                                />
                              </svg>
                              <div className="absolute inset-0 flex items-center justify-center">
                                <span className="text-xs font-semibold text-gray-700">
                                  {batch.progress_percentage}%
                                </span>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {formatNumber(batch.total_master_codes)}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {formatNumber(batch.total_unique_codes)}
                        </td>
                        <td className="px-4 py-3">
                          {batch.status === 'processing' || batch.status === 'queued' ? (
                            <div className="flex flex-col gap-1 min-w-[120px]">
                              <div className="flex items-center justify-between text-xs text-gray-500">
                                <span>{batch.status === 'queued' ? 'Queued' : 'Generating...'}</span>
                                <span>{batch.total_unique_codes > 0 ? Math.round(((batch.qr_inserted_count || 0) / batch.total_unique_codes) * 100) : 0}%</span>
                              </div>
                              <div className="w-full bg-gray-200 rounded-full h-1.5">
                                <div
                                  className="bg-blue-600 h-1.5 rounded-full transition-all duration-500"
                                  style={{ width: `${batch.total_unique_codes > 0 ? Math.round(((batch.qr_inserted_count || 0) / batch.total_unique_codes) * 100) : 0}%` }}
                                />
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-col items-start gap-1">
                              {getStatusBadge(batch.status)}
                              {batch.status === 'completed' && getDuration(batch) && (
                                <span className="text-[10px] text-blue-600 font-medium px-2">
                                  {getDuration(batch)}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {new Date(batch.excel_generated_at || batch.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-right space-x-2">
                          {batch.excel_file_url && batch.status !== 'processing' && batch.status !== 'queued' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleDownloadExcel(batch)}
                            >
                              <Download className="h-4 w-4 mr-1" />
                              Excel
                            </Button>
                          )}
                          {(batch.status === 'pending' || batch.status === 'failed') && (
                            <Button
                              size="sm"
                              onClick={() => handleGenerateBatch(batch.order_id)}
                              disabled={generating === batch.order_id}
                            >
                              {generating === batch.order_id ? (
                                <>
                                  <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
                                  Generating...
                                </>
                              ) : (
                                <>
                                  <QrCode className="h-4 w-4 mr-1" />
                                  {batch.status === 'failed' ? 'Retry' : 'Generate'}
                                </>
                              )}
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination Controls */}
          {filteredBatches.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-700">
                  Showing {(currentPage - 1) * pageSize + 1} to {Math.min(currentPage * pageSize, filteredBatches.length)} of {filteredBatches.length} entries
                </span>
                <Select
                  value={pageSize.toString()}
                  onValueChange={handlePageSizeChange}
                >
                  <SelectTrigger className="w-[100px] h-8">
                    <SelectValue placeholder="20" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="20">20</SelectItem>
                    <SelectItem value="30">30</SelectItem>
                    <SelectItem value="50">50</SelectItem>
                    <SelectItem value="100">100</SelectItem>
                    <SelectItem value="200">200</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-500">Custom:</span>
                  <input
                    type="number"
                    value={customPageSize}
                    onChange={handleCustomPageSizeChange}
                    className="w-16 h-8 px-2 border border-gray-300 rounded text-sm"
                    placeholder="Size"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-gray-700">
                  Page {currentPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
