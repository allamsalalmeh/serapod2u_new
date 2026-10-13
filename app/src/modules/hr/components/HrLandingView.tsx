'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { filterHrNavGroups, type HrNavGroup } from '@/modules/hr/hrNav'
import { useNavAccess } from '@/hooks/useNavAccess'
import HrHeroBanner from './HrHeroBanner'
import SetupReadinessBanner from '@/components/shared/SetupReadinessBanner'
import ModuleLandingCard from '@/components/layout/ModuleLandingCard'
import { hrLandingAccents, landingAccents, pickLandingAccent } from '@/lib/landing-accents'
import { cn } from '@/lib/utils'

interface HrLandingViewProps {
    userName?: string | null
    bannerImageUrl?: string | null
}

const cardDescriptions: Record<string, string> = {
    'hr-people': 'Manage employees, organizational chart, departments, and job positions.',
    'hr-attendance': 'Track clock-in/out events and review employee timesheets.',
    'hr-leave': 'Configure leave types, manage requests, and set up approval flows.',
    'hr-payroll': 'Define salary structures, allowances & deductions, and generate payslips.',
    'hr-performance': 'Set KPIs, conduct appraisals, and manage performance reviews.',
    'hr-settings': 'Configure departments, positions, approval rules, permissions, and accounting.',
}

const defaultIconAccent = landingAccents.orange

export default function HrLandingView({ userName, bannerImageUrl }: HrLandingViewProps) {
    const router = useRouter()
    // Administrative setup cards appear only for destinations this person may open; the employee entry is My Workspace.
    const { snapshot, allowsAny } = useNavAccess()
    const groups = useMemo(
        () => filterHrNavGroups(allowsAny).filter((group) => group.id !== 'hr-workspace'),
        [snapshot], // eslint-disable-line react-hooks/exhaustive-deps
    )

    return (
        <div className="sera-module-landing">
            <HrHeroBanner userName={userName ?? null} bannerImageUrl={bannerImageUrl} />

            <SetupReadinessBanner
                auditEndpoint="/api/hr/config/audit"
                settingsHref="/dashboard?view=hr/settings/configuration"
                moduleName="HR"
                accentColor="blue"
            />

            <div className="sera-module-landing__grid">
                {groups.map((group: HrNavGroup) => {
                    const Icon = group.icon
                    const description = cardDescriptions[group.id]
                    const accent = pickLandingAccent(hrLandingAccents, group.id, defaultIconAccent)

                    return (
                        <ModuleLandingCard
                            key={group.id}
                            icon={Icon}
                            accent={accent}
                            title={group.label}
                            description={description}
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
