import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrSettingsApprovalRulesPage() {
    const { userProfile, gate } = await getHrPageContext('hr/settings/approval-rules')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/settings/approval-rules" />
}
