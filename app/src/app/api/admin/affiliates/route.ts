/**
 * /api/admin/affiliates — E-commerce › Affiliates.
 * GET   settings, affiliates with balances, commissions, payouts, products to exclude
 * POST  { action: save_settings | review | save_affiliate | record_payout }
 * Live hosts (kind 'host') stay in Outdoor › Sales tools and are not changed here.
 */

import { NextRequest, NextResponse } from 'next/server'
import { userAllowed } from '@/lib/security-access/operation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { maskAccountNo, programSettingsFromRow } from '@/lib/affiliate/program'
import { isMissingAffiliateTable } from '@/lib/affiliate/server'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

type AdminActor = {
  userId: string
  organizationId: string | null
  orgType: string | null
  roleLevel: number | null
}

async function requireAdmin(): Promise<AdminActor | null> {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  const admin = createAdminClient()
  const { data: profile } = await admin
    .from('users')
    .select('id, organization_id, role_code, organizations!fk_users_organization(id, org_type_code), roles(role_level)')
    .eq('id', user.id)
    .single()
  if (!profile) return null
  return {
    userId: user.id,
    organizationId: profile.organization_id || null,
    orgType: (profile.organizations as any)?.org_type_code || null,
    roleLevel: (profile.roles as any)?.role_level ?? null,
  }
}

async function actorAllowed(actor: AdminActor, permission: string, legacyMaxRoleLevel: number) {
  return userAllowed(
    actor.userId,
    permission,
    () => actor.orgType === 'HQ' && actor.roleLevel != null && actor.roleLevel <= legacyMaxRoleLevel && !!actor.organizationId,
    { organizationId: actor.organizationId },
  )
}

function wholeNumber(raw: unknown, min: number, max: number): number | undefined {
  const value = Number(raw)
  if (raw === null || raw === undefined || String(raw).trim() === '' || !Number.isInteger(value) || value < min || value > max) return undefined
  return value
}

function decimal(raw: unknown, min: number, max: number, { allowNull = false } = {}): number | null | undefined {
  if (raw === null || raw === undefined || String(raw).trim() === '') return allowNull ? null : undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) return undefined
  return Math.round(value * 100) / 100
}

function uuidList(raw: unknown) {
  return [...new Set((Array.isArray(raw) ? raw : []).map((id) => String(id)).filter((id) => UUID.test(id)))]
}

function text(raw: unknown, max: number) {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : ''
}

