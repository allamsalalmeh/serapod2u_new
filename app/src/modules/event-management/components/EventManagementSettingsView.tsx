'use client'

import Link from 'next/link'
import { Settings } from 'lucide-react'
import { EVENT_MANAGEMENT_BASE_PATH } from '@/modules/event-management/eventManagementNav'
import { EventPageHeader } from '@/modules/event-management/components/EventManagementShared'

/**
 * Module Settings. This version has no organization-wide configurable settings, so the page states the registration
 * rules every event enforces (server-side, see validation/registration.ts and the register RPC) rather than offering
 * controls that would do nothing. Per-event changes (status) are made in each event's Settings tab.
 */
const RULES: Array<{ title: string; items: string[] }> = [
  {
    title: 'Registration form',
    items: [
      'Required: name and a valid Malaysian mobile number (stored as +60 E.164).',
      'Optional: email, cat name and cat breed.',
      'No OTP or SMS verification in this version.',
    ],
  },
  {
    title: 'Duplicates & attribution',
    items: [
      'One registration per mobile number per event.',
      'The first QR source (staff or booth) is kept; repeat submissions never overwrite details, consent or attribution.',
      'Booth registrations are excluded from staff rankings.',
    ],
  },
  {
    title: 'When registration is open',
    items: [
      'Public registration only works while the event is Active and within its registration window.',
      'Revoked QR codes stop accepting registrations.',
    ],
  },
]

export function EventManagementSettingsView() {
  return (
    <div className="sera-sc-page">
      <EventPageHeader
        eyebrow="Event Management"
        title={<><Settings className="h-5 w-5 text-[var(--sera-orange)]" />Settings</>}
        description="Registration rules applied to every event. They are fixed in this version and enforced on the server."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {RULES.map((group) => (
          <section key={group.title} className="rounded-xl border border-[var(--sera-line)] bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold text-[var(--sera-ink)]">{group.title}</h2>
            <ul className="list-disc space-y-1.5 pl-4 text-sm text-muted-foreground">
              {group.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        To change an event&apos;s status, open it from{' '}
        <Link href={`${EVENT_MANAGEMENT_BASE_PATH}/events`} className="font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)]">Events</Link>
        {' '}and use its Settings tab.
      </p>
    </div>
  )
}
