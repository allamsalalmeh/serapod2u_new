'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { CalendarRange, Plus } from 'lucide-react'
import type { EventEvent } from '@/modules/event-management/types/event'

interface Props {
  organizationId: string | null
}

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-700',
  ended: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-red-100 text-red-700',
}

export function EventManagementLandingView({ organizationId }: Props) {
  const [events, setEvents] = useState<EventEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/event-management/events')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to load events.')
      setEvents(body.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Event Management</h1>
          <p className="text-sm text-gray-500">Create events, assign staff, generate QR codes and track registrations.</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700"
        >
          <Plus size={16} /> New Event
        </button>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
          <CalendarRange className="mx-auto mb-2 text-gray-400" size={28} />
          No events yet. Create your first event to get started.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Starts</th>
                <th className="px-4 py-3">Ends</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {events.map((event) => (
                <tr key={event.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{event.name}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[event.status] ?? 'bg-gray-100 text-gray-700'}`}>
                      {event.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{new Date(event.starts_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-gray-600">{new Date(event.ends_at).toLocaleDateString()}</td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/marketing/event-management/${event.id}`} className="font-medium text-orange-600 hover:text-orange-700">
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate ? <CreateEventDialog onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load() }} /> : null}
    </div>
  )
}

function CreateEventDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [status, setStatus] = useState<'draft' | 'active'>('draft')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    if (!name.trim() || !startsAt || !endsAt) return setError('Name, start date and end date are required.')
    setSubmitting(true)
    try {
      const res = await fetch('/api/event-management/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, starts_at: startsAt, ends_at: endsAt, status }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to create event.')
      onCreated()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900">New Event</h2>
        <div className="mt-4 space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Event name"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-500">
              Start date/time
              <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-gray-500">
              End date/time
              <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm" />
            </label>
          </div>
          <label className="text-xs text-gray-500">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm">
              <option value="draft">Draft</option>
              <option value="active">Active</option>
            </select>
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">Cancel</button>
          <button onClick={submit} disabled={submitting} className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-60">
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
