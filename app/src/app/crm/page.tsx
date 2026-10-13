import DashboardContent from '@/components/dashboard/DashboardContent'
import { getCrmPageContext } from '@/app/crm/_lib'
import AccessState from '@/components/access/AccessState'

/**
 * /crm — CRM module landing page.
 * Shows hero banner + sub-module cards (same pattern as Finance/Supply Chain landing).
 */
export default async function CrmPage() {
    const { userProfile, canViewCrm, accessState } = await getCrmPageContext()

    if (!canViewCrm) {
        return (
            <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
        )
    }

    return <DashboardContent userProfile={userProfile} initialView="crm" />
}
