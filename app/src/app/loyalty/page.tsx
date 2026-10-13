import DashboardContent from '@/components/dashboard/DashboardContent'
import { getLoyaltyPageContext } from '@/app/loyalty/_lib'
import AccessState from '@/components/access/AccessState'

/**
 * /loyalty — Loyalty module landing page.
 * Shows hero banner + sub-module cards (same pattern as Finance/Supply Chain landing).
 */
export default async function LoyaltyPage() {
    const { userProfile, canViewLoyalty, accessState } = await getLoyaltyPageContext()

    if (!canViewLoyalty) {
        return (
            <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
        )
    }

    return <DashboardContent userProfile={userProfile} initialView="loyalty" />
}
