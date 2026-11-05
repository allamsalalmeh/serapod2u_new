import { describe, expect, it } from 'vitest'

import { IN_LOOKUP_CHUNK_SIZE, selectInChunks } from './chunkedIn'

describe('selectInChunks', () => {
    it('splits values so no single request exceeds the chunk size, and merges the rows', async () => {
        const values = Array.from({ length: 250 }, (_, i) => `id-${i}`)
        const sizes: number[] = []
        const result = await selectInChunks(values, async (chunk) => {
            sizes.push(chunk.length)
            return { data: chunk.map((id) => ({ id })), error: null }
        })
        expect(Math.max(...sizes)).toBeLessThanOrEqual(IN_LOOKUP_CHUNK_SIZE)
        expect(sizes.reduce((a, b) => a + b, 0)).toBe(250)
        expect(result.data).toHaveLength(250)
        expect(result.error).toBeNull()
        expect(result.failedValues.size).toBe(0)
    })

    it('de-duplicates values and skips the request entirely when empty', async () => {
        let calls = 0
        const empty = await selectInChunks([], async () => { calls += 1; return { data: [], error: null } })
        expect(calls).toBe(0)
        expect(empty.data).toEqual([])

        const seen: string[] = []
        await selectInChunks(['a', 'a', '', 'b'], async (chunk) => { seen.push(...chunk); return { data: [], error: null } })
        expect(seen).toEqual(['a', 'b'])
    })

    it('keeps rows from good chunks and reports which values were not loaded', async () => {
        const values = Array.from({ length: 5 }, (_, i) => `v${i}`)
        const result = await selectInChunks(values, async (chunk) => (
            chunk.includes('v2')
                ? { data: null, error: { code: '414', message: 'URI too long' } }
                : { data: chunk.map((id) => ({ id })), error: null }
        ), 2)
        expect(result.data.map((row: any) => row.id)).toEqual(['v0', 'v1', 'v4'])
        expect(result.error).toEqual({ code: '414', message: 'URI too long' })
        expect([...result.failedValues].sort()).toEqual(['v2', 'v3'])
    })

    it('retries a failed chunk once and keeps its rows when the retry succeeds', async () => {
        let calls = 0
        const result = await selectInChunks(['a', 'b'], async (chunk) => {
            calls += 1
            return calls === 1 ? { data: null, error: { code: '503' } } : { data: chunk.map((id) => ({ id })), error: null }
        })
        expect(calls).toBe(2)
        expect(result.error).toBeNull()
        expect(result.data).toHaveLength(2)
    })

    it('treats a thrown chunk as failed instead of rejecting the whole lookup', async () => {
        const result = await selectInChunks(['x'], async () => { throw new Error('network') })
        expect(result.data).toEqual([])
        expect(result.failedValues.has('x')).toBe(true)
    })
})
