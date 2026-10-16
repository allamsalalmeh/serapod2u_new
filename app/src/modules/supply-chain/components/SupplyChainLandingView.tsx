'use client'

import { ArrowRight } from 'lucide-react'
import { filterSupplyChainNavForUser, type SupplyChainNavGroup } from '@/modules/supply-chain/supplyChainNav'
import SupplyChainHeroBanner from './SupplyChainHeroBanner'
import ModuleLandingCard from '@/components/layout/ModuleLandingCard'
import { landingAccents, pickLandingAccent, supplyChainLandingAccents } from '@/lib/landing-accents'
import { Badge } from '@/components/ui/badge'
import { useNavAccess } from '@/hooks/useNavAccess'
import { productCatalogHome, supplyChainViewVisible } from '@/lib/security-access/nav-access'
import { cn } from '@/lib/utils'

interface SupplyChainLandingViewProps {
    userName?: string | null
    bannerImageUrl?: string | null
    onViewChange: (view: string) => void
    orgTypeCode?: string
    roleLevel?: number
}

const defaultIconAccent = landingAccents.orange

export default function SupplyChainLandingView({ userName, bannerImageUrl, onViewChange, orgTypeCode, roleLevel }: SupplyChainLandingViewProps) {
    const { snapshot } = useNavAccess()
    // Only the cards the person may open: organization rules plus the Security & Access answer per view (same decision
    // as the page guard of each /supply-chain/... route).
    const filteredGroups = filterSupplyChainNavForUser(orgTypeCode, roleLevel, productCatalogHome(snapshot) === 'supply-chain',
        (viewId) => supplyChainViewVisible(snapshot, viewId))

    return (
        <div className="sera-module-landing">
            <SupplyChainHeroBanner userName={userName ?? null} bannerImageUrl={bannerImageUrl} />

            <div className="sera-module-landing__grid">
                {filteredGroups.map((group: SupplyChainNavGroup) => {
                    const Icon = group.icon
                    const accent = pickLandingAccent(supplyChainLandingAccents, group.id, defaultIconAccent)

                    return (
                        <ModuleLandingCard
                            key={group.id}
                            icon={Icon}
                            accent={accent}
                            title={group.label}
                            description={group.description}
                        >
                            <ul className="m-0 p-0 list-none">
                                {group.children.map((child) => {
                                    const ChildIcon = child.icon
                                    return (
                                        <li key={child.id}>
                                            <button
                                                type="button"
                                                onClick={() => onViewChange(child.id)}
                                                className="sera-module-landing__link group"
                                            >
                                                <ChildIcon className={cn('h-4 w-4 shrink-0', accent.icon)} strokeWidth={1.75} />
                                                <span className="flex-1">{child.label}</span>
                                                {child.legacy && (
                                                    <Badge variant="outline" className="text-[var(--sera-orange-deep)] border-[var(--sera-orange)]/30 text-[10px] px-1.5 py-0 mr-1">
                                                        Legacy
                                                    </Badge>
                                                )}
                                                <ArrowRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity text-[var(--sera-orange)]" />
                                            </button>
                                        </li>
                                    )
                                })}
                            </ul>
                        </ModuleLandingCard>
                    )
                })}
            </div>
        </div>
    )
}
