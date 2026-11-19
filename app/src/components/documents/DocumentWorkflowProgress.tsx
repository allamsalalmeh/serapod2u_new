'use client'

import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { CheckCircle2, Clock, FileText, FileCheck, CreditCard, Receipt } from 'lucide-react'
import { getDocumentStatusText, getDisplayDocNo, type Document } from '@/lib/document-permissions'

interface DocumentWorkflowProgressProps {
  documents: {
    po?: Document | null
    so?: Document | null
    do?: Document | null
    invoice?: Document | null
    payment?: Document | null
    receipt?: Document | null
    depositInvoice?: Document | null
    depositPayment?: Document | null
    balancePaymentRequest?: Document | null
    balancePayment?: Document | null
    depositReceipt?: Document | null
    finalReceipt?: Document | null
  }
  onTabChange?: (tab: string) => void
  use50_50Split?: boolean
  depositPercentage?: number
  orderType?: string
  buyerOrgName?: string
  sellerOrgName?: string
}

export default function DocumentWorkflowProgress({
  documents,
  onTabChange,
  use50_50Split = false,
  depositPercentage = 50,
  orderType,
  buyerOrgName,
  sellerOrgName
}: DocumentWorkflowProgressProps) {
  const balancePercentage = 100 - depositPercentage

  // Determine the pending action and who needs to take it
  const getPendingActionRemark = (): string | null => {
    const buyer = buyerOrgName || 'buyer'
    const seller = sellerOrgName || 'manufacturer'

    if (orderType === 'D2H' || orderType === 'S2D') {
      // D2H/S2D workflow: SO → DO → Invoice → Payment → Receipt
      if (!documents.so) return `Awaiting ${seller} to create Sales Order`
      if (documents.so.status !== 'acknowledged') return `Awaiting ${buyer} to acknowledge Sales Order`
      if (!documents.do) return `Awaiting ${seller} to create Delivery Order`
      if (documents.do.status !== 'acknowledged') return `Awaiting ${buyer} to acknowledge Delivery Order`
      if (!documents.invoice) return `Awaiting ${seller} to upload Invoice`
      if (documents.invoice.status !== 'acknowledged') return `Awaiting ${buyer} to acknowledge Invoice`
      if (!documents.payment) return `Awaiting ${buyer} to upload Payment Proof`
      if (documents.payment.status !== 'acknowledged') return `Awaiting ${seller} to acknowledge Payment`
      if (!documents.receipt) return `Awaiting ${seller} to issue Receipt`
      return null // Workflow complete
    } else if (use50_50Split) {
      // Split payment workflow: PO → Dep Invoice → Dep Payment → Balance Request → Balance Payment → Receipt
      if (!documents.po) return `Awaiting ${buyer} to create Purchase Order`
      if (documents.po.status !== 'acknowledged') return `Awaiting ${seller} to acknowledge PO and upload Proforma Invoice`

      const depositInv = documents.depositInvoice || documents.invoice
      if (!depositInv) return `Awaiting ${seller} to upload Deposit Invoice`
      if (depositInv.status !== 'acknowledged') return `Awaiting ${buyer} to acknowledge Deposit Invoice`

      const depositPay = documents.depositPayment || documents.payment
      if (!depositPay) return `Awaiting ${buyer} to upload Deposit Payment Proof`
      if (depositPay.status !== 'acknowledged') return `Awaiting ${seller} to acknowledge Deposit Payment`

      if (!documents.balancePaymentRequest) return `Awaiting ${seller} to request Balance Payment`
      if (documents.balancePaymentRequest.status !== 'acknowledged') return `Awaiting ${buyer} to acknowledge Balance Request`

      if (!documents.balancePayment) return `Awaiting ${buyer} to upload Balance Payment Proof`
      if (documents.balancePayment.status !== 'acknowledged') return `Awaiting ${seller} to acknowledge Balance Payment`

      if (!documents.receipt && !documents.finalReceipt) return `Awaiting ${seller} to issue Receipt`
      return null // Workflow complete
    } else {
      // Traditional workflow: PO → Invoice → Payment → Receipt
      if (!documents.po) return `Awaiting ${buyer} to create Purchase Order`
      if (documents.po.status !== 'acknowledged') return `Awaiting ${seller} to acknowledge PO`
      if (!documents.invoice) return `Awaiting ${seller} to upload Invoice`
      if (documents.invoice.status !== 'acknowledged') return `Awaiting ${buyer} to acknowledge Invoice`
      if (!documents.payment) return `Awaiting ${buyer} to upload Payment Proof`
      if (documents.payment.status !== 'acknowledged') return `Awaiting ${seller} to acknowledge Payment`
      if (!documents.receipt) return `Awaiting ${seller} to issue Receipt`
      return null // Workflow complete
    }
  }

  const pendingRemark = getPendingActionRemark()
  // Define steps based on workflow type
  type Step = {
    key: string
    label: string
    shortLabel?: string
    icon: any
    color: string
    document: Document | null | undefined
  }

  const d2hSteps: Step[] = [
    {
      key: 'so',
      label: 'Sales Order',
      icon: FileText,
      color: 'blue',
      document: documents.so
    },
    {
      key: 'do',
      label: 'Delivery Order',
      icon: FileCheck,
      color: 'indigo',
      document: documents.do
    },
    {
      key: 'invoice',
      label: 'Invoice',
      icon: FileCheck,
      color: 'green',
      document: documents.invoice
    },
    {
      key: 'payment',
      label: 'Payment',
      icon: CreditCard,
      color: 'purple',
      document: documents.payment
    },
    {
      key: 'receipt',
      label: 'Receipt',
      icon: Receipt,
      color: 'orange',
      document: documents.receipt
    }
  ]

  const traditionalSteps: Step[] = [
    {
      key: 'po',
      label: 'Purchase Order',
      icon: FileText,
      color: 'blue',
      document: documents.po
    },
    {
      key: 'invoice',
      label: 'Invoice',
      icon: FileCheck,
      color: 'green',
      document: documents.invoice
    },
    {
      key: 'payment',
      label: 'Payment',
      icon: CreditCard,
      color: 'purple',
      document: documents.payment
    },
    {
      key: 'receipt',
      label: 'Receipt',
      icon: Receipt,
      color: 'orange',
      document: documents.receipt
    }
  ]

  const split50_50Steps: Step[] = [
    {
      key: 'po',
      label: 'Purchase Order',
      icon: FileText,
      color: 'blue',
      document: documents.po
    },
    {
      key: 'depositInvoice',
      label: 'Deposit Invoice',
      shortLabel: 'Dep. Inv',
      icon: FileCheck,
      color: 'indigo',
      document: documents.depositInvoice || documents.invoice
    },
    {
      key: 'depositPayment',
      label: 'Deposit Payment',
      shortLabel: 'Dep. Pay',
      icon: CreditCard,
      color: 'purple',
      document: documents.depositPayment || documents.payment
    },
    {
      key: 'balanceRequest',
      label: 'Balance Request',
      shortLabel: 'Bal. Req',
      icon: FileCheck,
      color: 'pink',
      document: documents.balancePaymentRequest
    },
    {
      key: 'balancePayment',
      label: 'Balance Payment',
      shortLabel: 'Bal. Pay',
      icon: CreditCard,
      color: 'rose',
      document: documents.balancePayment
    },
    {
      key: 'receipt',
      label: 'Receipt',
      icon: Receipt,
      color: 'orange',
      document: documents.receipt
    }
  ]

  let steps = traditionalSteps
  if (orderType === 'D2H' || orderType === 'S2D') {
    steps = d2hSteps
  } else if (use50_50Split) {
    steps = split50_50Steps
  }

  const getStepStatus = (document: Document | null | undefined) => {
    if (!document) return 'not-started'
    if (document.doc_type === 'RECEIPT') return 'completed'
    if (document.status === 'acknowledged') return 'completed'
    if (document.status === 'pending') return 'pending'
    return 'not-started'
  }

  const getStepColor = (status: string, baseColor: string) => {
    if (status === 'completed') return 'bg-green-100 text-green-700 border-green-300'
    if (status === 'partial') return 'bg-amber-100 text-amber-800 border-amber-300'
    if (status === 'pending') return `bg-yellow-100 text-yellow-700 border-yellow-300`
    return 'bg-gray-100 text-gray-400 border-gray-300'
  }

  const getIconColor = (status: string, baseColor: string) => {
    if (status === 'completed') return 'text-green-600'
    if (status === 'partial') return 'text-amber-600'
    if (status === 'pending') return `text-${baseColor}-600`
    return 'text-gray-400'
  }

  // Status shown on a step card. The receipt of a split order is only complete with the
  // final receipt; a deposit receipt alone is partial.
  const getDisplayStatus = (step: Step) => {
    const isReceiptStep = use50_50Split && step.key === 'receipt'
    if (!isReceiptStep) return getStepStatus(step.document)
    if (documents.finalReceipt) return 'completed'
    if (documents.depositReceipt) return 'partial'
    return getStepStatus(step.document)
  }

  // Progress counts only the steps shown as complete (green), so it matches the cards:
  // a yellow step never counts as done.
  const progress = steps.length > 0
    ? (steps.filter((s) => getDisplayStatus(s) === 'completed').length / steps.length) * 100
    : 0

  return (
    <Card className="p-6">
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-lg font-semibold text-gray-900">Document Workflow</h3>
          <span className="text-sm font-medium text-gray-600">{Math.round(progress)}% Complete</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-blue-600 h-2 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className={`grid gap-3 sm:gap-4 ${use50_50Split ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-6' : (orderType === 'D2H' || orderType === 'S2D') ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5' : 'grid-cols-2 md:grid-cols-4'}`}>
        {steps.map((step, index) => {
          // Receipt of a split order: green with the final receipt, amber with the deposit receipt only.
          const status = getDisplayStatus(step)
          const StepIcon = step.icon
          const displayLabel = use50_50Split && 'shortLabel' in step ? step.shortLabel : step.label

          return (
            <div key={step.key} className="relative">
              <button
                onClick={() => onTabChange?.(step.key)}
                className={`w-full border-2 rounded-lg p-2 sm:p-3 transition-all ${getStepColor(status, step.color)} ${onTabChange ? 'cursor-pointer hover:shadow-lg hover:scale-105 active:scale-100' : ''
                  }`}
              >
                <div className="flex flex-col items-center text-center">
                  <div className={`mb-2 ${getIconColor(status, step.color)}`}>
                    {status === 'completed' ? (
                      <CheckCircle2 className="w-5 h-5 sm:w-6 sm:h-6" />
                    ) : status === 'pending' || status === 'partial' ? (
                      <Clock className="w-5 h-5 sm:w-6 sm:h-6" />
                    ) : (
                      <StepIcon className="w-5 h-5 sm:w-6 sm:h-6" />
                    )}
                  </div>

                  <p className="font-semibold text-xs sm:text-sm mb-1">
                    <span className="sm:hidden">{step.key === 'po' ? 'PO' : step.key === 'so' ? 'SO' : step.key === 'do' ? 'DO' : displayLabel}</span>
                    <span className="hidden sm:inline">{displayLabel}</span>
                  </p>

                  {step.document ? (
                    <>
                      <Badge
                        variant="outline"
                        className="text-[10px] sm:text-xs mb-1"
                      >
                        <span className="truncate max-w-full block leading-tight">{getDisplayDocNo(step.document)}</span>
                      </Badge>
                      <span className="text-xs hidden sm:block">
                        {getDocumentStatusText(step.document)}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs hidden sm:block">Not Created</span>
                  )}
                </div>
              </button>

              {/* Connector Arrow */}
              {index < steps.length - 1 && (
                <div className="hidden md:block absolute top-1/2 -right-4 transform -translate-y-1/2 z-10">
                  <div className={`w-8 h-0.5 ${getStepStatus(steps[index + 1].document) !== 'not-started'
                    ? 'bg-green-400'
                    : 'bg-gray-300'
                    }`}></div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Workflow Description */}
      <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-xs text-blue-800">
        <span className="font-bold">Workflow: </span>
        {orderType === 'D2H' || orderType === 'S2D' ? (
          'Sales Order → Delivery Order → Invoice → Payment → Receipt.'
        ) : use50_50Split ? (
          `Orders use a ${depositPercentage}/${balancePercentage} payment split: Deposit Invoice (${depositPercentage}%) → Deposit Payment (${depositPercentage}%) → Balance Payment Request (${balancePercentage}%) → Balance Payment (${balancePercentage}%) → Receipt.`
        ) : (
          'Standard workflow: Purchase Order → Invoice → Payment → Receipt.'
        )}
      </div>

      {/* Pending Action Remark */}
      {pendingRemark && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-xs text-amber-800 mt-3">
          <span className="font-bold">Remarks: </span>
          {pendingRemark}
        </div>
      )}
    </Card>
  )
}
