import DashboardContent from '@/components/dashboard/DashboardContent'
import { getFinancePageContext } from '@/app/finance/_lib'
import AccessState from '@/components/access/AccessState'

export default async function ARInvoicesPage() {
    const { userProfile, canViewFinance, accessState } = await getFinancePageContext('finance/ar/invoices')
    if (!canViewFinance) {
        return <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
    }
    return <DashboardContent userProfile={userProfile} initialView="finance/ar/invoices" />
}
