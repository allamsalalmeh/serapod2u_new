import { randomUUID } from 'crypto'

/**
 * Bounded, sanitized request diagnostics for the Security & Access admin API.
 *
 * One trace per request: a correlation id, named phase timings and failure
 * classifications. Nothing user-supplied, no tokens, no row payloads: phase
 * names and classifications are fixed strings chosen by the code. A trace
 * keeps at most MAX_PHASES entries and logs one line, only when the request
 * was slow, failed, or SA_TRACE=1.
 */
const MAX_PHASES = 32
const SLOW_MS = 2_000

export type FailureClass = 'timeout' | 'network' | 'database' | 'schema_missing' | 'unknown'

export interface ClassifiedError {
  classification: FailureClass
  /** PostgREST / Postgres error code when the database answered ('' never appears). */
  code: string | null
}

const SCHEMA_MISSING = new Set(['PGRST205', '42P01', 'PGRST202', '42883', 'PGRST200', '42703'])

/**
 * Classifies a supabase-js / fetch error without exposing its message. supabase-js
 * reports a failed or aborted fetch (the admin client aborts after 10s) as an
 * error with an empty code: that is a transport failure, not a database answer.
 */
export function classifyError(error: unknown): ClassifiedError {
  const e = error as any
  const code = typeof e?.code === 'string' && e.code ? e.code : null
  if (code) return { classification: SCHEMA_MISSING.has(code) ? 'schema_missing' : 'database', code }
  const text = `${e?.name ?? ''} ${e?.message ?? ''} ${e?.details ?? ''} ${e?.cause?.code ?? ''}`
  if (/abort|timeout|timed out/i.test(text)) return { classification: 'timeout', code: null }
  if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket|UND_ERR/i.test(text)) return { classification: 'network', code: null }
  return { classification: 'unknown', code: null }
}

export function isSchemaMissing(error: unknown): boolean {
  return classifyError(error).classification === 'schema_missing'
}

export interface Trace {
  readonly id: string
  /** Runs `fn` and records its duration under `phase`. */
  time<T>(phase: string, fn: () => PromiseLike<T>): Promise<T>
  /** Records a failure classification for a phase (never the raw message). */
  fail(phase: string, error: unknown): ClassifiedError
  /** Records the authorization outcome separately from transport/database failures. */
  outcome(value: string): void
  /** Finishes the trace; logs when slow, failed or SA_TRACE=1. Returns a Server-Timing header value. */
  end(status: number): string
}

export function createTrace(route: string, id: string = randomUUID()): Trace {
  const started = performance.now()
  const phases: Array<{ name: string; ms: number }> = []
  const failures: Array<{ phase: string } & ClassifiedError> = []
  let authorization: string | null = null
  const record = (name: string, ms: number) => { if (phases.length < MAX_PHASES) phases.push({ name, ms: Math.round(ms) }) }
  return {
    id,
    async time(phase, fn) {
      const t = performance.now()
      try { return await fn() } finally { record(phase, performance.now() - t) }
    },
    fail(phase, error) {
      const c = classifyError(error)
      if (failures.length < MAX_PHASES) failures.push({ phase, ...c })
      return c
    },
    outcome(value) { authorization = value },
    end(status) {
      const total = Math.round(performance.now() - started)
      if (process.env.SA_TRACE === '1' || total >= SLOW_MS || status >= 400 || failures.length) {
        const log = status >= 500 || failures.length ? console.warn : console.info
        log('[sa-trace]', JSON.stringify({ route, id, status, totalMs: total, authorization, phases, failures }))
      }
      return [...phases.map(p => `${p.name.replace(/[^a-zA-Z0-9_-]/g, '_')};dur=${p.ms}`), `total;dur=${total}`].join(', ')
    },
  }
}

/** No-op trace for callers that do not trace (keeps call sites unconditional). */
export const NO_TRACE: Trace = {
  id: '',
  time: async (_phase, fn) => fn(),
  fail: (_phase, error) => classifyError(error),
  outcome: () => {},
  end: () => '',
}
