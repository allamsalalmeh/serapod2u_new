import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrPeopleDepartmentsPage() {
    const { userProfile, gate } = await getHrPageContext('hr/people/departments')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/people/departments" />
}