async function loadAll(admin: any, canManageProgram: boolean, canRecordPayout: boolean) {
  const syncRes = await admin.rpc('affiliate_sync_commissions')
  if (syncRes.error && isMissingAffiliateTable(syncRes.error)) return { missing: true }
  if (syncRes.error) throw new Error(`Affiliate ledger sync failed: ${syncRes.error.message}`)

  const [settingsRes, affiliatesRes, totalsRes, commissionsRes, payoutsRes, categoriesRes, productsRes] = await Promise.all([
    admin.from('affiliate_program_settings').select('*').eq('id', 1).maybeSingle(),
    admin.from('outdoor_affiliates').select('*').eq('kind', 'affiliate').order('created_at', { ascending: false }),
    admin.rpc('affiliate_commission_totals', { p_affiliate_id: null }),
    admin
      .from('affiliate_commissions')
      .select('id, affiliate_id, order_ref, sales_channel, sub_id, eligible_amount, commission_percent, commission_amount, status, ordered_at, delivered_at, confirmed_at, payout_id')
      .order('ordered_at', { ascending: false })
      .limit(1000),
    admin.from('affiliate_payouts').select('*').order('paid_at', { ascending: false }).limit(500),
    admin.from('product_categories').select('id, category_name').order('category_name'),
    admin.from('products').select('id, product_name, is_vape, category_id, is_active').eq('is_active', true).order('product_name'),
  ])
  const affiliateResults = [settingsRes, affiliatesRes, totalsRes, commissionsRes, payoutsRes]
  if (affiliateResults.some((result) => result.error && isMissingAffiliateTable(result.error))) return { missing: true }
  const failed = [...affiliateResults, categoriesRes, productsRes].find((result) => result.error)
  if (failed?.error) throw new Error(failed.error.message)

  const balances = new Map<string, { pending: number; confirmed: number; paid: number; orders: number }>()
  for (const total of totalsRes.data || []) {
    balances.set(String(total.affiliate_id), {
      pending: Number(total.pending) || 0,
      confirmed: Number(total.confirmed) || 0,
      paid: Number(total.paid) || 0,
      orders: Number(total.orders) || 0,
    })
  }
  const affiliates = (affiliatesRes.data || []).map((a: any) => ({
    id: String(a.id),
    code: String(a.code),
    name: String(a.name || ''),
    source: a.source === 'self' ? 'self' : 'staff',
    status: a.status || 'approved',
    isActive: a.is_active !== false,
    commissionMode: a.commission_mode === 'program' ? 'program' : 'custom',
    commissionPercent: Number(a.commission_percent) || 0,
    email: a.contact_email || '',
    phone: a.contact_phone || '',
    hasBankAccount: Boolean(
      String(a.bank_name || '').trim()
      && String(a.bank_account_no || '').trim()
      && String(a.bank_account_name || '').trim(),
    ),
    bankName: canRecordPayout ? a.bank_name || '' : '',
    bankAccountNo: canRecordPayout ? a.bank_account_no || '' : maskAccountNo(a.bank_account_no),
    bankAccountName: canRecordPayout ? a.bank_account_name || '' : '',
    notes: a.notes || '',
    reviewNote: a.review_note || '',
    appliedAt: a.applied_at || a.created_at,
    balance: balances.get(String(a.id)) || { pending: 0, confirmed: 0, paid: 0, orders: 0 },
  }))
  return {
    canManageProgram,
    canRecordPayout,
    settings: programSettingsFromRow(settingsRes.data),
    affiliates,
    commissions: (commissionsRes.data || []).map((c: any) => ({
      id: String(c.id),
      affiliateId: String(c.affiliate_id),
      orderRef: c.order_ref,
      channel: c.sales_channel === 'outdoor' ? 'outdoor' : 'store',
      subId: c.sub_id || '',
      goods: Number(c.eligible_amount) || 0,
      percent: Number(c.commission_percent) || 0,
      amount: Number(c.commission_amount) || 0,
      status: c.status,
      orderedAt: c.ordered_at,
      deliveredAt: c.delivered_at,
    })),
    payouts: (canRecordPayout ? payoutsRes.data || [] : []).map((p: any) => ({
      id: String(p.id),
      affiliateId: String(p.affiliate_id),
      amount: Number(p.amount) || 0,
      count: Number(p.commission_count) || 0,
      bankName: p.bank_name || '',
      bankAccountNo: p.bank_account_no || '',
      bankAccountName: p.bank_account_name || '',
      reference: p.transfer_reference,
      notes: p.notes || '',
      paidAt: p.paid_at,
    })),
    categories: (categoriesRes.data || []).map((c: any) => ({ id: String(c.id), name: String(c.category_name || '').trim() })),
    products: (productsRes.data || []).map((p: any) => ({
      id: String(p.id),
      name: String(p.product_name || ''),
      isVape: p.is_vape === true,
      categoryId: p.category_id ? String(p.category_id) : null,
    })),
  }
}

