import DashboardContent from '@/components/dashboard/DashboardContent'
import { getSettingsPageContext } from '@/app/settings/_lib'
import AccessState from '@/components/access/AccessState'

export default async function SettingsDocSequencePage() {
    const { userProfile, canViewSettings } = await getSettingsPageContext()
    if (!canViewSettings) return <AccessState kind="denied" />
    return <DashboardContent userProfile={userProfile} initialView="settings/preferences/doc-sequence" />
}
