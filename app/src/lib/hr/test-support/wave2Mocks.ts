/**
 * Test support (Wave 2 routes): a session client whose signed-in user and profile reads are controllable, and an
 * admin client whose rpc() is a spy. No network: nothing here reaches Supabase.
 */
import { vi } from 'vitest'

export const wave2 = {
  sessionUser: { id: '00000000-0000-0000-0000-0000000000a1' } as { id: string } | null,
  organizationId: '00000000-0000-0000-0000-000000000001',
  rpc: vi.fn(),
  rows: {} as Record<string, unknown>,
}

export function sessionClient() {
  const chain = (table: string) => {
    const q: any = {
      select: () => q, eq: () => q,
      single: async () => ({ data: table === 'users' ? { id: wave2.sessionUser?.id, organization_id: wave2.organizationId } : null, error: null }),
      maybeSingle: async () => ({ data: wave2.rows[table] ?? null, error: null }),
    }
    return q
  }
  return {
    auth: { getUser: async () => ({ data: { user: wave2.sessionUser }, error: wave2.sessionUser ? null : { message: 'no session' } }) },
    from: (t: string) => chain(t),
  }
}

export function resetWave2() {
  wave2.sessionUser = { id: '00000000-0000-0000-0000-0000000000a1' }
  wave2.rows = {}
  wave2.rpc.mockReset()
}
