import DashboardContent from '@/components/dashboard/DashboardContent'
import { getSettingsPageContext } from '@/app/settings/_lib'
import AccessState from '@/components/access/AccessState'

export default async function WhatsAppActivityRecoveryPage() {
  const { userProfile, canViewSettings } = await getSettingsPageContext()
  if (!canViewSettings) return <AccessState kind="denied" />
  return <DashboardContent userProfile={userProfile} initialView="notifications/whatsapp-activity-recovery" />
}
