'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient, resetClient, forceCleanStorage } from '@/lib/supabase/client'
import { normalizePhone } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Eye, EyeOff, Loader2, AlertCircle,
} from 'lucide-react'
import useEmblaCarousel from 'embla-carousel-react'
import Autoplay from 'embla-carousel-autoplay'
import HeroMedia from '@/components/storefront/HeroMedia'
import LoginProductStage3D from '@/components/auth/LoginProductStage3D'
import SocialAuthButtons from '@/components/auth/SocialAuthButtons'

// ── Types ─────────────────────────────────────────────────────────

interface HeroBanner {
    id: string
    title: string
    subtitle: string
    badge_text: string
    image_url: string
    link_url: string
    link_text: string
    animation_enabled?: boolean
    animation_style?: 'none' | 'kenburns' | 'floatGlow' | 'parallax'
    animation_intensity?: 'low' | 'medium' | 'high'
}

interface LoginPageClientProps {
    branding: {
        logoUrl: string | null
        loginTitle: string
        loginSubtitle: string
        copyrightText: string
    }
    loginBanners: HeroBanner[]
    /** Fixed by the address: business on the staff portal, store on the customer store. */
    hostMode?: 'business' | 'store' | null
}

const WORDMARK_SRC = '/brand/serapod-wordmark.png'
const WORDMARK_LIGHT_SRC = '/brand/serapod-wordmark-light.png'

function BrandWordmark({
    src,
    className,
    priority,
}: {
    src: string
    className?: string
    priority?: boolean
}) {
    return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={src}
            alt="serapod"
            className={className}
            width={360}
            height={120}
            decoding="async"
            {...(priority ? { fetchPriority: 'high' as const } : {})}
        />
    )
}

// ── Component ─────────────────────────────────────────────────────

