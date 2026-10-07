import { getEventManagementPageContext } from '@/app/marketing/event-management/_lib'
import { EventDetailView } from '@/modules/event-management/components/EventDetailView'

export const dynamic = 'force-dynamic'

export default async function EventManagementEventPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { canViewMarketing, organizationId } = await getEventManagementPageContext()
  const { eventId } = await params

  if (!canViewMarketing) {
    return (
      <div className="p-8">
        <h2 className="text-xl font-semibold">Unauthorized</h2>
        <p>You do not have permission to view Event Management.</p>
      </div>
    )
  }

  return <EventDetailView organizationId={organizationId} eventId={eventId} />
}
