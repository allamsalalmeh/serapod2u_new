import { authorizeOperation, organizationResource } from '@/lib/security-access/operation'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { getSupplyChainPageContext } from '@/app/supply-chain/_lib'
import { resolveSupplyChainSlug } from '@/modules/supply-chain/supplyChainNav'
import { supplyChainDestinationForView } from '@/lib/security-access/nav-access'
import AccessState from '@/components/access/AccessState'

interface SupplyChainSubPageProps {
    params: Promise<{ slug?: string[] }>
}

export default async function SupplyChainSubPage({ params }: SupplyChainSubPageProps) {
    const { slug = [] } = await params
    const { initialView, initialOrgId, initialOrderId, initialProductId } = resolveSupplyChainSlug(slug)
    // A direct URL needs the same S&A decision as its menu entry (module entry + the view's own destination).
    const { userProfile, canViewSupplyChain, accessState } = await getSupplyChainPageContext(supplyChainDestinationForView(initialView))

    const orgType = userProfile.organizations?.org_type_code
    const roleLevel = userProfile.roles?.role_level
    // Inventory settings follow the same S&A decision as their APIs
    // (inventory.stock_config.manage); the HQ admin rule is the legacy evaluator.
    const canManageInventorySettings =
        initialView !== 'inventory-settings' ||
        (userProfile.organization_id
            ? await authorizeOperation({
                actorId: userProfile.id,
                permission: 'inventory.stock_config.manage',
                resource: organizationResource('inventory_administration', userProfile.organization_id),
                legacy: () => orgType === 'HQ' && (roleLevel === 1 || roleLevel === 10),
            }).then(d => d.decision === 'ALLOW').catch(() => false)
            : false)

    if (!canViewSupplyChain || !canManageInventorySettings) {
        return (
            <AccessState kind={accessState === 'unavailable' ? 'unavailable' : 'denied'} />
        )
    }

    return (
        <DashboardContent
            userProfile={userProfile}
            initialView={initialView}
            initialOrgId={initialOrgId}
            initialOrderId={initialOrderId}
            initialProductId={initialProductId}
        />
    )
}
