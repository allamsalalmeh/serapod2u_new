import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./tiktok-api', () => ({
  tiktokAppForShop: () => ({ appKey: 'k', appSecret: 's', serviceId: '1', shops: [] }),
  exchangeTikTokAuthCode: vi.fn(async () => ({
    accessToken: 'new-access',
    accessTokenExpiresAt: '2026-11-01T00:00:00.000Z',
    refreshToken: 'new-refresh',
    refreshTokenExpiresAt: '2027-01-01T00:00:00.000Z',
    openId: 'open',
    sellerName: 'Ellbow',
    sellerBaseRegion: 'MY',
    userType: 0,
    grantedScopes: ['seller.order.info', 'seller.affiliate_collaboration.read'],
  })),
  getAuthorizedShops: vi.fn(async () => [{ id: 'tts-1', name: 'Ellbow Shop', code: 'MY1', cipher: 'ROW_x' }]),
}))
vi.mock('./tiktok-sync', () => ({ computeDataFrom: vi.fn(async () => '2026-10-19') }))

import { saveTikTokConnection } from './tiktok-oauth'

type Result = { data?: unknown; error: unknown }

function fakeDb(existing: { data_from: string; external_shop_id: string } | null) {
  const upserts: Record<string, unknown>[] = []
  const query = (result: Result) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      neq: () => q,
      maybeSingle: async () => result,
      then: (resolve: (r: Result) => unknown) => resolve(result),
    }
    return q
  }
  let connectionReads = 0
  const db = {
    from: (table: string) => {
      if (table === 'marketplace_shops') {
        return {
          ...query({ data: [{ id: 'shop-1', shop_name: 'Ellbow', is_active: true }], error: null }),
          update: () => query({ error: null }),
        }
      }
      return {
        ...query({ data: connectionReads++ === 0 ? null : existing, error: null }),
        upsert: async (row: Record<string, unknown>) => {
          upserts.push(row)
          return { error: row.data_from == null ? { code: '23502', message: 'null value in column "data_from"' } : null }
        },
      }
    },
  }
  return { db, upserts }
}

describe('saveTikTokConnection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('re-authorizing the same TikTok shop keeps data_from and the sync cursors', async () => {
    const { db, upserts } = fakeDb({ data_from: '2026-08-01', external_shop_id: 'tts-1' })
    await expect(saveTikTokConnection(db, { orgId: 'org', userId: 'u' }, 'shop-1', 'code')).resolves.toBeNull()
    expect(upserts).toHaveLength(1)
    expect(upserts[0].data_from).toBe('2026-08-01')
    expect(upserts[0].granted_scopes).toEqual(['seller.order.info', 'seller.affiliate_collaboration.read'])
    for (const key of ['orders_synced_to', 'statements_synced_to', 'payouts_synced_to', 'last_sync_at']) {
      expect(upserts[0]).not.toHaveProperty(key)
    }
  })

  it('a first connection starts from a fresh data_from and resets the cursors', async () => {
    const { db, upserts } = fakeDb(null)
    await expect(saveTikTokConnection(db, { orgId: 'org', userId: 'u' }, 'shop-1', 'code')).resolves.toBeNull()
    expect(upserts[0].data_from).toBe('2026-10-19')
    expect(upserts[0].orders_synced_to).toBeNull()
  })
})
