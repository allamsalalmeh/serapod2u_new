'use client'

import { useState, type ReactNode } from 'react'
import {
    Cat,
    Check,
    ChevronRight,
    Gift,
    Home,
    Loader2,
    Package,
    ScanLine,
    ShieldCheck,
    User,
} from 'lucide-react'

const ASSET_ROOT = '/images/ellbow-mobile-ready-assets'

const assets = {
    mascot: `${ASSET_ROOT}/webp/01-ellbow-cat-mascot-full.webp`,
    verified: `${ASSET_ROOT}/webp/04-ellbow-verified-shield-cat.webp`,
    campaign: `${ASSET_ROOT}/webp/16-ellbow-campaign-thumbnail.webp`,
    points: `${ASSET_ROOT}/png/11-ellbow-points-reward-icon.png`,
    home: `${ASSET_ROOT}/webp/05-ellbow-home-icon.webp`,
    rewards: `${ASSET_ROOT}/webp/06-ellbow-rewards-gift-icon.webp`,
    scan: `${ASSET_ROOT}/webp/07-ellbow-scan-icon.webp`,
    products: `${ASSET_ROOT}/webp/08-ellbow-product-pack-icon.webp`,
    profile: `${ASSET_ROOT}/webp/09-ellbow-profile-avatar-icon.webp`,
    heroBackground: `${ASSET_ROOT}/webp/15-ellbow-mobile-hero-background.webp`,
    rewardGift: `${ASSET_ROOT}/webp/18-ellbow-featured-reward-gift.webp`,
} as const

function ResilientImage({
    src,
    alt,
    className,
    fallback,
}: {
    src: string
    alt: string
    className: string
    fallback: ReactNode
}) {
    const [failed, setFailed] = useState(false)

    if (failed || !src) return <>{fallback}</>

    return <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />
}

export interface EllbowLiveReward {
    id: string
    name: string
    points: number
    imageUrl: string | null
}

interface EllbowLiveHomeProps {
    campaignName: string
    accountManagerName?: string
    brandName?: string
    campaignImageUrl?: string | null
    points: number
    nextRewardPoints: number
    nextRewardName?: string
    progressPercent: number
    collectLabel: string
    collectDisabled: boolean
    collectLoading: boolean
    collected: boolean
    pointsEnabled: boolean
    rewards: EllbowLiveReward[]
    rewardsLoading: boolean
    onCollect: () => void
    onViewRewards: () => void
    onRewardClick: (rewardId: string) => void
    collectionStatus?: ReactNode
}

