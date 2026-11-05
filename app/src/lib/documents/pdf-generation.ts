import { createClient } from '@/lib/supabase/server'
import { PDFGenerator, type PDFCompressionStats } from '@/lib/pdf-generator'
import { formatFileSize } from '@/lib/pdf-optimizer'
import {
  getTemplateGenerator,
  getDocumentTitle,
  type DocumentTemplateType,
  type TemplateSignatureData
} from '@/lib/pdf-templates'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Buffer } from 'buffer'
import { resolveOrganizationTerms } from '@/lib/organizations/terms'
import {
  resolvePdfAuditActor,
  resolvePdfImageSource,
  resolvePdfOrganizationLogoSource
} from '@/lib/documents/pdf-assets'
import { createAdminClient } from '@/lib/supabase/admin'
import { userSignaturePath } from '@/lib/storage/documents-bucket'

/**
 * Extract bucket and path from a Supabase storage public URL.
 * Returns null if the URL is not a recognized Supabase storage URL.
 */
function parseSupabaseStorageUrl(url: string): { bucket: string; path: string } | null {
  // Match: .../storage/v1/object/public/<bucket>/<path>
  const m = url.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+?)(?:\?.*)?$/)
  if (m) return { bucket: m[1], path: decodeURIComponent(m[2]) }
  return null
}

let _fetchSupabaseClient: SupabaseClient | null = null
let _fetchAdminClient: SupabaseClient | null = null
function setFetchSupabaseClient(client: SupabaseClient) {
  _fetchSupabaseClient = client
  _fetchAdminClient = createAdminClient()
}

async function fetchUserSignatureAsDataUrl(reference: string, ownerUserId: string): Promise<string | null> {
  const path = userSignaturePath(reference, ownerUserId)
  if (!path || !_fetchAdminClient) return null

  const { data, error } = await _fetchAdminClient.storage.from('documents').download(path)
  if (error || !data) {
    console.warn('Authorized signature download failed', { ownerUserId, error: error?.message })
    return null
  }

  const bytes = Buffer.from(await data.arrayBuffer()).toString('base64')
  return `data:${data.type || 'image/png'};base64,${bytes}`
}

async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const resolvedUrl = resolvePdfImageSource(url)
    if (!resolvedUrl) return null

    // For Supabase storage URLs, use the Supabase client to download
    // (self-hosted Kong requires apikey header which raw fetch doesn't include)
    const parsed = parseSupabaseStorageUrl(resolvedUrl)
    if (parsed && _fetchSupabaseClient) {
      const { data, error } = await _fetchSupabaseClient.storage
        .from(parsed.bucket)
        .download(parsed.path)
      if (error || !data) {
        console.warn('Supabase storage image download failed; falling back to HTTP fetch', {
          bucket: parsed.bucket,
          path: parsed.path,
          error: error?.message
        })
      } else {
        const arrayBuffer = await data.arrayBuffer()
        const base64 = Buffer.from(arrayBuffer).toString('base64')
        const contentType = data.type || 'image/png'
        return `data:${contentType};base64,${base64}`
      }
    }

    const response = await fetch(resolvedUrl)
    if (!response.ok) {
      console.warn('Unable to fetch PDF image', { status: response.status })
      return null
    }

    const arrayBuffer = await response.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')
    const contentType = response.headers.get('content-type') || 'image/png'
    return `data:${contentType};base64,${base64}`
  } catch (error) {
    console.error('Error fetching PDF image', error)
    return null
  }
}

function formatRoleName(roleName?: string | null, roleCode?: string | null): string {
  if (roleName && roleName.trim().length > 0) {
    return roleName
  }

  if (roleCode && roleCode.trim().length > 0) {
    return roleCode.replace(/_/g, ' ').toUpperCase()
  }

  return ''
}

export type DocumentGenerateType = 'order' | 'purchase_order' | 'sales_order' | 'delivery_order' | 'invoice' | 'receipt' | 'payment' | 'payment_request'

export interface GenerateDocumentOptions {
  documentId?: string
  supabaseClient?: SupabaseClient
  skipUpload?: boolean
}

