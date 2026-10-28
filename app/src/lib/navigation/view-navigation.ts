/**
 * In-app view switching used by the dashboard shell.
 *
 * The shell keeps the active view in state (`currentView`) *and*, for every view that owns a URL, pushes that URL so
 * refresh, back/forward and deep links resolve the same page. Those two mechanisms must never paint the same view —
 * see `shouldSwitchViewInMemory` for why.
 */

/** Compare locations the way the router does: ignore a trailing slash, the query string and the hash. '/' stays '/'. */
export function normalizeNavPath(path: string | null | undefined): string {
    const raw = String(path ?? '').trim()
    if (!raw) return ''
    const withoutQueryHash = raw.split(/[?#]/)[0]
    if (!withoutQueryHash) return ''
    const withoutTrailingSlash = withoutQueryHash.replace(/\/+$/, '')
    return withoutTrailingSlash || '/'
}

/**
 * Whether a view switch still has to be rendered in memory.
 *
 * Next.js keys a route segment by its params, so a `router.push` that changes the path recreates the page subtree
 * below that segment: the shell, the active view and the view's data effects all mount again. Rendering the target
 * view in memory *before* such a push therefore mounts it twice — once in the page being left, once in the page that
 * arrives — and a data view (View Inventory, for example) loads its data twice: it appears, resets to its skeleton,
 * and appears again. That double paint is the flicker.
 *
 * The destination page renders the view from its own URL (`initialView`), so the in-memory switch is only needed when
 * the push leaves the URL unchanged and therefore cannot deliver the view itself. An unknown location (`null`
 * pathname) is treated the same way: push, and let the page decide.
 */
export function shouldSwitchViewInMemory(
    currentPath: string | null | undefined,
    targetHref: string | null | undefined
): boolean {
    const from = normalizeNavPath(currentPath)
    const to = normalizeNavPath(targetHref)
    if (!from || !to) return false
    return from === to
}
