import DashboardContent from '@/components/dashboard/DashboardContent'
import { getSettingsPageContext } from '@/app/settings/_lib'
import AccessState from '@/components/access/AccessState'

/**
 * /settings — Settings module landing page.
 * Shows hero banner + category cards (like HR/Finance landing).
 */
export default async function SettingsPage() {
    const { userProfile, canViewSettings } = await getSettingsPageContext()

    if (!canViewSettings) {
        return (
            <AccessState kind="denied" />
        )
    }

    return <DashboardContent userProfile={userProfile} initialView="settings" />
}
