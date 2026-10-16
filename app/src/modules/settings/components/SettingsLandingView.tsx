'use client'

import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { visibleSettingsGroups, type SettingsNavGroup } from '@/modules/settings/settingsNav'
import { useSystemLogsAccess } from '@/components/system-logs/useSystemLogsAccess'
import SettingsHeroBanner from './SettingsHeroBanner'
import ModuleLandingCard from '@/components/layout/ModuleLandingCard'
import { landingAccents, pickLandingAccent, settingsLandingAccents } from '@/lib/landing-accents'
import { cn } from '@/lib/utils'

const defaultIconAccent = landingAccents.orange

interface SettingsLandingViewProps {
    userName?: string | null
    roleLevel?: number
    bannerImageUrl?: string | null
}

export default function SettingsLandingView({ userName, roleLevel, bannerImageUrl }: SettingsLandingViewProps) {
    const router = useRouter()

    const canViewSystemLogs = useSystemLogsAccess()
    const visibleGroups = visibleSettingsGroups({ roleLevel, canViewSystemLogs })

    return (
        <div className="sera-module-landing">
            <SettingsHeroBanner userName={userName ?? null} bannerImageUrl={bannerImageUrl} />

            <div className="sera-module-landing__grid">
                {visibleGroups.map((group: SettingsNavGroup) => {
                    const Icon = group.icon
                    const accent = pickLandingAccent(settingsLandingAccents, group.id, defaultIconAccent)

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
                                                onClick={() => router.push(child.href)}
                                                className="sera-module-landing__link group"
                                            >
                                                <ChildIcon className={cn('h-4 w-4 shrink-0', accent.icon)} strokeWidth={1.75} />
                                                <span className="flex-1">{child.label}</span>
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
