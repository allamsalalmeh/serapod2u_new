import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
const adminSingle = vi.fn()

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({ rpc })) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: () => ({ select: () => ({ eq: () => ({ single: adminSingle }) }) }),
  })),
}))

const post = async (body: Record<string, unknown>) => {
  const { POST } = await import('./route')
  const response = await POST(new Request('http://localhost/api/scratch-card/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json() }
}

describe('POST /api/scratch-card/play', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects requests without a campaign or journey, or without a phone', async () => {
    expect((await post({ consumerPhone: '60123' })).status).toBe(400)
    expect((await post({ campaignId: 'c-1' })).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns the RPC refusal object as a 400 with its error and code', async () => {
    rpc.mockResolvedValue({ data: { error: 'Daily play limit reached', code: 'DAILY_LIMIT_REACHED' }, error: null })
    const result = await post({ campaignId: 'c-1', consumerPhone: '60123' })
    expect(result).toEqual({ status: 400, body: { error: 'Daily play limit reached', code: 'DAILY_LIMIT_REACHED' } })
  })

  it('passes a successful play result through unchanged', async () => {
    const play = { success: true, reward_type: 'points', points_value: 10, play_id: 'p-1' }
    rpc.mockResolvedValue({ data: play, error: null })
    const result = await post({ journeyConfigId: 'j-1', consumerPhone: '60123', qrCodeId: 'q-1' })
    expect(result).toEqual({ status: 200, body: play })
    expect(rpc).toHaveBeenCalledWith('play_scratch_card_turn', {
      p_campaign_id: null,
      p_journey_config_id: 'j-1',
      p_consumer_phone: '60123',
      p_qr_code_id: 'q-1',
    })
  })

  it('reports RPC failures as a 500 with the database message', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    expect(await post({ campaignId: 'c-1', consumerPhone: '60123' })).toEqual({ status: 500, body: { error: 'boom' } })
  })

  it('resolves a QR code string to its id with the admin client', async () => {
    adminSingle.mockResolvedValue({ data: { id: 'q-9' }, error: null })
    rpc.mockResolvedValue({ data: { success: true }, error: null })
    await post({ campaignId: 'c-1', consumerPhone: '60123', qrCode: 'SERA-1' })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_qr_code_id: 'q-9' })
  })
})
