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
  /** Security & Access: may approve leave (shows the approvals tab and the pending-approval count). */
  canApproveLeave?: boolean
  /** Security & Access: holds HR administration (shows the "Switch to Admin View" shortcut). */
  canAdministerHr?: boolean
  /** Security & Access: may open the read-only staff organization chart. */
  canViewOrgChart?: boolean
  children: React.ReactNode
}

/**
 * Client shell for all /hr/mobile/* pages.
 * Site-wide service worker is registered from root layout (PwaBootstrap).
 */
export default function HrMobileShell({ userProfile, pendingSetup = false, canApproveLeave = false, canAdministerHr = false, canViewOrgChart = false, children }: Props) {
  return (
    <HrMobileProvider userProfile={userProfile} canApproveLeave={canApproveLeave} canAdministerHr={canAdministerHr} canViewOrgChart={canViewOrgChart}>
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
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center" role="status">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-100 dark:bg-blue-900/40">
        <UserCog className="h-7 w-7 text-blue-600" />
      </div>
      <h1 className="text-lg font-semibold">{name ? `Hi ${name.split(' ')[0]}, your employee setup is pending.` : 'Your employee setup is pending.'}</h1>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">Contact HR.</p>
      <p className="mt-4 max-w-sm text-xs text-muted-foreground">
        Your login and access to other modules are not affected. Attendance, leave and payslips appear here once HR completes your setup.
      </p>
    </div>
  )
}
