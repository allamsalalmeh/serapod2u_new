'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Briefcase, CalendarDays, Clock, FileText, Hourglass, ListTree, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import ModuleLightHeader from '@/components/layout/ModuleLightHeader'
import ModuleLandingCard from '@/components/layout/ModuleLandingCard'
import HrManagerWorkspaceView from '@/components/hr/workspace/HrManagerWorkspaceView'
import { landingAccents } from '@/lib/landing-accents'
import { useNavAccess } from '@/hooks/useNavAccess'

interface Employment {
    name: string | null
    employeeNo: number | null
    jobTitle: string | null
    department: string | null
    manager: string | null
    employmentType: string | null
    employmentStatus: string | null
    organization: string | null
    hireDate: string | null
}

type State =
    | { kind: 'loading' }
    | { kind: 'ready'; employment: Employment }
    | { kind: 'pending' }
    | { kind: 'unavailable' }
    | { kind: 'denied' }

export const PENDING_SETUP_MESSAGE = 'Your employee setup is pending. Contact HR.'

const Field = ({ label, value }: { label: string; value: string | number | null }) => (
    <div className="min-w-0">
        <dt className="text-xs uppercase tracking-wide text-[var(--sera-muted)]">{label}</dt>
        <dd className="mt-0.5 break-words text-sm font-medium text-[var(--sera-ink)]">{value === null || value === '' ? '—' : value}</dd>
    </div>
)

const titleCase = (value: string | null) => (value ? value.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null)

/**
 * My Workspace: the employee-facing HR entry, laid out with the shared module-landing shell (page gutter comes from the
 * application shell; no extra padding or centring here). Everything is the signed-in person's OWN record, read through
 * /api/hr/self-service/* (the employee is the authenticated account, never a client-supplied id). Attendance, leave and
 * payslips open the existing employee screens; the organization chart is the limited staff view and is independent of
 * the employee link. A pending setup is announced once; the affected cards only carry a short "Pending setup" status.
 */
export default function HrMyWorkspaceView({ userName }: { userName?: string | null }) {
    const nav = useNavAccess()
    const [state, setState] = useState<State>({ kind: 'loading' })

    const load = useCallback(async () => {
        setState({ kind: 'loading' })
        try {
            const res = await fetch('/api/hr/self-service/me', { cache: 'no-store' })
            if (res.status === 401 || res.status === 403) return setState({ kind: 'denied' })
            if (!res.ok) return setState({ kind: 'unavailable' })
            const body = await res.json()
            if (body?.state === 'pending') return setState({ kind: 'pending' })
            if (body?.state === 'ready' && body.employment) return setState({ kind: 'ready', employment: body.employment })
            setState({ kind: 'unavailable' })
        } catch {
            setState({ kind: 'unavailable' })
        }
    }, [])

    useEffect(() => { void load() }, [load])

    const ready = state.kind === 'ready'
    const pending = state.kind === 'pending'
    const orgChartAllowed = nav.allows('hr/people/org-chart') || nav.allows('hr/people/org-chart/staff')

    const cards = [
        { id: 'attendance', title: 'My Attendance', description: 'Clock in and out and review your attendance.', href: '/hr/mobile/attendance', icon: Clock, accent: landingAccents.teal, needsEmployee: true },
        { id: 'leave', title: 'My Leave', description: 'Your leave balance, requests and applications.', href: '/hr/mobile/leave', icon: CalendarDays, accent: landingAccents.violet, needsEmployee: true },
        { id: 'payslips', title: 'My Payslips', description: 'Your published payslips.', href: '/hr/mobile/payslip', icon: FileText, accent: landingAccents.amber, needsEmployee: true },
        ...(orgChartAllowed
            ? [{ id: 'org-chart', title: 'Organization Chart', description: 'Who works where and who reports to whom.', href: '/hr/people/org-chart', icon: ListTree, accent: landingAccents.sky, needsEmployee: false }]
            : []),
    ]

    return (
        <div className="sera-module-landing" data-testid="hr-my-workspace">
            <ModuleLightHeader
                eyebrow="HR"
                title="My Workspace"
                description={`${userName ? `Welcome, ${userName}. ` : ''}Your own employment, attendance, leave and payslips.`}
                actions={nav.allows('hr') ? (
                    <Button asChild variant="outline" size="sm">
                        <Link href="/hr"><ShieldCheck className="mr-2 h-4 w-4" aria-hidden />HR administration</Link>
                    </Button>
                ) : undefined}
            />

            {state.kind === 'loading' && (
                <div className="flex items-center gap-2 text-sm text-[var(--sera-muted)]" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Loading…</div>
            )}

            {pending && (
                <div role="status" className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                    <Hourglass className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <span>{PENDING_SETUP_MESSAGE}</span>
                </div>
            )}

            {state.kind === 'unavailable' && (
                <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--sera-line)] bg-white p-4 text-sm">
                    <span className="min-w-0">We couldn’t load your employment details right now. This is temporary and not a decision about your access.</span>
                    <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" aria-hidden />Try again</Button>
                </div>
            )}

            {state.kind === 'denied' && (
                <div role="alert" className="rounded-xl border border-[var(--sera-line)] bg-white p-4 text-sm">You don’t have access to this page. Contact your administrator if you need access.</div>
            )}

            {ready && (
                <ModuleLandingCard icon={Briefcase} accent={landingAccents.orange} title="My Employment" description="Your own employment details.">
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-[var(--sera-line)] pt-4 sm:grid-cols-2 xl:grid-cols-3">
                        <Field label="Name" value={state.employment.name} />
                        <Field label="Employee no." value={state.employment.employeeNo} />
                        <Field label="Job title" value={state.employment.jobTitle} />
                        <Field label="Department" value={state.employment.department} />
                        <Field label="Reports to" value={state.employment.manager} />
                        <Field label="Employment type" value={titleCase(state.employment.employmentType)} />
                        <Field label="Status" value={titleCase(state.employment.employmentStatus)} />
                        <Field label="Organization" value={state.employment.organization} />
                        <Field label="Hire date" value={state.employment.hireDate} />
                    </dl>
                </ModuleLandingCard>
            )}

            {nav.allows('hr/my-team') && <HrManagerWorkspaceView />}

            <div className="sera-module-landing__grid sera-module-landing__grid--pair">
                {cards.map(({ id, title, description, href, icon, accent, needsEmployee }) => {
                    const unavailable = needsEmployee && pending
                    if (unavailable) {
                        return (
                            <div key={id} role="link" aria-disabled="true" aria-label={`${title}, unavailable: pending setup`}>
                                <ModuleLandingCard
                                    className="sera-module-landing__card--disabled h-full"
                                    icon={icon}
                                    accent={accent}
                                    title={title}
                                    description={description}
                                    titleExtra={
                                        <span className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
                                            Pending setup
                                        </span>
                                    }
                                />
                            </div>
                        )
                    }
                    // Not a link until the employee record is known (or the card needs none): no dead destinations.
                    if (needsEmployee && !ready) {
                        return <ModuleLandingCard key={id} className="h-full" icon={icon} accent={accent} title={title} description={description} />
                    }
                    return (
                        <Link key={id} href={href} className="sera-module-landing__card-link" aria-label={title}>
                            <ModuleLandingCard className="h-full" icon={icon} accent={accent} title={title} description={description} />
                        </Link>
                    )
                })}
            </div>
        </div>
    )
}
