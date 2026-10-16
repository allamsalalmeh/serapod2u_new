import DashboardContent from '@/components/dashboard/DashboardContent'
import AccessState from '@/components/access/AccessState'
import { getRoadtourPageContext } from '@/app/roadtour/_lib'

export default async function RoadtourPage() {
  const { userProfile, canViewRoadtour, accessState } = await getRoadtourPageContext()
  if (!canViewRoadtour) return <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
  return <DashboardContent userProfile={userProfile} initialView="roadtour" />
}
