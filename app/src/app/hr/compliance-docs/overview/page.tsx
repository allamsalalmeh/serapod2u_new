import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrComplianceDocsOverviewPage() {
    const { userProfile, gate } = await getHrPageContext('hr/compliance-docs/overview')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/compliance-docs/overview" />
}
