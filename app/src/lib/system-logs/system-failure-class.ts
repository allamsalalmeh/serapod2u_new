/** Which System Log notification type a failure belongs to. Isomorphic and dependency-free. */
export type SystemFailureClass = 'critical' | 'database' | 'application'

const SQLSTATE = /^[0-9A-Z]{5}$/
/** Connection (08), resources (53), operator intervention such as shutdown (57P), system (58) and internal (XX) errors. */
const CRITICAL_SQLSTATE = /^(08|53|57P|58|XX)/

export function classifySystemFailure(code: string | null | undefined): SystemFailureClass {
  const value = String(code ?? '').toUpperCase()
  if (SQLSTATE.test(value) && CRITICAL_SQLSTATE.test(value)) return 'critical'
  if (SQLSTATE.test(value) || value.startsWith('PGRST')) return 'database'
  return 'application'
}
