import DashboardContent from '@/components/dashboard/DashboardContent'
import AccessState from '@/components/access/AccessState'
import { getPortalPageContext } from '@/app/_lib/portal-page-context'
import { navActorFromProfile, resolveUserManagementAccess } from '@/lib/server/nav-access'

export default async function UsersPage() {
  const { userProfile } = await getPortalPageContext()
  // Same rule as the sidebar entry (Root Access included); the screen's reads and changes decide again on the server.
  const access = await resolveUserManagementAccess(navActorFromProfile(userProfile))
  if (access.state !== 'allowed') return <AccessState kind={access.state === 'unavailable' ? 'unavailable' : 'denied'} />
  return <DashboardContent userProfile={userProfile} initialView="users" />
}
