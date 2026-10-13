import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrLeaveApprovalFlowPage() {
    const { userProfile, gate } = await getHrPageContext('hr/leave/approval-flow')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/leave/approval-flow" />
}
