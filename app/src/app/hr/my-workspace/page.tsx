import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

/** /hr/my-workspace — the employee-facing HR entry (Employee Self-Service, own record). */
export default async function HrMyWorkspacePage() {
    const { userProfile, gate } = await getHrPageContext('hr/my-workspace')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/my-workspace" />
}
