import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrPayrollSalaryStructurePage() {
    const { userProfile, gate } = await getHrPageContext('hr/payroll/salary-structure')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/payroll/salary-structure" />
}
