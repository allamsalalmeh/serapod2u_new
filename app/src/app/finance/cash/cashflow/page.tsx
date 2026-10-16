import DashboardContent from '@/components/dashboard/DashboardContent'
import { getFinancePageContext } from '@/app/finance/_lib'
import AccessState from '@/components/access/AccessState'

export default async function CashFlowPage() {
    const { userProfile, canViewFinance, accessState } = await getFinancePageContext('finance/cash/cashflow')
    if (!canViewFinance) {
        return <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
    }
    return <DashboardContent userProfile={userProfile} initialView="finance/cash/cashflow" />
}
