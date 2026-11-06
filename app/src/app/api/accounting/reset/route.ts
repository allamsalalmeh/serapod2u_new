import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/accounting/reset
 * DEV-ONLY: Reset accounting setup for a company
 * 
 * This endpoint:
 * 1. Clears gl_settings (sets all account mappings to null)
 * 2. Deletes all gl_accounts for the company
 * 3. If journals exist: deletes gl_document_postings, gl_journal_lines, gl_journals
 * 
 * SAFETY GUARDS:
 * - Only available when ALLOW_DEV_RESET=true, OR in a development build that
 *   talks to a LOCAL Supabase (localhost / 127.0.0.1). A dev server pointed at
 *   staging or production (e.g. `npm run dev` with the stg Supabase URL) can
 *   no longer wipe that shared database.
 * - Requires HQ Admin role
 * - Requires confirmation token in request body
 */

function isLocalSupabase(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** Single source of truth for both the UI check (GET) and the action (POST). */
function resetAllowed(): { allowed: boolean; reason: string } {
  if (process.env.ALLOW_DEV_RESET === 'true') return { allowed: true, reason: 'ALLOW_DEV_RESET' }
  if (process.env.NODE_ENV === 'production') return { allowed: false, reason: 'production build' }
  if (!isLocalSupabase()) return { allowed: false, reason: 'database is not local' }
  return { allowed: true, reason: 'local development database' }
}

export async function POST(request: NextRequest) {
  try {
    // CRITICAL: Check if reset is allowed
    const guard = resetAllowed()
    if (!guard.allowed) {
      return NextResponse.json(
        { error: `Reset not allowed (${guard.reason})` },
        { status: 403 }
      )
    }

    // Check feature flag
    if (process.env.NEXT_PUBLIC_ACCOUNTING_ENABLED !== 'true') {
      return NextResponse.json(
        { error: 'Accounting module is not enabled' },
        { status: 403 }
      )
    }

    const supabase = await createClient() as any
    
    // Parse request body
    const body = await request.json()
    const { confirmationToken } = body
    
    // Require confirmation token
    if (confirmationToken !== 'RESET') {
      return NextResponse.json(
        { error: 'Invalid confirmation. Type "RESET" to confirm.' },
        { status: 400 }
      )
    }
    
    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user details and check permissions
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('organization_id, role_code, roles!inner(role_level)')
      .eq('id', user.id)
      .single()

    if (userError || !userData) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Check if user is HQ Admin (role_level <= 20)
    const roleLevel = (userData.roles as any)?.role_level || 999
    if (!(await financeAllowed(user.id, 'finance.data.reset', () => roleLevel <= 20, userData.organization_id))) {
      return NextResponse.json(
        { error: 'Insufficient permissions. HQ Admin required.' },
        { status: 403 }
      )
    }

    // Get company_id
    const { data: companyId, error: companyError } = await supabase
      .rpc('get_company_id', { p_org_id: userData.organization_id })

    if (companyError || !companyId) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    }

    const deletedCounts = {
      settings: 0,
      accounts: 0,
      journals: 0,
      journalLines: 0,
      documentPostings: 0
    }

    // ORDER MATTERS: Delete in reverse dependency order
    // gl_settings has FK to gl_accounts, so delete settings first
    // gl_journal_lines has FK to gl_accounts, so delete lines before accounts

    // 1. Delete gl_settings FIRST (has FK to gl_accounts)
    try {
      const { data: settings, error: settingsError } = await supabase
        .from('gl_settings')
        .delete()
        .eq('company_id', companyId)
        .select('id')

      if (!settingsError) {
        deletedCounts.settings = settings?.length || 0
      } else {
        console.error('Error deleting settings:', settingsError)
      }
    } catch (e) {
      // Table might not exist yet, ignore
      console.error('gl_settings delete error:', e)
    }

    // 1b. Clear actual-payment state (payments, document closures) before journals.
    try {
      const { error: paymentsError } = await supabase.rpc('fin_reset_payment_state')
      if (paymentsError) console.error('Error clearing payment state:', paymentsError)
    } catch (e) {
      // Function might not exist yet, ignore
    }

    // 1c. Clear reversal records and journal-to-journal links so journals can be deleted.
    try {
      const { error: reversalsError } = await supabase.rpc('fin_reset_journal_reversals')
      if (reversalsError) console.error('Error clearing journal reversals:', reversalsError)
    } catch (e) {
      // Function might not exist yet, ignore
    }

    // 2. Delete gl_document_postings (if table exists)
    try {
      const { data: postings, error: postingsError } = await supabase
        .from('gl_document_postings')
        .delete()
        .eq('company_id', companyId)
        .select('id')

      if (!postingsError) {
        deletedCounts.documentPostings = postings?.length || 0
      }
    } catch (e) {
      // Table might not exist yet, ignore
    }

    // 3. Delete gl_journal_lines (via journal cascade, but be explicit)
    try {
      // First get journal IDs for this company
      const { data: journals } = await supabase
        .from('gl_journals')
        .select('id')
        .eq('company_id', companyId)

      if (journals && journals.length > 0) {
        const journalIds = journals.map((j: any) => j.id)
        
        const { data: lines, error: linesError } = await supabase
          .from('gl_journal_lines')
          .delete()
          .in('journal_id', journalIds)
          .select('id')

        if (!linesError) {
          deletedCounts.journalLines = lines?.length || 0
        }
      }
    } catch (e) {
      // Table might not exist yet, ignore
    }

    // 4. Delete gl_journals
    try {
      const { data: journals, error: journalsError } = await supabase
        .from('gl_journals')
        .delete()
        .eq('company_id', companyId)
        .select('id')

      if (!journalsError) {
        deletedCounts.journals = journals?.length || 0
      }
    } catch (e) {
      // Table might not exist yet, ignore
    }

    // 5. Delete gl_accounts LAST (after all FKs removed)
    try {
      const { data: accounts, error: accountsError } = await supabase
        .from('gl_accounts')
        .delete()
        .eq('company_id', companyId)
        .select('id')

      if (!accountsError) {
        deletedCounts.accounts = accounts?.length || 0
      } else {
        console.error('Error deleting accounts:', accountsError)
        return NextResponse.json(
          { error: `Failed to delete accounts: ${accountsError.message}` },
          { status: 500 }
        )
      }
    } catch (e) {
      console.error('Error in accounts deletion:', e)
      return NextResponse.json(
        { error: 'Failed to delete accounts' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      message: 'Accounting setup reset successfully',
      deleted: deletedCounts,
      isDevMode: true
    })

  } catch (error) {
    console.error('Error in POST /api/accounting/reset:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * GET /api/accounting/reset
 * Check if reset is available (for UI conditional rendering)
 */
export async function GET(_request: NextRequest) {
  const guard = resetAllowed()
  return NextResponse.json({
    resetAvailable: guard.allowed,
    reason: guard.reason,
    environment: process.env.NODE_ENV || 'development'
  })
}
