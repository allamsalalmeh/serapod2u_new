import DashboardContent from '@/components/dashboard/DashboardContent'
import { getPortalPageContext } from '@/app/_lib/portal-page-context'
import AccessState from '@/components/access/AccessState'
import { navActorFromProfile, resolveDestinationAccess } from '@/lib/server/nav-access'
import { REPORTING_DESTINATION } from '@/lib/security-access/nav-access'

/**
 * /reporting — cross-module analytics. The same decision as the sidebar entry and every /api/reporting route:
 * reporting.analytics.view (Reporting Viewer policy), evaluated by the canonical S&A engine in its current migration mode.
 */
export default async function ReportingPage() {
  const { userProfile } = await getPortalPageContext()
  const access = await resolveDestinationAccess(navActorFromProfile(userProfile), REPORTING_DESTINATION)
  if (access.state !== 'allowed') {
    return <AccessState kind={access.state === 'unavailable' ? 'unavailable' : 'denied'} />
  }
  return <DashboardContent userProfile={userProfile} initialView="reporting" />
}