export function EllbowLiveHome({
    campaignName,
    accountManagerName,
    brandName = 'RoadTour',
    campaignImageUrl,
    points,
    nextRewardPoints,
    nextRewardName,
    progressPercent,
    collectLabel,
    collectDisabled,
    collectLoading,
    collected,
    pointsEnabled,
    rewards,
    rewardsLoading,
    onCollect,
    onViewRewards,
    onRewardClick,
    collectionStatus,
}: EllbowLiveHomeProps) {
    return (
        <main data-testid="ellbow-live-home" className="min-h-0 flex-1 overflow-y-auto bg-[#f7f8f8] pb-32 text-[#17283a] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <section
                className="relative min-h-[310px] overflow-hidden bg-gradient-to-br from-[#087d78] via-[#0b9790] to-[#39b9ae] px-5 pb-20 pt-7 text-white"
                style={{ backgroundImage: `linear-gradient(135deg,rgba(5,111,107,.94),rgba(10,157,148,.9)),url(${assets.heroBackground})`, backgroundSize: 'cover' }}
            >
                <span className="absolute left-8 top-24 text-3xl text-white/15">🐾</span>
                <span className="absolute right-5 top-8 text-xl text-amber-200">✦</span>
                <span className="absolute right-14 top-16 text-sm text-white/70">✦</span>

                <div className="relative z-10 max-w-[62%] pt-2 text-center">
                    <div className="mx-auto h-[78px] w-[78px]">
                        <ResilientImage
                            src={assets.verified}
                            alt="Verified Ellbow product"
                            className="h-full w-full object-contain drop-shadow-[0_8px_12px_rgba(4,72,70,.35)]"
                            fallback={<ShieldCheck className="h-full w-full rounded-2xl bg-white/15 p-4 text-white" />}
                        />
                    </div>
                    <h1 className="mt-2 text-[28px] font-black leading-[1.02] tracking-tight drop-shadow-sm">
                        Genuine Product<br />Verified!
                    </h1>
                    <p className="mt-3 text-[13px] font-medium text-white/90">
                        This <span className="font-extrabold text-[#ffd7df]">ellbow</span> product is authentic.
                    </p>
                </div>

                <div className="absolute -bottom-5 right-[-24px] h-[270px] w-[230px]">
                    <ResilientImage
                        src={assets.mascot}
                        alt="Ellbow cat mascot"
                        className="h-full w-full object-contain object-bottom drop-shadow-[0_16px_20px_rgba(3,72,68,.34)]"
                        fallback={<Cat className="h-full w-full text-white/80" />}
                    />
                </div>
            </section>

            <div className="relative z-20 -mt-12 space-y-4 px-4">
                <button
                    type="button"
                    onClick={onViewRewards}
                    className="flex w-full items-center gap-3 rounded-[24px] border border-white/80 bg-white p-3 text-left shadow-[0_12px_30px_rgba(23,40,58,.14)] transition active:scale-[.99]"
                >
                    <div className="h-[72px] w-[72px] shrink-0 overflow-hidden rounded-[20px] bg-[#edf9f7]">
                        <ResilientImage
                            src={campaignImageUrl || assets.campaign}
                            alt={campaignName}
                            className="h-full w-full object-contain p-1"
                            fallback={<Gift className="h-full w-full p-4 text-[#0b968e]" />}
                        />
                    </div>
                    <div className="min-w-0 flex-1">
                        <span className="inline-flex items-center gap-1 rounded-full bg-[#0b968e] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                            <Check className="h-3 w-3" /> Active
                        </span>
                        <h2 className="mt-1 line-clamp-2 text-[17px] font-extrabold leading-tight text-[#17283a]">{campaignName}</h2>
                        {accountManagerName && <p className="mt-1 truncate text-[13px] font-bold text-[#dd3c70]">Account Manager: {accountManagerName}</p>}
                        <p className="mt-0.5 text-[11px] text-slate-400">by {brandName}</p>
                    </div>
                    <ChevronRight className="h-6 w-6 shrink-0 text-slate-400" />
                </button>

                <section className="rounded-[24px] border border-white bg-white p-4 shadow-[0_10px_26px_rgba(23,40,58,.10)]">
                    <div className="flex items-center gap-3">
                        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full bg-[#fff5d9]">
                            <ResilientImage
                                src={assets.points}
                                alt="Ellbow paw points"
                                className="h-full w-full object-contain scale-110"
                                fallback={<span className="flex h-full w-full items-center justify-center text-3xl">🐾</span>}
                            />
                        </div>
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[.12em] text-slate-400">Your Points</p>
                            <p className="text-3xl font-black leading-none tabular-nums text-[#17283a]">{points.toLocaleString()}</p>
                        </div>
                        <div className="ml-auto text-right">
                            <p className="text-[11px] font-medium text-slate-400">Next Reward</p>
                            <p className="text-[15px] font-extrabold text-[#0b968e]">
                                {nextRewardPoints > 0 ? `${nextRewardPoints.toLocaleString()} pts away` : 'Ready to claim!'}
                            </p>
                            {nextRewardName && <p className="max-w-[130px] truncate text-[10px] text-slate-400">{nextRewardName}</p>}
                        </div>
                    </div>
                    <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-gradient-to-r from-[#0b8e88] to-[#48c7b9] transition-all duration-700" style={{ width: `${Math.max(0, Math.min(progressPercent, 100))}%` }} />
                    </div>
                </section>

                <div className="space-y-3">
                    {pointsEnabled && (
                        <button
                            type="button"
                            onClick={onCollect}
                            disabled={collectDisabled}
                            className="flex w-full items-center justify-center gap-2 rounded-[20px] bg-gradient-to-r from-[#078d87] to-[#11a198] px-5 py-4 text-[17px] font-extrabold text-white shadow-[0_10px_22px_rgba(11,150,142,.28)] transition active:scale-[.99] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {collectLoading ? (
                                <Loader2 className="h-6 w-6 animate-spin" />
                            ) : collected ? (
                                <Check className="h-6 w-6" />
                            ) : (
                                <ResilientImage src={assets.points} alt="" className="h-7 w-7 object-contain" fallback={<span>🐾</span>} />
                            )}
                            {collectLabel}
                            <ChevronRight className="ml-auto h-5 w-5" />
                        </button>
                    )}
                    {pointsEnabled && collectionStatus}
                    <button
                        type="button"
                        onClick={onViewRewards}
                        className="flex w-full items-center justify-center gap-2 rounded-[20px] border-2 border-[#0b968e] bg-white px-5 py-3.5 text-[17px] font-extrabold text-[#087f79] shadow-sm transition active:scale-[.99]"
                    >
                        <ResilientImage src={assets.rewards} alt="" className="h-7 w-7 object-contain" fallback={<Gift className="h-6 w-6" />} />
                        View Rewards
                        <ChevronRight className="ml-auto h-5 w-5" />
                    </button>
                </div>
            </div>

            <section className="mt-7 px-4">
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-xl font-black text-[#17283a]">Featured Rewards</h2>
                    <button type="button" onClick={onViewRewards} className="flex items-center text-sm font-bold text-[#0b8e88]">
                        See all <ChevronRight className="h-4 w-4" />
                    </button>
                </div>

                {rewardsLoading ? (
                    <div className="flex gap-3 overflow-hidden">
                        {[1, 2, 3].map((item) => <div key={item} className="h-44 w-36 shrink-0 animate-pulse rounded-[22px] bg-white" />)}
                    </div>
                ) : rewards.length > 0 ? (
                    <div className="flex gap-3 overflow-x-auto pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        {rewards.map((reward) => (
                            <button key={reward.id} type="button" onClick={() => onRewardClick(reward.id)} className="w-36 shrink-0 overflow-hidden rounded-[22px] border border-white bg-white text-left shadow-[0_8px_22px_rgba(23,40,58,.09)]">
                                <div className="relative h-28 bg-gradient-to-br from-[#effaf8] to-[#fff3f6] p-2">
                                    <ResilientImage
                                        src={reward.imageUrl || assets.rewardGift}
                                        alt={reward.name}
                                        className="h-full w-full object-contain"
                                        fallback={<Gift className="h-full w-full p-7 text-[#dc3d70]" />}
                                    />
                                    <span className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-1 text-[9px] font-bold text-[#0b8e88] shadow-sm">{reward.points.toLocaleString()} pts</span>
                                </div>
                                <p className="truncate px-3 pb-3 pt-2 text-xs font-bold text-[#17283a]">{reward.name}</p>
                            </button>
                        ))}
                    </div>
                ) : (
                    <div className="rounded-[22px] border border-dashed border-[#a9d9d4] bg-white px-5 py-8 text-center">
                        <Gift className="mx-auto h-9 w-9 text-[#0b968e]" />
                        <p className="mt-2 text-sm font-semibold text-slate-500">New Ellbow rewards are coming soon.</p>
                    </div>
                )}
            </section>
        </main>
    )
}

