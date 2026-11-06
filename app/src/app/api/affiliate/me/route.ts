/**
 * /api/affiliate/me — the signed-in shopper's own affiliate account.
 * GET                  program, own account, earnings, payouts
 * GET ?productId=ID    can this person share that product (Share & earn button)
 * GET ?links=1         products they can link to
 * POST { action: join | update_bank }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { listProducts } from '@/lib/storefront/products'
import { listOutdoorProducts } from '@/lib/outdoor/catalog'
import {
  AFFILIATE_STATUS_LABELS,
  isProductEligible,
  programIsLive,
  roundRm,
  suggestAffiliateCode,
  validBankDetails,
  type AffiliateProgramSettings,
  type AffiliateStatus,
} from '@/lib/affiliate/program'
import { loadAffiliateProgramSettings, loadEligibilityProducts } from '@/lib/affiliate/server'

export const dynamic = 'force-dynamic'

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

function programView(s: AffiliateProgramSettings) {
  return {
    open: programIsLive(s),
    joinMode: s.joinMode,
    commissionPercent: s.commissionPercent,
    attributionDays: s.attributionDays,
    confirmAfterDays: s.confirmAfterDays,
    minPayoutAmount: s.minPayoutAmount,
    terms: s.terms,
    termsVersion: s.termsVersion,
  }
}

function accountView(row: any) {
  const status = (row.status || 'approved') as AffiliateStatus
  return {
    code: String(row.code),
    name: String(row.name || ''),
    status,
    statusLabel: AFFILIATE_STATUS_LABELS[status] || status,
    reviewNote: status === 'rejected' || status === 'suspended' ? row.review_note || '' : '',
    bankName: row.bank_name || '',
    bankAccountNo: row.bank_account_no || '',
    bankAccountName: row.bank_account_name || '',
    termsVersionAccepted: Number(row.terms_version_accepted) || null,
    joinedAt: row.applied_at || row.created_at,
  }
}

function shortRef(ref: unknown) {
  const value = String(ref || '')
  return value.length > 4 ? `…${value.slice(-4)}` : value
}

async function currentUser() {
  const session = await createClient()
  const { data } = await session.auth.getUser()
  return data?.user || null
}

async function ownAffiliate(admin: any, userId: string) {
  const { data, error } = await admin.from('outdoor_affiliates').select('*').eq('user_id', userId).maybeSingle()
  if (error) throw new Error(`Affiliate account lookup failed: ${error.message}`)
  return data
}

async function earnings(admin: any, affiliateId: string) {
  const sync = await admin.rpc('affiliate_sync_commissions')
  if (sync.error) throw new Error(`Affiliate ledger sync failed: ${sync.error.message}`)
  const [
    { data: totalsRows, error: totalsError },
    { data: rows, error: commissionsError },
    { data: payouts, error: payoutsError },
  ] = await Promise.all([
    admin.rpc('affiliate_commission_totals', { p_affiliate_id: affiliateId }),
    admin
      .from('affiliate_commissions')
      .select('order_ref, sales_channel, sub_id, eligible_amount, commission_percent, commission_amount, status, ordered_at, delivered_at, confirmed_at')
      .eq('affiliate_id', affiliateId)
      .order('ordered_at', { ascending: false })
      .limit(500),
    admin
      .from('affiliate_payouts')
      .select('amount, commission_count, transfer_reference, paid_at')
      .eq('affiliate_id', affiliateId)
      .order('paid_at', { ascending: false })
      .limit(100),
  ])
  if (totalsError) throw new Error(`Affiliate totals failed: ${totalsError.message}`)
  if (commissionsError) throw new Error(`Affiliate commission history failed: ${commissionsError.message}`)
  if (payoutsError) throw new Error(`Affiliate payout history failed: ${payoutsError.message}`)
  const total = totalsRows?.[0]
  const totals = {
    pending: roundRm(Number(total?.pending) || 0),
    confirmed: roundRm(Number(total?.confirmed) || 0),
    paid: roundRm(Number(total?.paid) || 0),
    cancelled: roundRm(Number(total?.cancelled) || 0),
    orders: Number(total?.orders) || 0,
  }
  return {
    totals,
    commissions: (rows || []).map((row: any) => ({
      order: shortRef(row.order_ref),
      channel: row.sales_channel === 'outdoor' ? 'Outdoor' : 'Store',
      subId: row.sub_id || '',
      goods: Number(row.eligible_amount) || 0,
      percent: Number(row.commission_percent) || 0,
      amount: Number(row.commission_amount) || 0,
      status: row.status,
      orderedAt: row.ordered_at,
    })),
    payouts: (payouts || []).map((p: any) => ({
      amount: Number(p.amount) || 0,
      count: Number(p.commission_count) || 0,
      reference: p.transfer_reference,
      paidAt: p.paid_at,
    })),
  }
}

async function linkProducts(admin: any, settings: AffiliateProgramSettings) {
  const [store, outdoor] = await Promise.all([
    listProducts({ sort: 'name_asc', limit: 200 }).catch(() => ({ products: [] as any[] })),
    listOutdoorProducts({ sort: 'name_asc', limit: 200 }).catch(() => ({ products: [] as any[] })),
  ])
  const all = [
    ...(store.products || []).map((p: any) => ({ p, channel: 'store' as const, path: `/store/products/${p.id}` })),
    ...(outdoor.products || []).map((p: any) => ({ p, channel: 'outdoor' as const, path: `/outdoor/shop/${p.id}` })),
  ]
  const eligibility = await loadEligibilityProducts(admin, all.map((x) => String(x.p.id)))
  const seen = new Set<string>()
  return all
    .filter((x) => isProductEligible(eligibility.get(String(x.p.id)), settings))
    .filter((x) => {
      const key = `${x.channel}:${x.p.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((x) => ({
      id: String(x.p.id),
      name: String(x.p.product_name || ''),
      imageUrl: x.p.image_url || null,
      channel: x.channel,
      path: x.path,
    }))
}

export async function GET(request: NextRequest) {
  try {
    const admin: any = createAdminClient()
    const settings = await loadAffiliateProgramSettings(admin)
    const program = programView(settings)
    const user = await currentUser()
    if (!user) return NextResponse.json({ signedIn: false, program, affiliate: null })

    const row = await ownAffiliate(admin, user.id)
    const affiliate = row ? accountView(row) : null
    const acceptedCurrentTerms = Boolean(row && (row.source !== 'self' || Number(row.terms_version_accepted) === settings.termsVersion))
    const approved = Boolean(row && row.status === 'approved' && row.is_active !== false && acceptedCurrentTerms)
    const params = request.nextUrl.searchParams

    const productId = params.get('productId')
    if (productId) {
      const products = await loadEligibilityProducts(admin, [productId])
      const percent = row?.commission_mode === 'custom' ? Number(row.commission_percent) || 0 : program.commissionPercent
      return NextResponse.json({
        signedIn: true,
        canShare: program.open && approved && isProductEligible(products.get(productId), settings),
        code: approved ? affiliate!.code : null,
        commissionPercent: percent,
      })
    }

    if (params.get('links') === '1') {
      if (!program.open || !approved) return NextResponse.json({ products: [] })
      return NextResponse.json({ products: await linkProducts(admin, settings) })
    }

    return NextResponse.json({
      signedIn: true,
      email: user.email || '',
      program,
      affiliate,
      ...(row ? await earnings(admin, String(row.id)) : {}),
    })
  } catch (err) {
    console.error('[affiliate/me GET]', err)
    return bad('Could not load your affiliate account.', 500)
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await currentUser()
    if (!user) return bad('Sign in first.', 401)
    const admin: any = createAdminClient()
    const body = await request.json().catch(() => ({}))
    const now = new Date().toISOString()
    const existing = await ownAffiliate(admin, user.id)

    if (body?.action === 'accept_terms') {
      if (!existing) return bad('Join the program first.')
      if (body.agree !== true) return bad('Please accept the program terms.')
      const settings = await loadAffiliateProgramSettings(admin)
      if (!programIsLive(settings)) return bad('The affiliate program is not open yet.', 403)
      const { error } = await admin
        .from('outdoor_affiliates')
        .update({ terms_version_accepted: settings.termsVersion, terms_accepted_at: now, updated_at: now })
        .eq('id', existing.id)
        .eq('user_id', user.id)
      if (error) return bad('Could not accept the updated terms.', 500)
      return NextResponse.json({ ok: true })
    }

    if (body?.action === 'update_bank') {
      if (!existing) return bad('Join the program first.')
      const bank = validBankDetails({ bankName: body.bankName, accountNo: body.bankAccountNo, accountName: body.bankAccountName })
      if ('error' in bank) return bad(bank.error!)
      const { error } = await admin
        .from('outdoor_affiliates')
        .update({ bank_name: bank.bankName, bank_account_no: bank.accountNo, bank_account_name: bank.accountName, updated_at: now })
        .eq('id', existing.id)
        .eq('user_id', user.id)
      if (error) return bad('Could not save your bank details.', 500)
      return NextResponse.json({ ok: true })
    }

    if (body?.action === 'join') {
      const settings = await loadAffiliateProgramSettings(admin)
      if (!programIsLive(settings)) return bad('The affiliate program is not open yet.', 403)
      if (body.agree !== true) return bad('Please accept the program terms.')
      if (existing && existing.status !== 'rejected') return NextResponse.json({ ok: true, status: existing.status })
      const bank = validBankDetails({ bankName: body.bankName, accountNo: body.bankAccountNo, accountName: body.bankAccountName })
      if ('error' in bank) return bad(bank.error!)

      const { data: profile } = await admin.from('users').select('full_name, email, phone').eq('id', user.id).maybeSingle()
      const name = String(profile?.full_name || bank.accountName || String(user.email || '').split('@')[0] || 'Affiliate').trim().slice(0, 120)
      const approved = settings.joinMode === 'open'
      const status = approved ? 'approved' : 'pending'
      const program = {
        status,
        is_active: approved,
        bank_name: bank.bankName,
        bank_account_no: bank.accountNo,
        bank_account_name: bank.accountName,
        applied_at: now,
        reviewed_at: approved ? now : null,
        reviewed_by: null,
        review_note: null,
        terms_version_accepted: settings.termsVersion,
        terms_accepted_at: now,
        updated_at: now,
      }

      if (existing) {
        const { error } = await admin.from('outdoor_affiliates').update(program).eq('id', existing.id).eq('user_id', user.id)
        if (error) return bad('Could not send your application.', 500)
        return NextResponse.json({ ok: true, status })
      }

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const code = suggestAffiliateCode(name)
        const { error } = await admin.from('outdoor_affiliates').insert({
          ...program,
          code,
          name,
          kind: 'affiliate',
          source: 'self',
          commission_mode: 'program',
          commission_percent: 0,
          user_id: user.id,
          contact_email: String(profile?.email || user.email || '').trim().toLowerCase() || null,
          contact_phone: profile?.phone || null,
          notes: null,
        })
        if (!error) return NextResponse.json({ ok: true, status })
        if (String(error.code) !== '23505') {
          console.error('[affiliate/me join]', error)
          return bad('Could not send your application.', 500)
        }
        if (/user_uidx|user_id/i.test(String(error.message || ''))) return NextResponse.json({ ok: true })
      }
      return bad('Could not create your code. Please try again.', 500)
    }

    return bad('Unknown action.')
  } catch (err) {
    console.error('[affiliate/me POST]', err)
    return bad('Could not save.', 500)
  }
}
