'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import AccessState from '@/components/access/AccessState'
import type { EventEvent } from '@/modules/event-management/types/event'

/** Primary action style used across Serapod module pages (e.g. RoadTour "New campaign"). */
export const PRIMARY_ACTION_CLASS = 'gap-2 bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]'

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-700',
  ended: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-red-100 text-red-700',
}

export function EventStatusBadge({ status }: { status: string }) {
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize', STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-700')}>
      {status}
    </span>
  )
}

/** Standard Serapod page header (orange bar, eyebrow, display title) used by module subpages such as RoadTour's. */
export function EventPageHeader({
  eyebrow,
  title,
  description,
  actions,
  children,
}: {
  eyebrow: string
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {children}
        <div className="sera-sc-header__bar mb-3 h-1 w-12 rounded-sm bg-[var(--sera-orange)]" />
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--sera-muted)]">{eyebrow}</p>
        <h1 className="font-display flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-tight text-[var(--sera-ink)] sm:text-3xl">
          {title}
        </h1>
        {description ? <p className="mt-1.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function formatEventDate(value: string | null | undefined, withTime = false): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return withTime ? date.toLocaleString() : date.toLocaleDateString()
}

/**
 * Outcome of the events request. Only `ready` is a successful answer, so counts and empty states are shown only
 * then; `denied` is the server's Security & Access decision (403), `signed_out` an expired session (401), and `error`
 * any other failure (network, 5xx, malformed body), which is not a statement about access.
 */
export type EventListStatus = 'loading' | 'ready' | 'denied' | 'signed_out' | 'error'

/** Loads the organization's events from the admin API (org is derived server-side). */
export function useEventList() {
  const [events, setEvents] = useState<EventEvent[]>([])
  const [status, setStatus] = useState<EventListStatus>('loading')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Only the latest request may update state: a slower earlier response (or one after unmount) is ignored.
  const requestSeq = useRef(0)
  const loadedRef = useRef(false)

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)
    let next: { status: EventListStatus; events?: EventEvent[]; error?: string }
    try {
      const res = await fetch('/api/event-management/events')
      const body = await res.json().catch(() => null)
      if (res.status === 403) next = { status: 'denied' }
      else if (res.status === 401) next = { status: 'signed_out' }
      else if (!res.ok || !body || !Array.isArray(body.data)) next = { status: 'error', error: body?.error || 'Failed to load events.' }
      else next = { status: 'ready', events: body.data }
    } catch {
      next = { status: 'error', error: 'Failed to load events. Check your connection and try again.' }
    }
    if (seq !== requestSeq.current) return
    if (next.status === 'ready') {
      setEvents(next.events ?? [])
      loadedRef.current = true
    } else if (next.status !== 'error') {
      setEvents([])
      loadedRef.current = false
    }
    // A failed refresh keeps the last successful list; the error is shown next to it.
    setStatus(next.status === 'error' && loadedRef.current ? 'ready' : next.status)
    setError(next.error ?? null)
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    return () => {
      requestSeq.current++
    }
  }, [load])

  return { events, status, loading, error, reload: load }
}

/** Access outcomes of the events request, shown instead of the page (never as an empty list). */
export function EventListAccessState({ status }: { status: EventListStatus }) {
  if (status === 'denied') return <AccessState kind="denied" />
  if (status === 'signed_out') return <AccessState kind="signed_out" />
  return null
}

/** A failed events request before any successful answer: says so and offers a retry, with no counts or empty state. */
export function EventListError({ error, onRetry, retrying }: { error: string | null; onRetry: () => void; retrying?: boolean }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-white px-4 py-6 text-center text-sm">
      <p className="font-medium text-[var(--sera-ink)]">We couldn’t load events.</p>
      <p className="mt-1 text-muted-foreground">{error || 'Failed to load events.'}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry} disabled={retrying}>
        Try again
      </Button>
    </div>
  )
}

export function CreateEventDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (event: EventEvent | null) => void
}) {
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
      setName('')
      setStartsAt('')
      setEndsAt('')
      setStatus('draft')
      onCreated(body.data ?? null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  const inputClass = 'mt-1 w-full rounded-lg border border-[var(--sera-line)] bg-white px-3 py-2 text-sm text-[var(--sera-ink)] focus:border-[var(--sera-orange)] focus:outline-none'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Event</DialogTitle>
          <DialogDescription>Create the event first, then assign staff and generate QR codes.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-xs font-medium text-[var(--sera-muted)]">
            Event name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Event name" className={inputClass} />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block text-xs font-medium text-[var(--sera-muted)]">
              Start date/time
              <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={inputClass} />
            </label>
            <label className="block text-xs font-medium text-[var(--sera-muted)]">
              End date/time
              <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={inputClass} />
            </label>
          </div>
          <label className="block text-xs font-medium text-[var(--sera-muted)]">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as 'draft' | 'active')} className={inputClass}>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
            </select>
          </label>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={submitting} className={PRIMARY_ACTION_CLASS}>{submitting ? 'Creating…' : 'Create'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
