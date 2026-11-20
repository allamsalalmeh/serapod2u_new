import { inventorySpan, type InventoryTrace } from './inventory-timing'

/** Complete, deterministic paged reads under the caller's existing RLS client. */
export async function readInventoryPages(createQuery: () => any, label: string, pageSize = 1000, trace?: InventoryTrace) {
  const started = performance.now()
  const endRead = inventorySpan(trace, label)
  let requests = 0
  const rows: any[] = []
  try {
    for (let from = 0; ; from += pageSize) {
      requests++
      const endPage = inventorySpan(trace, `${label}.page`, { page: requests, offset: from, limit: pageSize })
      let result
      try { result = await createQuery().range(from, from + pageSize - 1) }
      catch (error) { endPage({ ok: false, threw: true }); throw error }
      const { data, error } = result
      endPage({ ok: !error, statementTimeout: error?.code === '57014', rows: data?.length ?? 0, ...(typeof result.status === 'number' ? { status: result.status } : {}) })
      if (error) throw error
      rows.push(...(data || []))
      if (!data || data.length < pageSize) { endRead({ ok: true, requests, rows: rows.length }); return { data: rows, error: null } }
    }
  } catch (error) {
    endRead({ ok: false, requests, rows: rows.length })
    return { data: null, error }
  } finally {
    // No row data, URLs, tokens or user identifiers in diagnostic output.
    if (process.env.NODE_ENV === 'development') {
      console.debug('[inventory-read]', { label, requests, rows: rows.length, ms: Math.round(performance.now() - started) })
    }
  }
}
