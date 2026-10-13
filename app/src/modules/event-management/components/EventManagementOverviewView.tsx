'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CalendarRange, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ModuleLightHeader from '@/components/layout/ModuleLightHeader'
import { eventTabHref, EVENT_MANAGEMENT_BASE_PATH } from '@/modules/event-management/eventManagementNav'
import {
  CreateEventDialog,
  EventListAccessState,
  EventListError,
  EventStatusBadge,
  PRIMARY_ACTION_CLASS,
  formatEventDate,
  useEventList,
} from '@/modules/event-management/components/EventManagementShared'
import { EventManagementLoadingState } from '@/modules/event-management/components/EventManagementLoadingState'

interface Props {
  organizationId: string | null
}

/**
 * Module Overview: counts by status and the events that need attention now (active, then upcoming drafts),
 * all from the organization's events list. Per-event registration figures live on each event's Overview.
 */
export function EventManagementOverviewView(_props: Props) {
  const { events, status, loading, error, reload } = useEventList()
  const [showCreate, setShowCreate] = useState(false)

  const counts = useMemo(() => {
    const by = (status: string) => events.filter((e) => e.status === status).length
    return { total: events.length, active: by('active'), draft: by('draft'), closed: by('ended') + by('cancelled') }
  }, [events])

  const current = useMemo(() => {
    const rank: Record<string, number> = { active: 0, draft: 1 }
    return events
      .filter((e) => e.status === 'active' || e.status === 'draft')
      .sort((a, b) => (rank[a.status] - rank[b.status]) || a.starts_at.localeCompare(b.starts_at))
      .slice(0, 5)
  }, [events])

  const kpis = [
    { label: 'Total events', value: counts.total, accent: true },
    { label: 'Active', value: counts.active },
    { label: 'Draft', value: counts.draft },
    { label: 'Ended / cancelled', value: counts.closed },
  ]

  // Counts and the empty state need a successful answer; until then show loading, the access outcome, or the failure.
  if (status === 'loading') return <EventManagementLoadingState />
  if (status === 'denied' || status === 'signed_out') return <EventListAccessState status={status} />

  return (
    <div className="sera-module-landing">
      <ModuleLightHeader
        eyebrow="Event Management"
        title="Event registrations"
        description="Create events, assign staff, generate one QR per staff member plus a booth QR, and track visitor registrations."
        actions={
          <Button size="sm" onClick={() => setShowCreate(true)} className={PRIMARY_ACTION_CLASS}>
            <Plus className="h-4 w-4" /> New Event
          </Button>
        }
      />

      {status === 'error' ? (
        <EventListError error={error} onRetry={reload} retrying={loading} />
      ) : (
      <>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <div key={kpi.label} className={kpi.accent ? 'sera-sc-kpi sera-sc-kpi--accent' : 'sera-sc-kpi'}>
            <span className="sera-sc-kpi__label">{kpi.label}</span>
            <span className="sera-sc-kpi__value">{kpi.value}</span>
          </div>
        ))}
      </div>

      <section className="rounded-xl border border-[var(--sera-line)] bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--sera-line)] px-4 py-3">
          <h2 className="text-sm font-semibold text-[var(--sera-ink)]">Active &amp; draft events</h2>
          <Link
            href={`${EVENT_MANAGEMENT_BASE_PATH}/events`}
            className="inline-flex items-center gap-1 text-sm font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)]"
          >
            All events <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        {current.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            <CalendarRange className="mx-auto mb-2 text-[var(--sera-muted)]" size={24} />
            {events.length === 0 ? 'No events yet. Create your first event to get started.' : 'No active or draft events.'}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--sera-line)]">
            {current.map((event) => (
              <li key={event.id}>
                <Link href={eventTabHref(event.id, 'event-overview')} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--sera-mist)]/60">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-[var(--sera-ink)]">{event.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatEventDate(event.starts_at)} – {formatEventDate(event.ends_at)}
                    </p>
                  </div>
                  <EventStatusBadge status={event.status} />
                  <ArrowRight className="h-3.5 w-3.5 text-[var(--sera-orange)]" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      </>
      )}

      <CreateEventDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => {
          setShowCreate(false)
          reload()
        }}
      />
    </div>
  )
}
