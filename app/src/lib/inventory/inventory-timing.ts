/** Development diagnostics only. Never pass record data, URLs, messages or identity to this module. */
export interface InventoryTrace { id: string; started: number }
type Counts = Record<string, number | boolean | null>
const enabled = () => process.env.NODE_ENV === 'development'
let sequence = 0
export function createInventoryTrace(id?: string): InventoryTrace | undefined {
  if (!enabled()) return undefined
  const trace = { id: id && /^inv-[a-zA-Z0-9-]{1,100}$/.test(id) ? id : `inv-${crypto.randomUUID()}`, started: performance.now() }
  if (typeof window !== 'undefined') activateInventoryTransport(trace)
  return trace
}
export function inventoryEvent(trace: InventoryTrace | undefined, operation: string, event: string, counts: Counts = {}) {
  if (!trace || !enabled()) return
  console.info('[inventory-timing] ' + JSON.stringify({ id: trace.id, operation, event, at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - trace.started), ...counts }))
}
export function inventorySpan(trace: InventoryTrace | undefined, operation: string, counts: Counts = {}) {
  if (!trace || !enabled()) return (_counts: Counts = {}) => {}
  const started = performance.now()
  const span = ++sequence
  inventoryEvent(trace, operation, 'start', { span, ...counts })
  const timer = setInterval(() => inventoryEvent(trace, operation, 'pending', { span, ms: Math.round(performance.now() - started) }), 10000)
  // Server diagnostic timers must not keep a stopped dev process alive.
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  let ended = false
  return (endCounts: Counts = {}) => {
    if (ended) return
    ended = true
    clearInterval(timer)
    inventoryEvent(trace, operation, 'end', { span, ms: Math.round(performance.now() - started), ...endCounts })
  }
}
export async function timeInventoryOperation<T>(trace: InventoryTrace | undefined, operation: string, read: () => PromiseLike<T>): Promise<T> {
  const end = inventorySpan(trace, operation)
  try {
    const result = await read()
    const response = result as { error?: unknown; status?: number; data?: unknown }
    end({ ok: !response?.error, ...(typeof response?.status === 'number' ? { status: response.status } : {}), ...(Array.isArray(response?.data) ? { rows: response.data.length } : {}) })
    return result
  } catch (error) {
    end({ ok: false, threw: true })
    throw error
  }
}

/** Resource Timing supplies overall HTTP duration. Cross-origin TTFB is unavailable without Timing-Allow-Origin. */
export function observeInventoryResources(trace: InventoryTrace | undefined) {
  if (!trace || !enabled() || typeof PerformanceObserver === 'undefined') return () => {}
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      const url = new URL(entry.name)
      const operation = resourceOperation(url) || (url.pathname === '/api/security-access/me/navigation' ? 'http.navigation' : null)
      if (!operation) continue
      inventoryEvent(trace, operation, 'resource', {
        beforeTrace: entry.startTime < trace.started, startSinceNavigationMs: Math.round(entry.startTime), ms: Math.round(entry.duration),
        detailedTiming: entry.responseStart > 0,
        ttfbMs: entry.responseStart > 0 ? Math.round(entry.responseStart - entry.requestStart) : null,
        downloadMs: entry.responseStart > 0 ? Math.round(entry.responseEnd - entry.responseStart) : null,
        ...(typeof entry.responseStatus === 'number' ? { status: entry.responseStatus } : {}),
        ...(url.searchParams.has('offset') ? { offset: Number(url.searchParams.get('offset')) || 0 } : {}),
        ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) || 0 } : {}),
      })
    }
  })
  observer.observe({ type: 'resource', buffered: true })
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  if (navigation) inventoryEvent(trace, 'browser.navigation', 'snapshot', {
    ttfbMs: Math.round(navigation.responseStart - navigation.requestStart),
    documentMs: Math.round(navigation.responseEnd - navigation.startTime),
    shellMountSinceNavigationMs: Math.round(performance.now()), reload: navigation.type === 'reload',
    domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
  })
  return () => observer.disconnect()
}

let transportTrace: InventoryTrace | undefined
export function activateInventoryTransport(trace: InventoryTrace | undefined) { if (enabled()) transportTrace = trace }
export function clearInventoryTransport(trace: InventoryTrace | undefined) {
  if (trace && (transportTrace?.id === trace.id || transportTrace?.id.startsWith(`${trace.id}-l`))) transportTrace = undefined
}
function resourceOperation(url: URL): string | null {
  const known = ['vw_inventory_on_hand','v_incoming_stock','product_inventory','product_variants','stock_movements','vw_manual_stock_balance','inventory_stock_configurations','organizations','roles','departments','users']
  const table = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1]
  if (table && known.includes(table)) return `http.${table}`
  if (url.pathname === '/auth/v1/user') return 'http.auth.user'
  if (url.pathname === '/auth/v1/token') return 'http.auth.refresh'
  return null
}
/** Installed only on the development Supabase browser client. Headers, filters and bodies are never inspected/logged. */
export async function inventoryDiagnosticFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const operation = resourceOperation(url)
  const trace = transportTrace
  const request = ++sequence
  const end = inventorySpan(operation ? trace : undefined, operation ? `${operation}.headers` : 'http.other.headers', { request })
  try {
    const response = await fetch(input, init)
    end({ status: response.status, ok: response.ok })
    if (operation && trace && enabled()) {
      // Time the SDK's existing consumption; do not clone, eagerly read or inspect the body.
      const text = response.text.bind(response)
      response.text = async () => {
        const endBody = inventorySpan(trace, `${operation}.body.text`, { request })
        try { const body = await text(); endBody({ ok: true, bodyChars: body.length }); return body }
        catch (error) { endBody({ ok: false }); throw error }
      }
      const json = response.json.bind(response)
      response.json = async () => {
        const endBody = inventorySpan(trace, `${operation}.body.json`, { request })
        try { const body = await json(); endBody({ ok: true }); return body }
        catch (error) { endBody({ ok: false }); throw error }
      }
    }
    return response
  } catch (error) {
    end({ ok: false, aborted: error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name) })
    throw error
  }
}
