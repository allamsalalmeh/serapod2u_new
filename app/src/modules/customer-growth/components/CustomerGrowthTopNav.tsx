'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { UsersRound, ChevronDown, ChevronRight, Menu as MenuIcon } from 'lucide-react'
import {
    filterCustomerGrowthNavGroups,
    getActiveCustomerGrowthGroup,
    type CustomerGrowthNavGroup,
    type CustomerGrowthNavChild,
} from '@/modules/customer-growth/customerGrowthNav'
import { cn } from '@/lib/utils'
import { customerGrowthChildVisible } from '@/lib/security-access/nav-access'
import { useNavAccess } from '@/hooks/useNavAccess'

// ── Props ────────────────────────────────────────────────────────

interface CustomerGrowthTopNavProps {
    /** The current SPA view id (e.g. 'crm', 'mktg', 'loyalty', 'catalog', 'customer-growth', 'support-inbox') */
    currentView: string
    /** Callback for navigating — maps to DashboardContent's handleViewChange */
    onNavigate: (viewId: string) => void
}

// ── Component ────────────────────────────────────────────────────

export default function CustomerGrowthTopNav({ currentView, onNavigate }: CustomerGrowthTopNavProps) {
    const router = useRouter()
    // Only the destinations this person may open (Security & Access snapshot); the server decides every route and API too.
    const { snapshot } = useNavAccess()
    const customerGrowthNavGroups = useMemo(() => filterCustomerGrowthNavGroups(id => customerGrowthChildVisible(snapshot, id)), [snapshot]) // eslint-disable-line react-hooks/exhaustive-deps
    const [openGroupId, setOpenGroupId] = useState<string | null>(null)
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
    const dropdownRef = useRef<HTMLDivElement>(null)
    const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
    const [dropdownStyle, setDropdownStyle] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

    // ── Active helpers ────────────────────────────────────────────

    const activeGroupId = useMemo(() => getActiveCustomerGrowthGroup(currentView), [currentView])

    const isGroupActive = useCallback(
        (group: CustomerGrowthNavGroup) =>
            group.id === activeGroupId ||
            group.children.some((c) => c.id === currentView),
        [currentView, activeGroupId]
    )

    const isChildActive = useCallback(
        (child: CustomerGrowthNavChild) => child.id === currentView,
        [currentView]
    )

    // ── Close dropdown on outside click ──────────────────────────

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setOpenGroupId(null)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    // ── Position dropdown under the active group button ───────────

    useEffect(() => {
        if (openGroupId && dropdownRef.current) {
            const btn = buttonRefs.current[openGroupId]
            if (btn) {
                const rect = btn.getBoundingClientRect()
                const parentRect = dropdownRef.current.getBoundingClientRect()
                setDropdownStyle({
                    left: rect.left - parentRect.left,
                    top: rect.bottom - parentRect.top,
                })
            }
        }
    }, [openGroupId])

    // ── Keyboard ──────────────────────────────────────────────────

    const handleGroupKeyDown = useCallback(
        (e: React.KeyboardEvent, groupId: string) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setOpenGroupId((prev) => (prev === groupId ? null : groupId))
            }
            if (e.key === 'Escape') {
                setOpenGroupId(null)
            }
        },
        []
    )

    const handleChildKeyDown = useCallback(
        (e: React.KeyboardEvent, route: string) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                router.push(route)
                setOpenGroupId(null)
                setMobileMenuOpen(false)
            }
            if (e.key === 'Escape') {
                setOpenGroupId(null)
            }
        },
        [router]
    )

    // ── Navigate helper ───────────────────────────────────────────

    const handleNav = useCallback(
        (route: string) => {
            router.push(route)
            setOpenGroupId(null)
            setMobileMenuOpen(false)
        },
        [router]
    )

    // ── Render ────────────────────────────────────────────────────

    return (
        <div className="sticky top-0 z-40 bg-white border-b border-[var(--sera-line)] print:hidden">
            {/* ─── Main Row ─────────────────────────────────────────── */}
            <div className="sera-top-nav__inner">
                {/* Domain badge */}
                <div className="flex items-center gap-1.5 shrink-0 mr-1">
                    <button
                        type="button"
                        onClick={() => router.push('/customer-growth')}
                        className="flex items-center gap-1.5 bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)] px-2.5 py-0.5 rounded-md text-sm font-semibold hover:bg-[var(--sera-orange)]/15 transition-colors"
                    >
                        <UsersRound className="h-3 w-3" strokeWidth={1.75} />
                        <span className="hidden min-[420px]:inline">Customer & Growth</span>
                        <span className="min-[420px]:hidden">C&G</span>
                    </button>
                </div>

                {/* ── Desktop nav row with dropdowns ───────────────────── */}
                <div ref={dropdownRef} className="hidden md:flex items-center flex-1 min-w-0 relative">
                    <nav
                        className="flex items-center gap-0.5 overflow-x-auto scrollbar-hide"
                        role="menubar"
                        aria-label="Customer & Growth navigation"
                    >
                        {customerGrowthNavGroups.map((group) => {
                            const active = isGroupActive(group)
                            const open = openGroupId === group.id
                            const Icon = group.icon

                            return (
                                <button
                                    key={group.id}
                                    ref={(el) => { buttonRefs.current[group.id] = el }}
                                    role="menuitem"
                                    aria-haspopup="true"
                                    aria-expanded={open}
                                    aria-controls={`cg-dropdown-${group.id}`}
                                    onClick={() => setOpenGroupId(open ? null : group.id)}
                                    onKeyDown={(e) => handleGroupKeyDown(e, group.id)}
                                    className={cn(
                                        'flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors',
                                        active
                                            ? 'bg-[var(--sera-orange)]/10 text-[var(--sera-ink)]'
                                            : 'text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)]',
                                        open && !active && 'bg-[var(--sera-mist)] text-[var(--sera-ink)]'
                                    )}
                                >
                                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                                    {group.label}
                                    <ChevronDown
                                        className={cn(
                                            'h-3 w-3 transition-transform',
                                            open && 'rotate-180'
                                        )}
                                    />
                                </button>
                            )
                        })}
                    </nav>

                    {/* ── Dropdown panel ──────────────────────────────────── */}
                    {openGroupId && (() => {
                        const group = customerGrowthNavGroups.find((g) => g.id === openGroupId)
                        if (!group) return null

                        return (
                            <div
                                id={`cg-dropdown-${group.id}`}
                                role="menu"
                                aria-label={`${group.label} submenu`}
                                className="absolute min-w-[200px] bg-white border border-[var(--sera-line)] rounded-lg shadow-sm py-1 z-50 animate-in fade-in-0 zoom-in-95 duration-100"
                                style={{ left: dropdownStyle.left, top: dropdownStyle.top + 4 }}
                            >
                                {group.children.map((child) => {
                                    const ChildIcon = child.icon
                                    const childActive = isChildActive(child)

                                    return (
                                        <button
                                            key={child.id}
                                            role="menuitem"
                                            onClick={() => handleNav(child.route)}
                                            onKeyDown={(e) => handleChildKeyDown(e, child.route)}
                                            className={cn(
                                                'w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                                                childActive
                                                    ? 'bg-[var(--sera-orange)]/10 text-[var(--sera-ink)] font-semibold'
                                                    : 'text-[var(--sera-ink-soft)] hover:bg-[var(--sera-mist)]'
                                            )}
                                        >
                                            <ChildIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                                            <span>{child.label}</span>
                                        </button>
                                    )
                                })}
                            </div>
                        )
                    })()}
                </div>

                {/* ── Mobile hamburger ────────────────────────────────── */}
                <div className="flex md:hidden flex-1 min-w-0">
                    <button
                        type="button"
                        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-sm font-medium text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)]"
                        aria-label="Toggle Customer & Growth menu"
                    >
                        <MenuIcon className="h-4 w-4" />
                        <span>Menu</span>
                        <ChevronDown className={cn('h-3 w-3 transition-transform', mobileMenuOpen && 'rotate-180')} />
                    </button>
                </div>
            </div>

            {/* ─── Mobile dropdown ─────────────────────────────────── */}
            {mobileMenuOpen && (
                <div className="md:hidden border-t border-[var(--sera-line)] bg-white max-h-[60vh] overflow-y-auto">
                    {customerGrowthNavGroups.map((group) => {
                        const active = isGroupActive(group)
                        const open = openGroupId === group.id
                        const Icon = group.icon

                        return (
                            <div key={group.id}>
                                <button
                                    type="button"
                                    onClick={() => setOpenGroupId(open ? null : group.id)}
                                    className={cn(
                                        'w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium transition-colors',
                                        active
                                            ? 'bg-[var(--sera-orange)]/10 text-[var(--sera-ink)]'
                                            : 'text-[var(--sera-ink)] hover:bg-[var(--sera-mist)]'
                                    )}
                                >
                                    <Icon className="h-4 w-4" strokeWidth={1.75} />
                                    <span className="flex-1 text-left">{group.label}</span>
                                    <ChevronRight
                                        className={cn(
                                            'h-3.5 w-3.5 transition-transform',
                                            open && 'rotate-90'
                                        )}
                                    />
                                </button>

                                {open && (
                                    <div className="bg-[var(--sera-mist)]/60">
                                        {group.children.map((child) => {
                                            const ChildIcon = child.icon
                                            const childActive = isChildActive(child)

                                            return (
                                                <button
                                                    key={child.id}
                                                    type="button"
                                                    onClick={() => handleNav(child.route)}
                                                    className={cn(
                                                        'w-full flex items-center gap-2.5 pl-10 pr-4 py-2 text-sm transition-colors',
                                                        childActive
                                                            ? 'bg-[var(--sera-orange)]/10 text-[var(--sera-ink)] font-semibold'
                                                            : 'text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)]'
                                                    )}
                                                >
                                                    <ChildIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
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
