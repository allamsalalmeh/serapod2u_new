import DashboardContent from '@/components/dashboard/DashboardContent'
import { getMarketingPageContext } from '@/app/marketing/_lib'
import AccessState from '@/components/access/AccessState'

/**
 * /marketing — Marketing module landing page.
 * Shows hero banner + sub-module cards (same pattern as Finance/Supply Chain landing).
 */
export default async function MarketingPage() {
    const { userProfile, canViewMarketing, accessState } = await getMarketingPageContext()

    if (!canViewMarketing) {
        return (
            <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
        )
    }

    return <DashboardContent userProfile={userProfile} initialView="mktg" />
}
