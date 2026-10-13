import DashboardContent from '@/components/dashboard/DashboardContent'
import AccessState from '@/components/access/AccessState'
import { navActorFromProfile, resolveDestinationAccess } from '@/lib/server/nav-access'
import { roadtourDestinationForView } from '@/modules/roadtour/roadtourNav'
import { getRoadtourPageContext } from '@/app/roadtour/_lib'

/** Shared server renderer for RoadTour admin subpages (real URLs, same shell). */
export async function RoadtourAdminView({ view }: { view: string }) {
  const { userProfile, canViewRoadtour, accessState } = await getRoadtourPageContext()
  if (!canViewRoadtour) return <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
  // Each section needs its own RoadTour permission (campaigns, reporting, visits, settings, KPI settings).
  const section = await resolveDestinationAccess(navActorFromProfile(userProfile), roadtourDestinationForView(view))
  if (section.state !== 'allowed') return <AccessState kind={section.state === 'unavailable' ? 'unavailable' : 'denied'} />
  return <DashboardContent userProfile={userProfile} initialView={view} />
}
