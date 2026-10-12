'use client'

import { useCallback, useEffect, useState } from 'react'
import { Briefcase, Loader2, Users } from 'lucide-react'
import ModuleLandingCard from '@/components/layout/ModuleLandingCard'
import { landingAccents } from '@/lib/landing-accents'
import { useNavAccess } from '@/hooks/useNavAccess'

interface DirectReport {
  userId: string
  fullName: string | null
  jobTitle: string | null
  department: string | null
  employeeNo?: number | null
  employmentStatus?: string | null
  basicSalary?: number | null
  currency?: string | null
  allowances?: Array<{ allowanceTypeId: string | null; amount: number; currency: string | null }>
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; reports: DirectReport[] }
  | { kind: 'unavailable' }
  | { kind: 'denied' }

/**
 * Manager Workspace: the manager-facing section inside HR My Workspace. It lists the manager's OWN current, active direct
 * reports (read through /api/hr/mss/team, which is the authenticated account — never a client-supplied id) and, only when
 * the restricted Manager Compensation Viewer is also granted, their basic salary and authorized fixed allowances (read
 * through /api/hr/mss/compensation). No salary placeholder is ever rendered: the salary column exists only when the
 * compensation endpoint answered with authorized data, and its values are never present in initial hydration.
 */
export default function HrManagerWorkspaceView() {
  const nav = useNavAccess()
  const compensationAllowed = nav.allows('hr/team-compensation')
  const [state, setState] = useState<State>({ kind: 'loading' })

  const load = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
      const teamRes = await fetch('/api/hr/mss/team', { cache: 'no-store' })
      if (teamRes.status === 401 || teamRes.status === 403) return setState({ kind: 'denied' })
      if (!teamRes.ok) return setState({ kind: 'unavailable' })
      const team = await teamRes.json()
      let reports: DirectReport[] = Array.isArray(team?.data) ? team.data : []

      if (compensationAllowed) {
        const compRes = await fetch('/api/hr/mss/compensation', { cache: 'no-store' })
        if (compRes.ok) {
          const comp = (await compRes.json()) as { data?: DirectReport[] } | null
          const byId = new Map<string, DirectReport>()
          for (const row of comp?.data ?? []) byId.set(row.userId, row)
          reports = reports.map((r) => {
            const c = byId.get(r.userId)
            return { ...r, basicSalary: c?.basicSalary ?? null, currency: c?.currency ?? null, allowances: c?.allowances ?? [] }
          })
        }
      }

      setState({ kind: 'ready', reports })
    } catch {
      setState({ kind: 'unavailable' })
    }
  }, [compensationAllowed])

  useEffect(() => { void load() }, [load])

  return (
    <ModuleLandingCard icon={Users} accent={landingAccents.emerald} title="My Team" description="Your current, active direct reports.">
      {state.kind === 'loading' && (
        <div className="flex items-center gap-2 border-t border-[var(--sera-line)] pt-4 text-sm text-[var(--sera-muted)]" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />Loading team…
        </div>
      )}
      {state.kind === 'unavailable' && (
        <div className="border-t border-[var(--sera-line)] pt-4 text-sm text-[var(--sera-muted)]" role="status">We couldn’t load your team right now.</div>
      )}
      {state.kind === 'denied' && (
        <div className="border-t border-[var(--sera-line)] pt-4 text-sm text-[var(--sera-muted)]" role="alert">You don’t have access to your team directory.</div>
      )}
      {state.kind === 'ready' && (
        <div className="border-t border-[var(--sera-line)] pt-4">
          {state.reports.length === 0 ? (
            <p className="text-sm text-[var(--sera-muted)]">You have no direct reports right now.</p>
          ) : (
            <ul className="divide-y divide-[var(--sera-line)]">
              {state.reports.map((r) => (
                <li key={r.userId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--sera-ink)]">
                      <Briefcase className="h-3.5 w-3.5 text-[var(--sera-muted)]" aria-hidden />
                      {r.fullName}
                    </div>
                    <div className="text-xs text-[var(--sera-muted)]">
                      {[r.jobTitle, r.department].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                  {compensationAllowed && r.basicSalary != null && (
                    <div className="text-right">
                      <div className="text-sm font-semibold text-[var(--sera-ink)]">
                        {new Intl.NumberFormat('en-MY', { style: 'currency', currency: r.currency ?? 'MYR' }).format(r.basicSalary)}
                      </div>
                      {r.allowances && r.allowances.length > 0 && (
                        <div className="text-xs text-[var(--sera-muted)]">
                          +{r.allowances.map((a) => `${new Intl.NumberFormat('en-MY', { style: 'currency', currency: a.currency ?? 'MYR' }).format(a.amount)}`).join(', ')}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ModuleLandingCard>
  )
}
