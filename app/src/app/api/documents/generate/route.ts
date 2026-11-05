import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { generatePdfForOrderDocument, type DocumentGenerateType } from '@/lib/documents/pdf-generation'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const orderId = searchParams.get('orderId')
    const type = searchParams.get('type') as DocumentGenerateType
    const documentId = searchParams.get('documentId') ?? undefined
    const noCache = searchParams.get('nocache') === 'true'

    if (!orderId || !type) {
      return NextResponse.json(
        { error: 'Missing orderId or type parameter' },
        { status: 400 }
      )
    }

    // Document generation reads order financials: authenticated S&A decision
    // first (the PDF helpers below read through the caller's RLS).
    {
      const { createClient: createAuthClient } = await import('@/lib/supabase/server')
      const authClient = await createAuthClient()
      const { data: { user: actor } } = await authClient.auth.getUser()
      if (!actor) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      const saDenied = await guardUserOperation(actor.id, 'supply_chain.document.manage')
      if (saDenied) return saDenied
    }

    // Delivery Orders are always generated fresh: a stored copy may predate the current content (and show prices), and
    // Received By changes with the acknowledgement.
    const cacheable = type !== 'delivery_order'

    // Try to serve cached PDF first (unless nocache=true)
    if (cacheable && !noCache && documentId) {
      try {
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()

        // Check if cached PDF exists in document_files
        const { data: cachedPdf, error: cacheError } = await supabase
          .from('document_files')
          .select('file_url, file_name, created_at')
          .eq('document_id', documentId)
          .eq('mime_type', 'application/pdf')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (!cacheError && cachedPdf) {
          // Get document's last updated timestamp
          const { data: doc } = await supabase
            .from('documents')
            .select('updated_at, acknowledged_at')
            .eq('id', documentId)
            .single()

          // Use cached PDF if it's newer than document updates
          const docLastUpdate = new Date(doc?.acknowledged_at || doc?.updated_at || 0)
          const pdfGenerated = new Date(cachedPdf.created_at)

          if (pdfGenerated >= docLastUpdate) {
            console.log('📄 Serving cached PDF:', cachedPdf.file_name)

            // Download from storage
            const { createAdminClient } = await import('@/lib/supabase/admin')
            const admin = createAdminClient()
            const { data: pdfBlob, error: downloadError } = await admin.storage
              .from('order-documents')
              .download(cachedPdf.file_url)

            if (!downloadError && pdfBlob) {
              const buffer = Buffer.from(await pdfBlob.arrayBuffer())
              return new NextResponse(buffer, {
                headers: {
                  'Content-Type': 'application/pdf',
                  'Content-Disposition': `attachment; filename="${cachedPdf.file_name}"`,
                  'X-Cache-Status': 'HIT'
                },
              })
            }
          } else {
            console.log('📄 Cached PDF outdated, regenerating...')
          }
        }
      } catch (cacheErr) {
        console.warn('Cache check failed, generating new PDF:', cacheErr)
      }
    }

    // Generate new PDF
    console.log('📄 Generating new PDF...')
    // Skip internal upload in generation function, we handle it here with service role
    const { buffer, filename, sizeInfo } = await generatePdfForOrderDocument(orderId, type, {
      documentId,
      skipUpload: true
    })

    // Cache the generated PDF if documentId is provided
    if (cacheable && documentId && buffer) {
      try {
        const { createClient } = await import('@/lib/supabase/server')
        const { createClient: createServiceClient } = await import('@supabase/supabase-js')
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()

        // Fetch company_id from order
        const { data: orderData } = await supabase
          .from('orders')
          .select('company_id')
          .eq('id', orderId)
          .single()

        const companyId = orderData?.company_id

        // Use service role client for storage operations (bypasses RLS)
        const serviceSupabase = createServiceClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          {
            auth: {
              autoRefreshToken: false,
              persistSession: false
            }
          }
        )

        // Upload PDF to storage using service role
        // Use friendly filename format: {orderId}/{filename} for organized storage
        // filename already contains order number from pdf-generation.ts (e.g., "ORD-0101-25-0001-PO.pdf")
        const pdfStoragePath = `${orderId}/${filename}`
        const { data: uploadData, error: uploadError } = await serviceSupabase.storage
          .from('order-documents')
          .upload(pdfStoragePath, buffer, {
            contentType: 'application/pdf',
            cacheControl: '3600',
            upsert: true  // Allow overwriting existing files
          })

        if (uploadError) {
          console.error('Error uploading generated PDF to storage:', uploadError)
        } else if (uploadData) {
          // Save reference in document_files using service role (bypasses RLS)
          const { error: insertError } = await serviceSupabase
            .from('document_files')
            .insert({
              document_id: documentId,
              file_url: uploadData.path,
              file_name: filename,
              file_size: buffer.length,
              mime_type: 'application/pdf',
              company_id: companyId,
              uploaded_by: user?.id
            })

          if (insertError) {
            console.error('Error saving PDF cache reference:', insertError)
          } else {
            console.log('📄 PDF cached successfully:', filename)
          }
        }
      } catch (cacheErr) {
        console.error('Failed to cache PDF:', cacheErr)
        // Don't fail the request if caching fails
      }
    }

    return new NextResponse(buffer as any, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.length),
        // PDF size info headers for frontend notification
        'X-PDF-Size': String(sizeInfo.fileSize),
        'X-PDF-Size-Formatted': sizeInfo.fileSizeFormatted,
        'X-PDF-Compression-Summary': encodeURIComponent(sizeInfo.compressionSummary),
      },
    })
  } catch (error: any) {
    console.error('Error generating PDF:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to generate PDF' },
      { status: 500 }
    )
  }
}
