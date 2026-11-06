import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { financeToday, isValidPostingDate } from '@/modules/finance/postingDate'

/**
 * GET /api/accounting/posting/preview
 * Get posting preview for a document
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { data: financeActor } = await (supabase as any).from('users').select('organization_id').eq('id', user.id).maybeSingle()
    if (!(await financeAllowed(user.id, 'finance.ledger.view', () => true, financeActor?.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const documentType = searchParams.get('documentType')
    const documentId = searchParams.get('documentId')

    if (!documentType || !documentId) {
      return NextResponse.json({ 
        error: 'documentType and documentId are required' 
      }, { status: 400 })
    }

    // Call the RPC function (using 'any' since RPC not in generated types yet)
    const { data, error } = await (supabase as any).rpc('get_posting_preview', {
      p_document_type: documentType,
      p_document_id: documentId
    })

    if (error) {
      console.error('Error getting posting preview:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Error in posting preview API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/accounting/posting
 * Post document to GL using document type and document ID
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { data: financeActor } = await (supabase as any).from('users').select('organization_id').eq('id', user.id).maybeSingle()
    if (!(await financeAllowed(user.id, 'finance.journal.post', () => true, financeActor?.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const { documentType, documentId, postingDate } = body

    if (!documentType || !documentId) {
      return NextResponse.json({ 
        error: 'documentType and documentId are required' 
      }, { status: 400 })
    }

    // Validate document type
    const validTypes = [
      'SUPPLIER_DEPOSIT_PAYMENT',
      'SUPPLIER_INVOICE_RECOGNITION', 
      'SUPPLIER_BALANCE_PAYMENT',
      'SALES_INVOICE',
      'RECEIPT'
    ]
    
    if (!validTypes.includes(documentType)) {
      return NextResponse.json({ 
        error: `Invalid document type. Must be one of: ${validTypes.join(', ')}` 
      }, { status: 400 })
    }

    // The posting date is a Malaysian calendar date. It may be in the past (a
    // document posted on its own date) but never in the future; closed periods
    // are refused by the database.
    const today = financeToday()
    if (postingDate !== undefined && postingDate !== null && postingDate !== '') {
      if (!isValidPostingDate(postingDate)) {
        return NextResponse.json({ error: 'postingDate must be a valid date (YYYY-MM-DD)' }, { status: 400 })
      }
      if (postingDate > today) {
        return NextResponse.json({ error: 'Posting date cannot be in the future' }, { status: 400 })
      }
    }

    // Call the post_document_to_gl RPC function
    // Using 'any' since RPC not in generated types yet
    const { data, error } = await (supabase as any).rpc('post_document_to_gl', {
      p_document_type: documentType,
      p_document_id: documentId,
      p_posting_date: postingDate || today
    })

    if (error) {
      console.error('Error posting to GL:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Check if the RPC returned an error
    const result = data as any
    if (result && !result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Error in posting API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
