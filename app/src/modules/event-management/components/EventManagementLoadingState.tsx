/**
 * Event Management placeholder shown while its content is not available yet: during a navigation into the module
 * (before the server page arrives) and while a view's first events request is in flight. It never shows counts or an
 * empty state, so nothing can be mistaken for real data.
 */
export function EventManagementLoadingState({ label = 'Loading events…' }: { label?: string }) {
  return (
    <div className="sera-module-landing" role="status" aria-live="polite" aria-busy="true" data-event-management-loading>
      <div className="animate-pulse space-y-2">
        <div className="h-3 w-32 rounded bg-[var(--sera-line)]" />
        <div className="h-6 w-56 max-w-full rounded bg-[var(--sera-line)]" />
        <div className="h-3 w-96 max-w-full rounded bg-[var(--sera-line)]" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="sera-sc-kpi animate-pulse">
            <span className="h-3 w-20 rounded bg-[var(--sera-line)]" />
            <span className="mt-2 h-6 w-10 rounded bg-[var(--sera-line)]" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-[var(--sera-line)] bg-white px-4 py-6">
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}
