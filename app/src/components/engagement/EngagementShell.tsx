"use client"

import { ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'
import { NavAccessProvider } from '@/hooks/useNavAccess'
import type { UserProfileWithRelations } from '@/lib/server/get-user-profile'

interface EngagementShellProps {
  userProfile: UserProfileWithRelations
  activeView?: string
  children: ReactNode
}

export function EngagementShell({ userProfile, activeView = 'point-catalog', children }: EngagementShellProps) {
  const router = useRouter()
  const pathname = usePathname()

  const handleNavigate = (view: string) => {
    if (view === 'point-catalog') {
      if (pathname !== '/engagement/catalog') {
        router.push('/engagement/catalog')
      }
      return
    }

    if (view === 'point-catalog-admin' || view === 'point-catalog-admin-list') {
      if (pathname !== '/engagement/catalog/admin') {
        router.push('/engagement/catalog/admin')
      }
      return
    }

    if (view === 'point-catalog-admin-new') {
      router.push('/engagement/catalog/admin/new')
      return
    }

    if (view === 'lucky-draw') {
      if (pathname !== '/engagement/lucky-draw') {
        router.push('/engagement/lucky-draw')
      }
      return
    }

    if (view === 'redeem-gift-management') {
      if (pathname !== '/engagement/redeem') {
        router.push('/engagement/redeem')
      }
      return
    }

    if (view === 'journey-builder') {
      if (pathname !== '/engagement/journey-builder') {
        router.push('/engagement/journey-builder')
      }
      return
    }

    if (view === 'consumer-activations') {
      if (pathname !== '/engagement/consumer-activations') {
        router.push('/engagement/consumer-activations')
      }
      return
    }

    if (view === 'product-catalog') {
      if (pathname !== '/engagement/product-catalog') {
        router.push('/engagement/product-catalog')
      }
      return
    }

    // Default fallback: return to dashboard and let dashboard content pick up stored view
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem('dashboardView', view)
    }
    router.push('/dashboard')
  }

  return (
    <NavAccessProvider userId={userProfile.id} organizationId={userProfile.organization_id ?? userProfile.organizations?.id ?? null}>
    <div className="h-[100dvh] max-h-[100dvh] overflow-hidden bg-background flex sera-shell">
      <div className="print:hidden w-0 min-w-0 overflow-visible shrink-0 lg:w-auto lg:sticky lg:top-0 lg:h-[100dvh] lg:self-start">
        <Sidebar userProfile={userProfile} currentView={activeView} onViewChange={handleNavigate} />
      </div>
      <div className="flex-1 w-full min-w-0 h-full min-h-0 flex flex-col overflow-hidden">
        {/* Mobile hamburger clearance — Engagement routes have no GlobalPageChrome */}
        <div className="sera-top-chrome print:hidden shrink-0 lg:hidden">
          <div className="sera-top-nav__inner">
            <span className="text-sm font-semibold text-[var(--sera-ink)] truncate">Engagement</span>
          </div>
        </div>
        <main className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-muted/10 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
    </NavAccessProvider>
  )
}
