import DashboardContent from '@/components/dashboard/DashboardContent'
import AccessState from '@/components/access/AccessState'
import { getPortalPageContext } from '@/app/_lib/portal-page-context'
import { navActorFromProfile, resolveUserManagementAccess } from '@/lib/server/nav-access'

interface UserProfilePageProps {
  params: Promise<{ id: string }>
}

export default async function UserProfilePage({ params }: UserProfilePageProps) {
  const { userProfile } = await getPortalPageContext()
  const { id } = await params
  // Another person's record is a User Management destination; one's own record stays open.
  if (id !== userProfile.id) {
    const access = await resolveUserManagementAccess(navActorFromProfile(userProfile))
    if (access.state !== 'allowed') return <AccessState kind={access.state === 'unavailable' ? 'unavailable' : 'denied'} />
  }
  return (
    <DashboardContent
      userProfile={userProfile}
      initialView="user-profile"
      initialTargetId={id}
    />
  )
}
