import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrPayrollAllowancesPage() {
    const { userProfile, gate } = await getHrPageContext('hr/payroll/allowances-deductions')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/payroll/allowances-deductions" />
}
