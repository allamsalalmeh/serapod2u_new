import DashboardContent from '@/components/dashboard/DashboardContent'
import { getFinancePageContext } from '@/app/finance/_lib'
import AccessState from '@/components/access/AccessState'

export default async function ARReceiptsPage() {
    const { userProfile, canViewFinance, accessState } = await getFinancePageContext('finance/ar/receipts')
    if (!canViewFinance) {
        return <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
    }
    return <DashboardContent userProfile={userProfile} initialView="finance/ar/receipts" />
}
