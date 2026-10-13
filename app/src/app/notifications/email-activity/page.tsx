import DashboardContent from '@/components/dashboard/DashboardContent'
import { getSettingsPageContext } from '@/app/settings/_lib'
import AccessState from '@/components/access/AccessState'

export const dynamic = 'force-dynamic'

export default async function EmailActivityPage() {
  const { userProfile, canViewSettings } = await getSettingsPageContext()
  if (!canViewSettings) return <AccessState kind="denied" />
  return <DashboardContent userProfile={userProfile} initialView="notifications/email-activity" />
}
