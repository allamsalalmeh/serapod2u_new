import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrPayrollPayslipsPage() {
    const { userProfile, gate } = await getHrPageContext('hr/payroll/payslips')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/payroll/payslips" />
}
