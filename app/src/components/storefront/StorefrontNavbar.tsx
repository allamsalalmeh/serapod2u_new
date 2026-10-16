'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useState, useEffect, useRef } from 'react'
import { ShoppingCart, Search, User, Menu, X, LogOut, Package, ChevronDown } from 'lucide-react'
import { useCart } from '@/lib/storefront/cart-context'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import StoreBrandMark from '@/components/storefront/StoreBrandMark'

interface UserInfo {
  id: string
  full_name: string | null
  email: string
  avatar_url: string | null
  phone: string | null
}

const NAV_LINKS = [
  { href: '/store', label: 'Home', match: (path: string) => path === '/store' },
  {
    href: '/store/products',
    label: 'Products',
    match: (path: string) => path.startsWith('/store/products'),
  },
]

export default function StorefrontNavbar() {
  const { totalItems, clearCart } = useCart()
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [user, setUser] = useState<UserInfo | null>(null)
  const [showDropdown, setShowDropdown] = useState(false)
  const [loadingAuth, setLoadingAuth] = useState(true)
  const [scrolled, setScrolled] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const supabase = createClient()
        const { data: { user: authUser } } = await supabase.auth.getUser()

        if (authUser) {
          const { data: profile } = await supabase
            .from('users')
            .select('id, full_name, email, avatar_url, phone')
            .eq('id', authUser.id)
            .single()

          if (profile) {
            setUser(profile)
          } else {
            setUser({
              id: authUser.id,
              full_name: authUser.user_metadata?.full_name || null,
              email: authUser.email || '',
              avatar_url: authUser.user_metadata?.avatar_url || null,
              phone: authUser.phone || null
            })
          }
        }
      } catch {
        // Not logged in
      } finally {
        setLoadingAuth(false)
      }
    }
    checkAuth()

    const supabase = createClient()
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        const { data: profile } = await supabase
          .from('users')
          .select('id, full_name, email, avatar_url, phone')
          .eq('id', session.user.id)
          .single()
        if (profile) setUser(profile)
      } else if (event === 'SIGNED_OUT') {
        setUser(null)
      }
    })

    return () => { subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    if (searchQuery.trim()) {
      router.push(`/store/products?search=${encodeURIComponent(searchQuery.trim())}`)
      setSearchOpen(false)
      setMobileMenuOpen(false)
    }
  }

  const handleSignOut = async () => {
    try {
      const supabase = createClient()
      await supabase.auth.signOut()
      clearCart()
      setUser(null)
      setShowDropdown(false)
      router.push('/store')
      router.refresh()
    } catch { }
  }

  const getInitials = (name: string | null, email: string) => {
    if (name) {
      return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    }
    return email[0]?.toUpperCase() || 'U'
  }

  return (
    <header
      className={`sticky top-0 z-50 border-b backdrop-blur-md transition-[border-color,box-shadow,background-color] duration-300 ${
        scrolled
          ? 'border-[var(--sera-line)] bg-[var(--sera-surface)]/92 shadow-[0_10px_32px_-18px_rgba(20,18,16,0.4)]'
          : 'border-transparent bg-[var(--sera-paper)]/88'
      }`}
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-[4.25rem] items-center gap-4 lg:gap-6">
          <Link href="/store" className="flex flex-shrink-0 items-center group" aria-label="Serapod Store home">
            <StoreBrandMark
              className="h-7 w-auto transition-transform duration-300 group-hover:scale-[1.02] sm:h-8"
              priority
            />
          </Link>

          <nav className="ml-2 hidden items-center gap-1 lg:flex" aria-label="Primary">
            {NAV_LINKS.map((link) => {
              const active = link.match(pathname || '')
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`relative rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? 'text-[var(--sera-ink)]'
                      : 'text-[var(--sera-muted)] hover:text-[var(--sera-ink)]'
                  }`}
                >
                  {link.label}
                  {active && (
                    <span className="absolute inset-x-3 -bottom-0.5 h-0.5 rounded-full bg-[var(--sera-orange)]" />
                  )}
                </Link>
              )
            })}
          </nav>

          <div className="mx-auto hidden min-w-0 max-w-md flex-1 md:block lg:mx-0 lg:max-w-sm xl:max-w-md">
            <form onSubmit={handleSearch} className="relative w-full">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search products..."
                className="h-10 w-full rounded-xl border border-[var(--sera-line)] bg-[var(--sera-surface)] pl-10 pr-4 text-sm text-[var(--sera-ink)] placeholder:text-[var(--sera-muted)]/70 transition-all focus:border-[var(--sera-orange)]/40 focus:bg-[var(--sera-surface)] focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/20"
              />
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sera-muted)]" />
            </form>
          </div>

          <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
            <button
              onClick={() => setSearchOpen(!searchOpen)}
              className="rounded-xl p-2.5 text-[var(--sera-muted)] transition-colors hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)] md:hidden"
              aria-label="Search"
            >
              <Search className="h-5 w-5" />
            </button>

            <Link
              href="/store/cart"
              className="relative rounded-xl p-2.5 text-[var(--sera-muted)] transition-colors hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)]"
              aria-label="Cart"
            >
              <ShoppingCart className="h-5 w-5" />
              {totalItems > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-[var(--sera-orange)] px-1 text-[10px] font-bold text-white">
                  {totalItems > 99 ? '99+' : totalItems}
                </span>
              )}
            </Link>

            {!loadingAuth && (
              user ? (
                <div className="relative" ref={dropdownRef}>
                  <button
                    onClick={() => setShowDropdown(!showDropdown)}
                    className="flex items-center gap-2 rounded-full p-1 transition-colors hover:bg-[var(--sera-mist)]"
                    aria-label="User menu"
                  >
                    {user.avatar_url ? (
                      <Image
                        src={user.avatar_url}
                        alt={user.full_name || 'User'}
                        width={32}
                        height={32}
                        className="h-8 w-8 rounded-full border border-[var(--sera-line)] object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[var(--sera-orange)] to-[var(--sera-orange-deep)] text-xs font-bold text-white">
                        {getInitials(user.full_name, user.email)}
                      </div>
                    )}
                    <span className="hidden max-w-[120px] truncate text-sm font-medium text-[var(--sera-ink-soft)] sm:block">
                      {user.full_name || user.email.split('@')[0]}
                    </span>
                    <ChevronDown className="hidden h-4 w-4 text-[var(--sera-muted)] sm:block" />
                  </button>

                  {showDropdown && (
                    <div className="absolute right-0 z-50 mt-2 w-64 animate-in fade-in slide-in-from-top-2 rounded-2xl border border-[var(--sera-line)] bg-[var(--sera-surface)] py-2 shadow-lg duration-150">
                      <div className="border-b border-[var(--sera-line)] px-4 py-3">
                        <div className="flex items-center gap-3">
                          {user.avatar_url ? (
                            <Image
                              src={user.avatar_url}
                              alt=""
                              width={40}
                              height={40}
                              className="h-10 w-10 rounded-full object-cover"
                              unoptimized
                            />
                          ) : (
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-[var(--sera-orange)] to-[var(--sera-orange-deep)] text-sm font-bold text-white">
                              {getInitials(user.full_name, user.email)}
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-[var(--sera-ink)]">
                              {user.full_name || 'User'}
                            </p>
                            <p className="truncate text-xs text-[var(--sera-muted)]">{user.email}</p>
                          </div>
                        </div>
                      </div>

                      <div className="py-1">
                        <Link
                          href="/store/account"
                          onClick={() => setShowDropdown(false)}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-[var(--sera-ink-soft)] transition-colors hover:bg-[var(--sera-mist)]"
                        >
                          <User className="h-4 w-4 text-[var(--sera-muted)]" />
                          My Account
                        </Link>
                        <Link
                          href="/store/orders"
                          onClick={() => setShowDropdown(false)}
                          className="flex items-center gap-3 px-4 py-2.5 text-sm text-[var(--sera-ink-soft)] transition-colors hover:bg-[var(--sera-mist)]"
                        >
                          <Package className="h-4 w-4 text-[var(--sera-muted)]" />
                          My Purchases
                        </Link>
                      </div>

                      <div className="border-t border-[var(--sera-line)] py-1">
                        <button
                          onClick={handleSignOut}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-red-600 transition-colors hover:bg-red-50"
                        >
                          <LogOut className="h-4 w-4" />
                          Logout
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Link
                  href="/login"
                  className="hidden items-center gap-1.5 rounded-xl bg-[var(--sera-orange)] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--sera-orange-deep)] sm:inline-flex"
                >
                  <User className="h-4 w-4" />
                  Login
                </Link>
              )
            )}

            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="rounded-xl p-2.5 text-[var(--sera-muted)] transition-colors hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)] md:hidden"
              aria-label="Menu"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {searchOpen && (
          <div className="pb-3 md:hidden">
            <form onSubmit={handleSearch} className="relative">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search products..."
                autoFocus
                className="h-10 w-full rounded-xl border border-[var(--sera-line)] bg-[var(--sera-paper)] pl-10 pr-4 text-sm text-[var(--sera-ink)] placeholder:text-[var(--sera-muted)]/70 focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/25"
              />
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sera-muted)]" />
            </form>
          </div>
        )}

        {mobileMenuOpen && (
          <div className="space-y-1 border-t border-[var(--sera-line)] py-3 md:hidden">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`block rounded-xl px-3 py-2.5 text-sm font-medium ${
                  link.match(pathname || '')
                    ? 'bg-[var(--sera-mist)] text-[var(--sera-ink)]'
                    : 'text-[var(--sera-ink-soft)] hover:bg-[var(--sera-mist)]'
                }`}
              >
                {link.label}
              </Link>
            ))}
            {user ? (
              <>
                <Link href="/store/account" onClick={() => setMobileMenuOpen(false)}
                  className="block rounded-xl px-3 py-2.5 text-sm font-medium text-[var(--sera-ink-soft)] hover:bg-[var(--sera-mist)]">My Account</Link>
                <Link href="/store/orders" onClick={() => setMobileMenuOpen(false)}
                  className="block rounded-xl px-3 py-2.5 text-sm font-medium text-[var(--sera-ink-soft)] hover:bg-[var(--sera-mist)]">My Purchases</Link>
                <button onClick={() => { handleSignOut(); setMobileMenuOpen(false) }}
                  className="block w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50">Logout</button>
              </>
            ) : (
              <Link href="/login" onClick={() => setMobileMenuOpen(false)}
                className="block rounded-xl px-3 py-2.5 text-sm font-medium text-[var(--sera-ink-soft)] hover:bg-[var(--sera-mist)]">Login</Link>
            )}
          </div>
        )}
      </div>
      <div className="h-0.5 w-full bg-gradient-to-r from-transparent via-[var(--sera-orange)]/70 to-transparent opacity-80" />
    </header>
  )
}
