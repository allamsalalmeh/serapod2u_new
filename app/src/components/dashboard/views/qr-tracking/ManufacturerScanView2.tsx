'use client'

import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { CheckCircle, AlertTriangle, Loader2, Play, Clock, FileText } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import OrderDocumentsDialogEnhanced from '@/components/dashboard/views/orders/OrderDocumentsDialogEnhanced'

interface UserProfile {
  id: string
  email: string
  role_code: string
  organization_id: string
  signature_url?: string | null
  organizations: {
    id: string
    org_name: string
    org_type_code: string
  }
  roles: {
    role_level: number
  }
}

interface ManufacturerScanView2Props {
  userProfile: UserProfile
}

interface BatchProgress {
  batch_id: string
  batch_code: string
  batch_status?: string
  packing_status?: string
  order_id: string
  order_no: string
  display_doc_no?: string | null
  buyer_org_name: string
  total_master_codes: number
  packed_master_codes: number
  total_unique_codes: number
  packed_unique_codes: number
  master_progress_percentage: number
  unique_progress_percentage: number
}

function CountUp({ value }: { value: number }) {
  const [count, setCount] = useState(value)
  const countRef = useRef(count)

  // Sync ref with state
  useEffect(() => {
    countRef.current = count
  }, [count])

  useEffect(() => {
    const start = countRef.current
    const end = value
    if (start === end) return

    const duration = 1500 // 1.5s animation
    const startTime = Date.now()

    const timer = setInterval(() => {
      const timePassed = Date.now() - startTime
      let progress = timePassed / duration

      if (progress > 1) progress = 1

      // Linear interpolation for "running number" effect
      const current = Math.floor(start + (end - start) * progress)
      setCount(current)

      if (progress === 1) {
        clearInterval(timer)
      }
    }, 20) // 50fps

    return () => clearInterval(timer)
  }, [value])

  return <>{count.toLocaleString()}</>
}

