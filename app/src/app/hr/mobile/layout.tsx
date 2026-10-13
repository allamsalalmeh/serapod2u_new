import { getHrPageContext } from '@/app/hr/_lib'
import AccessState from '@/components/access/AccessState'
import { resolveDestinationAccess } from '@/lib/server/nav-access'
import HrMobileShell from '@/components/hr/mobile/HrMobileShell'
import { getOwnOnboardingState } from '@/lib/hr/onboarding'
import type { Metadata, Viewport } from 'next'

/* ─── PWA metadata for the HR mobile scope ────────────────────────── */

export const metadata: Metadata = {
  title: 'Serapod HR',
  description: 'Employee self-service HR portal — attendance, leave, payslip',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Serapod HR',
  },
  icons: {
    icon: '/icons/icon-192x192.png',
    apple: '/icons/icon-192x192.png',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
}

export function generateViewport(): Viewport {
  return {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: 'cover',
    themeColor: '#2563eb',
  }
}

/* ─── Layout (server component → auth → client shell) ─────────────── */

export default async function HrMobileLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // The employee screens need Employee Self-Service (own record); HR administrators may also open them. A denial, a
  // temporarily unavailable permission check and an expired login are different states, none of them a /login redirect
  // except the expired login (handled inside getHrPageContext).
  const { userProfile, actor, gate } = await getHrPageContext(['hr/my-workspace', 'hr'])
  if (gate) return gate

  // Manager/administrator affordances come from Security & Access, never from a legacy role level.
  const [leaveApproval, hrAdministration, orgChart] = await Promise.all([
    resolveDestinationAccess(actor, 'hr/leave/requests'),
    resolveDestinationAccess(actor, 'hr'),
    resolveDestinationAccess(actor, ['hr/people/org-chart', 'hr/people/org-chart/staff']),
  ])

  // Employee self-service follows HR onboarding: until HR completes it (or after a reset, or when there is no
  // employment record yet) the employee sees a pending-setup screen. Login and every other module stay available;
  // history is kept. An onboarding state that cannot be read is a temporary problem, not "pending".
  const onboarding = await getOwnOnboardingState(userProfile.id, userProfile.organization_id)
  if (onboarding === 'unknown') return <AccessState kind="unavailable" homeHref="/hr/my-workspace" homeLabel="Back to My Workspace" />
  const pendingSetup = onboarding !== 'completed'

  return (
    <HrMobileShell
      userProfile={userProfile}
      pendingSetup={pendingSetup}
      canApproveLeave={leaveApproval.state === 'allowed'}
      canAdministerHr={hrAdministration.state === 'allowed'}
      canViewOrgChart={orgChart.state === 'allowed'}
    >
      {children}
    </HrMobileShell>
  )
}
