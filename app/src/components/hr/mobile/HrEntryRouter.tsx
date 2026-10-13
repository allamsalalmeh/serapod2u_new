'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { Loader2, Briefcase } from 'lucide-react'

interface Props {
  userProfile: any
  /** 'hr' (administrative landing) for HR administrators, 'hr/my-workspace' for employee-only users. */
  initialView?: string
}

/**
 * Smart entry router rendered by /hr page.
 *
 * SSR: renders a lightweight loading screen.
 * Client mobile (≤768px): redirects to /hr/mobile/home.
 * Client desktop: renders the existing DashboardContent with the HR landing view (administrators) or My Workspace.
 */
export default function HrEntryRouter({ userProfile, initialView = 'hr' }: Props) {
  const router = useRouter()
  const [mode, setMode] = useState<'loading' | 'desktop'>('loading')

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 768px)').matches
    if (isMobile) {
      router.replace('/hr/mobile/home')
    } else {
      setMode('desktop')
    }
  }, [router])

  if (mode === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-14 w-14 rounded-2xl bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
            <Briefcase className="h-7 w-7 text-blue-600" />
          </div>
          <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
          <p className="text-sm text-muted-foreground">Loading HR…</p>
        </div>
      </div>
    )
  }

  return <DashboardContent userProfile={userProfile} initialView={initialView} />
}
