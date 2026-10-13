import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrPerformanceAppraisalsPage() {
    const { userProfile, gate } = await getHrPageContext('hr/performance/appraisals')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/performance/appraisals" />
}
