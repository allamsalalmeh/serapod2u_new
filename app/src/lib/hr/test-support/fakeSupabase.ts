/**
 * Test support: a recording fake of the Supabase query builder (no network, no database).
 * `results[table]` is either one result (returned for every await on that table) or an array used as a queue.
 */
export type Call = [table: string, method: string, ...args: unknown[]]

export function createFakeSupabase(initial: Record<string, unknown> = {}) {
  const calls: Call[] = []
  const results: Record<string, unknown> = { ...initial }
  const next = (table: string) => {
    const r = results[table]
    if (Array.isArray(r)) return r.length > 1 ? r.shift() : r[0]
    return r ?? { data: [], error: null }
  }
  const chain = (table: string): any =>
    new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === 'then') return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(next(table)).then(resolve, reject)
        return (...args: unknown[]) => {
          calls.push([table, prop, ...args])
          return chain(table)
        }
      },
    })
  const client = {
    from: (table: string) => {
      calls.push([table, 'from'])
      return chain(table)
    },
    rpc: (name: string, args: unknown) => {
      calls.push(['rpc', name, args])
      return Promise.resolve(next(`rpc:${name}`))
    },
    auth: { getUser: async () => ({ data: { user: { id: 'user-hr' } }, error: null }) },
  }
  const callsTo = (table: string, method?: string) => calls.filter((c) => c[0] === table && (!method || c[1] === method))
  return { client, calls, results, callsTo }
}
