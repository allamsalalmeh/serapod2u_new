import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression tests for the confirmed cron double-fire root cause.
 *
 * The Next.js standalone production runtime evaluates `cron-scheduler` TWICE in
 * the same Node process. Each evaluation used to get its own module-scoped
 * `started` flag and registered its own four node-cron tasks, so every worker
 * ran ~2x/minute.
 *
 * The decisive test is "a second MODULE EVALUATION registers nothing".
 * `vi.resetModules()` + re-import reproduces exactly that: the module registry
 * is cleared and the module body is evaluated again, while `globalThis` (where
 * ownership now lives) survives - which is precisely the production condition.
 */

const scheduleMock = vi.fn()
vi.mock('node-cron', () => ({
  default: { schedule: (...args: unknown[]) => scheduleMock(...args) },
}))

const REGISTRY_KEY = Symbol.for('serapod2u.cron.scheduler.registry')
const originalEnv = { ...process.env }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  scheduleMock.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any)[REGISTRY_KEY]
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  process.env.INTERNAL_CRON_BASE_URL = 'http://127.0.0.1:3000'
  process.env.CRON_SECRET = 'test-secret'
  // The single-start guarantee is about registration bookkeeping, not about
  // which features are switched on, so these cases opt the gated Serapp worker
  // in and keep asserting against the full worker list.
  process.env.ENABLE_SERAPP_HOLD_EXPIRY = 'true'
})

afterEach(() => {
  vi.unstubAllGlobals()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any)[REGISTRY_KEY]
  process.env = { ...originalEnv }
})

const flush = () => new Promise((r) => setTimeout(r, 0))
const WORKERS = [
  '/api/cron/qr-reverse-worker',
  '/api/cron/qr-generation-worker',
  '/api/cron/manufacturer-packing-worker',
  '/api/cron/notification-outbox-worker',
  '/api/cron/sa-decision-retention',
  '/api/cron/sa-governance-maintenance',
  '/api/cron/storefront-unpaid-expiry',
  '/api/cron/tiktok-shop-sync',
  // SerApp order holds expire on their own schedule.
  '/api/cron/serapp-hold-expiry',
]
// Counted from the list rather than hard-coded, so adding a worker does not
// look like the single-start guarantee breaking.
const WORKER_COUNT = WORKERS.length

describe('single-start guarantee', () => {
  it('1. first initialization registers the scheduler', async () => {
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()
    expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)
    expect(mod.__getCronRegistryForTests().started).toBe(true)
  })

  it('2. a second call within the SAME module instance registers nothing more', async () => {
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()
    mod.startCronScheduler()
    mod.startCronScheduler()
    expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)
  })

  it('3. a second MODULE EVALUATION registers nothing (the actual root cause)', async () => {
    // --- module evaluation A ---
    const modA = await import('./cron-scheduler')
    modA.startCronScheduler()
    expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)
    const ownerA = modA.__getCronRegistryForTests().schedulerInstanceId

    // --- module evaluation B: fresh module body, same process, same globalThis ---
    vi.resetModules()
    const modB = await import('./cron-scheduler')
    expect(modB).not.toBe(modA) // genuinely a different module instance
    modB.startCronScheduler()

    // still one set - B must not add its own tasks
    expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)
    // and B sees the SAME shared registry, not a fresh one
    expect(modB.__getCronRegistryForTests().schedulerInstanceId).toBe(ownerA)
  })

  it('3b. BEHAVIOUR ONLY: two module evaluations yield one set of registrations, not two', async () => {
    // Deliberately uses no new exports, so it fails against the OLD
    // module-scoped implementation for the right reason: twice the tasks.
    const modA = await import('./cron-scheduler')
    modA.startCronScheduler()

    vi.resetModules()
    const modB = await import('./cron-scheduler')
    modB.startCronScheduler()

    expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)
  })

  it('4. exactly one route is registered per worker', async () => {
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()
    const registered = [...mod.__getCronRegistryForTests().registeredPaths]
    expect(registered).toHaveLength(WORKER_COUNT)
    expect(new Set(registered)).toEqual(new Set(WORKERS))
  })

  it('5. no route is ever registered twice across three module evaluations', async () => {
    for (let i = 0; i < 3; i++) {
      vi.resetModules()
      const mod = await import('./cron-scheduler')
      mod.startCronScheduler()
    }
    expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)

    const mod = await import('./cron-scheduler')
    expect(mod.__getCronRegistryForTests().registeredPaths.size).toBe(WORKER_COUNT)
  })

  it('logs the duplicate suppression once per extra evaluation, not per tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const modA = await import('./cron-scheduler')
    modA.startCronScheduler()

    vi.resetModules()
    const modB = await import('./cron-scheduler')
    modB.startCronScheduler()

    const suppressed = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('Duplicate scheduler initialization suppressed'))
    expect(suppressed).toHaveLength(1)
    warn.mockRestore()
  })
})

