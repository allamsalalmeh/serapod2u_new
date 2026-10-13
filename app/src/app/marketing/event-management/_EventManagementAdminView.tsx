import type { ReactNode } from 'react'
import DashboardContent from '@/components/dashboard/DashboardContent'
import AccessState from '@/components/access/AccessState'
import { getEventManagementPageContext } from '@/app/marketing/event-management/_lib'

/**
 * Shared server renderer for Event Management admin pages (real URLs, standard dashboard shell — same pattern as
 * RoadtourAdminView). Access is the Marketing parent gate `marketing.module.view` with organization isolation; every
 * Event Management API re-checks it.
 */
export async function EventManagementAdminView({
  view,
  render,
}: {
  view: string
  render: (context: { organizationId: string | null }) => ReactNode
}) {
  const { userProfile, canViewMarketing, accessState, organizationId } = await getEventManagementPageContext()
  if (!canViewMarketing) return <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
  return (
    <DashboardContent userProfile={userProfile} initialView={view}>
      {render({ organizationId })}
    </DashboardContent>
  )
}