export default function ManufacturerScanView2({ userProfile }: ManufacturerScanView2Props) {
  const [orders, setOrders] = useState<any[]>([])
  const [selectedOrder, setSelectedOrder] = useState<string>('')
  const [currentBatch, setCurrentBatch] = useState<BatchProgress | null>(null)
  const [processing, setProcessing] = useState(false)
  const [progressStep, setProgressStep] = useState<'idle' | 'packing' | 'shipping' | 'notifying' | 'completed'>('idle')
  const [packProgress, setPackProgress] = useState(0)
  const [startTime, setStartTime] = useState<number | null>(null)
  const [elapsedTime, setElapsedTime] = useState<string>('0s')
  const [showDocumentsDialog, setShowDocumentsDialog] = useState(false)
  const { toast } = useToast()
  const supabase = createClient()

  useEffect(() => {
    if (userProfile?.organization_id) {
      fetchOrders()
    }
  }, [userProfile?.organization_id])

  useEffect(() => {
    let interval: NodeJS.Timeout | undefined
    if (processing && startTime) {
      interval = setInterval(() => {
        const seconds = Math.floor((Date.now() - startTime) / 1000)
        const minutes = Math.floor(seconds / 60)
        const remainingSeconds = seconds % 60
        setElapsedTime(`${minutes}m ${remainingSeconds}s`)
      }, 1000)
    }
    return () => {
      if (interval) {
        clearInterval(interval)
      }
    }
  }, [processing, startTime])

  // Auto-trigger worker in development or if stuck
  useEffect(() => {
    let workerInterval: NodeJS.Timeout | undefined
    if (processing && (currentBatch?.packing_status === 'queued' || currentBatch?.packing_status === 'processing')) {
      // Trigger worker every 5 seconds if queued or processing
      // This ensures that even if the cron is not running (local dev), the process continues
      workerInterval = setInterval(async () => {
        try {
          console.log('Triggering packing worker...')
          await fetch('/api/cron/manufacturer-packing-worker')
        } catch (e) {
          console.error('Failed to trigger worker:', e)
        }
      }, 5000)
    }
    return () => {
      if (workerInterval) clearInterval(workerInterval)
    }
  }, [processing, currentBatch?.packing_status])

  const fetchOrders = async () => {
    console.log('Fetching orders for Manufacturer Scan 2...')

    if (!userProfile?.organization_id) {
      console.warn('No organization ID found for user, skipping fetch')
      return
    }

    // Build query - fetch all orders for this manufacturer
    let query = supabase
      .from('orders')
      .select(`
        id,
        order_no,
        display_doc_no,
        status,
        created_at,
        seller_org_id,
        payment_terms,
        buyer_org:organizations!orders_buyer_org_id_fkey(org_name),
        qr_batches(id, status)
      `)
      .eq('seller_org_id', userProfile.organization_id)
      .in('status', ['approved', 'closed'])
      .order('created_at', { ascending: false })

    const { data, error } = await query

    if (error) {
      console.error('Error fetching orders:', JSON.stringify(error, null, 2))
      return
    }

    console.log('Raw orders fetched:', data?.length)

    // For each order, check if it has batches with printed master codes
    const ordersWithPrintedMasters = []

    for (const order of data || []) {
      const batches = order.qr_batches as any
      if (!batches) continue

      const batchList = Array.isArray(batches) ? batches : [batches]
      if (batchList.length === 0) continue

      // Check each batch for printed master codes
      for (const batch of batchList) {
        // Query master codes for this batch with printed status
        const { count: printedCount } = await supabase
          .from('qr_master_codes')
          .select('*', { count: 'exact', head: true })
          .eq('batch_id', batch.id)
          .eq('status', 'printed')

        // If this batch has printed masters, include the order
        if (printedCount && printedCount > 0) {
          ordersWithPrintedMasters.push(order)
          break // Found a valid batch, no need to check other batches for this order
        }
      }
    }

    console.log('Orders with printed master codes:', ordersWithPrintedMasters.length)
    setOrders(ordersWithPrintedMasters)
  }

  const handleOrderSelect = async (orderId: string) => {
    setSelectedOrder(orderId)
    setCurrentBatch(null)
    setProgressStep('idle')
    setProcessing(false)

    const order = orders.find(o => o.id === orderId)
    if (order) {
      const batches = order.qr_batches as any
      const batchList = Array.isArray(batches) ? batches : [batches]

      // Find the best batch to show
      const batch = batchList.find((b: any) =>
        ['generated', 'printed', 'packed', 'processing', 'ready_to_ship'].includes(b.status)
      ) || batchList[0]

      if (batch) {
        await fetchBatchProgress(batch.id, order)
      }
    }
  }

  const fetchBatchProgress = async (batchId: string, order: any) => {
    // Get latest batch status first
    const { data: batchInfo } = await supabase
      .from('qr_batches')
      .select('status, packing_status')
      .eq('id', batchId)
      .single()

    const batchStatus = batchInfo?.status || 'unknown'
    const packingStatus = batchInfo?.packing_status || 'idle'
    const isCompleted = batchStatus === 'completed' || packingStatus === 'completed'

    // Get counts
    const { count: totalMaster } = await supabase
      .from('qr_master_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)

    let packedMaster = 0
    if (isCompleted) {
      packedMaster = totalMaster || 0
    } else {
      const { count } = await supabase
        .from('qr_master_codes')
        .select('*', { count: 'exact', head: true })
        .eq('batch_id', batchId)
        .in('status', ['packed', 'ready_to_ship'])
      packedMaster = count || 0
    }

    const { count: totalUnique } = await supabase
      .from('qr_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)

    let packedUnique = 0
    if (isCompleted) {
      packedUnique = totalUnique || 0
    } else {
      const { count } = await supabase
        .from('qr_codes')
        .select('*', { count: 'exact', head: true })
        .eq('batch_id', batchId)
        .in('status', ['packed', 'ready_to_ship'])
      packedUnique = count || 0
    }

    const batchData: BatchProgress = {
      batch_id: batchId,
      batch_code: `BATCH-${order.display_doc_no || order.order_no}`,
      batch_status: batchStatus,
      packing_status: packingStatus,
      order_id: order.id,
      order_no: order.order_no,
      display_doc_no: order.display_doc_no,
      buyer_org_name: order.buyer_org?.org_name || 'Unknown',
      total_master_codes: totalMaster || 0,
      packed_master_codes: packedMaster,
      total_unique_codes: totalUnique || 0,
      packed_unique_codes: packedUnique,
      master_progress_percentage: totalMaster ? (packedMaster / totalMaster) * 100 : 0,
      unique_progress_percentage: totalUnique ? (packedUnique / totalUnique) * 100 : 0
    }

    setCurrentBatch(batchData)

    // Check if already completed
    if (batchData.batch_status === 'completed') {
      setProgressStep('completed')
    } else if (batchData.packing_status === 'processing' || batchData.packing_status === 'queued') {
      setProgressStep('packing')
      setProcessing(true)
      setStartTime(prev => prev || Date.now())
    } else {
      setProgressStep('idle')
      setProcessing(false)
    }
  }

  const handleCompleteProcess = async () => {
    if (!currentBatch) return

    setProcessing(true)
    setStartTime(Date.now())
    setProgressStep('packing')

    try {
      // Step 1: Start Packing Worker
      const startResponse = await fetch('/api/manufacturer/start-packing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: currentBatch.batch_id })
      })

      if (!startResponse.ok) {
        const errorData = await startResponse.json()
        // If already packing, we can continue to poll
        if (startResponse.status !== 400 && errorData.message !== 'Packing already in progress') {
          throw new Error(errorData.error || 'Failed to start packing')
        }
      }

      // Poll for completion
      let isPacking = true
      let idlePolls = 0
      while (isPacking) {
        await new Promise(resolve => setTimeout(resolve, 2000)) // Poll every 2s

        const order = orders.find(o => o.id === selectedOrder)
        await fetchBatchProgress(currentBatch.batch_id, order)

        const { data: checkBatch } = await supabase
          .from('qr_batches')
          .select('packing_status')
          .eq('id', currentBatch.batch_id)
          .single()

        if (checkBatch?.packing_status === 'completed') {
          isPacking = false
        } else if (checkBatch?.packing_status === 'failed') {
          throw new Error('Packing failed')
        } else if (!checkBatch?.packing_status || checkBatch.packing_status === 'idle') {
          idlePolls += 1
          if (idlePolls >= 5) throw new Error('Packing did not start for this batch. Please try again or contact Serapod.')
        }
      }

      // Step 2: Ready to Ship & Notify (Complete Production)
      setProgressStep('shipping')

      const response = await fetch('/api/manufacturer/complete-production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_id: currentBatch.batch_id
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to complete production')
      }

      const result = await response.json()

      setProgressStep('completed')

      // Calculate balance percentage from order payment terms
      const order = orders.find(o => o.id === selectedOrder)
      const balancePct = order?.payment_terms?.balance_pct || 0.5
      const balancePercentage = Math.round(balancePct * 100)

      // Show success message with balance payment info
      const balanceMessage = result.balance_payment_created
        ? ` Balance payment request (${balancePercentage}%) has been sent to admin for approval.`
        : ''

      toast({
        title: 'Production Complete! 🎉',
        description: `Batch ${currentBatch.batch_code} is now ready for warehouse shipment. ${result.packed_master_codes} of ${result.total_master_codes} cases packed.${balanceMessage}`,
      })

      // Refresh batch data
      await fetchBatchProgress(currentBatch.batch_id, order)

      // Refresh orders list to remove completed ones
      await fetchOrders()

    } catch (error: any) {
      console.error('Process failed:', error)
      toast({
        title: 'Process Failed',
        description: error.message,
        variant: 'destructive'
      })
      setProgressStep('idle')
    } finally {
      setProcessing(false)
      setStartTime(null)
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Manufacturer Scan</h1>
          <p className="text-gray-500 mt-1">Simplified bulk processing for manufacturing</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Select Order to Process</CardTitle>
        </CardHeader>
        <CardContent>
          <select
            className="w-full p-2 border rounded-md"
            value={selectedOrder}
            onChange={(e) => handleOrderSelect(e.target.value)}
            disabled={processing}
          >
            <option value="">Select an order...</option>
            {orders.map((order) => (
              <option key={order.id} value={order.id}>
                {order.display_doc_no || order.order_no} - {order.buyer_org?.org_name} ({new Date(order.created_at).toLocaleDateString()})
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      {currentBatch && (
        <Card>
          <CardHeader>
            <CardTitle className="flex justify-between items-center text-base">
              <span>Batch Progress: {currentBatch.batch_code}</span>
              {processing && (
                <Badge variant="secondary" className="animate-pulse">
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Processing... {elapsedTime}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Status Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-100">
                <p className="text-xs text-blue-600 font-medium">Master Cases</p>
                <p className="text-lg font-bold text-blue-900">
                  <CountUp value={currentBatch.packed_master_codes} /> / {currentBatch.total_master_codes.toLocaleString()}
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <Progress value={currentBatch.master_progress_percentage} className="h-1.5 flex-1" />
                  <span className="text-xs font-medium text-gray-500 whitespace-nowrap">
                    {Math.round(currentBatch.master_progress_percentage)}%
                  </span>
                </div>
              </div>
              <div className="p-4 bg-purple-50 rounded-lg border border-purple-100">
                <p className="text-xs text-purple-600 font-medium">Unique Codes</p>
                <p className="text-lg font-bold text-purple-900">
                  <CountUp value={currentBatch.packed_unique_codes} /> / {currentBatch.total_unique_codes.toLocaleString()}
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <Progress value={currentBatch.unique_progress_percentage} className="h-1.5 flex-1" />
                  <span className="text-xs font-medium text-gray-500 whitespace-nowrap">
                    {Math.round(currentBatch.unique_progress_percentage)}%
                  </span>
                </div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg border border-gray-100 flex flex-col justify-center items-center">
                <p className="text-xs text-gray-600 font-medium mb-2">Current Status</p>
                {progressStep === 'completed' || currentBatch.batch_status === 'completed' ? (
                  <Badge className="bg-green-600 text-sm py-1 px-3">Completed</Badge>
                ) : (
                  <Badge variant="outline" className="text-sm py-1 px-3">{currentBatch.batch_status || 'Pending'}</Badge>
                )}
              </div>
            </div>

            {/* Action Area */}
            <div className="mt-8 border-t pt-6">
              {processing ? (
                <div className="space-y-4">
                  <h3 className="font-semibold text-lg">Processing...</h3>

                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>1. Packing Codes (Printed → Ready to Ship)</span>
                      {progressStep === 'packing' && <Loader2 className="h-4 w-4 animate-spin" />}
                      {(progressStep === 'shipping' || progressStep === 'completed') && <CheckCircle className="h-4 w-4 text-green-600" />}
                    </div>
                    <div className="flex justify-between text-sm">
                      <span>2. Finalizing Batch (Ready to Ship)</span>
                      {progressStep === 'shipping' && <Loader2 className="h-4 w-4 animate-spin" />}
                      {progressStep === 'completed' && <CheckCircle className="h-4 w-4 text-green-600" />}
                    </div>
                    <div className="flex justify-between text-sm">
                      <span>3. Notifying Serapod (Balance Payment)</span>
                      {progressStep === 'completed' && <CheckCircle className="h-4 w-4 text-green-600" />}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  {currentBatch.batch_status !== 'completed' && progressStep !== 'completed' ? (
                    <Button
                      className="w-full md:w-auto bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white shadow-md text-sm py-2 px-4"
                      onClick={handleCompleteProcess}
                    >
                      <Play className="mr-2 h-4 w-4" />
                      Completed Manufacture Process
                    </Button>
                  ) : (
                    <div className="flex flex-col items-center gap-4 w-full">
                      <Alert className="bg-green-50 border-green-200 w-full">
                        <CheckCircle className="h-4 w-4 text-green-600" />
                        <AlertDescription className="text-green-800">
                          This order has been fully processed and is ready for shipment.
                        </AlertDescription>
                      </Alert>

                      <Button
                        variant="outline"
                        className="w-full md:w-auto border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-800"
                        onClick={() => setShowDocumentsDialog(true)}
                      >
                        <FileText className="mr-2 h-4 w-4" />
                        View Balance Request Document
                      </Button>
                    </div>
                  )}

                  <p className="text-sm text-gray-500 max-w-md text-center">
                    This will automatically pack all codes, mark the batch as ready to ship, and notify Serapod for payment.
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {currentBatch && (
        <OrderDocumentsDialogEnhanced
          open={showDocumentsDialog}
          onClose={() => setShowDocumentsDialog(false)}
          orderId={currentBatch.order_id}
          orderNo={currentBatch.order_no}
          displayOrderNo={currentBatch.display_doc_no}
          userProfile={userProfile}
          initialTab="balanceRequest"
        />
      )}
    </div>
  )
}
