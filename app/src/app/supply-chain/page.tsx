import DashboardContent from '@/components/dashboard/DashboardContent'
import { getSupplyChainPageContext } from '@/app/supply-chain/_lib'
import { resolveSupplyChainDeepLink } from '@/modules/supply-chain/supplyChainNav'
import { supplyChainDestinationForView } from '@/lib/security-access/nav-access'
import AccessState from '@/components/access/AccessState'

/**
 * /supply-chain — Supply Chain module landing page.
 * Shows hero banner + sub-module cards (same pattern as Finance/HR landing).
 */
export default async function SupplyChainPage({ searchParams }: { searchParams: Promise<{ view?: string; orderId?: string }> }) {
    const params = await searchParams
    const deepLink = resolveSupplyChainDeepLink(params.view, params.orderId)
    // An order deep link (?view=view-order&orderId=...) is decided like the Orders list; the landing by the module entry.
    const { userProfile, canViewSupplyChain, accessState } = await getSupplyChainPageContext(supplyChainDestinationForView(deepLink.initialView))

    if (!canViewSupplyChain) {
        return (
            <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
        )
    }

    return <DashboardContent userProfile={userProfile} initialView={deepLink.initialView} initialOrderId={deepLink.initialOrderId} />
}
