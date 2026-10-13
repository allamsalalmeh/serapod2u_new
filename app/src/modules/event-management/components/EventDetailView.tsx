'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Download } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { EventEvent, EventRegistration, EventStaff, EventQrToken } from '@/modules/event-management/types/event'
import { EVENT_MANAGEMENT_BASE_PATH, eventManagementEventTabs, eventTabHref, type EventTabId } from '@/modules/event-management/eventManagementNav'
import { EventPageHeader, EventStatusBadge } from '@/modules/event-management/components/EventManagementShared'

interface Props {
  organizationId: string | null
  eventId: string
  /** Active tab, from the URL (/marketing/event-management/<eventId>[/visitors|/staff-qr|/settings]). */
  tab?: EventTabId
}

const EVENTS_HREF = `${EVENT_MANAGEMENT_BASE_PATH}/events`

function BackToEvents() {
  return (
    <Link href={EVENTS_HREF} className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)]">
      <ArrowLeft size={14} /> Events
    </Link>
  )
}

export function EventDetailView({ eventId, tab = 'event-overview' }: Props) {
  const [event, setEvent] = useState<EventEvent | null>(null)
  const [stats, setStats] = useState<any>(null)
  const [staff, setStaff] = useState<EventStaff[]>([])
  const [tokens, setTokens] = useState<EventQrToken[]>([])
  const [registrations, setRegistrations] = useState<EventRegistration[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [eventRes, statsRes, staffRes, tokensRes, regsRes] = await Promise.all([
        fetch(`/api/event-management/events/${eventId}`),
        fetch(`/api/event-management/events/${eventId}/stats`),
        fetch(`/api/event-management/events/${eventId}/staff`),
        fetch(`/api/event-management/events/${eventId}/qr`),
        fetch(`/api/event-management/events/${eventId}/registrations`),
      ])
      const [eventBody, statsBody, staffBody, tokensBody, regsBody] = await Promise.all([
        eventRes.json(), statsRes.json(), staffRes.json(), tokensRes.json(), regsRes.json(),
      ])
      if (eventRes.ok) setEvent(eventBody.data)
      if (statsRes.ok) setStats(statsBody.data)
      if (staffRes.ok) setStaff(staffBody.data ?? [])
      if (tokensRes.ok) setTokens(tokensBody.data ?? [])
      if (regsRes.ok) setRegistrations(regsBody.data ?? [])
      if (!eventRes.ok) setError(eventBody.error || 'Failed to load event.')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  if (loading && !event) return <div className="sera-sc-page text-sm text-muted-foreground">Loading…</div>
  if (error && !event) {
    return (
      <div className="sera-sc-page">
        <div>
          <BackToEvents />
          <p className="text-sm text-red-600">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="sera-sc-page">
      <EventPageHeader
        eyebrow="Event Management · Event"
        title={<>{event?.name ?? 'Event'}{event ? <EventStatusBadge status={event.status} /> : null}</>}
        description={event ? `${new Date(event.starts_at).toLocaleString()} – ${new Date(event.ends_at).toLocaleString()}` : undefined}
      >
        <BackToEvents />
      </EventPageHeader>

      <nav aria-label="Event sections" className="scrollbar-hide -mt-2 flex gap-1 overflow-x-auto border-b border-[var(--sera-line)]">
        {eventManagementEventTabs.map((t) => {
          const active = tab === t.id
          const Icon = t.icon
          return (
            <Link
              key={t.id}
              href={eventTabHref(eventId, t.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                '-mb-px inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors sm:px-4',
                active
                  ? 'border-[var(--sera-orange)] text-[var(--sera-orange-deep)]'
                  : 'border-transparent text-[var(--sera-muted)] hover:text-[var(--sera-ink)]'
              )}
            >
              <Icon size={16} /> {t.label}
            </Link>
          )
        })}
      </nav>

      <div>
        {tab === 'event-overview' ? <OverviewTab event={event} stats={stats} /> : null}
        {tab === 'event-visitors' ? <VisitorsTab eventId={eventId} registrations={registrations} /> : null}
        {tab === 'event-staff-qr' ? <StaffQrTab eventId={eventId} staff={staff} tokens={tokens} onReload={loadAll} /> : null}
        {tab === 'event-settings' && event ? <SettingsTab event={event} onReload={loadAll} /> : null}
      </div>
    </div>
  )
}

function OverviewTab({ event, stats }: { event: EventEvent | null; stats: any }) {
  if (!event) return null
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="Total registrations" value={stats?.total ?? 0} />
        <StatCard label="Staff registrations" value={stats?.staff ?? 0} />
        <StatCard label="Booth registrations" value={stats?.booth ?? 0} />
        <StatCard label="Status" value={event.status} />
      </div>

      <div className="rounded-lg border border-[var(--sera-line)] bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-900">Staff leaderboard</h3>
        {!stats?.staffComparison?.length ? (
          <p className="text-sm text-gray-500">No staff registrations yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-gray-500"><tr><th className="py-2">Staff</th><th className="py-2 text-right">Registrations</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {stats.staffComparison.map((s: any) => (
                <tr key={s.staff_user_id}>
                  <td className="py-2 text-gray-900">{s.full_name ?? 'Unknown'}</td>
                  <td className="py-2 text-right font-medium text-gray-900">{s.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-gray-400">Booth registrations are excluded from staff rankings.</p>
      </div>

      <div className="rounded-lg border border-[var(--sera-line)] bg-white p-4 text-sm text-gray-600">
        <h3 className="mb-2 text-sm font-semibold text-gray-900">Event details</h3>
        <p>Starts: {new Date(event.starts_at).toLocaleString()}</p>
        <p>Ends: {new Date(event.ends_at).toLocaleString()}</p>
        <p>Timezone: {event.timezone}</p>
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-[var(--sera-line)] bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  )
}

function VisitorsTab({ eventId, registrations }: { eventId: string; registrations: EventRegistration[] }) {
  const [q, setQ] = useState('')

  const filtered = q.trim()
    ? registrations.filter((r) => {
        const haystack = [r.contact?.name, r.contact?.phone_normalized, r.contact?.email_normalized]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return haystack.includes(q.trim().toLowerCase())
      })
    : registrations

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, phone or email…"
          className="w-full max-w-xs rounded-lg border border-[var(--sera-line)] px-3 py-2 text-sm"
        />
        <a
          href={`/api/event-management/events/${eventId}/registrations/export?format=csv`}
          className="ml-auto inline-flex items-center gap-1 rounded-lg bg-[var(--sera-orange)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--sera-orange-deep)]"
        >
          <Download size={14} /> Export CSV
        </a>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-gray-500">No registrations yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--sera-line)] bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Phone</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Cat</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Attributed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 text-gray-900">{r.contact?.name}</td>
                  <td className="px-4 py-2 text-gray-600">{r.contact?.phone_normalized}</td>
                  <td className="px-4 py-2 text-gray-600">{r.contact?.email_normalized ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-600">{r.contact?.cat_name ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-600">{r.qr_token_kind === 'booth' ? 'Booth' : 'Staff'}</td>
                  <td className="px-4 py-2 text-gray-600">{r.attributed_staff_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function StaffQrTab({ eventId, staff, tokens, onReload }: { eventId: string; staff: EventStaff[]; tokens: EventQrToken[]; onReload: () => void }) {
  const [staffUserId, setStaffUserId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function assign() {
    setError(null)
    if (!staffUserId.trim()) return setError('Enter a staff user id.')
    setBusy(true)
    try {
      const res = await fetch(`/api/event-management/events/${eventId}/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: staffUserId.trim() }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to assign staff.')
      setStaffUserId('')
      onReload()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function generate(kind: 'staff' | 'booth', staffUserId?: string) {
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/event-management/events/${eventId}/qr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, staff_user_id: staffUserId ?? null }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to generate QR.')
      onReload()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(tokenId: string) {
    setBusy(true)
    await fetch(`/api/event-management/events/${eventId}/qr?token_id=${encodeURIComponent(tokenId)}`, { method: 'DELETE' })
    onReload()
    setBusy(false)
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-2 text-sm font-semibold text-gray-900">Assigned staff</h3>
        <div className="mb-2 flex gap-2">
          <input value={staffUserId} onChange={(e) => setStaffUserId(e.target.value)} placeholder="Staff user id" className="w-full max-w-xs rounded-lg border border-[var(--sera-line)] px-3 py-2 text-sm" />
          <button onClick={assign} disabled={busy} className="rounded-lg bg-[var(--sera-orange)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--sera-orange-deep)] disabled:opacity-60">Assign</button>
        </div>
        {staff.length === 0 ? (
          <p className="text-sm text-gray-500">No staff assigned.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-lg border border-[var(--sera-line)] bg-white">
            {staff.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="text-gray-900">{s.full_name ?? s.user_id}</span>
                <button onClick={() => generate('staff', s.user_id)} disabled={busy} className="text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)]">Generate QR</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900">QR codes</h3>
          <button onClick={() => generate('booth')} disabled={busy} className="rounded-lg border border-[var(--sera-line)] px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">Generate booth QR</button>
        </div>
        {tokens.length === 0 ? (
          <p className="text-sm text-gray-500">No QR codes yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-lg border border-[var(--sera-line)] bg-white">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <div>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.kind === 'booth' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{t.kind}</span>
                  <span className="ml-2 text-gray-900">{t.staff_name ?? 'Booth'}</span>
                  <span className="ml-2 text-xs text-gray-400">{t.status}</span>
                </div>
                <div className="flex items-center gap-3">
                  {t.status === 'active' ? <a href={`/api/event-management/events/${eventId}/qr/${t.token}/image`} target="_blank" rel="noreferrer" className="text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)]">View QR</a> : null}
                  {t.status === 'active' ? <button onClick={() => revoke(t.id)} disabled={busy} className="text-red-600 hover:text-red-700">Revoke</button> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  )
}

function SettingsTab({ event, onReload }: { event: EventEvent; onReload: () => void }) {
  const [status, setStatus] = useState(event.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function saveStatus() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/event-management/events/${event.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to update event.')
      onReload()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-sm space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-900">Status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="mt-1 w-full rounded-lg border border-[var(--sera-line)] px-3 py-2 text-sm">
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="ended">Ended</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <p className="mt-1 text-xs text-gray-400">Public registration only works while status is Active and within the registration window.</p>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button onClick={saveStatus} disabled={busy} className="rounded-lg bg-[var(--sera-orange)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--sera-orange-deep)] disabled:opacity-60">
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}


