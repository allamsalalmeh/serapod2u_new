import { financeAllowed } from '@/lib/security-access/finance'
import { loadAgingReport } from '@/lib/accounting/subledger-data'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/ap/aging?asAt=YYYY-MM-DD
 * Accounts payable aging (purchases): open balance of every posted supplier invoice
 * after the money actually paid, by supplier and age (days since the invoice was
 * posted). Money paid on invoices not posted yet is shown as advances.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: userData } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single()

    if (!userData?.organization_id) {
      return NextResponse.json({ error: 'User has no organization' }, { status: 400 })
    }
    if (!(await financeAllowed(user.id, 'finance.payable.view', () => true, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const asAtParam = searchParams.get('asAt')
    const asAtDate = asAtParam && /^\d{4}-\d{2}-\d{2}$/.test(asAtParam) ? asAtParam : new Date().toISOString().split('T')[0]

    const { rows, totals, error } = await loadAgingReport(createAdminClient() as any, {
      companyId: userData.organization_id,
      side: 'AP',
      asOf: asAtDate,
    })
    if (error) {
      console.error('Error building AP aging:', error)
      return NextResponse.json({ error }, { status: 500 })
    }

    return NextResponse.json({ aging: rows, totals, asAtDate, partyCount: rows.length })
  } catch (error) {
    console.error('Error in AP aging API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