describe('dispatch behaviour', () => {
  it('6. one minute tick produces one dispatch per route', async () => {
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()

    for (const call of scheduleMock.mock.calls) {
      ;(call[1] as () => void)()
    }
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(WORKER_COUNT)
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(new Set(urls).size).toBe(WORKER_COUNT)
  })

  it('7. the global dispatch guard holds ACROSS module evaluations', async () => {
    const modA = await import('./cron-scheduler')
    expect(modA.claimDispatchSlot('/api/cron/x', '*/1 * * * *', 60_000)).toBe(true)

    // a second module evaluation must NOT get a fresh dispatch map
    vi.resetModules()
    const modB = await import('./cron-scheduler')
    expect(modB.claimDispatchSlot('/api/cron/x', '*/1 * * * *', 60_100)).toBe(false)

    // next minute is allowed again
    expect(modB.claimDispatchSlot('/api/cron/x', '*/1 * * * *', 120_000)).toBe(true)
  })

  it('a double-fired callback still results in a single HTTP request', async () => {
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()
    const callback = scheduleMock.mock.calls[0][1] as () => void

    callback()
    callback()
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('8. six-field (sub-minute) schedules are never suppressed', async () => {
    const mod = await import('./cron-scheduler')
    expect(mod.isMinuteGranular('*/1 * * * *')).toBe(true)
    expect(mod.isMinuteGranular('*/20 * * * * *')).toBe(false)
    expect(mod.claimDispatchSlot('/api/cron/y', '*/20 * * * * *', 60_000)).toBe(true)
    expect(mod.claimDispatchSlot('/api/cron/y', '*/20 * * * * *', 60_100)).toBe(true)
  })

  it('sends the cron credential and no diagnostic headers remain', async () => {
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()
    ;(scheduleMock.mock.calls[0][1] as () => void)()
    await flush()

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-secret')
    expect(Object.keys(headers).some((h) => h.toLowerCase().startsWith('x-serapod-cron'))).toBe(false)
    expect(init.redirect).toBe('manual')
  })

  it('a 3xx follows exactly once, no unbounded retry', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(null, { status: 307, headers: { location: '/api/cron/qr-reverse-worker' } })
    )
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()
    ;(scheduleMock.mock.calls[0][1] as () => void)()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

/**
 * Localhost safety switch.
 *
 * A developer's `.env.local` commonly points at a SHARED database. These four
 * workers write to it every minute, so running `next dev` to review a UI would
 * quietly mutate staging. The flag makes that opt-out explicit — and, just as
 * importantly, the environment alone must never make the decision.
 */
describe('DISABLE_INTERNAL_CRON_WORKERS', () => {
    it('registers nothing when the flag is set', async () => {
        process.env.DISABLE_INTERNAL_CRON_WORKERS = '1'
        const mod = await import('./cron-scheduler')
        mod.startCronScheduler()

        expect(scheduleMock).not.toHaveBeenCalled()
        expect(mod.__getCronRegistryForTests().registeredPaths.size).toBe(0)
        // Never claims the started flag, so nothing is left half-initialised.
        expect(mod.__getCronRegistryForTests().started).toBe(false)
    })

    it('never dispatches a worker while disabled', async () => {
        process.env.DISABLE_INTERNAL_CRON_WORKERS = '1'
        const mod = await import('./cron-scheduler')
        mod.startCronScheduler()
        await flush()

        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('logs exactly one concise line, even across a second module evaluation', async () => {
        process.env.DISABLE_INTERNAL_CRON_WORKERS = '1'
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const modA = await import('./cron-scheduler')
        modA.startCronScheduler()
        modA.startCronScheduler()

        vi.resetModules()
        const modB = await import('./cron-scheduler')
        modB.startCronScheduler()

        const disabledLines = logSpy.mock.calls
            .map((call) => String(call[0]))
            .filter((line) => line.includes('DISABLED'))
        expect(disabledLines).toHaveLength(1)
        expect(disabledLines[0]).toContain('DISABLE_INTERNAL_CRON_WORKERS')
        // The duplicate-initialization warning belongs to the enabled path only.
        expect(warnSpy).not.toHaveBeenCalled()

        logSpy.mockRestore()
        warnSpy.mockRestore()
    })

    it('leaves staging and production behaviour unchanged when the flag is absent', async () => {
        delete process.env.DISABLE_INTERNAL_CRON_WORKERS
        const mod = await import('./cron-scheduler')
        mod.startCronScheduler()

        expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)
        expect(mod.__getCronRegistryForTests().started).toBe(true)
        expect([...mod.__getCronRegistryForTests().registeredPaths].sort()).toEqual([...WORKERS].sort())
    })

    it('does not disable cron merely because NODE_ENV is development', async () => {
        delete process.env.DISABLE_INTERNAL_CRON_WORKERS
        vi.stubEnv('NODE_ENV', 'development')

        const mod = await import('./cron-scheduler')
        mod.startCronScheduler()

        expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)
    })

    it('treats explicit falsey spellings as enabled', async () => {
        const mod = await import('./cron-scheduler')
        for (const value of ['0', 'false', 'off', 'no', 'FALSE', ' ', '']) {
            expect(mod.internalCronWorkersDisabled({ DISABLE_INTERNAL_CRON_WORKERS: value } as unknown as NodeJS.ProcessEnv)).toBe(false)
        }
        expect(mod.internalCronWorkersDisabled({} as NodeJS.ProcessEnv)).toBe(false)
    })

    it('treats the usual truthy spellings as disabled', async () => {
        const mod = await import('./cron-scheduler')
        for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
            expect(mod.internalCronWorkersDisabled({ DISABLE_INTERNAL_CRON_WORKERS: value } as unknown as NodeJS.ProcessEnv)).toBe(true)
        }
    })
})

describe('Serapp hold-expiry schedule gate', () => {
  const SERAPP = '/api/cron/serapp-hold-expiry'

  it('is not scheduled when the flag is absent', async () => {
    delete process.env.ENABLE_SERAPP_HOLD_EXPIRY
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()

    const registered = [...mod.__getCronRegistryForTests().registeredPaths]
    expect(registered).not.toContain(SERAPP)
    expect(registered).toHaveLength(WORKER_COUNT - 1)
    expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT - 1)
  })

  it('leaves every unrelated worker scheduled', async () => {
    delete process.env.ENABLE_SERAPP_HOLD_EXPIRY
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()

    const registered = new Set(mod.__getCronRegistryForTests().registeredPaths)
    for (const worker of WORKERS.filter((w) => w !== SERAPP)) {
      expect(registered.has(worker)).toBe(true)
    }
  })

  it('never dispatches the gated worker over a tick', async () => {
    delete process.env.ENABLE_SERAPP_HOLD_EXPIRY
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()

    for (const call of scheduleMock.mock.calls) {
      ;(call[1] as () => void)()
    }
    await flush()

    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes(SERAPP))).toBe(false)
  })

  it('is scheduled again once the flag opts in', async () => {
    process.env.ENABLE_SERAPP_HOLD_EXPIRY = 'true'
    const mod = await import('./cron-scheduler')
    mod.startCronScheduler()

    expect([...mod.__getCronRegistryForTests().registeredPaths]).toContain(SERAPP)
    expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)
  })

  it('reads the usual falsey spellings as off', async () => {
    const mod = await import('./cron-scheduler')
    for (const off of [undefined, '', '0', 'false', 'off', 'no', 'FALSE']) {
      expect(
        mod.serappHoldExpiryEnabled({ ...process.env, ENABLE_SERAPP_HOLD_EXPIRY: off }),
      ).toBe(false)
    }
    for (const on of ['1', 'true', 'on', 'yes', 'TRUE']) {
      expect(
        mod.serappHoldExpiryEnabled({ ...process.env, ENABLE_SERAPP_HOLD_EXPIRY: on }),
      ).toBe(true)
    }
  })
})

