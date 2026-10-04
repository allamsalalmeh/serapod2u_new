import { redirect } from 'next/navigation'
import { getHrPageContext } from '@/app/hr/_lib'
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
  // Reuse the same auth guard as desktop HR pages
  const { userProfile, canViewHr } = await getHrPageContext()

  if (!canViewHr) {
    redirect('/login')
  }

  // Employee self-service follows HR onboarding: until HR completes it (or
  // after a reset) the employee sees a pending-setup screen. Login and every
  // other module stay available; history is kept.
  const onboarding = await getOwnOnboardingState(userProfile.id, userProfile.organization_id)
  const pendingSetup = onboarding === 'pending' || onboarding === 'reset'

  return <HrMobileShell userProfile={userProfile} pendingSetup={pendingSetup}>{children}</HrMobileShell>
}