export type EllbowNavigationTab = 'home' | 'rewards' | 'products' | 'profile'

interface EllbowBottomNavigationProps {
    activeTab: EllbowNavigationTab | string
    onSelect: (tab: EllbowNavigationTab) => void
    onScan: () => void
}

const navItems = [
    { id: 'home' as const, label: 'Home', src: assets.home, fallback: <Home className="h-6 w-6" /> },
    { id: 'rewards' as const, label: 'Rewards', src: assets.rewards, fallback: <Gift className="h-6 w-6" /> },
    { id: 'products' as const, label: 'Product', src: assets.products, fallback: <Package className="h-6 w-6" /> },
    { id: 'profile' as const, label: 'Profile', src: assets.profile, fallback: <User className="h-6 w-6" /> },
]

export function EllbowBottomNavigation({ activeTab, onSelect, onScan }: EllbowBottomNavigationProps) {
    const renderItem = (item: (typeof navItems)[number]) => {
        const active = activeTab === item.id
        return (
            <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={active ? 'page' : undefined}
                className={`flex min-w-0 flex-1 flex-col items-center justify-center rounded-2xl py-1.5 text-[10px] font-bold transition ${active ? 'bg-[#e9f7f5] text-[#07847e]' : 'text-slate-500'}`}
            >
                <span className="h-8 w-8 overflow-hidden">
                    <ResilientImage src={item.src} alt="" className="h-full w-full object-contain" fallback={item.fallback} />
                </span>
                <span>{item.label}</span>
            </button>
        )
    }

    return (
        <nav data-testid="ellbow-bottom-navigation" className="fixed inset-x-0 bottom-0 z-50 border-t border-white/80 bg-white/95 px-2 pb-[max(.5rem,env(safe-area-inset-bottom))] pt-1.5 shadow-[0_-10px_30px_rgba(23,40,58,.12)] backdrop-blur">
            <div className="mx-auto grid max-w-md grid-cols-5 items-end gap-1">
                {renderItem(navItems[0])}
                {renderItem(navItems[1])}
                <button type="button" onClick={onScan} className="relative flex flex-col items-center text-[10px] font-bold text-[#07847e]">
                    <span className="-mt-6 flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-[#08a098] to-[#087d78] shadow-[0_8px_20px_rgba(8,125,120,.35)] ring-4 ring-white">
                        <ResilientImage src={assets.scan} alt="" className="h-12 w-12 object-contain brightness-0 invert" fallback={<ScanLine className="h-8 w-8 text-white" />} />
                    </span>
                    <span>Scan</span>
                </button>
                {renderItem(navItems[2])}
                {renderItem(navItems[3])}
            </div>
        </nav>
    )
}
