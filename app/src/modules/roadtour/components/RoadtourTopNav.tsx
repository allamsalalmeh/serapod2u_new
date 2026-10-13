'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Map, ChevronDown, ChevronRight, Menu as MenuIcon } from 'lucide-react'
import {
  filterRoadtourNavGroups,
  findRoadtourGroupForView,
  resolveRoadtourViewId,
  type RoadtourNavGroup,
  type RoadtourNavChild,
} from '@/modules/roadtour/roadtourNav'
import { cn } from '@/lib/utils'
import { useNavAccess } from '@/hooks/useNavAccess'

interface RoadtourTopNavProps {
  currentView: string
  onNavigate: (viewId: string) => void
}

export default function RoadtourTopNav({ currentView, onNavigate }: RoadtourTopNavProps) {
  // Only the sections this person may open (Security & Access snapshot); the server decides every page and API too.
  const { snapshot, allows } = useNavAccess()
  const roadtourNavGroups = useMemo(() => filterRoadtourNavGroups(allows), [snapshot]) // eslint-disable-line react-hooks/exhaustive-deps
  const [openGroupId, setOpenGroupId] = useState<string | null>(null)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [dropdownStyle, setDropdownStyle] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

  // Legacy Analytics view ids still highlight the report that replaced them.
  const activeViewId = useMemo(() => resolveRoadtourViewId(currentView), [currentView])
  const activeGroupId = useMemo(() => findRoadtourGroupForView(activeViewId)?.id ?? null, [activeViewId])

  const isGroupActive = useCallback(
    (group: RoadtourNavGroup) =>
      group.id === activeGroupId || group.children.some((c) => c.id === activeViewId),
    [activeViewId, activeGroupId]
  )

  const isChildActive = useCallback(
    (child: RoadtourNavChild) => child.id === activeViewId,
    [activeViewId]
  )

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpenGroupId(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (openGroupId && dropdownRef.current) {
      const btn = buttonRefs.current[openGroupId]
      if (btn) {
        const rect = btn.getBoundingClientRect()
        const parentRect = dropdownRef.current.getBoundingClientRect()
        setDropdownStyle({ left: rect.left - parentRect.left, top: rect.bottom - parentRect.top })
      }
    }
  }, [openGroupId])

  const handleNav = useCallback(
    (childId: string) => {
      onNavigate(childId)
      setOpenGroupId(null)
      setMobileMenuOpen(false)
    },
    [onNavigate]
  )

  return (
    <div className="sticky top-0 z-40 border-b border-[var(--sera-line)] bg-white print:hidden">
      <div className="sera-top-nav__inner">
        <div className="mr-1 flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => onNavigate('roadtour')}
            className="flex items-center gap-1.5 rounded-md bg-[var(--sera-orange)]/10 px-2.5 py-0.5 text-sm font-semibold text-[var(--sera-orange-deep)] transition-colors hover:bg-[var(--sera-orange)]/15"
          >
            <Map className="h-3 w-3" />
            <span>RoadTour</span>
          </button>
        </div>

        {/* Desktop */}
        <div ref={dropdownRef} className="relative hidden min-w-0 flex-1 items-center md:flex">
          <nav className="scrollbar-hide flex items-center gap-0.5 overflow-x-auto" role="menubar">
            {roadtourNavGroups.map((group) => {
              const active = isGroupActive(group)
              const open = openGroupId === group.id
              const Icon = group.icon
              return (
                <button
                  key={group.id}
                  type="button"
                  ref={(el) => {
                    buttonRefs.current[group.id] = el
                  }}
                  role="menuitem"
                  aria-haspopup="true"
                  aria-expanded={open}
                  onClick={() => setOpenGroupId(open ? null : group.id)}
                  className={cn(
                    'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-[var(--sera-orange)]/10 text-[var(--sera-ink)]'
                      : 'text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)]',
                    open && !active && 'bg-[var(--sera-mist)] text-[var(--sera-ink)]'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {group.label}
                  <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
                </button>
              )
            })}
          </nav>

          {openGroupId &&
            (() => {
              const group = roadtourNavGroups.find((g) => g.id === openGroupId)
              if (!group) return null
              return (
                <div
                  role="menu"
                  className="absolute z-50 min-w-[200px] animate-in rounded-lg border border-[var(--sera-line)] bg-white py-1 shadow-sm duration-100 fade-in-0 zoom-in-95"
                  style={{ left: dropdownStyle.left, top: dropdownStyle.top + 4 }}
                >
                  {group.children.map((child) => {
                    const ChildIcon = child.icon
                    const childActive = isChildActive(child)
                    return (
                      <button
                        key={child.id}
                        type="button"
                        role="menuitem"
                        onClick={() => handleNav(child.id)}
                        className={cn(
                          'flex w-full items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                          childActive
                            ? 'bg-[var(--sera-orange)]/10 font-semibold text-[var(--sera-orange-deep)]'
                            : 'text-[var(--sera-ink-soft)] hover:bg-[var(--sera-mist)]'
                        )}
                      >
                        <ChildIcon className="h-3.5 w-3.5 shrink-0" />
                        <span>{child.label}</span>
                      </button>
                    )
                  })}
                </div>
              )
            })()}
        </div>

        {/* Mobile */}
        <div className="flex min-w-0 flex-1 md:hidden">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)]"
          >
            <MenuIcon className="h-4 w-4" />
            <span>Menu</span>
            <ChevronDown className={cn('h-3 w-3 transition-transform', mobileMenuOpen && 'rotate-180')} />
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="max-h-[60vh] overflow-y-auto border-t border-[var(--sera-line)] bg-white md:hidden">
          {roadtourNavGroups.map((group) => {
            const active = isGroupActive(group)
            const open = openGroupId === group.id
            const Icon = group.icon
            return (
              <div key={group.id}>
                <button
                  type="button"
                  onClick={() => setOpenGroupId(open ? null : group.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-[var(--sera-orange)]/10 text-[var(--sera-ink)]'
                      : 'text-[var(--sera-ink-soft)] hover:bg-[var(--sera-mist)]'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex-1 text-left">{group.label}</span>
                  <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
                </button>
                {open && (
                  <div className="bg-[var(--sera-mist)]/50">
                    {group.children.map((child) => {
                      const ChildIcon = child.icon
                      const childActive = isChildActive(child)
                      return (
                        <button
                          key={child.id}
                          type="button"
                          onClick={() => handleNav(child.id)}
                          className={cn(
                            'flex w-full items-center gap-2.5 py-2 pl-10 pr-4 text-sm transition-colors',
                            childActive
                              ? 'bg-[var(--sera-orange)]/10 font-semibold text-[var(--sera-orange-deep)]'
                              : 'text-[var(--sera-muted)] hover:bg-[var(--sera-mist)]'
                          )}
                        >
                          <ChildIcon className="h-3.5 w-3.5 shrink-0" />
                          <span>{child.label}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
