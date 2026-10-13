import { EventManagementAdminView } from '@/app/marketing/event-management/_EventManagementAdminView'
import { EventManagementOverviewView } from '@/modules/event-management/components/EventManagementOverviewView'

export const dynamic = 'force-dynamic'

export default function EventManagementPage() {
  return (
    <EventManagementAdminView
      view="event-management"
      render={({ organizationId }) => <EventManagementOverviewView organizationId={organizationId} />}
    />
  )
}
