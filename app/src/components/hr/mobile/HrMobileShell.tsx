'use client'

import { HrMobileProvider, type HrUserProfile } from './HrMobileContext'
import BottomNav from './BottomNav'
import HrHelpDrawer from './HrHelpDrawer'
import HrOfflineBanner from './HrOfflineBanner'
import { UserCog } from 'lucide-react'

interface Props {
  userProfile: HrUserProfile
  /** HR has not completed (or has reset) this employee's onboarding. */
  pendingSetup?: boolean
  children: React.ReactNode
}

/**
 * Client shell for all /hr/mobile/* pages.
 * Site-wide service worker is registered from root layout (PwaBootstrap).
 */
export default function HrMobileShell({ userProfile, pendingSetup = false, children }: Props) {
  return (
    <HrMobileProvider userProfile={userProfile}>
      <div className="h-[100dvh] flex flex-col bg-background">
        <HrOfflineBanner />
        <main className="flex-1 overflow-y-auto overscroll-y-contain pb-20">
          {pendingSetup ? <HrPendingSetup name={userProfile.full_name} /> : children}
        </main>
        {!pendingSetup && <BottomNav />}
        <HrHelpDrawer />
      </div>
    </HrMobileProvider>
  )
}

function HrPendingSetup({ name }: { name: string | null }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-100 dark:bg-blue-900/40">
        <UserCog className="h-7 w-7 text-blue-600" />
      </div>
      <h1 className="text-lg font-semibold">Your HR profile is being set up</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        {name ? `Hi ${name.split(' ')[0]}, ` : ''}HR has not finished registering you yet. Attendance, leave and payslips
        will appear here once HR completes your onboarding.
      </p>
      <p className="mt-4 max-w-sm text-xs text-muted-foreground">
        Your login and access to other modules are not affected. Contact HR if you think this is wrong.
      </p>
    </div>
  )
}
