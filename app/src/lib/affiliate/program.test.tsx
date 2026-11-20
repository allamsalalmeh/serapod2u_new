import { describe, expect, it } from 'vitest'
import {
  buildAffiliateLink,
  DEFAULT_AFFILIATE_PROGRAM_SETTINGS,
  eligibleGoodsAmount,
  isProductEligible,
  isSelfReferral,
  programIsLive,
  programSettingsFromRow,
  storedAffiliateRef,
  suggestAffiliateCode,
  validBankDetails,
  withinAttribution,
} from './program'

const day = 86_400_000
const settings = { ...DEFAULT_AFFILIATE_PROGRAM_SETTINGS, enabled: true, commissionPercent: 5 }

describe('affiliate program settings', () => {
  it('starts switched off and is live only when on and priced', () => {
    const off = programSettingsFromRow(null)
    expect(off.enabled).toBe(false)
    expect(off.excludeVape).toBe(true)
    expect(programIsLive(off)).toBe(false)
    expect(programIsLive({ ...off, enabled: true })).toBe(false)
    expect(programIsLive({ ...off, enabled: true, commissionPercent: 0 })).toBe(true)
  })

  it('reads the database row', () => {
    const s = programSettingsFromRow({
      enabled: true, join_mode: 'approval', commission_percent: '7.5', attribution_days: 14, confirm_after_days: 10,
      min_payout_amount: '50', exclude_vape: false, excluded_category_ids: ['c1'], excluded_product_ids: ['p1'], terms: 'T',
    })
    expect(s).toEqual({
      enabled: true, joinMode: 'approval', commissionPercent: 7.5, attributionDays: 14, confirmAfterDays: 10,
      minPayoutAmount: 50, excludeVape: false, excludedCategoryIds: ['c1'], excludedProductIds: ['p1'], terms: 'T', termsVersion: 1,
    })
  })
})

describe('eligible products', () => {
  const products = new Map([
    ['vape', { id: 'vape', is_vape: true, category_id: 'cv' }],
    ['mat', { id: 'mat', is_vape: false, category_id: 'co' }],
    ['food', { id: 'food', is_vape: false, category_id: 'cp' }],
  ])

  it('leaves out vapes, excluded categories and excluded products', () => {
    expect(isProductEligible(products.get('vape'), settings)).toBe(false)
    expect(isProductEligible(products.get('vape'), { ...settings, excludeVape: false })).toBe(true)
    expect(isProductEligible(products.get('mat'), { ...settings, excludedCategoryIds: ['co'] })).toBe(false)
    expect(isProductEligible(products.get('food'), { ...settings, excludedProductIds: ['food'] })).toBe(false)
    expect(isProductEligible(undefined, settings)).toBe(false)
  })

  it('adds up only eligible lines, to the sen', () => {
    const lines = [
      { productId: 'vape', subtotal: 100 },
      { productId: 'mat', subtotal: 49.9 },
      { productId: 'food', subtotal: 0.15 },
      { productId: 'unknown', subtotal: 10 },
    ]
    expect(eligibleGoodsAmount(lines, products, settings)).toBe(50.05)
  })
})

describe('attribution window and stored link', () => {
  const now = Date.UTC(2026, 10, 2)
  it('trusts checkouts without a click time and checks the window otherwise', () => {
    expect(withinAttribution(undefined, 30, now)).toBe(true)
    expect(withinAttribution(now - 29 * day, 30, now)).toBe(true)
    expect(withinAttribution(now - 31 * day, 30, now)).toBe(false)
  })

  it('reads the saved link and drops bad or very old ones', () => {
    expect(storedAffiliateRef({ code: 'aminah-7k2q', sub: 'tiktok', at: now - day, token: 'signed' }, now)).toEqual({ code: 'AMINAH-7K2Q', sub: 'tiktok', clickedAt: now - day, token: 'signed' })
    expect(storedAffiliateRef({ code: 'AB', at: now, token: 'signed' }, now)).toBeNull()
    expect(storedAffiliateRef({ code: 'AMINAH', at: now - 400 * day, token: 'signed' }, now)).toBeNull()
    expect(storedAffiliateRef({ code: 'AMINAH', sub: 'bad sub!', at: now, token: 'signed' }, now)?.sub).toBe('')
    expect(storedAffiliateRef({ code: 'AMINAH', at: now }, now)).toBeNull()
  })
})

describe('self referral', () => {
  const affiliate = { user_id: 'u1', contact_email: 'Aminah@Mail.com', contact_phone: '012-345 6789' }
  it('matches the account, the email or the phone', () => {
    expect(isSelfReferral(affiliate, { userId: 'u1' })).toBe(true)
    expect(isSelfReferral(affiliate, { email: ' aminah@mail.com ' })).toBe(true)
    expect(isSelfReferral(affiliate, { phone: '+60123456789' })).toBe(true)
    expect(isSelfReferral(affiliate, { userId: 'u2', email: 'other@mail.com', phone: '0198765432' })).toBe(false)
    expect(isSelfReferral({}, { email: '', phone: '' })).toBe(false)
  })
})

describe('codes, links and bank details', () => {
  it('makes a valid code from the name', () => {
    const code = suggestAffiliateCode('Nur Aminah binti Ali', () => 0)
    expect(code).toBe('NURAMINAHB-AAAA')
    expect(suggestAffiliateCode('', () => 0.99)).toMatch(/^SERA-[A-Z0-9]{4}$/)
  })

  it('links only to our own sites and keeps the page address', () => {
    expect(buildAffiliateLink('https://store.serapod2u.com/store/products/p1?x=1', 'aminah', 'tiktok')).toBe(
      'https://store.serapod2u.com/store/products/p1?x=1&ref=AMINAH&sub=tiktok',
    )
    expect(buildAffiliateLink('https://outdoor.serapod2u.com/shop/p1?ref=OLD', 'AMINAH')).toBe('https://outdoor.serapod2u.com/shop/p1?ref=AMINAH')
    expect(buildAffiliateLink('https://evil.com/?a=serapod2u.com', 'AMINAH')).toBe('')
    expect(buildAffiliateLink('javascript:alert(1)', 'AMINAH')).toBe('')
    expect(buildAffiliateLink('https://store.serapod2u.com/', 'x')).toBe('')
  })

  it('checks bank details', () => {
    expect(validBankDetails({ bankName: 'Maybank', accountNo: '1234 5678-90', accountName: 'Aminah' })).toEqual({
      bankName: 'Maybank', accountNo: '1234567890', accountName: 'Aminah',
    })
    expect(validBankDetails({ bankName: 'M', accountNo: '123456', accountName: 'A B' })).toHaveProperty('error')
    expect(validBankDetails({ bankName: 'Maybank', accountNo: '12AB56', accountName: 'Aminah' })).toHaveProperty('error')
  })
})
