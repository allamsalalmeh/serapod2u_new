'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Gift, Search, ChevronRight, ChevronDown, X, Menu as MenuIcon } from 'lucide-react'
import {
    loyaltyNavGroups as all_loyaltyNavGroups,
    getAllLoyaltyNavItems,
    getLoyaltyBreadcrumb,
    type LoyaltyNavGroup,
    type LoyaltyNavChild,
} from '@/modules/loyalty/loyaltyNav'
import { useAccessibleNavGroups } from '@/hooks/useNavAccess'
import { cn } from '@/lib/utils'

// ── Props ────────────────────────────────────────────────────────

interface LoyaltyTopNavProps {
    /** The current SPA view id (e.g. 'journey-builder', 'marketing', 'lucky-draw') */
    currentView: string
    /** Callback for navigating — maps to DashboardContent's handleViewChange */
    onNavigate: (viewId: string) => void
}

// ── Component ────────────────────────────────────────────────────

export default function LoyaltyTopNav({ currentView, onNavigate }: LoyaltyTopNavProps) {
    // Only the functions this person may open (Security & Access snapshot); the server decides every page and API too.
    const loyaltyNavGroups = useAccessibleNavGroups(all_loyaltyNavGroups)
    const [openGroupId, setOpenGroupId] = useState<string | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [searchOpen, setSearchOpen] = useState(false)
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
    const dropdownRef = useRef<HTMLDivElement>(null)
    const searchRef = useRef<HTMLDivElement>(null)
    const navRowRef = useRef<HTMLDivElement>(null)
    const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
    const [dropdownStyle, setDropdownStyle] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

    // ── Active helpers ────────────────────────────────────────────

    const isGroupActive = useCallback(
        (group: LoyaltyNavGroup) =>
            group.id === currentView ||
            group.children.some((c) => c.id === currentView),
        [currentView]
    )

    const isChildActive = useCallback(
        (child: LoyaltyNavChild) => child.id === currentView,
        [currentView]
    )

    // ── Breadcrumb ────────────────────────────────────────────────

    const breadcrumbs = useMemo(() => getLoyaltyBreadcrumb(currentView), [currentView])

    // ── Search ────────────────────────────────────────────────────

    const allItems = useMemo(() => getAllLoyaltyNavItems(), [])

    const filteredItems = useMemo(() => {
        if (!searchQuery.trim()) return []
        const q = searchQuery.toLowerCase()
        return allItems.filter((item) => item.label.toLowerCase().includes(q))
    }, [searchQuery, allItems])

    // ── Close dropdown / search on outside click ──────────────────

    useEffect(() => {
        function handleClickOutside(e: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setOpenGroupId(null)
            }
            if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
                setSearchOpen(false)
                setSearchQuery('')
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
        (e: React.KeyboardEvent, viewId: string) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onNavigate(viewId)
                setOpenGroupId(null)
                setMobileMenuOpen(false)
            }
            if (e.key === 'Escape') {
                setOpenGroupId(null)
            }
        },
        [onNavigate]
    )

    // ── Navigate helper ───────────────────────────────────────────

    const handleNav = useCallback(
        (viewId: string) => {
            onNavigate(viewId)
            setOpenGroupId(null)
            setMobileMenuOpen(false)
            setSearchOpen(false)
            setSearchQuery('')
        },
        [onNavigate]
    )

    // ── Render ────────────────────────────────────────────────────

    return (
        <div className="sticky top-0 z-30 bg-card border-b border-border print:hidden">
            {/* ─── Main Row ─────────────────────────────────────────── */}
            <div className="sera-top-nav__inner">
                {/* Loyalty badge */}
                <div className="flex items-center gap-1.5 shrink-0 mr-1">
                    <div className="flex items-center gap-1 bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-2.5 py-0.5 rounded text-sm font-semibold">
                        <Gift className="h-3 w-3" />
                        <span>Loyalty</span>
                    </div>
                </div>

                {/* ── Desktop nav row ──────────────────────────────────── */}
                <div ref={dropdownRef} className="hidden md:flex items-center flex-1 min-w-0 relative">
                    <nav
                        ref={navRowRef}
                        className="flex items-center gap-0.5 overflow-x-auto scrollbar-hide"
                        role="menubar"
                        aria-label="Loyalty navigation"
                    >
                        {loyaltyNavGroups.map((group) => {
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
                                    aria-controls={`ly-dropdown-${group.id}`}
                                    onClick={() => setOpenGroupId(open ? null : group.id)}
                                    onKeyDown={(e) => handleGroupKeyDown(e, group.id)}
                                    className={cn(
                                        'flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md whitespace-nowrap transition-colors',
                                        active
                                            ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200'
                                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                                        open && !active && 'bg-accent text-accent-foreground'
                                    )}
                                >
                                    <Icon className="h-3.5 w-3.5" />
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

                    {/* ── Dropdown panel ── */}
                    {openGroupId && (() => {
                        const group = loyaltyNavGroups.find((g) => g.id === openGroupId)
                        if (!group) return null

                        return (
                            <div
                                id={`ly-dropdown-${group.id}`}
                                role="menu"
                                aria-label={`${group.label} submenu`}
                                className="absolute min-w-[200px] bg-popover border border-border rounded-lg shadow-lg py-1 z-50 animate-in fade-in-0 zoom-in-95 duration-100"
                                style={{ left: dropdownStyle.left, top: dropdownStyle.top + 4 }}
                            >
                                {group.children.map((child) => {
                                    const ChildIcon = child.icon
                                    const childActive = isChildActive(child)

                                    return (
                                        <button
                                            key={child.id}
                                            role="menuitem"
                                            onClick={() => handleNav(child.id)}
                                            onKeyDown={(e) => handleChildKeyDown(e, child.id)}
                                            className={cn(
                                                'w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                                                childActive
                                                    ? 'bg-purple-50 text-purple-700 font-semibold dark:bg-purple-900/30 dark:text-purple-300'
                                                    : 'text-foreground hover:bg-accent'
                                            )}
                                        >
                                            <ChildIcon className="h-3.5 w-3.5 shrink-0" />
                                            <span className="flex-1 text-left">{child.label}</span>
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
                        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent"
                        aria-label="Toggle Loyalty menu"
                    >
                        <MenuIcon className="h-4 w-4" />
                        <span>Menu</span>
                        <ChevronDown className={cn('h-3 w-3 transition-transform', mobileMenuOpen && 'rotate-180')} />
                    </button>
                </div>

                {/* ── Search ──────────────────────────────────────────── */}
                <div ref={searchRef} className="relative shrink-0">
                    {searchOpen ? (
                        <div className="flex items-center gap-1.5 bg-accent rounded-md px-2 py-1">
                            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <input
                                autoFocus
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search Loyalty…"
                                className="bg-transparent text-sm outline-none w-32 sm:w-44 placeholder:text-muted-foreground"
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                        setSearchOpen(false)
                                        setSearchQuery('')
                                    }
                                    if (e.key === 'Enter' && filteredItems.length > 0) {
                                        handleNav(filteredItems[0].id)
                                    }
                                }}
                            />
                            <button
                                onClick={() => {
                                    setSearchOpen(false)
                                    setSearchQuery('')
                                }}
                                className="text-muted-foreground hover:text-foreground"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => setSearchOpen(true)}
                            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-sm text-muted-foreground hover:bg-accent transition-colors"
                            aria-label="Search Loyalty"
                        >
                            <Search className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Search</span>
                        </button>
                    )}

                    {/* ── Search results dropdown ─────────────────────── */}
                    {searchOpen && filteredItems.length > 0 && (
                        <div className="absolute right-0 top-full mt-1 w-60 bg-popover border border-border rounded-lg shadow-lg py-1 z-40 max-h-64 overflow-y-auto">
                            {filteredItems.map((item) => {
                                const ItemIcon = item.icon
                                return (
                                    <button
                                        key={item.id}
                                        onClick={() => handleNav(item.id)}
                                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors"
                                    >
                                        <ItemIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                        <span>{item.label}</span>
                                    </button>
                                )
                            })}
                        </div>
                    )}
                    {searchOpen && searchQuery.trim() && filteredItems.length === 0 && (
                        <div className="absolute right-0 top-full mt-1 w-60 bg-popover border border-border rounded-lg shadow-lg p-3 z-40">
                            <p className="text-sm text-muted-foreground">No results for &quot;{searchQuery}&quot;</p>
                        </div>
                    )}
                </div>
            </div>

            {/* ─── Mobile dropdown ─────────────────────────────────── */}
            {mobileMenuOpen && (
                <div className="md:hidden border-t border-border bg-card max-h-[60vh] overflow-y-auto">
                    {loyaltyNavGroups.map((group) => {
                        const active = isGroupActive(group)
                        const open = openGroupId === group.id
                        const Icon = group.icon

                        return (
                            <div key={group.id}>
                                <button
                                    onClick={() => setOpenGroupId(open ? null : group.id)}
                                    className={cn(
                                        'w-full flex items-center gap-2.5 px-4 py-2.5 text-sm font-medium transition-colors',
                                        active
                                            ? 'bg-purple-50 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200'
                                            : 'text-foreground hover:bg-accent'
                                    )}
                                >
                                    <Icon className="h-4 w-4" />
                                    <span className="flex-1 text-left">{group.label}</span>
                                    <ChevronRight
                                        className={cn(
                                            'h-3.5 w-3.5 transition-transform',
                                            open && 'rotate-90'
                                        )}
                                    />
                                </button>

                                {open && (
                                    <div className="bg-accent/30">
                                        {group.children.map((child) => {
                                            const ChildIcon = child.icon
                                            const childActive = isChildActive(child)

                                            return (
                                                <button
                                                    key={child.id}
                                                    onClick={() => handleNav(child.id)}
                                                    className={cn(
                                                        'w-full flex items-center gap-2.5 pl-10 pr-4 py-2 text-sm transition-colors',
                                                        childActive
                                                            ? 'bg-purple-50 text-purple-700 font-semibold dark:bg-purple-900/30 dark:text-purple-300'
                                                            : 'text-muted-foreground hover:bg-accent'
                                                    )}
                                                >
                                                    <ChildIcon className="h-3.5 w-3.5 shrink-0" />
                                                    <span className="flex-1 text-left">{child.label}</span>
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

            {/* ─── Breadcrumb bar ──────────────────────────────────── */}
            {breadcrumbs.length > 1 && (
                <div className="sera-top-nav__breadcrumb text-[11px] text-muted-foreground border-t border-border/50 bg-muted/30">
                    {breadcrumbs.map((crumb, i) => (
                        <span key={i} className="flex items-center gap-1">
                            {i > 0 && <ChevronRight className="h-2.5 w-2.5" />}
                            {crumb.href && i < breadcrumbs.length - 1 ? (
                                <button
                                    onClick={() => handleNav(crumb.href!)}
                                    className="hover:text-foreground transition-colors underline-offset-2 hover:underline"
                                >
                                    {crumb.label}
                                </button>
                            ) : (
                                <span className={i === breadcrumbs.length - 1 ? 'text-foreground font-medium' : ''}>
                                    {crumb.label}
                                </span>
                            )}
                        </span>
                    ))}
                </div>
            )}
        </div>
    )
}
