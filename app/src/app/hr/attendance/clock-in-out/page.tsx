import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrAttendanceClockPage() {
    const { userProfile, gate } = await getHrPageContext('hr/attendance/clock-in-out')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/attendance/clock-in-out" />
}
