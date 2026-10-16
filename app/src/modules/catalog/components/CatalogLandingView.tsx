'use client'

import { ArrowRight } from 'lucide-react'
import { catalogNavGroups as all_catalogNavGroups, type CatalogNavGroup } from '@/modules/catalog/catalogNav'
import { useAccessibleNavGroups } from '@/hooks/useNavAccess'
import CatalogHeroBanner from './CatalogHeroBanner'
import ModuleLandingCard from '@/components/layout/ModuleLandingCard'
import { catalogLandingAccents, landingAccents, pickLandingAccent } from '@/lib/landing-accents'
import { cn } from '@/lib/utils'

interface CatalogLandingViewProps {
    userName?: string | null
    bannerImageUrl?: string | null
    onViewChange: (view: string) => void
    hideHeroBanner?: boolean
}

const defaultIconAccent = landingAccents.indigo

export default function CatalogLandingView({ userName, bannerImageUrl, onViewChange, hideHeroBanner }: CatalogLandingViewProps) {
    // Only the functions this person may open (Security & Access snapshot); the server decides every page and API too.
    const catalogNavGroups = useAccessibleNavGroups(all_catalogNavGroups)
    return (
        <div className="sera-module-landing">
            {!hideHeroBanner && <CatalogHeroBanner userName={userName ?? null} bannerImageUrl={bannerImageUrl} />}

            <div className="sera-module-landing__grid">
                {catalogNavGroups.map((group: CatalogNavGroup) => {
                    const Icon = group.icon
                    const accent = pickLandingAccent(catalogLandingAccents, group.id, defaultIconAccent)

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
