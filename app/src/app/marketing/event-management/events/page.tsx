import { EventManagementAdminView } from '@/app/marketing/event-management/_EventManagementAdminView'
import { EventManagementEventsView } from '@/modules/event-management/components/EventManagementEventsView'

export const dynamic = 'force-dynamic'

export default function EventManagementEventsPage() {
  return (
    <EventManagementAdminView
      view="event-management-events"
      render={({ organizationId }) => <EventManagementEventsView organizationId={organizationId} />}
    />
  )
}
