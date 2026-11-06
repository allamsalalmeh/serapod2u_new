/**
 * Affiliate program rules shared by checkout, the shopper affiliate page and
 * the admin page. Affiliates live in outdoor_affiliates (live hosts too).
 */
import { normalizeAffiliateCode, OUTDOOR_REF_DAYS } from '@/lib/outdoor/sales-tools'
import { normalizeMalaysianPhone } from '@/lib/storefront/customer-validation'

export type AffiliateJoinMode = 'open' | 'approval'
export type AffiliateStatus = 'pending' | 'approved' | 'rejected' | 'suspended'
export type AffiliateCommissionStatus = 'pending' | 'confirmed' | 'cancelled' | 'paid'

export type AffiliateProgramSettings = {
  enabled: boolean
  joinMode: AffiliateJoinMode
  commissionPercent: number | null
  attributionDays: number
  confirmAfterDays: number
  minPayoutAmount: number
  excludeVape: boolean
  excludedCategoryIds: string[]
  excludedProductIds: string[]
  terms: string
  termsVersion: number
}

export const DEFAULT_AFFILIATE_PROGRAM_SETTINGS: AffiliateProgramSettings = {
  enabled: false,
  joinMode: 'open',
  commissionPercent: null,
  attributionDays: 30,
  confirmAfterDays: 7,
  minPayoutAmount: 0,
  excludeVape: true,
  excludedCategoryIds: [],
  excludedProductIds: [],
  terms: '',
  termsVersion: 1,
}

/** Live host links keep the 30-day window they always had. */
export const HOST_REF_DAYS = OUTDOOR_REF_DAYS
export const AFFILIATE_REF_STORAGE_KEY = 'serapod_affiliate_ref'
/** How long the browser keeps a clicked link; checkout applies the program window. */
export const AFFILIATE_REF_KEEP_DAYS = 365

export const AFFILIATE_STATUS_LABELS: Record<AffiliateStatus, string> = {
  pending: 'Waiting for approval',
  approved: 'Active',
  rejected: 'Not approved',
  suspended: 'Suspended',
}

export const COMMISSION_STATUS_LABELS: Record<AffiliateCommissionStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  paid: 'Paid',
}

function num(raw: unknown): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function ids(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((id) => String(id)).filter(Boolean) : []
}

export function programSettingsFromRow(row: any): AffiliateProgramSettings {
  if (!row) return { ...DEFAULT_AFFILIATE_PROGRAM_SETTINGS }
  const d = DEFAULT_AFFILIATE_PROGRAM_SETTINGS
  return {
    enabled: row.enabled === true,
    joinMode: row.join_mode === 'approval' ? 'approval' : 'open',
    commissionPercent: num(row.commission_percent),
    attributionDays: num(row.attribution_days) ?? d.attributionDays,
    confirmAfterDays: num(row.confirm_after_days) ?? d.confirmAfterDays,
    minPayoutAmount: num(row.min_payout_amount) ?? d.minPayoutAmount,
    excludeVape: row.exclude_vape !== false,
    excludedCategoryIds: ids(row.excluded_category_ids),
    excludedProductIds: ids(row.excluded_product_ids),
    terms: typeof row.terms === 'string' ? row.terms : '',
    termsVersion: Math.max(1, num(row.terms_version) ?? 1),
  }
}

/** On and priced: people can join and orders earn commission. */
export function programIsLive(settings: AffiliateProgramSettings) {
  return settings.enabled && settings.commissionPercent != null
}

export function normalizeSubId(raw: unknown): string {
  const sub = String(raw ?? '').trim()
  return /^[A-Za-z0-9_-]{1,40}$/.test(sub) ? sub : ''
}

export type StoredAffiliateRef = { code: string; sub: string; clickedAt: number; token: string }

/** The ref saved by the link capture, while the browser still keeps it. */
export function storedAffiliateRef(stored: unknown, now = Date.now()): StoredAffiliateRef | null {
  if (!stored || typeof stored !== 'object') return null
  const { code, sub, at, token } = stored as { code?: unknown; sub?: unknown; at?: unknown; token?: unknown }
  const clickedAt = Number(at)
  const clean = normalizeAffiliateCode(code)
  const signed = typeof token === 'string' ? token.trim() : ''
  if (!clean || !signed || signed.length > 1024 || !Number.isFinite(clickedAt) || clickedAt > now + 60_000) return null
  if (now - clickedAt > AFFILIATE_REF_KEEP_DAYS * 86_400_000) return null
  return { code: clean, sub: normalizeSubId(sub), clickedAt, token: signed }
}

