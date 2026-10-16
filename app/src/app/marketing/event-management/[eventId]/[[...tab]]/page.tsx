import { notFound } from 'next/navigation'
import { EventManagementAdminView } from '@/app/marketing/event-management/_EventManagementAdminView'
import { EventDetailView } from '@/modules/event-management/components/EventDetailView'
import { resolveEventTab } from '@/modules/event-management/eventManagementNav'

export const dynamic = 'force-dynamic'

export default async function EventManagementEventPage({
  params,
}: {
  params: Promise<{ eventId: string; tab?: string[] }>
}) {
  const { eventId, tab: segments } = await params
  const tab = resolveEventTab(segments)
  if (!tab) notFound()

  return (
    <EventManagementAdminView
      view={tab}
      render={({ organizationId }) => <EventDetailView organizationId={organizationId} eventId={eventId} tab={tab} />}
    />
  )
}
