import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

/**
 * /hr/attendance/public-holidays — the public-holiday calendar that drives leave working days, attendance day types and
 * overtime day types. Reached from HR → Attendance → Public Holidays and from the HR setup checklist. Viewing follows the
 * destination's S&A decision; changes are decided again by the API (hr.settings.manage).
 */
export default async function HrAttendancePublicHolidaysPage() {
    const { userProfile, gate } = await getHrPageContext('hr/attendance/public-holidays')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/attendance/public-holidays" />
}
