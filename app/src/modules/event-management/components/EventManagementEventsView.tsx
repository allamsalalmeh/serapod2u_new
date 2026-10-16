'use client'

import { useState } from 'react'
import Link from 'next/link'
import { CalendarRange, ChevronRight, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { eventTabHref } from '@/modules/event-management/eventManagementNav'
import {
  CreateEventDialog,
  EventPageHeader,
  EventStatusBadge,
  PRIMARY_ACTION_CLASS,
  formatEventDate,
  useEventList,
  EventListAccessState,
  EventListError,
} from '@/modules/event-management/components/EventManagementShared'

interface Props {
  organizationId: string | null
}

/** Events tab: the organization's events with create + per-event deep link. */
export function EventManagementEventsView(_props: Props) {
  const { events, status, loading, error, reload } = useEventList()
  const [showCreate, setShowCreate] = useState(false)

  if (status === 'denied' || status === 'signed_out') return <EventListAccessState status={status} />

  return (
    <div className="sera-sc-page">
      <EventPageHeader
        eyebrow="Event Management"
        title={<><CalendarRange className="h-5 w-5 text-[var(--sera-orange)]" />Events</>}
        description="Create events, assign staff, generate QR codes and track registrations."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={reload} className="gap-2" disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)} className={PRIMARY_ACTION_CLASS}>
              <Plus className="h-4 w-4" /> New Event
            </Button>
          </>
        }
      />

      {status === 'ready' && error ? <p className="text-sm text-red-600">{error}</p> : null}

      {/* The empty state needs a successful answer; until then show loading or the failure. */}
      {status === 'loading' ? (
        <p role="status" className="text-sm text-muted-foreground">Loading events…</p>
      ) : status === 'error' ? (
        <EventListError error={error} onRetry={reload} retrying={loading} />
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--sera-line)] bg-white p-10 text-center text-sm text-muted-foreground">
          <CalendarRange className="mx-auto mb-2 text-[var(--sera-muted)]" size={28} />
          No events yet. Create your first event to get started.
        </div>
      ) : (
        <>
          {/* Desktop / tablet */}
          <div className="hidden overflow-x-auto rounded-xl border border-[var(--sera-line)] bg-white md:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--sera-mist)] text-xs uppercase text-[var(--sera-muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Event</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Starts</th>
                  <th className="px-4 py-3 font-medium">Ends</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--sera-line)]">
                {events.map((event) => (
                  <tr key={event.id} className="hover:bg-[var(--sera-mist)]/60">
                    <td className="px-4 py-3 font-medium text-[var(--sera-ink)]">{event.name}</td>
                    <td className="px-4 py-3"><EventStatusBadge status={event.status} /></td>
                    <td className="px-4 py-3 text-muted-foreground">{formatEventDate(event.starts_at)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatEventDate(event.ends_at)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link href={eventTabHref(event.id, 'event-overview')} className="font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)]">
                        Manage
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile */}
          <ul className="divide-y divide-[var(--sera-line)] overflow-hidden rounded-xl border border-[var(--sera-line)] bg-white md:hidden">
            {events.map((event) => (
              <li key={event.id}>
                <Link href={eventTabHref(event.id, 'event-overview')} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-[var(--sera-ink)]">{event.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatEventDate(event.starts_at)} – {formatEventDate(event.ends_at)}
                    </p>
                  </div>
                  <EventStatusBadge status={event.status} />
                  <ChevronRight className="h-4 w-4 text-[var(--sera-muted)]" />
                </Link>
              </li>
            ))}
          </ul>
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
