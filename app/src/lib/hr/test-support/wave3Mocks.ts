/**
 * Test support (Wave 3 routes): the Wave 2 session/admin mocks plus a controllable Employee Self-Service decision.
 * No network: nothing here reaches Supabase.
 */
import { vi } from 'vitest'
export { resetWave2, sessionClient, wave2 } from './wave2Mocks'

export const ess = { allowed: true, calls: [] as unknown[] }
export const hrSelfCanMock = vi.fn(async (...args: unknown[]) => { ess.calls.push(args); return ess.allowed })
export function resetEss() { ess.allowed = true; ess.calls = []; hrSelfCanMock.mockClear() }
