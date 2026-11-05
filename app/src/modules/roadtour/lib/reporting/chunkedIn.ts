// Chunked `.in(...)` lookups for the reporting loader.
//
// PostgREST encodes `.in(column, values)` into the request URL, and the gateway
// in front of it rejects long URLs with HTTP 414. Around 200–300 UUIDs is enough
// to cross that limit, so a busy month (many participants scanning) turned the
// whole identity lookup into one failed request: every account manager and
// participant lost their name at once. Splitting the values keeps each request
// well under the limit while the caller still sees one merged result.

/** Comfortably below the observed 414 threshold for UUID lists. */
export const IN_LOOKUP_CHUNK_SIZE = 100

export interface ChunkedLookupResult<T> {
    data: T[]
    /** First error seen; rows from the chunks that succeeded are still returned. */
    error: unknown | null
    /** Values whose chunk failed, so callers can tell "not found" from "not loaded". */
    failedValues: Set<string>
}

export async function selectInChunks<T>(
    values: readonly string[],
    runChunk: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
    chunkSize: number = IN_LOOKUP_CHUNK_SIZE,
): Promise<ChunkedLookupResult<T>> {
    const unique = Array.from(new Set(values.filter(Boolean)))
    const size = Math.max(1, Math.floor(chunkSize))
    const chunks: string[][] = []
    for (let index = 0; index < unique.length; index += size) chunks.push(unique.slice(index, index + size))

    const attempt = async (chunk: string[]) => {
        try {
            return { chunk, ...(await runChunk(chunk)) }
        } catch (error) {
            return { chunk, data: null, error }
        }
    }
    // One retry per failed chunk absorbs a transient blip; a second failure is
    // reported through `error` / `failedValues` rather than hidden.
    const results = await Promise.all(chunks.map(async (chunk) => {
        const first = await attempt(chunk)
        return first.error ? attempt(chunk) : first
    }))

    const data: T[] = []
    const failedValues = new Set<string>()
    let firstError: unknown | null = null
    for (const result of results) {
        if (result.error) {
            if (firstError === null) firstError = result.error
            for (const value of result.chunk) failedValues.add(value)
            continue
        }
        data.push(...(result.data || []))
    }
    return { data, error: firstError, failedValues }
}
