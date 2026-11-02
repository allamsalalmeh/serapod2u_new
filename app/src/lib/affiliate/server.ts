import { createClient } from '@/lib/supabase/server'
import { normalizeAffiliateCode } from '@/lib/outdoor/sales-tools'
import {
  DEFAULT_AFFILIATE_PROGRAM_SETTINGS,
  eligibleGoodsAmount,
  HOST_REF_DAYS,
  isSelfReferral,
  normalizeSubId,
  programIsLive,
  programSettingsFromRow,
  withinAttribution,
  type AffiliateProgramSettings,
  type EligibilityProduct,
} from '@/lib/affiliate/program'

/** Tables not migrated yet: the program is off. */
export function isMissingAffiliateTable(error: any) {
  return /affiliate_(program_settings|commissions|payouts)|PGRST205|PGRST202|42P01|42883|does not exist|schema cache/i.test(
    `${error?.code || ''} ${error?.message || ''}`,
  )
}

export async function loadAffiliateProgramSettings(supabase: any): Promise<AffiliateProgramSettings> {
  const { data, error } = await supabase.from('affiliate_program_settings').select('*').eq('id', 1).maybeSingle()
  if (error) {
    if (!isMissingAffiliateTable(error)) console.error('[affiliate] settings', error)
    return { ...DEFAULT_AFFILIATE_PROGRAM_SETTINGS }
  }
  return programSettingsFromRow(data)
}

/** Brings the commission ledger up to date with the orders; never throws. */
export async function syncAffiliateCommissions(supabase: any) {
  try {
    const { error } = await supabase.rpc('affiliate_sync_commissions')
    if (error && !isMissingAffiliateTable(error)) console.error('[affiliate] sync', error)
  } catch (err) {
    console.error('[affiliate] sync', err)
  }
}

export async function loadEligibilityProducts(supabase: any, productIds: string[]) {
  const map = new Map<string, EligibilityProduct>()
  const unique = [...new Set(productIds.filter(Boolean))]
  if (unique.length === 0) return map
  const { data } = await supabase.from('products').select('id, is_vape, category_id').in('id', unique)
  for (const row of data || []) map.set(String(row.id), { id: String(row.id), is_vape: row.is_vape, category_id: row.category_id })
  return map
}

type CheckoutAffiliateInput = {
  channel: 'store' | 'outdoor'
  /** What the Outdoor checkout already resolved (live hosts keep exactly that). */
  outdoorResolved: { id: string; code: string } | null
  code: unknown
  subId: unknown
  clickedAt: unknown
  buyer: { email?: string | null; phone?: string | null }
  lines: Array<{ variant_id: string; subtotal: number }>
  variants: Array<{ id: string; product_id?: string | null }>
}

export type CheckoutAffiliate = {
  affiliate: { id: string; code: string } | null
  /** Extra storefront_orders columns for program orders. */
  columns: Record<string, unknown>
}

async function signedInUserId() {
  try {
    const session = await createClient()
    const { data } = await session.auth.getUser()
    return data?.user?.id || null
  } catch {
    return null
  }
}

/**
 * Who earns from this order. Live hosts on Outdoor keep their old behaviour (30-day link,
 * no program columns). Program affiliates need the program on, a click inside the
 * window and a buyer who is not the affiliate; the rate and the eligible goods value
 * are saved on the order. On any error Outdoor keeps what it resolved and Store gets none.
 */
export async function resolveCheckoutAffiliate(supabase: any, input: CheckoutAffiliateInput): Promise<CheckoutAffiliate> {
  const fallback: CheckoutAffiliate = { affiliate: input.channel === 'outdoor' ? input.outdoorResolved : null, columns: {} }
  const none: CheckoutAffiliate = { affiliate: null, columns: {} }
  try {
    const code = normalizeAffiliateCode(input.code)
    if (!code) return fallback
    const { data: row, error } = await supabase
      .from('outdoor_affiliates')
      .select('*')
      .eq('code', code)
      .eq('is_active', true)
      .maybeSingle()
    if (error || !row) return fallback

    if (row.kind !== 'affiliate') {
      if (input.channel !== 'outdoor') return none
      return withinAttribution(input.clickedAt, HOST_REF_DAYS) ? fallback : none
    }

    const settings = await loadAffiliateProgramSettings(supabase)
    if (!settings.enabled) {
      return input.channel === 'outdoor' && row.commission_mode !== 'program' ? fallback : none
    }
    if (!withinAttribution(input.clickedAt, settings.attributionDays)) return none
    const buyer = { ...input.buyer, userId: await signedInUserId() }
    if (isSelfReferral(row, buyer)) return none

    const percent = row.commission_mode === 'program' ? settings.commissionPercent : Number(row.commission_percent)
    if (percent == null || !Number.isFinite(percent) || !programIsLive({ ...settings, commissionPercent: percent })) return none

    const productOf = new Map(input.variants.map((v) => [String(v.id), String(v.product_id || '')]))
    const products = await loadEligibilityProducts(supabase, [...productOf.values()])
    const eligible = eligibleGoodsAmount(
      input.lines.map((line) => ({ productId: productOf.get(String(line.variant_id)), subtotal: line.subtotal })),
      products,
      settings,
    )
    return {
      affiliate: { id: String(row.id), code: String(row.code) },
      columns: {
        affiliate_sub_id: normalizeSubId(input.subId) || null,
        affiliate_commission_percent: percent,
        affiliate_eligible_amount: eligible,
      },
    }
  } catch (err) {
    console.error('[affiliate] checkout', err)
    return fallback
  }
}
