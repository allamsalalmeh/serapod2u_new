import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { parsePaymentDocumentAction } from '@/modules/finance/supplierPayment'

/**
 * POST /api/accounting/payment-documents/[id]
 * Close a supplier payment document with no further payment ("Mark as complete",
 * finance.journal.post) or reopen one closed by mistake (finance.payment.approve).
 * Body: { action: 'close' | 'reopen', reason: string }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const parsed = parsePaymentDocumentAction(id, await request.json().catch(() => ({})))
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    const { action, reason } = parsed.value

    const { data: financeActor } = await (supabase as any)
      .from('users').select('organization_id').eq('id', user.id).maybeSingle()
    const permission = action === 'reopen' ? 'finance.payment.approve' : 'finance.journal.post'
    if (!(await financeAllowed(user.id, permission, () => true, financeActor?.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data, error } = await (supabase as any).rpc(
      action === 'reopen' ? 'fin_reopen_payment_document' : 'fin_close_payment_document',
      { p_document_id: id, p_reason: reason },
    )

    if (error) {
      console.error(`Error (${action}) on payment document:`, error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data?.success) {
      return NextResponse.json({ error: data?.error || 'Action failed' }, { status: 400 })
    }
    return NextResponse.json(data)
  } catch (error) {
    console.error('Error in payment documents API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
