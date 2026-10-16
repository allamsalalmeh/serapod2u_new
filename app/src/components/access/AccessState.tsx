'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Hourglass, Lock, RefreshCw, LogIn } from 'lucide-react'

/**
 * The single, compact "you cannot use this page" state. It never carries protected data and never explains the
 * decision (role levels, permission keys and engine reasons stay in server diagnostics, not in the employee message).
 * Each kind is a different situation:
 *   denied            the server decided the person has no access
 *   unavailable       the permission check itself failed: temporary, not a decision
 *   signed_out        the login expired
 *   employee_pending  the HR employee record is not linked or onboarding is not complete
 */
export type AccessStateKind = 'denied' | 'unavailable' | 'signed_out' | 'employee_pending'

export interface AccessStateProps {
  kind: AccessStateKind
  /** An authorized place to go back to (My Workspace when the person has one, otherwise the dashboard). */
  homeHref?: string
  homeLabel?: string
}

const COPY: Record<AccessStateKind, { title: string; body: string }> = {
  denied: { title: 'You don’t have access to this page.', body: 'Contact your administrator if you need access.' },
  unavailable: {
    title: 'We couldn’t check your access right now.',
    body: 'This is a temporary problem, not a decision about your access. Try again in a moment.',
  },
  signed_out: { title: 'Your session has expired.', body: 'Sign in again to continue.' },
  employee_pending: { title: 'Your employee setup is pending.', body: 'Contact HR.' },
}

export default function AccessState({ kind, homeHref = '/dashboard', homeLabel = 'Back to Dashboard' }: AccessStateProps) {
  const router = useRouter()
  const copy = COPY[kind]
  const Icon = kind === 'unavailable' ? RefreshCw : kind === 'signed_out' ? LogIn : kind === 'employee_pending' ? Hourglass : Lock
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6" role={kind === 'denied' ? 'alert' : 'status'} data-access-state={kind}>
      <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Icon className="h-6 w-6 text-muted-foreground" aria-hidden />
        </div>
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{copy.body}</p>
        <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
          {kind === 'unavailable' && (
            <Button type="button" onClick={() => router.refresh()}>Try again</Button>
          )}
          {kind === 'signed_out' ? (
            <Button asChild><Link href="/login">Sign in</Link></Button>
          ) : (
            <Button asChild variant={kind === 'unavailable' ? 'outline' : 'default'}>
              <Link href={homeHref}>{homeLabel}</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
