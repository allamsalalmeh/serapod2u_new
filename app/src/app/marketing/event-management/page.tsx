import { getEventManagementPageContext } from '@/app/marketing/event-management/_lib'
import { EventManagementLandingView } from '@/modules/event-management/components/EventManagementLandingView'

export const dynamic = 'force-dynamic'

export default async function EventManagementPage() {
  const { canViewMarketing, organizationId } = await getEventManagementPageContext()

  if (!canViewMarketing) {
    return (
      <div className="p-8">
        <h2 className="text-xl font-semibold">Unauthorized</h2>
        <p>You do not have permission to view Event Management.</p>
      </div>
    )
  }

  return <EventManagementLandingView organizationId={organizationId} />
}
