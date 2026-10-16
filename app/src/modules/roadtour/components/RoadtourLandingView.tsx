'use client'

import { ArrowRight } from 'lucide-react'
import { useMemo } from 'react'
import { filterRoadtourNavGroups } from '../roadtourNav'
import { useNavAccess } from '@/hooks/useNavAccess'
import ModuleLightHeader from '@/components/layout/ModuleLightHeader'
import ModuleLandingCard from '@/components/layout/ModuleLandingCard'
import { landingAccents, pickLandingAccent, roadtourLandingAccents } from '@/lib/landing-accents'
import { cn } from '@/lib/utils'

interface RoadtourLandingViewProps {
    userProfile: any
    onViewChange: (viewId: string) => void
}

const defaultAccent = landingAccents.orange

export function RoadtourLandingView({ onViewChange }: RoadtourLandingViewProps) {
    // Only the sections this person may open (Security & Access snapshot); the server decides every page and API too.
    const { snapshot, allows } = useNavAccess()
    const roadtourNavGroups = useMemo(() => filterRoadtourNavGroups(allows), [snapshot]) // eslint-disable-line react-hooks/exhaustive-deps
    return (
        <div className="sera-module-landing">
            <ModuleLightHeader
                eyebrow="Road Tour"
                title="Field campaigns"
                description="Plan road tour campaigns, assign account managers, generate QR codes, track field visits, capture surveys, and monitor performance across your shop network."
            />

            <div className="sera-module-landing__grid">
                {roadtourNavGroups.map((group) => {
                    const accent = pickLandingAccent(roadtourLandingAccents, group.id, defaultAccent)
                    const Icon = group.icon

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
