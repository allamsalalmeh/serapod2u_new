import DashboardContent from '@/components/dashboard/DashboardContent'
import HrStaffOrgChartView from '@/components/hr/workspace/HrStaffOrgChartView'
import { getHrPageContext } from '@/app/hr/_lib'

/**
 * The administrative chart needs the HR module entry plus hr.employee.view. Staff with the directory read permission get
 * the limited read-only chart (name, job title, department, reporting line) instead; both are checked on the server.
 */
export default async function HrOrgChartPage() {
    const { userProfile, access, gate } = await getHrPageContext(['hr/people/org-chart', 'hr/people/org-chart/staff'])
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    if (access.state === 'allowed' && access.destination === 'hr/people/org-chart/staff') {
        return (
            <DashboardContent userProfile={userProfile} initialView="hr/people/org-chart">
                <HrStaffOrgChartView />
            </DashboardContent>
        )
    }
    return <DashboardContent userProfile={userProfile} initialView="hr/people/org-chart" />
}
