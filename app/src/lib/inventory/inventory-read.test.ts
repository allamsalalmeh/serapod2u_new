import { expect, it } from 'vitest'
import { readInventoryPages } from './inventory-read'
it('reads every page including the final partial page without dropping totals', async () => {
  const rows = Array.from({ length: 2307 }, (_, id) => ({ id }))
  const ranges: number[] = []
  const result = await readInventoryPages(() => ({ range: async (from: number, to: number) => {
    ranges.push(from); return { data: rows.slice(from, to + 1), error: null }
  } }), 'test')
  expect(result.data).toEqual(rows)
  expect(ranges).toEqual([0, 1000, 2000])
})
it('does not publish partial balances when a later page fails', async () => {
  const result = await readInventoryPages(() => ({ range: async (from: number) => from === 0
    ? { data: Array(1000).fill({}), error: null }
    : { data: null, error: { message: 'permission denied' } } }), 'test')
  expect(result.data).toBeNull()
  expect(result.error).toEqual({ message: 'permission denied' })
})
it('returns request failures as errors, never as empty successful reads', async () => {
  const result = await readInventoryPages(() => { throw new Error('offline') }, 'test')
  expect(result.data).toBeNull()
  expect(result.error).toBeInstanceOf(Error)
})
