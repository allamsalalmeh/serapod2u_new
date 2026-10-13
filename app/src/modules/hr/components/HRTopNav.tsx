'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Briefcase, Search, ChevronRight, ChevronDown, X, Menu as MenuIcon, Bot } from 'lucide-react'
import {
    filterHrNavGroups,
    getAllHrNavItems,
    getHrBreadcrumb,
    type HrNavGroup,
    type HrNavChild,
} from '@/modules/hr/hrNav'
import { cn } from '@/lib/utils'
import { useNavAccess } from '@/hooks/useNavAccess'

// ── Props ────────────────────────────────────────────────────────

interface HRTopNavProps {
    /** The current SPA view id (e.g. 'hr/people/employees') */
    currentView: string
    /** Callback for navigating (same as sidebar's onViewChange → router.push) */
    onNavigate: (href: string) => void
}

// ── Component ────────────────────────────────────────────────────

export default function HRTopNav({ currentView, onNavigate }: HRTopNavProps) {
    const router = useRouter()
    // Only the destinations this person may open (Security & Access snapshot); nothing while it loads or is unavailable.
    const { snapshot, allowsAny } = useNavAccess()
    const hrNavGroups = useMemo(() => filterHrNavGroups(allowsAny), [snapshot]) // eslint-disable-line react-hooks/exhaustive-deps
    const [openGroupId, setOpenGroupId] = useState<string | null>(null)
    const [searchQuery, setSearchQuery] = useState('')
    const [searchOpen, setSearchOpen] = useState(false)
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
    const [aiHealthOk, setAiHealthOk] = useState<boolean | null>(null)
    const dropdownRef = useRef<HTMLDivElement>(null)
    const searchRef = useRef<HTMLDivElement>(null)
    const navRowRef = useRef<HTMLDivElement>(null)
    const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
    const [dropdownStyle, setDropdownStyle] = useState<{ left: number; top: number }>({ left: 0, top: 0 })

    // ── AI health indicator ───────────────────────────────────────
    useEffect(() => {
        let cancelled = false
        const check = async () => {
            try {
                const res = await fetch('/api/ai/health')
                if (!cancelled) {
                    const data = await res.json()
                    setAiHealthOk(data.ok === true)
                }
            } catch {
                if (!cancelled) setAiHealthOk(false)
            }
        }
        check()
        const interval = setInterval(check, 60_000) // re-check every 60s
        return () => { cancelled = true; clearInterval(interval) }
    }, [])

    // ── Active helpers ────────────────────────────────────────────

    const isGroupActive = useCallback(
        (group: HrNavGroup) =>
            group.id === currentView ||
            group.children.some((c) => c.id === currentView),
        [currentView]
    )

    const isChildActive = useCallback(
        (child: HrNavChild) => child.id === currentView,
        [currentView]
    )

    // ── Breadcrumb ────────────────────────────────────────────────

    const breadcrumbs = useMemo(() => getHrBreadcrumb(currentView), [currentView])

    // ── Search ────────────────────────────────────────────────────

    const allItems = useMemo(() => getAllHrNavItems(hrNavGroups), [hrNavGroups])

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
        (e: React.KeyboardEvent, href: string) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onNavigate(href)
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
        (href: string) => {
            onNavigate(href)
            setOpenGroupId(null)
            setMobileMenuOpen(false)
            setSearchOpen(false)
            setSearchQuery('')
        },
        [onNavigate]
    )

    // ── Render ────────────────────────────────────────────────────

    return (
        <div className="sticky top-0 z-40 bg-white border-b border-[var(--sera-line)] print:hidden">
            {/* ─── Main Row ─────────────────────────────────────────── */}
            <div className="sera-top-nav__inner">
                {/* HR badge */}
                <div className="flex items-center gap-1.5 shrink-0 mr-1">
                    <div className="flex items-center gap-1.5 bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)] px-2.5 py-0.5 rounded-md text-sm font-semibold">
                        <Briefcase className="h-3 w-3" strokeWidth={1.75} />
                        <span>HR</span>
                    </div>
                </div>

                {/* ── Desktop nav row ──────────────────────────────────── */}
                <div ref={dropdownRef} className="hidden md:flex items-center flex-1 min-w-0 relative">
                    <nav
                        ref={navRowRef}
                        className="flex items-center gap-0.5 overflow-x-auto scrollbar-hide"
                        role="menubar"
                        aria-label="HR navigation"
                    >
                        {hrNavGroups.map((group) => {
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
                                    aria-controls={`hr-dropdown-${group.id}`}
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

                    {/* ── Dropdown panel – rendered outside the scrolling <nav> ── */}
                    {openGroupId && (() => {
                        const group = hrNavGroups.find((g) => g.id === openGroupId)
                        if (!group) return null

                        return (
                            <div
                                id={`hr-dropdown-${group.id}`}
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
                                            onClick={() => handleNav(child.href)}
                                            onKeyDown={(e) => handleChildKeyDown(e, child.href)}
                                            className={cn(
                                                'w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                                                childActive
                                                    ? 'bg-[var(--sera-orange)]/8 text-[var(--sera-ink)] font-semibold'
                                                    : 'text-[var(--sera-ink)] hover:bg-[var(--sera-mist)]'
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

                {/* ── Mobile hamburger ────────────────────────────────── */}
                <div className="flex md:hidden flex-1 min-w-0">
                    <button
                        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-sm font-medium text-[var(--sera-muted)] hover:bg-[var(--sera-mist)]"
                        aria-label="Toggle HR menu"
                    >
                        <MenuIcon className="h-4 w-4" />
                        <span>Menu</span>
                        <ChevronDown className={cn('h-3 w-3 transition-transform', mobileMenuOpen && 'rotate-180')} />
                    </button>
                </div>

                {/* ── AI Assistant ────────────────────────────────────── */}
                <button
                    onClick={() => {
                        // Dispatch custom event to open the AI drawer
                        window.dispatchEvent(new CustomEvent('hr-ai-assistant-toggle'))
                    }}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-sm text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)] transition-colors shrink-0"
                    aria-label="AI Assistant"
                    title={aiHealthOk === null ? 'HR AI Assistant – checking…' : aiHealthOk ? 'HR AI Assistant – online' : 'HR AI Assistant – offline'}
                >
                    <span className="relative">
                        <Bot className="h-3.5 w-3.5" />
                        {aiHealthOk !== null && (
                            <span
                                className={cn(
                                    'absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-white dark:ring-gray-900',
                                    aiHealthOk ? 'bg-emerald-500' : 'bg-red-500'
                                )}
                            />
                        )}
                    </span>
                    <span className="hidden sm:inline">AI Assistant</span>
                </button>

                {/* ── Search ──────────────────────────────────────────── */}
                <div ref={searchRef} className="relative shrink-0">
                    {searchOpen ? (
                        <div className="flex items-center gap-1.5 bg-[var(--sera-mist)] rounded-md px-2 py-1">
                            <Search className="h-3.5 w-3.5 text-[var(--sera-muted)] shrink-0" />
                            <input
                                autoFocus
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search HR…"
                                className="bg-transparent text-sm outline-none w-32 sm:w-44 placeholder:text-[var(--sera-muted)]"
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                        setSearchOpen(false)
                                        setSearchQuery('')
                                    }
                                    if (e.key === 'Enter' && filteredItems.length > 0) {
                                        handleNav(filteredItems[0].href)
                                    }
                                }}
                            />
                            <button
                                onClick={() => {
                                    setSearchOpen(false)
                                    setSearchQuery('')
                                }}
                                className="text-[var(--sera-muted)] hover:text-[var(--sera-ink)]"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </div>
                    ) : (
                        <button
                            onClick={() => setSearchOpen(true)}
                            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-sm text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] transition-colors"
                            aria-label="Search HR"
                        >
                            <Search className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Search</span>
                        </button>
                    )}

                    {/* ── Search results dropdown ─────────────────────── */}
                    {searchOpen && filteredItems.length > 0 && (
                        <div className="absolute right-0 top-full mt-1 w-60 bg-white border border-[var(--sera-line)] rounded-lg shadow-sm py-1 z-40 max-h-64 overflow-y-auto">
                            {filteredItems.map((item) => {
                                const ItemIcon = item.icon
                                return (
                                    <button
                                        key={item.id}
                                        onClick={() => handleNav(item.href)}
                                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--sera-ink)] hover:bg-[var(--sera-mist)] transition-colors"
                                    >
                                        <ItemIcon className="h-3.5 w-3.5 shrink-0 text-[var(--sera-muted)]" />
                                        <span>{item.label}</span>
                                    </button>
                                )
                            })}
                        </div>
                    )}
                    {searchOpen && searchQuery.trim() && filteredItems.length === 0 && (
                        <div className="absolute right-0 top-full mt-1 w-60 bg-white border border-[var(--sera-line)] rounded-lg shadow-sm p-3 z-40">
                            <p className="text-sm text-[var(--sera-muted)]">No results for &quot;{searchQuery}&quot;</p>
                        </div>
                    )}
                </div>
            </div>

            {/* ─── Mobile dropdown ─────────────────────────────────── */}
            {mobileMenuOpen && (
                <div className="md:hidden border-t border-[var(--sera-line)] bg-white max-h-[60vh] overflow-y-auto">
                    {hrNavGroups.map((group) => {
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
                                            ? 'bg-[var(--sera-orange)]/10 text-[var(--sera-ink)]'
                                            : 'text-[var(--sera-ink)] hover:bg-[var(--sera-mist)]'
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
                                    <div className="bg-[var(--sera-mist)]/50">
                                        {group.children.map((child) => {
                                            const ChildIcon = child.icon
                                            const childActive = isChildActive(child)

                                            return (
                                                <button
                                                    key={child.id}
                                                    onClick={() => handleNav(child.href)}
                                                    className={cn(
                                                        'w-full flex items-center gap-2.5 pl-10 pr-4 py-2 text-sm transition-colors',
                                                        childActive
                                                            ? 'bg-[var(--sera-orange)]/8 text-[var(--sera-ink)] font-semibold'
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

            {/* ─── Breadcrumb bar ──────────────────────────────────── */}
            {breadcrumbs.length > 1 && (
                <div className="sera-top-nav__breadcrumb text-[11px] text-[var(--sera-muted)] border-t border-[var(--sera-line)]/80 bg-[var(--sera-mist)]/50">
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
