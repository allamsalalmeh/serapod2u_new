'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/use-toast'
import PaymentProofUpload from '@/components/documents/PaymentProofUpload'
import { d2hPaymentErrorMessage, d2hPaymentStatus, type D2HPaymentSummary } from '@/lib/orders/d2h-payments'

interface DocLike {
  id: string
  doc_no: string
  display_doc_no?: string | null
  status: string
  created_at: string
  payload?: any
}

interface D2HPaymentsPanelProps {
  orderId: string
  companyId: string
  invoiceId: string | null
  payments: DocLike[]
  receipts: DocLike[]
  /** Reload the dialog after a change. */
  onChanged: () => void
}

const rm = (n: number | null | undefined) =>
  `RM ${(Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * D2H payments of one order: paid / verified by Finance / outstanding, every payment and
 * receipt, the amount of the pending payment, and "Record another payment".
 */
export default function D2HPaymentsPanel({ orderId, companyId, invoiceId, payments, receipts, onChanged }: D2HPaymentsPanelProps) {
  const supabase = createClient()
  const [summary, setSummary] = useState<D2HPaymentSummary | null>(null)
  const [pendingAmount, setPendingAmount] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [newProofUrl, setNewProofUrl] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await (supabase as any).rpc('d2h_order_payment_summary', { p_order_id: orderId })
    if (!error && data) {
      setSummary(data as D2HPaymentSummary)
      setPendingAmount(data.pending_amount != null ? String(data.pending_amount) : String(data.outstanding ?? ''))
      setNewAmount(String(data.outstanding ?? ''))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  useEffect(() => { load() }, [load, payments.length, receipts.length])

  if (!summary) return null
  const status = d2hPaymentStatus(summary)

  const savePendingAmount = async () => {
    setBusy(true)
    const { error } = await (supabase as any).rpc('d2h_set_pending_payment_amount', {
      p_order_id: orderId,
      p_amount: Number(pendingAmount),
    })
    setBusy(false)
    if (error) {
      toast({ title: 'Amount not saved', description: d2hPaymentErrorMessage(error), variant: 'destructive' })
      return
    }
    toast({ title: 'Payment amount saved' })
    await load()
    onChanged()
  }

  const recordNext = async () => {
    setBusy(true)
    const { error } = await (supabase as any).rpc('d2h_record_next_payment', {
      p_order_id: orderId,
      p_amount: Number(newAmount),
      p_payment_proof_url: newProofUrl,
    })
    setBusy(false)
    if (error) {
      toast({ title: 'Payment not recorded', description: d2hPaymentErrorMessage(error), variant: 'destructive' })
      return
    }
    toast({ title: 'Payment recorded', description: 'HQ acknowledges it next; Finance then verifies the money received.' })
    setRecording(false)
    setNewProofUrl(null)
    await load()
    onChanged()
  }

  const receiptFor = (paymentId: string) => receipts.find((r) => r.payload?.payment_id === paymentId)

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-blue-900">Payments</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status.tone}`}>{status.label}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div><div className="text-xs text-gray-500">Order total</div><div className="font-mono">{rm(summary.order_total)}</div></div>
        <div><div className="text-xs text-gray-500">Paid (acknowledged)</div><div className="font-mono">{rm(summary.paid)}</div></div>
        <div><div className="text-xs text-gray-500">Verified by Finance</div><div className="font-mono">{rm(summary.verified)}</div></div>
        <div><div className="text-xs text-gray-500">Outstanding</div><div className="font-mono font-semibold">{rm(summary.outstanding)}</div></div>
      </div>

      {payments.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 font-normal">Payment</th>
              <th className="py-1 font-normal">Status</th>
              <th className="py-1 text-right font-normal">Amount</th>
              <th className="py-1 font-normal pl-3">Receipt</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => {
              const r = receiptFor(p.id)
              const amount = r ? r.payload?.payment_amount : p.payload?.amount
              return (
                <tr key={p.id} className="border-t border-blue-100">
                  <td className="py-1 font-mono">{p.display_doc_no || p.doc_no}</td>
                  <td className="py-1 capitalize">{p.status}</td>
                  <td className="py-1 text-right font-mono">{amount != null ? rm(amount) : '—'}</td>
                  <td className="py-1 pl-3 font-mono">{r ? (r.display_doc_no || r.doc_no) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {summary.pending_payment_id && summary.can_record && (
        <div className="flex flex-wrap items-end gap-2 border-t border-blue-100 pt-3">
          <div>
            <label htmlFor="pending-payment-amount" className="block text-xs font-medium">
              Amount paid on {summary.pending_payment_no} (RM)
            </label>
            <Input
              id="pending-payment-amount"
              type="number"
              min="0.01"
              step="0.01"
              max={summary.outstanding}
              value={pendingAmount}
              onChange={(e) => setPendingAmount(e.target.value)}
              className="h-8 w-40"
            />
          </div>
          <Button size="sm" variant="outline" onClick={savePendingAmount} disabled={busy || !(Number(pendingAmount) > 0)}>
            {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Save amount
          </Button>
          <p className="w-full text-xs text-gray-500">
            {summary.pending_amount == null
              ? 'Not stated yet: if left empty, the expected amount is used when HQ acknowledges.'
              : 'HQ acknowledges this amount; the receipt is issued for it.'}
          </p>
        </div>
      )}

      {summary.can_record && !summary.pending_payment_id && summary.invoice_acknowledged && summary.outstanding > 0 && (
        <div className="border-t border-blue-100 pt-3 space-y-2">
          {!recording ? (
            <Button size="sm" onClick={() => setRecording(true)}>
              <Plus className="mr-1 h-3 w-3" /> Record another payment
            </Button>
          ) : (
            <>
              <div>
                <label htmlFor="next-payment-amount" className="block text-xs font-medium">Amount paid (RM)</label>
                <Input
                  id="next-payment-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  max={summary.outstanding}
                  value={newAmount}
                  onChange={(e) => setNewAmount(e.target.value)}
                  className="h-8 w-40"
                />
                <p className="mt-1 text-xs text-gray-500">Up to {rm(summary.outstanding)} outstanding.</p>
              </div>
              {invoiceId && (
                <PaymentProofUpload
                  documentId={invoiceId}
                  orderId={orderId}
                  companyId={companyId}
                  onUploadComplete={setNewProofUrl}
                  existingFileUrl={newProofUrl}
                />
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={recordNext} disabled={busy || !(Number(newAmount) > 0)}>
                  {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Submit payment
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRecording(false)} disabled={busy}>Cancel</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
