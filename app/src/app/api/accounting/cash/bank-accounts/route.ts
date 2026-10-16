import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET  /api/accounting/cash/bank-accounts — List bank accounts
 * POST /api/accounting/cash/bank-accounts — Create a new bank account
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
    if (!(await financeAllowed(user.id, 'finance.cash.view', () => true, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const orgId = userData.organization_id

    // Fetch bank accounts with their linked GL account info
    const { data: accounts, error } = await supabase
      .from('bank_accounts')
      .select(`
        id, account_name, bank_name, account_number, bank_code, branch,
        currency_code, gl_account_id, opening_balance, opening_balance_date, statement_frequency, current_balance,
        is_active, is_default, notes, created_at, updated_at
      `)
      .eq('company_id', orgId)
      .order('is_default', { ascending: false })
      .order('account_name', { ascending: true })

    if (error) {
      console.error('Error fetching bank accounts:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Get linked GL account details
    const glAccountIds = (accounts || []).map((a: any) => a.gl_account_id).filter(Boolean)
    const glMap: Record<string, { code: string; name: string }> = {}
    if (glAccountIds.length > 0) {
      const { data: glAccounts } = await supabase
        .from('gl_accounts')
        .select('id, code, name')
        .in('id', glAccountIds)
      if (glAccounts) {
        for (const g of glAccounts) glMap[g.id] = { code: g.code, name: g.name }
      }
    }

    // Get available GL cash/bank accounts for linking
    const { data: cashAccounts } = await supabase
      .from('gl_accounts')
      .select('id, code, name, account_type')
      .eq('company_id', orgId)
      .eq('account_type', 'ASSET')
      .eq('is_active', true)
      .order('code', { ascending: true })

    // Bank balance per statement: closing balance of the latest approved
    // (completed) statement of each account. This is the bank's figure;
    // current_balance stays the book balance used by reconciliation.
    // Rows the user may not read (RLS) simply leave it empty.
    const accountIds = (accounts || []).map((a: any) => a.id)
    const statementMap: Record<string, { balance: number; date: string }> = {}
    if (accountIds.length > 0) {
      const { data: statements } = await (supabase as any)
        .from('bank_statement_imports')
        .select('bank_account_id, closing_balance, period_end')
        .eq('company_id', orgId)
        .eq('status', 'completed')
        .in('bank_account_id', accountIds)
        .order('period_end', { ascending: false })
      for (const s of statements || []) {
        if (!statementMap[s.bank_account_id] && s.closing_balance !== null && s.period_end) {
          statementMap[s.bank_account_id] = { balance: Number(s.closing_balance), date: s.period_end }
        }
      }
    }

    const result = (accounts || []).map((a: any) => ({
      ...a,
      gl_account: glMap[a.gl_account_id] || null,
      statement_balance: statementMap[a.id]?.balance ?? null,
      statement_balance_date: statementMap[a.id]?.date ?? null,
    }))

    return NextResponse.json({
      accounts: result,
      availableGLAccounts: cashAccounts || [],
      total: result.length,
    })
  } catch (error) {
    console.error('Error in bank accounts API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
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
    if (!(await financeAllowed(user.id, 'finance.reconciliation.perform', () => true, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const { account_name, bank_name, account_number, bank_code, branch, currency_code, gl_account_id, opening_balance, opening_balance_date, statement_frequency, is_default, notes } = body

    if (!account_name || !bank_name || !account_number) {
      return NextResponse.json({ error: 'Account name, bank name, and account number are required' }, { status: 400 })
    }

    // If setting as default, unset existing default first
    if (is_default) {
      await supabase
        .from('bank_accounts')
        .update({ is_default: false })
        .eq('company_id', userData.organization_id)
        .eq('is_default', true)
    }

    const { data: newAccount, error } = await (supabase as any)
      .from('bank_accounts')
      .insert({
        company_id: userData.organization_id,
        account_name,
        bank_name,
        account_number,
        bank_code: bank_code || null,
        branch: branch || null,
        currency_code: currency_code || 'MYR',
        gl_account_id: gl_account_id || null,
        opening_balance: opening_balance || 0,
        opening_balance_date: isDate(opening_balance_date) ? opening_balance_date : null,
        statement_frequency: statement_frequency === 'daily' ? 'daily' : 'monthly',
        current_balance: opening_balance || 0,
        is_default: is_default || false,
        notes: notes || null,
        created_by: user.id,
        updated_by: user.id,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating bank account:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ account: newAccount }, { status: 201 })
  } catch (error) {
    console.error('Error in bank accounts create API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
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
    if (!(await financeAllowed(user.id, 'finance.reconciliation.perform', () => true, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const { id } = body ?? {}

    if (!id) {
      return NextResponse.json({ error: 'Bank account id is required' }, { status: 400 })
    }

    // Only known fields can be changed (balances maintained by the system are not editable here).
    const updates: Record<string, unknown> = {}
    for (const key of EDITABLE_FIELDS) if (key in body) updates[key] = body[key]
    if ('opening_balance_date' in updates && updates.opening_balance_date !== null && !isDate(updates.opening_balance_date)) {
      return NextResponse.json({ error: 'Opening balance date must be YYYY-MM-DD' }, { status: 400 })
    }
    if ('statement_frequency' in updates && !['monthly', 'daily'].includes(String(updates.statement_frequency))) {
      return NextResponse.json({ error: 'Statement frequency must be monthly or daily' }, { status: 400 })
    }

    // The opening balance (and its date) and the statement frequency are
    // locked after creation: only a Super Admin may change them. The database
    // trigger enforces and logs the same rule.
    if ('opening_balance' in updates || 'opening_balance_date' in updates || 'statement_frequency' in updates) {
      const { data: current } = await (supabase as any)
        .from('bank_accounts')
        .select('opening_balance, opening_balance_date, statement_frequency')
        .eq('id', id)
        .eq('company_id', userData.organization_id)
        .maybeSingle()
      if (!current) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
      const balanceChanged = 'opening_balance' in updates && Number(updates.opening_balance ?? 0) !== Number((current as any).opening_balance ?? 0)
      const dateChanged = 'opening_balance_date' in updates && (updates.opening_balance_date ?? null) !== ((current as any).opening_balance_date ?? null)
      const frequencyChanged = 'statement_frequency' in updates && updates.statement_frequency !== ((current as any).statement_frequency ?? 'monthly')
      if (!balanceChanged) delete updates.opening_balance
      if (!dateChanged) delete updates.opening_balance_date
      if (!frequencyChanged) delete updates.statement_frequency
      if ((balanceChanged || dateChanged || frequencyChanged) && !(await isSuperAdmin(supabase, user.id))) {
        return NextResponse.json({
          error: balanceChanged || dateChanged
            ? 'Only a Super Admin can change the opening balance or its date.'
            : 'Only a Super Admin can change the statement frequency.',
        }, { status: 403 })
      }
    }

    // If setting as default, unset existing default first
    if (updates.is_default) {
      await supabase
        .from('bank_accounts')
        .update({ is_default: false })
        .eq('company_id', userData.organization_id)
        .eq('is_default', true)
    }

    const { data: updated, error } = await (supabase as any)
      .from('bank_accounts')
      .update({ ...updates, updated_by: user.id, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', userData.organization_id)
      .select()
      .single()

    if (error) {
      console.error('Error updating bank account:', error)
      if (/bank_account_opening_balance_locked/.test(error.message)) {
        return NextResponse.json({ error: 'Only a Super Admin can change the opening balance or its date.' }, { status: 403 })
      }
      if (/bank_account_statement_frequency_locked/.test(error.message)) {
        return NextResponse.json({ error: 'Only a Super Admin can change the statement frequency.' }, { status: 403 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ account: updated })
  } catch (error) {
    console.error('Error in bank accounts update API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

const EDITABLE_FIELDS = [
  'account_name', 'bank_name', 'account_number', 'bank_code', 'branch', 'currency_code',
  'gl_account_id', 'opening_balance', 'opening_balance_date', 'statement_frequency', 'is_active', 'is_default', 'notes',
] as const

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** Same rule as public.sa_legacy_is_super_admin: active user with role level 1. */
async function isSuperAdmin(supabase: any, userId: string) {
  const { data } = await supabase
    .from('users')
    .select('is_active, roles:role_code ( role_level )')
    .eq('id', userId)
    .single()
  const role = Array.isArray(data?.roles) ? data.roles[0] : data?.roles
  return data?.is_active === true && Number(role?.role_level) === 1
}
