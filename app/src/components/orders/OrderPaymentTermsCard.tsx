'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/use-toast'
import {
  orderTermsSummary,
  paymentTermChangeErrorMessage,
  paymentTermFlow,
  paymentTermLockText,
  termIdForOrder,
  termSourceLabel,
  type OrderPaymentTerms,
  type PaymentTermOption,
} from '@/lib/orders/payment-terms'

interface OrderPaymentTermsCardProps {
  orderId: string
  orderType: string | null | undefined
  paymentTerms: OrderPaymentTerms | null | undefined
  orderTotal: number
  /** Called after a successful change so the dialog reloads the order. */
  onChanged?: () => void
}

interface ChangeStatus {
  allowed: boolean
  can_manage: boolean
  reason: string | null
}

const money = (n: number) => `RM ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Payment terms of one order, shown under the document workflow.
 * HQ Admin can override them (with a reason) until the PO is acknowledged (H2M)
 * or an invoice is issued (D2H); the database enforces the same rules.
 */
export default function OrderPaymentTermsCard({ orderId, orderType, paymentTerms, orderTotal, onChanged }: OrderPaymentTermsCardProps) {
  const supabase = createClient()
  const [status, setStatus] = useState<ChangeStatus | null>(null)
  const [editing, setEditing] = useState(false)
  const [options, setOptions] = useState<PaymentTermOption[]>([])
  const [termId, setTermId] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const summary = orderTermsSummary(paymentTerms, orderTotal)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error } = await (supabase as any).rpc('order_payment_term_change_status', { p_order_id: orderId })
      if (!cancelled) setStatus(error ? null : (data as ChangeStatus))
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, paymentTerms])

  const startEditing = async () => {
    setEditing(true)
    setReason('')
    if (options.length === 0) {
      const { data } = await supabase
        .from('payment_terms')
        .select('id, term_code, term_name, deposit_percentage, balance_percentage, is_default')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
      const list = (data || []) as PaymentTermOption[]
      setOptions(list)
      setTermId(termIdForOrder(list, paymentTerms) || list[0]?.id || '')
    } else {
      setTermId(termIdForOrder(options, paymentTerms) || options[0]?.id || '')
    }
  }

  const save = async () => {
    setSaving(true)
    const { error } = await (supabase as any).rpc('order_change_payment_term', {
      p_order_id: orderId,
      p_term_id: termId,
      p_reason: reason,
    })
    setSaving(false)
    if (error) {
      toast({ title: 'Payment terms not changed', description: paymentTermChangeErrorMessage(error), variant: 'destructive' })
      return
    }
    toast({ title: 'Payment terms changed', description: 'The order documents now follow the new term.' })
    setEditing(false)
    onChanged?.()
  }

  const lockText = status?.can_manage ? paymentTermLockText(status.reason) : null
  const selected = options.find((o) => o.id === termId)
  const reasonOk = reason.trim().length >= 5

  return (
    <div className="rounded-md border border-[var(--sera-line,#e5e7eb)] p-3 sm:p-4 text-sm space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="font-semibold">Payment Terms: {summary.name}</div>
          <div className="text-xs text-gray-500">{termSourceLabel(paymentTerms, orderType)}</div>
          {paymentTerms?.source === 'override' && paymentTerms.change_reason && (
            <div className="text-xs text-gray-500">Reason: {paymentTerms.change_reason}</div>
          )}
        </div>
        {status?.allowed && !editing && (
          <Button variant="outline" size="sm" onClick={startEditing}>Change</Button>
        )}
      </div>

      <div className="text-xs text-gray-700">
        {summary.kind === 'split'
          ? `Expected: ${money(summary.depositAmount)} (${summary.depositPercentage}%) first, then ${money(summary.balanceAmount)} (${summary.balancePercentage}%) balance.`
          : `Expected: ${money(orderTotal)} (100%) in one payment.`}
      </div>

      {lockText && <div className="text-xs text-gray-500">{lockText}</div>}

      {editing && (
        <div className="border-t pt-3 space-y-2">
          <label htmlFor="order-payment-term" className="block text-xs font-medium">New payment term</label>
          <select
            id="order-payment-term"
            value={termId}
            onChange={(e) => setTermId(e.target.value)}
            className="w-full px-3 py-2 border rounded-md text-sm"
          >
            {options.map((t) => (
              <option key={t.id} value={t.id}>{t.term_name}{t.is_default ? ' (Default)' : ''}</option>
            ))}
          </select>
          {selected && orderType === 'H2M' && <p className="text-xs text-gray-500">{paymentTermFlow(selected)}</p>}
          <label htmlFor="order-payment-term-reason" className="block text-xs font-medium">Reason (required)</label>
          <textarea
            id="order-payment-term-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            className="w-full px-3 py-2 border rounded-md text-sm"
            placeholder="Why is this order on a different term?"
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving || !termId || !reasonOk}>
              {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
