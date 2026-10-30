import { describe, expect, it } from 'vitest'
import { schemaProblems, type QueryCall } from './postgrest-fake'

const query = { table: 'movements', select: 'id,quantity_change', filters: [], writes: [] } as unknown as QueryCall

describe('schema snapshot view contracts', () => {
  it('accepts pg_dump security options while still rejecting missing columns', () => {
    const sql = `CREATE VIEW public.movements WITH (security_invoker='false', security_barrier='true') AS
 SELECT sm.id,
    sm.quantity_change
 FROM public.stock_movements sm;
`
    expect(schemaProblems(sql, query)).toEqual([])
    expect(schemaProblems(sql, { ...query, select: 'missing' })).toContain('movements.missing does not exist')
  })
  it('still accepts a view without options', () => {
    const sql = `CREATE VIEW public.movements AS
 SELECT sm.id,
    sm.quantity_change
 FROM public.stock_movements sm;
`
    expect(schemaProblems(sql, query)).toEqual([])
  })
})
