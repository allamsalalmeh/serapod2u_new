import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrRecruitmentApplicantsPage() {
    const { userProfile, gate } = await getHrPageContext('hr/recruitment/applicants')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/recruitment/applicants" />
}