/** A link click is inside the window. Checkouts that do not send the click time are trusted (older pages). */
export function withinAttribution(clickedAt: unknown, days: number, now = Date.now()) {
  const at = Number(clickedAt)
  if (clickedAt === null || clickedAt === undefined || !Number.isFinite(at) || at <= 0) return true
  return now - at <= Math.max(0, days) * 86_400_000
}

export type EligibilityProduct = { id: string; is_vape?: boolean | null; category_id?: string | null }

export function isProductEligible(product: EligibilityProduct | null | undefined, settings: AffiliateProgramSettings) {
  if (!product?.id) return false
  if (settings.excludeVape && product.is_vape === true) return false
  if (settings.excludedProductIds.includes(product.id)) return false
  if (product.category_id && settings.excludedCategoryIds.includes(product.category_id)) return false
  return true
}

export function roundRm(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100
}

/** Goods value that earns commission: lines of eligible products only (delivery is never a line). */
export function eligibleGoodsAmount(
  lines: Array<{ productId: string | null | undefined; subtotal: number }>,
  products: Map<string, EligibilityProduct>,
  settings: AffiliateProgramSettings,
) {
  const cents = lines.reduce((sum, line) => {
    const product = line.productId ? products.get(line.productId) : undefined
    return isProductEligible(product, settings) ? sum + Math.round((Number(line.subtotal) || 0) * 100) : sum
  }, 0)
  return Math.max(0, cents) / 100
}

export function commissionAmount(goods: number, percent: number) {
  return roundRm((Math.max(0, goods) * Math.max(0, percent)) / 100)
}

function sameEmail(a: unknown, b: unknown) {
  const x = String(a || '').trim().toLowerCase()
  return Boolean(x) && x === String(b || '').trim().toLowerCase()
}

function samePhone(a: unknown, b: unknown) {
  const x = normalizeMalaysianPhone(String(a || ''))
  return Boolean(x) && x === normalizeMalaysianPhone(String(b || ''))
}

/** The affiliate is buying through their own link. */
export function isSelfReferral(
  affiliate: { user_id?: string | null; contact_email?: string | null; contact_phone?: string | null },
  buyer: { userId?: string | null; email?: string | null; phone?: string | null },
) {
  if (affiliate.user_id && buyer.userId && affiliate.user_id === buyer.userId) return true
  return sameEmail(affiliate.contact_email, buyer.email) || samePhone(affiliate.contact_phone, buyer.phone)
}

/** A code from the person's name plus 4 random characters, e.g. AMINAH-7K2Q. */
export function suggestAffiliateCode(name: string, random: () => number = Math.random) {
  const letters = String(name || '')
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let tail = ''
  for (let i = 0; i < 4; i += 1) tail += alphabet[Math.floor(random() * alphabet.length) % alphabet.length]
  return normalizeAffiliateCode(`${letters || 'SERA'}-${tail}`)
}

/** Our own sites: the only pages an affiliate link may point to. */
export function isShareableHost(hostname: string) {
  const host = String(hostname || '').trim().toLowerCase()
  return (
    host === 'serapod2u.com' ||
    host.endsWith('.serapod2u.com') ||
    host === 'serapod.com' ||
    host.endsWith('.serapod.com') ||
    host === 'localhost' ||
    host.endsWith('.localhost')
  )
}

/** Adds ?ref=CODE (and &sub=) to one of our pages; '' when the address is not ours. */
export function buildAffiliateLink(address: string, code: string, sub = '') {
  const clean = normalizeAffiliateCode(code)
  if (!clean) return ''
  let url: URL
  try {
    url = new URL(String(address || '').trim())
  } catch {
    return ''
  }
  if (!['http:', 'https:'].includes(url.protocol) || !isShareableHost(url.hostname)) return ''
  url.searchParams.set('ref', clean)
  const subId = normalizeSubId(sub)
  if (subId) url.searchParams.set('sub', subId)
  else url.searchParams.delete('sub')
  return url.toString()
}

export function maskAccountNo(raw: unknown) {
  const digits = String(raw || '').replace(/\s+/g, '')
  if (!digits) return ''
  return digits.length <= 4 ? digits : `•••• ${digits.slice(-4)}`
}

export function cleanAccountNo(raw: unknown) {
  return String(raw || '').replace(/[\s-]+/g, '')
}

export function validBankDetails(input: { bankName: unknown; accountNo: unknown; accountName: unknown }) {
  const bankName = String(input.bankName || '').trim()
  const accountNo = cleanAccountNo(input.accountNo)
  const accountName = String(input.accountName || '').trim()
  if (bankName.length < 2 || bankName.length > 80) return { error: 'Enter your bank name.' }
  if (!/^\d{6,20}$/.test(accountNo)) return { error: 'Account number must be 6 to 20 digits.' }
  if (accountName.length < 2 || accountName.length > 120) return { error: 'Enter the name on the bank account.' }
  return { bankName, accountNo, accountName }
}
