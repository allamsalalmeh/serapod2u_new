import { existsSync, readFileSync } from 'node:fs'

/**
 * A tiny in-memory stand-in for the supabase-js query builder, for route
 * tests. It records every call and applies eq / in / order / range to fixture
 * rows, so tests assert what a query actually selects instead of canned data.
 * Fixture rows are whatever the caller's RLS would let it see; embedded
 * resources are pre-shaped on the row.
 */

export type Row = Record<string, unknown>
export type QueryCall = {
  table: string
  select: string | null
  filters: Array<{ op: 'eq' | 'in'; column: string; value: unknown }>
  order: string | null
  range: [number, number] | null
  writes: string[]
}

export type FakeDb = {
  calls: QueryCall[]
  from: (table: string) => unknown
  failOn: (table: string, error?: { message: string; code?: string }) => void
}

export const createFakeDb = (tables: Record<string, Row[]>): FakeDb => {
  const calls: QueryCall[] = []
  const failures = new Map<string, { message: string; code?: string }>()

  const from = (table: string) => {
    const call: QueryCall = { table, select: null, filters: [], order: null, range: null, writes: [] }
    calls.push(call)

    const execute = () => {
      const failure = failures.get(table)
      if (failure) return { data: null, error: failure }
      let rows = (tables[table] ?? []).filter(row =>
        call.filters.every(filter =>
          filter.op === 'eq'
            ? row[filter.column] === filter.value
            : (filter.value as unknown[]).includes(row[filter.column])
        )
      )
      if (call.order) {
        const column = call.order
        rows = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])))
      }
      if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1)
      return { data: rows, error: null }
    }

    const builder: Record<string, unknown> = {
      select: (columns: string) => { call.select = columns; return builder },
      eq: (column: string, value: unknown) => { call.filters.push({ op: 'eq', column, value }); return builder },
      in: (column: string, value: unknown[]) => { call.filters.push({ op: 'in', column, value }); return builder },
      order: (column: string) => { call.order = column; return builder },
      range: (fromIndex: number, toIndex: number) => { call.range = [fromIndex, toIndex]; return builder },
      maybeSingle: () => {
        const result = execute()
        return Promise.resolve(result.error ? result : { data: result.data?.[0] ?? null, error: null })
      },
      // PostgREST: exactly one row, otherwise PGRST116.
      single: () => {
        const result = execute()
        if (result.error) return Promise.resolve(result)
        return Promise.resolve(result.data?.length === 1
          ? { data: result.data[0], error: null }
          : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } })
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(execute()).then(onFulfilled, onRejected),
    }
    for (const write of ['insert', 'update', 'upsert', 'delete']) {
      builder[write] = () => { call.writes.push(write); return builder }
    }
    return builder
  }

  return {
    calls,
    from,
    failOn: (table, error = { message: 'boom', code: 'XX000' }) => { failures.set(table, error) },
  }
}

// ---------------------------------------------------------------------------
// Schema-snapshot contract: every column and embed a recorded query uses must
// exist in the local staging schema dump (untracked; skipped when absent).
// ---------------------------------------------------------------------------

const snapshotUrl = new URL('../../../supabase/schemas/current_schema.sql', import.meta.url)
export const schemaSnapshot = existsSync(snapshotUrl) ? readFileSync(snapshotUrl, 'utf8') : null

const relationBody = (sql: string, relation: string): string | null => {
  const table = sql.indexOf(`CREATE TABLE public.${relation} (`)
  if (table >= 0) return sql.slice(table, sql.indexOf('\n);', table))
  const view = sql.indexOf(`CREATE VIEW public.${relation} AS`)
  if (view >= 0) return sql.slice(view, sql.indexOf(';\n', view))
  return null
}

const relationHasColumn = (sql: string, relation: string, column: string): boolean => {
  const body = relationBody(sql, relation)
  if (!body) return false
  if (body.startsWith('CREATE TABLE')) return new RegExp(`\\n    "?${column}"? `).test(body)
  // Views: the column must be projected (`AS column` or `alias.column` in the select list).
  return new RegExp(`(AS ${column}\\b|\\.${column}(,|\\n|$))`).test(body)
}

const foreignKeyBetween = (sql: string, a: string, b: string): boolean => {
  const fk = /ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \w+ FOREIGN KEY \([^)]+\) REFERENCES public\.(\w+)\(/g
  for (const match of sql.matchAll(fk)) {
    if ((match[1] === a && match[2] === b) || (match[1] === b && match[2] === a)) return true
  }
  return false
}

const splitTopLevel = (select: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of select) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/** Returns human-readable problems; an empty list means the query fits the schema. */
export const schemaProblems = (sql: string, call: QueryCall): string[] => {
  const problems: string[] = []
  const checkSelect = (relation: string, select: string) => {
    for (const part of splitTopLevel(select)) {
      const embed = part.match(/^(\w+)(?:!\w+)?\s*\(([\s\S]*)\)$/)
      if (embed) {
        const [, target, inner] = embed
        if (!relationBody(sql, target)) problems.push(`${relation}: embedded relation ${target} does not exist`)
        else if (!foreignKeyBetween(sql, relation, target)) problems.push(`${relation}: no foreign key to ${target}`)
        else checkSelect(target, inner)
      } else if (!relationHasColumn(sql, relation, part)) {
        problems.push(`${relation}.${part} does not exist`)
      }
    }
  }
  if (!relationBody(sql, call.table)) return [`relation ${call.table} does not exist`]
  if (call.select) checkSelect(call.table, call.select)
  for (const column of [...call.filters.map(f => f.column), ...(call.order ? [call.order] : [])]) {
    if (!relationHasColumn(sql, call.table, column)) problems.push(`${call.table}.${column} (filter/order) does not exist`)
  }
  return problems
}
