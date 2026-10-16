import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrAttendanceTimesheetsPage() {
    const { userProfile, gate } = await getHrPageContext('hr/attendance/timesheets')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/attendance/timesheets" />
}
