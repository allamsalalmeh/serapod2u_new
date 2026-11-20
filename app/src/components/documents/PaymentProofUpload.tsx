'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'
import UnifiedDocumentUpload from './UnifiedDocumentUpload'
import { useToast } from '@/components/ui/use-toast'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { downloadOrderDocument } from '@/lib/storage/order-documents-client'

type PaymentProofVariant = 'invoice' | 'balance' | 'payment'

const VARIANT_COPY: Record<PaymentProofVariant, {
  assetName: string
  stepTitle: string
  stepDescription: string
  fieldLabel: string
  fieldHint: string
  successHeader: string
  successDescription: string
  successCardTitle: string
  toastUploadDescription: string
  toastReplaceDescription: string
  toastDownloadFailed: string
  replacePrompt: string
  uploadCta: string
}> = {
  invoice: {
    assetName: 'payment proof',
    stepTitle: 'Step 1: Upload Payment Proof (Required)',
    stepDescription:
      'Before acknowledging this invoice, please attach proof of payment such as a bank transfer receipt or payment confirmation.',
    fieldLabel: 'Payment Proof Document',
    fieldHint: 'Accepted formats: PDF, JPG, PNG • Maximum file size: 5MB',
    successHeader: '✓ Step 1 Complete: Payment Proof Uploaded',
    successDescription: 'You can now proceed to acknowledge the invoice below.',
    successCardTitle: 'Payment Proof Uploaded',
    toastUploadDescription: 'Payment proof has been uploaded',
    toastReplaceDescription: 'Payment proof has been replaced with the new file',
    toastDownloadFailed: 'Failed to download payment proof',
    replacePrompt: 'Please select a new payment proof file',
    uploadCta: 'Click to upload payment proof'
  },
  payment: {
    assetName: 'payment proof',
    stepTitle: 'Upload Payment Proof (Required)',
    stepDescription:
      'Attach proof of this payment, such as a bank transfer receipt or payment confirmation. HQ reviews it before acknowledging the payment.',
    fieldLabel: 'Payment Proof Document',
    fieldHint: 'Accepted formats: PDF, JPG, PNG • Maximum file size: 5MB',
    successHeader: '✓ Payment Proof Uploaded',
    successDescription: 'You can now submit the payment below.',
    successCardTitle: 'Payment Proof Uploaded',
    toastUploadDescription: 'Payment proof has been uploaded',
    toastReplaceDescription: 'Payment proof has been replaced with the new file',
    toastDownloadFailed: 'Failed to download payment proof',
    replacePrompt: 'Please select a new payment proof file',
    uploadCta: 'Click to upload payment proof'
  },
  balance: {
    assetName: 'final payment document',
    stepTitle: 'Step 1: Attach Final Payment Document (Required)',
    stepDescription:
      'Before HQ can approve this balance payment request, please upload the remittance advice or supporting document for the final 50% payment.',
    fieldLabel: 'Final Payment Document',
    fieldHint: 'Accepted formats: PDF, JPG, PNG • Maximum file size: 5MB',
    successHeader: '✓ Final Payment Document Attached',
    successDescription: 'HQ approvers can now approve the balance payment request.',
    successCardTitle: 'Final Payment Document Uploaded',
    toastUploadDescription: 'Final payment document has been uploaded',
    toastReplaceDescription: 'Final payment document has been replaced with the new file',
    toastDownloadFailed: 'Failed to download final payment document',
    replacePrompt: 'Please select a new final payment document',
    uploadCta: 'Click to upload final payment document'
  }
}

interface PaymentProofUploadProps {
  documentId: string
  orderId: string
  companyId: string
  onUploadComplete: (fileUrl: string) => void
  existingFileUrl?: string | null
  variant?: PaymentProofVariant
}