describe('remote database guard', () => {
    it('registers no workers for a dev process connected to a remote database', async () => {
        vi.stubEnv('NODE_ENV', 'development')
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase-stg-serapod.getouch.cloud'
        process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
        delete process.env.DISABLE_INTERNAL_CRON_WORKERS
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})

        try {
            const mod = await import('./cron-scheduler')
            mod.startCronScheduler()
            mod.startCronScheduler()

            expect(scheduleMock).not.toHaveBeenCalled()
            expect(mod.__getCronRegistryForTests().registeredPaths.size).toBe(0)
            expect(log.mock.calls.filter(([line]) => String(line).includes('NOT registered'))).toHaveLength(1)
        } finally {
            vi.unstubAllEnvs()
            log.mockRestore()
        }
    })

    it('registers workers when ALLOW_REMOTE_DB_WORKERS_FROM_LOCAL=true', async () => {
        vi.stubEnv('NODE_ENV', 'development')
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase-stg-serapod.getouch.cloud'
        process.env.ALLOW_REMOTE_DB_WORKERS_FROM_LOCAL = 'true'

        try {
            const mod = await import('./cron-scheduler')
            mod.startCronScheduler()
            expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)
        } finally {
            vi.unstubAllEnvs()
        }
    })

    it('registers workers for the deployed staging runtime', async () => {
        vi.stubEnv('NODE_ENV', 'production')
        process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase-stg-serapod.getouch.cloud'
        process.env.NEXT_PUBLIC_APP_URL = 'https://stg.serapod2u.com'

        try {
            const mod = await import('./cron-scheduler')
            mod.startCronScheduler()
            expect(scheduleMock).toHaveBeenCalledTimes(WORKER_COUNT)
        } finally {
            vi.unstubAllEnvs()
        }
    })
})
