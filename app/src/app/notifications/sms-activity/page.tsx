import DashboardContent from '@/components/dashboard/DashboardContent'
import NotificationMonitor from '@/components/settings/monitor/NotificationMonitor'
import { getSettingsPageContext } from '@/app/settings/_lib'
import AccessState from '@/components/access/AccessState'

export const dynamic = 'force-dynamic'

export default async function SmsActivityPage() {
  const { userProfile, canViewSettings } = await getSettingsPageContext()
  if (!canViewSettings) return <AccessState kind="denied" />
  return (
    <DashboardContent userProfile={userProfile} initialView="notifications/sms-activity">
      <div className="p-4 sm:p-6">
        <NotificationMonitor initialChannel="sms" />
      </div>
    </DashboardContent>
  )
}
