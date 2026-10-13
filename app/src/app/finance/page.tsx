import DashboardContent from '@/components/dashboard/DashboardContent'
import { getFinancePageContext } from '@/app/finance/_lib'
import AccessState from '@/components/access/AccessState'

/**
 * /finance — Finance module landing page.
 * Shows hero banner + sub-module cards (like HR landing).
 */
export default async function FinancePage() {
    const { userProfile, canViewFinance, accessState } = await getFinancePageContext('finance')

    if (!canViewFinance) {
        return (
            <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
        )
    }

    return <DashboardContent userProfile={userProfile} initialView="finance" />
}
