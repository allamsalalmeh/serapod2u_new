import DashboardContent from '@/components/dashboard/DashboardContent'
import { notFound } from 'next/navigation'
import { getPortalPageContext } from '@/app/_lib/portal-page-context'
import { commissionReleased } from '@/lib/hr/commission/release'

// The release switch is read per request (runtime environment), never baked in at build time.
export const dynamic = 'force-dynamic'

/**
 * HR → Payroll → Commission Settings. The shell loads no commission data: the view asks the commission API, where the
 * database decides access (hr.commission.view / manage / approve) for every read and action.
 */
export default async function HrPayrollCommissionSettingsPage() {
    if (!commissionReleased()) notFound()
    const { userProfile } = await getPortalPageContext()
    return <DashboardContent userProfile={userProfile} initialView="hr/payroll/commission-settings" />
}
