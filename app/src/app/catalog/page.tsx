import DashboardContent from '@/components/dashboard/DashboardContent'
import { getCatalogPageContext } from '@/app/catalog/_lib'
import AccessState from '@/components/access/AccessState'

/**
 * /catalog — Catalog module landing page.
 * Shows hero banner + sub-module cards (same pattern as Finance/Supply Chain landing).
 */
export default async function CatalogPage() {
    const { userProfile, canViewCatalog, accessState } = await getCatalogPageContext()

    if (!canViewCatalog) {
        return (
            <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
        )
    }

    return <DashboardContent userProfile={userProfile} initialView="catalog" />
}
