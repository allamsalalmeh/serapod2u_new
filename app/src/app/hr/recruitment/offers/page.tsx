import DashboardContent from '@/components/dashboard/DashboardContent'
import { getHrPageContext } from '@/app/hr/_lib'

export default async function HrRecruitmentOffersPage() {
    const { userProfile, gate } = await getHrPageContext('hr/recruitment/offers')
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <DashboardContent userProfile={userProfile} initialView="hr/recruitment/offers" />
}
