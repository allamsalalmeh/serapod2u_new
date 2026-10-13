import DashboardContent from '@/components/dashboard/DashboardContent'
import { getCustomerGrowthPageContext } from '@/app/customer-growth/_lib'
import AccessState from '@/components/access/AccessState'

/**
 * /customer-growth — Customer & Growth domain landing page.
 * Shows hero banner + module cards (same pattern as Supply Chain landing).
 */
export default async function CustomerGrowthPage() {
    const { userProfile, canViewCustomerGrowth, accessState } = await getCustomerGrowthPageContext()

    if (!canViewCustomerGrowth) {
        return (
            <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
        )
    }

    return <DashboardContent userProfile={userProfile} initialView="customer-growth" />
}
