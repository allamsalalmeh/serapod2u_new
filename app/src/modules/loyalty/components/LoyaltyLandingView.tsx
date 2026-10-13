'use client'

import { ArrowRight } from 'lucide-react'
import { loyaltyNavGroups as all_loyaltyNavGroups, type LoyaltyNavGroup } from '@/modules/loyalty/loyaltyNav'
import { useAccessibleNavGroups } from '@/hooks/useNavAccess'
import LoyaltyHeroBanner from './LoyaltyHeroBanner'
import ModuleLandingCard from '@/components/layout/ModuleLandingCard'
import { landingAccents, loyaltyLandingAccents, pickLandingAccent } from '@/lib/landing-accents'
import { cn } from '@/lib/utils'

interface LoyaltyLandingViewProps {
    userName?: string | null
    bannerImageUrl?: string | null
    onViewChange: (view: string) => void
    hideHeroBanner?: boolean
}

const defaultIconAccent = landingAccents.amber

export default function LoyaltyLandingView({ userName, bannerImageUrl, onViewChange, hideHeroBanner }: LoyaltyLandingViewProps) {
    // Only the functions this person may open (Security & Access snapshot); the server decides every page and API too.
    const loyaltyNavGroups = useAccessibleNavGroups(all_loyaltyNavGroups)
    return (
        <div className="sera-module-landing">
            {!hideHeroBanner && <LoyaltyHeroBanner userName={userName ?? null} bannerImageUrl={bannerImageUrl} />}

            <div className="sera-module-landing__grid">
                {loyaltyNavGroups.map((group: LoyaltyNavGroup) => {
                    const Icon = group.icon
                    const accent = pickLandingAccent(loyaltyLandingAccents, group.id, defaultIconAccent)

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
                                                <span className="flex-1 text-left">{child.label}</span>
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
