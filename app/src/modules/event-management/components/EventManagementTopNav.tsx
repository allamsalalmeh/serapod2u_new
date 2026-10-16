'use client'

import { CalendarRange } from 'lucide-react'
import { activeEventManagementModuleTab, eventManagementModuleTabs } from '@/modules/event-management/eventManagementNav'
import { cn } from '@/lib/utils'

interface EventManagementTopNavProps {
  currentView: string
  onNavigate: (viewId: string) => void
}

/**
 * Event Management module bar (same chrome as RoadtourTopNav): module chip + Overview / Events / Settings.
 * Inside an event, "Events" stays active. Every tab is the same `marketing.module.view` destination, so no extra
 * filtering is needed here; the pages and APIs re-check on the server.
 */
export default function EventManagementTopNav({ currentView, onNavigate }: EventManagementTopNavProps) {
  const activeTab = activeEventManagementModuleTab(currentView)

  return (
    <div className="sticky top-0 z-40 border-b border-[var(--sera-line)] bg-white print:hidden">
      <div className="sera-top-nav__inner">
        <div className="mr-1 flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onNavigate('event-management')}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-[var(--sera-orange)]/10 px-2.5 py-0.5 text-sm font-semibold text-[var(--sera-orange-deep)] transition-colors hover:bg-[var(--sera-orange)]/15"
          >
            <CalendarRange className="h-3 w-3" />
            <span>Event Management</span>
          </button>
        </div>

        <nav className="scrollbar-hide flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Event Management">
          {eventManagementModuleTabs.map((tab) => {
            const active = tab.id === activeTab
            const Icon = tab.icon
            return (
              <button
                key={tab.id}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => onNavigate(tab.id)}
                className={cn(
                  'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
                  active
                    ? 'bg-[var(--sera-orange)]/10 text-[var(--sera-ink)]'
                    : 'text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)]'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            )
          })}
        </nav>
      </div>
    </div>
  )
}