export async function GET() {
  try {
    const staff = await requireAdmin()
    if (!staff) return bad('Unauthorized', 401)
    const [canManageProgram, canRecordPayout] = await Promise.all([
      actorAllowed(staff, 'ecommerce.store.manage', 20),
      actorAllowed(staff, 'finance.payment.approve', 20),
    ])
    if (!canManageProgram && !canRecordPayout) return bad('Forbidden', 403)
    const data = await loadAll(createAdminClient(), canManageProgram, canRecordPayout)
    if ((data as any).missing) return bad('The affiliate program is not set up on this database yet.', 503)
    return NextResponse.json(data)
  } catch (err) {
    console.error('[admin/affiliates GET]', err)
    return bad('Could not load affiliates.', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const staff = await requireAdmin()
    if (!staff) return bad('Unauthorized', 401)
    const body = await request.json().catch(() => ({}))
    const action = String(body?.action || '')
    const requiredPermission = action === 'record_payout' ? 'finance.payment.approve' : 'ecommerce.store.manage'
    if (!(await actorAllowed(staff, requiredPermission, 20))) {
      return action === 'record_payout'
        ? bad('A finance payment approver must record affiliate transfers.', 403)
        : bad('Forbidden', 403)
    }
    const admin: any = createAdminClient()
    const now = new Date().toISOString()

    if (body?.action === 'save_settings') {
      const commission = decimal(body.commissionPercent, 0, 100, { allowNull: true })
      const attribution = wholeNumber(body.attributionDays, 1, 365)
      const confirm = wholeNumber(body.confirmAfterDays, 7, 180)
      const minPayout = decimal(body.minPayoutAmount, 0, 100000)
      if (commission === undefined) return bad('Commission must be 0 to 100%.')
      if (attribution === undefined) return bad('Link window must be 1 to 365 days.')
      if (confirm === undefined) return bad('Days after delivery must be 7 to 180 (after the refund window).')
      if (minPayout === undefined || minPayout === null) return bad('Minimum payout must be RM 0 or more.')
      const enabled = body.enabled === true
      if (enabled && commission === null) return bad('Set the commission % before switching the program on.')
      const nextTerms = text(body.terms, 4000)
      const { error } = await admin.from('affiliate_program_settings').upsert({
        id: 1,
        enabled,
        join_mode: body.joinMode === 'approval' ? 'approval' : 'open',
        commission_percent: commission,
        attribution_days: attribution,
        confirm_after_days: confirm,
        min_payout_amount: minPayout,
        exclude_vape: body.excludeVape !== false,
        excluded_category_ids: uuidList(body.excludedCategoryIds),
        excluded_product_ids: uuidList(body.excludedProductIds),
        terms: nextTerms || null,
        updated_at: now,
        updated_by: staff.userId,
      })
      if (error) return bad(error.message, 500)
      return NextResponse.json({ ok: true })
    }

    const id = text(body?.id ?? body?.affiliateId, 64)
    if (!UUID.test(id)) return bad('Choose an affiliate.')
    const { data: row, error: rowError } = await admin.from('outdoor_affiliates').select('*').eq('id', id).maybeSingle()
    if (rowError) return bad('Could not load the affiliate.', 500)
    if (!row || row.kind !== 'affiliate') return bad('Affiliate not found.', 404)

    if (body.action === 'review') {
      const decisions: Record<string, { status: string; active: boolean }> = {
        approve: { status: 'approved', active: true },
        reject: { status: 'rejected', active: false },
        suspend: { status: 'suspended', active: false },
        reactivate: { status: 'approved', active: true },
      }
      const decision = decisions[String(body.decision)]
      if (!decision) return bad('Unknown decision.')
      const { error } = await admin
        .from('outdoor_affiliates')
        .update({
          status: decision.status,
          is_active: decision.active,
          reviewed_at: now,
          reviewed_by: staff.userId,
          review_note: text(body.note, 500) || null,
          updated_at: now,
        })
        .eq('id', id)
      if (error) return bad(error.message, 500)
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'save_affiliate') {
      const mode = body.commissionMode === 'custom' ? 'custom' : 'program'
      const percent = mode === 'custom' ? decimal(body.commissionPercent, 0, 100) : Number(row.commission_percent) || 0
      if (percent === undefined || percent === null) return bad('Commission must be 0 to 100%.')
      const { error } = await admin
        .from('outdoor_affiliates')
        .update({ commission_mode: mode, commission_percent: percent, notes: text(body.notes, 500) || null, updated_at: now })
        .eq('id', id)
      if (error) return bad(error.message, 500)
      return NextResponse.json({ ok: true })
    }

    if (body.action === 'record_payout') {
      const reference = text(body.reference, 120)
      if (!reference) return bad('Enter the bank transfer reference.')
      const expectedAmount = decimal(body.expectedAmount, 0.01, 100000000)
      if (expectedAmount === undefined || expectedAmount === null) return bad('Refresh the payout list before recording this transfer.', 409)
      const { data, error } = await admin.rpc('affiliate_record_payout', {
        p_affiliate_id: id,
        p_reference: reference,
        p_notes: text(body.notes, 500),
        p_actor: staff.userId,
        p_expected_amount: expectedAmount,
        p_expected_bank_name: text(body.expectedBankName, 80),
        p_expected_bank_account_no: text(body.expectedBankAccountNo, 20),
        p_expected_bank_account_name: text(body.expectedBankAccountName, 120),
      })
      if (error) {
        if (/nothing_to_pay/.test(String(error.message))) return bad('Nothing confirmed to pay yet.')
        if (/snapshot_changed/.test(String(error.message))) return bad('The amount or bank details changed. Refresh before recording the transfer.', 409)
        if (/below_minimum/.test(String(error.message))) return bad('The confirmed balance is below the minimum payout.', 409)
        if (/bank_required/.test(String(error.message))) return bad('This affiliate has no complete bank account saved.', 409)
        if (/affiliate_sync|ledger sync/i.test(String(error.message))) return bad('Could not reconcile the commission ledger. No transfer was recorded.', 503)
        return bad(error.message, 500)
      }
      return NextResponse.json({ ok: true, payout: data })
    }

    return bad('Unknown action.')
  } catch (err) {
    console.error('[admin/affiliates POST]', err)
    return bad('Could not save.', 500)
  }
}
