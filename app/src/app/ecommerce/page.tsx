import DashboardContent from '@/components/dashboard/DashboardContent'
import { getEcommercePageContext } from '@/app/ecommerce/_lib'
import AccessState from '@/components/access/AccessState'

/**
 * /ecommerce — E-commerce module landing page.
 * Defaults to the Store Banner Manager (Hero Banners) view.
 * Part of the Customer & Growth domain.
 */
export default async function EcommercePage() {
    const { userProfile, canViewEcommerce, accessState } = await getEcommercePageContext()

    if (!canViewEcommerce) {
        return (
            <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
        )
    }

    return <DashboardContent userProfile={userProfile} initialView="store-banner-manager" />
}