// Helper to format file size
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export default function PaymentProofUpload({
  documentId,
  orderId,
  companyId,
  onUploadComplete,
  existingFileUrl = null,
  variant = 'invoice'
}: PaymentProofUploadProps) {
  const copy = VARIANT_COPY[variant]
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(existingFileUrl)
  const [fileSize, setFileSize] = useState<number | null>(null)
  const { toast } = useToast()
  const handleUpload = async (file: File) => {
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('documentId', documentId)
      form.append('kind', variant === 'balance' ? 'balance-payment-proof' : 'deposit-payment-proof')
      const oldPath = uploadedUrl || existingFileUrl
      if (oldPath) form.append('existingFileUrl', oldPath)
      const response = await fetch(`/api/documents/order/${encodeURIComponent(orderId)}/file`, {
        method: 'POST', body: form,
      })
      const result = await response.json()
      if (!response.ok || !result?.fileUrl) throw new Error(result?.error || 'Failed to upload payment proof')
      const fileUrl = result.fileUrl

      setUploadedUrl(fileUrl)
      setFileSize(file.size)
      onUploadComplete(fileUrl)

      toast({
        title: uploadedUrl || existingFileUrl ? 'File Replaced Successfully' : 'Upload Successful',
        description: uploadedUrl || existingFileUrl 
          ? copy.toastReplaceDescription
          : copy.toastUploadDescription
      })

    } catch (error: any) {
      console.error('Error uploading file:', error)
      toast({
        title: 'Upload Failed',
        description: error.message || 'Failed to upload payment proof',
        variant: 'destructive'
      })
      throw error // Re-throw so UnifiedDocumentUpload knows it failed
    }
  }

  const handleDownloadExisting = async () => {
    if (!uploadedUrl) return

    try {
      await downloadOrderDocument(orderId, uploadedUrl, 'payment-proof.pdf')
    } catch (error: any) {
      console.error('Error downloading file:', error)
      toast({
        title: 'Download Failed',
        description: copy.toastDownloadFailed,
        variant: 'destructive'
      })
    }
  }

  const handleReplaceFile = () => {
    setUploadedUrl(null)
    toast({
      title: 'Ready to Replace',
      description: copy.replacePrompt,
    })
  }

  if (uploadedUrl) {
    return (
      <div className="space-y-2">
        {/* Success header */}
        <div className="bg-green-50 border-l-4 border-green-500 p-2.5">
          <div className="flex items-start gap-2">
            <div className="flex-shrink-0">
              <Check className="w-4 h-4 text-green-600 mt-0.5" />
            </div>
            <div className="flex-1">
              <h4 className="text-xs font-semibold text-green-900 mb-0.5">
                {copy.successHeader}
              </h4>
              <p className="text-[11px] text-green-800">
                {copy.successDescription}
              </p>
              <p className="text-[10px] text-green-700 mt-0.5">
                Need to change the file? Click &quot;Replace&quot; to upload a different document.
              </p>
            </div>
          </div>
        </div>

        <Card className="p-2.5 bg-green-50 border-2 border-green-200">
          <div className="flex items-center gap-2">
            <div className="flex-shrink-0">
              <div className="w-9 h-9 rounded-lg bg-green-100 flex items-center justify-center">
                <Check className="w-4 h-4 text-green-600" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-green-900">{copy.successCardTitle}</p>
              <p className="text-[11px] text-green-700 truncate">
                {uploadedUrl.split('/').pop()}
                {fileSize && <span className="text-[10px] text-green-600 ml-1">({formatFileSize(fileSize)})</span>}
              </p>
            </div>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadExisting}
                className="h-7 px-2 text-[10px] border-green-300 hover:bg-green-100"
              >
                Download
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReplaceFile}
                className="h-7 px-2 text-[10px] border-amber-300 hover:bg-amber-50 text-amber-700 hover:text-amber-800"
              >
                Replace
              </Button>
            </div>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Prominent header */}
      <div className="bg-blue-50 border-l-4 border-blue-500 p-2.5">
        <div className="flex items-start gap-2">
          <div className="flex-shrink-0">
            <svg className="w-4 h-4 text-blue-600 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="flex-1">
            <h4 className="text-xs font-semibold text-blue-900 mb-0.5">
              {copy.stepTitle}
            </h4>
            <p className="text-[11px] text-blue-800">
              {copy.stepDescription}
            </p>
          </div>
        </div>
      </div>

      <UnifiedDocumentUpload
        label={copy.fieldLabel}
        description={copy.fieldHint}
        onUpload={handleUpload}
        acceptedFileTypes={['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']}
      />
    </div>
  )
}
