import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrTimeExpenseOverviewPage() {
    const { userProfile, gate } = await getHrPageContext('hr/time-expense/overview')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/time-expense/overview" />
}
