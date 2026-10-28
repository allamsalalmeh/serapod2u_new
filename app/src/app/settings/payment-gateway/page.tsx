import DashboardContent from '@/components/dashboard/DashboardContent'
import { getSettingsPageContext } from '@/app/settings/_lib'
import AccessState from '@/components/access/AccessState'
import { navActorFromProfile, resolveDestinationAccess } from '@/lib/server/nav-access'

export default async function SettingsPaymentGatewayPage() {
    const { userProfile, canViewSettings } = await getSettingsPageContext()
    if (!canViewSettings) return <AccessState kind="denied" />
    // Payment Gateway is privileged administration (ecommerce.channel.manage), not part of the general Settings entry.
    const access = await resolveDestinationAccess(navActorFromProfile(userProfile), 'settings/payment-gateway')
    if (access.state !== 'allowed') return <AccessState kind={access.state === 'unavailable' ? 'unavailable' : 'denied'} referenceId={access.state === 'denied' ? access.referenceId : undefined} />
    return <DashboardContent userProfile={userProfile} initialView="settings/payment-gateway" />
}
