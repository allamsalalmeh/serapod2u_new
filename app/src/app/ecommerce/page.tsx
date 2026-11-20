import DashboardContent from '@/components/dashboard/DashboardContent'
import { getEcommercePageContext } from '@/app/ecommerce/_lib'
import AccessState from '@/components/access/AccessState'
import { navActorFromProfile, resolveDestinationAccess } from '@/lib/server/nav-access'

/** Landing sections in order of preference; the first one the person may open is shown. */
const ECOMMERCE_LANDING_VIEWS = ['store-banner-manager', 'store-orders', 'ecommerce/tiktok-shop', 'ecommerce/payment-gateway'] as const

/**
 * /ecommerce — E-commerce module landing page.
 * Opens the first section the person is authorized for (Store Banner Manager when allowed).
 * Part of the Customer & Growth domain.
 */
export default async function EcommercePage() {
    const { userProfile, canViewEcommerce, accessState, access } = await getEcommercePageContext()

    if (!canViewEcommerce) {
        return (
            <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} referenceId={access.state === 'denied' ? access.referenceId : undefined} />
        )
    }

    const landing = await resolveDestinationAccess(navActorFromProfile(userProfile), ECOMMERCE_LANDING_VIEWS)
    if (landing.state !== 'allowed') {
        return <AccessState kind={landing.state === 'unavailable' ? 'unavailable' : 'denied'} referenceId={landing.state === 'denied' ? landing.referenceId : undefined} />
    }

    return <DashboardContent userProfile={userProfile} initialView={landing.destination} />
}
