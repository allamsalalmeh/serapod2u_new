import DashboardContent from '@/components/dashboard/DashboardContent'
import { getSettingsPageContext } from '@/app/settings/_lib'
import { ensureNotificationTypes } from '@/lib/notifications/ensureNotificationTypes'
import AccessState from '@/components/access/AccessState'

export default async function SettingsNotificationTypesPage() {
    await ensureNotificationTypes()
    const { userProfile, canViewSettings } = await getSettingsPageContext()
    if (!canViewSettings) return <AccessState kind="denied" />
    return <DashboardContent userProfile={userProfile} initialView="settings/notifications/types" />
}
