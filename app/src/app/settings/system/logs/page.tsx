import DashboardContent from '@/components/dashboard/DashboardContent'
import { getSettingsPageContext } from '@/app/settings/_lib'
import AccessState from '@/components/access/AccessState'
import { resolveSystemLogAccess } from '@/lib/system-logs/access'

/**
 * /settings/system/logs — System Logs. Guarded by platform.system_logs.view (Security & Access), NOT by Settings
 * access: viewing Settings or User Management alone never opens it, and a System Log Viewer does not need the rest of
 * Settings. Every data request is authorized again by /api/system-logs.
 */
export default async function SystemLogsPage() {
    const { user, userProfile } = await getSettingsPageContext()
    const access = await resolveSystemLogAccess(user.id, { probe: true })
    if (!access.allowed) return <AccessState kind={access.status === 503 ? 'unavailable' : 'denied'} />
    return <DashboardContent userProfile={userProfile} initialView="settings/system/logs" />
}
