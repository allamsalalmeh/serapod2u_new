import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrPerformanceReviewsPage() {
    const { userProfile, gate } = await getHrPageContext('hr/performance/reviews')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/performance/reviews" />
}