// PDF size statistics for notifications
export interface PDFSizeInfo {
  fileSize: number
  fileSizeFormatted: string
  compressionStats: PDFCompressionStats
  compressionSummary: string
}

interface GenerateResult {
  buffer: Buffer
  filename: string
  sizeInfo: PDFSizeInfo  // Added size information
}

export async function generatePdfForOrderDocument(
  orderId: string,
  type: DocumentGenerateType,
  options: GenerateDocumentOptions = {}
): Promise<GenerateResult> {
  if (!orderId) {
    throw new Error('Order ID is required')
  }

  if (!type) {
    throw new Error('Document type is required')
  }

  const supabase = options.supabaseClient ?? (await createClient())
  setFetchSupabaseClient(supabase)

  // Fetch order data with all relationships
  const { data: orderData, error: orderError } = await supabase
    .from('orders')
    .select(`
      *,
      buyer_org:organizations!orders_buyer_org_id_fkey(
        org_name,
        org_type_code,
        address,
        address_line2,
        city,
        state:state_id,
        postal_code,
        country_code,
        contact_name,
        contact_phone,
        contact_email,
        logo_url
      ),
      seller_org:organizations!orders_seller_org_id_fkey(
        org_name,
        org_type_code,
        address,
        address_line2,
        city,
        state:state_id,
        postal_code,
        country_code,
        contact_name,
        contact_phone,
        contact_email,
        logo_url
      ),
      warehouse_org:organizations!orders_warehouse_org_id_fkey(
        org_name,
        address,
        address_line2,
        city,
        state:state_id,
        postal_code,
        country_code,
        contact_name,
        contact_phone,
        contact_email
      ),
      order_items(
        *,
        product:products(product_name, product_code),
        variant:product_variants(variant_name)
      )
    `)
    .eq('id', orderId)
    .single()

  if (orderError || !orderData) {
    console.error('Order fetch error:', {
      orderId,
      error: orderError,
      message: orderError?.message,
      details: orderError?.details,
      hint: orderError?.hint,
      code: orderError?.code
    })
    throw new Error(orderError?.message || 'Order not found')
  }

  // Determine which organization's settings control the template
  // Logic: Use the ISSUER'S settings.
  // - Purchase Orders, Payment Advice: Buyer (buyer_org_id)
  // - Sales Orders, Invoices, Delivery Orders, Receipts_issued_by_seller: Seller (seller_org_id)
  let settingOrgId = orderData.buyer_org_id

  const sellerIssuedTypes: DocumentGenerateType[] = ['sales_order', 'delivery_order', 'invoice', 'receipt', 'payment_request']
  if (sellerIssuedTypes.includes(type)) {
    settingOrgId = orderData.seller_org_id
  }

  // Fetch organization's document template setting
  let documentTemplate: DocumentTemplateType = 'detailed' // Default to current detailed format
  let organizationTerms = ''
  try {
    const { data: orgSettingsData } = await supabase
      .from('organizations')
      .select('settings')
      .eq('id', settingOrgId)
      .single()

    if (orgSettingsData?.settings) {
      const settings = typeof orgSettingsData.settings === 'string'
        ? JSON.parse(orgSettingsData.settings)
        : orgSettingsData.settings
      if (settings.document_template) {
        documentTemplate = settings.document_template as DocumentTemplateType
      }
      // Terms & Conditions come from the same issuing organization that
      // controls the template, so a document never carries another org's
      // terms. Unrelated to `payment_terms` on the order itself.
      organizationTerms = resolveOrganizationTerms(orgSettingsData)
    }
    console.log(`📄 Using document template: ${documentTemplate} (from org: ${settingOrgId})`)
  } catch (e) {
    console.warn('Could not fetch document template setting, using default:', e)
  }

  // Fetch buyer organization logo and signature images for Classic template
  let buyerLogoImage: string | null = null
  let buyerSignatureImage: string | null = null

  try {
    if (orderData.buyer_org?.logo_url) {
      const logoSource = resolvePdfOrganizationLogoSource(orderData.buyer_org.logo_url)
      buyerLogoImage = logoSource ? await fetchImageAsDataUrl(logoSource) : null
    }
  } catch (logoErr) {
    console.warn('Could not fetch buyer logo:', logoErr)
  }

  // Fetch organization signature separately (it might be in a different column)
  try {
    const { data: orgSignature } = await supabase
      .from('organizations')
      .select('signature_url')
      .eq('id', orderData.buyer_org_id)
      .single()

    if (orgSignature?.signature_url) {
      buyerSignatureImage = await fetchImageAsDataUrl(orgSignature.signature_url)
    }
  } catch (sigErr) {
    console.warn('Could not fetch buyer signature:', sigErr)
  }

  // Fetch seller logo image (for Classic template)
  let sellerLogoImage: string | null = null
  try {
    if (orderData.seller_org?.logo_url) {
      const logoSource = resolvePdfOrganizationLogoSource(orderData.seller_org.logo_url)
      sellerLogoImage = logoSource ? await fetchImageAsDataUrl(logoSource) : null
    }
  } catch (logoErr) {
    console.warn('Could not fetch seller logo:', logoErr)
  }

  // Fetch Issuer Organization Signature (for Sales Order/Invoice "Issued by" section)
  // For SO/Invoice/DO/Receipt/Payment Request, the issuer is the Seller.
  // For PO/Payment Advice, the issuer is the Buyer.
  let issuerSignatureImage: string | null = null
  let issuerOrgId = orderData.buyer_org_id // Default to Buyer (PO/Payment Advice)

  if (['sales_order', 'invoice', 'delivery_order', 'receipt', 'payment_request'].includes(type) && orderData.seller_org_id) {
    issuerOrgId = orderData.seller_org_id
  }

  try {
    const { data: issuerOrg } = await supabase
      .from('organizations')
      .select('signature_url')
      .eq('id', issuerOrgId)
      .single()

    if (issuerOrg?.signature_url) {
      issuerSignatureImage = await fetchImageAsDataUrl(issuerOrg.signature_url)
    }
  } catch (issuerSigErr) {
    console.warn('Could not fetch issuer signature:', issuerSigErr)
  }

  // Fetch the authoritative order creator. Name and signature are retained as
  // one actor so the Classic audit footer cannot mix two different users.
  let creator: ReturnType<typeof resolvePdfAuditActor> = null
  let creatorSignatureImage: string | null = null
  if (orderData.created_by) {
    try {
      const { data: creatorRow } = await supabase
        .from('users')
        .select('full_name, signature_url')
        .eq('id', orderData.created_by)
        .single()

      creator = resolvePdfAuditActor(creatorRow)
      if (creator?.signature_url) {
        creatorSignatureImage = await fetchUserSignatureAsDataUrl(creator.signature_url, orderData.created_by)
      }
    } catch (creatorErr) {
      console.warn('Could not fetch order creator for PDF:', creatorErr)
    }
  }

  // Fetch approver data if order is approved.
  // Annotated loosely because the blocks below progressively add keys
  // (approver, approval_hash, ...) that the initializer does not yet carry.
  let enrichedOrderData: Record<string, any> = {
    ...orderData,
    creator,
    buyer_logo_image: buyerLogoImage,
    seller_logo_image: sellerLogoImage,
    buyer_signature_image: buyerSignatureImage,
    issuer_signature_image: issuerSignatureImage,
    creator_signature_image: creatorSignatureImage,
    organization_terms: organizationTerms
  }

  if (orderData.approved_by) {
    const { data: approver } = await supabase
      .from('users')
      .select('full_name, signature_url, role_code, roles:role_code(role_name)')
      .eq('id', orderData.approved_by)
      .single()

    const resolvedApprover = resolvePdfAuditActor(approver)
    if (resolvedApprover) {
      const approverSignatureImage = resolvedApprover.signature_url
        ? await fetchUserSignatureAsDataUrl(resolvedApprover.signature_url, orderData.approved_by)
        : null

      const approvalData = `${orderData.order_no}|${orderData.approved_by}|${orderData.approved_at}`
      const encoder = new TextEncoder()
      const dataBuffer = encoder.encode(approvalData)
      const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer)
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      const approvalHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32)

      enrichedOrderData = {
        ...enrichedOrderData,
        approver: {
          full_name: resolvedApprover.full_name,
          signature_url: resolvedApprover.signature_url,
          role_name: formatRoleName((approver?.roles as any)?.role_name, approver?.role_code) || 'HQ POWER USER'
        },
        approval_hash: approvalHash,
        approver_signature_image: approverSignatureImage
      }
    }
  }

  let signatures: any[] = []
  const generator = new PDFGenerator(signatures)
  let compressionStats = generator.getCompressionStats()
  let pdfBlob: Blob
  let filename: string

  if (type === 'order') {
    pdfBlob = await generator.generateOrderPDF(enrichedOrderData as any)
    // Use display_doc_no (new format) for filename if available, fallback to legacy order_no
    const orderDisplayNo = orderData.display_doc_no || orderData.order_no
    filename = `${orderDisplayNo}.pdf`
    compressionStats = generator.getCompressionStats()
  } else {
    // Typed as the documents.doc_type union so the filter below type-checks.
    let docType: 'PO' | 'SO' | 'DO' | 'INVOICE' | 'RECEIPT' | 'PAYMENT' | 'PAYMENT_REQUEST'
    switch (type) {
      case 'purchase_order':
        docType = 'PO'
        break
      case 'sales_order':
        docType = 'SO'
        break
      case 'delivery_order':
        docType = 'DO'
        break
      case 'invoice':
        docType = 'INVOICE'
        break
      case 'receipt':
        docType = 'RECEIPT'
        break
      case 'payment':
        docType = 'PAYMENT'
        break
      case 'payment_request':
        docType = 'PAYMENT_REQUEST'
        break
      default:
        throw new Error('Invalid document type')
    }

    let documentQuery = supabase
      .from('documents')
      .select('*')
      .eq('order_id', orderId)
      .eq('doc_type', docType)

    if (options.documentId) {
      documentQuery = documentQuery.eq('id', options.documentId)
    }

    const { data: documentData, error: docError } = await documentQuery
      .order('created_at', { ascending: true })
      .maybeSingle()

    if (docError || !documentData) {
      throw new Error(`${type} not found for this order`)
    }

    let paymentDocument: any = null
    if (docType === 'RECEIPT') {
      const { data: paymentData } = await supabase
        .from('documents')
        .select('*')
        .eq('order_id', orderId)
        .eq('doc_type', 'PAYMENT')
        .eq('id', (documentData.payload as any)?.payment_id ?? documentData.id)
        .maybeSingle()

      if (paymentData) {
        paymentDocument = paymentData
      }
    }

    let poDocument: any = null
    if (docType === 'INVOICE') {
      const { data: poData } = await supabase
        .from('documents')
        .select('*')
        .eq('order_id', orderId)
        .eq('doc_type', 'PO')
        .maybeSingle()

      if (poData) {
        poDocument = poData
      }
    }

    const acknowledgementSource =
      docType === 'RECEIPT' && paymentDocument ? paymentDocument :
        docType === 'INVOICE' && poDocument ? poDocument :
          documentData

    // Loosely annotated for the same reason as enrichedOrderData: later blocks
    // attach acknowledger, linked_invoice, requested_percent and friends.
    let enrichedDocumentData: Record<string, any> = {
      ...documentData,
      acknowledged_at: acknowledgementSource?.acknowledged_at ?? documentData.acknowledged_at,
      acknowledged_by: acknowledgementSource?.acknowledged_by ?? documentData.acknowledged_by
    }

    if (acknowledgementSource?.acknowledged_by) {
      const { data: acknowledger } = await supabase
        .from('users')
        .select('full_name, signature_url, role_code, roles:role_code(role_name)')
        .eq('id', acknowledgementSource.acknowledged_by)
        .single()

      if (acknowledger) {
        const acknowledgerSignatureImage = acknowledger.signature_url
          ? await fetchUserSignatureAsDataUrl(acknowledger.signature_url, acknowledgementSource.acknowledged_by)
          : null

        const ackData = `${acknowledgementSource.doc_no}|${acknowledgementSource.acknowledged_by}|${acknowledgementSource.acknowledged_at}`
        const encoder = new TextEncoder()
        const dataBuffer = encoder.encode(ackData)
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer)
        const hashArray = Array.from(new Uint8Array(hashBuffer))
        const ackHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32)

        enrichedDocumentData = {
          ...enrichedDocumentData,
          acknowledger: {
            full_name: acknowledger.full_name,
            signature_url: acknowledger.signature_url,
            role_name: formatRoleName((acknowledger.roles as any)?.role_name, acknowledger.role_code) || 'MANUFACTURER'
          },
          acknowledgement_hash: ackHash,
          acknowledger_signature_image: acknowledgerSignatureImage
        }
      }
    }

    // Prepared By on a Delivery Order: the user who created the DO. Left blank if that is not recorded.
    if (docType === 'DO' && documentData.created_by) {
      const { data: preparer } = await supabase
        .from('users')
        .select('full_name, signature_url')
        .eq('id', documentData.created_by)
        .maybeSingle()
      if (preparer) {
        enrichedDocumentData = {
          ...enrichedDocumentData,
          prepared_by: {
            full_name: preparer.full_name,
            signature_image: preparer.signature_url
              ? await fetchUserSignatureAsDataUrl(preparer.signature_url, documentData.created_by)
              : null
          }
        }
      }
    }

    if (docType === 'PAYMENT') {
      const paymentPayload = (documentData.payload ?? {}) as Record<string, any>
      let linkedInvoice: any = null
      let sourceRequest: any = null

      if (paymentPayload?.invoice_id) {
        const { data: invoiceDoc } = await supabase
          .from('documents')
          .select('id, doc_no, status, total_amount, payment_percentage, payload, created_at')
          .eq('id', paymentPayload.invoice_id)
          .maybeSingle()

        if (invoiceDoc) {
          linkedInvoice = invoiceDoc
        }
      }

      if (paymentPayload?.source_request_id) {
        const { data: requestDoc } = await supabase
          .from('documents')
          .select('id, doc_no, status, total_amount, payment_percentage, payload, created_at')
          .eq('id', paymentPayload.source_request_id)
          .maybeSingle()

        if (requestDoc) {
          sourceRequest = requestDoc
        }
      }

      if (linkedInvoice || sourceRequest) {
        enrichedDocumentData = {
          ...enrichedDocumentData,
          linked_invoice: linkedInvoice,
          source_request: sourceRequest
        }
      }
    }

    if (docType === 'PAYMENT_REQUEST') {
      const payload = (documentData.payload ?? {}) as Record<string, any>

      const { data: relatedDocs } = await supabase
        .from('documents')
        .select('id, doc_no, doc_type, status, created_at, payment_percentage, payload')
        .eq('order_id', orderId)
        .in('doc_type', ['INVOICE', 'PAYMENT', 'RECEIPT'])
        .order('created_at', { ascending: true })

      let depositInvoice: any = null
      let depositPayment: any = null
      let depositReceipt: any = null

      if (relatedDocs && relatedDocs.length > 0) {
        for (const related of relatedDocs) {
          const relatedPayload = (related.payload ?? {}) as Record<string, any>
          const paymentPct = typeof related.payment_percentage === 'number'
            ? related.payment_percentage
            : typeof relatedPayload.payment_percentage === 'number'
              ? relatedPayload.payment_percentage
              : undefined

          if (!depositInvoice && related.doc_type === 'INVOICE') {
            const isDepositInvoice = relatedPayload.is_deposit_invoice === true || relatedPayload.invoice_stage === 'deposit'
              || relatedPayload.is_deposit === true || (typeof paymentPct === 'number' && paymentPct <= 60)
            if (isDepositInvoice) {
              depositInvoice = {
                id: related.id,
                doc_no: related.doc_no,
                status: related.status,
                created_at: related.created_at,
                payment_percentage: paymentPct ?? null
              }
            }
          }

          if (!depositPayment && related.doc_type === 'PAYMENT') {
            const isDepositPayment = relatedPayload.is_deposit_payment === true
              || relatedPayload.payment_stage === 'deposit'
              || relatedPayload.stage === 'deposit'
              || (typeof paymentPct === 'number' && paymentPct > 0 && paymentPct <= 60)
            if (isDepositPayment) {
              depositPayment = {
                id: related.id,
                doc_no: related.doc_no,
                status: related.status,
                created_at: related.created_at,
                payment_percentage: paymentPct ?? null
              }
            }
          }

          if (!depositReceipt && related.doc_type === 'RECEIPT') {
            const isDepositReceipt = relatedPayload.is_deposit_receipt === true
              || relatedPayload.receipt_stage === 'deposit'
              || relatedPayload.payment_stage === 'deposit'
              || relatedPayload.stage === 'deposit'
              || (typeof paymentPct === 'number' && paymentPct > 0 && paymentPct <= 60)
            if (isDepositReceipt) {
              depositReceipt = {
                id: related.id,
                doc_no: related.doc_no,
                status: related.status,
                created_at: related.created_at,
                payment_percentage: paymentPct ?? null
              }
            }
          }

          if (depositInvoice && depositPayment && depositReceipt) {
            break
          }
        }
      }

      const requestedPercent = typeof payload.requested_percent === 'number'
        ? payload.requested_percent
        : typeof payload.requested_percent === 'string'
          ? parseFloat(payload.requested_percent)
          : null

      enrichedDocumentData = {
        ...enrichedDocumentData,
        requested_percent: requestedPercent,
        related_documents: {
          deposit_invoice: depositInvoice,
          deposit_payment: depositPayment,
          deposit_receipt: depositReceipt
        }
      }
    }

    const signaturesDocumentId =
      docType === 'RECEIPT' && paymentDocument ? paymentDocument.id : documentData.id

    const { data: signaturesData } = await supabase
      .rpc('get_document_signatures', { p_document_id: signaturesDocumentId })

    if (signaturesData && signaturesData.length > 0) {
      signatures = await Promise.all(
        signaturesData.map(async (sig: any) => ({
          ...sig,
          integrity_hash: sig.signature_hash,
          signature_image_data: sig.signature_image_url && sig.signer_user_id
            ? await fetchUserSignatureAsDataUrl(sig.signature_image_url, sig.signer_user_id)
            : null
        }))
      )

      const manufacturerSignature = [...signatures]
        .reverse()
        .find((sig) => (sig.signer_role || '').toUpperCase().includes('MANUFACTUR'))

      if (manufacturerSignature) {
        enrichedDocumentData = {
          ...enrichedDocumentData,
          acknowledged_at: manufacturerSignature.signed_at || enrichedDocumentData.acknowledged_at,
          acknowledgement_hash:
            manufacturerSignature.integrity_hash || manufacturerSignature.signature_hash || enrichedDocumentData.acknowledgement_hash,
          acknowledger: {
            full_name: manufacturerSignature.signer_name,
            role_name: formatRoleName(undefined, manufacturerSignature.signer_role) || manufacturerSignature.signer_role || 'MANUFACTURER',
            signature_url: manufacturerSignature.signature_image_url
          },
          acknowledger_signature_image:
            manufacturerSignature.signature_image_data || enrichedDocumentData.acknowledger_signature_image || null
        }
      }
    }

    const generatorWithSigs = new PDFGenerator(signatures)
    let compressionStats = generatorWithSigs.getCompressionStats()

    // Check if we should use an alternative template
    const templateGenerator = getTemplateGenerator(
      documentTemplate,
      signatures.map(s => ({
        signer_name: s.signer_name,
        signer_role: s.signer_role,
        signed_at: s.signed_at,
        signature_image_data: s.signature_image_data
      })) as TemplateSignatureData[]
    )

    // Use alternative template if available (classic)
    if (templateGenerator && documentTemplate !== 'detailed') {
      const docTitle = getDocumentTitle(docType)
      pdfBlob = await templateGenerator.generate(
        enrichedOrderData as any,
        enrichedDocumentData as any,
        docTitle
      )

      // Set filename based on document type - use display_doc_no (new format) when available
      const docDisplayNo = enrichedDocumentData.display_doc_no || enrichedDocumentData.doc_no
      filename = `${docDisplayNo}.pdf`
    } else {
      // Use the detailed PDFGenerator (current behavior)
      // Use display_doc_no (new format) for filename when available
      const docDisplayNo = enrichedDocumentData.display_doc_no || enrichedDocumentData.doc_no
      switch (type) {
        case 'purchase_order':
          pdfBlob = await generatorWithSigs.generatePurchaseOrderPDF(enrichedOrderData as any, enrichedDocumentData as any)
          break
        case 'sales_order':
          pdfBlob = await generatorWithSigs.generateSalesOrderPDF(enrichedOrderData as any, enrichedDocumentData as any)
          break
        case 'delivery_order':
          pdfBlob = await generatorWithSigs.generateDeliveryOrderPDF(enrichedOrderData as any, enrichedDocumentData as any)
          break
        case 'invoice':
          pdfBlob = await generatorWithSigs.generateInvoicePDF(enrichedOrderData as any, enrichedDocumentData as any)
          break
        case 'receipt':
          pdfBlob = await generatorWithSigs.generateReceiptPDF(enrichedOrderData as any, enrichedDocumentData as any)
          break
        case 'payment':
          pdfBlob = await generatorWithSigs.generatePaymentPDF(enrichedOrderData as any, enrichedDocumentData as any)
          break
        case 'payment_request':
          pdfBlob = await generatorWithSigs.generatePaymentRequestPDF(enrichedOrderData as any, enrichedDocumentData as any)
          break
        default:
          pdfBlob = await generatorWithSigs.generateOrderPDF(enrichedOrderData as any)
      }
      filename = `${docDisplayNo}.pdf`
    }

    // Get updated compression stats after PDF generation
    compressionStats = generatorWithSigs.getCompressionStats()
    if (!options.skipUpload) {
      try {
        const arrayBuffer = await pdfBlob.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)
        const admin = _fetchAdminClient || createAdminClient()
        const { error: uploadError } = await admin.storage
          .from('order-documents')
          .upload(`${orderId}/${filename}`, buffer, {
            contentType: 'application/pdf',
            upsert: true
          })

        if (uploadError) {
          console.error('Error uploading generated PDF to storage:', uploadError)
        }
      } catch (uploadErr) {
        console.error('Error uploading to storage:', uploadErr)
      }
    }
  }

  const arrayBuffer = await pdfBlob.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const fileSize = buffer.length

  // Build compression summary for notification
  const summaryParts: string[] = []
  summaryParts.push(`📄 PDF Size: ${formatFileSize(fileSize)}`)

  if (compressionStats.totalSavings > 0) {
    summaryParts.push(`💾 Optimized: ${formatFileSize(compressionStats.totalSavings)} saved`)
  }

  if (compressionStats.logoCompressedSize > 0) {
    const logoSaving = compressionStats.logoOriginalSize - compressionStats.logoCompressedSize
    if (logoSaving > 0) {
      summaryParts.push(`🖼️ Logo: ${formatFileSize(compressionStats.logoCompressedSize)} (${Math.round(logoSaving / compressionStats.logoOriginalSize * 100)}% smaller)`)
    }
  }

  if (compressionStats.signatureCompressedSize > 0) {
    const sigSaving = compressionStats.signatureOriginalSize - compressionStats.signatureCompressedSize
    if (sigSaving > 0) {
      summaryParts.push(`✍️ Signatures: ${formatFileSize(compressionStats.signatureCompressedSize)} (${Math.round(sigSaving / compressionStats.signatureOriginalSize * 100)}% smaller)`)
    }
  }

  const sizeInfo: PDFSizeInfo = {
    fileSize,
    fileSizeFormatted: formatFileSize(fileSize),
    compressionStats,
    compressionSummary: summaryParts.join(' | ')
  }

  // Log compression summary for monitoring
  console.log(`📊 PDF Generated: ${filename} | ${sizeInfo.compressionSummary}`)

  return {
    buffer,
    filename,
    sizeInfo
  }
}
