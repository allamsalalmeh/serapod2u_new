import { z } from 'zod'
import { LOG_CATEGORIES, LOG_ENVIRONMENTS, LOG_SEVERITIES, ACTIVITY_OUTCOMES } from './contract'

/**
 * List query contract for GET /api/system-logs (bounded by construction): a window of at most 31 days, at most
 * 100 rows per page, keyset cursors only (no offsets), search text ≤ 120 characters.
 */
export const MAX_WINDOW_DAYS = 31
export const DEFAULT_ERROR_WINDOW_HOURS = 24
export const DEFAULT_ACTIVITY_WINDOW_DAYS = 7

const uuid = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
const empty = (v: unknown) => (v === '' || v === null ? undefined : v)

export const listQuerySchema = z.object({
  tab: z.enum(['errors', 'activity']).default('errors'),
  from: z.preprocess(empty, z.string().datetime({ offset: true }).optional()),
  to: z.preprocess(empty, z.string().datetime({ offset: true }).optional()),
  environment: z.preprocess(empty, z.enum(LOG_ENVIRONMENTS).optional()),
  user: z.preprocess(empty, uuid.optional()),
  module: z.preprocess(empty, z.string().max(80).optional()),
  severity: z.preprocess(empty, z.enum(LOG_SEVERITIES).optional()),
  category: z.preprocess(empty, z.enum(LOG_CATEGORIES).optional()),
  outcome: z.preprocess(empty, z.enum(ACTIVITY_OUTCOMES).optional()),
  q: z.preprocess(empty, z.string().trim().max(120).optional()),
  limit: z.preprocess(empty, z.coerce.number().int().min(1).max(100).default(50)),
  cursor: z.preprocess(empty, z.string().max(300).optional()),
})
export type ListQuery = z.infer<typeof listQuerySchema>

export interface Cursor { t: string; k: string }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (typeof value?.t !== 'string' || Number.isNaN(Date.parse(value.t)) || typeof value?.k !== 'string' || value.k.length > 80) return null
    return { t: value.t, k: value.k }
  } catch {
    return null
  }
}

/** Resolves the bounded time window (defaults: errors 24 h, activity 7 days; never wider than 31 days). */
export function resolveWindow(q: Pick<ListQuery, 'tab' | 'from' | 'to'>, now: Date = new Date()): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date(now.getTime() + 60_000)
  const defaultFrom = q.tab === 'activity'
    ? new Date(to.getTime() - DEFAULT_ACTIVITY_WINDOW_DAYS * 86_400_000)
    : new Date(to.getTime() - DEFAULT_ERROR_WINDOW_HOURS * 3_600_000)
  let from = q.from ? new Date(q.from) : defaultFrom
  if (from > to) from = defaultFrom
  const earliest = new Date(to.getTime() - MAX_WINDOW_DAYS * 86_400_000)
  if (from < earliest) from = earliest
  return { from, to }
}

/** Module filter options (error modules come from moduleFromPath / reporters; activity modules from the SQL read model). */
export const MODULE_OPTIONS = [
  'Supply Chain', 'Inventory', 'Product Catalog', 'Orders', 'HR', 'Finance', 'Security & Access', 'User Management', 'Settings',
  'QR & Traceability', 'Customer & Growth', 'E-Commerce', 'RoadTour', 'Manufacturing', 'Dashboard', 'Background jobs', 'System Logs', 'Other',
] as const
