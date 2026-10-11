import DashboardContent from '@/components/dashboard/DashboardContent'
import { getPortalPageContext } from '@/app/_lib/portal-page-context'

/**
 * HR → Payroll → Commission Settings. The shell loads no commission data: the view asks the commission API, where the
 * database decides access (hr.commission.view / manage / approve) for every read and action.
 */
export default async function HrPayrollCommissionSettingsPage() {
    const { userProfile } = await getPortalPageContext()
    return <DashboardContent userProfile={userProfile} initialView="hr/payroll/commission-settings" />
}