export default function LoginPageClient({ branding, loginBanners, hostMode = null }: LoginPageClientProps) {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState('')
    const [selectedIndex, setSelectedIndex] = useState(0)
    const router = useRouter()

    // Mode from URL: ?mode=store | ?mode=business (UI copy only)
    const [mode, setMode] = useState<'store' | 'business'>(hostMode ?? 'store')
    const [signupHref, setSignupHref] = useState('/signup')
    const [nextPath, setNextPath] = useState('/store')
    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        const m = params.get('mode')
        if (!hostMode && m === 'business') setMode('business')
        // Show session replaced message
        if (params.get('reason') === 'session_replaced') {
            setError('You were signed out because your account was accessed from another device.')
        }
        const next = params.get('next') || params.get('redirect')
        if (next && next.startsWith('/') && !next.startsWith('//')) setNextPath(next)
        const qs = new URLSearchParams()
        if (next) qs.set('next', next)
        if (m) qs.set('mode', m)
        const q = qs.toString()
        setSignupHref(q ? `/signup?${q}` : '/signup')
    }, [])

    // Track if we're navigating away (prevents state updates during navigation)
    const isNavigatingRef = useRef(false)

    /**
     * Centralized post-login redirect.
     * Calls the server API which reads account_scope and returns { redirectTo }.
     */
    const doPostLoginRedirect = async () => {
        isNavigatingRef.current = true
        try {
            const params = new URLSearchParams(window.location.search)
            const nextParam = params.get('next') || params.get('redirect')
            const safeNext = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//')
                ? nextParam
                : null
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 4000)
            const endpoint = safeNext
                ? `/api/auth/post-login-redirect?next=${encodeURIComponent(safeNext)}`
                : '/api/auth/post-login-redirect'
            const res = await fetch(endpoint, { signal: controller.signal })
            clearTimeout(timeout)
            const data = await res.json()
            window.location.href = data.redirectTo || safeNext || '/store'
        } catch {
            const params = new URLSearchParams(window.location.search)
            const nextParam = params.get('next') || params.get('redirect')
            window.location.href =
                nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//')
                    ? nextParam
                    : '/store'
        }
    }

    const bannerCount = loginBanners.length

    // Embla carousel for hero banners
    const autoplayRef = useRef(
        Autoplay({ delay: 5000, stopOnInteraction: false, stopOnMouseEnter: true })
    )
    const [emblaRef, emblaApi] = useEmblaCarousel(
        { loop: bannerCount > 1, duration: 30 },
        bannerCount > 1 ? [autoplayRef.current] : []
    )

    const onSelect = useCallback(() => {
        if (!emblaApi) return
        setSelectedIndex(emblaApi.selectedScrollSnap())
    }, [emblaApi])

    useEffect(() => {
        if (!emblaApi) return
        emblaApi.on('select', onSelect)
        onSelect()
        return () => { emblaApi.off('select', onSelect) }
    }, [emblaApi, onSelect])

    // Clear stale session on mount — use centralized redirect
    useEffect(() => {
        const clearStaleSession = async () => {
            try {
                const params = new URLSearchParams(window.location.search)
                const nextParam = params.get('next') || params.get('redirect')
                const isStorefrontReturn = hostMode === 'store' || (
                    !!nextParam &&
                    nextParam.startsWith('/') &&
                    !nextParam.startsWith('//') &&
                    (nextParam.startsWith('/outdoor') || nextParam.startsWith('/store') || params.get('mode') === 'store'))

                const supabase = createClient()
                const { data: { user }, error } = await supabase.auth.getUser()
                if (error) {
                    forceCleanStorage()
                    await supabase.auth.signOut({ scope: 'local' })
                    resetClient()
                } else if (user) {
                    const { data: profile } = await supabase
                        .from('users')
                        .select('account_scope, organization_id')
                        .eq('id', user.id)
                        .single()

                    if (profile?.account_scope === 'portal' && profile?.organization_id) {
                        // Portal user already logged in — redirect to dashboard (or next if provided)
                        doPostLoginRedirect()
                    } else if (isStorefrontReturn) {
                        // Shopper already signed in and returning to Outdoor/Store checkout/account
                        doPostLoginRedirect()
                    } else {
                        // Business login page: clear storefront session so HQ can sign in
                        await supabase.auth.signOut({ scope: 'local' })
                        resetClient()
                    }
                }
            } catch {
                forceCleanStorage()
            }
        }
        clearStaleSession()
    }, [router])

    // ── Email/Password Login ────────────────────────────────────────
    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setIsLoading(true)
        setError('')

        try {
            forceCleanStorage()
            resetClient()
            const supabase = createClient()

            let credentials: any = { password }

            if (email.includes('@')) {
                credentials.email = email
            } else {
                const normalizedPhone = normalizePhone(email)
                const { data: userEmail, error: lookupError } = await supabase
                    .rpc('get_email_by_phone' as any, { p_phone: normalizedPhone } as any)

                if (lookupError || !userEmail) {
                    setError('Phone number not found. Please check your number or use email.')
                    setIsLoading(false)
                    return
                }
                credentials.email = userEmail
            }

            const { error: signInError } = await supabase.auth.signInWithPassword(credentials)

            if (signInError) {
                if (signInError.message.includes('Invalid login credentials')) {
                    setError('Invalid email or password. Please check your credentials.')
                } else if (signInError.status === 429) {
                    setError('Too many attempts. Please wait a few minutes.')
                } else {
                    setError(signInError.message)
                }
                setIsLoading(false)
                return
            }

            const { data: { user: authUser } } = await supabase.auth.getUser()
            if (!authUser) {
                setError('Authentication failed. Please try again.')
                setIsLoading(false)
                return
            }

            // Update last_login_at
            try {
                await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', authUser.id)
            } catch { }

            // Get user profile to determine redirect
            let { data: userProfile } = await supabase
                .from('users')
                .select('*, organizations!fk_users_organization(org_type_code)')
                .eq('id', authUser.id)
                .single()

            if (!userProfile) {
                await new Promise(resolve => setTimeout(resolve, 500))
                const { data: retryProfile } = await supabase
                    .from('users')
                    .select('*, organizations!fk_users_organization(org_type_code)')
                    .eq('id', authUser.id)
                    .single()
                userProfile = retryProfile
            }

            if (!userProfile || !userProfile.is_active) {
                await supabase.auth.signOut()
                setError('Your account is inactive. Contact your administrator.')
                setIsLoading(false)
                return
            }

            // Update last_login via RPC
            try {
                await supabase.rpc('update_last_login', { user_id: authUser.id } as any)
            } catch { }

            // Capture IP (fire and forget)
            fetch('/api/update-login-ip', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(() => { })

            // Stamp session ID for single-session enforcement
            const sessionId = crypto.randomUUID()
            try {
                await supabase.from('users').update({ active_session_id: sessionId, session_started_at: new Date().toISOString() } as any).eq('id', authUser.id)
                localStorage.setItem('serapod_session_id', sessionId)
            } catch { }

            // Route via centralized post-login redirect API (hard navigation)
            await doPostLoginRedirect()
        } catch (err) {
            console.error('Login error:', err)
            if (!isNavigatingRef.current) {
                setError('An unexpected error occurred. Please try again.')
                setIsLoading(false)
            }
        }
    }

    // ── Render ──────────────────────────────────────────────────────

    return (
        <div className="min-h-screen flex bg-[var(--sera-paper)]">
            {/* Left: Brand visual plane */}
            <div className="hidden lg:flex lg:w-[54%] xl:w-[58%] relative overflow-hidden bg-[var(--sera-ink)] text-white">
                {bannerCount > 0 ? (
                    <>
                        <div ref={emblaRef} className="overflow-hidden absolute inset-0">
                            <div className="flex h-full">
                                {loginBanners.map((banner, index) => (
                                    <div key={banner.id} className="relative flex-[0_0_100%] min-w-0 h-full">
                                        <HeroMedia
                                            imageUrl={banner.image_url}
                                            alt={banner.title || 'Banner'}
                                            animationEnabled={banner.animation_enabled}
                                            animationStyle={banner.animation_style || 'none'}
                                            intensity={banner.animation_intensity || 'low'}
                                            context="login"
                                            priority={index === 0}
                                        />
                                        <div className="absolute inset-0 bg-gradient-to-t from-[var(--sera-ink)] via-[var(--sera-ink)]/45 to-transparent" />
                                        <div className="absolute inset-x-0 bottom-0 p-10 xl:p-14">
                                            <BrandWordmark
                                                src={WORDMARK_LIGHT_SRC}
                                                className="h-10 xl:h-12 w-auto mb-6 login-rise"
                                                priority={index === 0}
                                            />
                                            {(banner.title || banner.subtitle) && (
                                                <div className="text-white max-w-lg login-rise login-rise-delay-1">
                                                    {banner.title && (
                                                        <h2 className="font-display text-3xl xl:text-4xl font-semibold leading-tight tracking-tight mb-2">
                                                            {banner.title}
                                                        </h2>
                                                    )}
                                                    {banner.subtitle && (
                                                        <p className="text-base text-white/75 leading-relaxed">{banner.subtitle}</p>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                        {bannerCount > 1 && (
                            <div className="absolute bottom-5 left-10 xl:left-14 flex items-center gap-2 z-10">
                                {loginBanners.map((_, i) => (
                                    <button
                                        key={i}
                                        onClick={() => emblaApi?.scrollTo(i)}
                                        className={`h-1.5 rounded-sm transition-all ${i === selectedIndex ? 'w-8 bg-[var(--sera-orange)]' : 'w-3 bg-white/35 hover:bg-white/55'}`}
                                        aria-label={`Go to slide ${i + 1}`}
                                    />
                                ))}
                            </div>
                        )}
                    </>
                ) : (
                    <div className="relative w-full h-full overflow-hidden">
                        {/* Atmospheric field — charcoal + orange, no purple */}
                        <div
                            className="absolute inset-0 login-sheen"
                            style={{
                                backgroundImage:
                                    'radial-gradient(ellipse 80% 60% at 20% 80%, rgba(232,93,4,0.28), transparent 55%), radial-gradient(ellipse 70% 50% at 85% 15%, rgba(255,255,255,0.08), transparent 50%), linear-gradient(145deg, #141210 0%, #1f1b17 45%, #2a2018 100%)',
                            }}
                        />
                        <div
                            className="absolute inset-0 opacity-[0.14] mix-blend-soft-light"
                            style={{
                                backgroundImage:
                                    'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E")',
                            }}
                        />
                        {/* Soft brand atmosphere — kept subtle so products + copy stay primary */}
                        <div className="absolute inset-x-0 bottom-0 h-1/2 opacity-50 pointer-events-none">
                            <div
                                className="absolute inset-0"
                                style={{
                                    background:
                                        'radial-gradient(ellipse 70% 80% at 70% 80%, rgba(232,93,4,0.18), transparent 60%)',
                                }}
                            />
                        </div>

                        <div className="relative z-10 flex h-full flex-col p-10 xl:p-14">
                            <div className="login-rise shrink-0">
                                <BrandWordmark
                                    src={WORDMARK_LIGHT_SRC}
                                    className="h-11 xl:h-14 w-auto"
                                    priority
                                />
                            </div>

                            {/* Tall product fills vertical void; copy sits beside it */}
                            <div className="flex-1 flex items-center min-h-0 py-4">
                                <div className="w-full flex flex-col xl:flex-row xl:items-center xl:justify-between gap-8 xl:gap-6">
                                    <div className="max-w-[340px] xl:max-w-md shrink-0">
                                        <div className="h-1.5 w-16 rounded-sm bg-[var(--sera-orange)] mb-7 login-accent-bar login-rise login-rise-delay-1" />
                                        <h2 className="font-display text-5xl xl:text-6xl font-semibold tracking-tight leading-[1.05] login-rise login-rise-delay-2">
                                            Products.<br />Campaigns.<br />One flow.
                                        </h2>
                                        <p className="mt-6 text-lg xl:text-xl text-white/75 leading-relaxed login-rise login-rise-delay-3">
                                            From flavour drops to field teams — Serapod keeps every launch moving with the brand.
                                        </p>
                                    </div>

                                    <div className="login-rise login-rise-delay-2 flex justify-center xl:justify-end flex-1 min-h-0">
                                        <LoginProductStage3D />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Right: Sign-in interaction */}
            <div className="flex-1 flex flex-col min-h-screen bg-[var(--sera-paper)] relative">
                <div
                    className="pointer-events-none absolute inset-0 opacity-[0.35]"
                    style={{
                        backgroundImage:
                            'linear-gradient(to right, transparent 0%, transparent 96%, rgba(20,18,16,0.04) 100%), radial-gradient(ellipse 50% 40% at 100% 0%, rgba(232,93,4,0.06), transparent 60%)',
                    }}
                />

                <div className="relative flex items-center justify-between px-6 sm:px-10 py-5">
                    <Link href="/store" className="flex items-center gap-3 group">
                        <BrandWordmark
                            src={WORDMARK_SRC}
                            className="h-8 sm:h-9 w-auto max-w-[160px] object-contain object-left"
                            priority
                        />
                    </Link>
                    <Link
                        href="/store"
                        className="text-sm text-[var(--sera-muted)] hover:text-[var(--sera-ink)] transition-colors"
                    >
                        Need help?
                    </Link>
                </div>

                <div className="relative flex-1 flex items-center justify-center px-6 sm:px-10 py-8">
                    <div className="w-full max-w-[420px]">
                        {/* Mobile brand mark when left panel is hidden */}
                        <div className="lg:hidden mb-10 login-rise">
                            <BrandWordmark src={WORDMARK_SRC} className="h-10 w-auto" priority />
                            <div className="mt-4 h-1 w-12 rounded-sm bg-[var(--sera-orange)] login-accent-bar" />
                        </div>

                        <div className="login-rise login-rise-delay-1">
                            <h1 className="font-display text-3xl sm:text-[2.1rem] font-semibold tracking-tight text-[var(--sera-ink)]">
                                {mode === 'business' ? 'Business Portal' : 'Welcome back'}
                            </h1>
                            <p className="mt-2 text-sm sm:text-[15px] text-[var(--sera-muted)] leading-relaxed">
                                {mode === 'business'
                                    ? 'Sign in to access your Serapod business dashboard.'
                                    : hostMode === 'store'
                                        ? 'Sign in to your Serapod2U account to shop and track your orders.'
                                        : (branding.loginSubtitle || 'Sign in to continue to your workspace.')}
                            </p>
                        </div>

                        {error && (
                            <div className="mt-6 bg-red-50 border border-red-200/80 rounded-lg p-3.5 flex items-start gap-2.5 login-rise login-rise-delay-2">
                                <AlertCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
                                <p className="text-sm text-red-700 leading-snug">{error}</p>
                            </div>
                        )}

                        <form onSubmit={handleSubmit} className="mt-8 space-y-5 login-rise login-rise-delay-2">
                            <div className="space-y-2">
                                <Label htmlFor="email" className="text-[13px] font-medium text-[var(--sera-ink-soft)]">
                                    Phone number / Email
                                </Label>
                                <Input
                                    id="email"
                                    type="text"
                                    placeholder="Enter your email or phone number"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                    disabled={isLoading}
                                    className="h-12 rounded-lg border-[var(--sera-line)] bg-white px-3.5 text-[var(--sera-ink)] placeholder:text-gray-400 focus-visible:ring-[var(--sera-orange)]/30 focus-visible:border-[var(--sera-orange)]"
                                />
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="password" className="text-[13px] font-medium text-[var(--sera-ink-soft)]">
                                    Password
                                </Label>
                                <div className="relative">
                                    <Input
                                        id="password"
                                        type={showPassword ? 'text' : 'password'}
                                        placeholder="Enter your password"
                                        value={password}
                                        onChange={(e) => setPassword(e.target.value)}
                                        required
                                        disabled={isLoading}
                                        className="h-12 pr-11 rounded-lg border-[var(--sera-line)] bg-white px-3.5 text-[var(--sera-ink)] placeholder:text-gray-400 focus-visible:ring-[var(--sera-orange)]/30 focus-visible:border-[var(--sera-orange)]"
                                    />
                                    <button
                                        type="button"
                                        className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-gray-400 hover:text-[var(--sera-ink)] transition-colors"
                                        onClick={() => setShowPassword(!showPassword)}
                                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    >
                                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                    </button>
                                </div>
                            </div>

                            <Button
                                type="submit"
                                className="w-full h-12 rounded-lg bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white font-semibold tracking-wide shadow-none transition-colors"
                                disabled={isLoading}
                            >
                                {isLoading ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Signing in...
                                    </>
                                ) : (
                                    'LOG IN'
                                )}
                            </Button>
                        </form>

                        <div className="mt-4 login-rise login-rise-delay-3">
                            <Link
                                href={email.trim()
                                    ? `/forgot-password?identifier=${encodeURIComponent(email.trim())}`
                                    : '/forgot-password'}
                                className="text-sm font-medium text-[var(--sera-ink-soft)] underline-offset-4 hover:text-[var(--sera-orange)] hover:underline transition-colors"
                            >
                                Forgot Password
                            </Link>
                        </div>

                        {hostMode !== 'business' && (
                            <>
                                <div className="relative my-8 login-rise login-rise-delay-3">
                                    <div className="absolute inset-0 flex items-center">
                                        <div className="w-full border-t border-[var(--sera-line)]" />
                                    </div>
                                    <div className="relative flex justify-center text-[11px] uppercase tracking-[0.18em]">
                                        <span className="bg-[var(--sera-paper)] px-3 text-[var(--sera-muted)] font-medium">OR</span>
                                    </div>
                                </div>

                                <div className="login-rise login-rise-delay-4">
                                    <SocialAuthButtons
                                        nextPath={nextPath}
                                        disabled={isLoading}
                                        onError={setError}
                                        variant="portal"
                                    />
                                </div>

                                <div className="mt-8 text-center text-sm text-[var(--sera-muted)] login-rise login-rise-delay-4">
                                    New to Serapod2U?{' '}
                                    <Link href={signupHref} className="font-semibold text-[var(--sera-ink)] hover:text-[var(--sera-orange)] transition-colors">
                                        Sign Up
                                    </Link>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                <div className="relative px-6 sm:px-10 py-4 text-center">
                    <p className="text-[11px] tracking-wide text-[var(--sera-muted)]">{branding.copyrightText}</p>
                </div>
            </div>
        </div>
    )
}
