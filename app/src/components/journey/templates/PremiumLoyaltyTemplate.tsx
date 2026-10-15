'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import Image from 'next/image'
import { motion, AnimatePresence } from 'framer-motion'
import { formatNumber } from '@/lib/utils/formatters'
import { createClient } from '@/lib/supabase/client'
import { logoutConsumer } from '@/app/actions/consumer'
import { registerConsumer } from '@/lib/actions'
import { captureRoadtourGeolocation } from '@/lib/roadtour/location-client'
import type { RoadtourLocationPayload } from '@/lib/roadtour/location-shared'
import { SupportChatWidgetV2 } from '@/components/support/SupportChatWidgetV2'
import SafeImage from '@/components/shared/SafeImage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import {
    Home,
    Gift,
    Star,
    Gamepad2,
    Building2,
    User,
    ChevronRight,
    ChevronLeft,
    Coins,
    Trophy,
    Sparkles,
    CheckCircle2,
    ArrowLeft,
    X,
    XCircle,
    ShoppingBag,
    Ticket,
    Crown,
    Zap,
    Package,
    LogIn,
    CreditCard,
    LogOut,
    Eye,
    EyeOff,
    Loader2,
    Mail,
    Phone,
    Settings,
    Lock,
    Shield,
    MapPin,
    Store,
    Save,
    Check,
    MessageSquare,
    Send,
    TrendingUp,
    Grid3x3,
    List,
    Ghost,
    AlertTriangle,
    AlertCircle,
    Camera,
    ScanLine
} from 'lucide-react'
import { SecurityCodeModal } from '../SecurityCodeModal'
import { AnnouncementBanner } from '../AnnouncementBanner'
import ScratchCard from '../ScratchCard'
import SpinWheelGame from '../SpinWheelGame'
import DailyQuizGame from '../DailyQuizGame'
import { extractTokenFromQRCode } from '@/utils/qrSecurity'
import { PointEarnedAnimation } from '@/components/animations/PointEarnedAnimation'
import { LuckyDrawSuccessAnimation } from '@/components/animations/LuckyDrawSuccessAnimation'
import { GenuineProductAnimation } from '@/components/animations/GenuineProductAnimation'
import { RewardRedemptionAnimation } from '@/components/animations/RewardRedemptionAnimation'
import { GiftClaimedAnimation } from '@/components/animations/GiftClaimedAnimation'
import { InsufficientPointsAnimation } from '@/components/animations/InsufficientPointsAnimation'
import { RegistrationCelebrationAnimation } from '@/components/animations/RegistrationCelebrationAnimation'
import { ShopLinkCelebrationAnimation } from '@/components/animations/ShopLinkCelebrationAnimation'
import dynamic from 'next/dynamic'

// Dynamically import QrScanner to avoid SSR issues
const QrScanner = dynamic(() => import('@/components/scanner/QrScanner'), { ssr: false })
import { validatePhoneNumber, normalizePhone, getStorageUrl, toTitleCaseWords } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import ForgotPasswordModal from '@/components/journey/ForgotPasswordModal'
import QrCollectionStatus from '@/components/journey/QrCollectionStatus'
import { ReferencePicker, type ReferenceUser } from '@/components/ui/reference-picker'
import { ShopPicker, type ShopResult } from '@/components/ui/shop-picker'
import { CreateShopDialog } from '@/components/shop-requests/CreateShopDialog'
import { hasValidLinkedShop, hasValidReferenceLink, resolveCollectProfileCompletion } from '@/lib/engagement/profile-completion'
import { INVALID_REFERENCE_WARNING_MESSAGE, INVALID_SHOP_WARNING_MESSAGE } from '@/lib/engagement/profile-link-validation'
import {
    getRegistrationPendingShopDisplayName,
    getRegistrationReferenceSelectionError,
    getRegistrationShopSelectionError,
    SIGNUP_CONFIRM_PASSWORD_REQUIRED_MESSAGE,
    SIGNUP_PASSWORD_MIN_LENGTH_MESSAGE,
    SIGNUP_PASSWORD_REQUIRED_MESSAGE,
    SIGNUP_PASSWORDS_DO_NOT_MATCH_MESSAGE,
    SIGNUP_PASSWORDS_MATCH_MESSAGE,
    type RegistrationPendingShopRequest,
    validateRegistrationLinkSelections,
    validateRegistrationPasswordFields,
} from '@/lib/engagement/registration-link-selection'
import { getRoadtourShopSurveyField, getRoadtourShopSurveyPrefillValues, type RoadtourShopSurveySource } from '@/lib/roadtour/survey'
import { EllbowBottomNavigation, EllbowLiveHome } from '@/components/journey/petfood/EllbowLiveExperience'

// Types
interface JourneyConfig {
    id?: string
    welcome_title: string
    welcome_message: string
    thank_you_message: string
    primary_color: string
    button_color: string
    points_enabled: boolean
    lucky_draw_enabled: boolean
    redemption_enabled: boolean
    require_security_code?: boolean
    // Per-feature security code bypass
    skip_security_code_for_points?: boolean
    skip_security_code_for_lucky_draw?: boolean
    skip_security_code_for_redemption?: boolean
    skip_security_code_for_scratch_card?: boolean
    show_product_image?: boolean
    product_image_source?: 'variant' | 'custom' | 'genuine_badge'
    custom_image_url?: string
    genuine_badge_style?: string
    variant_image_url?: string | null
    lucky_draw_image_url?: string | null
    lucky_draw_campaign_name?: string | null
    lucky_draw_prizes?: any[]
    enable_scratch_card_game?: boolean
    points_title?: string | null
    points_description?: string | null
    lucky_draw_title?: string
    lucky_draw_description?: string
    redemption_title?: string
    redemption_description?: string
    scratch_card_title?: string
    scratch_card_description?: string
    banner_config?: {
        enabled: boolean
        template: 'grid' | 'carousel'
        location?: 'home' | 'rewards' | 'products' | 'profile'
        items: Array<{
            id: string
            image_url: string
            link_to?: 'short_link' | 'page_rewards' | 'page_product' | 'page-contactus' | 'external_url' | 'no-link' | 'rewards' | 'products' | 'contact-us' | string
            external_url?: string
            expires_at?: string
            page?: 'home' | 'rewards' | 'products' | 'profile'
            is_active?: boolean
        }>
    }
}

interface RewardItem {
    id: string
    item_name: string
    item_description: string | null
    points_required: number
    point_offer?: number | null
    wallet_scope?: 'consumer' | 'shop' | null
    item_image_url: string | null
    additional_images?: string[]
    item_code: string
    stock_quantity: number | null
    is_active: boolean | null
}

interface ProductItem {
    id: string
    product_name: string
    product_description: string | null
    product_code: string
    brand_name?: string
    category_name?: string
    hide_price?: boolean
    primary_image_url?: string | null
    variants?: {
        id: string
        variant_name: string
        suggested_retail_price: number | null
        other_price?: number | null
        image_url?: string | null
    }[]
}

type TabType = 'home' | 'rewards' | 'scan' | 'products' | 'games' | 'profile' | 'account-settings' | 'lucky-draw' | 'play-scratch-card' | 'spin-wheel' | 'daily-quiz'

interface ProductInfo {
    product_name?: string
    variant_name?: string
    brand_name?: string
}

// Utility function to compress images before upload
async function compressImage(file: File, maxSize: number = 200, quality: number = 0.8): Promise<Blob> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = (e) => {
            const img = document.createElement('img')
            img.onload = () => {
                const canvas = document.createElement('canvas')
                let width = img.width
                let height = img.height

                // Calculate new dimensions maintaining aspect ratio
                if (width > height) {
                    if (width > maxSize) {
                        height = Math.round((height * maxSize) / width)
                        width = maxSize
                    }
                } else {
                    if (height > maxSize) {
                        width = Math.round((width * maxSize) / height)
                        height = maxSize
                    }
                }

                canvas.width = width
                canvas.height = height

                const ctx = canvas.getContext('2d')
                if (!ctx) {
                    reject(new Error('Could not get canvas context'))
                    return
                }

                ctx.drawImage(img, 0, 0, width, height)

                canvas.toBlob(
                    (blob) => {
                        if (blob) {
                            resolve(blob)
                        } else {
                            reject(new Error('Could not compress image'))
                        }
                    },
                    'image/jpeg',
                    quality
                )
            }
            img.onerror = () => reject(new Error('Could not load image'))
            img.src = e.target?.result as string
        }
        reader.onerror = () => reject(new Error('Could not read file'))
        reader.readAsDataURL(file)
    })
}

interface PremiumLoyaltyTemplateProps {
    config: JourneyConfig
    qrCode?: string
    orgId?: string
    isLive?: boolean
    consumerPhone?: string
    productInfo?: ProductInfo
    roadtourContext?: {
        token: string
        campaign_name: string
        account_manager_name: string
        default_points: number
        org_id: string
        qr_code_id?: string | null
        campaign_id?: string | null
        account_manager_user_id?: string | null
        reward_mode?: string | null
        survey_template_id?: string | null
        require_geolocation?: boolean
    }
    /**
     * Optional brand skin. 'pet_food' layers Ellbow branding (verified cat
     * hero, teal/pink wordmark) over the identical claim/points machinery.
     * Absent / 'premium' renders the existing Vape/Premium experience unchanged.
     */
    experienceTheme?: 'premium' | 'pet_food'
}

interface RoadtourSurveyField {
    id: string
    field_key: string
    label: string
    field_type: string
    options: string[] | null
    is_required: boolean
    sort_order: number
}

interface RoadtourMilestoneSummary {
    reward_status: 'pending' | 'completed' | 'awarded' | 'expired' | 'cancelled'
    current_valid_product_scan_count: number
    required_product_qr_scans: number
    remaining_product_qr_scans: number
    campaign_reward_points: number
}

interface RoadtourClaimResponse {
    code?: string
    message?: string
    error?: string
    requiresLogin?: boolean
    requiresConsumerConfirmation?: boolean
    requiresProfileUpdate?: boolean
    modalMessage?: string
    points_awarded?: number
    total_balance?: number
    balance_after?: number
    roadtour_reward_deferred?: boolean
    roadtour_milestone?: RoadtourMilestoneSummary | null
}

interface RoadtourProductQrProgressNotice {
    roadtour_milestone?: RoadtourMilestoneSummary | null
    roadtour_duplicate_product_qr?: boolean
    roadtour_milestone_awarded?: boolean
}

interface RoadtourProductQrProgressCopy {
    title: string
    description: string
    successNote: string | null
}

function normalizeRoadtourSurveyOptions(value: unknown) {
    if (!Array.isArray(value)) return null

    const normalized = value
        .map((option) => {
            if (typeof option === 'string') return option.trim()
            if (option && typeof option === 'object') {
                const label = typeof (option as any).label === 'string' ? (option as any).label.trim() : ''
                const rawValue = typeof (option as any).value === 'string' ? (option as any).value.trim() : ''
                return label || rawValue
            }
            return ''
        })
        .filter(Boolean)

    return normalized.length > 0 ? normalized : null
}

function mapRoadtourSurveyFieldRow(row: any): RoadtourSurveyField {
    return {
        id: row.id,
        field_key: row.field_key,
        label: row.field_label ?? row.label ?? '',
        field_type: row.field_type,
        options: normalizeRoadtourSurveyOptions(row.field_options ?? row.options),
        is_required: Boolean(row.is_required),
        sort_order: Number(row.sort_order || 0),
    }
}

// Variant Media Component for Animations
const VariantMedia = ({ variant, onClick }: { variant: any, onClick: (v: any) => void }) => {
    const videoRef = useRef<HTMLVideoElement>(null)
    const [videoError, setVideoError] = useState(false)

    useEffect(() => {
        // Reset error state when animation_url changes
        setVideoError(false)

        if (variant.animation_url && videoRef.current) {
            const video = videoRef.current
            video.muted = true

            // Try to play when video is ready - loop continuously
            const handleCanPlay = () => {
                const playPromise = video.play()
                if (playPromise !== undefined) {
                    playPromise.catch((err) => {
                        console.warn('Video autoplay failed:', err)
                    })
                }
            }

            video.addEventListener('canplay', handleCanPlay)

            // No timeout - let it loop continuously
            return () => {
                video.removeEventListener('canplay', handleCanPlay)
            }
        }
    }, [variant.animation_url])

    if (variant.animation_url && !videoError) {
        return (
            <div className="w-full h-full relative cursor-pointer" onClick={() => onClick(variant)}>
                <video
                    ref={videoRef}
                    src={getStorageUrl(variant.animation_url)}
                    className="w-full h-full object-cover"
                    muted
                    loop
                    playsInline
                    onError={() => setVideoError(true)}
                />
                <div className="absolute top-2 right-2 bg-black/40 rounded-full p-1.5 backdrop-blur-sm shadow-sm z-10">
                    <div className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
                </div>
            </div>
        )
    }

    if (variant.image_url) {
        return (
            <Image
                src={getStorageUrl(variant.image_url) || variant.image_url}
                alt={variant.variant_name}
                fill
                className="object-cover"
            />
        )
    }

    return (
        <div className="w-full h-full flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300"><path d="m7.5 4.27 9 5.15" /><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22v-10" /></svg>
        </div>
    )
}

type CollectPointsOptions = {
    preferredClaimLane?: 'shop'
    consumerConfirmation?: boolean
    skipProfileCheck?: boolean
    qrCodeOverride?: string
    resumeAfterProfileSave?: boolean
    shopIdOverride?: string
    shopPasswordOverride?: string
}

type CollectPointsResult = {
    success: boolean
    alreadyCollected?: boolean
    error?: string
    requiresProfileUpdate?: boolean
    requiresLogin?: boolean
}

type PendingCollectState = {
    intendedAction: 'collect_points'
    preferredClaimLane: 'shop'
    qrCode: string
    returnUrl: string
    startedAt: number
    email: string | null
}

const PENDING_COLLECT_STORAGE_KEY = 'serapod_pending_collect_v1'
const PENDING_COLLECT_MAX_AGE_MS = 15 * 60 * 1000

export default function PremiumLoyaltyTemplate({
    config,
    qrCode,
    orgId,
    isLive = false,
    consumerPhone,
    productInfo,
    roadtourContext,
    experienceTheme = 'premium'
}: PremiumLoyaltyTemplateProps) {
    const supabase = createClient()
    // Optional, additive brand skin. Defaults to 'premium' so the existing
    // Vape/Premium experience is rendered exactly as before. Only the Pet Food
    // shell passes 'pet_food' to layer Ellbow branding on top of the unchanged
    // claim/points/rewards machinery below.
    const isPetFoodTheme = experienceTheme === 'pet_food'
    const isRoadtourMode = Boolean(roadtourContext?.token)
    const hasLegacyProductQrContext = Boolean(qrCode) && !isRoadtourMode
    const { toast } = useToast()
    const [activeTab, setActiveTab] = useState<TabType>('home')
    const previousActiveTabRef = useRef<TabType>('home')
    const [showScanner, setShowScanner] = useState(false)

    // Scratch Card State
    const [scratchResult, setScratchResult] = useState<{ isWin: boolean, rewardName: string } | null>(null)
    const [isScratching, setIsScratching] = useState(false)
    const [scratchError, setScratchError] = useState<string | null>(null)
    const [scratchCardAlreadyPlayed, setScratchCardAlreadyPlayed] = useState(false)
    const [scratchCardPreviousReward, setScratchCardPreviousReward] = useState<string | null>(null)
    const [qrCodeDbId, setQrCodeDbId] = useState<string | null>(null)

    const [userPoints, setUserPoints] = useState(0)
    const [userName, setUserName] = useState('')
    const [userEmail, setUserEmail] = useState('')
    const [userAvatarUrl, setUserAvatarUrl] = useState<string | null>(null)
    const [isUploadingAvatar, setIsUploadingAvatar] = useState(false)
    const [shopName, setShopName] = useState('')
    const [rewards, setRewards] = useState<RewardItem[]>([])
    const [products, setProducts] = useState<ProductItem[]>([])
    const [selectedProduct, setSelectedProduct] = useState<ProductItem | null>(null)
    const [selectedRewardForDetail, setSelectedRewardForDetail] = useState<RewardItem | null>(null)
    const [currentRewardImageIndex, setCurrentRewardImageIndex] = useState(0)

    // Master Banner State
    const [masterBannerConfig, setMasterBannerConfig] = useState<any>(null)

    // Fetch master banner config
    useEffect(() => {
        if (orgId) {
            fetch(`/api/master-banner/${orgId}`)
                .then(res => res.json())
                .then(data => {
                    if (data.success && data.data) {
                        setMasterBannerConfig(data.data)
                    }
                })
                .catch(err => console.error('Error fetching master banner:', err))
        }
    }, [orgId])

    // Calculate next reward based on user points and available rewards
    const nextRewardInfo = useMemo(() => {
        if (!rewards || rewards.length === 0) {
            return { pointsAway: 100, rewardName: '', nextRewardPoints: 0 }
        }

        // Filter active rewards and sort by points required (ascending)
        const activeRewards = rewards
            .filter(r => r.is_active && (r.stock_quantity === null || r.stock_quantity > 0))
            .sort((a, b) => a.points_required - b.points_required)

        if (activeRewards.length === 0) {
            return { pointsAway: 100, rewardName: '', nextRewardPoints: 0 }
        }

        // Find the next reward that user can work towards (points_required > userPoints)
        const nextReward = activeRewards.find(r => r.points_required > userPoints)

        if (nextReward) {
            const pointsAway = nextReward.points_required - userPoints
            return {
                pointsAway,
                rewardName: nextReward.item_name,
                nextRewardPoints: nextReward.points_required
            }
        }

        // User has enough points for all rewards - show the highest one they can claim
        const highestReward = activeRewards[activeRewards.length - 1]
        return {
            pointsAway: 0,
            rewardName: highestReward.item_name,
            nextRewardPoints: highestReward.points_required
        }
    }, [rewards, userPoints])

    const fileInputRef = useRef<HTMLInputElement>(null)

    const handleAvatarClick = () => {
        if (isAuthenticated) {
            fileInputRef.current?.click()
        }
    }

    const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        try {
            if (!event.target.files || event.target.files.length === 0) {
                return
            }

            // Get user ID from state or auth
            let currentUserId = userId
            if (!currentUserId) {
                const { data: { user } } = await supabase.auth.getUser()
                if (user) currentUserId = user.id
            }

            if (!currentUserId) {
                toast({
                    title: "Error",
                    description: "You must be logged in to upload an avatar",
                    variant: "destructive"
                })
                return
            }

            const file = event.target.files[0]

            // Check file size - max 2MB before compression
            const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB
            if (file.size > MAX_FILE_SIZE) {
                toast({
                    title: "File too large",
                    description: "Please select an image smaller than 2MB",
                    variant: "destructive"
                })
                return
            }

            // Compress image before upload
            const compressedFile = await compressImage(file, 200, 0.8) // 200px, 80% quality

            const fileExt = 'jpg' // Always use jpg for compressed images
            const fileName = `${Math.random().toString(36).substring(2, 15)}_${Date.now()}.${fileExt}`
            const filePath = `${currentUserId}/${fileName}`

            setIsUploadingAvatar(true)

            // 1. Upload compressed image to Supabase Storage
            const { error: uploadError } = await supabase.storage
                .from('avatars')
                .upload(filePath, compressedFile, {
                    contentType: 'image/jpeg',
                    upsert: true
                })

            if (uploadError) {
                throw uploadError
            }

            // 2. Get Public URL
            const { data: { publicUrl } } = supabase.storage
                .from('avatars')
                .getPublicUrl(filePath)

            // 3. Update User Profile
            const { error: updateError } = await supabase
                .from('users')
                .update({ avatar_url: publicUrl })
                .eq('id', currentUserId)

            if (updateError) {
                throw updateError
            }

            // 4. Update Local State
            setUserAvatarUrl(publicUrl)
            toast({
                title: "Success",
                description: "Avatar updated successfully",
            })

        } catch (error: any) {
            console.error('Error uploading avatar:', error)
            toast({
                title: "Error",
                description: "Failed to upload avatar: " + error.message,
                variant: "destructive"
            })
        } finally {
            setIsUploadingAvatar(false)
            // Reset file input
            if (fileInputRef.current) {
                fileInputRef.current.value = ''
            }
        }
    }
    const [showRewardDetailModal, setShowRewardDetailModal] = useState(false)
    const [loadingRewards, setLoadingRewards] = useState(false)
    const [loadingProducts, setLoadingProducts] = useState(false)
    const [pointsCollected, setPointsCollected] = useState(false)
    const [qrPointsCollected, setQrPointsCollected] = useState(false) // From DB - persists across sessions
    const [pointsEarned, setPointsEarned] = useState(0)
    const [lastEarnedPoints, setLastEarnedPoints] = useState(0) // Persists after modal closes
    const [totalBalance, setTotalBalance] = useState(0)
    const [previousBalance, setPreviousBalance] = useState(0)
    const [luckyDrawEntered, setLuckyDrawEntered] = useState(false)
    const [luckyDrawQrUsed, setLuckyDrawQrUsed] = useState(false) // Track if QR already used for lucky draw
    const [checkingQrStatus, setCheckingQrStatus] = useState(true) // Start true to show loading
    const [selectedAnimation, setSelectedAnimation] = useState<string | null>(null)
    const [selectedVariantForDetail, setSelectedVariantForDetail] = useState<any>(null)

    // Control visibility of Free Gifts section in Rewards tab
    const [showFreeGifts, setShowFreeGifts] = useState(false)

    // Points collection modal states
    const [showPointsLoginModal, setShowPointsLoginModal] = useState(false)
    const [showShopPassword, setShowShopPassword] = useState(false)
    const [shopId, setShopId] = useState('')
    const [shopPassword, setShopPassword] = useState('')
    const [collectingPoints, setCollectingPoints] = useState(false)
    const [pointsError, setPointsError] = useState('')
    const [pointsErrorAction, setPointsErrorAction] = useState<'shop-profile-link' | 'roadtour-shop-only' | null>(null)
    const [pointsErrorTitle, setPointsErrorTitle] = useState('Complete Your Profile')
    const [showPointsSuccessModal, setShowPointsSuccessModal] = useState(false)
    const [showForgotPasswordModal, setShowForgotPasswordModal] = useState(false)
    const [forgotPasswordReturnTarget, setForgotPasswordReturnTarget] = useState<'profile' | 'collect'>('collect')
    const [collectPointsStep, setCollectPointsStep] = useState<'login' | 'complete-profile' | 'consumer-confirm' | 'roadtour-survey'>('login')
    const [pendingProfileCollectLane, setPendingProfileCollectLane] = useState<'shop' | null>(null)
    const [pendingProfileCollectEmail, setPendingProfileCollectEmail] = useState('')
    const [pendingCollectResumeError, setPendingCollectResumeError] = useState('')
    const [isShopRequestOpen, setIsShopRequestOpen] = useState(false)
    const [pendingShopRequestName, setPendingShopRequestName] = useState('')
    const [isSignUpShopRequestOpen, setIsSignUpShopRequestOpen] = useState(false)
    const [pendingSignUpShopRequestName, setPendingSignUpShopRequestName] = useState('')
    const [consumerClaimConfirmed, setConsumerClaimConfirmed] = useState(false)
    const [qrClaimMode, setQrClaimMode] = useState<'single_shop' | 'dual'>('single_shop')
    const [qrShopLaneCollected, setQrShopLaneCollected] = useState(false)
    const [qrConsumerLaneCollected, setQrConsumerLaneCollected] = useState(false)
    const [roadtourGeolocation, setRoadtourGeolocation] = useState<RoadtourLocationPayload | null>(null)
    const [roadtourSurveyFields, setRoadtourSurveyFields] = useState<RoadtourSurveyField[]>([])
    const [roadtourSurveyAnswers, setRoadtourSurveyAnswers] = useState<Record<string, string>>({})
    const [roadtourSurveyShopName, setRoadtourSurveyShopName] = useState('')
    const [roadtourSurveyLoading, setRoadtourSurveyLoading] = useState(false)
    const [roadtourMilestone, setRoadtourMilestone] = useState<RoadtourMilestoneSummary | null>(null)
    const [roadtourProductQrSuccessNote, setRoadtourProductQrSuccessNote] = useState<string | null>(null)

    // Auth states (for profile login)
    const [isAuthenticated, setIsAuthenticated] = useState(false)
    const [isShopUser, setIsShopUser] = useState(false)
    const [authLoading, setAuthLoading] = useState(true)

    // Ref to track if we're currently fetching profile (prevents duplicate fetches)
    const isFetchingProfileRef = useRef(false)
    const lastProfileFetchTimeRef = useRef(0)
    const lastProfileRefreshRef = useRef(0)

    // Game active states
    const [activeGames, setActiveGames] = useState({
        scratch: false,
        spin: false,
        quiz: false
    })

    useEffect(() => {
        if (config?.id) {
            checkActiveGames()
        }
    }, [config?.id])

    const checkActiveGames = async () => {
        if (!config?.id) return

        try {
            // Use API route to bypass RLS for public consumer access
            const response = await fetch(`/api/consumer/active-games?journey_config_id=${config.id}`)
            const result = await response.json()

            if (result.success) {
                setActiveGames({
                    scratch: result.activeGames?.scratch || false,
                    spin: result.activeGames?.spin || false,
                    quiz: result.activeGames?.quiz || false
                })
            } else {
                console.error('Error checking active games:', result.error)
            }
        } catch (error) {
            console.error('Error checking active games:', error)
        }
    }

    // Fetch banks
    useEffect(() => {
        const fetchBanks = async () => {
            const { data, error } = await supabase
                .from('msia_banks')
                .select('*')
                .eq('is_active', true)
                .order('short_name')

            if (data) {
                setBanks(data)
            }
        }

        fetchBanks()
    }, [])

    const [showLoginForm, setShowLoginForm] = useState(false)
    const [loginEmail, setLoginEmail] = useState('')
    const [loginPassword, setLoginPassword] = useState('')
    const [showPassword, setShowPassword] = useState(false)
    const [showConfirmPassword, setShowConfirmPassword] = useState(false)
    const [loginLoading, setLoginLoading] = useState(false)
    const [loginError, setLoginError] = useState('')
    const [emailError, setEmailError] = useState('')
    const [phoneError, setPhoneError] = useState('')
    const [isSignUp, setIsSignUp] = useState(false)
    const [signUpEmailStatus, setSignUpEmailStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle')
    const [signUpPhoneStatus, setSignUpPhoneStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle')
    const [showRegistrationOtpModal, setShowRegistrationOtpModal] = useState(false)
    const [registrationOtpCode, setRegistrationOtpCode] = useState('')
    const [registrationOtpError, setRegistrationOtpError] = useState('')
    const [registrationOtpLoading, setRegistrationOtpLoading] = useState(false)
    const [registrationOtpSending, setRegistrationOtpSending] = useState(false)
    const [, setRegistrationVerificationToken] = useState('')
    const [registrationResendCooldown, setRegistrationResendCooldown] = useState(0)
    const [registrationOtpRequested, setRegistrationOtpRequested] = useState(false)
    const [registrationCreatingAccount, setRegistrationCreatingAccount] = useState(false)

    // Signup states
    const [signUpName, setSignUpName] = useState('')
    const [signUpPhone, setSignUpPhone] = useState('')
    const [signUpConfirmPassword, setSignUpConfirmPassword] = useState('')
    // New Signup Fields
    const [signUpReference, setSignUpReference] = useState('')
    const [signUpShopName, setSignUpShopName] = useState('')
    const [signUpReferenceUserId, setSignUpReferenceUserId] = useState<string | null>(null)
    const [signUpShopOrganizationId, setSignUpShopOrganizationId] = useState<string | null>(null)
    const [signUpPendingShopRequest, setSignUpPendingShopRequest] = useState<RegistrationPendingShopRequest | null>(null)
    const [signUpReferenceError, setSignUpReferenceError] = useState('')
    const [signUpShopError, setSignUpShopError] = useState('')
    const [signUpPasswordError, setSignUpPasswordError] = useState('')
    const [signUpConfirmPasswordError, setSignUpConfirmPasswordError] = useState('')
    const [signUpPasswordSuccess, setSignUpPasswordSuccess] = useState('')
    const [signUpReferenceTouched, setSignUpReferenceTouched] = useState(false)
    const [signUpShopTouched, setSignUpShopTouched] = useState(false)
    const [signUpPasswordTouched, setSignUpPasswordTouched] = useState(false)
    const [signUpConfirmPasswordTouched, setSignUpConfirmPasswordTouched] = useState(false)
    const [signUpValidationAttempted, setSignUpValidationAttempted] = useState(false)

    // Security modal states
    const [showSecurityModal, setShowSecurityModal] = useState(false)
    const [securityVerified, setSecurityVerified] = useState(false)
    const [pendingAction, setPendingAction] = useState<string | null>(null)

    // Form states for lucky draw
    const [customerName, setCustomerName] = useState('')
    const [customerPhone, setCustomerPhone] = useState('')
    const [customerEmail, setCustomerEmail] = useState('')
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [showLuckyDrawSuccess, setShowLuckyDrawSuccess] = useState(false)
    const [luckyDrawError, setLuckyDrawError] = useState('')
    const [luckyDrawPhoneError, setLuckyDrawPhoneError] = useState('')
    const [luckyDrawEmailError, setLuckyDrawEmailError] = useState('')

    // Account settings states
    const [userPhone, setUserPhone] = useState('')
    const [userReferralPhone, setUserReferralPhone] = useState('')
    const [userReferenceUserId, setUserReferenceUserId] = useState<string | null>(null)
    const [userId, setUserId] = useState<string | null>(null)
    const [editingName, setEditingName] = useState(false)
    const [editingPhone, setEditingPhone] = useState(false)
    const [editingReferralPhone, setEditingReferralPhone] = useState(false)

    // Bank details state
    const [bankDetails, setBankDetails] = useState<{
        bankId: string | null
        bankName: string | null
        accountNumber: string | null
        holderName: string | null
    }>({ bankId: null, bankName: null, accountNumber: null, holderName: null })
    const [showBankDetailsModal, setShowBankDetailsModal] = useState(false)
    const [newName, setNewName] = useState('')
    const [newPhone, setNewPhone] = useState('')
    const [newReferralPhone, setNewReferralPhone] = useState('')
    const [newReferenceUserId, setNewReferenceUserId] = useState<string | null>(null)
    const [userReferenceDisplayName, setUserReferenceDisplayName] = useState('')
    const [referralName, setReferralName] = useState('')
    const [referralCheckStatus, setReferralCheckStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
    const [invalidReference, setInvalidReference] = useState(false)
    const [invalidShop, setInvalidShop] = useState(false)
    const [profileIncomplete, setProfileIncomplete] = useState(false)
    const [profileIncompleteMessage, setProfileIncompleteMessage] = useState('')
    const [savingProfile, setSavingProfile] = useState(false)
    const [profileSaveError, setProfileSaveError] = useState('')
    const [profileSaveSuccess, setProfileSaveSuccess] = useState(false)
    const [profileSaveNotice, setProfileSaveNotice] = useState('')

    // Bank Account states
    const [banks, setBanks] = useState<any[]>([])
    const [bankId, setBankId] = useState('')
    const [bankAccountNumber, setBankAccountNumber] = useState('')
    const [bankAccountHolderName, setBankAccountHolderName] = useState('')
    const [showBankInfo, setShowBankInfo] = useState(false)
    const [bankError, setBankError] = useState('')

    // Address states
    const [userAddress, setUserAddress] = useState('')
    const [editingAddress, setEditingAddress] = useState(false)
    const [newAddress, setNewAddress] = useState('')

    // Shop Name states
    const [userShopName, setUserShopName] = useState('')
    const [editingShopName, setEditingShopName] = useState(false)
    const [newShopName, setNewShopName] = useState('')
    const [userLinkedOrganizationId, setUserLinkedOrganizationId] = useState<string | null>(null)
    const [newLinkedOrganizationId, setNewLinkedOrganizationId] = useState<string | null>(null)

    // Password change states
    const [showChangePassword, setShowChangePassword] = useState(false)
    const [currentPassword, setCurrentPassword] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [showCurrentPassword, setShowCurrentPassword] = useState(false)
    const [showNewPassword, setShowNewPassword] = useState(false)
    const [showChangeConfirmPassword, setShowChangeConfirmPassword] = useState(false)
    const [changingPassword, setChangingPassword] = useState(false)
    const [passwordError, setPasswordError] = useState('')
    const [passwordSuccess, setPasswordSuccess] = useState(false)
    const [showProfileInfo, setShowProfileInfo] = useState(false)

    const signUpEmailInputRef = useRef<HTMLInputElement>(null)
    const signUpNameInputRef = useRef<HTMLInputElement>(null)
    const signUpPhoneInputRef = useRef<HTMLInputElement>(null)
    const signUpReferenceInputRef = useRef<HTMLInputElement>(null)
    const signUpShopInputRef = useRef<HTMLInputElement>(null)
    const signUpPasswordInputRef = useRef<HTMLInputElement>(null)
    const signUpConfirmPasswordInputRef = useRef<HTMLInputElement>(null)

    const shouldRequestRoadtourGeolocation = Boolean(roadtourContext?.require_geolocation)
    const signUpEmailValue = loginEmail.replace(/\s/g, '')
    const signUpEmailFormatValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signUpEmailValue)
    const signUpPhoneValidation = validatePhoneNumber(signUpPhone)
    const signUpPasswordValidation = useMemo(
        () => validateRegistrationPasswordFields(loginPassword, signUpConfirmPassword),
        [loginPassword, signUpConfirmPassword],
    )

    const getRoadtourProfileIncompleteMessage = (name?: string | null) => {
        const resolvedName = (name || userName || 'there').trim()
        return `Hi ${resolvedName}, your **shop** and **reference** are not valid. Please update your profile before collecting points.`
    }

    const withUserGreeting = (message?: string | null, name?: string | null) => {
        const resolvedName = (name || userName || 'there').trim()
        const baseMessage = (message || "You're not linked to any shop yet. Continue collecting points as a consumer?").trim()

        if (!baseMessage) {
            return `Hi ${resolvedName}, please review your claim type before continuing.`
        }

        if (/^hi\s/i.test(baseMessage)) {
            return baseMessage
        }

        return `Hi ${resolvedName}, ${baseMessage.charAt(0).toLowerCase()}${baseMessage.slice(1)}`
    }

    const readPendingCollectState = (): PendingCollectState | null => {
        if (typeof window === 'undefined') return null

        try {
            const rawState = sessionStorage.getItem(PENDING_COLLECT_STORAGE_KEY)
            if (!rawState) return null

            const parsed = JSON.parse(rawState) as Partial<PendingCollectState>
            const isValidState = parsed?.intendedAction === 'collect_points'
                && parsed?.preferredClaimLane === 'shop'
                && typeof parsed?.qrCode === 'string'
                && parsed.qrCode.trim().length > 0
                && typeof parsed?.returnUrl === 'string'
                && typeof parsed?.startedAt === 'number'

            if (!isValidState) {
                sessionStorage.removeItem(PENDING_COLLECT_STORAGE_KEY)
                return null
            }

            if ((Date.now() - parsed.startedAt) > PENDING_COLLECT_MAX_AGE_MS) {
                sessionStorage.removeItem(PENDING_COLLECT_STORAGE_KEY)
                return null
            }

            return {
                intendedAction: 'collect_points',
                preferredClaimLane: 'shop',
                qrCode: parsed.qrCode,
                returnUrl: parsed.returnUrl,
                startedAt: parsed.startedAt,
                email: typeof parsed.email === 'string' && parsed.email.trim().length > 0 ? parsed.email : null,
            }
        } catch (error) {
            console.warn('Unable to read pending collect state:', error)
            sessionStorage.removeItem(PENDING_COLLECT_STORAGE_KEY)
            return null
        }
    }

    const persistPendingCollectState = (overrides: { email?: string | null } = {}) => {
        if (typeof window === 'undefined' || !qrCode) return

        const nextState: PendingCollectState = {
            intendedAction: 'collect_points',
            preferredClaimLane: 'shop',
            qrCode,
            returnUrl: window.location.href,
            startedAt: Date.now(),
            email: overrides.email !== undefined
                ? (overrides.email?.trim() || null)
                : ((pendingProfileCollectEmail || userEmail || '').trim() || null),
        }

        sessionStorage.setItem(PENDING_COLLECT_STORAGE_KEY, JSON.stringify(nextState))
    }

    const clearPendingCollectStorage = () => {
        if (typeof window === 'undefined') return
        sessionStorage.removeItem(PENDING_COLLECT_STORAGE_KEY)
    }

    const resetPendingCollectFlowState = () => {
        clearPendingCollectStorage()
        setPendingProfileCollectLane(null)
        setPendingProfileCollectEmail('')
        setPendingCollectResumeError('')
    }

    const closeCollectPointsModal = () => {
        setShowPointsLoginModal(false)
        setPointsError('')
        setPointsErrorTitle('')
        setPointsErrorAction(null)
        setRoadtourSurveyFields([])
        setRoadtourSurveyAnswers({})
        setRoadtourSurveyShopName('')
        setRoadtourSurveyLoading(false)
        resetPendingCollectFlowState()
        setCollectPointsStep('login')
    }

    const resolveRoadtourGeolocation = async (forcePrompt = false) => {
        if (!roadtourContext || !shouldRequestRoadtourGeolocation) return null
        if (roadtourGeolocation && !forcePrompt) return roadtourGeolocation

        const nextLocation = await captureRoadtourGeolocation({
            forcePrompt,
            previousLocation: roadtourGeolocation,
        })
        setRoadtourGeolocation(nextLocation)
        return nextLocation
    }

    useEffect(() => {
        setRoadtourGeolocation(null)
    }, [roadtourContext?.token])

    useEffect(() => {
        setRoadtourSurveyFields([])
        setRoadtourSurveyAnswers({})
        setRoadtourSurveyShopName('')
        setRoadtourSurveyLoading(false)
        setRoadtourMilestone(null)
        setRoadtourProductQrSuccessNote(null)
    }, [roadtourContext?.token])

    function formatCountLabel(value: number, noun: string) {
        return `${value} ${noun}${value === 1 ? '' : 's'}`
    }

    function buildRoadtourProductQrProgressCopy(data: RoadtourProductQrProgressNotice): RoadtourProductQrProgressCopy | null {
        const milestone = data.roadtour_milestone
        if (!milestone) return null

        const rewardPointsLabel = `${milestone.campaign_reward_points} additional point${milestone.campaign_reward_points === 1 ? '' : 's'}`
        const remainingScanLabel = formatCountLabel(milestone.remaining_product_qr_scans, 'more Product QR scan')

        if (data.roadtour_milestone_awarded || milestone.reward_status === 'awarded') {
            const completionMessage = `Congratulations. You have completed the RoadTour requirement and ${rewardPointsLabel} have been added to your wallet.`
            return {
                title: 'RoadTour bonus unlocked',
                description: completionMessage,
                successNote: completionMessage,
            }
        }

        if (data.roadtour_duplicate_product_qr) {
            return {
                title: 'RoadTour QR already counted',
                description: `This Product QR was already counted. Your RoadTour progress remains ${milestone.current_valid_product_scan_count}/${milestone.required_product_qr_scans}.`,
                successNote: null,
            }
        }

        return {
            title: 'RoadTour bonus in progress',
            description: `${milestone.current_valid_product_scan_count}/${milestone.required_product_qr_scans} Product QR scans counted. Scan ${remainingScanLabel} to unlock ${rewardPointsLabel}.`,
            successNote: `RoadTour bonus in progress. Scan ${remainingScanLabel} and we will add ${rewardPointsLabel} after you complete this requirement.`,
        }
    }

    function showRoadtourProductQrProgressNotice(data: RoadtourProductQrProgressNotice) {
        const progressCopy = buildRoadtourProductQrProgressCopy(data)
        if (!progressCopy) return

        toast({ title: progressCopy.title, description: progressCopy.description })
    }

    const loadRoadtourSurveyTemplate = async (templateId: string) => {
        setRoadtourSurveyLoading(true)

        try {
            const { data, error } = await (supabase as any)
                .from('roadtour_survey_template_fields')
                .select('id, field_key, field_label, field_type, field_options, is_required, sort_order')
                .eq('template_id', templateId)
                .order('sort_order')

            if (error) throw error

            const nextFields = (data || []).map(mapRoadtourSurveyFieldRow)
            const nextAnswers: Record<string, string> = {}
            let linkedShopName = ''

            if (userLinkedOrganizationId) {
                const { data: linkedShop } = await (supabase as any)
                    .from('organizations')
                    .select('org_name, hot_flavour_brands, sells_serapod_flavour, sells_sbox, sells_sbox_special_edition')
                    .eq('id', userLinkedOrganizationId)
                    .maybeSingle()

                if (linkedShop) {
                    linkedShopName = linkedShop.org_name || ''
                    const prefillValues = getRoadtourShopSurveyPrefillValues(linkedShop as RoadtourShopSurveySource)

                    for (const field of nextFields) {
                        const prefillValue = prefillValues[field.field_key]
                        if (!prefillValue) continue
                        nextAnswers[field.field_key] = prefillValue
                    }
                }
            }

            setRoadtourSurveyFields(nextFields)
            setRoadtourSurveyAnswers(nextAnswers)
            setRoadtourSurveyShopName(linkedShopName)

            return nextFields
        } finally {
            setRoadtourSurveyLoading(false)
        }
    }

    const openRoadtourSurveyPrompt = async (message?: string) => {
        if (!roadtourContext?.survey_template_id) {
            setPointsError(message || 'Please complete the survey to claim your reward.')
            setShowPointsLoginModal(true)
            return
        }

        await loadRoadtourSurveyTemplate(roadtourContext.survey_template_id)
        setCollectingPoints(false)
        setPointsError(message || '')
        setPointsErrorTitle('Quick Survey')
        setPointsErrorAction(null)
        setCollectPointsStep('roadtour-survey')
        setShowPointsLoginModal(true)
    }

    const submitRoadtourSurveyClaim = async () => {
        const missingFields = roadtourSurveyFields.filter((field) => field.is_required && !roadtourSurveyAnswers[field.field_key]?.trim())
        if (missingFields.length > 0) {
            setPointsError(`Please fill in: ${missingFields.map((field) => field.label).join(', ')}`)
            return
        }

        if (isAuthenticated) {
            await handleRoadtourClaimWithSession({ surveyAnswers: roadtourSurveyAnswers })
            return
        }

        await handleRoadtourClaimWithLogin({ surveyAnswers: roadtourSurveyAnswers })
    }

    useEffect(() => {
        const previousTab = previousActiveTabRef.current
        const hasPersistedPendingCollect = typeof window !== 'undefined'
            && Boolean(sessionStorage.getItem(PENDING_COLLECT_STORAGE_KEY))
        if (
            previousTab === 'account-settings'
            && activeTab !== 'account-settings'
            && (pendingProfileCollectLane === 'shop' || hasPersistedPendingCollect)
            && !savingProfile
            && !collectingPoints
        ) {
            resetPendingCollectFlowState()
        }
        previousActiveTabRef.current = activeTab
    }, [activeTab, pendingProfileCollectLane, savingProfile, collectingPoints])

    useEffect(() => {
        if (!roadtourContext || !shouldRequestRoadtourGeolocation) return

        void (async () => {
            const nextLocation = await captureRoadtourGeolocation({
                forcePrompt: false,
                previousLocation: roadtourGeolocation,
            })
            setRoadtourGeolocation(nextLocation)
        })()
    }, [roadtourContext, roadtourContext?.token, shouldRequestRoadtourGeolocation])

    // Genuine product verified animation state
    const [showGenuineVerified, setShowGenuineVerified] = useState(false)

    // Registration celebration animation state
    const [showRegistrationCelebration, setShowRegistrationCelebration] = useState(false)
    const [registrationBonusInfo, setRegistrationBonusInfo] = useState<{ points: number; awarded: boolean; mode: string | null }>({ points: 0, awarded: false, mode: null })
    const [showShopLinkCelebration, setShowShopLinkCelebration] = useState(false)
    const [shopLinkCelebrationName, setShopLinkCelebrationName] = useState('')
    const genuineAnimationKeyRef = useRef<string | null>(null)

    // Points animation state
    const [showPointsAnimation, setShowPointsAnimation] = useState(false)
    const [displayPoints, setDisplayPoints] = useState(0)

    // Animate points counter
    useEffect(() => {
        if (showPointsAnimation) {
            let start = 0
            const end = userPoints
            const duration = 2000
            const startTime = Date.now()

            const animate = () => {
                const now = Date.now()
                const progress = Math.min((now - startTime) / duration, 1)
                const easeOutQuart = 1 - Math.pow(1 - progress, 4)

                setDisplayPoints(Math.floor(start + (end - start) * easeOutQuart))

                if (progress < 1) {
                    requestAnimationFrame(animate)
                }
            }

            requestAnimationFrame(animate)
        } else {
            setDisplayPoints(0)
        }
    }, [showPointsAnimation, userPoints])

    // Reward redemption states
    const [selectedReward, setSelectedReward] = useState<RewardItem | null>(null)
    const [showRedeemConfirm, setShowRedeemConfirm] = useState(false)
    const [redeeming, setRedeeming] = useState(false)
    // One idempotency key per confirmation: a retry of the same confirmation
    // returns the original result instead of redeeming twice.
    const redeemRequestKeyRef = useRef<string | null>(null)
    const [redeemError, setRedeemError] = useState('')
    const [showRedeemSuccess, setShowRedeemSuccess] = useState(false)
    const [redemptionDetails, setRedemptionDetails] = useState<{
        rewardName: string
        pointsDeducted: number
        pointsEarned?: number
        newBalance: number
        redemptionCode: string
        isBonusPoints?: boolean
        bonusMessage?: string
        encourageMessage?: string
    } | null>(null)
    // Track last redeemed reward for Recent Activity display
    const [lastRedeemedReward, setLastRedeemedReward] = useState<{
        rewardName: string
        pointsDeducted: number
    } | null>(null)

    const [showInsufficientPoints, setShowInsufficientPoints] = useState(false)
    const [insufficientPointsData, setInsufficientPointsData] = useState<{ needed: number, available: number } | null>(null)

    // Rewards tab category states
    type RewardCategoryType = 'All' | 'Scanned' | 'Point History' | 'History'
    const [rewardCategory, setRewardCategory] = useState<RewardCategoryType>('All')
    const [redemptionHistory, setRedemptionHistory] = useState<any[]>([])
    const [pointsHistory, setPointsHistory] = useState<any[]>([])
    const [scannedProducts, setScannedProducts] = useState<any[]>([])
    const [loadingRedemptionHistory, setLoadingRedemptionHistory] = useState(false)
    const [loadingPointsHistory, setLoadingPointsHistory] = useState(false)
    const [loadingScannedProducts, setLoadingScannedProducts] = useState(false)

    // Pagination states
    const [redemptionPage, setRedemptionPage] = useState(1)
    const [pointsPage, setPointsPage] = useState(1)
    const [scannedPage, setScannedPage] = useState(1)
    const [scannedViewMode, setScannedViewMode] = useState<'grid' | 'list'>('list')
    const itemsPerPage = 10

    // Feedback states
    const [showFeedbackModal, setShowFeedbackModal] = useState(false)
    const [feedbackTitle, setFeedbackTitle] = useState('')
    const [feedbackMessage, setFeedbackMessage] = useState('')
    const [submittingFeedback, setSubmittingFeedback] = useState(false)
    const [feedbackError, setFeedbackError] = useState('')
    const [feedbackSuccess, setFeedbackSuccess] = useState(false)
    const [unreadMessageCount, setUnreadMessageCount] = useState(0)

    // Free Gift Redemption states
    interface FreeGift {
        id: string
        gift_name: string
        gift_description: string | null
        gift_image_url: string | null
        total_quantity: number
        claimed_quantity: number
    }
    const [freeGifts, setFreeGifts] = useState<FreeGift[]>([])
    const [loadingFreeGifts, setLoadingFreeGifts] = useState(false)
    const [giftRedeemed, setGiftRedeemed] = useState(false)
    const [giftQrUsed, setGiftQrUsed] = useState(false)
    const [selectedGift, setSelectedGift] = useState<FreeGift | null>(null)
    const [showGiftConfirm, setShowGiftConfirm] = useState(false)
    const [claimingGift, setClaimingGift] = useState(false)
    const [giftError, setGiftError] = useState('')
    const [showGiftSuccess, setShowGiftSuccess] = useState(false)
    const [claimedGiftName, setClaimedGiftName] = useState('')

    // Helper function to check if user is from SHOP organization (uses API to bypass RLS)
    const checkUserOrganization = async (userId: string, force: boolean = false) => {
        // Prevent duplicate simultaneous fetches unless forced
        if (!force && isFetchingProfileRef.current) {
            console.log('🔐 Profile fetch already in progress, skipping...')
            return { success: false, isShop: false, fullName: '', organizationId: null, avatarUrl: null, orgName: '', phone: '', pointsBalance: 0, duplicate: true }
        }

        // Prevent duplicate fetches if fetched recently (within 2 seconds)
        if (!force && Date.now() - lastProfileFetchTimeRef.current < 2000) {
            console.log('🔐 Profile fetched recently, skipping...')
            return { success: false, isShop: false, fullName: '', organizationId: null, avatarUrl: null, orgName: '', phone: '', pointsBalance: 0, duplicate: true }
        }

        isFetchingProfileRef.current = true

        try {
            console.log('🔐 checkUserOrganization - Starting for userId:', userId)

            // Get current session to pass token
            const { data: { session }, error: sessionError } = await supabase.auth.getSession()
            if (sessionError || !session || !session.access_token) {
                console.error('🔐 Session missing/invalid:', sessionError)
                // Treat missing session as invalid so caller can clear state
                return { isShop: false, fullName: '', organizationId: null, avatarUrl: null, orgName: '', phone: '', pointsBalance: 0, sessionInvalid: true }
            }
            const token = session.access_token
            console.log('🔐 Got session token:', !!token)

            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 15000) // 15s timeout

            // Use API endpoint to fetch profile (bypasses RLS issues)
            const response = await fetch('/api/user/profile', {
                headers: {
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                    'Content-Type': 'application/json'
                },
                credentials: 'include', // Important: include cookies for auth
                signal: controller.signal
            }).finally(() => clearTimeout(timeoutId))

            console.log('🔐 Profile API response status:', response.status)

            // Handle 401 - session is invalid/expired
            if (response.status === 401) {
                console.log('🔐 Session expired/invalid (401), clearing auth and browser storage...')

                // Clear browser storage to remove stale session data
                if (typeof window !== 'undefined') {
                    const localKeys = Object.keys(localStorage)
                    localKeys.forEach(key => {
                        if (key.includes('supabase') || key.includes('sb-')) {
                            localStorage.removeItem(key)
                        }
                    })
                    const sessionKeys = Object.keys(sessionStorage)
                    sessionKeys.forEach(key => {
                        if (key.includes('supabase') || key.includes('sb-')) {
                            sessionStorage.removeItem(key)
                        }
                    })
                }

                await supabase.auth.signOut({ scope: 'local' })
                return { success: false, isShop: false, fullName: '', organizationId: null, avatarUrl: null, orgName: '', phone: '', pointsBalance: 0, sessionInvalid: true }
            }

            const result = await response.json()
            console.log('🔐 Profile API result:', result)

            if (!result.success || !result.profile) {
                console.error('🔐 Error fetching user profile via API:', result.error)
                return { success: false, isShop: false, fullName: '', organizationId: null, avatarUrl: null, orgName: '', phone: '', pointsBalance: 0 }
            }

            const profile = result.profile
            console.log('🔐 User profile fetched via API:', {
                fullName: profile.fullName,
                avatarUrl: profile.avatarUrl,
                phone: profile.phone,
                organizationId: profile.organizationId,
                isShop: profile.isShop,
                orgName: profile.orgName,
                pointsBalance: profile.pointsBalance
            })

            // Update last fetch time
            lastProfileFetchTimeRef.current = Date.now()

            return {
                success: true,
                isShop: profile.isShop === true, // Explicit boolean conversion
                fullName: profile.fullName || '',
                organizationId: profile.organizationId,
                avatarUrl: profile.avatarUrl,
                orgName: profile.orgName || '',
                phone: profile.phone || '',
                address: profile.address || '',
                shop_name: profile.shop_name || '',
                referenceDisplayName: profile.referenceDisplayName || '',
                pointsBalance: profile.pointsBalance || 0,
                bankId: profile.bankId || '',
                bankName: profile.bankName || '',
                bankAccountNumber: profile.bankAccountNumber || '',
                bankAccountHolderName: profile.bankAccountHolderName || '',
                referralPhone: profile.referralPhone || '',
                referenceUserId: profile.referenceUserId || null,
                consumerClaimConfirmedAt: profile.consumerClaimConfirmedAt || null,
                invalidReference: profile.invalidReference === true,
                invalidShop: profile.invalidShop === true,
                isReferenceValid: profile.isReferenceValid === true,
                isShopValid: profile.isShopValid === true,
                profileIncomplete: profile.profileIncomplete === true,
                profileIncompleteMessage: profile.profileIncompleteMessage || '',
            }
        } catch (error) {
            console.error('🔐 Error checking user organization:', error)
            return { success: false, isShop: false, fullName: '', organizationId: null, avatarUrl: null, orgName: '', phone: '', pointsBalance: 0 }
        } finally {
            isFetchingProfileRef.current = false
        }
    }

    // Ref to track if initial auth check completed (prevents double profile fetch)
    const initialAuthCheckDoneRef = useRef(false)

    // Check auth status on mount
    useEffect(() => {
        // IMPORTANT: Mark that auth check is starting immediately
        // This prevents onAuthStateChange from running before initial check is done
        const isInitialCheck = !initialAuthCheckDoneRef.current
        if (isInitialCheck) {
            console.log('🔐 Starting initial auth check - blocking onAuthStateChange')
        }

        const checkAuth = async () => {
            // Set a timeout to ensure authLoading becomes false even if API hangs
            const authTimeout = setTimeout(() => {
                console.log('🔐 Auth check timeout - forcing authLoading to false')
                setAuthLoading(false)
                initialAuthCheckDoneRef.current = true
            }, 5000) // 5 second timeout

            try {
                console.log('🔐 Checking auth status...')

                // Check for active session marker in sessionStorage
                const activeSessionMarker = sessionStorage.getItem('serapod_active_session')

                // If user has logged in during this browser session, preserve their session
                if (activeSessionMarker === 'logged_in') {
                    console.log('🔐 Active session marker found - user previously logged in this session')
                    // Continue to validate the session below
                } else if (!activeSessionMarker) {
                    // No session marker - this could be a fresh scan or returning user
                    // Don't clear sessions immediately - check if there's a valid session first
                    console.log('🔐 No session marker - checking for existing valid session')
                    sessionStorage.setItem('serapod_active_session', 'checked')
                }

                // Validate session with server using getUser()
                const { data: userData, error: getUserError } = await supabase.auth.getUser()
                let user = userData?.user || null
                let authError = getUserError || null

                console.log('🔐 getUser result:', user?.id, user?.email, 'Error:', authError?.message)

                // If getUser fails with auth error or no user, user is not authenticated
                if (authError || !user) {
                    console.log('🔐 No valid session found')
                    setIsAuthenticated(false)
                    setIsShopUser(false)
                    setUserEmail('')
                    setUserName('')
                    setUserPoints(0)
                    setUserAvatarUrl(null)
                    setShopName('')
                    setUserPhone('')
                    setUserId(null)
                    clearTimeout(authTimeout)
                    setAuthLoading(false)
                    initialAuthCheckDoneRef.current = true
                    return
                }

                // User exists and is valid - they are authenticated!
                console.log('🔐 User session validated with server')
                setIsAuthenticated(true)
                setUserEmail(user.email || '')
                setUserId(user.id)
                setUserName(user.user_metadata?.full_name || user.email?.split('@')[0] || 'User')

                // Mark session as logged in so it persists across QR scans
                sessionStorage.setItem('serapod_active_session', 'logged_in')

                // Fetch profile data
                console.log('🔐 User found, fetching profile data...')

                try {
                    const profileResult = await checkUserOrganization(user.id)
                    const { success, isShop, fullName, organizationId, avatarUrl, orgName, phone, referralPhone, referenceUserId, address, referenceDisplayName, pointsBalance, sessionInvalid, bankId, bankAccountNumber, bankAccountHolderName, consumerClaimConfirmedAt, invalidReference, invalidShop, profileIncomplete: _profileIncomplete, profileIncompleteMessage: _profileIncompleteMessage } = profileResult as any

                    if (sessionInvalid) {
                        console.log('🔐 Session was invalid, clearing auth state')
                        await supabase.auth.signOut()
                        setIsAuthenticated(false)
                        setIsShopUser(false)
                        setUserEmail('')
                        setUserName('')
                        setUserPoints(0)
                        setUserAvatarUrl(null)
                        setShopName('')
                        setUserPhone('')
                        setConsumerClaimConfirmed(false)
                        setUserId(null)
                        initialAuthCheckDoneRef.current = true
                        return
                    }

                    if (success) {
                        console.log('🔐 Profile data received:', { isShop, fullName, avatarUrl, orgName, phone, pointsBalance })
                        setIsShopUser(isShop)
                        setUserName(fullName || user.user_metadata?.full_name || user.email?.split('@')[0] || '')
                        // Only update avatar if we have a new one or explicitly null (prevents flicker)
                        if (avatarUrl !== undefined) setUserAvatarUrl(avatarUrl)
                        setShopName(orgName)
                        setUserLinkedOrganizationId(organizationId || null)
                        setNewLinkedOrganizationId(organizationId || null)
                        setUserPhone(phone)
                        setUserReferralPhone(referralPhone || '')
                        setUserReferenceUserId(referenceUserId || null)
                        setUserReferenceDisplayName(referenceDisplayName || '')
                        setInvalidReference(invalidReference === true)
                        setInvalidShop(invalidShop === true)
                        setNewName(fullName || user.user_metadata?.full_name || user.email?.split('@')[0] || '')
                        setNewPhone(phone)
                        setNewReferralPhone(referralPhone || '')
                        setNewReferenceUserId(referenceUserId || null)
                        setConsumerClaimConfirmed(Boolean(consumerClaimConfirmedAt))

                        // Set points and bank details for ALL users (Shop and Independent)
                        console.log('🔐 Setting user points balance:', pointsBalance)
                        setUserPoints(pointsBalance)
                        // Set bank details
                        setBankId(bankId || '')
                        setBankAccountNumber(bankAccountNumber || '')
                        setBankAccountHolderName(bankAccountHolderName || '')
                        // Set address
                        setUserAddress(address || '')
                        setNewAddress(address || '')
                        setUserShopName(organizationId ? (orgName || '') : '')
                        setNewShopName(organizationId ? (orgName || '') : '')

                        // Profile completeness check — show proactive modal
                        setProfileIncomplete(_profileIncomplete === true)
                        setProfileIncompleteMessage(_profileIncompleteMessage || '')
                        if (_profileIncomplete) {
                            console.log('🔐 Profile incomplete — showing proactive modal')
                            openCollectPointsProfilePrompt({
                                modalTitle: 'Complete Your Profile',
                                modalMessage: _profileIncompleteMessage,
                                error: _profileIncompleteMessage,
                            })
                        }
                    } else {
                        console.warn('🔐 Profile fetch failed, using basic info')
                        setUserName(user.user_metadata?.full_name || user.email?.split('@')[0] || 'User')
                        setIsShopUser(false)
                    }
                } catch (profileError) {
                    console.error('🔐 Profile fetch error:', profileError)
                    setUserName(user.user_metadata?.full_name || user.email?.split('@')[0] || 'User')
                    setIsShopUser(false)
                }
            } catch (error) {
                console.error('Auth check error:', error)
            } finally {
                clearTimeout(authTimeout)
                setAuthLoading(false)
                initialAuthCheckDoneRef.current = true
                console.log('🔐 Initial auth check completed - onAuthStateChange now active')
            }
        }

        // Run initial auth check first
        checkAuth()

        // IMPORTANT: Set up auth listener AFTER a small delay to ensure initial check starts first
        // This prevents race conditions where onAuthStateChange fires before checkAuth completes
        const setupAuthListener = () => {
            const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
                console.log('🔐 Auth state changed:', event, '| Has session:', !!session?.user, '| Initial check done:', initialAuthCheckDoneRef.current)

                // CRITICAL: Skip ALL events until initial auth check is complete
                if (!initialAuthCheckDoneRef.current) {
                    console.log('🔐 Skipping auth state change - initial check not done yet')
                    return
                }

                // Skip INITIAL_SESSION - this is just the first sync on page load
                if (event === 'INITIAL_SESSION') {
                    console.log('🔐 Skipping INITIAL_SESSION - already handled by checkAuth')
                    return
                }

                // Only process SIGNED_IN and SIGNED_OUT events to avoid duplicate fetches
                if (event !== 'SIGNED_IN' && event !== 'SIGNED_OUT') {
                    console.log('🔐 Skipping non-essential auth event:', event)
                    return
                }

                if (session?.user && event === 'SIGNED_IN') {
                    console.log('🔐 Processing SIGNED_IN event')
                    // User just signed in - set authenticated immediately
                    setIsAuthenticated(true)
                    setUserEmail(session.user.email || '')
                    setUserId(session.user.id)

                    // Mark active session
                    sessionStorage.setItem('serapod_active_session', 'logged_in')

                    // Skip profile fetch if already in progress
                    if (isFetchingProfileRef.current) {
                        console.log('🔐 Profile fetch already in progress, skipping')
                        return
                    }

                    // Fetch profile
                    try {
                        const { success, isShop, fullName, organizationId, avatarUrl, orgName, phone, referralPhone, referenceUserId, address, referenceDisplayName, pointsBalance, bankId, bankAccountNumber, bankAccountHolderName, consumerClaimConfirmedAt, invalidReference, invalidShop } = await checkUserOrganization(session.user.id) as any

                        if (success) {
                            console.log('🔐 Profile fetched on SIGNED_IN')
                            setIsShopUser(isShop)
                            setUserName(fullName || session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || '')
                            setUserAvatarUrl(avatarUrl)
                            setShopName(orgName)
                            setUserLinkedOrganizationId(organizationId || null)
                            setNewLinkedOrganizationId(organizationId || null)
                            setUserPhone(phone)
                            setUserReferralPhone(referralPhone || '')
                            setUserReferenceUserId(referenceUserId || null)
                            setUserReferenceDisplayName(referenceDisplayName || '')
                            setInvalidReference(invalidReference === true)
                            setInvalidShop(invalidShop === true)
                            setNewName(fullName || session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || '')
                            setNewPhone(phone)
                            setNewReferralPhone(referralPhone || '')
                            setNewReferenceUserId(referenceUserId || null)
                            setConsumerClaimConfirmed(Boolean(consumerClaimConfirmedAt))

                            // Set points and bank details for ALL users
                            setUserPoints(pointsBalance)
                            setBankId(bankId || '')
                            setBankAccountNumber(bankAccountNumber || '')
                            setBankAccountHolderName(bankAccountHolderName || '')
                            // Set address
                            setUserAddress(address || '')
                            setNewAddress(address || '')
                            setUserShopName(organizationId ? (orgName || '') : '')
                            setNewShopName(organizationId ? (orgName || '') : '')
                        }
                    } catch (error) {
                        console.error('🔐 Profile fetch error on auth change:', error)
                    }
                } else if (event === 'SIGNED_OUT') {
                    console.log('🔐 Processing SIGNED_OUT event')
                    // User signed out - clear all state
                    sessionStorage.removeItem('serapod_active_session')
                    setIsAuthenticated(false)
                    setIsShopUser(false)
                    setUserEmail('')
                    setUserName('')
                    setUserPoints(0)
                    setUserAvatarUrl(null)
                    setShopName('')
                    setUserPhone('')
                    setUserReferenceUserId(null)
                    setConsumerClaimConfirmed(false)
                    setUserId(null)
                }
            })

            return subscription
        }

        // Set up the auth listener
        const subscription = setupAuthListener()

        return () => {
            subscription.unsubscribe()
        }
    }, [supabase, qrCode])

    // Fetch unread message count for notification badge
    const fetchUnreadMessageCount = async () => {
        if (!isAuthenticated) {
            setUnreadMessageCount(0)
            return
        }
        try {
            // Use the new summary endpoint
            const res = await fetch('/api/support/unread-summary')
            const data = await res.json()
            if (typeof data.total_unread === 'number') {
                setUnreadMessageCount(data.total_unread)
            }
        } catch (error) {
            console.error('Failed to fetch unread count', error)
        }
    }

    // Subscribe to realtime updates for new messages
    useEffect(() => {
        if (!isAuthenticated || !userId) return

        console.log('Setting up realtime support subscription for user:', userId)

        // Subscribe to changes in support_conversations for this user
        // This handles "admin replies" which update the user_unread_count on the conversation row
        const channel = supabase
            .channel('support-unread-updates')
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'support_conversations',
                    filter: `created_by_user_id=eq.${userId}`
                },
                (payload) => {
                    console.log('Realtime support update:', payload)
                    // If the user_unread_count changed, or we just want to be safe, refetch
                    fetchUnreadMessageCount()
                }
            )
            .subscribe()

        return () => {
            supabase.removeChannel(channel)
        }
    }, [isAuthenticated, userId, supabase])

    // Fetch unread count on auth change and periodically
    useEffect(() => {
        if (isAuthenticated) {
            fetchUnreadMessageCount()
            // Poll every 30 seconds
            const interval = setInterval(fetchUnreadMessageCount, 30000)
            return () => clearInterval(interval)
        } else {
            setUnreadMessageCount(0)
        }
    }, [isAuthenticated])

    // Refresh unread count when feedback modal closes
    useEffect(() => {
        if (!showFeedbackModal && isAuthenticated) {
            fetchUnreadMessageCount()
        }
    }, [showFeedbackModal, isAuthenticated])

    // Show genuine product verified animation once per QR page/session.
    useEffect(() => {
        const animationKey = roadtourContext?.token
            ? `roadtour:${roadtourContext.token}`
            : (qrCode ? `qr:${qrCode}` : null)
        const shouldShowGenuineAnimation = isLive && Boolean(animationKey)
        let showTimer: ReturnType<typeof setTimeout> | null = null
        let hideTimer: ReturnType<typeof setTimeout> | null = null

        if (shouldShowGenuineAnimation) {
            if (genuineAnimationKeyRef.current === animationKey) {
                return
            }

            genuineAnimationKeyRef.current = animationKey
            setShowPointsAnimation(false)
            setShowGenuineVerified(false)

            showTimer = setTimeout(() => {
                setShowGenuineVerified(true)
                hideTimer = setTimeout(() => {
                    setShowGenuineVerified(false)
                    setShowPointsAnimation(true)
                }, 4000)
            }, 500)
        } else {
            setShowGenuineVerified(false)
            showTimer = setTimeout(() => setShowPointsAnimation(true), 500)
        }

        return () => {
            if (showTimer) clearTimeout(showTimer)
            if (hideTimer) clearTimeout(hideTimer)
        }
    }, [isLive, qrCode, roadtourContext?.token])

    // Fetch rewards on mount for Featured Rewards section
    useEffect(() => {
        const hasValidContext = orgId || (isPetFoodTheme && roadtourContext?.token)
        if (isLive && hasValidContext) {
            fetchRewards()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLive, orgId, isPetFoodTheme, roadtourContext?.token])

    // Fetch rewards from API when rewards tab is active
    useEffect(() => {
        const hasValidContext = orgId || (isPetFoodTheme && roadtourContext?.token)
        if (activeTab === 'rewards' && isLive && hasValidContext) {
            fetchRewards()
        }
    }, [activeTab, isLive, orgId, isPetFoodTheme, roadtourContext?.token])

    // Fetch free gifts when rewards tab is active (fixes issue where free gifts don't show when directly navigating to Rewards)
    useEffect(() => {
        if (activeTab === 'rewards' && isLive && hasLegacyProductQrContext && config.redemption_enabled) {
            fetchFreeGifts()
            checkGiftRedeemStatus()
        }
    }, [activeTab, isLive, hasLegacyProductQrContext, qrCode, config.redemption_enabled])

    // Fetch rewards tab data when user logs in while on rewards tab
    useEffect(() => {
        if (activeTab === 'rewards' && isAuthenticated && isLive) {
            console.log('🔐 User authenticated on rewards tab, fetching data for category:', rewardCategory)
            // Fetch data based on current category
            if (rewardCategory === 'History') {
                fetchRedemptionHistory()
            } else if (rewardCategory === 'Point History') {
                fetchPointsHistory()
            } else if (rewardCategory === 'Scanned') {
                fetchScannedProducts()
            }
        }
    }, [isAuthenticated, activeTab, isLive])

    // Fetch products from API when products tab is active
    useEffect(() => {
        if (activeTab === 'products' && isLive && (orgId || isPetFoodTheme)) {
            fetchProducts()
        }
    }, [activeTab, isLive, orgId, isPetFoodTheme])

    // Clear cached products/rewards when theme or RoadTour context changes
    // to prevent stale data from the wrong endpoint from being visible.
    useEffect(() => {
        setRewards([])
        setProducts([])
    }, [isPetFoodTheme, roadtourContext?.token])

    // Ensure profile state is fresh whenever user opens Profile tab (handles stale/expired sessions)
    useEffect(() => {
        const refreshProfileIfNeeded = async () => {
            if (activeTab !== 'profile') return

            // If not authenticated, show login form
            if (!isAuthenticated) {
                setShowLoginForm(true)
                return
            }

            if (!userId) return

            // Avoid duplicate / overly frequent fetches (5s cooldown)
            const now = Date.now()
            if (isFetchingProfileRef.current) return
            if (now - lastProfileRefreshRef.current < 5000) return

            isFetchingProfileRef.current = true
            try {
                const profile = await checkUserOrganization(userId, true)
                lastProfileRefreshRef.current = Date.now()

                if (!profile.success || profile.sessionInvalid) {
                    await supabase.auth.signOut()
                    setIsAuthenticated(false)
                    setIsShopUser(false)
                    setUserEmail('')
                    setUserName('')
                    setUserPoints(0)
                    setUserAvatarUrl(null)
                    setShopName('')
                    setUserPhone('')
                    setConsumerClaimConfirmed(false)
                    setUserId(null)
                    setShowLoginForm(true)
                    return
                }

                // Only update state if values have actually changed to prevent unnecessary re-renders/flickers
                if (profile.isShop !== isShopUser) setIsShopUser(profile.isShop)
                const newName = profile.fullName || userName
                if (newName !== userName) setUserName(newName)
                // Only update avatar if it's different (prevents flicker on profile tab)
                if (profile.avatarUrl !== userAvatarUrl) setUserAvatarUrl(profile.avatarUrl)
                const newOrgName = profile.orgName || shopName
                if (newOrgName !== shopName) setShopName(newOrgName)
                const newPhone = profile.phone || userPhone
                if (newPhone !== userPhone) setUserPhone(newPhone)
                setConsumerClaimConfirmed(Boolean((profile as any).consumerClaimConfirmedAt))
                if (profile.pointsBalance !== userPoints) {
                    setUserPoints(profile.pointsBalance)
                }
            } catch (err) {
                console.error('🔐 Profile refresh on profile tab failed:', err)
            } finally {
                isFetchingProfileRef.current = false
            }
        }

        refreshProfileIfNeeded()
    }, [activeTab, isAuthenticated, userId, supabase, userName, shopName, userPhone, userAvatarUrl, isShopUser, userPoints])

    // Check QR status function - reusable for multiple calls
    const checkQrStatusFromApi = async (): Promise<{ isLuckyDrawEntered: boolean, isPointsCollected: boolean, claimMode: 'single_shop' | 'dual', shopLaneCollected: boolean, consumerLaneCollected: boolean }> => {
        if (!hasLegacyProductQrContext || !qrCode) return { isLuckyDrawEntered: false, isPointsCollected: false, claimMode: 'single_shop', shopLaneCollected: false, consumerLaneCollected: false }

        try {
            const response = await fetch(`/api/consumer/check-lucky-draw-status?qr_code=${encodeURIComponent(qrCode)}`)
            const data = await response.json() as RoadtourClaimResponse

            if (data.success) {
                return {
                    isLuckyDrawEntered: data.is_lucky_draw_entered || false,
                    isPointsCollected: data.is_points_collected || false,
                    claimMode: data.claim_mode === 'dual' ? 'dual' : 'single_shop',
                    shopLaneCollected: data.is_shop_points_collected || false,
                    consumerLaneCollected: data.is_consumer_points_collected || false
                }
            }
        } catch (error) {
            console.error('Error checking QR status:', error)
        }
        return { isLuckyDrawEntered: false, isPointsCollected: false, claimMode: 'single_shop', shopLaneCollected: false, consumerLaneCollected: false }
    }

    useEffect(() => {
        // Guests must never inherit QR-level "already collected" as their own UI state.
        // Otherwise Collect shows "Collected" and is disabled before they can open the login modal.
        if (!isAuthenticated) {
            setQrPointsCollected(false)
            return
        }

        if (qrClaimMode === 'dual') {
            setQrPointsCollected(isShopUser ? qrShopLaneCollected : qrConsumerLaneCollected)
            return
        }

        setQrPointsCollected(qrShopLaneCollected || qrConsumerLaneCollected)
    }, [qrClaimMode, qrShopLaneCollected, qrConsumerLaneCollected, isAuthenticated, isShopUser])

    // Check QR status on mount - this prevents button clicks if already used
    useEffect(() => {
        const checkQrStatus = async () => {
            if (!hasLegacyProductQrContext || !qrCode) {
                setCheckingQrStatus(false)
                return
            }

            setCheckingQrStatus(true)

            // Add timeout to prevent infinite loading
            const timeoutId = setTimeout(() => {
                console.warn('⚠️ QR status check timed out, enabling buttons')
                setCheckingQrStatus(false)
            }, 10000) // 10 second timeout

            try {
                const controller = new AbortController()
                const fetchTimeoutId = setTimeout(() => controller.abort(), 8000)

                const response = await fetch(
                    `/api/consumer/check-lucky-draw-status?qr_code=${encodeURIComponent(qrCode)}`,
                    { signal: controller.signal }
                )
                clearTimeout(fetchTimeoutId)

                const data = await response.json()

                if (data.success) {
                    setQrClaimMode(data.claim_mode === 'dual' ? 'dual' : 'single_shop')
                    setQrShopLaneCollected(data.is_shop_points_collected || false)
                    setQrConsumerLaneCollected(data.is_consumer_points_collected || false)

                    // Check if lucky draw already entered from this QR
                    if (data.is_lucky_draw_entered) {
                        setLuckyDrawQrUsed(true)
                        setLuckyDrawEntered(true)
                        // Pre-fill entry details if available
                        if (data.entry_details) {
                            setCustomerName(data.entry_details.consumer_name || '')
                            setCustomerPhone(data.entry_details.consumer_phone || '')
                        }
                    }

                    // Check if gift already redeemed from this QR
                    if (data.is_gift_redeemed) {
                        setGiftQrUsed(true)
                        setGiftRedeemed(true)
                    }

                    // Check if scratch card already played from this QR
                    if (data.is_scratch_card_played) {
                        setScratchCardAlreadyPlayed(true)
                        if (data.scratch_card_reward) {
                            setScratchCardPreviousReward(data.scratch_card_reward)
                        }
                    }

                    // Store the QR code DB ID for scratch card plays
                    if (data.qr_code_id) {
                        setQrCodeDbId(data.qr_code_id)
                    }
                }
            } catch (error: any) {
                if (error.name === 'AbortError') {
                    console.warn('⚠️ QR status check aborted (timeout)')
                } else {
                    console.error('Error checking QR status:', error)
                }
            } finally {
                clearTimeout(timeoutId)
                setCheckingQrStatus(false)
            }
        }

        // Check on mount - always check QR status for returning visitors
        if (isLive && hasLegacyProductQrContext) {
            checkQrStatus()
        } else {
            // Not live or no QR code - immediately set checking to false
            setCheckingQrStatus(false)
        }
    }, [isLive, hasLegacyProductQrContext, qrCode]) // Only run on mount and when QR context changes

    // Clear login form when QR code changes (new scan)
    useEffect(() => {
        console.log('🔐 QR code changed, clearing login form state')
        setLoginEmail('')
        setLoginPassword('')
        setLoginError('')
        setEmailError('')
        setPhoneError('')
        setSignUpEmailStatus('idle')
        setSignUpPhoneStatus('idle')
        resetRegistrationVerificationState()
        setLoginLoading(false)
        setShowLoginForm(false)
    }, [qrCode])

    // Clear login form when user becomes authenticated
    useEffect(() => {
        if (isAuthenticated) {
            console.log('🔐 User authenticated, clearing login form')
            setLoginEmail('')
            setLoginPassword('')
            setLoginError('')
            setEmailError('')
            setPhoneError('')
            setSignUpEmailStatus('idle')
            setSignUpPhoneStatus('idle')
            resetRegistrationVerificationState()
            setLoginLoading(false)
            setShowLoginForm(false)
        }
    }, [isAuthenticated])

    useEffect(() => {
        if (registrationResendCooldown <= 0) return

        const timer = window.setTimeout(() => {
            setRegistrationResendCooldown((current) => Math.max(0, current - 1))
        }, 1000)

        return () => window.clearTimeout(timer)
    }, [registrationResendCooldown])

    useEffect(() => {
        if (!isSignUp) return

        const email = loginEmail.trim().toLowerCase()
        if (!email) {
            setEmailError('')
            setSignUpEmailStatus('idle')
            return
        }

        if (!email.includes('@')) {
            setEmailError('Please enter a valid email address.')
            setSignUpEmailStatus('taken')
            return
        }

        const timeoutId = window.setTimeout(async () => {
            try {
                setSignUpEmailStatus('checking')
                const response = await fetch('/api/auth/register/check-availability', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email }),
                })

                const result = await response.json()
                if (!response.ok) {
                    throw new Error(result.error || 'Unable to validate email address.')
                }

                if (result.email?.available) {
                    setEmailError('')
                    setSignUpEmailStatus('available')
                } else {
                    setEmailError(result.email?.message || 'This email address is already linked to an existing account.')
                    setSignUpEmailStatus('taken')
                }
            } catch (error: any) {
                setEmailError(error.message || 'Unable to validate email address.')
                setSignUpEmailStatus('taken')
            }
        }, 450)

        return () => window.clearTimeout(timeoutId)
    }, [isSignUp, loginEmail])

    useEffect(() => {
        if (!isSignUp) return

        const phone = signUpPhone.trim()
        if (!phone) {
            setPhoneError('')
            setSignUpPhoneStatus('idle')
            return
        }

        if (!validatePhoneNumber(phone)) {
            setPhoneError('Please enter a valid Malaysia or China mobile number.')
            setSignUpPhoneStatus('taken')
            return
        }

        const timeoutId = window.setTimeout(async () => {
            try {
                setSignUpPhoneStatus('checking')
                const response = await fetch('/api/auth/register/check-availability', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone }),
                })

                const result = await response.json()
                if (!response.ok) {
                    throw new Error(result.error || 'Unable to validate mobile number.')
                }

                if (result.phone?.available) {
                    setPhoneError('')
                    setSignUpPhoneStatus('available')
                } else {
                    setPhoneError(result.phone?.message || 'This mobile number is already linked to an existing account.')
                    setSignUpPhoneStatus('taken')
                }
            } catch (error: any) {
                setPhoneError(error.message || 'Unable to validate mobile number.')
                setSignUpPhoneStatus('taken')
            }
        }, 450)

        return () => window.clearTimeout(timeoutId)
    }, [isSignUp, signUpPhone])

    // Re-check QR status when navigating to lucky-draw tab (bulletproof double-check)
    useEffect(() => {
        const recheckStatus = async () => {
            if (activeTab === 'lucky-draw' && isLive && hasLegacyProductQrContext && !luckyDrawQrUsed && !luckyDrawEntered) {
                setCheckingQrStatus(true)
                const status = await checkQrStatusFromApi()
                if (status.isLuckyDrawEntered) {
                    setLuckyDrawQrUsed(true)
                    setLuckyDrawEntered(true)
                }
                setCheckingQrStatus(false)
            }
        }
        recheckStatus()
    }, [activeTab, isLive, hasLegacyProductQrContext, qrCode])

    const fetchRewards = async () => {
        if (!orgId && !(isPetFoodTheme && roadtourContext?.token)) return
        setLoadingRewards(true)
        try {
            let response: Response

            if (isPetFoodTheme && roadtourContext?.token) {
                // Pet Food / Ellbow uses the scoped Ellbow public-rewards endpoint
                response = await fetch(`/api/engagement/catalog/ellbow/public-rewards?rt=${roadtourContext.token}`)
            } else {
                // Cellera / Vape uses the legacy shared consumer endpoint
                response = await fetch(`/api/consumer/rewards?org_id=${orgId}`)
            }

            const result = await response.json()

            if (result.success) {
                setRewards(result.rewards || [])
            } else {
                console.error('Error fetching rewards:', result.error)
                setRewards([])
            }
        } catch (error) {
            console.error('Error fetching rewards:', error)
            setRewards([])
        } finally {
            setLoadingRewards(false)
        }
    }

    const fetchProducts = async () => {
        if (!orgId) return
        setLoadingProducts(true)
        try {
            let response: Response

            if (isPetFoodTheme) {
                // Pet Food / Ellbow uses the scoped RoadTour product endpoint
                response = await fetch(`/api/roadtour/products?org_id=${orgId}`)
            } else {
                // Cellera / Vape uses the legacy shared consumer endpoint
                response = await fetch(`/api/consumer/products?org_id=${orgId}`)
            }

            const result = await response.json()

            if (result.success) {
                setProducts(result.products || [])
            } else {
                console.error('Error fetching products:', result.error)
                setProducts([])
            }
        } catch (error) {
            console.error('Error fetching products:', error)
            setProducts([])
        } finally {
            setLoadingProducts(false)
        }
    }

    // Fetch redemption history
    const fetchRedemptionHistory = async () => {
        if (!isAuthenticated) return
        setLoadingRedemptionHistory(true)
        try {
            const response = await fetch('/api/consumer/redemption-history')
            const result = await response.json()

            if (result.success) {
                setRedemptionHistory(result.redemptions || [])
            } else {
                console.error('Error fetching redemption history:', result.error)
                setRedemptionHistory([])
            }
        } catch (error) {
            console.error('Error fetching redemption history:', error)
            setRedemptionHistory([])
        } finally {
            setLoadingRedemptionHistory(false)
        }
    }

    // Fetch points history
    const fetchPointsHistory = async () => {
        if (!isAuthenticated) return
        setLoadingPointsHistory(true)
        try {
            const response = await fetch('/api/consumer/points-history')
            const result = await response.json()

            if (result.success) {
                setPointsHistory(result.transactions || [])
            } else {
                console.error('Error fetching points history:', result.error)
                setPointsHistory([])
            }
        } catch (error) {
            console.error('Error fetching points history:', error)
            setPointsHistory([])
        } finally {
            setLoadingPointsHistory(false)
        }
    }

    // Fetch scanned products
    const fetchScannedProducts = async () => {
        if (!isAuthenticated) return
        setLoadingScannedProducts(true)
        try {
            const response = await fetch('/api/consumer/scanned-products')
            const result = await response.json()

            if (result.success) {
                setScannedProducts(result.scans || [])
            } else {
                console.error('Error fetching scanned products:', result.error)
                setScannedProducts([])
            }
        } catch (error) {
            console.error('Error fetching scanned products:', error)
            setScannedProducts([])
        } finally {
            setLoadingScannedProducts(false)
        }
    }

    // Fetch free gifts for redemption
    const fetchFreeGifts = async () => {
        if (!hasLegacyProductQrContext || !qrCode) return
        setLoadingFreeGifts(true)
        try {
            const response = await fetch(`/api/consumer/redeem-gifts?qr_code=${encodeURIComponent(qrCode)}`)
            const result = await response.json()

            if (result.success) {
                setFreeGifts(result.gifts || [])
            } else {
                console.error('Error fetching free gifts:', result.error)
                setFreeGifts([])
            }
        } catch (error) {
            console.error('Error fetching free gifts:', error)
            setFreeGifts([])
        } finally {
            setLoadingFreeGifts(false)
        }
    }

    // Check if gift already redeemed for this QR
    const checkGiftRedeemStatus = async () => {
        if (!hasLegacyProductQrContext || !qrCode) return
        try {
            const response = await fetch(`/api/consumer/check-lucky-draw-status?qr_code=${encodeURIComponent(qrCode)}`)
            const data = await response.json()
            if (data.success && data.is_gift_redeemed) {
                setGiftQrUsed(true)
                setGiftRedeemed(true)
            }
        } catch (error) {
            console.error('Error checking gift redeem status:', error)
        }
    }

    // Handle gift claim
    const handleClaimGift = async () => {
        if (!selectedGift || !hasLegacyProductQrContext || !qrCode) return

        setClaimingGift(true)
        setGiftError('')

        try {
            const response = await fetch('/api/consumer/claim-gift', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    qr_code: qrCode,
                    gift_id: selectedGift.id,
                    consumer_name: customerName || null,
                    consumer_phone: customerPhone || null,
                    consumer_email: customerEmail || null
                })
            })

            const data = await response.json()

            if (data.success) {
                setClaimedGiftName(selectedGift.gift_name)
                setGiftRedeemed(true)
                setGiftQrUsed(true)
                setShowGiftConfirm(false)
                setShowGiftSuccess(true)
            } else if (data.code === 'ALREADY_REDEEMED') {
                setGiftQrUsed(true)
                setGiftRedeemed(true)
                setGiftError('This QR code has already been used to claim a gift.')
            } else {
                setGiftError(data.error || 'Failed to claim gift')
            }
        } catch (error) {
            console.error('Error claiming gift:', error)
            setGiftError('Network error. Please try again.')
        } finally {
            setClaimingGift(false)
        }
    }

    const resetRegistrationVerificationState = () => {
        setShowRegistrationOtpModal(false)
        setRegistrationOtpCode('')
        setRegistrationOtpError('')
        setRegistrationOtpLoading(false)
        setRegistrationOtpSending(false)
        setRegistrationVerificationToken('')
        setRegistrationResendCooldown(0)
        setRegistrationOtpRequested(false)
        setRegistrationCreatingAccount(false)
    }

    const resetSignUpForm = () => {
        setLoginEmail('')
        setLoginPassword('')
        setSignUpName('')
        setSignUpPhone('')
        setSignUpConfirmPassword('')
        setSignUpReference('')
        setSignUpShopName('')
        setSignUpReferenceUserId(null)
        setSignUpShopOrganizationId(null)
        setSignUpPendingShopRequest(null)
        setSignUpReferenceError('')
        setSignUpShopError('')
        setSignUpPasswordError('')
        setSignUpConfirmPasswordError('')
        setSignUpPasswordSuccess('')
        setSignUpReferenceTouched(false)
        setSignUpShopTouched(false)
        setSignUpPasswordTouched(false)
        setSignUpConfirmPasswordTouched(false)
        setSignUpValidationAttempted(false)
        setEmailError('')
        setPhoneError('')
        setSignUpEmailStatus('idle')
        setSignUpPhoneStatus('idle')
        setIsSignUpShopRequestOpen(false)
        setPendingSignUpShopRequestName('')
        resetRegistrationVerificationState()
    }

    const openRegistrationFromCollect = (identifier: string) => {
        const trimmedIdentifier = identifier.trim()

        resetSignUpForm()
        if (trimmedIdentifier.includes('@')) {
            setLoginEmail(trimmedIdentifier)
        } else if (trimmedIdentifier) {
            setSignUpPhone(trimmedIdentifier)
        }

        setShowPointsLoginModal(false)
        setCollectPointsStep('login')
        setPointsError('')
        setShopPassword('')
        setActiveTab('profile')
        setIsSignUp(true)
        setShowLoginForm(true)
        setLoginError('No account was found. Create your account to collect these points.')
    }

    const focusAndScrollToField = (ref: React.RefObject<HTMLInputElement | null>) => {
        ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        ref.current?.focus()
    }

    const resolveSignUpReferenceError = (value: string, referenceUserId: string | null) => {
        return getRegistrationReferenceSelectionError(value, referenceUserId) || ''
    }

    const resolveSignUpShopError = (value: string, shopOrganizationId: string | null) => {
        return getRegistrationShopSelectionError(value, shopOrganizationId, signUpPendingShopRequest) || ''
    }

    const runSignUpLinkSelectionValidation = () => {
        let validation: ReturnType<typeof validateRegistrationLinkSelections>

        try {
            validation = validateRegistrationLinkSelections({
                referenceValue: signUpReference,
                referenceUserId: signUpReferenceUserId,
                shopValue: signUpShopName,
                shopOrganizationId: signUpShopOrganizationId,
                pendingShopRequest: signUpPendingShopRequest,
            })
        } catch (validationError) {
            console.error('Sign-up link selection validation failed:', validationError)
            setLoginError("We couldn't validate the form. Please review the highlighted fields and try again.")
            setSignUpReferenceError(resolveSignUpReferenceError(signUpReference, signUpReferenceUserId))
            setSignUpShopError(resolveSignUpShopError(signUpShopName, signUpShopOrganizationId))
            return false
        }

        setSignUpReferenceError(validation.referenceError || '')
        setSignUpShopError(validation.shopError || '')

        return validation.isValid
    }

    const applySignUpPasswordValidation = (options?: {
        password?: string
        confirmPassword?: string
        showPassword?: boolean
        showConfirmPassword?: boolean
    }) => {
        const password = options?.password ?? loginPassword
        const confirmPassword = options?.confirmPassword ?? signUpConfirmPassword
        const validation = validateRegistrationPasswordFields(password, confirmPassword)
        const shouldShowPassword = (options?.showPassword ?? signUpPasswordTouched) || signUpValidationAttempted
        const shouldShowConfirmPassword = (options?.showConfirmPassword ?? signUpConfirmPasswordTouched) || signUpValidationAttempted || Boolean(confirmPassword)

        setSignUpPasswordError(shouldShowPassword ? (validation.passwordError || '') : '')
        setSignUpConfirmPasswordError(shouldShowConfirmPassword ? (validation.confirmPasswordError || '') : '')
        setSignUpPasswordSuccess(shouldShowConfirmPassword ? (validation.confirmPasswordSuccess || '') : '')

        return validation
    }

    const validateSignUpFields = () => {
        setSignUpValidationAttempted(true)
        setSignUpReferenceTouched(true)
        setSignUpShopTouched(true)
        setSignUpPasswordTouched(true)
        setSignUpConfirmPasswordTouched(true)

        const referenceError = resolveSignUpReferenceError(signUpReference, signUpReferenceUserId)
        const shopError = resolveSignUpShopError(signUpShopName, signUpShopOrganizationId)
        const passwordValidation = applySignUpPasswordValidation({
            showPassword: true,
            showConfirmPassword: true,
        })

        setSignUpReferenceError(referenceError)
        setSignUpShopError(shopError)

        const emailFieldError = !signUpEmailValue
            ? 'Please fill in all fields'
            : !signUpEmailFormatValid
                ? 'Please enter a valid email address'
                : emailError || (signUpEmailStatus === 'taken'
                    ? 'Please update the highlighted registration details before continuing.'
                    : signUpEmailStatus === 'checking'
                        ? 'Please wait while we validate your registration details.'
                        : '')

        const fullNameFieldError = !signUpName.trim() ? 'Please enter your full name' : ''
        const phoneFieldError = !signUpPhone.trim()
            ? 'Please enter your mobile number'
            : !signUpPhoneValidation.isValid
                ? 'Please enter a valid Malaysia or China mobile number'
                : phoneError || (signUpPhoneStatus === 'taken'
                    ? 'Please update the highlighted registration details before continuing.'
                    : signUpPhoneStatus === 'checking'
                        ? 'Please wait while we validate your registration details.'
                        : '')

        if (emailFieldError) {
            setLoginError(emailFieldError)
            focusAndScrollToField(signUpEmailInputRef)
            return false
        }

        if (fullNameFieldError) {
            setLoginError(fullNameFieldError)
            focusAndScrollToField(signUpNameInputRef)
            return false
        }

        if (phoneFieldError) {
            setLoginError(phoneFieldError)
            focusAndScrollToField(signUpPhoneInputRef)
            return false
        }

        if (referenceError) {
            setLoginError('Please correct the highlighted fields before continuing.')
            focusAndScrollToField(signUpReferenceInputRef)
            return false
        }

        if (shopError) {
            setLoginError('Please correct the highlighted fields before continuing.')
            focusAndScrollToField(signUpShopInputRef)
            return false
        }

        if (passwordValidation.passwordError) {
            setLoginError(passwordValidation.passwordError)
            focusAndScrollToField(signUpPasswordInputRef)
            return false
        }

        if (passwordValidation.confirmPasswordError) {
            setLoginError(passwordValidation.confirmPasswordError)
            focusAndScrollToField(signUpConfirmPasswordInputRef)
            return false
        }

        setLoginError('')
        return true
    }

    const completeVerifiedRegistration = async (emailToUse: string, verificationToken: string) => {
        const regResult = await registerConsumer({
            email: emailToUse,
            password: loginPassword,
            full_name: signUpName,
            phone: signUpPhone || undefined,
            reference_user_id: signUpReferenceUserId || undefined,
            referral_phone: signUpReference || undefined,
            organization_id: signUpShopOrganizationId || undefined,
            shop_name: signUpShopName || undefined,
            registration_org_id: orgId,
            verification_token: verificationToken,
        })

        if (!regResult.success) {
            throw new Error(regResult.error || 'Failed to create account')
        }

        // Capture bonus info for celebration animation
        const bonus = (regResult as any).bonus
        if (bonus && bonus.points > 0) {
            setRegistrationBonusInfo({ points: bonus.points, awarded: bonus.awarded, mode: bonus.mode })
        }

        const { data, error } = await supabase.auth.signInWithPassword({
            email: emailToUse,
            password: loginPassword
        })

        if (error) throw error

        if (data.session && data.user) {
            sessionStorage.setItem('serapod_active_session', 'logged_in')
            setShowLoginForm(false)
            resetSignUpForm()

            try {
                const profileData = await checkUserOrganization(data.user.id, true)
                const { success, isShop, fullName, avatarUrl, orgName, phone, pointsBalance } = profileData

                if (success) {
                    setIsAuthenticated(true)
                    setUserEmail(data.user.email || '')
                    setUserId(data.user.id)
                    setIsShopUser(isShop)
                    setUserName(fullName || data.user.user_metadata?.full_name || data.user.email?.split('@')[0] || '')
                    setUserAvatarUrl(avatarUrl)
                    setShopName(orgName)
                    setUserPhone(phone)
                    setUserPoints(pointsBalance)
                }
            } catch (profileError) {
                console.error('🔐 Error fetching profile after signup:', profileError)
            }

            // Show celebration animation instead of plain toast
            setShowRegistrationCelebration(true)
            return
        }

        setShowLoginForm(false)
        resetSignUpForm()
        setShowRegistrationCelebration(true)
    }

    const requestRegistrationOtp = async (isResend = false) => {
        if (!orgId) {
            throw new Error('Registration is not available because the organization is missing.')
        }

        if (!validateSignUpFields()) {
            return
        }

        setRegistrationOtpSending(true)
        setRegistrationOtpError('')

        try {
            const response = await fetch(isResend ? '/api/auth/register/resend-code' : '/api/auth/register/request-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: loginEmail.trim().toLowerCase(),
                    phone: signUpPhone.trim(),
                    fullName: signUpName.trim(),
                    orgId,
                    referenceUserId: signUpReferenceUserId,
                    referralPhone: signUpReference.trim(),
                    shopOrganizationId: signUpShopOrganizationId,
                    shopName: signUpShopName.trim(),
                    pendingShopRequest: signUpPendingShopRequest,
                    password: loginPassword,
                    confirmPassword: signUpConfirmPassword,
                    roadtourContext: roadtourContext
                        ? {
                            token: roadtourContext.token,
                            campaign_name: roadtourContext.campaign_name,
                            account_manager_name: roadtourContext.account_manager_name,
                            org_id: roadtourContext.org_id,
                            qr_code_id: roadtourContext.qr_code_id || null,
                            campaign_id: roadtourContext.campaign_id || null,
                            account_manager_user_id: roadtourContext.account_manager_user_id || null,
                        }
                        : null,
                }),
            })

            const result = await response.json()
            if (!response.ok) {
                if (result.field === 'email') {
                    setEmailError(result.error)
                    setSignUpEmailStatus('taken')
                }
                if (result.field === 'phone') {
                    setPhoneError(result.error)
                    setSignUpPhoneStatus('taken')
                }
                if (result.field === 'reference') {
                    setSignUpReferenceError(result.error)
                }
                if (result.field === 'shop') {
                    setSignUpShopError(result.error)
                }
                if (result.field === 'password') {
                    setSignUpPasswordTouched(true)
                    setSignUpPasswordError(result.error)
                    focusAndScrollToField(signUpPasswordInputRef)
                }
                if (result.field === 'confirmPassword') {
                    setSignUpConfirmPasswordTouched(true)
                    setSignUpConfirmPasswordError(result.error)
                    focusAndScrollToField(signUpConfirmPasswordInputRef)
                }
                throw new Error(result.error || 'Unable to send verification code.')
            }

            setRegistrationResendCooldown(Number(result.resendCooldown || 60))
            setShowRegistrationOtpModal(true)
            setRegistrationOtpRequested(true)
            setRegistrationOtpCode('')
            setRegistrationOtpError('')
            toast({
                title: isResend ? 'Verification Code Sent' : 'Verification Started',
                description: result.message || 'A 4-digit verification code has been sent to your email.',
            })
        } finally {
            setRegistrationOtpSending(false)
        }
    }

    const verifyRegistrationOtp = async () => {
        if (!signUpPhone.trim()) {
            setRegistrationOtpError('Phone number is required.')
            return
        }

        if (!/^\d{4}$/.test(registrationOtpCode)) {
            setRegistrationOtpError('Please enter the 4-digit verification code.')
            return
        }

        setRegistrationOtpLoading(true)
        setRegistrationOtpError('')

        try {
            const response = await fetch('/api/auth/register/verify-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    phone: signUpPhone.trim(),
                    code: registrationOtpCode,
                }),
            })

            const result = await response.json()
            if (!response.ok) {
                throw new Error(result.error || 'Unable to verify the code.')
            }

            setRegistrationVerificationToken(result.verificationToken || '')
            setRegistrationCreatingAccount(true)
            setRegistrationOtpError('')

            const emailToUse = loginEmail.replace(/\s/g, '').toLowerCase()
            await completeVerifiedRegistration(emailToUse, result.verificationToken)
        } catch (error: any) {
            setRegistrationCreatingAccount(false)
            setRegistrationOtpError(error.message || 'Unable to verify the code.')
        } finally {
            setRegistrationOtpLoading(false)
        }
    }

    // Handle login
    const handleLogin = async () => {
        if (!loginEmail || !loginPassword) {
            setLoginError('Please fill in all fields')
            return
        }

        if (isSignUp) {
            if (!validateSignUpFields()) {
                return
            }
        }

        // Prevent duplicate submissions
        if (loginLoading) {
            console.log('🔐 Login already in progress, ignoring duplicate request')
            return
        }

        setLoginLoading(true)
        setLoginError('')

        try {
            // Remove all whitespace from email
            let emailToUse = loginEmail.replace(/\s/g, '')

            // Check if input looks like a phone number (doesn't contain @)
            if (!emailToUse.includes('@')) {
                // If signing up, we require a valid email in this field
                if (isSignUp) {
                    setLoginError('Please enter a valid email address')
                    setLoginLoading(false)
                    return
                }

                // Normalize and lookup email by phone
                const normalizedPhone = normalizePhone(emailToUse)

                // Use the RPC function to find the email associated with this phone number
                // Add retry logic for better reliability
                let userEmailData = null
                let lookupError = null

                for (let i = 0; i < 3; i++) {
                    try {
                        const result = await supabase
                            .rpc('get_email_by_phone' as any, { p_phone: normalizedPhone })

                        if (!result.error) {
                            userEmailData = result.data
                            lookupError = null
                            break
                        }
                        lookupError = result.error
                    } catch (err) {
                        lookupError = err as any
                    }
                    if (i < 2) await new Promise(resolve => setTimeout(resolve, 1000))
                }

                if (lookupError) {
                    console.error('Phone lookup error:', lookupError)
                    setLoginError('Error verifying phone number. Please check your connection.')
                    setLoginLoading(false)
                    return
                }

                // Handle different response formats safely
                let userEmail = userEmailData
                if (Array.isArray(userEmailData)) {
                    if (userEmailData.length > 0) {
                        userEmail = userEmailData[0].email || userEmailData[0]
                    } else {
                        userEmail = null
                    }
                } else if (typeof userEmailData === 'object' && userEmailData !== null) {
                    userEmail = (userEmailData as any).email || userEmailData
                }

                if (!userEmail) {
                    setLoginError('Phone number not found. Please check your number or use email to login.')
                    setLoginLoading(false)
                    return
                }

                emailToUse = userEmail as string
            }

            console.log('🔐 Attempting login with email:', emailToUse)

            if (isSignUp) {
                // Validate email format before sending to Supabase
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
                if (!emailRegex.test(emailToUse)) {
                    setLoginError(`Invalid email format: "${emailToUse}". Please check for typos.`)
                    setLoginLoading(false)
                    return
                }

                if (!runSignUpLinkSelectionValidation()) {
                    setLoginError('Please select a valid reference and shop before continuing.')
                    setLoginLoading(false)
                    return
                }

                // If OTP already requested, just re-open the modal instead of sending another code
                if (registrationOtpRequested) {
                    setShowRegistrationOtpModal(true)
                    setLoginLoading(false)
                    return
                }

                await requestRegistrationOtp(false)
                setLoginError('')
                return
            } else {
                // Add timeout for sign in
                const signInPromise = supabase.auth.signInWithPassword({
                    email: emailToUse,
                    password: loginPassword,
                })
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Login timed out')), 15000)
                )

                const { data, error } = await Promise.race([
                    signInPromise,
                    timeoutPromise
                ]) as any

                if (error) {
                    const message = (error.message || '').toLowerCase()
                    if (message.includes('invalid login credentials')) {
                        setLoginError('Incorrect email/phone or password. Please try again.')
                    } else if (message.includes('timeout')) {
                        setLoginError('Login took too long. Please check your connection and try again.')
                    } else {
                        setLoginError(error.message || 'Login failed. Please try again.')
                    }
                    setLoginLoading(false)
                    return
                }

                console.log('🔐 Sign in successful, user:', data.user?.email)

                // IMPORTANT: Mark this as an active session so it persists within this browser session
                sessionStorage.setItem('serapod_active_session', 'logged_in')

                setShowLoginForm(false)
                // Clear form after successful login
                setLoginEmail('')
                setLoginPassword('')

                // IMPORTANT: Force profile fetch after successful login
                if (data.user) {
                    console.log('🔐 Forcing profile fetch after login...')
                    try {
                        const profileData = await checkUserOrganization(data.user.id, true) // Force fetch, bypass duplicate check
                        const { success, isShop, fullName, avatarUrl, orgName, phone, pointsBalance, consumerClaimConfirmedAt } = profileData as any

                        if (success) {
                            console.log('🔐 Profile loaded successfully after login')
                            setIsAuthenticated(true)
                            setUserEmail(data.user.email || '')
                            setUserId(data.user.id)
                            setIsShopUser(isShop)
                            setUserName(fullName || data.user.user_metadata?.full_name || data.user.email?.split('@')[0] || '')
                            setUserAvatarUrl(avatarUrl)
                            setShopName(orgName)
                            setUserPhone(phone)
                            setConsumerClaimConfirmed(Boolean(consumerClaimConfirmedAt))
                            // Set points for all users
                            setUserPoints(pointsBalance)
                        }
                    } catch (profileError) {
                        console.error('🔐 Error fetching profile after login:', profileError)
                    }
                }
            }
        } catch (error: any) {
            console.error('🔐 Login error:', error)
            if (error.message?.includes('Invalid login credentials')) {
                setLoginError('Invalid email/phone or password. Please check your credentials.')
            } else {
                setLoginError(error.message || 'Login failed')
            }
        } finally {
            setLoginLoading(false)
        }
    }

    // Handle QR scan result - navigate to the scanned URL or track page
    const handleQrScanResult = (result: string) => {
        console.log('📱 QR Scan Result:', result)

        try {
            // Check if it's a URL
            if (result.startsWith('http://') || result.startsWith('https://')) {
                const url = new URL(result)
                const hostname = url.hostname.toLowerCase()

                // Check if it's a Serapod2u domain
                const allowedDomains = [
                    'serapod2u.com',
                    'dev.serapod2u.com',
                    'staging.serapod2u.com',
                    'localhost',
                    '127.0.0.1'
                ]

                const isAllowed = allowedDomains.some(domain =>
                    hostname === domain || hostname.endsWith('.' + domain)
                )

                if (isAllowed) {
                    // Navigate to the URL path within our app
                    const path = url.pathname + url.search
                    window.location.href = path
                } else {
                    // External URL - show warning or navigate
                    toast({
                        title: 'External Link',
                        description: 'This QR code links to an external site. Opening...',
                    })
                    window.open(result, '_blank', 'noopener,noreferrer')
                }
            } else if (result.startsWith('/track/') || result.startsWith('/verify/')) {
                // Direct path - navigate
                window.location.href = result
            } else {
                // Assume it's a code and try to navigate to track
                // Could be a product code or QR code
                const cleanCode = result.replace(/[^a-zA-Z0-9-_]/g, '')
                if (cleanCode.length > 0) {
                    window.location.href = `/track/product/${cleanCode}`
                } else {
                    toast({
                        title: 'Invalid QR Code',
                        description: 'Could not process this QR code.',
                        variant: 'destructive'
                    })
                }
            }
        } catch (error) {
            console.error('Error processing QR result:', error)
            // If URL parsing fails, try treating it as a code
            const cleanCode = result.replace(/[^a-zA-Z0-9-_]/g, '')
            if (cleanCode.length > 0) {
                window.location.href = `/track/product/${cleanCode}`
            } else {
                toast({
                    title: 'Invalid QR Code',
                    description: 'Could not process this QR code.',
                    variant: 'destructive'
                })
            }
        }
    }

    // Handle logout
    const handleLogout = async () => {
        console.log('🔐 Logging out...')
        try {
            // Clear state first to ensure UI updates immediately
            setIsAuthenticated(false)
            setIsShopUser(false)
            setUserEmail('')
            setUserName('')
            setUserPoints(0)
            setUserAvatarUrl(null)
            setShopName('')
            setUserPhone('')
            setConsumerClaimConfirmed(false)
            setUserId(null)
            // Guest must not keep session collect flags (would show "Collected" while logged out)
            setPointsCollected(false)
            setQrPointsCollected(false)
            setLastEarnedPoints(0)

            // IMPORTANT: Clear login form fields to prevent auto-login on next visit
            setLoginEmail('')
            setLoginPassword('')
            setLoginError('')
            setShowLoginForm(false)

            // Call server action to clear cookies
            await logoutConsumer()

            // Then sign out from Supabase (with timeout)
            const signOutPromise = supabase.auth.signOut()
            const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 2000))
            await Promise.race([signOutPromise, timeoutPromise])

            // Clear any cached session data (both localStorage AND sessionStorage)
            if (typeof window !== 'undefined') {
                // Clear localStorage keys related to Supabase
                const localKeysToRemove = Object.keys(localStorage).filter(key =>
                    key.startsWith('sb-') || key.includes('supabase')
                )
                localKeysToRemove.forEach(key => localStorage.removeItem(key))

                // Also clear sessionStorage to prevent stale session issues
                const sessionKeysToRemove = Object.keys(sessionStorage).filter(key =>
                    key.startsWith('sb-') || key.includes('supabase')
                )
                sessionKeysToRemove.forEach(key => sessionStorage.removeItem(key))

                // IMPORTANT: Remove the active session marker so next QR scan is fresh
                sessionStorage.removeItem('serapod_active_session')
            }

            console.log('🔐 Logged out successfully')

            // Navigate to profile tab after logout
            setActiveTab('profile')

            // Show toast confirmation
            toast({ title: 'Signed Out', description: 'You have been signed out successfully.' })
        } catch (error) {
            console.error('🔐 Logout error:', error)
            // Even if there's an error, state is already cleared
            toast({ title: 'Signed Out', description: 'Session cleared.' })
        }
    }

    // Check referral phone validity
    const checkReferralPhone = async (phone: string) => {
        if (!phone || !phone.trim()) {
            setReferralCheckStatus('idle')
            setReferralName('')
            return
        }

        const validation = validatePhoneNumber(phone)
        if (!validation.isValid) {
            setReferralCheckStatus('invalid')
            setReferralName('')
            return
        }

        const normalizedPhone = normalizePhone(phone)
        setReferralCheckStatus('checking')

        try {
            const { data: isValid, error } = await supabase
                .rpc('check_serapod_user_phone', {
                    p_phone: normalizedPhone
                })

            if (error) throw error

            if (isValid) {
                setReferralCheckStatus('valid')
                // Fetch name
                try {
                    const res = await fetch('/api/user/lookup-phone', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phone: normalizedPhone })
                    })
                    const data = await res.json()
                    if (data.success && data.name) {
                        setReferralName(data.name)
                    } else {
                        setReferralName('')
                    }
                } catch (e) {
                    console.error("Error looking up referral name", e)
                }
            } else {
                setReferralCheckStatus('invalid')
                setReferralName('')
            }
        } catch (error) {
            console.error('Error checking referral:', error)
            setReferralCheckStatus('idle')
            setReferralName('')
        }
    }

    const getPendingCollectCompletionNotice = ({
        missingShop,
        missingReference,
        invalidShop,
        invalidReference,
        shopChanged,
        referenceChanged,
    }: {
        missingShop: boolean
        missingReference: boolean
        invalidShop: boolean
        invalidReference: boolean
        shopChanged: boolean
        referenceChanged: boolean
    }) => {
        const savedLabel = shopChanged && !referenceChanged
            ? 'Shop saved.'
            : referenceChanged && !shopChanged
                ? 'Reference saved.'
                : 'Profile saved.'

        if ((missingShop || invalidShop) && (missingReference || invalidReference)) {
            return `${savedLabel} Please update your shop and reference before points can be collected.`
        }

        if (missingShop || invalidShop) {
            return `${savedLabel} Please update your shop before points can be collected.`
        }

        if (missingReference || invalidReference) {
            return `${savedLabel} Please update your reference before points can be collected.`
        }

        return ''
    }

    // Handle profile update (name and phone)
    const handleSaveProfile = async () => {
        let targetUserId = userId

        if (!targetUserId) {
            const { data: { user } } = await supabase.auth.getUser()
            if (user?.id) {
                targetUserId = user.id
                setUserId(user.id)
            }
        }

        if (!targetUserId) {
            setProfileSaveError('Please sign in again before saving your profile.')
            return
        }

        const pendingLaneRetry = pendingProfileCollectLane
        const pendingCollectState = readPendingCollectState()
        const shouldResumePendingCollect = pendingLaneRetry === 'shop'
            || (pendingCollectState?.intendedAction === 'collect_points' && pendingCollectState.preferredClaimLane === 'shop')
        let postSaveResumeTask: (() => Promise<void>) | null = null

        setSavingProfile(true)
        setProfileSaveError('')
        setProfileSaveSuccess(false)
        setProfileSaveNotice('')
        setPendingCollectResumeError('')

        try {
            // Prepare update data
            const updateData: any = {}

            if (newName !== userName) {
                updateData.full_name = newName.trim()
            }

            if (newPhone !== userPhone) {
                // Validate phone number format (Malaysia/China)
                if (newPhone && newPhone.trim()) {
                    const phoneValidation = validatePhoneNumber(newPhone.trim())
                    if (!phoneValidation.isValid) {
                        setProfileSaveError(phoneValidation.error || 'Invalid phone number format. Use Malaysia (+60) or China (+86) format.')
                        setSavingProfile(false)
                        return
                    }
                }
                updateData.phone = newPhone.trim() || null
            }

            // Add address if changed
            if (newAddress !== userAddress) {
                updateData.address = newAddress.trim() || null
            }

            // Add shop name if changed (only for users not linked as SHOP users yet)
            if (!isShopUser && newShopName !== userShopName) {
                updateData.shop_name = newShopName.trim() || null
            }

            // Shop affiliation is not a profile field: it is linked through the
            // dedicated consumer shop-link operation before the profile is saved.
            const shopLinkChanged = !isShopUser && newLinkedOrganizationId !== userLinkedOrganizationId

            if (!isShopUser && newShopName.trim() && !newLinkedOrganizationId) {
                setProfileSaveError('Please select a valid shop organization before saving.')
                setSavingProfile(false)
                return
            }

            if (shopLinkChanged && !newLinkedOrganizationId) {
                setProfileSaveError('Please select the shop you want to switch to.')
                setSavingProfile(false)
                return
            }

            // Add referral phone if changed — use RPC for approval flow
            const referralPhoneChanged = newReferralPhone !== userReferralPhone || newReferenceUserId !== userReferenceUserId
            if (referralPhoneChanged) {
                if (newReferralPhone && newReferralPhone.trim()) {
                    const validation = validatePhoneNumber(newReferralPhone.trim())
                    if (!validation.isValid) {
                        setProfileSaveError('Invalid referral phone format')
                        setSavingProfile(false)
                        return
                    }

                    if (referralCheckStatus !== 'valid') {
                        setProfileSaveError(INVALID_REFERENCE_WARNING_MESSAGE)
                        setSavingProfile(false)
                        return
                    }

                    if (!newReferenceUserId) {
                        setProfileSaveError(INVALID_REFERENCE_WARNING_MESSAGE)
                        setSavingProfile(false)
                        return
                    }
                }

                updateData.referral_phone = newReferralPhone.trim() || null
                updateData.reference_user_id = newReferenceUserId
            }

            // Add bank details if shop user or independent consumer
            if (isShopUser || !shopName) {
                // If any bank field is filled, validate all required fields
                if (bankId || bankAccountNumber || bankAccountHolderName) {
                    if (!bankId) {
                        setProfileSaveError('Please select a bank')
                        setSavingProfile(false)
                        return
                    }
                    if (!bankAccountNumber) {
                        setProfileSaveError('Please enter account number')
                        setSavingProfile(false)
                        return
                    }
                    if (!bankAccountHolderName) {
                        setProfileSaveError('Please enter account holder name')
                        setSavingProfile(false)
                        return
                    }

                    const selectedBank = banks.find(b => b.id === bankId)
                    if (selectedBank) {
                        if (selectedBank.is_numeric_only && !/^\d+$/.test(bankAccountNumber)) {
                            setProfileSaveError('Account number must contain digits only')
                            setSavingProfile(false)
                            return
                        }
                        if (bankAccountNumber.length < selectedBank.min_account_length) {
                            setProfileSaveError(`Account number must be at least ${selectedBank.min_account_length} digits`)
                            setSavingProfile(false)
                            return
                        }
                        if (bankAccountNumber.length > selectedBank.max_account_length) {
                            setProfileSaveError(`Account number must be at most ${selectedBank.max_account_length} digits`)
                            setSavingProfile(false)
                            return
                        }
                    }
                }

                // Only send bank fields if user is editing bank info (at least one field has value)
                if (bankId || bankAccountNumber || bankAccountHolderName) {
                    updateData.bank_id = bankId || null
                    updateData.bank_account_number = bankAccountNumber || null
                    updateData.bank_account_holder_name = bankAccountHolderName || null
                }
            }

            if (Object.keys(updateData).length === 0 && !referralPhoneChanged && !shopLinkChanged) {
                setProfileSaveError('No changes to save')
                setSavingProfile(false)
                return
            }

            if (shopLinkChanged && newLinkedOrganizationId) {
                const linkShop = (confirmShopSwitch: boolean) => fetch('/api/consumer/link-shop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ organization_id: newLinkedOrganizationId, ...(confirmShopSwitch ? { confirmShopSwitch: true } : {}) }),
                })

                let linkResponse = await linkShop(false)
                let linkData = await linkResponse.json()

                // The server never silently moves a shop-linked profile to another shop.
                if (linkResponse.status === 409 && linkData?.requiresShopSwitchConfirmation) {
                    const currentShopLabel = linkData.currentShop?.org_name || 'your current shop'
                    const requestedShopLabel = linkData.requestedShop?.org_name || 'the selected shop'
                    if (!window.confirm(`Your profile is linked to ${currentShopLabel}. Switch to ${requestedShopLabel}?`)) {
                        setProfileSaveError('Shop was not changed.')
                        setSavingProfile(false)
                        return
                    }
                    linkResponse = await linkShop(true)
                    linkData = await linkResponse.json()
                }

                if (!linkResponse.ok || !linkData?.success) {
                    throw new Error(linkData?.error || 'Failed to link the selected shop')
                }
                updateData.organization_id = newLinkedOrganizationId
            }

            // Profile fields only (this also syncs phone with Supabase Auth).
            const { organization_id: _linkedOrganizationId, ...profileFields } = updateData
            if (Object.keys(profileFields).length > 0) {
                const response = await fetch('/api/user/update-profile', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: targetUserId,
                        ...profileFields,
                    })
                })
                const data = await response.json()

                if (!response.ok) {
                    throw new Error(data.error || 'Failed to update profile')
                }
            }

            if (referralPhoneChanged) {
                setUserReferralPhone(newReferralPhone || '')
                setUserReferenceUserId(newReferenceUserId || null)
                setUserReferenceDisplayName(referralName || '')
            }

            // Update local state
            if (updateData.full_name) {
                setUserName(updateData.full_name)
            }
            if (updateData.phone !== undefined) {
                setUserPhone(updateData.phone || '')
            }
            if (updateData.address !== undefined) {
                setUserAddress(updateData.address || '')
            }
            if (updateData.shop_name !== undefined || updateData.organization_id !== undefined) {
                const nextLinkedShopName = updateData.organization_id ? (newShopName.trim() || '') : ''
                setUserShopName(nextLinkedShopName)
                setNewShopName(nextLinkedShopName)
            }
            if (updateData.organization_id !== undefined) {
                setUserLinkedOrganizationId(updateData.organization_id || null)
            }

            const refreshedProfile = await checkUserOrganization(targetUserId, true) as any
            if (refreshedProfile?.success) {
                setIsShopUser(Boolean(refreshedProfile.isShop))
                setShopName(refreshedProfile.orgName || '')
                setUserShopName(refreshedProfile.organizationId ? (refreshedProfile.orgName || '') : '')
                setNewShopName(refreshedProfile.organizationId ? (refreshedProfile.orgName || '') : '')
                setUserLinkedOrganizationId(refreshedProfile.organizationId || null)
                setNewLinkedOrganizationId(refreshedProfile.organizationId || null)
                setUserReferralPhone(refreshedProfile.referralPhone || '')
                setNewReferralPhone(refreshedProfile.referralPhone || '')
                setUserReferenceUserId(refreshedProfile.referenceUserId || null)
                setNewReferenceUserId(refreshedProfile.referenceUserId || null)
                setUserReferenceDisplayName(refreshedProfile.referenceDisplayName || '')
                setInvalidReference(refreshedProfile.invalidReference === true)
                setInvalidShop(refreshedProfile.invalidShop === true)
                setProfileIncomplete(refreshedProfile.profileIncomplete === true)
                setProfileIncompleteMessage(refreshedProfile.profileIncompleteMessage || '')
            }

            setProfileSaveSuccess(true)
            setEditingName(false)
            setEditingPhone(false)
            setEditingAddress(false)
            setEditingShopName(false)
            setEditingReferralPhone(false)

            const shopChanged = updateData.shop_name !== undefined || updateData.organization_id !== undefined
            const referenceChanged = referralPhoneChanged
            const savedProfileCompletion = refreshedProfile?.success
                ? resolveCollectProfileCompletion({
                    claimLane: 'shop',
                    organizationId: refreshedProfile.organizationId || null,
                    referralPhone: refreshedProfile.referralPhone || null,
                    isShopLinkValid: refreshedProfile.invalidShop === true ? false : undefined,
                    isReferenceLinkValid: refreshedProfile.invalidReference === true ? false : undefined,
                })
                : resolveCollectProfileCompletion({
                    claimLane: 'shop',
                    organizationId: updateData.organization_id !== undefined
                        ? updateData.organization_id || null
                        : newLinkedOrganizationId || userLinkedOrganizationId,
                    referralPhone: referralPhoneChanged
                        ? newReferralPhone.trim() || null
                        : newReferralPhone || userReferralPhone,
                    isShopLinkValid: updateData.organization_id !== undefined
                        ? Boolean(updateData.organization_id)
                        : undefined,
                    isReferenceLinkValid: referralPhoneChanged
                        ? Boolean(newReferenceUserId)
                        : undefined,
                })

            if (shouldResumePendingCollect) {
                const resumeEmail = pendingCollectState?.email
                    || (pendingProfileCollectEmail || userEmail || '').trim()
                    || null
                setPendingProfileCollectLane('shop')
                persistPendingCollectState({ email: resumeEmail })
            }

            if (shouldResumePendingCollect && !savedProfileCompletion.shouldBlockCollect) {
                postSaveResumeTask = roadtourContext
                    ? async () => {
                        await handleRoadtourClaimWithSession()
                    }
                    : async () => {
                        await resumePendingCollectAfterProfileSave({ collapseProfileInfo: true })
                    }
            } else if (shouldResumePendingCollect) {
                setProfileSaveNotice(
                    getPendingCollectCompletionNotice({
                        missingShop: savedProfileCompletion.missingShop,
                        missingReference: savedProfileCompletion.missingReference,
                        invalidShop: savedProfileCompletion.invalidShop,
                        invalidReference: savedProfileCompletion.invalidReference,
                        shopChanged,
                        referenceChanged,
                    })
                    || refreshedProfile?.profileIncompleteMessage
                    || 'Profile saved. Please complete your remaining shop or reference details before points can be collected.'
                )
            }

            // Clear success message after 3 seconds
            setTimeout(() => setProfileSaveSuccess(false), 3000)

        } catch (error: any) {
            console.error('Error saving profile:', error)
            setProfileSaveError(error.message || 'Failed to save profile')
        } finally {
            setSavingProfile(false)
        }

        if (postSaveResumeTask) {
            void postSaveResumeTask().catch((error) => {
                console.error('Error resuming pending collect after profile save:', error)
            })
        }
    }

    // Handle password change
    const handleChangePassword = async () => {
        if (!currentPassword || !newPassword || !confirmPassword) {
            setPasswordError('All fields are required')
            return
        }

        if (newPassword.length < 6) {
            setPasswordError('New password must be at least 6 characters')
            return
        }

        if (newPassword !== confirmPassword) {
            setPasswordError('Passwords do not match')
            return
        }

        setChangingPassword(true)
        setPasswordError('')
        setPasswordSuccess(false)

        try {
            console.log('🔐 Starting password change...')

            // First verify current password by attempting re-auth with timeout
            const signInPromise = supabase.auth.signInWithPassword({
                email: userEmail,
                password: currentPassword
            })

            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Password verification timeout')), 10000)
            )

            const { error: signInError } = await Promise.race([signInPromise, timeoutPromise]) as any

            if (signInError) {
                throw new Error('Current password is incorrect')
            }

            console.log('🔐 Current password verified, updating...')

            // Update password with timeout
            const updatePromise = supabase.auth.updateUser({
                password: newPassword
            })

            const updateTimeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Password update timeout')), 10000)
            )

            const { error: updateError } = await Promise.race([updatePromise, updateTimeoutPromise]) as any

            if (updateError) {
                throw new Error(updateError.message)
            }

            console.log('✅ Password changed successfully')
            setPasswordSuccess(true)
            setCurrentPassword('')
            setNewPassword('')
            setConfirmPassword('')
            setShowChangePassword(false)

            // Clear success message after 3 seconds
            setTimeout(() => setPasswordSuccess(false), 3000)

        } catch (error: any) {
            console.error('❌ Error changing password:', error)
            setPasswordError(error.message || 'Failed to change password')
        } finally {
            setChangingPassword(false)
        }
    }

    // Check if security code is required for a specific feature
    const isSecurityCodeRequiredForFeature = (action: string): boolean => {
        // If main security code is OFF, no security code required for anything
        if (!config.require_security_code) return false

        // If already verified, no need to check again
        if (securityVerified) return false

        // Check per-feature bypass settings
        switch (action) {
            case 'collect-points':
                return !config.skip_security_code_for_points
            case 'lucky-draw':
                return !config.skip_security_code_for_lucky_draw
            case 'redeem':
            case 'redemption':
                return !config.skip_security_code_for_redemption
            case 'scratch-card':
            case 'play-scratch-card':
            case 'spin-wheel':
            case 'daily-quiz':
            case 'games':
                return !config.skip_security_code_for_scratch_card
            default:
                return true // Default: require security code
        }
    }

    // Handle security check for protected features
    const handleProtectedAction = (action: string) => {
        if (isSecurityCodeRequiredForFeature(action)) {
            setPendingAction(action)
            setShowSecurityModal(true)
        } else {
            executeAction(action)
        }
    }

    const executeAction = async (action: string) => {
        switch (action) {
            case 'collect-points':
                // If user is authenticated (shop user OR independent consumer), collect points with session
                console.log('🔐 Collect points action - isAuthenticated:', isAuthenticated, 'isShopUser:', isShopUser, 'authLoading:', authLoading)

                // ALWAYS do a direct session check to ensure we don't show login modal unnecessarily
                // This handles cases where isAuthenticated state might be stale or incorrect
                console.log('🔐 Doing direct session check before collect...')
                try {
                    const { data: { user }, error } = await supabase.auth.getUser()
                    console.log('🔐 Direct session check result:', user?.id, user?.email, 'Error:', error?.message)

                    if (user && !error) {
                        console.log('🔐 Valid session found, proceeding to collect points with session')
                        // Update auth state if it was incorrect
                        if (!isAuthenticated) {
                            setIsAuthenticated(true)
                            setUserEmail(user.email || '')
                            setUserId(user.id)
                            sessionStorage.setItem('serapod_active_session', 'logged_in')
                        }
                        // Branch: RoadTour uses its own claim API
                        if (roadtourContext) {
                            handleRoadtourClaimWithSession()
                        } else {
                            handleCollectPointsWithSession()
                        }
                        return
                    }
                } catch (e) {
                    console.log('🔐 Session check error:', e)
                }

                // No valid session - show login modal
                console.log('🔐 No valid session, showing login modal')
                setPointsError('')
                setCollectPointsStep('login')
                setShowPointsLoginModal(true)
                break
            case 'lucky-draw':
                setActiveTab('lucky-draw')
                break
            case 'games':
            case 'scratch-card':
                setActiveTab('games')
                break
            case 'play-scratch-card':
                setActiveTab('play-scratch-card')
                break
            case 'spin-wheel':
                setActiveTab('spin-wheel')
                break
            case 'daily-quiz':
                setActiveTab('daily-quiz')
                break
            case 'redeem':
            case 'redemption':
                // Navigate to free gift selection
                setActiveTab('rewards')
                setShowFreeGifts(true)
                // Show free gift modal section (will be handled in rewards tab)
                break
        }
    }

    const populateProfileEditor = async (targetUserId: string) => {
        const profileResult = await checkUserOrganization(targetUserId) as any
        if (profileResult?.success) {
            setUserName(profileResult.fullName || '')
            setNewName(profileResult.fullName || '')
            setUserPhone(profileResult.phone || '')
            setNewPhone(profileResult.phone || '')
            setUserAddress(profileResult.address || '')
            setNewAddress(profileResult.address || '')
            setUserShopName(profileResult.organizationId ? (profileResult.orgName || '') : '')
            setNewShopName(profileResult.organizationId ? (profileResult.orgName || '') : '')
            setUserReferralPhone(profileResult.referralPhone || '')
            setNewReferralPhone(profileResult.referralPhone || '')
            setUserReferenceUserId(profileResult.referenceUserId || null)
            setNewReferenceUserId(profileResult.referenceUserId || null)
            setUserReferenceDisplayName(profileResult.referenceDisplayName || '')
            if (profileResult.avatarUrl) setUserAvatarUrl(profileResult.avatarUrl)
            setInvalidReference(profileResult.invalidReference === true)
            setInvalidShop(profileResult.invalidShop === true)
            setProfileIncomplete(profileResult.profileIncomplete === true)
            setProfileIncompleteMessage(profileResult.profileIncompleteMessage || '')
        }
    }

    const openProfileForPendingCollectFlow = async () => {
        try {
            if (!isAuthenticated && pendingProfileCollectEmail && shopPassword) {
                const { error: signInError } = await supabase.auth.signInWithPassword({
                    email: pendingProfileCollectEmail,
                    password: shopPassword,
                })

                if (!signInError) {
                    setIsAuthenticated(true)
                    setUserEmail(pendingProfileCollectEmail)
                    const { data: { user } } = await supabase.auth.getUser()
                    if (user) {
                        setUserId(user.id)
                        sessionStorage.setItem('serapod_active_session', 'logged_in')
                    }
                }
            }

            if (pendingProfileCollectLane === 'shop') {
                persistPendingCollectState()
            }

            const targetUserId = userId || (await supabase.auth.getUser()).data.user?.id
            if (targetUserId) {
                await populateProfileEditor(targetUserId)
                setUserId(targetUserId)
            }

            setShowPointsLoginModal(false)
            setPointsError('')
            setPointsErrorAction(null)
            setActiveTab('account-settings')
            setShowProfileInfo(true)
        } catch (error) {
            console.error('Error preparing profile editor for shop-lane retry:', error)
            setPointsError('Unable to open your profile right now. Please try again.')
        }
    }

    const openCollectPointsProfilePrompt = (payload?: string | { modalTitle?: string; modalMessage?: string; error?: string; message?: string; email?: string | null }) => {
        const title = typeof payload === 'string'
            ? 'Complete Your Profile'
            : payload?.modalTitle || 'Complete Your Profile'
        const message = typeof payload === 'string'
            ? payload
            : payload?.modalMessage || payload?.message || payload?.error || 'Please update your profile before collecting points.'
        const pendingEmail = typeof payload === 'string' ? userEmail : (payload?.email || userEmail)

        setCollectingPoints(false)
        setPendingProfileCollectLane('shop')
        setPendingProfileCollectEmail(pendingEmail)
        setPendingCollectResumeError('')
        persistPendingCollectState({ email: pendingEmail })
        setPointsErrorTitle(title)
        setPointsError(message)
        setPointsErrorAction(null)
        setCollectPointsStep('complete-profile')
        setShowPointsLoginModal(true)
    }

    const openConsumerClaimConfirmationPrompt = (message?: string, email?: string | null) => {
        setCollectingPoints(false)
        setPendingProfileCollectLane('shop')
        setPendingCollectResumeError('')
        setPointsErrorTitle('Choose Claim Type')
        setPointsError(message || "You're not linked to any shop yet. Continue collecting points as a consumer?")
        setPointsErrorAction(null)
        setPendingProfileCollectEmail(email || userEmail)
        persistPendingCollectState({ email: email || userEmail })
        setCollectPointsStep('consumer-confirm')
        setShowPointsLoginModal(true)
    }

    const openShopLaneConflictPrompt = (message?: string, email?: string | null) => {
        setCollectingPoints(false)
        setPendingProfileCollectLane('shop')
        setPendingProfileCollectEmail(email || userEmail)
        setPendingCollectResumeError('')
        persistPendingCollectState({ email: email || userEmail })
        setPointsErrorTitle('Complete Your Profile')
        setPointsError(message || 'This QR was already claimed by a consumer. Only shop staff can claim it now.')
        setPointsErrorAction('shop-profile-link')
        setCollectPointsStep('complete-profile')
        setShowPointsLoginModal(true)
    }

    const openRoadtourShopOnlyPrompt = (message?: string) => {
        setCollectingPoints(false)
        setPendingProfileCollectLane('shop')
        setPointsErrorTitle('Complete Your Profile')
        setPointsError(message || getRoadtourProfileIncompleteMessage(userName))
        setPointsErrorAction('roadtour-shop-only')
        setCollectPointsStep('complete-profile')
        setShowPointsLoginModal(true)
    }

    const openRoadtourDuplicatePrompt = (message?: string, title = 'Already Claimed') => {
        setCollectingPoints(false)
        setPointsErrorTitle(title)
        setPointsError(message || 'You have already claimed this RoadTour reward.')
        setPointsErrorAction(null)
        setCollectPointsStep('login')
        setShowPointsLoginModal(false)
    }

    const hasValidShopLaneProfile = (overrides: {
        organizationId?: string | null
        shopName?: string
        referralPhone?: string
        isShopLinkValid?: boolean
        isReferenceLinkValid?: boolean
    } = {}) => {
        const activeShopName = overrides.shopName ?? newShopName ?? userShopName
        const activeOrganizationId = overrides.organizationId ?? newLinkedOrganizationId ?? userLinkedOrganizationId
        const activeReferralPhone = overrides.referralPhone ?? newReferralPhone ?? userReferralPhone

        return hasValidLinkedShop({
            organizationId: activeOrganizationId,
            isShopLinkValid: overrides.isShopLinkValid,
        } as any) && hasValidReferenceLink({
            referralPhone: activeReferralPhone,
            isReferenceLinkValid: overrides.isReferenceLinkValid,
        } as any)
    }

    const canAutoRetryShopLane = () => {
        const activeOrganizationId = newLinkedOrganizationId || userLinkedOrganizationId
        const activeReferralPhone = newReferralPhone || userReferralPhone

        return !isShopUser && hasValidShopLaneProfile({
            isShopLinkValid: activeOrganizationId
                ? (newLinkedOrganizationId && newLinkedOrganizationId !== userLinkedOrganizationId ? true : !invalidShop)
                : undefined,
            isReferenceLinkValid: newReferralPhone && newReferralPhone !== userReferralPhone
                ? referralCheckStatus === 'valid'
                : activeReferralPhone.trim() ? !invalidReference : undefined,
        })
    }

    const resumePendingCollectAfterProfileSave = async (options: { collapseProfileInfo?: boolean } = {}): Promise<CollectPointsResult> => {
        let pendingCollectState = readPendingCollectState()

        if (!pendingCollectState && pendingProfileCollectLane === 'shop' && qrCode) {
            const recoveredEmail = (pendingProfileCollectEmail || userEmail || '').trim() || null
            pendingCollectState = {
                intendedAction: 'collect_points',
                preferredClaimLane: 'shop',
                qrCode,
                returnUrl: typeof window !== 'undefined' ? window.location.href : '',
                startedAt: Date.now(),
                email: recoveredEmail,
            }
            persistPendingCollectState({ email: recoveredEmail })
        }

        if (!pendingCollectState) {
            const expiredMessage = 'Profile saved, but the pending collection request expired. Please reopen the QR page and collect again.'
            setPendingCollectResumeError(expiredMessage)
            return { success: false, error: expiredMessage }
        }

        if (options.collapseProfileInfo) {
            setShowProfileInfo(false)
        }

        setPendingCollectResumeError('')

        const fallbackShopId = (shopId || pendingProfileCollectEmail || pendingCollectState.email || userEmail).trim()
        const fallbackShopPassword = shopPassword.trim()
        const canUseCredentialFallback = fallbackShopId.length > 0 && fallbackShopPassword.length > 0

        if (isAuthenticated) {
            const sessionResult = await handleCollectPointsWithSession({
                preferredClaimLane: 'shop',
                skipProfileCheck: true,
                qrCodeOverride: pendingCollectState.qrCode,
                resumeAfterProfileSave: true,
            })

            if (
                sessionResult.success
                || sessionResult.requiresProfileUpdate
                || (!sessionResult.requiresLogin && !canUseCredentialFallback)
            ) {
                return sessionResult
            }
        }

        if (!canUseCredentialFallback) {
            const missingCredentialsMessage = 'Profile saved, but the original sign-in details were unavailable for automatic collection. Please collect the QR again.'
            setPendingCollectResumeError(missingCredentialsMessage)
            return { success: false, error: missingCredentialsMessage }
        }

        return handleCollectPoints({
            preferredClaimLane: 'shop',
            skipProfileCheck: true,
            qrCodeOverride: pendingCollectState.qrCode,
            resumeAfterProfileSave: true,
            shopIdOverride: fallbackShopId,
            shopPasswordOverride: fallbackShopPassword,
        })
    }

    // Handle points collection
    const handleCollectPoints = async (options: CollectPointsOptions = {}): Promise<CollectPointsResult> => {
        const normalizedClaimLane = options.preferredClaimLane === 'shop' ? 'shop' : undefined
        const consumerConfirmation = options.consumerConfirmation === true
        const targetQrCode = options.qrCodeOverride || qrCode
        const credentialShopId = options.shopIdOverride ?? shopId
        const credentialShopPassword = options.shopPasswordOverride ?? shopPassword

        if (!options.skipProfileCheck && profileIncomplete) {
            openCollectPointsProfilePrompt({
                modalTitle: 'Complete Your Profile',
                modalMessage: profileIncompleteMessage,
                error: profileIncompleteMessage,
            })
            return { success: false, requiresProfileUpdate: true, error: profileIncompleteMessage }
        }

        if (!options.skipProfileCheck && normalizedClaimLane === 'shop' && (invalidReference || invalidShop)) {
            const blockingMessage = invalidReference ? INVALID_REFERENCE_WARNING_MESSAGE : INVALID_SHOP_WARNING_MESSAGE
            openCollectPointsProfilePrompt({
                modalTitle: 'Complete Your Profile',
                modalMessage: blockingMessage,
                error: blockingMessage,
            })
            return { success: false, requiresProfileUpdate: true, error: blockingMessage }
        }

        if (!credentialShopId || !credentialShopPassword) {
            const missingCredentialsMessage = 'Please enter your Shop ID and password'
            setPointsError(missingCredentialsMessage)
            if (options.resumeAfterProfileSave) {
                setPendingCollectResumeError(`Profile saved, but points could not be collected automatically. ${missingCredentialsMessage}.`)
            }
            return { success: false, error: missingCredentialsMessage }
        }

        if (!targetQrCode) {
            const missingQrMessage = 'QR code not available'
            setPointsError(missingQrMessage)
            if (options.resumeAfterProfileSave) {
                setPendingCollectResumeError(`Profile saved, but points could not be collected automatically. ${missingQrMessage}.`)
            }
            return { success: false, error: missingQrMessage }
        }

        setCollectingPoints(true)
        setPointsError('')
        setRoadtourProductQrSuccessNote(null)

        try {
            console.log('🔐 handleCollectPoints - Starting...')
            console.log('📡 Calling collect points API...')
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 15000) // 15s timeout

            const response = await fetch('/api/consumer/collect-points', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    qr_code: targetQrCode,
                    shop_id: credentialShopId.trim(),
                    password: credentialShopPassword,
                    preferred_claim_lane: normalizedClaimLane,
                    consumer_confirmation: consumerConfirmation
                }),
                signal: controller.signal
            }).finally(() => clearTimeout(timeoutId))

            const data = await response.json()

            if (!response.ok && data.noAccount) {
                openRegistrationFromCollect(credentialShopId)
                return { success: false, error: data.error || 'No account found' }
            }

            if (data.requiresProfileUpdate) {
                // Establish client-side session so profile page doesn't require re-login
                if (data.email && credentialShopPassword) {
                    try {
                        const { error: signInError } = await supabase.auth.signInWithPassword({
                            email: data.email,
                            password: credentialShopPassword
                        })
                        if (!signInError) {
                            console.log('✅ Session established for profile update')
                            setIsAuthenticated(true)
                            setUserEmail(data.email)
                            const { data: { user } } = await supabase.auth.getUser()
                            if (user) setUserId(user.id)
                            sessionStorage.setItem('serapod_active_session', 'logged_in')
                        }
                    } catch (e) {
                        console.warn('⚠️ Could not establish session for profile:', e)
                    }
                }
                openCollectPointsProfilePrompt(data)
                if (options.resumeAfterProfileSave) {
                    setPendingCollectResumeError(data.modalMessage || data.error || 'Profile saved, but your shop or reference details are still incomplete for collection.')
                }
                return { success: false, requiresProfileUpdate: true, error: data.error || data.modalMessage || data.message }
            }

            if (data.requiresConsumerConfirmation) {
                openConsumerClaimConfirmationPrompt(data.error, data.email)
                if (options.resumeAfterProfileSave) {
                    setPendingCollectResumeError(data.error || 'Profile saved, but another confirmation step is still required before points can be collected.')
                }
                return { success: false, error: data.error || 'Consumer confirmation required' }
            }

            if (!response.ok) {
                if (data.already_collected) {
                    if (data.remaining_lane_available) {
                        if (data.remaining_lane_available === 'shop') {
                            if (normalizedClaimLane !== 'shop' && canAutoRetryShopLane()) {
                                return await handleCollectPoints({ preferredClaimLane: 'shop' })
                            }
                            openShopLaneConflictPrompt(data.error, data.email)
                        } else {
                            setPointsError(data.error || 'This QR code is only available for the other claim lane.')
                            setPointsErrorAction(null)
                        }
                        return { success: false, alreadyCollected: true, error: data.error }
                    }
                    // Points already collected for this QR
                    setPointsEarned(data.points_earned || 0)
                    setPreviousBalance(data.total_balance || 0)
                    setTotalBalance(data.total_balance || 0)
                    setPointsCollected(true)
                    setRoadtourProductQrSuccessNote(null)
                    setShowPointsLoginModal(false)
                    setShowPointsSuccessModal(true)
                    setPointsError('')
                    showRoadtourProductQrProgressNotice(data)
                    resetPendingCollectFlowState()
                    return { success: true, alreadyCollected: true }
                } else {
                    throw new Error(data.error || 'Failed to collect points')
                }
            }

            // Success - points collected
            const newBalance = data.new_balance || data.total_balance || 0
            const earnedPoints = data.points_earned || 0
            setPreviousBalance(newBalance - earnedPoints)
            setPointsEarned(earnedPoints)
            setLastEarnedPoints(earnedPoints) // Persist for Recent Activity
            setTotalBalance(newBalance)
            setUserPoints(newBalance)
            setPointsCollected(true)
            if (data.claim_lane === 'shop') {
                setQrShopLaneCollected(true)
            } else if (data.claim_lane === 'consumer') {
                setQrConsumerLaneCollected(true)
            }
            if (roadtourContext && normalizedClaimLane === 'shop' && data.claim_lane === 'shop') {
                setShopLinkCelebrationName(data.shop_name || newShopName || userShopName || shopName || 'kedai anda')
                setShowShopLinkCelebration(true)
                resetPendingCollectFlowState()
            } else if (normalizedClaimLane === 'shop' && data.claim_lane === 'shop') {
                resetPendingCollectFlowState()
            }
            if (data.consumer_claim_confirmed_at) {
                setConsumerClaimConfirmed(true)
            }
            setRoadtourProductQrSuccessNote(buildRoadtourProductQrProgressCopy(data)?.successNote ?? null)
            showRoadtourProductQrProgressNotice(data)
            setShowPointsLoginModal(false)
            setShowPointsSuccessModal(true)
            setPointsErrorAction(null)

            // IMPORTANT: Establish client-side session so next time user doesn't need to login again
            if (data.email && credentialShopPassword) {
                console.log('🔐 Establishing persistent session for shop user...')
                try {
                    // Add timeout for session establishment
                    const signInPromise = supabase.auth.signInWithPassword({
                        email: data.email,
                        password: credentialShopPassword
                    })
                    const timeoutPromise = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Session establishment timed out')), 10000)
                    )

                    const { error: signInError } = await Promise.race([
                        signInPromise,
                        timeoutPromise
                    ]) as any

                    if (!signInError) {
                        console.log('✅ Session established successfully')
                        // Update auth state so next point collection won't require login
                        setIsAuthenticated(true)
                        setIsShopUser(true)
                        setUserEmail(data.email)
                        setShopName(data.shop_name || '')
                        if (data.avatar_url) setUserAvatarUrl(data.avatar_url)
                    } else {
                        console.warn('⚠️ Could not establish session:', signInError.message)
                    }
                } catch (sessionError) {
                    console.warn('⚠️ Error establishing session:', sessionError)
                    // Don't fail the point collection just because session couldn't be established
                }
            }

            // Clear form
            setShopId('')
            setShopPassword('')

            return { success: true }

        } catch (error: any) {
            console.error('Error collecting points:', error)
            const errorMessage = error.message || 'Failed to collect points'
            setPointsError(errorMessage)
            if (options.resumeAfterProfileSave) {
                setPendingCollectResumeError(`Profile saved, but points could not be collected automatically. ${errorMessage}`)
            }
            return { success: false, error: errorMessage }
        } finally {
            setCollectingPoints(false)
        }
    }

    // Handle points collection using existing session (for authenticated shop users)
    const handleCollectPointsWithSession = async (options: CollectPointsOptions = {}): Promise<CollectPointsResult> => {
        const preferredClaimLane = options.preferredClaimLane
        const consumerConfirmation = options.consumerConfirmation === true
        const targetQrCode = options.qrCodeOverride || qrCode

        if (!options.skipProfileCheck && profileIncomplete) {
            openCollectPointsProfilePrompt({
                modalTitle: 'Complete Your Profile',
                modalMessage: profileIncompleteMessage,
                error: profileIncompleteMessage,
            })
            return { success: false, requiresProfileUpdate: true, error: profileIncompleteMessage }
        }

        if (!targetQrCode) {
            setPointsError('QR code not available')
            return { success: false, error: 'QR code not available' }
        }

        setCollectingPoints(true)
        setPointsError('')
        setRoadtourProductQrSuccessNote(null)
        if (options.resumeAfterProfileSave) {
            setPendingCollectResumeError('')
        }

        try {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), 15000) // 15s timeout

            const response = await fetch('/api/consumer/collect-points-auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    qr_code: targetQrCode,
                    preferred_claim_lane: preferredClaimLane,
                    consumer_confirmation: consumerConfirmation
                }),
                signal: controller.signal
            }).finally(() => clearTimeout(timeoutId))

            const data = await response.json()

            // If session expired or user is not a shop user, fall back to login modal
            if (data.requiresLogin) {
                setPointsError('')
                setCollectPointsStep('login')
                setShowPointsLoginModal(true)
                if (options.resumeAfterProfileSave) {
                    setPendingCollectResumeError('Profile saved, but your session expired before points could be collected. Please sign in and retry collection.')
                }
                return { success: false, requiresLogin: true, error: 'Session expired before points could be collected.' }
            }

            if (data.requiresProfileUpdate) {
                openCollectPointsProfilePrompt(data)
                if (options.resumeAfterProfileSave) {
                    setPendingCollectResumeError(data.modalMessage || data.error || 'Profile saved, but your shop or reference details are still incomplete for collection.')
                }
                return { success: false, requiresProfileUpdate: true, error: data.error || data.modalMessage || data.message }
            }

            if (data.requiresConsumerConfirmation) {
                openConsumerClaimConfirmationPrompt(data.error, userEmail)
                return { success: false, error: data.error || 'Consumer confirmation required' }
            }

            if (!response.ok) {
                if (data.already_collected) {
                    if (data.remaining_lane_available) {
                        if (data.remaining_lane_available === 'shop') {
                            if (preferredClaimLane !== 'shop' && canAutoRetryShopLane()) {
                                return await handleCollectPointsWithSession({ preferredClaimLane: 'shop' })
                            }
                            openShopLaneConflictPrompt(data.error)
                        } else {
                            setPointsError(data.error || 'This QR code is only available for the other claim lane.')
                            setPointsErrorAction(null)
                        }
                        return { success: false, alreadyCollected: true, error: data.error }
                    }
                    // Points already collected for this QR
                    setPointsEarned(data.points_earned || 0)
                    setPreviousBalance(data.total_balance || 0)
                    setTotalBalance(data.total_balance || 0)
                    setPointsCollected(true)
                    setRoadtourProductQrSuccessNote(null)
                    setShowPointsSuccessModal(true)
                    setPointsError('')
                    showRoadtourProductQrProgressNotice(data)
                    resetPendingCollectFlowState()
                    return { success: true, alreadyCollected: true }
                } else {
                    throw new Error(data.error || 'Failed to collect points')
                }
            }

            // Success - points collected
            const newBalance = data.new_balance || data.total_balance || 0
            const earnedPoints = data.points_earned || 0
            setPreviousBalance(newBalance - earnedPoints)
            setPointsEarned(earnedPoints)
            setLastEarnedPoints(earnedPoints) // Persist for Recent Activity
            setTotalBalance(newBalance)
            setUserPoints(newBalance)
            setPointsCollected(true)
            if (data.claim_lane === 'shop') {
                setQrShopLaneCollected(true)
            } else if (data.claim_lane === 'consumer') {
                setQrConsumerLaneCollected(true)
            }
            if (roadtourContext && preferredClaimLane === 'shop' && data.claim_lane === 'shop') {
                setShopLinkCelebrationName(data.shop_name || newShopName || userShopName || shopName || 'kedai anda')
                setShowShopLinkCelebration(true)
                resetPendingCollectFlowState()
            } else if (preferredClaimLane === 'shop' && data.claim_lane === 'shop') {
                resetPendingCollectFlowState()
            }
            if (data.consumer_claim_confirmed_at) {
                setConsumerClaimConfirmed(true)
            }
            setRoadtourProductQrSuccessNote(buildRoadtourProductQrProgressCopy(data)?.successNote ?? null)
            showRoadtourProductQrProgressNotice(data)
            setShowPointsSuccessModal(true)
            setPointsErrorAction(null)
            if (data.avatar_url) setUserAvatarUrl(data.avatar_url)

            return { success: true }

        } catch (error: any) {
            console.error('Error collecting points with session:', error)
            const errorMessage = error.message || 'Failed to collect points'
            setPointsError(errorMessage)
            if (options.resumeAfterProfileSave) {
                setPendingCollectResumeError(`Profile saved, but points could not be collected automatically. ${errorMessage}`)
            }
            // Only show login modal if it's an authentication-related error
            // Don't show login modal for QR code errors when user is already authenticated
            if (!isAuthenticated || errorMessage.toLowerCase().includes('not authenticated') || errorMessage.toLowerCase().includes('session expired')) {
                setShowPointsLoginModal(true)
            }
            // Otherwise, just show the error (will be displayed in the UI)
            return { success: false, error: errorMessage }
        } finally {
            setCollectingPoints(false)
        }
    }

    // --- RoadTour claim handlers (only used when roadtourContext is provided) ---
    const handleRoadtourClaimWithSession = async (options: { consumerConfirmation?: boolean; surveyAnswers?: Record<string, string> } = {}) => {
        if (!roadtourContext) return
        setCollectingPoints(true)
        setPointsError('')
        try {
            const geolocation = await resolveRoadtourGeolocation(true)
            const response = await fetch('/api/roadtour/claim-reward', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    token: roadtourContext.token,
                    geolocation,
                    consumer_confirmation: options.consumerConfirmation === true,
                    survey_answers: options.surveyAnswers && Object.keys(options.surveyAnswers).length > 0 ? options.surveyAnswers : null,
                }),
            })
            const data = await response.json()

            if (data.requiresLogin || data.code === 'AUTH_FAILED') {
                setCollectPointsStep('login')
                setShowPointsLoginModal(true)
                setCollectingPoints(false)
                return
            }
            if (data.code === 'SHOP_REQUIRED') {
                openRoadtourShopOnlyPrompt(data.message)
                return
            }
            if (data.requiresConsumerConfirmation) {
                openConsumerClaimConfirmationPrompt(data.modalMessage || data.message || data.error, userEmail)
                return
            }
            if (data.requiresProfileUpdate || data.code === 'PROFILE_INCOMPLETE') {
                openCollectPointsProfilePrompt(data.message || data.error || getRoadtourProfileIncompleteMessage(userName))
                return
            }
            if (data.code === 'SURVEY_REQUIRED') {
                await openRoadtourSurveyPrompt(data.message)
                return
            }
            if (!response.ok) {
                if (data.code === 'DUPLICATE') {
                    openRoadtourDuplicatePrompt(data.message, data.modalTitle || 'Already Claimed')
                    return
                }
                throw new Error(data.message || 'Failed to claim reward')
            }
            if (data.roadtour_reward_deferred && data.roadtour_milestone) {
                const balance = data.total_balance ?? data.balance_after ?? 0
                setRoadtourMilestone(data.roadtour_milestone)
                setPreviousBalance(balance)
                setPointsEarned(0)
                setLastEarnedPoints(0)
                setTotalBalance(balance)
                setUserPoints(balance)
                setPointsCollected(true)
                setRoadtourSurveyFields([])
                setRoadtourSurveyAnswers({})
                setRoadtourSurveyShopName('')
                setShowPointsLoginModal(false)
                setShowPointsSuccessModal(false)
                return
            }

            // Success
            const earned = data.points_awarded ?? roadtourContext.default_points ?? 0
            const balance = data.total_balance ?? data.balance_after ?? earned
            setPreviousBalance(balance - earned)
            setPointsEarned(earned)
            setLastEarnedPoints(earned)
            setTotalBalance(balance)
            setUserPoints(balance)
            setPointsCollected(true)
            setRoadtourMilestone(null)
            setRoadtourSurveyFields([])
            setRoadtourSurveyAnswers({})
            setRoadtourSurveyShopName('')
            setShowPointsLoginModal(false)
            setShowPointsSuccessModal(true)
        } catch (error: any) {
            setPointsError(error.message || 'Failed to claim reward')
            if (!isAuthenticated) setShowPointsLoginModal(true)
        } finally {
            setCollectingPoints(false)
        }
    }

    const handleRoadtourClaimWithLogin = async (options: { consumerConfirmation?: boolean; surveyAnswers?: Record<string, string> } = {}) => {
        if (!roadtourContext || !shopId.trim() || !shopPassword.trim()) return
        setCollectingPoints(true)
        setPointsError('')
        try {
            const geolocation = await resolveRoadtourGeolocation(true)
            // Resolve phone to email using same RPC as product flow
            const isPhone = /^[0-9+]/.test(shopId.trim())
            let email = shopId.trim()
            if (isPhone) {
                const normalized = normalizePhone(email)
                const { data: rpcResult } = await (supabase as any).rpc('get_email_by_phone', { p_phone: normalized })
                if (typeof rpcResult === 'string' && rpcResult) email = rpcResult
                else if (Array.isArray(rpcResult) && rpcResult.length > 0) email = rpcResult[0]
                else { setPointsError('No account found with this phone number.'); setCollectingPoints(false); return }
            }
            // Sign in client-side to establish session (same as product flow)
            const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: shopPassword })
            if (signInError) { setPointsError(signInError.message || 'Invalid credentials.'); setCollectingPoints(false); return }
            setIsAuthenticated(true)
            setUserEmail(email)
            const { data: { user: authUser } } = await supabase.auth.getUser()
            if (authUser) setUserId(authUser.id)
            sessionStorage.setItem('serapod_active_session', 'logged_in')
            // Now claim via session — also send credentials as server-side auth fallback
            // (SSR cookies may not be set yet immediately after client-side signIn)
            const response = await fetch('/api/roadtour/claim-reward', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    token: roadtourContext.token,
                    login_email: email,
                    login_password: shopPassword,
                    geolocation,
                    consumer_confirmation: options.consumerConfirmation === true,
                    survey_answers: options.surveyAnswers && Object.keys(options.surveyAnswers).length > 0 ? options.surveyAnswers : null,
                }),
            })
            const data = await response.json() as RoadtourClaimResponse
            if (data.code === 'SHOP_REQUIRED') {
                openRoadtourShopOnlyPrompt(data.message)
                return
            }
            if (data.requiresConsumerConfirmation) {
                openConsumerClaimConfirmationPrompt(data.modalMessage || data.message || data.error, email)
                return
            }
            if (data.requiresProfileUpdate || data.code === 'PROFILE_INCOMPLETE') {
                openCollectPointsProfilePrompt(data.message || data.error || getRoadtourProfileIncompleteMessage(userName))
                return
            }
            if (data.code === 'SURVEY_REQUIRED') {
                await openRoadtourSurveyPrompt(data.message)
                return
            }
            if (!response.ok) {
                if (data.code === 'DUPLICATE') {
                    openRoadtourDuplicatePrompt(data.message, data.modalTitle || 'Already Claimed')
                    return
                }
                throw new Error(data.message || 'Failed to claim reward')
            }
            if (data.roadtour_reward_deferred && data.roadtour_milestone) {
                const balance = data.total_balance ?? data.balance_after ?? 0
                setRoadtourMilestone(data.roadtour_milestone)
                setPreviousBalance(balance)
                setPointsEarned(0)
                setLastEarnedPoints(0)
                setTotalBalance(balance)
                setUserPoints(balance)
                setPointsCollected(true)
                setRoadtourSurveyFields([])
                setRoadtourSurveyAnswers({})
                setRoadtourSurveyShopName('')
                setShowPointsLoginModal(false)
                setShowPointsSuccessModal(false)
                setShopId(''); setShopPassword('')
                return
            }

            const earned = data.points_awarded ?? roadtourContext.default_points ?? 0
            const balance = data.total_balance ?? data.balance_after ?? earned
            setPreviousBalance(balance - earned)
            setPointsEarned(earned)
            setLastEarnedPoints(earned)
            setTotalBalance(balance)
            setUserPoints(balance)
            setPointsCollected(true)
            setRoadtourMilestone(null)
            setRoadtourSurveyFields([])
            setRoadtourSurveyAnswers({})
            setRoadtourSurveyShopName('')
            setShowPointsLoginModal(false)
            setShowPointsSuccessModal(true)
            setShopId(''); setShopPassword('')
        } catch (error: any) {
            setPointsError(error.message || 'Failed to claim reward')
        } finally {
            setCollectingPoints(false)
        }
    }

    const handleSecuritySuccess = () => {
        setSecurityVerified(true)
        setShowSecurityModal(false)
        if (pendingAction) {
            executeAction(pendingAction)
            setPendingAction(null)
        }
    }

    // Malaysia phone number validation
    const validateMalaysiaPhone = (phone: string): boolean => {
        // Remove spaces, dashes, and leading zeros
        const cleaned = phone.replace(/[\s-]/g, '').replace(/^0+/, '')
        // Malaysia mobile: 1X-XXXXXXX (9-10 digits after country code)
        // Formats: 01X-XXXXXXX, +601X-XXXXXXX, 601X-XXXXXXX
        const mobileRegex = /^(60)?1[0-9]{8,9}$/
        // Also accept format starting with 0
        const localRegex = /^01[0-9]{8,9}$/
        return mobileRegex.test(cleaned) || localRegex.test(phone.replace(/[\s-]/g, ''))
    }

    // Email validation
    const validateEmail = (email: string): boolean => {
        if (!email) return true // Email is optional
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        return emailRegex.test(email)
    }

    // Handle phone input change with validation
    const handlePhoneChange = (value: string) => {
        setCustomerPhone(value)
        if (value && !validateMalaysiaPhone(value)) {
            setLuckyDrawPhoneError('Please enter a valid Malaysia phone number (e.g., 0123456789)')
        } else {
            setLuckyDrawPhoneError('')
        }
    }

    // Handle email input change with validation
    const handleEmailChange = (value: string) => {
        setCustomerEmail(value)
        if (value && !validateEmail(value)) {
            setLuckyDrawEmailError('Please enter a valid email address')
        } else {
            setLuckyDrawEmailError('')
        }
    }

    // Submit lucky draw entry
    const handleLuckyDrawSubmit = async () => {
        // BULLETPROOF CHECK 1: If already marked as entered, don't proceed
        if (luckyDrawQrUsed || luckyDrawEntered) {
            setLuckyDrawError('This QR code has already been used for lucky draw entry.')
            return
        }

        // Validate inputs
        if (!customerName || !customerPhone) {
            setLuckyDrawError('Please fill in all required fields')
            return
        }

        if (!validateMalaysiaPhone(customerPhone)) {
            setLuckyDrawPhoneError('Please enter a valid Malaysia phone number')
            return
        }

        if (customerEmail && !validateEmail(customerEmail)) {
            setLuckyDrawEmailError('Please enter a valid email address')
            return
        }

        setIsSubmitting(true)
        setLuckyDrawError('')

        // BULLETPROOF CHECK 2: Pre-submit API verification
        try {
            const preCheckStatus = await checkQrStatusFromApi()
            if (preCheckStatus.isLuckyDrawEntered) {
                setLuckyDrawQrUsed(true)
                setLuckyDrawEntered(true)
                setLuckyDrawError('This QR code has already been used for lucky draw entry.')
                setIsSubmitting(false)
                return
            }
        } catch (error) {
            console.error('Pre-check failed, proceeding with submission:', error)
            // Continue with submission - the API will do final validation
        }

        setLuckyDrawError('')

        try {
            const response = await fetch('/api/consumer/lucky-draw-entry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    qr_code: qrCode,
                    consumer_name: customerName,
                    consumer_phone: customerPhone,
                    consumer_email: customerEmail || null
                })
            })

            const data = await response.json()

            if (response.ok && data.success) {
                // BULLETPROOF: Always set the flags on success
                setLuckyDrawQrUsed(true)
                setLuckyDrawEntered(true)
                setShowLuckyDrawSuccess(true)
            } else if (data.already_entered) {
                // Already entered - set flags and show success
                setLuckyDrawQrUsed(true)
                setLuckyDrawEntered(true)
                setShowLuckyDrawSuccess(true)
            } else {
                setLuckyDrawError(data.error || 'Failed to submit entry. Please try again.')
            }
        } catch (error) {
            console.error('Error submitting lucky draw:', error)
            setLuckyDrawError('Network error. Please check your connection and try again.')
        } finally {
            setIsSubmitting(false)
        }
    }

    // Handle lucky draw success close
    const handleLuckyDrawSuccessClose = () => {
        setShowLuckyDrawSuccess(false)
        setLuckyDrawEntered(true)
    }

    // Handle reward redemption
    const handleRedeemReward = async (reward: RewardItem) => {
        // Check if user is authenticated
        if (!isAuthenticated) {
            alert('Please log in to redeem rewards')
            setActiveTab('profile')
            return
        }

        // Check if user is a shop user
        // if (!isShopUser) {
        //     alert('Only shop accounts can redeem rewards')
        //     return
        // }

        // For Point category (bonus points), no points check needed - it's free to collect
        const isPointCategory = (reward as any).category === 'point'

        if (!isPointCategory) {
            const pointsNeeded = reward.point_offer || reward.points_required

            // Check if user has enough points
            if (userPoints < pointsNeeded) {
                setInsufficientPointsData({
                    needed: pointsNeeded,
                    available: userPoints
                })
                setShowInsufficientPoints(true)
                return
            }
        }

        // Show confirmation
        redeemRequestKeyRef.current = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
        setSelectedReward(reward)
        setShowRedeemConfirm(true)
    }

    // Confirm and process redemption
    const confirmRedemption = async () => {
        if (!selectedReward || redeeming) return

        setRedeeming(true)
        setRedeemError('')

        try {
            const response = await fetch('/api/consumer/redeem-reward', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reward_id: selectedReward.id,
                    request_key: redeemRequestKeyRef.current
                })
            })

            const data = await response.json()

            if (response.ok && data.success) {
                // Check if this is a bonus points redemption
                const isBonusPoints = data.is_bonus_points === true

                // Set redemption details for animation
                setRedemptionDetails({
                    rewardName: data.reward_name,
                    pointsDeducted: isBonusPoints ? 0 : data.points_deducted,
                    pointsEarned: isBonusPoints ? data.points_earned : 0,
                    newBalance: data.new_balance,
                    redemptionCode: data.redemption_code,
                    isBonusPoints: isBonusPoints,
                    bonusMessage: data.message,
                    encourageMessage: data.encourage_message
                })

                // Track last redeemed/earned reward for Recent Activity display
                if (isBonusPoints) {
                    setLastEarnedPoints(data.points_earned)
                } else {
                    setLastRedeemedReward({
                        rewardName: data.reward_name,
                        pointsDeducted: data.points_deducted
                    })
                }

                // Update local points balance
                setUserPoints(data.new_balance)

                // Close confirmation and show success animation
                setShowRedeemConfirm(false)
                setShowRedeemSuccess(true)

                // Refresh rewards list to update stock
                fetchRewards()

                // IMPORTANT: Refresh redemption history to show new redemption
                fetchRedemptionHistory()
            } else {
                if (typeof data.current_balance === 'number') {
                    setUserPoints(data.current_balance)
                }

                if (typeof data.current_balance === 'number' && typeof data.required === 'number') {
                    setShowRedeemConfirm(false)
                    setInsufficientPointsData({
                        needed: data.required,
                        available: data.current_balance
                    })
                    setShowInsufficientPoints(true)
                }

                setRedeemError(data.error || 'Failed to redeem reward')
            }
        } catch (error) {
            console.error('Error redeeming reward:', error)
            setRedeemError('Network error. Please try again.')
        } finally {
            setRedeeming(false)
        }
    }

    // Handle redemption success close
    const handleRedeemSuccessClose = () => {
        setShowRedeemSuccess(false)
        setSelectedReward(null)
        // Navigate to rewards tab after closing success animation
        setActiveTab('rewards')
        setRedemptionDetails(null)
    }

    // Handle feedback submission
    const handleSubmitFeedback = async () => {
        if (!feedbackTitle.trim()) {
            setFeedbackError('Please enter a title for your feedback')
            return
        }
        if (!feedbackMessage.trim()) {
            setFeedbackError('Please enter your feedback message')
            return
        }

        setSubmittingFeedback(true)
        setFeedbackError('')

        try {
            const response = await fetch('/api/consumer/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: feedbackTitle.trim(),
                    message: feedbackMessage.trim(),
                    qr_code: qrCode,
                    org_id: orgId,
                    consumer_name: userName || undefined,
                    consumer_phone: userPhone || consumerPhone || undefined,
                    consumer_email: userEmail || undefined,
                    product_name: productInfo?.product_name || undefined,
                    variant_name: productInfo?.variant_name || undefined
                })
            })

            const data = await response.json()

            if (response.ok && data.success) {
                setFeedbackSuccess(true)
                setFeedbackTitle('')
                setFeedbackMessage('')
                // Auto close after 3 seconds
                setTimeout(() => {
                    setShowFeedbackModal(false)
                    setFeedbackSuccess(false)
                }, 3000)
            } else {
                setFeedbackError(data.error || 'Failed to submit feedback. Please try again.')
            }
        } catch (error) {
            console.error('Error submitting feedback:', error)
            setFeedbackError('Network error. Please try again.')
        } finally {
            setSubmittingFeedback(false)
        }
    }

    // Render Home Tab
    // Helper to render banner based on location
    const renderBanner = (location: 'home' | 'rewards' | 'products' | 'profile', currentPlacement: 'top' | 'bottom' = 'top') => {
        const individualItems = (config.banner_config?.enabled && config.banner_config.items) ? config.banner_config.items : []
        const masterItems = (masterBannerConfig?.enabled && masterBannerConfig.items) ? masterBannerConfig.items : []

        // Combine and deduplicate items based on ID
        const allItemsRaw = [...individualItems, ...masterItems]
        const seenIds = new Set()
        const allItems = allItemsRaw.filter((item: any) => {
            if (seenIds.has(item.id)) return false
            seenIds.add(item.id)
            return true
        })

        if (allItems.length === 0) return null

        // Filter items by page (defaults to 'home' if page is not set)
        const pageItems = allItems.filter((item: any) => (item.page || 'home') === location)

        // Filter items by placement (defaults to 'top' if placement is not set)
        const placementItems = pageItems.filter((item: any) => (item.placement || 'top') === currentPlacement)

        if (placementItems.length === 0) return null

        // Determine settings based on placement and location
        let template: 'grid' | 'carousel' = 'grid'
        let autoSlide = false
        let slideInterval = 5
        let showDots = true
        let showProgress = false

        // Use page-specific settings from master banner config if available
        if (masterBannerConfig?.pageSettings?.[location]) {
            const settings = masterBannerConfig.pageSettings[location]
            if (currentPlacement === 'top') {
                template = settings.topTemplate || 'carousel'
                autoSlide = settings.topAutoSlide ?? true
                slideInterval = settings.topSlideInterval ?? 5
            } else {
                template = settings.bottomTemplate || 'grid'
                autoSlide = settings.bottomAutoSlide ?? false
                slideInterval = settings.bottomSlideInterval ?? 5
            }
        } else {
            // Fallback for legacy configuration
            template = masterBannerConfig?.template || config.banner_config?.template || 'grid'
            autoSlide = masterBannerConfig?.autoSlide ?? true
            slideInterval = masterBannerConfig?.slideInterval ?? 5
        }

        return (
            <div className={`sera-collect__banner ${currentPlacement === 'top' ? 'is-top' : 'is-bottom'}`}>
                <AnnouncementBanner
                    items={placementItems as any[]}
                    template={template}
                    autoSlide={autoSlide}
                    slideInterval={slideInterval}
                    showDots={showDots}
                    showProgress={showProgress}
                    onItemClick={(item) => {
                        const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || ''
                        const appUrl = appBaseUrl ? `${appBaseUrl}/app` : '/app'

                        if (item.link_to === 'rewards' || item.link_to === 'page_rewards') setActiveTab('rewards')
                        else if (item.link_to === 'products' || item.link_to === 'page_product') setActiveTab('products')
                        else if (item.link_to === 'contact-us' || item.link_to === 'page-contactus') setShowFeedbackModal(true)
                        else if (item.link_to === 'no-link') return
                        else if (item.link_to === 'short_link') window.open(appUrl, '_blank')
                        else if (item.link_to === 'external_url' && item.external_url) window.open(item.external_url, '_blank')
                        else if (item.link_to?.startsWith('http')) window.open(item.link_to, '_blank')
                    }}
                />
            </div>
        )
    }

    // Ellbow Pet Food home tab. Presentation is isolated from the shared engine;
    // all points, rewards, scanner, and navigation actions still use live state.
    const renderEllbowHomeTab = () => {
        const hasQrContext = isRoadtourMode || hasLegacyProductQrContext
        const collected = Boolean(hasQrContext && (pointsCollected || qrPointsCollected))
        const heroProductName = productInfo?.product_name || roadtourContext?.campaign_name || config.welcome_title
        const progressTarget = nextRewardInfo.nextRewardPoints || Math.max(displayPoints + nextRewardInfo.pointsAway, 100)
        const progressPct = progressTarget > 0 ? Math.min((displayPoints / progressTarget) * 100, 100) : 0
        const featuredRewards = rewards.slice(0, 6).map((reward) => ({
            id: reward.id,
            name: reward.item_name,
            points: reward.point_offer || reward.points_required,
            imageUrl: reward.item_image_url ? (getStorageUrl(reward.item_image_url) || reward.item_image_url) : null,
        }))
        const collectLoading = collectingPoints || checkingQrStatus
        const collectLabel = !hasQrContext
            ? 'Scan to Collect'
            : collectingPoints
                ? 'Collecting…'
                : checkingQrStatus
                    ? 'Checking…'
                    : collected
                        ? 'Points Collected'
                        : 'Collect Points'

        return (
            <EllbowLiveHome
                campaignName={heroProductName}
                accountManagerName={roadtourContext?.account_manager_name}
                brandName={productInfo?.brand_name || 'RoadTour'}
                campaignImageUrl={isRoadtourMode ? null : config.variant_image_url}
                points={displayPoints}
                nextRewardPoints={nextRewardInfo.pointsAway}
                nextRewardName={nextRewardInfo.rewardName}
                progressPercent={progressPct}
                collectLabel={collectLabel}
                collectDisabled={hasQrContext ? (collectLoading || pointsCollected || qrPointsCollected) : false}
                collectLoading={collectLoading}
                collected={collected}
                pointsEnabled={config.points_enabled}
                rewards={featuredRewards}
                rewardsLoading={loadingRewards}
                onCollect={() => hasQrContext ? handleProtectedAction('collect-points') : setShowScanner(true)}
                onViewRewards={() => {
                    setShowFreeGifts(false)
                    setActiveTab('rewards')
                }}
                onRewardClick={(rewardId) => {
                    const reward = rewards.find((item) => item.id === rewardId)
                    if (!reward) return
                    setSelectedRewardForDetail(reward)
                    setCurrentRewardImageIndex(0)
                    setShowRewardDetailModal(true)
                }}
            />
        )
    }
    const renderHomeTab = () => isPetFoodTheme ? renderEllbowHomeTab() : (
        <div className="flex-1 overflow-y-auto pb-6">
            <div className="sera-collect__home-shell">
            {/* Hero Section */}
            <div className="sera-collect__home-hero">
                <div className="relative z-10">
                    <div className="flex items-start justify-between gap-4 mb-6">
                        <div className="min-w-0 flex-1">
                            <div className="mb-5 flex items-center gap-4">
                                <div className="sera-collect__brand-plate">
                                    <Image
                                        src="/images/logo.png"
                                        alt="Serapod"
                                        width={280}
                                        height={89}
                                        className="sera-collect__hero-logo !mx-0"
                                        priority
                                    />
                                </div>
                            </div>
                            {/* Show product info when scanned, otherwise show welcome */}
                            {roadtourContext ? (
                                <>
                                    <div className="flex items-center gap-2 mb-1">
                                        <Gift className="w-4 h-4 text-orange-200" />
                                        <p className="text-orange-200 text-sm font-medium">RoadTour Campaign</p>
                                    </div>
                                    <h1 className="text-xl font-bold leading-tight md:text-2xl">
                                        {roadtourContext.campaign_name}
                                    </h1>
                                    <p className="text-white/80 text-sm mt-0.5">Account Manager: {roadtourContext.account_manager_name}</p>
                                </>
                            ) : productInfo?.product_name ? (
                                <>
                                    <div className="flex items-center gap-2 mb-1">
                                        <Shield className="w-4 h-4 text-green-300" />
                                        <p className="text-green-300 text-sm font-medium">✓ Genuine Product Verified</p>
                                    </div>
                                    <h1 className="text-xl font-bold leading-tight md:text-2xl">
                                        {productInfo.product_name}
                                    </h1>
                                    {productInfo.variant_name && (
                                        <p className="text-white/80 text-sm mt-0.5">{productInfo.variant_name}</p>
                                    )}
                                    {productInfo.brand_name && (
                                        <p className="text-white/60 text-xs mt-0.5">by {productInfo.brand_name}</p>
                                    )}
                                </>
                            ) : (
                                <>
                                    <p className="text-white/80 text-sm">Welcome back</p>
                                    <h1 className="font-display text-2xl font-bold md:text-3xl">
                                        {userName || 'Valued Member'}
                                    </h1>
                                    {isAuthenticated && (
                                        <p className="text-white/70 text-xs mt-1">
                                            {isShopUser && shopName ? `${shopName} (Shop Staff)` : 'Consumer'}
                                        </p>
                                    )}
                                </>
                            )}
                        </div>
                        <div
                            className={`w-12 h-12 shrink-0 rounded-full bg-white/20 flex items-center justify-center overflow-hidden relative md:h-14 md:w-14 ${isAuthenticated ? 'cursor-pointer hover:opacity-80' : ''}`}
                            onClick={handleAvatarClick}
                        >
                            {isUploadingAvatar ? (
                                <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                </div>
                            ) : null}

                            {userAvatarUrl ? (
                                <img
                                    src={userAvatarUrl}
                                    alt="Profile"
                                    className="object-cover w-full h-full"
                                />
                            ) : (
                                <User className="w-6 h-6" />
                            )}
                            <input
                                type="file"
                                ref={fileInputRef}
                                className="hidden"
                                accept="image/*"
                                onChange={handleAvatarUpload}
                            />
                        </div>
                    </div>

                    {/* Points Card */}
                    <div className="bg-white/15 backdrop-blur-sm rounded-2xl p-4 border border-white/20">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-white/70 text-xs uppercase tracking-wider">Your Points</p>
                                <div className="flex items-baseline gap-2 mt-1">
                                    <span className="text-3xl font-bold tabular-nums">{displayPoints}</span>
                                    <Star className={`w-5 h-5 text-yellow-300 fill-yellow-300 ${showPointsAnimation ? 'animate-bounce' : ''}`} />
                                </div>
                            </div>
                            <div className="text-right">
                                <p className="text-white/70 text-xs">Next Reward</p>
                                <p className="text-sm font-medium">
                                    {nextRewardInfo.pointsAway > 0
                                        ? `${nextRewardInfo.pointsAway.toLocaleString()} pts away`
                                        : 'Ready to claim!'}
                                </p>
                                {nextRewardInfo.rewardName && (
                                    <p className="text-[10px] text-white/60 mt-0.5 truncate max-w-[100px]">
                                        {nextRewardInfo.rewardName}
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* Progress bar */}
                        <div className="mt-4">
                            <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                                <div
                                    className="h-full bg-yellow-400 rounded-full transition-all ease-out"
                                    style={{
                                        width: showPointsAnimation
                                            ? `${Math.min((userPoints / (nextRewardInfo.nextRewardPoints || 50000)) * 100, 100)}%`
                                            : '0%',
                                        transitionDuration: '2000ms'
                                    }}
                                />
                            </div>
                            <div className="flex justify-between mt-2 text-xs text-white/60">
                                <span>0</span>
                                {nextRewardInfo.nextRewardPoints > 0 ? (
                                    <>
                                        <span>{Math.round(nextRewardInfo.nextRewardPoints * 0.25).toLocaleString()}</span>
                                        <span>{Math.round(nextRewardInfo.nextRewardPoints * 0.5).toLocaleString()}</span>
                                        <span>{nextRewardInfo.nextRewardPoints.toLocaleString()}</span>
                                    </>
                                ) : (
                                    <>
                                        <span>10,000</span>
                                        <span>25,000</span>
                                        <span>50,000</span>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Quick Actions */}
            <div className="relative z-20 mt-5 px-0">
                <div className="sera-collect__panel p-4 flex justify-between gap-3 md:p-5">
                    {config.points_enabled && (
                        <button
                            onClick={() => (isRoadtourMode || hasLegacyProductQrContext) ? handleProtectedAction('collect-points') : setShowScanner(true)}
                            disabled={(isRoadtourMode || hasLegacyProductQrContext) ? (collectingPoints || pointsCollected || qrPointsCollected || checkingQrStatus) : false}
                            className={`flex-1 flex flex-col items-center p-2 rounded-xl transition-colors ${(isRoadtourMode || hasLegacyProductQrContext) && (pointsCollected || qrPointsCollected) ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'
                                }`}
                        >
                            <div
                                className="w-10 h-10 rounded-full flex items-center justify-center mb-1.5"
                                style={{ backgroundColor: ((isRoadtourMode || hasLegacyProductQrContext) && (pointsCollected || qrPointsCollected)) ? '#dcfce7' : `${config.primary_color}15` }}
                            >
                                {(isRoadtourMode || hasLegacyProductQrContext) && (collectingPoints || checkingQrStatus) ? (
                                    <Loader2 className="w-5 h-5 animate-spin" style={{ color: config.primary_color }} />
                                ) : ((isRoadtourMode || hasLegacyProductQrContext) && (pointsCollected || qrPointsCollected)) ? (
                                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                                ) : (
                                    <Coins className="w-5 h-5" style={{ color: config.primary_color }} />
                                )}
                            </div>
                            <span className={`text-[10px] font-medium ${(isRoadtourMode || hasLegacyProductQrContext) ? 'text-gray-700' : 'text-gray-500'}`}>
                                {!(isRoadtourMode || hasLegacyProductQrContext) ? 'Scan to collect' : collectingPoints ? 'Collecting...' : checkingQrStatus ? 'Checking...' : (pointsCollected || qrPointsCollected) ? 'Collected' : isRoadtourMode ? 'RoadTour Rewards' : 'Collect'}
                            </span>
                        </button>
                    )}

                    {config.lucky_draw_enabled && (
                        <button
                            onClick={() => hasLegacyProductQrContext ? handleProtectedAction('lucky-draw') : setShowScanner(true)}
                            disabled={hasLegacyProductQrContext ? (checkingQrStatus || luckyDrawQrUsed || luckyDrawEntered) : false}
                            className={`flex-1 flex flex-col items-center p-2 rounded-xl transition-colors ${hasLegacyProductQrContext && (luckyDrawQrUsed || luckyDrawEntered) ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'
                                }`}
                        >
                            <div
                                className="w-10 h-10 rounded-full flex items-center justify-center mb-1.5"
                                style={{ backgroundColor: (hasLegacyProductQrContext && (luckyDrawQrUsed || luckyDrawEntered)) ? '#dcfce7' : '#fef3c7' }}
                            >
                                {hasLegacyProductQrContext && checkingQrStatus ? (
                                    <Loader2 className="w-5 h-5 animate-spin text-amber-500" />
                                ) : (hasLegacyProductQrContext && (luckyDrawQrUsed || luckyDrawEntered)) ? (
                                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                                ) : (
                                    <Trophy className="w-5 h-5 text-amber-500" />
                                )}
                            </div>
                            <span className={`text-[10px] font-medium ${hasLegacyProductQrContext ? 'text-gray-700' : 'text-gray-500'}`}>
                                {!hasLegacyProductQrContext ? 'Scan first' : checkingQrStatus ? 'Checking...' : (luckyDrawQrUsed || luckyDrawEntered) ? 'Already In' : 'Lucky Draw'}
                            </span>
                        </button>
                    )}

                    {config.redemption_enabled && (
                        <button
                            onClick={() => {
                                if (hasLegacyProductQrContext) {
                                    handleProtectedAction('redeem')
                                    fetchFreeGifts()
                                } else {
                                    setShowScanner(true)
                                }
                            }}
                            disabled={hasLegacyProductQrContext ? (checkingQrStatus || giftQrUsed || giftRedeemed) : false}
                            className={`flex-1 flex flex-col items-center p-2 rounded-xl transition-colors ${hasLegacyProductQrContext && (giftQrUsed || giftRedeemed) ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'
                                }`}
                        >
                            <div
                                className="w-10 h-10 rounded-full flex items-center justify-center mb-1.5"
                                style={{ backgroundColor: (hasLegacyProductQrContext && (giftQrUsed || giftRedeemed)) ? '#dcfce7' : '#dcfce7' }}
                            >
                                {hasLegacyProductQrContext && checkingQrStatus ? (
                                    <Loader2 className="w-5 h-5 animate-spin text-green-500" />
                                ) : (hasLegacyProductQrContext && (giftQrUsed || giftRedeemed)) ? (
                                    <CheckCircle2 className="w-5 h-5 text-green-500" />
                                ) : (
                                    <Gift className="w-5 h-5 text-green-500" />
                                )}
                            </div>
                            <span className={`text-[10px] font-medium ${hasLegacyProductQrContext ? 'text-gray-700' : 'text-gray-500'}`}>
                                {!hasLegacyProductQrContext ? 'Scan first' : checkingQrStatus ? 'Checking...' : (giftQrUsed || giftRedeemed) ? 'Redeemed' : 'Redeem'}
                            </span>
                        </button>
                    )}

                    {config.enable_scratch_card_game && (
                        <button
                            onClick={() => handleProtectedAction('scratch-card')}
                            className="flex-1 flex flex-col items-center p-2 rounded-xl hover:bg-gray-50 transition-colors"
                        >
                            <div
                                className="w-10 h-10 rounded-full flex items-center justify-center mb-1.5"
                                style={{ backgroundColor: '#f3e8ff' }}
                            >
                                <Ticket className="w-5 h-5 text-purple-600" />
                            </div>
                            <span className="text-[10px] font-medium text-gray-700">Games</span>
                        </button>
                    )}
                </div>
                {config.points_enabled && hasLegacyProductQrContext && !checkingQrStatus && (
                    <QrCollectionStatus
                        qrCode={qrCode}
                        isAuthenticated={isAuthenticated}
                        allCollected={qrClaimMode === 'dual' ? (qrShopLaneCollected && qrConsumerLaneCollected) : (qrShopLaneCollected || qrConsumerLaneCollected)}
                        anyCollected={qrShopLaneCollected || qrConsumerLaneCollected}
                    />
                )}
            </div>

            <div className="sera-collect__home-grid">
            {/* Featured Rewards Section */}
            <section className="sera-collect__section">
                <div className="flex items-center justify-between mb-4">
                    <h2 className="font-display text-lg font-bold text-[var(--sera-ink)]">Featured Rewards</h2>
                    <button
                        onClick={() => setActiveTab('rewards')}
                        className="text-sm font-medium flex items-center gap-1"
                        style={{ color: config.primary_color }}
                    >
                        See all <ChevronRight className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
                    {/* Show real rewards if available, otherwise show loading/placeholder */}
                    {loadingRewards ? (
                        // Loading state
                        [1, 2, 3].map((i) => (
                            <div key={i} className="flex-shrink-0 w-36 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden animate-pulse">
                                <div className="h-24 bg-gray-200" />
                                <div className="p-3">
                                    <div className="h-3 bg-gray-200 rounded w-20 mb-2" />
                                    <div className="h-3 bg-gray-200 rounded w-14" />
                                </div>
                            </div>
                        ))
                    ) : rewards.length > 0 ? (
                        // Show real rewards (first 5)
                        rewards.slice(0, 5).map((reward) => (
                            <div
                                key={reward.id}
                                className="flex-shrink-0 w-36 bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden cursor-pointer hover:shadow-md transition-shadow"
                                onClick={() => setActiveTab('rewards')}
                            >
                                <div className="h-24 bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center relative overflow-hidden p-2">
                                    <SafeImage
                                        src={reward.item_image_url}
                                        alt={reward.item_name}
                                        className="absolute inset-0 h-full w-full object-contain"
                                        fallbackClassName="bg-gradient-to-br from-gray-100 to-gray-200"
                                        fallbackIcon={Gift}
                                        fallbackIconClassName="h-10 w-10 text-gray-400"
                                    />
                                    {reward.stock_quantity !== null && reward.stock_quantity <= 5 && reward.stock_quantity > 0 && (
                                        <span className="absolute top-1 right-1 bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                                            {reward.stock_quantity} left
                                        </span>
                                    )}
                                </div>
                                <div className="p-3">
                                    <p className="text-xs font-medium text-gray-900 line-clamp-1">{reward.item_name}</p>
                                    <div className="flex items-center gap-1 mt-1">
                                        <Star className={`w-3 h-3 ${(reward as any).category === 'point' ? 'text-green-500 fill-green-500' : 'text-amber-500 fill-amber-500'}`} />
                                        {(reward as any).category === 'point' ? (
                                            <span className="text-xs font-bold text-green-600">+{(reward as any).point_reward_amount || 0} pts</span>
                                        ) : reward.point_offer ? (
                                            <div className="flex items-center gap-1">
                                                <span className="text-xs text-gray-400 line-through">{reward.points_required}</span>
                                                <span className="text-xs font-bold text-red-500">{reward.point_offer} pts</span>
                                            </div>
                                        ) : (
                                            <span className="text-xs text-gray-600">{reward.points_required} pts</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))
                    ) : (
                        // No rewards available placeholder
                        <div className="flex-1 text-center py-8 text-gray-500">
                            <Gift className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                            <p className="text-sm">No rewards available yet</p>
                            <p className="text-xs">Check back soon!</p>
                        </div>
                    )}
                </div>
            </section>

            {/* Recent Activity */}
            <section className="sera-collect__section">
                <h2 className="font-display text-lg font-bold text-[var(--sera-ink)] mb-4">Recent Activity</h2>
                <div className="space-y-3">
                    {pointsCollected && (
                        <div className="flex items-center gap-3 p-3 bg-green-50 rounded-xl border border-green-100">
                            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center">
                                <CheckCircle2 className="w-5 h-5 text-green-600" />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-gray-900">Points Collected</p>
                                <p className="text-xs text-gray-500">Just now</p>
                            </div>
                            <span className="text-sm font-bold text-green-600">+{lastEarnedPoints} pts</span>
                        </div>
                    )}

                    {lastRedeemedReward && (
                        <div className="flex items-center gap-3 p-3 bg-purple-50 rounded-xl border border-purple-100">
                            <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center">
                                <Gift className="w-5 h-5 text-purple-600" />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-gray-900">Reward Redeemed</p>
                                <p className="text-xs text-gray-500">{lastRedeemedReward.rewardName}</p>
                            </div>
                            <span className="text-sm font-bold text-purple-600">-{lastRedeemedReward.pointsDeducted} pts</span>
                        </div>
                    )}

                    {luckyDrawEntered && (
                        <div className="flex items-center gap-3 p-3 bg-amber-50 rounded-xl border border-amber-100">
                            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
                                <Trophy className="w-5 h-5 text-amber-600" />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-gray-900">Lucky Draw Entry</p>
                                <p className="text-xs text-gray-500">Just now</p>
                            </div>
                            <Badge className="bg-amber-100 text-amber-700">Entered</Badge>
                        </div>
                    )}

                    {!pointsCollected && !luckyDrawEntered && !lastRedeemedReward && (
                        <div className="text-center py-8 text-gray-500">
                            <Zap className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                            <p className="text-sm">No recent activity</p>
                            <p className="text-xs">Start collecting points!</p>
                        </div>
                    )}
                </div>
            </section>
            </div>

            {/* Promotions Banner */}
            {renderBanner('home', 'top')}

            {/* Bottom Banner */}
            {renderBanner('home', 'bottom')}
            </div>
        </div>
    )

    // Render Rewards Tab
    const renderRewardsTab = () => {
        // Handler for category tab change
        const handleCategoryChange = (cat: RewardCategoryType) => {
            setRewardCategory(cat)
            // Fetch data for the selected tab if authenticated
            if (isAuthenticated) {
                if (cat === 'History') {
                    // Always fetch to ensure latest redemptions are shown
                    fetchRedemptionHistory()
                } else if (cat === 'Point History') {
                    // Always fetch to ensure latest points transactions are shown
                    fetchPointsHistory()
                } else if (cat === 'Scanned' && scannedProducts.length === 0) {
                    fetchScannedProducts()
                }
            }
        }

        // Format date helper
        const formatDate = (dateStr: string) => {
            const date = new Date(dateStr)
            return date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            })
        }

        // Get status color
        const getStatusColor = (status: string) => {
            switch (status) {
                case 'fulfilled':
                    return { bg: 'bg-green-100', text: 'text-green-700' }
                case 'processing':
                    return { bg: 'bg-blue-100', text: 'text-blue-700' }
                case 'pending':
                default:
                    return { bg: 'bg-amber-100', text: 'text-amber-700' }
            }
        }

        return (
            <div className="flex-1 overflow-y-auto pb-20 bg-gray-50">
                {/* Header */}
                <div
                    className="px-5 pt-6 pb-8 text-white"
                    style={{ backgroundColor: config.primary_color }}
                >
                    <h1 className="text-xl font-bold mb-2">Rewards Catalog</h1>
                    <p className="text-white/80 text-sm">Redeem your points for amazing rewards</p>

                    <div className="mt-4 flex items-center gap-2 bg-white/15 rounded-xl p-3">
                        <Star className="w-5 h-5 text-yellow-300 fill-yellow-300" />
                        <span className="font-bold">{userPoints}</span>
                        <span className="text-white/70 text-sm">points available</span>
                    </div>
                </div>

                {/* Category Tabs - Renamed: All, Scanned, Point History, History */}
                <div className="px-5 -mt-4">
                    <div className="bg-white rounded-xl shadow-sm p-1 flex gap-1">
                        {(['All', 'Scanned', 'Point History', 'History'] as RewardCategoryType[]).map((cat) => (
                            <button
                                key={cat}
                                onClick={() => handleCategoryChange(cat)}
                                className={`flex-1 py-2 px-2 rounded-lg text-xs font-medium transition-colors ${rewardCategory === cat
                                    ? 'text-white'
                                    : 'text-gray-600 hover:bg-gray-50'
                                    }`}
                                style={rewardCategory === cat ? { backgroundColor: config.primary_color } : {}}
                            >
                                {cat}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Tab Content */}
                <div className="px-5 mt-4">
                    {renderBanner('rewards', 'top')}
                    {/* Free Gifts Section - Show when redemption is enabled and there are gifts */}
                    {config.redemption_enabled && showFreeGifts && (
                        <div className="mb-6">
                            <h3 className="text-base font-semibold text-gray-900 mb-3 flex items-center gap-2">
                                <Gift className="w-5 h-5 text-green-500" />
                                Free Gifts Available
                            </h3>
                            {loadingFreeGifts ? (
                                <div className="text-center py-6">
                                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-green-500" />
                                    <p className="text-sm text-gray-500 mt-2">Loading gifts...</p>
                                </div>
                            ) : giftQrUsed || giftRedeemed ? (
                                <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
                                    <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto mb-2" />
                                    <p className="text-sm font-medium text-green-700">You've already claimed a gift with this QR code!</p>
                                    <p className="text-xs text-green-600 mt-1">Scan another product to claim more gifts.</p>
                                </div>
                            ) : freeGifts.length > 0 ? (
                                <div className="grid grid-cols-2 gap-3">
                                    {freeGifts.map((gift) => {
                                        const remaining = gift.total_quantity === 0
                                            ? 'Unlimited'
                                            : gift.total_quantity - gift.claimed_quantity
                                        const isAvailable = gift.total_quantity === 0 || (typeof remaining === 'number' && remaining > 0)

                                        return (
                                            <div key={gift.id} className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-100">
                                                <div className="h-24 bg-gradient-to-br from-green-50 to-green-100 flex items-center justify-center relative overflow-hidden">
                                                    {gift.gift_image_url ? (
                                                        <img
                                                            src={getStorageUrl(gift.gift_image_url) || gift.gift_image_url}
                                                            alt={gift.gift_name}
                                                            className="w-full h-full object-contain p-2"
                                                        />
                                                    ) : (
                                                        <Gift className="w-10 h-10 text-green-400" />
                                                    )}
                                                    {gift.total_quantity > 0 && remaining !== 'Unlimited' && (
                                                        <Badge className="absolute top-1 right-1 bg-green-500 text-white text-[10px]">
                                                            {remaining} left
                                                        </Badge>
                                                    )}
                                                </div>
                                                <div className="p-3">
                                                    <p className="text-sm font-medium text-gray-900 line-clamp-1">{gift.gift_name}</p>
                                                    <p className="text-xs text-gray-500 line-clamp-1 mt-0.5">{gift.gift_description || 'Free gift for you!'}</p>
                                                    <button
                                                        onClick={() => {
                                                            if (isAvailable) {
                                                                setSelectedGift(gift)
                                                                setShowGiftConfirm(true)
                                                            }
                                                        }}
                                                        disabled={!isAvailable}
                                                        className="w-full mt-2 text-xs font-medium px-3 py-2 rounded-lg transition-all hover:scale-105 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                                                        style={{
                                                            backgroundColor: isAvailable ? '#dcfce7' : '#e5e7eb',
                                                            color: isAvailable ? '#16a34a' : '#6b7280'
                                                        }}
                                                    >
                                                        {isAvailable ? 'Claim Free' : 'Out of Stock'}
                                                    </button>
                                                </div>
                                            </div>
                                        )
                                    })}
                                </div>
                            ) : (
                                <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-center">
                                    <Ghost className="w-10 h-10 text-gray-300 mx-auto mb-2" />
                                    <p className="text-sm text-gray-500">No free gifts available for this product.</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ALL - Show rewards grid */}
                    {rewardCategory === 'All' && (
                        <div className="grid grid-cols-2 gap-3">
                            {loadingRewards ? (
                                <div className="col-span-2 text-center py-12">
                                    <div className="w-8 h-8 border-2 border-gray-300 border-t-primary rounded-full animate-spin mx-auto" />
                                </div>
                            ) : rewards.length > 0 ? (
                                rewards.map((reward) => (
                                    <div key={reward.id} className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-100">
                                        <div className="h-28 bg-white flex items-center justify-center relative p-2">
                                            {(reward as any).animation_url ? (
                                                <video
                                                    src={getStorageUrl((reward as any).animation_url) || (reward as any).animation_url}
                                                    className="w-full h-full object-contain"
                                                    muted
                                                    loop
                                                    autoPlay
                                                    playsInline
                                                />
                                            ) : reward.item_image_url ? (
                                                <Image
                                                    src={getStorageUrl(reward.item_image_url) || reward.item_image_url}
                                                    alt={reward.item_name}
                                                    fill
                                                    className="object-contain"
                                                />
                                            ) : (
                                                <Gift className="w-12 h-12 text-gray-400" />
                                            )}
                                            {reward.stock_quantity !== null && reward.stock_quantity < 10 && (
                                                <Badge className="absolute top-2 right-2 bg-red-500 text-white text-[10px]">
                                                    {reward.stock_quantity} left
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="p-3">
                                            <p className="text-sm font-medium text-gray-900 line-clamp-1">{reward.item_name}</p>
                                            <p className="text-xs text-gray-500 line-clamp-1 mt-0.5">{reward.item_description || 'Redeem your points'}</p>
                                            <div className="flex items-center justify-between mt-2">
                                                <div className="flex items-center gap-1">
                                                    <Star className={`w-3 h-3 ${(reward as any).category === 'point' ? 'text-green-500 fill-green-500' : 'text-amber-500 fill-amber-500'}`} />
                                                    {(reward as any).category === 'point' ? (
                                                        <span className="text-sm font-bold text-green-600">+{(reward as any).point_reward_amount || 0} pts</span>
                                                    ) : reward.point_offer ? (
                                                        <div className="flex flex-col leading-none">
                                                            <span className="text-[10px] text-gray-400 line-through">{formatNumber(reward.points_required)}</span>
                                                            <span className="text-sm font-bold text-red-500">{formatNumber(reward.point_offer)}</span>
                                                        </div>
                                                    ) : (
                                                        <span className="text-sm font-bold" style={{ color: config.primary_color }}>
                                                            {formatNumber(reward.points_required)}
                                                        </span>
                                                    )}
                                                </div>
                                                <button
                                                    onClick={() => {
                                                        setSelectedRewardForDetail(reward)
                                                        setCurrentRewardImageIndex(0)
                                                        setShowRewardDetailModal(true)
                                                    }}
                                                    className="text-xs font-medium px-3 py-1.5 rounded-lg transition-all hover:scale-105 active:scale-95"
                                                    style={{
                                                        backgroundColor: `${config.button_color}15`,
                                                        color: config.button_color
                                                    }}
                                                >
                                                    View
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="col-span-2 text-center py-12 text-gray-500">
                                    <Gift className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                    <p className="text-sm">No rewards available</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* SCANNED - Show scanned products */}
                    {rewardCategory === 'Scanned' && (
                        <div className="space-y-3">
                            {!isAuthenticated ? (
                                <div className="text-center py-12 text-gray-500">
                                    <Package className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                    <p className="text-sm">Please login to view scanned products</p>
                                </div>
                            ) : loadingScannedProducts ? (
                                <div className="text-center py-12">
                                    <div className="w-8 h-8 border-2 border-gray-300 border-t-primary rounded-full animate-spin mx-auto" />
                                </div>
                            ) : scannedProducts.length > 0 ? (
                                <>
                                    {/* View Toggle */}
                                    <div className="flex justify-end gap-2 mb-3">
                                        <button
                                            onClick={() => setScannedViewMode('list')}
                                            className={`p-2 rounded-lg transition-colors ${scannedViewMode === 'list'
                                                ? 'bg-gray-900 text-white'
                                                : 'bg-white text-gray-600 border border-gray-200'
                                                }`}
                                        >
                                            <List className="w-4 h-4" />
                                        </button>
                                        <button
                                            onClick={() => setScannedViewMode('grid')}
                                            className={`p-2 rounded-lg transition-colors ${scannedViewMode === 'grid'
                                                ? 'bg-gray-900 text-white'
                                                : 'bg-white text-gray-600 border border-gray-200'
                                                }`}
                                        >
                                            <Grid3x3 className="w-4 h-4" />
                                        </button>
                                    </div>

                                    {/* List View */}
                                    {scannedViewMode === 'list' ? (
                                        <div className="space-y-3">
                                            {scannedProducts.slice((scannedPage - 1) * itemsPerPage, scannedPage * itemsPerPage).map((scan, idx) => (
                                                <div key={`${scan.product_name}-${scan.variant_name}-${idx}`} className="bg-white rounded-xl shadow-sm p-4 border border-gray-100">
                                                    <div className="flex gap-3">
                                                        <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                                                            {scan.image_url ? (
                                                                <Image
                                                                    src={getStorageUrl(scan.image_url) || scan.image_url}
                                                                    alt={scan.variant_name || 'Product'}
                                                                    width={64}
                                                                    height={64}
                                                                    className="object-cover"
                                                                />
                                                            ) : (
                                                                <Package className="w-8 h-8 text-gray-400" />
                                                            )}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className="text-sm font-medium text-gray-900 line-clamp-1">
                                                                {scan.product_name}
                                                            </p>
                                                            <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                                                                {scan.variant_name}
                                                            </p>
                                                            <div className="flex items-center gap-2 mt-2">
                                                                <Badge className="bg-blue-50 text-blue-700 border-blue-200 text-[10px]">
                                                                    {scan.scan_count} {scan.scan_count === 1 ? 'scan' : 'scans'}
                                                                </Badge>
                                                                <span className="text-xs font-semibold text-green-600">
                                                                    +{scan.total_points} pts
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        /* Grid View */
                                        <div className="grid grid-cols-2 gap-3">
                                            {scannedProducts.slice((scannedPage - 1) * itemsPerPage, scannedPage * itemsPerPage).map((scan, idx) => (
                                                <div key={`${scan.product_name}-${scan.variant_name}-${idx}`} className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-100">
                                                    <div className="h-32 bg-gray-100 flex items-center justify-center overflow-hidden">
                                                        {scan.image_url ? (
                                                            <Image
                                                                src={getStorageUrl(scan.image_url) || scan.image_url}
                                                                alt={scan.variant_name || 'Product'}
                                                                width={128}
                                                                height={128}
                                                                className="object-cover w-full h-full"
                                                            />
                                                        ) : (
                                                            <Package className="w-12 h-12 text-gray-400" />
                                                        )}
                                                    </div>
                                                    <div className="p-3">
                                                        <p className="text-sm font-medium text-gray-900 line-clamp-1">
                                                            {scan.product_name}
                                                        </p>
                                                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                                                            {scan.variant_name}
                                                        </p>
                                                        <div className="flex items-center justify-between mt-2">
                                                            <Badge className="bg-blue-50 text-blue-700 border-blue-200 text-[10px]">
                                                                {scan.scan_count}x
                                                            </Badge>
                                                            <span className="text-xs font-semibold text-green-600">
                                                                +{scan.total_points}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* Pagination */}
                                    {scannedProducts.length > itemsPerPage && (
                                        <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                                            <button
                                                onClick={() => setScannedPage(Math.max(1, scannedPage - 1))}
                                                disabled={scannedPage === 1}
                                                className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                <ChevronLeft className="w-4 h-4" />
                                                Previous
                                            </button>
                                            <span className="text-sm text-gray-600">
                                                Page {scannedPage} of {Math.ceil(scannedProducts.length / itemsPerPage)}
                                            </span>
                                            <button
                                                onClick={() => setScannedPage(Math.min(Math.ceil(scannedProducts.length / itemsPerPage), scannedPage + 1))}
                                                disabled={scannedPage >= Math.ceil(scannedProducts.length / itemsPerPage)}
                                                className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                Next
                                                <ChevronRight className="w-4 h-4" />
                                            </button>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div className="text-center py-12 text-gray-500">
                                    <Package className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                    <p className="text-sm">No scanned products yet</p>
                                    <p className="text-xs mt-1">Scan QR codes to see them here</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* POINT HISTORY - Show points transactions */}
                    {rewardCategory === 'Point History' && (
                        <div className="space-y-3">
                            {!isAuthenticated ? (
                                <div className="text-center py-12 text-gray-500">
                                    <Star className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                    <p className="text-sm">Please login to view points history</p>
                                </div>
                            ) : loadingPointsHistory ? (
                                <div className="text-center py-12">
                                    <div className="w-8 h-8 border-2 border-gray-300 border-t-primary rounded-full animate-spin mx-auto" />
                                </div>
                            ) : pointsHistory.length > 0 ? (
                                <>
                                    {pointsHistory.slice((pointsPage - 1) * itemsPerPage, pointsPage * itemsPerPage).map((txn) => (
                                        <div key={txn.id} className="bg-white rounded-xl shadow-sm p-4 border border-gray-100">
                                            <div className="flex items-center gap-3">
                                                <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                                                    {txn.image_url ? (
                                                        <Image
                                                            src={getStorageUrl(txn.image_url) || txn.image_url}
                                                            alt={txn.product_name || 'Transaction'}
                                                            width={48}
                                                            height={48}
                                                            className="object-cover"
                                                        />
                                                    ) : txn.points > 0 ? (
                                                        <TrendingUp className="w-6 h-6 text-green-600" />
                                                    ) : (
                                                        <Gift className="w-6 h-6 text-purple-600" />
                                                    )}
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium text-gray-900 line-clamp-1">
                                                        {txn.product_name || txn.description || (txn.points > 0 ? 'Points Earned' : 'Points Redeemed')}
                                                    </p>
                                                    {txn.variant_name && (
                                                        <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                                                            {txn.variant_name}
                                                        </p>
                                                    )}
                                                    <p className="text-xs text-gray-400 mt-1">
                                                        {formatDate(txn.date)}
                                                    </p>
                                                </div>
                                                <div className="text-right">
                                                    <p className={`text-sm font-bold ${txn.points > 0 ? 'text-green-600' : 'text-purple-600'
                                                        }`}>
                                                        {txn.points > 0 ? '+' : ''}{txn.points} pts
                                                    </p>
                                                    {txn.balance_after !== null && txn.balance_after !== undefined && (
                                                        <p className="text-xs text-gray-400">
                                                            Balance: {txn.balance_after}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))}

                                    {/* Pagination */}
                                    {pointsHistory.length > itemsPerPage && (
                                        <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                                            <button
                                                onClick={() => setPointsPage(Math.max(1, pointsPage - 1))}
                                                disabled={pointsPage === 1}
                                                className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                <ChevronLeft className="w-4 h-4" />
                                                Previous
                                            </button>
                                            <span className="text-sm text-gray-600">
                                                Page {pointsPage} of {Math.ceil(pointsHistory.length / itemsPerPage)}
                                            </span>
                                            <button
                                                onClick={() => setPointsPage(Math.min(Math.ceil(pointsHistory.length / itemsPerPage), pointsPage + 1))}
                                                disabled={pointsPage >= Math.ceil(pointsHistory.length / itemsPerPage)}
                                                className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                Next
                                                <ChevronRight className="w-4 h-4" />
                                            </button>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div className="text-center py-12 text-gray-500">
                                    <Star className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                    <p className="text-sm">No points history yet</p>
                                    <p className="text-xs mt-1">Collect points to see them here</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* HISTORY - Show redemption history */}
                    {rewardCategory === 'History' && (
                        <div className="space-y-3">
                            {!isAuthenticated ? (
                                <div className="text-center py-12 text-gray-500">
                                    <Gift className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                    <p className="text-sm">Please login to view redemption history</p>
                                </div>
                            ) : loadingRedemptionHistory ? (
                                <div className="text-center py-12">
                                    <div className="w-8 h-8 border-2 border-gray-300 border-t-primary rounded-full animate-spin mx-auto" />
                                </div>
                            ) : redemptionHistory.length > 0 ? (
                                <>
                                    {redemptionHistory.slice((redemptionPage - 1) * itemsPerPage, redemptionPage * itemsPerPage).map((redemption) => {
                                        const statusColors = getStatusColor(redemption.status)
                                        return (
                                            <div key={redemption.id} className="bg-white rounded-xl shadow-sm p-4 border border-gray-100">
                                                <div className="flex gap-3">
                                                    <div className="w-16 h-16 rounded-lg bg-gray-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                                                        {redemption.reward?.image_url ? (
                                                            <Image
                                                                src={getStorageUrl(redemption.reward.image_url) || redemption.reward.image_url}
                                                                alt={redemption.reward?.name || 'Reward'}
                                                                width={64}
                                                                height={64}
                                                                className="object-cover"
                                                            />
                                                        ) : (
                                                            <Gift className="w-8 h-8 text-gray-400" />
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-medium text-gray-900 line-clamp-1">
                                                            {redemption.reward?.name || redemption.description || 'Reward Redeemed'}
                                                        </p>
                                                        <p className="text-xs text-gray-500 mt-0.5">
                                                            {formatDate(redemption.date)}
                                                        </p>
                                                        <div className="flex items-center gap-2 mt-2">
                                                            <Badge className={`${statusColors.bg} ${statusColors.text} text-[10px] capitalize`}>
                                                                {redemption.status}
                                                            </Badge>
                                                            {redemption.redemption_code && (
                                                                <span className="text-xs text-gray-500 font-mono">
                                                                    {redemption.redemption_code}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className="text-sm font-bold text-purple-600">
                                                            -{redemption.points_deducted} pts
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        )
                                    })}

                                    {/* Pagination */}
                                    {redemptionHistory.length > itemsPerPage && (
                                        <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                                            <button
                                                onClick={() => setRedemptionPage(Math.max(1, redemptionPage - 1))}
                                                disabled={redemptionPage === 1}
                                                className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                <ChevronLeft className="w-4 h-4" />
                                                Previous
                                            </button>
                                            <span className="text-sm text-gray-600">
                                                Page {redemptionPage} of {Math.ceil(redemptionHistory.length / itemsPerPage)}
                                            </span>
                                            <button
                                                onClick={() => setRedemptionPage(Math.min(Math.ceil(redemptionHistory.length / itemsPerPage), redemptionPage + 1))}
                                                disabled={redemptionPage >= Math.ceil(redemptionHistory.length / itemsPerPage)}
                                                className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                Next
                                                <ChevronRight className="w-4 h-4" />
                                            </button>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div className="text-center py-12 text-gray-500">
                                    <Gift className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                                    <p className="text-sm">No redemptions yet</p>
                                    <p className="text-xs mt-1">Redeem rewards to see them here</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
                {renderBanner('rewards', 'bottom')}
            </div>
        )
    }

    // Render Lucky Draw Tab
    const renderLuckyDrawTab = () => (
        <div className="flex-1 overflow-y-auto pb-20 bg-gray-50">
            {/* Header with animated elements */}
            <div
                className="px-5 pt-6 pb-16 text-white text-center relative overflow-hidden"
                style={{
                    background: `linear-gradient(135deg, #f59e0b 0%, #d97706 100%)`
                }}
            >
                {/* Animated floating circles */}
                <div className="absolute inset-0">
                    <div className="absolute top-4 left-4 w-8 h-8 rounded-full bg-white/20 animate-pulse" />
                    <div className="absolute top-12 right-8 w-4 h-4 rounded-full bg-white/30 animate-bounce" style={{ animationDelay: '0.5s' }} />
                    <div className="absolute bottom-8 left-12 w-6 h-6 rounded-full bg-white/20 animate-pulse" style={{ animationDelay: '1s' }} />
                    <div className="absolute bottom-4 right-4 w-10 h-10 rounded-full bg-white/15 animate-bounce" style={{ animationDelay: '0.3s' }} />
                    <div className="absolute top-1/2 left-1/4 w-3 h-3 rounded-full bg-yellow-300/40 animate-ping" style={{ animationDelay: '0.7s' }} />
                    <div className="absolute top-1/3 right-1/4 w-2 h-2 rounded-full bg-yellow-200/50 animate-ping" style={{ animationDelay: '1.2s' }} />
                </div>

                <div className="relative z-10">
                    {/* Animated Trophy */}
                    <div className="relative inline-block">
                        <div className="absolute inset-0 bg-yellow-300 rounded-full blur-xl opacity-30 animate-pulse" />
                        <Trophy className="w-16 h-16 mx-auto mb-3 text-yellow-200 relative z-10 drop-shadow-lg" />
                        {/* Sparkle effects */}
                        <Sparkles className="absolute -top-1 -right-1 w-5 h-5 text-yellow-300 animate-bounce" />
                        <Star className="absolute -bottom-1 -left-1 w-4 h-4 text-yellow-200 fill-yellow-200 animate-pulse" />
                    </div>
                    <h1 className="text-2xl font-bold mb-2 drop-shadow-md">Lucky Draw</h1>
                    <p className="text-white/90 text-sm">Enter for a chance to win amazing prizes!</p>
                </div>
            </div>

            {/* Entry Form Card */}
            <div className="px-5 -mt-8 relative z-20">
                {checkingQrStatus ? (
                    // Loading state while checking QR status
                    <div className="bg-white rounded-2xl shadow-lg p-8 text-center border border-amber-100">
                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-100 flex items-center justify-center animate-pulse">
                            <Loader2 className="w-8 h-8 text-amber-600 animate-spin" />
                        </div>
                        <p className="text-gray-600 text-sm">Checking entry status...</p>
                    </div>
                ) : luckyDrawEntered || luckyDrawQrUsed ? (
                    // Already entered - show nice animation
                    <div className="bg-white rounded-2xl shadow-lg p-6 text-center border border-amber-100 relative overflow-hidden">
                        {/* Confetti background animation */}
                        <div className="absolute inset-0 overflow-hidden pointer-events-none">
                            <div className="absolute top-0 left-1/4 w-2 h-2 bg-amber-400 rounded-full animate-bounce" style={{ animationDelay: '0s', animationDuration: '2s' }} />
                            <div className="absolute top-0 left-1/2 w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '0.3s', animationDuration: '2.3s' }} />
                            <div className="absolute top-0 left-3/4 w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.6s', animationDuration: '1.8s' }} />
                            <div className="absolute top-0 left-1/3 w-1 h-1 bg-pink-400 rounded-full animate-bounce" style={{ animationDelay: '0.9s', animationDuration: '2.5s' }} />
                            <div className="absolute top-0 left-2/3 w-1.5 h-1.5 bg-purple-400 rounded-full animate-bounce" style={{ animationDelay: '1.2s', animationDuration: '2.1s' }} />
                        </div>

                        {/* Animated success icon */}
                        <div className="relative inline-block mb-4">
                            <div className="absolute inset-0 bg-green-400 rounded-full blur-xl opacity-30 animate-pulse" />
                            <div className="w-20 h-20 mx-auto rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center shadow-lg relative">
                                <CheckCircle2 className="w-10 h-10 text-white drop-shadow-md" />
                                {/* Sparkle effect */}
                                <Sparkles className="absolute -top-1 -right-1 w-5 h-5 text-amber-400 animate-pulse" />
                            </div>
                        </div>

                        <h2 className="text-xl font-bold text-gray-900 mb-2">You're Already In!</h2>
                        <p className="text-gray-600 text-sm mb-4">
                            This QR code has already been used to enter the lucky draw. Good luck!
                        </p>

                        {customerName && (
                            <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl p-4 text-left border border-amber-200">
                                <p className="text-xs text-amber-700 font-medium mb-2 flex items-center gap-1">
                                    <Gift className="w-3 h-3" />
                                    Entry Details
                                </p>
                                <p className="text-sm font-semibold text-gray-900">{customerName}</p>
                                <p className="text-sm text-gray-600">{customerPhone}</p>
                                {customerEmail && <p className="text-sm text-gray-500">{customerEmail}</p>}
                            </div>
                        )}

                        {!customerName && (
                            <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-xl p-4 border border-green-200">
                                <p className="text-sm text-green-700 flex items-center justify-center gap-2">
                                    <Trophy className="w-4 h-4" />
                                    Entry confirmed! Winners will be announced soon.
                                </p>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="bg-white rounded-2xl shadow-lg p-5 border border-gray-100">
                        <h2 className="text-lg font-bold text-gray-900 mb-4">Enter Your Details</h2>

                        {/* Error message */}
                        {luckyDrawError && (
                            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl">
                                <p className="text-sm text-red-600">{luckyDrawError}</p>
                            </div>
                        )}

                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Full Name <span className="text-red-500">*</span>
                                </label>
                                <Input
                                    placeholder="Enter your full name"
                                    value={customerName}
                                    onChange={(e) => setCustomerName(e.target.value)}
                                    className="h-11"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Phone Number <span className="text-red-500">*</span>
                                </label>
                                <Input
                                    placeholder="e.g., 0123456789"
                                    value={customerPhone}
                                    onChange={(e) => handlePhoneChange(e.target.value)}
                                    className={`h-11 ${luckyDrawPhoneError ? 'border-red-300 focus:border-red-500 focus:ring-red-500' : ''}`}
                                />
                                {luckyDrawPhoneError && (
                                    <p className="text-xs text-red-500 mt-1">{luckyDrawPhoneError}</p>
                                )}
                                <p className="text-xs text-gray-400 mt-1">Malaysia mobile number format</p>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Email <span className="text-gray-400">(Optional)</span>
                                </label>
                                <Input
                                    type="email"
                                    placeholder="example@email.com"
                                    value={customerEmail}
                                    onChange={(e) => handleEmailChange(e.target.value)}
                                    className={`h-11 ${luckyDrawEmailError ? 'border-red-300 focus:border-red-500 focus:ring-red-500' : ''}`}
                                />
                                {luckyDrawEmailError && (
                                    <p className="text-xs text-red-500 mt-1">{luckyDrawEmailError}</p>
                                )}
                            </div>

                            <Button
                                onClick={handleLuckyDrawSubmit}
                                disabled={!customerName || !customerPhone || isSubmitting || !!luckyDrawPhoneError || !!luckyDrawEmailError}
                                className="w-full h-12 text-base font-semibold bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 shadow-lg"
                            >
                                {isSubmitting ? (
                                    <span className="flex items-center gap-2">
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                        Submitting...
                                    </span>
                                ) : (
                                    <span className="flex items-center gap-2">
                                        <Trophy className="w-5 h-5" />
                                        Enter Lucky Draw
                                    </span>
                                )}
                            </Button>
                        </div>
                    </div>
                )}
            </div>

            {/* Prizes Section */}
            <div className="px-5 mt-6">
                <h2 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
                    <Crown className="w-5 h-5 text-amber-500" />
                    Prizes to Win
                </h2>
                <div className="space-y-3">
                    {config.lucky_draw_prizes?.length ? (
                        config.lucky_draw_prizes.map((prize: any, index: number) => (
                            <div key={index} className="bg-white rounded-xl p-4 flex items-center gap-4 shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
                                <div className="w-20 h-20 rounded-xl bg-gradient-to-br from-amber-100 to-amber-200 flex items-center justify-center overflow-hidden flex-shrink-0 border border-amber-200">
                                    {prize.image_url ? (
                                        <img
                                            src={getStorageUrl(prize.image_url) || prize.image_url}
                                            alt={prize.name || `Prize ${index + 1}`}
                                            className="w-full h-full object-contain p-1"
                                        />
                                    ) : (
                                        <Crown className="w-10 h-10 text-amber-600" />
                                    )}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="font-semibold text-gray-900 truncate">{prize.name || `Prize ${index + 1}`}</p>
                                    <p className="text-sm text-gray-500 line-clamp-2">{prize.description || 'Amazing prize awaits!'}</p>
                                    {prize.quantity && (
                                        <p className="text-xs text-amber-600 mt-1 font-medium">{prize.quantity} available</p>
                                    )}
                                </div>
                            </div>
                        ))
                    ) : (
                        // Demo prizes
                        ['Grand Prize', '2nd Prize', '3rd Prize'].map((prize, index) => (
                            <div key={index} className="bg-white rounded-xl p-4 flex items-center gap-4 shadow-sm border border-gray-100">
                                <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-amber-100 to-amber-200 flex items-center justify-center">
                                    {index === 0 ? (
                                        <Crown className="w-8 h-8 text-amber-600" />
                                    ) : (
                                        <Trophy className="w-8 h-8 text-amber-600" />
                                    )}
                                </div>
                                <div className="flex-1">
                                    <p className="font-semibold text-gray-900">{prize}</p>
                                    <p className="text-sm text-gray-500">Amazing prize awaits!</p>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    )

    // Render Games Tab
    const renderGamesTab = () => (
        <div className="flex-1 overflow-y-auto pb-20 bg-gray-50">
            {/* Header */}
            <div
                className="px-5 pt-6 pb-8 text-white"
                style={{
                    background: `linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)`
                }}
            >
                <h1 className="text-xl font-bold mb-2">Games & Activities</h1>
                <p className="text-white/80 text-sm">Play games to earn bonus points!</p>
            </div>

            {/* Games Grid */}
            <div className="px-5 -mt-4 grid gap-4 relative z-10">
                {config.enable_scratch_card_game && activeGames.scratch && (
                    <button
                        onClick={() => handleProtectedAction('play-scratch-card')}
                        className="bg-white rounded-2xl shadow-lg p-5 text-left hover:shadow-xl transition-shadow"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                                <Ticket className="w-8 h-8 text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-bold text-gray-900">Scratch & Win</h3>
                                <p className="text-sm text-gray-500">Scratch to reveal your prize!</p>
                            </div>
                            <ChevronRight className="w-5 h-5 text-gray-400" />
                        </div>
                    </button>
                )}

                {/* Spin the Wheel */}
                {activeGames.spin && (
                    <button
                        onClick={() => handleProtectedAction('spin-wheel')}
                        className="bg-white rounded-2xl shadow-lg p-5 text-left hover:shadow-xl transition-shadow"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center">
                                <Gamepad2 className="w-8 h-8 text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-bold text-gray-900">Spin the Wheel</h3>
                                <p className="text-sm text-gray-500">Spin to win amazing rewards!</p>
                            </div>
                            <ChevronRight className="w-5 h-5 text-gray-400" />
                        </div>
                    </button>
                )}

                {/* Daily Quiz */}
                {activeGames.quiz && (
                    <button
                        onClick={() => handleProtectedAction('daily-quiz')}
                        className="bg-white rounded-2xl shadow-lg p-5 text-left hover:shadow-xl transition-shadow"
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
                                <Sparkles className="w-8 h-8 text-white" />
                            </div>
                            <div className="flex-1">
                                <h3 className="font-bold text-gray-900">Daily Quiz</h3>
                                <p className="text-sm text-gray-500">Answer questions to earn points!</p>
                            </div>
                            <ChevronRight className="w-5 h-5 text-gray-400" />
                        </div>
                    </button>
                )}
            </div>
        </div>
    )

    const handlePlayScratchCard = async () => {
        // Prevent re-scratching
        if (isScratching || scratchResult || scratchCardAlreadyPlayed) return

        setIsScratching(true)
        setScratchError(null)

        try {
            // Get phone from props or authenticated user
            const phone = consumerPhone || userPhone

            if (!phone) {
                // Check if user is authenticated but has no phone
                if (isAuthenticated) {
                    setScratchError('Please update your phone number in your profile to play.')
                } else {
                    setScratchError('Please login to play the scratch card game.')
                }
                setIsScratching(false)
                return
            }

            console.log('Playing scratch card with:', {
                journeyConfigId: config.id,
                phone,
                qrCodeId: qrCodeDbId
            })

            const { data, error } = await supabase.rpc('play_scratch_card_turn' as any, {
                p_journey_config_id: config.id,
                p_consumer_phone: phone,
                p_qr_code_id: qrCodeDbId // Pass the QR code ID for per-QR limit tracking
            }) as { data: any, error: any }

            console.log('Scratch card RPC response:', { data, error })

            if (error) throw error

            // Handle error response from RPC
            if (data?.error) {
                // Check for specific error codes
                if (data.code === 'QR_LIMIT_REACHED') {
                    setScratchCardAlreadyPlayed(true)
                    throw new Error('This QR code has already been used for scratch card.')
                }
                throw new Error(data.error)
            }

            // RPC returns: { success: true, reward: { name, type, value_points, ... }, play_id }
            const isWin = data.success === true || data.status === 'win'
            const rewardName = data.reward?.name || data.reward_name || 'No Prize'
            const points = data.reward?.value_points || data.points_value || 0
            const rewardType = data.reward?.type || data.reward_type || 'no_prize'

            console.log('Scratch card result:', { isWin, rewardName, points, rewardType })

            // Set result - this will trigger UI update
            const result = {
                isWin: isWin && rewardType !== 'no_prize',
                rewardName
            }
            setScratchResult(result)

            // Mark as played so user can't play again
            setScratchCardAlreadyPlayed(true)
            setScratchCardPreviousReward(rewardName)

            // Handle Win
            if (isWin && points > 0) {
                // Play sound
                const audio = new Audio('/sounds/win.mp3')
                audio.play().catch(e => console.log('Audio play failed', e))

                // Show animation for points
                setPreviousBalance(userPoints)
                setTotalBalance(userPoints + points)
                setPointsEarned(points)
                setShowPointsSuccessModal(true)

                // Update local balance immediately for UI
                setUserPoints(prev => prev + points)

                // Also refresh balance from server to ensure sync
                // (The DB function now adds points automatically)
                if (isShopUser && userId) {
                    try {
                        const response = await fetch('/api/user/profile', {
                            credentials: 'include'
                        })
                        const result = await response.json()
                        if (result.success && result.profile?.pointsBalance !== undefined) {
                            console.log('Refreshed points balance from server:', result.profile.pointsBalance)
                            setUserPoints(result.profile.pointsBalance)
                            setTotalBalance(result.profile.pointsBalance)
                        }
                    } catch (refreshErr) {
                        console.error('Error refreshing balance:', refreshErr)
                    }
                }
            }

        } catch (err: any) {
            console.error('Scratch card error:', err)
            setScratchError(err.message || 'Failed to play. Please try again.')
            toast({
                title: "Error",
                description: err.message || "Failed to play scratch card",
                variant: "destructive"
            })
        } finally {
            setIsScratching(false)
        }
    }

    const renderScratchCardTab = () => (
        <div className="flex-1 overflow-y-auto bg-gray-50 flex flex-col">
            <div className="p-4 flex items-center gap-3 bg-white shadow-sm z-10">
                <button onClick={() => setActiveTab('games')} className="p-2 -ml-2">
                    <ArrowLeft className="w-6 h-6 text-gray-600" />
                </button>
                <h1 className="text-lg font-bold">Scratch & Win</h1>
            </div>
            <div className="flex-1 p-6 flex items-center justify-center flex-col gap-4">
                {/* Show "Already Played" message with nice animation */}
                {scratchCardAlreadyPlayed && !scratchResult ? (
                    <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-6 text-center animate-in fade-in zoom-in duration-500">
                        {/* Animated gift box icon */}
                        <div className="mb-4 relative">
                            <div className="w-24 h-24 mx-auto bg-gradient-to-br from-amber-400 to-orange-500 rounded-2xl flex items-center justify-center shadow-lg animate-bounce">
                                <Gift className="w-12 h-12 text-white" />
                            </div>
                            {/* Sparkle effects */}
                            <div className="absolute -top-2 -right-2 w-6 h-6 text-yellow-400 animate-ping">✨</div>
                            <div className="absolute -bottom-1 -left-2 w-5 h-5 text-yellow-400 animate-pulse">⭐</div>
                        </div>

                        <h3 className="text-xl font-bold text-gray-900 mb-2">
                            🎉 You've Already Played!
                        </h3>

                        {scratchCardPreviousReward && (
                            <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-xl p-4 mb-4">
                                <p className="text-sm text-green-700 mb-1">Your prize:</p>
                                <p className="text-lg font-bold text-green-800">{scratchCardPreviousReward}</p>
                            </div>
                        )}

                        <p className="text-gray-600 mb-4 leading-relaxed">
                            This QR code has already been used for the scratch card game.
                            <br />
                            <span className="text-sm text-gray-500">Scan a new QR code to play again!</span>
                        </p>

                        {/* Fun illustration */}
                        <div className="text-4xl mb-4 animate-pulse">
                            🎁 → 📱 → 🎰
                        </div>

                        <button
                            onClick={() => setActiveTab('home')}
                            className="w-full py-3 px-4 rounded-xl font-semibold text-white transition-all duration-300 hover:scale-105 active:scale-95"
                            style={{ backgroundColor: config.primary_color }}
                        >
                            Back to Home
                        </button>
                    </div>
                ) : (
                    <>
                        {scratchError && (
                            <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm text-center w-full max-w-sm">
                                {scratchError}
                                {!isAuthenticated && scratchError.includes('login') && (
                                    <button
                                        onClick={() => setActiveTab('profile')}
                                        className="mt-2 block w-full py-2 px-4 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                                    >
                                        Go to Login
                                    </button>
                                )}
                                {isAuthenticated && scratchError.includes('phone') && (
                                    <button
                                        onClick={() => setActiveTab('account-settings')}
                                        className="mt-2 block w-full py-2 px-4 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                                    >
                                        Update Profile
                                    </button>
                                )}
                            </div>
                        )}
                        <ScratchCard
                            primaryColor={config.primary_color}
                            titleText={config.scratch_card_title || 'Scratch & Win'}
                            successMessage="You won: {{reward_name}}"
                            noPrizeMessage="Better luck next time!"
                            result={scratchResult}
                            isScratching={isScratching}
                            onScratchComplete={handlePlayScratchCard}
                            theme="modern"
                        />
                        {!scratchResult && !isScratching && (
                            <p className="text-sm text-gray-500 text-center animate-pulse">
                                Tap or scratch to play!
                            </p>
                        )}
                    </>
                )}
            </div>
        </div>
    )

    const renderSpinWheelTab = () => (
        <div className="flex-1 overflow-y-auto bg-gray-50 flex flex-col">
            <div className="p-4 flex items-center gap-3 bg-white shadow-sm z-10">
                <button onClick={() => setActiveTab('games')} className="p-2 -ml-2">
                    <ArrowLeft className="w-6 h-6 text-gray-600" />
                </button>
                <h1 className="text-lg font-bold">Spin the Wheel</h1>
            </div>
            <div className="flex-1 p-6 flex items-center justify-center">
                <SpinWheelGame
                    primaryColor={config.primary_color}
                    journeyId={config.id}
                    qrCode={qrCode}
                    onSpinComplete={() => {
                        // Handle completion logic
                    }}
                />
            </div>
        </div>
    )

    const renderDailyQuizTab = () => (
        <div className="flex-1 overflow-y-auto bg-gray-50 flex flex-col">
            <div className="p-4 flex items-center gap-3 bg-white shadow-sm z-10">
                <button onClick={() => setActiveTab('games')} className="p-2 -ml-2">
                    <ArrowLeft className="w-6 h-6 text-gray-600" />
                </button>
                <h1 className="text-lg font-bold">Daily Quiz</h1>
            </div>
            <div className="flex-1 p-6">
                <DailyQuizGame
                    primaryColor={config.primary_color}
                    journeyId={config.id}
                    qrCode={qrCode}
                    onQuizComplete={(score) => {
                        // Handle completion logic
                    }}
                />
            </div>
        </div>
    )

    // Render Products Tab
    const renderProductsTab = () => {
        if (selectedProduct) {
            return (
                <div className="flex-1 overflow-y-auto pb-20 bg-gray-50">
                    {/* Header */}
                    <div
                        className="px-5 pt-6 pb-8 text-white sticky top-0 z-30"
                        style={{
                            background: `linear-gradient(135deg, ${config.primary_color} 0%, ${adjustColor(config.primary_color, -20)} 100%)`
                        }}
                    >
                        <button
                            onClick={() => setSelectedProduct(null)}
                            className="flex items-center gap-2 text-white/90 hover:text-white mb-4 transition-colors"
                        >
                            <ArrowLeft className="w-5 h-5" />
                            <span className="font-medium">Back to Catalog</span>
                        </button>
                        <h1 className="text-xl font-bold mb-1">{selectedProduct.product_name}</h1>
                        <p className="text-white/80 text-sm">{selectedProduct.brand_name}</p>
                    </div>

                    {/* Product Details */}
                    <div className="px-5 -mt-4 relative z-20 space-y-4">
                        {/* Main Product Card */}
                        <div className="bg-white rounded-2xl shadow-sm overflow-hidden border border-gray-100 p-4">
                            <div className="aspect-video relative rounded-xl overflow-hidden bg-gray-100 mb-4">
                                {selectedProduct.primary_image_url ? (
                                    <Image
                                        src={getStorageUrl(selectedProduct.primary_image_url) || selectedProduct.primary_image_url}
                                        alt={selectedProduct.product_name}
                                        fill
                                        className="object-contain"
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Package className="w-12 h-12 text-gray-300" />
                                    </div>
                                )}
                            </div>
                            <p className="text-sm text-gray-600">{selectedProduct.product_description}</p>
                        </div>

                        {/* Variants List */}
                        <h3 className="text-lg font-bold text-gray-900 px-1">
                            Available Variants ({selectedProduct.variants?.length || 0})
                        </h3>

                        <div className="grid grid-cols-2 gap-3">
                            {selectedProduct.variants?.map((variant) => (
                                <div
                                    key={variant.id}
                                    className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden flex flex-col h-full cursor-pointer active:scale-[0.98] transition-transform"
                                    onClick={() => setSelectedVariantForDetail({ ...variant, product: selectedProduct })}
                                >
                                    <div className="aspect-square relative bg-gray-50">
                                        <VariantMedia
                                            variant={variant}
                                            onClick={(v) => setSelectedVariantForDetail({ ...v, product: selectedProduct })}
                                        />
                                    </div>
                                    <div className="p-3 flex flex-col flex-1">
                                        <div className="font-medium text-gray-900 text-sm mb-1 flex-1">
                                            {variant.variant_name.includes('[') ? (
                                                <>
                                                    <span className="block">{variant.variant_name.split('[')[0]}</span>
                                                    <span className="block text-xs text-gray-500 mt-0.5">[{variant.variant_name.split('[')[1]}</span>
                                                </>
                                            ) : (
                                                variant.variant_name
                                            )}
                                        </div>
                                        {!selectedProduct.hide_price && (
                                            <div className="mt-auto">
                                                {variant.other_price && variant.other_price > 0 && variant.suggested_retail_price ? (
                                                    <div className="flex flex-col items-start gap-0.5">
                                                        <div className="flex items-center flex-wrap gap-1">
                                                            <span className="text-sm font-bold text-[#FF5722]">
                                                                RM {variant.other_price.toFixed(2)}
                                                            </span>
                                                            <span className="text-[10px] bg-[#FFEEE8] text-[#FF5722] px-1 rounded font-medium">
                                                                -{Math.round(((variant.suggested_retail_price - variant.other_price) / variant.suggested_retail_price) * 100)}%
                                                            </span>
                                                        </div>

                                                        <div className="flex items-center flex-wrap gap-1">
                                                            <span className="text-[10px] text-gray-400 line-through">
                                                                RM {variant.suggested_retail_price.toFixed(2)}
                                                            </span>
                                                            <div className="flex items-center border border-[#FF5722] rounded px-1">
                                                                <span className="text-[9px] text-[#FF5722] font-medium">
                                                                    RM{(variant.suggested_retail_price - variant.other_price).toFixed(0)} off
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    variant.suggested_retail_price && (
                                                        <p className="text-sm font-bold" style={{ color: config.primary_color }}>
                                                            RM {variant.suggested_retail_price.toFixed(2)}
                                                        </p>
                                                    )
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )
        }

        return (
            <div className="flex-1 overflow-y-auto pb-20 bg-gray-50">
                {/* Header */}
                <div
                    className="px-5 pt-6 pb-8 text-white"
                    style={{
                        background: `linear-gradient(135deg, ${config.primary_color} 0%, ${adjustColor(config.primary_color, -20)} 100%)`
                    }}
                >
                    <h1 className="text-xl font-bold mb-2">Product Catalog</h1>
                    <p className="text-white/80 text-sm">Discover our amazing products</p>
                </div>

                {/* Products Grid */}
                <div className="px-5 -mt-4 relative z-20">
                    {renderBanner('products', 'top')}
                    {loadingProducts ? (
                        <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
                            <Loader2 className="w-8 h-8 mx-auto animate-spin text-gray-400" />
                            <p className="text-sm text-gray-500 mt-2">Loading products...</p>
                        </div>
                    ) : products.length > 0 ? (
                        <div className="space-y-4">
                            {products.map((product) => (
                                <div
                                    key={product.id}
                                    className="bg-white rounded-2xl shadow-sm overflow-hidden border border-gray-100 active:scale-[0.98] transition-transform cursor-pointer"
                                    onClick={() => setSelectedProduct(product)}
                                >
                                    <div className="flex">
                                        <div className="w-28 h-28 bg-gradient-to-br from-gray-100 to-gray-200 flex-shrink-0 flex items-center justify-center relative">
                                            {product.primary_image_url ? (
                                                <Image
                                                    src={getStorageUrl(product.primary_image_url) || product.primary_image_url}
                                                    alt={product.product_name}
                                                    fill
                                                    className="object-cover"
                                                />
                                            ) : (
                                                <Package className="w-10 h-10 text-gray-400" />
                                            )}
                                        </div>
                                        <div className="flex-1 p-4">
                                            <div className="flex items-start justify-between">
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-bold text-gray-900 line-clamp-1">{product.product_name}</p>
                                                    <p className="text-xs text-gray-500 mt-0.5">{product.brand_name}</p>
                                                </div>
                                                {product.category_name && (
                                                    <Badge variant="secondary" className="text-[10px] flex-shrink-0 ml-2">
                                                        {product.category_name}
                                                    </Badge>
                                                )}
                                            </div>
                                            {product.product_description && (
                                                <p className="text-xs text-gray-600 mt-2 line-clamp-2">{product.product_description}</p>
                                            )}
                                            {product.variants && product.variants.length > 0 && (
                                                <div className="mt-2 flex items-center gap-2">
                                                    <span className="text-xs text-gray-500">{product.variants.length} variant{product.variants.length > 1 ? 's' : ''}</span>
                                                    {product.variants[0].suggested_retail_price && !product.hide_price && (
                                                        <span className="text-sm font-bold" style={{ color: config.primary_color }}>
                                                            RM {product.variants[0].suggested_retail_price.toFixed(2)}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="bg-white rounded-2xl shadow-lg p-8 text-center">
                            <Package className="w-16 h-16 mx-auto text-gray-300" />
                            <h3 className="text-lg font-bold text-gray-900 mt-4">No Products Available</h3>
                            <p className="text-sm text-gray-500 mt-1">Check back soon for new products!</p>
                        </div>
                    )}
                    {renderBanner('products', 'bottom')}
                </div>
            </div>
        )
    }

    // Call to action button handlers
    const renderProfileTab = () => (
        <div className="flex-1 overflow-y-auto pb-6 bg-[var(--sera-mist)]">
            <div className="sera-collect__content sera-collect__profile-layout">
            <div className="sera-collect__profile-hero text-center">
                {/* Buttons moved to fixed position outside scroll container */}

                <div className="sera-collect__profile-logo">
                    <Image
                        src="/images/logo.png"
                        alt="Serapod"
                        width={320}
                        height={102}
                        className="sera-collect__hero-logo"
                        priority
                    />
                </div>

                <div className="sera-collect__profile-avatar relative z-10 w-20 h-20 mx-auto mb-4 rounded-full flex items-center justify-center overflow-hidden group">
                    {isAuthenticated && (
                        <>
                            <input
                                type="file"
                                ref={fileInputRef}
                                onChange={handleAvatarUpload}
                                className="hidden"
                                accept="image/*"
                            />
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity z-10"
                                disabled={isUploadingAvatar}
                            >
                                {isUploadingAvatar ? (
                                    <Loader2 className="w-6 h-6 text-white animate-spin" />
                                ) : (
                                    <Camera className="w-6 h-6 text-white" />
                                )}
                            </button>
                        </>
                    )}
                    {isAuthenticated && userAvatarUrl ? (
                        <img
                            src={userAvatarUrl}
                            alt="Profile"
                            className="object-cover w-full h-full"
                            key={userAvatarUrl} // Force re-render when avatar changes
                        />
                    ) : (
                        <User className="w-10 h-10" />
                    )}
                </div>
                <div className="sera-collect__profile-eyebrow relative z-10">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    {isAuthenticated ? 'Member profile' : 'Serapod2U rewards'}
                </div>
                <h1 className="relative z-10 font-display text-2xl font-bold tracking-tight md:text-3xl">
                    {isAuthenticated
                        ? (userName || 'User')
                        : 'Welcome to Serapod2U'}
                </h1>
                {isAuthenticated && isShopUser && shopName && (
                    <p className="relative z-10 text-white/70 text-xs mt-1">{shopName}</p>
                )}
                <p className="relative z-10 text-white/85 text-sm mt-1 md:text-base">
                    {isAuthenticated
                        ? (userEmail || 'No email')
                        : 'Sign in or create an account to collect points & redeem rewards'}
                </p>
            </div>

            <div className="sera-collect__profile-main px-4 relative z-10 space-y-5 pt-4 md:px-0 md:pt-0">
                {/* Login/Logout Section */}
                {!isAuthenticated ? (
                    <div className="sera-collect__panel sera-collect__panel--welcome p-5 md:p-6">
                        {showLoginForm ? (
                            <div className="space-y-4">
                                <div className="flex items-center justify-between mb-2">
                                    <h2 className="font-display text-lg font-bold text-[var(--sera-ink)]">
                                        {isSignUp ? 'Create Account' : 'Sign In'}
                                    </h2>
                                    <button
                                        onClick={() => {
                                            setShowLoginForm(false)
                                            setLoginError('')
                                            resetSignUpForm()
                                            setLoginEmail('')
                                            setLoginPassword('')
                                            setLoginLoading(false)
                                        }}
                                        className="p-1 rounded-full hover:bg-gray-100"
                                    >
                                        <X className="w-5 h-5 text-gray-500" />
                                    </button>
                                </div>

                                {loginError && (
                                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                                        <p className="text-sm text-red-600">{loginError}</p>
                                    </div>
                                )}

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">
                                        {isSignUp ? 'Email' : 'Email or Phone Number'}
                                    </label>
                                    <div className="relative">
                                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                        <Input
                                            type="text"
                                            placeholder={isSignUp ? "Enter your email address" : "Enter email or phone number"}
                                            value={loginEmail}
                                            onChange={(e) => {
                                                setLoginEmail(e.target.value)
                                                if (!isSignUp) {
                                                    setEmailError('')
                                                } else if (!e.target.value.trim()) {
                                                    setEmailError('')
                                                    setSignUpEmailStatus('idle')
                                                }
                                            }}
                                            className={`h-11 pl-10 ${(emailError || signUpEmailStatus === 'taken') ? 'border-red-500 focus-visible:ring-red-500' : signUpEmailStatus === 'available' ? 'border-green-500 focus-visible:ring-green-500' : ''}`}
                                            autoComplete="off"
                                            autoCorrect="off"
                                            autoCapitalize="off"
                                        />
                                        {isSignUp && signUpEmailStatus === 'checking' && (
                                            <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                                <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
                                            </div>
                                        )}
                                        {isSignUp && signUpEmailStatus === 'available' && !emailError && (
                                            <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                                <CheckCircle2 className="w-5 h-5 text-green-500" />
                                            </div>
                                        )}
                                        {(emailError || signUpEmailStatus === 'taken') && (
                                            <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                                <AlertCircle className="w-5 h-5 text-red-500" />
                                            </div>
                                        )}
                                    </div>
                                    {emailError && (
                                        <p className="text-xs text-red-500 mt-1">{emailError}</p>
                                    )}
                                    {!isSignUp && <p className="text-xs text-gray-500 mt-1">You can log in using your email or phone number.</p>}
                                </div>

                                {isSignUp && (
                                    <>
                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                                Full Name
                                            </label>
                                            <div className="relative">
                                                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                                <Input
                                                    ref={signUpNameInputRef}
                                                    type="text"
                                                    placeholder="Enter your full name"
                                                    value={signUpName}
                                                    onChange={(e) => {
                                                        setLoginError('')
                                                        let newValue = e.target.value
                                                        // Auto-capitalize words in Full Name when space is pressed
                                                        if (newValue.endsWith(' ') && newValue.length > 1) {
                                                            const words = newValue.split(' ')
                                                            if (words.length >= 2) {
                                                                const lastWordIndex = words.length - 2
                                                                const lastWord = words[lastWordIndex]
                                                                if (lastWord) {
                                                                    words[lastWordIndex] = lastWord.charAt(0).toUpperCase() + lastWord.slice(1).toLowerCase()
                                                                    newValue = words.join(' ')
                                                                }
                                                            }
                                                        }
                                                        setSignUpName(newValue)
                                                    }}
                                                    className="h-11 pl-10"
                                                    autoComplete="name"
                                                />
                                            </div>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                                Phone Number
                                            </label>
                                            <div className="relative">
                                                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                                <Input
                                                    ref={signUpPhoneInputRef}
                                                    type="tel"
                                                    placeholder="e.g., 0123456789"
                                                    value={signUpPhone}
                                                    onChange={(e) => {
                                                        setLoginError('')
                                                        setSignUpPhone(e.target.value)
                                                        if (!e.target.value.trim()) {
                                                            setPhoneError('')
                                                            setSignUpPhoneStatus('idle')
                                                        }
                                                    }}
                                                    className={`h-11 pl-10 ${(phoneError || signUpPhoneStatus === 'taken') ? 'border-red-500 focus-visible:ring-red-500' : signUpPhoneStatus === 'available' ? 'border-green-500 focus-visible:ring-green-500' : ''}`}
                                                    autoComplete="tel"
                                                />
                                                {signUpPhoneStatus === 'checking' && (
                                                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                                        <Loader2 className="w-5 h-5 text-gray-400 animate-spin" />
                                                    </div>
                                                )}
                                                {signUpPhoneStatus === 'available' && !phoneError && (
                                                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                                                    </div>
                                                )}
                                                {(phoneError || signUpPhoneStatus === 'taken') && (
                                                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                                                        <AlertCircle className="w-5 h-5 text-red-500" />
                                                    </div>
                                                )}
                                            </div>
                                            {phoneError && (
                                                <p className="text-xs text-red-500 mt-1">{phoneError}</p>
                                            )}
                                            {!phoneError && (
                                                <p className="text-xs text-gray-500 mt-1">Supported: Malaysia (+60) and China (+86) mobile numbers. A 4-digit verification code will be sent to your email before account creation.</p>
                                            )}
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                                Reference
                                            </label>
                                            <ReferencePicker
                                                inputRef={signUpReferenceInputRef}
                                                value={signUpReference}
                                                referenceUserId={signUpReferenceUserId}
                                                onSelect={(ref: ReferenceUser | null, phone: string) => {
                                                    setLoginError('')
                                                    const hadSelectedReference = Boolean(signUpReferenceUserId)
                                                    const nextReferenceUserId = ref?.user_id || null
                                                    setSignUpReference(phone)
                                                    setSignUpReferenceUserId(nextReferenceUserId)

                                                    if (ref) {
                                                        setSignUpReferenceTouched(true)
                                                        setSignUpReferenceError('')
                                                        return
                                                    }

                                                    if (!phone) {
                                                        setSignUpReferenceError(signUpReferenceTouched || signUpValidationAttempted ? resolveSignUpReferenceError('', null) : '')
                                                        return
                                                    }

                                                    setSignUpReferenceError(
                                                        signUpReferenceTouched || signUpValidationAttempted || hadSelectedReference
                                                            ? resolveSignUpReferenceError(phone, null)
                                                            : ''
                                                    )
                                                }}
                                                onBlur={(value: string, hasSelection: boolean) => {
                                                    setSignUpReferenceTouched(true)
                                                    setSignUpReferenceError(resolveSignUpReferenceError(value, hasSelection ? signUpReferenceUserId : null))
                                                }}
                                                placeholder="Search by name, phone, or email..."
                                            />
                                            {signUpReferenceError && (
                                                <p className="text-xs text-red-500 mt-1">{signUpReferenceError}</p>
                                            )}
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                                Shop Name
                                            </label>
                                            <ShopPicker
                                                inputRef={signUpShopInputRef}
                                                value={signUpShopName}
                                                onSelect={(shop: ShopResult | null, displayName: string) => {
                                                    setLoginError('')
                                                    const hadSelectedShop = Boolean(signUpShopOrganizationId || signUpPendingShopRequest)
                                                    const nextShopOrganizationId = shop?.org_id || null

                                                    if (registrationOtpRequested && (nextShopOrganizationId !== signUpShopOrganizationId || Boolean(signUpPendingShopRequest))) {
                                                        resetRegistrationVerificationState()
                                                    }

                                                    setSignUpShopName(displayName)
                                                    setSignUpShopOrganizationId(nextShopOrganizationId)

                                                    if (shop) {
                                                        setSignUpPendingShopRequest(null)
                                                        setSignUpShopTouched(true)
                                                        setSignUpShopError('')
                                                        return
                                                    }

                                                    setSignUpPendingShopRequest(null)

                                                    if (!displayName) {
                                                        setSignUpShopError(signUpShopTouched || signUpValidationAttempted ? resolveSignUpShopError('', null) : '')
                                                        return
                                                    }

                                                    setSignUpShopError(
                                                        signUpShopTouched || signUpValidationAttempted || hadSelectedShop
                                                            ? resolveSignUpShopError(displayName, null)
                                                            : ''
                                                    )
                                                }}
                                                onBlur={(value: string, hasSelection: boolean) => {
                                                    setSignUpShopTouched(true)
                                                    setSignUpShopError(resolveSignUpShopError(value, hasSelection ? signUpShopOrganizationId : null))
                                                }}
                                                onCreateRequest={(shopName) => {
                                                    setPendingSignUpShopRequestName(toTitleCaseWords(shopName.trim()))
                                                    setIsSignUpShopRequestOpen(true)
                                                }}
                                                placeholder="Search shop by name..."
                                                maxLength={120}
                                            />
                                            {signUpShopError && (
                                                <p className="text-xs text-red-500 mt-1">{signUpShopError}</p>
                                            )}
                                            <CreateShopDialog
                                                open={isSignUpShopRequestOpen}
                                                onOpenChange={(open) => {
                                                    setIsSignUpShopRequestOpen(open)
                                                    if (!open) {
                                                        setPendingSignUpShopRequestName('')
                                                    }
                                                }}
                                                defaultShopName={pendingSignUpShopRequestName}
                                                mode="prepare-registration"
                                                linkUser={false}
                                                verificationOrgId={orgId}
                                                onCreated={(org) => {
                                                    if (registrationOtpRequested) {
                                                        resetRegistrationVerificationState()
                                                    }

                                                    const displayName = org.org_name + (org.branch ? ` (${org.branch})` : '')
                                                    setIsSignUpShopRequestOpen(false)
                                                    setPendingSignUpShopRequestName('')
                                                    setSignUpPendingShopRequest(null)
                                                    setSignUpShopName(displayName)
                                                    setSignUpShopOrganizationId(org.id)
                                                    setSignUpShopTouched(true)
                                                    setSignUpShopError('')
                                                    setLoginError('')
                                                }}
                                            />
                                        </div>
                                    </>
                                )}

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">
                                        Password
                                    </label>
                                    <div className="relative">
                                        <Input
                                            ref={signUpPasswordInputRef}
                                            type={showPassword ? 'text' : 'password'}
                                            placeholder="Enter your password"
                                            value={loginPassword}
                                            onChange={(e) => {
                                                setLoginError('')
                                                setLoginPassword(e.target.value)
                                                applySignUpPasswordValidation({
                                                    password: e.target.value,
                                                    showPassword: signUpPasswordTouched || signUpValidationAttempted,
                                                    showConfirmPassword: signUpConfirmPasswordTouched || signUpValidationAttempted || Boolean(signUpConfirmPassword),
                                                })
                                            }}
                                            onBlur={() => {
                                                setSignUpPasswordTouched(true)
                                                applySignUpPasswordValidation({
                                                    showPassword: true,
                                                    showConfirmPassword: signUpConfirmPasswordTouched || signUpValidationAttempted || Boolean(signUpConfirmPassword),
                                                })
                                            }}
                                            className="h-11 pr-10"
                                            autoComplete="new-password"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(!showPassword)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2"
                                        >
                                            {showPassword ? (
                                                <EyeOff className="w-5 h-5 text-gray-400" />
                                            ) : (
                                                <Eye className="w-5 h-5 text-gray-400" />
                                            )}
                                        </button>
                                    </div>
                                    {isSignUp && <p className="text-xs text-gray-500 mt-1">Minimum 6 characters</p>}
                                    {isSignUp && signUpPasswordError && (
                                        <p className="text-xs text-red-500 mt-1">{signUpPasswordError}</p>
                                    )}
                                </div>

                                {isSignUp && (
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">
                                            Confirm Password
                                        </label>
                                        <div className="relative">
                                            <Input
                                                ref={signUpConfirmPasswordInputRef}
                                                type={showConfirmPassword ? 'text' : 'password'}
                                                placeholder="Re-enter your password"
                                                value={signUpConfirmPassword}
                                                onChange={(e) => {
                                                    setLoginError('')
                                                    setSignUpConfirmPasswordTouched(true)
                                                    setSignUpConfirmPassword(e.target.value)
                                                    applySignUpPasswordValidation({
                                                        confirmPassword: e.target.value,
                                                        showPassword: signUpPasswordTouched || signUpValidationAttempted || Boolean(loginPassword),
                                                        showConfirmPassword: true,
                                                    })
                                                }}
                                                onBlur={() => {
                                                    setSignUpConfirmPasswordTouched(true)
                                                    applySignUpPasswordValidation({
                                                        showPassword: signUpPasswordTouched || signUpValidationAttempted || Boolean(loginPassword),
                                                        showConfirmPassword: true,
                                                    })
                                                }}
                                                className={`h-11 pr-10 ${signUpPasswordSuccess
                                                    ? 'border-green-500 focus-visible:ring-green-500'
                                                    : signUpConfirmPasswordError
                                                        ? 'border-red-500 focus-visible:ring-red-500'
                                                        : ''
                                                    }`}
                                                autoComplete="new-password"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                                                className="absolute right-3 top-1/2 -translate-y-1/2"
                                            >
                                                {showConfirmPassword ? (
                                                    <EyeOff className="w-5 h-5 text-gray-400" />
                                                ) : (
                                                    <Eye className="w-5 h-5 text-gray-400" />
                                                )}
                                            </button>
                                        </div>
                                        {signUpConfirmPasswordError && (
                                            <p className="text-xs text-red-500 mt-1">{signUpConfirmPasswordError}</p>
                                        )}
                                        {signUpPasswordSuccess && !signUpConfirmPasswordError && (
                                            <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                                                <Check className="w-3 h-3" /> {signUpPasswordSuccess}
                                            </p>
                                        )}
                                    </div>
                                )}

                                <Button
                                    onClick={handleLogin}
                                    disabled={loginLoading || registrationOtpSending || (!isSignUp && (!loginEmail || !loginPassword))}
                                    className="w-full h-11 font-semibold"
                                    style={{ backgroundColor: config.button_color }}
                                >
                                    {loginLoading ? (
                                        <>
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                            {isSignUp ? 'Creating Account...' : 'Signing In...'}
                                        </>
                                    ) : registrationOtpSending ? (
                                        <>
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                            Sending Email Code...
                                        </>
                                    ) : (
                                        isSignUp ? 'Create Account' : 'Sign In'
                                    )}
                                </Button>

                                {!isSignUp && (
                                    <div className="text-center">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setForgotPasswordReturnTarget('profile')
                                                setShowForgotPasswordModal(true)
                                            }}
                                            className="text-sm font-medium hover:underline"
                                            style={{ color: config.primary_color }}
                                        >
                                            Forgot Password?
                                        </button>
                                    </div>
                                )}

                                <div className="text-center">
                                    <button
                                        onClick={() => {
                                            setLoginError('')
                                            setEmailError('')
                                            setPhoneError('')
                                            setSignUpEmailStatus('idle')
                                            setSignUpPhoneStatus('idle')
                                            resetRegistrationVerificationState()
                                            setIsSignUp(!isSignUp)
                                        }}
                                        className="text-sm font-medium"
                                        style={{ color: config.primary_color }}
                                    >
                                        {isSignUp ? 'Already have an account? Sign In' : "Don't have an account? Sign Up"}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="text-center space-y-5">
                                <div className="sera-collect__panel-intro-icon" aria-hidden="true">
                                    <Gift className="h-6 w-6" />
                                </div>
                                <div>
                                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--sera-orange)]">Collect Points</p>
                                    <h2 className="font-display mt-1 text-xl font-bold text-[var(--sera-ink)]">Get started</h2>
                                    <p className="mt-1.5 text-sm text-[var(--sera-muted)]">
                                        Sign in if you already have an account, or create a new one to start earning rewards.
                                    </p>
                                </div>
                                <div className="space-y-2.5">
                                    <Button
                                        onClick={() => {
                                            setIsSignUp(false)
                                            setShowLoginForm(true)
                                            setLoginError('')
                                        }}
                                        className="sera-collect__cta-primary h-11 font-semibold"
                                    >
                                        <LogIn className="w-4 h-4 mr-2" />
                                        Sign In
                                    </Button>
                                    <Button
                                        onClick={() => {
                                            setIsSignUp(true)
                                            setShowLoginForm(true)
                                            setLoginError('')
                                        }}
                                        variant="outline"
                                        className="sera-collect__cta-secondary h-11 font-semibold"
                                    >
                                        Create Account
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>
                ) : null}

                {/* Stats Section - Only show when authenticated */}
                {isAuthenticated && (
                    <div className="sera-collect__panel divide-y divide-[var(--sera-line)]">
                        <div className="p-4 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <Star className="w-5 h-5 text-amber-500" />
                                <span className="font-medium text-[var(--sera-ink)]">Total Points</span>
                            </div>
                            <span className="font-bold text-[var(--sera-orange)]">{userPoints}</span>
                        </div>
                    </div>
                )}

            </div>
            </div>

            <div className="sera-collect__content sera-collect__profile-banners">
                {renderBanner('profile', 'top')}
                {renderBanner('profile', 'bottom')}
            </div>
        </div>
    )

    // Render Account Settings Tab
    const renderAccountSettingsTab = () => (
        <div className="flex-1 overflow-y-auto pb-20 bg-gray-50">
            {/* Header */}
            <div
                className="px-5 pt-6 pb-8 text-white"
                style={{ backgroundColor: config.primary_color }}
            >
                <div className="flex items-center gap-3 mb-4">
                    <button
                        onClick={() => setActiveTab('profile')}
                        className="p-2 rounded-full bg-white/20 hover:bg-white/30 transition-colors"
                    >
                        <ArrowLeft className="w-5 h-5" />
                    </button>
                    <h1 className="text-xl font-bold">Account Settings</h1>
                </div>
            </div>

            <div className="px-5 -mt-4 relative z-20 space-y-4">
                {/* Success/Error Messages */}
                {pendingCollectResumeError && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-xl">
                        <div className="flex items-start gap-2">
                            <AlertCircle className="w-5 h-5 text-red-500 mt-0.5 shrink-0" />
                            <div className="flex-1 space-y-3">
                                <p className="text-sm text-red-700">{pendingCollectResumeError}</p>
                                <Button
                                    onClick={() => {
                                        void resumePendingCollectAfterProfileSave()
                                    }}
                                    disabled={collectingPoints || savingProfile}
                                    className="w-full h-10 font-semibold"
                                    style={{ backgroundColor: config.button_color }}
                                >
                                    {collectingPoints ? (
                                        <>
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                            Retrying...
                                        </>
                                    ) : (
                                        'Retry Collection'
                                    )}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
                {profileSaveNotice && (
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2">
                        <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
                        <p className="text-sm text-amber-700">{profileSaveNotice}</p>
                    </div>
                )}
                {profileSaveSuccess && (
                    <div className="p-3 bg-green-50 border border-green-200 rounded-xl flex items-center gap-2">
                        <Check className="w-5 h-5 text-green-500" />
                        <p className="text-sm text-green-700">Profile updated successfully!</p>
                    </div>
                )}
                {passwordSuccess && (
                    <div className="p-3 bg-green-50 border border-green-200 rounded-xl flex items-center gap-2">
                        <Check className="w-5 h-5 text-green-500" />
                        <p className="text-sm text-green-700">Password changed successfully!</p>
                    </div>
                )}

                {/* Account & Security Section */}
                <div className="bg-transparent">
                    {/* Account & Security */}
                    <button
                        onClick={() => setShowChangePassword(!showChangePassword)}
                        className="w-full p-4 flex items-center justify-between hover:bg-gray-50 transition-colors bg-white rounded-xl mb-3"
                    >
                        <div className="flex items-center gap-3">
                            <Lock className="w-5 h-5 text-gray-600" />
                            <span className="font-medium text-gray-900">Account & Security</span>
                        </div>
                        <ChevronRight className={`w-5 h-5 text-gray-400 transition-transform ${showChangePassword ? 'rotate-90' : ''}`} />
                    </button>

                    {/* Expandable Password Change Section */}
                    {showChangePassword && (
                        <div className="p-4 bg-gray-50 rounded-xl space-y-4 mb-3">
                            <h4 className="font-semibold text-gray-900">Change Password</h4>
                            <p className="text-sm text-gray-500">Update your password to keep your account secure</p>

                            {passwordError && (
                                <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                                    <p className="text-sm text-red-600">{passwordError}</p>
                                </div>
                            )}

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Current Password <span className="text-red-500">*</span>
                                </label>
                                <div className="relative">
                                    <Input
                                        type={showCurrentPassword ? 'text' : 'password'}
                                        placeholder="Enter current password"
                                        value={currentPassword}
                                        onChange={(e) => setCurrentPassword(e.target.value)}
                                        className="h-11 pr-10"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2"
                                    >
                                        {showCurrentPassword ? (
                                            <EyeOff className="w-5 h-5 text-gray-400" />
                                        ) : (
                                            <Eye className="w-5 h-5 text-gray-400" />
                                        )}
                                    </button>
                                </div>
                                <p className="text-xs text-gray-500 mt-1">Enter your current password to verify your identity</p>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    New Password <span className="text-red-500">*</span>
                                </label>
                                <div className="relative">
                                    <Input
                                        type={showNewPassword ? 'text' : 'password'}
                                        placeholder="Enter new password (min 6 characters)"
                                        value={newPassword}
                                        onChange={(e) => setNewPassword(e.target.value)}
                                        className="h-11 pr-10"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowNewPassword(!showNewPassword)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2"
                                    >
                                        {showNewPassword ? (
                                            <EyeOff className="w-5 h-5 text-gray-400" />
                                        ) : (
                                            <Eye className="w-5 h-5 text-gray-400" />
                                        )}
                                    </button>
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Confirm New Password <span className="text-red-500">*</span>
                                </label>
                                <div className="relative">
                                    <Input
                                        type={showChangeConfirmPassword ? 'text' : 'password'}
                                        placeholder="Confirm new password"
                                        value={confirmPassword}
                                        onChange={(e) => setConfirmPassword(e.target.value)}
                                        className="h-11 pr-10"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowChangeConfirmPassword(!showChangeConfirmPassword)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2"
                                    >
                                        {showChangeConfirmPassword ? (
                                            <EyeOff className="w-5 h-5 text-gray-400" />
                                        ) : (
                                            <Eye className="w-5 h-5 text-gray-400" />
                                        )}
                                    </button>
                                </div>
                            </div>

                            <Button
                                onClick={handleChangePassword}
                                disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword}
                                className="w-full h-11 font-semibold"
                                style={{ backgroundColor: config.button_color }}
                            >
                                {changingPassword ? (
                                    <>
                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                        Updating...
                                    </>
                                ) : (
                                    'Update Password'
                                )}
                            </Button>
                        </div>
                    )}
                </div>

                {/* Profile Information Section */}
                <div className="bg-transparent">
                    {/* Profile Information Clickable Row */}
                    <button
                        onClick={() => setShowProfileInfo(!showProfileInfo)}
                        className="w-full p-4 flex items-center justify-between hover:bg-gray-50 transition-colors bg-white rounded-xl mb-3"
                    >
                        <div className="flex items-center gap-3">
                            <User className="w-5 h-5 text-gray-600" />
                            <span className="font-medium text-gray-900">Profile Information</span>
                        </div>
                        <ChevronRight className={`w-5 h-5 text-gray-400 transition-transform ${showProfileInfo ? 'rotate-90' : ''}`} />
                    </button>

                    {/* Expandable Profile Info Section */}
                    {showProfileInfo && (
                        <div className="bg-gray-50 rounded-xl mb-3 overflow-hidden">
                            {profileSaveError && (
                                <div className="p-3 mx-4 mt-4 bg-red-50 border border-red-200 rounded-lg">
                                    <p className="text-sm text-red-600">{profileSaveError}</p>
                                </div>
                            )}

                            {/* Name */}
                            <div className="p-4 border-b border-gray-100">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-sm font-medium text-gray-700">Name</label>
                                    {!editingName && (
                                        <button
                                            onClick={() => {
                                                setEditingName(true)
                                                setNewName(userName)
                                            }}
                                            className="text-sm font-medium"
                                            style={{ color: config.primary_color }}
                                        >
                                            Edit
                                        </button>
                                    )}
                                </div>
                                {editingName ? (
                                    <div className="flex gap-2">
                                        <Input
                                            type="text"
                                            value={newName}
                                            onChange={(e) => setNewName(e.target.value)}
                                            placeholder="Enter your name"
                                            className="h-10 flex-1"
                                        />
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                                setEditingName(false)
                                                setNewName(userName)
                                            }}
                                        >
                                            <X className="w-4 h-4" />
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <User className="w-4 h-4 text-gray-400" />
                                        <span className="text-gray-900">{userName || 'Not set'}</span>
                                    </div>
                                )}
                            </div>

                            {/* Phone */}
                            <div className="p-4 border-b border-gray-100">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-sm font-medium text-gray-700">Phone Number</label>
                                    {!editingPhone && (
                                        <button
                                            onClick={() => {
                                                setEditingPhone(true)
                                                setNewPhone(userPhone)
                                            }}
                                            className="text-sm font-medium"
                                            style={{ color: config.primary_color }}
                                        >
                                            Edit
                                        </button>
                                    )}
                                </div>
                                {editingPhone ? (
                                    <div className="flex gap-2">
                                        <Input
                                            type="tel"
                                            value={newPhone}
                                            onChange={(e) => setNewPhone(e.target.value)}
                                            placeholder="e.g., +60123456789"
                                            className="h-10 flex-1"
                                        />
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                                setEditingPhone(false)
                                                setNewPhone(userPhone)
                                            }}
                                        >
                                            <X className="w-4 h-4" />
                                        </Button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <Phone className="w-4 h-4 text-gray-400" />
                                        <span className="text-gray-900">{userPhone || 'Not set'}</span>
                                    </div>
                                )}
                            </div>

                            {/* Reference */}
                            <div className="p-4 border-b border-gray-100">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-sm font-medium text-gray-700">Reference</label>
                                    {!editingReferralPhone && (
                                        <button
                                            onClick={() => {
                                                setEditingReferralPhone(true)
                                                setNewReferralPhone(userReferralPhone)
                                                setNewReferenceUserId(userReferenceUserId)
                                            }}
                                            className="text-sm font-medium"
                                            style={{ color: config.primary_color }}
                                        >
                                            Edit
                                        </button>
                                    )}
                                </div>
                                {editingReferralPhone ? (
                                    <div className="space-y-2">
                                        <div className="flex gap-2 items-start">
                                            <div className="flex-1">
                                                <ReferencePicker
                                                    value={newReferralPhone}
                                                    referenceUserId={newReferenceUserId}
                                                    onSelect={(ref: ReferenceUser | null, phone: string) => {
                                                        setNewReferralPhone(phone)
                                                        if (ref) {
                                                            setNewReferenceUserId(ref.user_id)
                                                            setReferralCheckStatus('valid')
                                                            setReferralName(ref.full_name)
                                                        } else if (!phone) {
                                                            setNewReferenceUserId(null)
                                                            setReferralCheckStatus('idle')
                                                            setReferralName('')
                                                        } else {
                                                            setNewReferenceUserId(null)
                                                        }
                                                    }}
                                                    placeholder="Search by name, phone, or email..."
                                                />
                                            </div>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => {
                                                    setEditingReferralPhone(false)
                                                    setNewReferralPhone(userReferralPhone)
                                                    setNewReferenceUserId(userReferenceUserId)
                                                    setReferralCheckStatus('idle')
                                                }}
                                            >
                                                <X className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-start gap-2">
                                        <Shield className="w-4 h-4 text-gray-400 mt-0.5" />
                                        {userReferralPhone ? (
                                            <div className="min-w-0">
                                                {userReferenceDisplayName && (
                                                    <div className="text-gray-900 font-medium truncate">{userReferenceDisplayName}</div>
                                                )}
                                                <div className={`truncate ${userReferenceDisplayName ? 'text-sm text-gray-500' : 'text-gray-900'}`}>
                                                    {userReferralPhone}
                                                </div>
                                            </div>
                                        ) : (
                                            <span className="text-gray-900">Not set</span>
                                        )}
                                    </div>
                                )}
                                {!((editingReferralPhone ? newReferralPhone : userReferralPhone) || '').trim() && (
                                    <p className="text-xs text-red-500 italic mt-1">* Required — please set your reference to collect points</p>
                                )}
                                {((editingReferralPhone ? newReferralPhone : userReferralPhone) || '').trim() && (editingReferralPhone ? (newReferralPhone === userReferralPhone ? invalidReference : referralCheckStatus === 'invalid') : invalidReference) && (
                                    <p className="text-xs text-amber-700 mt-1">{INVALID_REFERENCE_WARNING_MESSAGE}</p>
                                )}
                            </div>

                            {/* Email (Read-only) */}
                            <div className="p-4 border-b border-gray-100">
                                <label className="text-sm font-medium text-gray-700 block mb-2">Email</label>
                                <div className="flex items-center gap-2">
                                    <Mail className="w-4 h-4 text-gray-400" />
                                    <span className="text-gray-900">{userEmail}</span>
                                </div>
                            </div>

                            {/* Shop Name */}
                            <div className="p-4 border-t border-gray-100">
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-sm font-medium text-gray-700">Shop</label>
                                    {!editingShopName && (
                                        !isShopUser && (
                                            <button
                                                onClick={() => {
                                                    setEditingShopName(true)
                                                    setNewShopName(userShopName)
                                                    setNewLinkedOrganizationId(userLinkedOrganizationId)
                                                }}
                                                className="text-sm font-medium"
                                                style={{ color: config.primary_color }}
                                            >
                                                Edit
                                            </button>
                                        )
                                    )}
                                </div>
                                {!isShopUser && editingShopName ? (
                                    <div className="space-y-2">
                                        <div className="flex gap-2 items-start">
                                            <div className="flex-1">
                                                <ShopPicker
                                                    value={newShopName}
                                                    onSelect={(shop: ShopResult | null, displayName: string) => {
                                                        setNewShopName(displayName)
                                                        setNewLinkedOrganizationId(shop?.org_id || null)
                                                    }}
                                                    onCreateRequest={(shopName) => {
                                                        setPendingShopRequestName(toTitleCaseWords(shopName.trim()))
                                                        setIsShopRequestOpen(true)
                                                    }}
                                                    placeholder="Search shop by name..."
                                                    maxLength={120}
                                                />
                                            </div>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => {
                                                    setEditingShopName(false)
                                                    setNewShopName(userShopName)
                                                    setNewLinkedOrganizationId(userLinkedOrganizationId)
                                                }}
                                            >
                                                <X className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex items-start gap-2">
                                        <Building2 className="w-4 h-4 text-gray-400 mt-0.5" />
                                        <span className="block text-gray-900 text-sm">{userShopName || 'Not set'}</span>
                                    </div>
                                )}
                                {!((!isShopUser && editingShopName ? newShopName : userShopName) || '').trim() && (
                                    <p className="text-xs text-red-500 italic mt-1">* Required — please set your shop name to collect points</p>
                                )}
                                {!isShopUser && (((editingShopName ? newShopName : userShopName) || '').trim()) && (editingShopName ? !newLinkedOrganizationId : invalidShop) && (
                                    <p className="text-xs text-amber-700 mt-1">{INVALID_SHOP_WARNING_MESSAGE}</p>
                                )}
                            </div>

                            <CreateShopDialog
                                open={isShopRequestOpen}
                                onOpenChange={setIsShopRequestOpen}
                                defaultShopName={pendingShopRequestName}
                                linkUser={false}
                                onCreated={async (org) => {
                                    const displayName = org.org_name + (org.branch ? ` (${org.branch})` : '')
                                    setIsShopRequestOpen(false)
                                    setPendingShopRequestName('')
                                    setNewShopName(displayName)
                                    setNewLinkedOrganizationId(org.id)
                                    setInvalidShop(false)
                                    setEditingShopName(true)
                                    setProfileSaveError('')
                                    setProfileSaveNotice('New shop created. Please save your changes to continue collecting points.')
                                }}
                                onSelectExisting={(org) => {
                                    const displayName = org.org_name + (org.branch ? ` (${org.branch})` : '')
                                    setIsShopRequestOpen(false)
                                    setPendingShopRequestName('')
                                    setNewShopName(displayName)
                                    setNewLinkedOrganizationId(org.id)
                                    setInvalidShop(false)
                                    setEditingShopName(true)
                                    setProfileSaveError('')
                                    setProfileSaveNotice('Existing shop selected. Please save your changes to continue collecting points.')
                                }}
                            />

                            {/* Save Button */}
                            {(editingName || editingPhone || editingShopName || editingReferralPhone) && (newName !== userName || newPhone !== userPhone || (!isShopUser && (newShopName !== userShopName || newLinkedOrganizationId !== userLinkedOrganizationId)) || newReferralPhone !== userReferralPhone || newReferenceUserId !== userReferenceUserId) && (
                                <div className="p-4 border-t border-gray-100">
                                    <Button
                                        onClick={handleSaveProfile}
                                        disabled={savingProfile}
                                        className="w-full h-11 font-semibold"
                                        style={{ backgroundColor: config.button_color }}
                                    >
                                        {savingProfile ? (
                                            <>
                                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                Saving...
                                            </>
                                        ) : (
                                            <>
                                                <Save className="w-4 h-4 mr-2" />
                                                Save Changes
                                            </>
                                        )}
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Bank Account Section (All Users) */}
                <div className="bg-transparent">
                    <button
                        onClick={() => setShowBankInfo(!showBankInfo)}
                        className="w-full p-4 flex items-center justify-between hover:bg-gray-50 transition-colors bg-white rounded-xl mb-3"
                    >
                        <div className="flex items-center gap-3">
                            <CreditCard className="w-5 h-5 text-gray-600" />
                            <span className="font-medium text-gray-900">Bank Account</span>
                        </div>
                        <ChevronRight className={`w-5 h-5 text-gray-400 transition-transform ${showBankInfo ? 'rotate-90' : ''}`} />
                    </button>

                    {showBankInfo && (
                        <div className="bg-gray-50 rounded-xl mb-3 overflow-hidden p-4 space-y-4">
                            <p className="text-sm text-gray-500 mb-2">Update your bank account details for payouts.</p>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name (Account Holder)</label>
                                <Input
                                    value={bankAccountHolderName}
                                    onChange={(e) => setBankAccountHolderName(e.target.value)}
                                    placeholder="e.g., ALI BIN ABU"
                                    className="bg-white"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Bank Name</label>
                                <select
                                    value={bankId}
                                    onChange={(e) => setBankId(e.target.value)}
                                    className="w-full h-10 px-3 rounded-md border border-input bg-white text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                >
                                    <option value="">Select Bank</option>
                                    {banks.map(bank => (
                                        <option key={bank.id} value={bank.id}>{bank.short_name}</option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Account Number</label>
                                <Input
                                    value={bankAccountNumber}
                                    onChange={(e) => setBankAccountNumber(e.target.value)}
                                    placeholder="e.g., 1234567890"
                                    className="bg-white"
                                />
                            </div>

                            {profileSaveError && (
                                <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                                    <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                                    <p className="text-sm text-red-600">{profileSaveError}</p>
                                </div>
                            )}

                            {profileSaveSuccess && (
                                <div className="p-3 bg-green-50 border border-green-200 rounded-lg flex items-start gap-2">
                                    <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                                    <p className="text-sm text-green-600">Bank details saved successfully!</p>
                                </div>
                            )}

                            <Button
                                onClick={handleSaveProfile}
                                disabled={savingProfile}
                                className="w-full h-11 font-semibold mt-2"
                                style={{ backgroundColor: config.button_color }}
                            >
                                {savingProfile ? (
                                    <>
                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                        Saving...
                                    </>
                                ) : (
                                    <>
                                        <Save className="w-4 h-4 mr-2" />
                                        Save Bank Details
                                    </>
                                )}
                            </Button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )

    // Render content based on active tab
    const renderContent = () => {
        switch (activeTab) {
            case 'home':
                return renderHomeTab()
            case 'rewards':
                return renderRewardsTab()
            case 'lucky-draw':
                return renderLuckyDrawTab()
            case 'products':
                return renderProductsTab()
            case 'games':
                return renderGamesTab()
            case 'play-scratch-card':
                return renderScratchCardTab()
            case 'spin-wheel':
                return renderSpinWheelTab()
            case 'daily-quiz':
                return renderDailyQuizTab()
            case 'profile':
                return renderProfileTab()
            case 'account-settings':
                return renderAccountSettingsTab()
            default:
                return renderHomeTab()
        }
    }

    return (
        <div className="sera-collect">
            <div className="sera-collect__frame">
            <header className="sera-collect__topbar">
                <div className="sera-collect__brand">
                    <Image
                        src="/images/logo.png"
                        alt="Serapod"
                        width={248}
                        height={79}
                        className="sera-collect__brand-logo"
                        priority
                    />
                    <div className="sera-collect__brand-copy">
                        <div className="sera-collect__brand-tag">Collect Points</div>
                    </div>
                </div>

                {activeTab === 'profile' && isAuthenticated && (
                    <div className="flex items-center gap-1" style={{ pointerEvents: 'auto' }}>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                console.log('Settings button clicked (fixed)')
                                setActiveTab('account-settings')
                            }}
                            className="p-2.5 rounded-full bg-[var(--sera-mist)] hover:bg-[var(--sera-line)] transition-colors active:bg-[var(--sera-line)] cursor-pointer touch-manipulation select-none"
                            title="Account Settings"
                            aria-label="Account Settings"
                        >
                            <Settings className="w-4 h-4 text-[var(--sera-ink)] pointer-events-none" />
                        </button>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                console.log('Feedback button clicked (fixed)')
                                setShowFeedbackModal(true)
                                setFeedbackError('')
                                setFeedbackSuccess(false)
                            }}
                            className="p-2.5 rounded-full bg-[var(--sera-mist)] hover:bg-[var(--sera-line)] transition-colors active:bg-[var(--sera-line)] cursor-pointer touch-manipulation select-none relative"
                            title="Messages"
                            aria-label="Messages"
                        >
                            <MessageSquare className="w-4 h-4 text-[var(--sera-ink)] pointer-events-none" />
                            {unreadMessageCount > 0 && (
                                <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-bold min-w-[16px] h-4 rounded-full flex items-center justify-center px-1">
                                    {unreadMessageCount > 99 ? '99+' : unreadMessageCount}
                                </span>
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                console.log('Logout button clicked (fixed)')
                                handleLogout()
                            }}
                            className="p-2.5 rounded-full bg-[var(--sera-mist)] hover:bg-[var(--sera-line)] transition-colors active:bg-[var(--sera-line)] cursor-pointer touch-manipulation select-none"
                            title="Sign Out"
                            aria-label="Sign Out"
                        >
                            <LogOut className="w-4 h-4 text-[var(--sera-ink)] pointer-events-none" />
                        </button>
                    </div>
                )}
            </header>

            {/* Main Content */}
            <div className="sera-collect__body">
                {renderContent()}
            </div>

            {/* QR Scanner Modal */}
            {showScanner && (
                <QrScanner
                    primaryColor={config.primary_color}
                    onClose={() => setShowScanner(false)}
                    onResult={(result) => {
                        setShowScanner(false)
                        // Handle QR code result
                        handleQrScanResult(result)
                    }}
                />
            )}

            {/* Bottom Navigation */}
            {isPetFoodTheme ? (
                <EllbowBottomNavigation
                    activeTab={activeTab}
                    onSelect={(tab) => {
                        setActiveTab(tab)
                        if (tab === 'rewards') setShowFreeGifts(false)
                    }}
                    onScan={() => setShowScanner(true)}
                />
            ) : (
            <nav className="sera-collect__nav">
                <div className="sera-collect__nav-inner relative">
                    {/* Left tabs: Home, Rewards */}
                    {[
                        { id: 'home' as TabType, icon: Home, label: 'Home' },
                        { id: 'rewards' as TabType, icon: Gift, label: 'Rewards' },
                    ].map((tab) => {
                        const Icon = tab.icon
                        const isActive = activeTab === tab.id

                        return (
                            <button
                                key={tab.id}
                                onClick={() => {
                                    setActiveTab(tab.id)
                                    if (tab.id === 'rewards') {
                                        setShowFreeGifts(false)
                                    }
                                }}
                                className={`sera-collect__nav-btn ${isActive ? 'is-active' : ''}`}
                            >
                                <Icon className="w-5 h-5" />
                                <span className="text-[10px] font-medium">{tab.label}</span>
                            </button>
                        )
                    })}

                    {/* Center Scan Button - Elevated */}
                    <button
                        onClick={() => setShowScanner(true)}
                        className="relative flex flex-col items-center -mt-5"
                        aria-label="Scan QR"
                    >
                        <div className="sera-collect__scan">
                            <ScanLine className="w-7 h-7 text-white" />
                        </div>
                        <span className="text-[10px] mt-1 font-medium text-[var(--sera-muted)]">Scan</span>
                    </button>

                    {/* Right tabs: Product, Profile */}
                    {[
                        { id: 'products' as TabType, icon: Package, label: 'Product' },
                        { id: 'profile' as TabType, icon: User, label: 'Profile' },
                    ].map((tab) => {
                        const Icon = tab.icon
                        const isActive = activeTab === tab.id

                        return (
                            <button
                                key={tab.id}
                                onClick={() => {
                                    setActiveTab(tab.id)
                                }}
                                className={`sera-collect__nav-btn ${isActive ? 'is-active' : ''}`}
                            >
                                <Icon className="w-5 h-5" />
                                <span className="text-[10px] font-medium">{tab.label}</span>
                            </button>
                        )
                    })}
                </div>
            </nav>
            )}

            {/* Security Code Modal */}
            {qrCode && (
                <SecurityCodeModal
                    isOpen={showSecurityModal}
                    onClose={() => {
                        setShowSecurityModal(false)
                        setPendingAction(null)
                    }}
                    onSuccess={handleSecuritySuccess}
                    publicToken={extractTokenFromQRCode(qrCode)}
                />
            )}

            {/* Error Modal for authenticated users - shows QR code errors without login form */}
            {pointsError && isAuthenticated && !showPointsLoginModal && !showPointsSuccessModal && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-2xl w-full max-w-sm p-6 space-y-4">
                        <div className="text-center">
                            <div className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center bg-red-100">
                                <XCircle className="w-8 h-8 text-red-500" />
                            </div>
                            <h3 className="text-xl font-bold text-gray-900">{pointsErrorTitle || 'Unable to Collect Points'}</h3>
                            <p className="text-sm text-gray-500 mt-1">
                                {pointsErrorTitle === 'Already Claimed'
                                    ? 'This RoadTour reward was already claimed by this account'
                                    : 'There was a problem processing your request'}
                            </p>
                        </div>

                        <div className="p-3 bg-red-50 border border-red-200 rounded-xl">
                            <p className="text-sm text-red-600 text-center">{pointsError}</p>
                        </div>

                        <button
                            onClick={() => {
                                setPointsError('')
                                setPointsErrorTitle('')
                            }}
                            className="w-full py-3 px-4 rounded-xl font-medium text-white transition-colors"
                            style={{ backgroundColor: config.primary_color }}
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}

            {/* Collect Points Login Modal */}
            {showPointsLoginModal && !showPointsSuccessModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4">
                    <div className="flex max-h-[calc(100dvh-24px)] w-full max-w-sm flex-col overflow-hidden rounded-2xl bg-white p-4 shadow-xl sm:p-6">
                        <div className="flex shrink-0 justify-end">
                            <button
                                type="button"
                                onClick={closeCollectPointsModal}
                                className="rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                                aria-label="Close collect points dialog"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="shrink-0 text-center">
                            <div
                                className="w-16 h-16 rounded-full mx-auto mb-4 flex items-center justify-center"
                                style={{ backgroundColor: `${config.primary_color}15` }}
                            >
                                {collectPointsStep === 'complete-profile' || collectPointsStep === 'consumer-confirm' ? (
                                    <AlertCircle className="w-8 h-8" style={{ color: config.primary_color }} />
                                ) : collectPointsStep === 'roadtour-survey' ? (
                                    <MessageSquare className="w-8 h-8" style={{ color: config.primary_color }} />
                                ) : (
                                    <Gift className="w-8 h-8" style={{ color: config.primary_color }} />
                                )}
                            </div>
                            <h3 className="text-xl font-bold text-gray-900">
                                {collectPointsStep === 'complete-profile'
                                    ? pointsErrorTitle || 'Complete Your Profile'
                                    : collectPointsStep === 'consumer-confirm'
                                        ? 'Confirm Consumer Lane'
                                        : collectPointsStep === 'roadtour-survey'
                                            ? 'Quick Survey'
                                            : 'Collect Points'}
                            </h3>
                            <p className="text-sm text-gray-500 mt-1">
                                {collectPointsStep === 'complete-profile'
                                    ? 'Update your shop details before collecting points'
                                    : collectPointsStep === 'consumer-confirm'
                                        ? 'Choose whether to continue as a consumer or link to a shop first'
                                        : collectPointsStep === 'roadtour-survey'
                                            ? 'Complete the survey to claim your RoadTour reward'
                                            : 'Enter your credentials to collect points'}
                            </p>
                        </div>

                        {collectPointsStep === 'complete-profile' ? (
                            <>
                                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                                    {pointsErrorAction === 'shop-profile-link' ? (
                                        <p className="text-sm text-amber-700 text-center">
                                            This QR was already claimed by a consumer. Only shop staff can claim it now.{' '}
                                            <button
                                                type="button"
                                                onClick={openProfileForPendingCollectFlow}
                                                className="font-semibold underline underline-offset-2"
                                            >
                                                Are you shop staff?
                                            </button>
                                        </p>
                                    ) : pointsErrorAction === 'roadtour-shop-only' ? (
                                        <p className="text-sm text-amber-700 text-center">
                                            {(pointsError || getRoadtourProfileIncompleteMessage(userName))
                                                .split(/(\*\*[^*]+\*\*)/g)
                                                .map((part, i) =>
                                                    part.startsWith('**') && part.endsWith('**')
                                                        ? <strong key={i}>{part.slice(2, -2)}</strong>
                                                        : part
                                                )}
                                        </p>
                                    ) : (
                                        <p className="text-sm text-amber-700 text-center">
                                            {(pointsError || 'Your account does not have a shop set yet. Please update Shop Name and Reference in Profile first.')
                                                .split(/(\*\*[^*]+\*\*)/g)
                                                .map((part, i) =>
                                                    part.startsWith('**') && part.endsWith('**')
                                                        ? <strong key={i}>{part.slice(2, -2)}</strong>
                                                        : part
                                                )}
                                        </p>
                                    )}
                                </div>

                                <div className="flex gap-3 pt-2">
                                    <button
                                        onClick={() => {
                                            setShowPointsLoginModal(false)
                                            setPointsError('')
                                            setPointsErrorAction(null)
                                            setPendingProfileCollectLane(null)
                                            setPendingProfileCollectEmail('')
                                            setCollectPointsStep('login')
                                        }}
                                        className="flex-1 py-3 px-4 border border-gray-300 rounded-xl font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={openProfileForPendingCollectFlow}
                                        className="flex-1 py-3 px-4 rounded-xl font-medium text-white transition-colors disabled:opacity-50"
                                        style={{ backgroundColor: config.button_color }}
                                    >
                                        {pointsErrorAction === 'shop-profile-link'
                                            ? 'Update Your Profile'
                                            : pointsErrorAction === 'roadtour-shop-only'
                                                ? 'Update My profile'
                                                : 'Go to Profile'}
                                    </button>
                                </div>
                            </>
                        ) : collectPointsStep === 'consumer-confirm' ? (
                            <>
                                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                                    {pointsErrorTitle && <p className="text-sm font-semibold text-amber-900 text-center mb-1">{pointsErrorTitle}</p>}
                                    <p className="text-sm text-amber-700 text-center">
                                        {withUserGreeting(pointsError, userName)}
                                    </p>
                                </div>

                                <div className="flex gap-3 pt-2">
                                    <button
                                        onClick={openProfileForPendingCollectFlow}
                                        className="flex-1 py-3 px-4 border border-gray-300 rounded-xl font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                                    >
                                        Belong to Shop
                                    </button>
                                    <button
                                        onClick={() => {
                                            if (roadtourContext) {
                                                if (isAuthenticated) {
                                                    void handleRoadtourClaimWithSession({ consumerConfirmation: true })
                                                    return
                                                }

                                                void handleRoadtourClaimWithLogin({ consumerConfirmation: true })
                                                return
                                            }

                                            if (isAuthenticated) {
                                                void handleCollectPointsWithSession({ consumerConfirmation: true })
                                                return
                                            }

                                            void handleCollectPoints({ consumerConfirmation: true })
                                        }}
                                        disabled={collectingPoints || consumerClaimConfirmed}
                                        className="flex-1 py-3 px-4 rounded-xl font-medium text-white transition-colors disabled:opacity-50"
                                        style={{ backgroundColor: config.button_color }}
                                    >
                                        {collectingPoints ? (
                                            <span className="flex items-center justify-center gap-2">
                                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                                Confirming...
                                            </span>
                                        ) : consumerClaimConfirmed ? 'Confirmed' : 'Consumer'}
                                    </button>
                                </div>
                            </>
                        ) : collectPointsStep === 'roadtour-survey' ? (
                            <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-4">
                                {roadtourSurveyShopName && (
                                    <div className="p-3 bg-orange-50 border border-orange-200 rounded-xl">
                                        <p className="text-sm text-orange-700 text-center">
                                            Some answers were prefilled from your linked shop: <span className="font-semibold">{roadtourSurveyShopName}</span>
                                        </p>
                                    </div>
                                )}

                                {pointsError && (
                                    <div className="p-3 bg-red-50 border border-red-200 rounded-xl">
                                        <p className="text-sm text-red-600 text-center">{pointsError}</p>
                                    </div>
                                )}

                                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 pb-4">
                                    {roadtourSurveyLoading ? (
                                        <div className="py-6 text-center text-sm text-gray-500">
                                            <Loader2 className="w-4 h-4 animate-spin mx-auto mb-2" />
                                            Loading survey...
                                        </div>
                                    ) : roadtourSurveyFields.length === 0 ? (
                                        <p className="text-sm text-gray-500 text-center py-4">No survey fields found for this RoadTour campaign.</p>
                                    ) : roadtourSurveyFields.map((field) => (
                                        <div key={field.id} className="space-y-2">
                                            <label className="block text-sm font-medium text-gray-700">
                                                {field.label} {field.is_required && <span className="text-red-500">*</span>}
                                            </label>
                                            {getRoadtourShopSurveyField(field.field_key) && (
                                                <p className="text-xs text-gray-500">Linked shop field. You can review and update the answer before submitting.</p>
                                            )}
                                            {field.field_type === 'text' && (
                                                <input
                                                    type="text"
                                                    value={roadtourSurveyAnswers[field.field_key] || ''}
                                                    onChange={(e) => setRoadtourSurveyAnswers({ ...roadtourSurveyAnswers, [field.field_key]: e.target.value })}
                                                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2"
                                                    style={{ '--tw-ring-color': config.primary_color } as any}
                                                />
                                            )}
                                            {field.field_type === 'textarea' && (
                                                <textarea
                                                    rows={3}
                                                    value={roadtourSurveyAnswers[field.field_key] || ''}
                                                    onChange={(e) => setRoadtourSurveyAnswers({ ...roadtourSurveyAnswers, [field.field_key]: e.target.value })}
                                                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2"
                                                    style={{ '--tw-ring-color': config.primary_color } as any}
                                                />
                                            )}
                                            {field.field_type === 'yes_no' && (
                                                <div className="flex gap-3">
                                                    {['yes', 'no'].map((value) => (
                                                        <button
                                                            key={value}
                                                            type="button"
                                                            onClick={() => setRoadtourSurveyAnswers({ ...roadtourSurveyAnswers, [field.field_key]: value })}
                                                            className={`flex-1 py-2 rounded-xl border text-sm font-medium ${roadtourSurveyAnswers[field.field_key] === value ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
                                                        >
                                                            {value === 'yes' ? 'Yes' : 'No'}
                                                        </button>
                                                    ))}
                                                </div>
                                            )}
                                            {(field.field_type === 'single_select' || field.field_type === 'radio') && field.options && (
                                                <select
                                                    value={roadtourSurveyAnswers[field.field_key] || ''}
                                                    onChange={(e) => setRoadtourSurveyAnswers({ ...roadtourSurveyAnswers, [field.field_key]: e.target.value })}
                                                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2"
                                                    style={{ '--tw-ring-color': config.primary_color } as any}
                                                >
                                                    <option value="">Select...</option>
                                                    {field.options.map((option) => (
                                                        <option key={option} value={option}>{option}</option>
                                                    ))}
                                                </select>
                                            )}
                                            {field.field_type === 'multi_select' && field.options && (
                                                <div className="flex flex-wrap gap-2">
                                                    {field.options.map((option) => {
                                                        const selectedValues = (roadtourSurveyAnswers[field.field_key] || '').split(',').filter(Boolean)
                                                        const isSelected = selectedValues.includes(option)
                                                        const nextValues = isSelected
                                                            ? selectedValues.filter((value) => value !== option)
                                                            : [...selectedValues, option]

                                                        return (
                                                            <button
                                                                key={option}
                                                                type="button"
                                                                onClick={() => setRoadtourSurveyAnswers({ ...roadtourSurveyAnswers, [field.field_key]: nextValues.join(',') })}
                                                                className={`px-3 py-1.5 rounded-full border text-xs font-medium ${isSelected ? 'border-orange-400 bg-orange-50 text-orange-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
                                                            >
                                                                {option}
                                                            </button>
                                                        )
                                                    })}
                                                </div>
                                            )}
                                            {field.field_type === 'number' && (
                                                <input
                                                    type="number"
                                                    value={roadtourSurveyAnswers[field.field_key] || ''}
                                                    onChange={(e) => setRoadtourSurveyAnswers({ ...roadtourSurveyAnswers, [field.field_key]: e.target.value })}
                                                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2"
                                                    style={{ '--tw-ring-color': config.primary_color } as any}
                                                />
                                            )}
                                            {field.field_type === 'phone' && (
                                                <input
                                                    type="tel"
                                                    value={roadtourSurveyAnswers[field.field_key] || ''}
                                                    onChange={(e) => setRoadtourSurveyAnswers({ ...roadtourSurveyAnswers, [field.field_key]: e.target.value })}
                                                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2"
                                                    style={{ '--tw-ring-color': config.primary_color } as any}
                                                />
                                            )}
                                            {field.field_type === 'checkbox' && (
                                                <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
                                                    <input
                                                        type="checkbox"
                                                        checked={roadtourSurveyAnswers[field.field_key] === 'true'}
                                                        onChange={(e) => setRoadtourSurveyAnswers({ ...roadtourSurveyAnswers, [field.field_key]: e.target.checked ? 'true' : 'false' })}
                                                        className="w-4 h-4 rounded"
                                                    />
                                                    Mark as yes
                                                </label>
                                            )}
                                        </div>
                                    ))}
                                </div>

                                <div className="grid shrink-0 grid-cols-2 gap-3 border-t border-gray-100 bg-white pt-3 pb-[calc(16px+env(safe-area-inset-bottom))]">
                                    <button
                                        onClick={closeCollectPointsModal}
                                        className="min-h-[44px] px-4 py-3 border border-gray-300 rounded-xl font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                                        disabled={collectingPoints}
                                    >
                                        Back
                                    </button>
                                    <button
                                        onClick={() => { void submitRoadtourSurveyClaim() }}
                                        disabled={collectingPoints || roadtourSurveyLoading || roadtourSurveyFields.length === 0}
                                        className="min-h-[44px] px-4 py-3 rounded-xl font-medium text-white transition-colors disabled:opacity-50"
                                        style={{ backgroundColor: config.button_color }}
                                    >
                                        {collectingPoints ? (
                                            <span className="flex items-center justify-center gap-2">
                                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                                Submitting...
                                            </span>
                                        ) : 'Submit & Claim Reward'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <>
                                {/* Login Step */}
                                <div className="space-y-3">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Email or Phone</label>
                                        <input
                                            type="text"
                                            value={shopId}
                                            onChange={(e) => setShopId(e.target.value)}
                                            placeholder="Enter your email or phone"
                                            className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2"
                                            style={{ '--tw-ring-color': config.primary_color } as any}
                                            disabled={collectingPoints}
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                                        <div className="relative">
                                            <input
                                                type={showShopPassword ? 'text' : 'password'}
                                                value={shopPassword}
                                                onChange={(e) => setShopPassword(e.target.value)}
                                                placeholder="Enter your password"
                                                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 pr-10"
                                                style={{ '--tw-ring-color': config.primary_color } as any}
                                                disabled={collectingPoints}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => setShowShopPassword(!showShopPassword)}
                                                className="absolute right-3 top-1/2 -translate-y-1/2"
                                            >
                                                {showShopPassword ? (
                                                    <EyeOff className="w-5 h-5 text-gray-400" />
                                                ) : (
                                                    <Eye className="w-5 h-5 text-gray-400" />
                                                )}
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {pointsError && (
                                    <div className="p-3 bg-red-50 border border-red-200 rounded-xl">
                                        <p className="text-sm text-red-600 text-center">{pointsError}</p>
                                    </div>
                                )}

                                <div className="flex gap-3 pt-2">
                                    <button
                                        onClick={() => {
                                            setShowPointsLoginModal(false)
                                            setPointsError('')
                                            setShopId('')
                                            setShopPassword('')
                                            setCollectingPoints(false)
                                        }}
                                        className="flex-1 py-3 px-4 border border-gray-300 rounded-xl font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                                    >
                                        Back
                                    </button>
                                    <button
                                        onClick={() => {
                                            if (roadtourContext) {
                                                void handleRoadtourClaimWithLogin()
                                                return
                                            }
                                            void handleCollectPoints()
                                        }}
                                        disabled={collectingPoints || !shopId.trim() || !shopPassword.trim()}
                                        className="flex-1 py-3 px-4 rounded-xl font-medium text-white transition-colors disabled:opacity-50"
                                        style={{ backgroundColor: config.button_color }}
                                    >
                                        {collectingPoints ? (
                                            <span className="flex items-center justify-center gap-2">
                                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                                Collecting...
                                            </span>
                                        ) : (
                                            roadtourContext ? 'RoadTour Rewards' : 'Collect Points'
                                        )}
                                    </button>
                                </div>

                                <div className="text-center mt-2 space-y-1">
                                    <button
                                        onClick={() => {
                                            setShowPointsLoginModal(false)
                                            setForgotPasswordReturnTarget('collect')
                                            setShowForgotPasswordModal(true)
                                        }}
                                        className="text-sm font-medium hover:underline"
                                        style={{ color: config.primary_color }}
                                    >
                                        Forgot Password?
                                    </button>
                                    <br />
                                    <button
                                        onClick={() => {
                                            setShowPointsLoginModal(false)
                                            setActiveTab('profile')
                                            setShowLoginForm(true)
                                            setIsSignUp(true)
                                        }}
                                        className="text-sm font-medium hover:underline"
                                        style={{ color: config.primary_color }}
                                    >
                                        Do not have account? Register here
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Forgot Password Modal */}
            <ForgotPasswordModal
                isOpen={showForgotPasswordModal}
                initialEmail={loginEmail}
                onClose={() => setShowForgotPasswordModal(false)}
                onBackToLogin={() => {
                    setShowForgotPasswordModal(false)
                    if (forgotPasswordReturnTarget === 'collect') {
                        setCollectPointsStep('login')
                        setShowPointsLoginModal(true)
                    } else {
                        setActiveTab('profile')
                        setShowLoginForm(true)
                        setIsSignUp(false)
                    }
                }}
                primaryColor={config.primary_color}
                buttonColor={config.button_color}
            />

            <ShopLinkCelebrationAnimation
                isOpen={showShopLinkCelebration}
                shopName={shopLinkCelebrationName}
                primaryColor={config.button_color}
                onClose={() => setShowShopLinkCelebration(false)}
            />

            {roadtourMilestone && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl">
                        <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-500" />
                        <h3 className="mt-3 text-xl font-bold text-gray-900">
                            {roadtourMilestone.reward_status === 'awarded'
                                ? 'RoadTour Milestone Completed'
                                : roadtourMilestone.current_valid_product_scan_count > 0
                                    ? 'RoadTour Progress Updated'
                                    : 'RoadTour Progress Started'}
                        </h3>
                        <p className="mt-2 text-3xl font-black" style={{ color: config.button_color }}>
                            {roadtourMilestone.current_valid_product_scan_count}/{roadtourMilestone.required_product_qr_scans}
                        </p>
                        <p className="mt-2 text-sm text-gray-600">
                            {roadtourMilestone.reward_status === 'awarded'
                                ? `${roadtourMilestone.campaign_reward_points} RoadTour points have been awarded after completing the Product QR requirement.`
                                : `You will be entitled to ${roadtourMilestone.campaign_reward_points} points after scanning ${roadtourMilestone.required_product_qr_scans} unique Product QR codes.`}
                        </p>
                        <p className="mt-2 text-xs text-gray-500">
                            {roadtourMilestone.remaining_product_qr_scans > 0
                                ? `${roadtourMilestone.remaining_product_qr_scans} more Product QR scan${roadtourMilestone.remaining_product_qr_scans === 1 ? '' : 's'} to unlock this RoadTour reward.`
                                : 'Milestone completed. Your reward will be reflected in your points balance.'}
                        </p>
                        <button
                            type="button"
                            onClick={() => {
                                setRoadtourMilestone(null)
                                setShowPointsLoginModal(false)
                                setCollectPointsStep('login')
                            }}
                            className="mt-5 w-full rounded-xl px-4 py-3 text-sm font-bold text-white"
                            style={{ backgroundColor: config.button_color }}
                        >
                            Got it
                        </button>
                    </div>
                </div>
            )}

            {/* Collect Points Success Animation */}
            <PointEarnedAnimation
                isOpen={showPointsSuccessModal && !roadtourMilestone}
                pointsEarned={pointsEarned}
                totalBalance={totalBalance}
                previousBalance={previousBalance}
                additionalNote={roadtourProductQrSuccessNote || undefined}
                primaryColor={config.button_color}
                autoCloseDelay={3500}
                onClose={() => {
                    setShowPointsSuccessModal(false)
                    setShowPointsLoginModal(false)
                    setRoadtourProductQrSuccessNote(null)
                    setPointsEarned(0)
                    setShopId('')
                    setShopPassword('')
                    setCollectPointsStep('login')
                }}
            />

            {/* Lucky Draw Success Animation */}
            <LuckyDrawSuccessAnimation
                isOpen={showLuckyDrawSuccess}
                customerName={customerName}
                customerPhone={customerPhone}
                autoCloseDelay={3500}
                onClose={handleLuckyDrawSuccessClose}
            />

            {/* Genuine Product Verified Animation */}
            <GenuineProductAnimation
                isVisible={showGenuineVerified}
                productInfo={productInfo}
                ellbow={isPetFoodTheme}
                title={roadtourContext ? `Thanks ${userShopName || newShopName || shopName || 'Shop'} for Joining RoadTour!` : undefined}
                subtitle={roadtourContext ? 'We appreciate your participation and support.' : undefined}
                onClose={() => {
                    setShowGenuineVerified(false)
                    setShowPointsAnimation(true)
                }}
            />

            {/* Registration Celebration Animation */}
            <RegistrationCelebrationAnimation
                isVisible={showRegistrationCelebration}
                userName={signUpName || userName || ''}
                bonusPoints={registrationBonusInfo.points}
                bonusAwarded={registrationBonusInfo.awarded}
                bonusMode={registrationBonusInfo.mode}
                onClose={() => setShowRegistrationCelebration(false)}
            />

            {/* Variant Animation Modal */}
            <Dialog open={!!selectedAnimation} onOpenChange={(open) => !open && setSelectedAnimation(null)}>
                <DialogContent className="sm:max-w-md p-0 overflow-hidden bg-black border-none max-w-[90vw] md:max-w-[500px]">
                    <div className="relative w-full h-full flex items-center justify-center">
                        <button
                            onClick={() => setSelectedAnimation(null)}
                            className="absolute top-2 right-2 z-50 bg-black/50 rounded-full p-2 text-white hover:bg-black/70 transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                        {selectedAnimation && (
                            <video
                                src={getStorageUrl(selectedAnimation)}
                                className="w-full h-auto aspect-video max-h-[80vh] object-contain bg-black"
                                controls
                                autoPlay
                                loop
                                playsInline
                            />
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            {/* Variant Detail Modal (like Shopee product page) */}
            <Dialog open={!!selectedVariantForDetail} onOpenChange={(open) => !open && setSelectedVariantForDetail(null)}>
                <DialogContent className="sm:max-w-lg p-0 overflow-hidden bg-white border-none max-w-[95vw] max-h-[90vh] rounded-2xl">
                    <DialogTitle className="sr-only">{selectedVariantForDetail?.variant_name || 'Variant Details'}</DialogTitle>
                    {selectedVariantForDetail && (
                        <div className="flex flex-col h-full max-h-[90vh]">
                            {/* Close button */}
                            <button
                                onClick={() => setSelectedVariantForDetail(null)}
                                className="absolute top-3 right-3 z-50 bg-black/40 rounded-full p-2 text-white hover:bg-black/60 transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>

                            {/* Media Section */}
                            <div className="relative w-full aspect-square bg-gray-100">
                                {selectedVariantForDetail.animation_url ? (
                                    <video
                                        src={getStorageUrl(selectedVariantForDetail.animation_url)}
                                        className="w-full h-full object-contain bg-black"
                                        controls
                                        autoPlay
                                        loop
                                        playsInline
                                    // Note: Browser autoplay policies may block sound. User can unmute via controls.
                                    />
                                ) : selectedVariantForDetail.image_url ? (
                                    <Image
                                        src={getStorageUrl(selectedVariantForDetail.image_url) || selectedVariantForDetail.image_url}
                                        alt={selectedVariantForDetail.variant_name}
                                        fill
                                        className="object-contain"
                                    />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center">
                                        <Package className="w-16 h-16 text-gray-300" />
                                    </div>
                                )}
                            </div>

                            {/* Content Section */}
                            <div className="p-4 space-y-3 flex-1 overflow-y-auto">
                                {/* Price */}
                                {!selectedVariantForDetail.product?.hide_price && (
                                    <div className="flex items-baseline gap-2">
                                        {selectedVariantForDetail.other_price && selectedVariantForDetail.other_price > 0 ? (
                                            <>
                                                <span className="text-2xl font-bold" style={{ color: config.primary_color }}>
                                                    RM {selectedVariantForDetail.other_price.toFixed(2)}
                                                </span>
                                                {selectedVariantForDetail.suggested_retail_price && (
                                                    <>
                                                        <span className="text-sm text-gray-400 line-through">
                                                            RM {selectedVariantForDetail.suggested_retail_price.toFixed(2)}
                                                        </span>
                                                        <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded font-medium">
                                                            -{Math.round(((selectedVariantForDetail.suggested_retail_price - selectedVariantForDetail.other_price) / selectedVariantForDetail.suggested_retail_price) * 100)}%
                                                        </span>
                                                    </>
                                                )}
                                            </>
                                        ) : selectedVariantForDetail.suggested_retail_price ? (
                                            <span className="text-2xl font-bold" style={{ color: config.primary_color }}>
                                                RM {selectedVariantForDetail.suggested_retail_price.toFixed(2)}
                                            </span>
                                        ) : null}
                                    </div>
                                )}

                                {/* Product & Variant Name */}
                                <div>
                                    <h2 className="text-lg font-bold text-gray-900 leading-tight">
                                        {selectedVariantForDetail.product?.product_name}
                                    </h2>
                                    <p className="text-sm text-gray-600 mt-1">{selectedVariantForDetail.variant_name}</p>
                                </div>

                                {/* Description */}
                                {selectedVariantForDetail.product?.product_description && (
                                    <p className="text-sm text-gray-500">
                                        {selectedVariantForDetail.product.product_description}
                                    </p>
                                )}
                            </div>

                            {/* Action Buttons - Fixed at bottom */}
                            <div className="border-t border-gray-100 p-4 bg-white">
                                <div className="flex gap-3">
                                    {/* Chat Now */}
                                    <button
                                        onClick={() => {
                                            // Store variant info for pre-filling chat
                                            const price = selectedVariantForDetail.other_price || selectedVariantForDetail.suggested_retail_price
                                            const subject = `Enquiry: ${selectedVariantForDetail.product?.product_name} - ${selectedVariantForDetail.variant_name}${price ? ` (RM ${price.toFixed(2)})` : ''}`
                                            sessionStorage.setItem('prefill_chat_subject', subject)
                                            setSelectedVariantForDetail(null)
                                            setCollectPointsStep('login')
                                        }}
                                        style={{ borderColor: config.primary_color, color: config.primary_color }}
                                    >
                                        <MessageSquare className="w-5 h-5" />
                                        Chat Now
                                    </button>

                                    {/* Buy Now */}
                                    <button
                                        onClick={() => {
                                            // Store variant info for pre-filling chat as an order inquiry
                                            const price = selectedVariantForDetail.other_price || selectedVariantForDetail.suggested_retail_price
                                            const subject = `Order: ${selectedVariantForDetail.product?.product_name} - ${selectedVariantForDetail.variant_name}${price ? ` (RM ${price.toFixed(2)})` : ''}`
                                            sessionStorage.setItem('prefill_chat_subject', subject)
                                            setSelectedVariantForDetail(null)
                                            setShowFeedbackModal(true)
                                        }}
                                        className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-white transition-all"
                                        style={{ backgroundColor: config.primary_color }}
                                    >
                                        <ShoppingBag className="w-5 h-5" />
                                        Buy Now
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Redeem Confirmation Modal */}
            {showRedeemConfirm && selectedReward && (
                <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/50 p-4 sm:items-center">
                    <div
                        className="my-auto flex max-h-[min(90dvh,90vh)] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white"
                        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
                    >
                        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-6">
                        <div className="text-center">
                            {/* Animated Gift Icon */}
                            <div className="relative w-20 h-20 mx-auto mb-4">
                                <div className="absolute inset-0 animate-ping rounded-full opacity-20" style={{ backgroundColor: config.primary_color }} />
                                <div
                                    className="relative w-20 h-20 rounded-full flex items-center justify-center animate-bounce"
                                    style={{ backgroundColor: `${config.primary_color}15` }}
                                >
                                    <Gift className="w-10 h-10 animate-pulse" style={{ color: config.primary_color }} />
                                </div>
                            </div>
                            <h3 className="text-xl font-bold text-gray-900">
                                {(selectedReward as any).category === 'point' ? 'Collect Bonus Points' : 'Confirm Redemption'}
                            </h3>
                            <p className="text-sm text-gray-500 mt-2">
                                {(selectedReward as any).category === 'point'
                                    ? 'Collect your bonus points now!'
                                    : 'Are you sure you want to redeem this reward?'}
                            </p>
                        </div>

                        <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                            {/* Reward Image & Name */}
                            <div className="flex items-center gap-3">
                                {selectedReward.item_image_url ? (
                                    <img
                                        src={getStorageUrl(selectedReward.item_image_url) || selectedReward.item_image_url}
                                        alt={selectedReward.item_name}
                                        className="w-16 h-16 object-cover rounded-lg"
                                    />
                                ) : (
                                    <div className="w-16 h-16 bg-gray-200 rounded-lg flex items-center justify-center">
                                        <Gift className="w-8 h-8 text-gray-400" />
                                    </div>
                                )}
                                <div className="flex-1">
                                    <p className="font-semibold text-gray-900">{selectedReward.item_name}</p>
                                    {selectedReward.item_description && (
                                        <p className="text-xs text-gray-500 mt-1 line-clamp-2">{selectedReward.item_description}</p>
                                    )}
                                </div>
                            </div>

                            {/* Points Info */}
                            <div className="pt-3 border-t border-gray-200">
                                {(selectedReward as any).category === 'point' ? (
                                    <>
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-gray-600">Bonus Points:</span>
                                            <span className="font-bold text-green-600">
                                                +{(selectedReward as any).point_reward_amount || 0}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between text-sm mt-1">
                                            <span className="text-gray-600">New Balance:</span>
                                            <span className="font-bold text-green-600">
                                                {userPoints + ((selectedReward as any).point_reward_amount || 0)}
                                            </span>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="text-gray-600">Points Required:</span>
                                            <span className="font-bold text-red-600">
                                                -{selectedReward.point_offer || selectedReward.points_required}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between text-sm mt-1">
                                            <span className="text-gray-600">New Balance:</span>
                                            <span className="font-bold text-green-600">
                                                {userPoints - (selectedReward.point_offer || selectedReward.points_required)}
                                            </span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Cashback Bank Info Warning - hide for Point category */}
                        {(selectedReward as any).category !== 'point' && selectedReward.item_code.toLowerCase().includes('cashback') && (!bankId || !bankAccountNumber || !bankAccountHolderName) && (
                            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-3">
                                <div className="flex items-start gap-3">
                                    <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                                    <div className="space-y-1">
                                        <p className="text-sm font-medium text-amber-900">Bank Details Required</p>
                                        <p className="text-xs text-amber-700 leading-relaxed">
                                            To ensure smooth processing of your cashback claim, please update your bank account information. Missing details may cause delays.
                                        </p>
                                    </div>
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="w-full bg-white border-amber-200 text-amber-700 hover:bg-amber-50 hover:text-amber-800"
                                    onClick={() => {
                                        setShowRedeemConfirm(false)
                                        setActiveTab('account-settings')
                                    }}
                                >
                                    Update Bank Details
                                </Button>
                            </div>
                        )}

                        {/* Address Required for Physical Rewards (non-Cashback) - hide for Point category */}
                        {(selectedReward as any).category !== 'point' && !selectedReward.item_code.toLowerCase().includes('cashback') && !userAddress && (
                            <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl space-y-3">
                                <div className="flex items-start gap-3">
                                    <MapPin className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                                    <div className="space-y-1">
                                        <p className="text-sm font-medium text-blue-900">Delivery Address Required</p>
                                        <p className="text-xs text-blue-700 leading-relaxed">
                                            Please update your delivery address to ensure we can ship your reward. Missing address may cause delays in delivery.
                                        </p>
                                    </div>
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="w-full bg-white border-blue-200 text-blue-700 hover:bg-blue-50 hover:text-blue-800"
                                    onClick={() => {
                                        setShowRedeemConfirm(false)
                                        setActiveTab('account-settings')
                                        setShowProfileInfo(true)
                                    }}
                                >
                                    Update Address
                                </Button>
                            </div>
                        )}

                        {redeemError && (
                            <div className="p-3 bg-red-50 border border-red-200 rounded-xl">
                                <p className="text-sm text-red-600 text-center">{redeemError}</p>
                            </div>
                        )}
                        </div>

                        <div className="flex shrink-0 gap-3 border-t border-gray-100 bg-white p-4">
                            <button
                                type="button"
                                onClick={() => {
                                    setShowRedeemConfirm(false)
                                    setSelectedReward(null)
                                    setRedeemError('')
                                }}
                                disabled={redeeming}
                                className="flex-1 rounded-xl border border-gray-300 px-4 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={confirmRedemption}
                                disabled={redeeming}
                                className="flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 font-semibold text-white transition-colors disabled:opacity-50"
                                style={{ backgroundColor: (selectedReward as any).category === 'point' ? '#10B981' : config.button_color }}
                            >
                                {redeeming ? (
                                    <>
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        Processing...
                                    </>
                                ) : (selectedReward as any).category === 'point' ? (
                                    'Collect Points'
                                ) : (
                                    'Confirm'
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Insufficient Points Animation Modal */}
            <InsufficientPointsAnimation
                isOpen={showInsufficientPoints && insufficientPointsData !== null}
                pointsNeeded={insufficientPointsData?.needed || 0}
                pointsAvailable={insufficientPointsData?.available || 0}
                onClose={() => setShowInsufficientPoints(false)}
                primaryColor={config.button_color}
            />

            {/* Reward Redemption Success Animation */}
            {redemptionDetails && (
                <RewardRedemptionAnimation
                    isOpen={showRedeemSuccess}
                    rewardName={redemptionDetails.rewardName}
                    pointsDeducted={redemptionDetails.pointsDeducted}
                    pointsEarned={redemptionDetails.pointsEarned}
                    newBalance={redemptionDetails.newBalance}
                    redemptionCode={redemptionDetails.redemptionCode}
                    onClose={handleRedeemSuccessClose}
                    isCashback={selectedReward?.item_code?.toLowerCase().includes('cashback') || false}
                    isBonusPoints={redemptionDetails.isBonusPoints}
                    bonusMessage={redemptionDetails.bonusMessage}
                    encourageMessage={redemptionDetails.encourageMessage}
                    deliveryAddress={userAddress || undefined}
                    bankName={banks.find(b => b.id === bankId)?.short_name}
                    bankAccount={bankAccountNumber || undefined}
                    bankHolder={bankAccountHolderName || undefined}
                />
            )}

            {/* Free Gift Confirmation Modal */}
            {showGiftConfirm && selectedGift && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4">
                        <div className="text-center">
                            <div className="relative w-20 h-20 mx-auto mb-4">
                                <div className="absolute inset-0 animate-ping rounded-full bg-green-200 opacity-30" />
                                <div className="relative w-20 h-20 rounded-full flex items-center justify-center bg-green-100 animate-bounce">
                                    <Gift className="w-10 h-10 text-green-500 animate-pulse" />
                                </div>
                            </div>
                            <h3 className="text-xl font-bold text-gray-900">Claim Free Gift</h3>
                            <p className="text-sm text-gray-500 mt-2">Are you sure you want to claim this gift?</p>
                        </div>

                        <div className="bg-gray-50 rounded-xl p-4">
                            <div className="flex items-center gap-3">
                                {selectedGift.gift_image_url ? (
                                    <img
                                        src={getStorageUrl(selectedGift.gift_image_url) || selectedGift.gift_image_url}
                                        alt={selectedGift.gift_name}
                                        className="w-16 h-16 object-contain rounded-lg bg-white p-1"
                                    />
                                ) : (
                                    <div className="w-16 h-16 bg-green-100 rounded-lg flex items-center justify-center">
                                        <Gift className="w-8 h-8 text-green-400" />
                                    </div>
                                )}
                                <div className="flex-1">
                                    <p className="font-semibold text-gray-900">{selectedGift.gift_name}</p>
                                    {selectedGift.gift_description && (
                                        <p className="text-xs text-gray-500 mt-1 line-clamp-2">{selectedGift.gift_description}</p>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                            <p className="text-xs text-amber-700 text-center">
                                ⚠️ This QR code can only be used once to claim a free gift.
                            </p>
                        </div>

                        {giftError && (
                            <div className="p-3 bg-red-50 border border-red-200 rounded-xl">
                                <p className="text-sm text-red-600 text-center">{giftError}</p>
                            </div>
                        )}

                        <div className="flex gap-3">
                            <button
                                onClick={() => {
                                    setShowGiftConfirm(false)
                                    setSelectedGift(null)
                                    setGiftError('')
                                }}
                                disabled={claimingGift}
                                className="flex-1 px-4 py-3 border border-gray-300 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-colors disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleClaimGift}
                                disabled={claimingGift}
                                className="flex-1 px-4 py-3 text-white font-semibold rounded-xl bg-green-500 hover:bg-green-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {claimingGift ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Claiming...
                                    </>
                                ) : (
                                    'Claim Gift'
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Free Gift Success Modal */}
            <GiftClaimedAnimation
                isVisible={showGiftSuccess}
                giftName={claimedGiftName}
                onClose={() => {
                    setShowGiftSuccess(false)
                    setSelectedGift(null)
                }}
            />

            {/* Support Chat Modal */}
            {showFeedbackModal && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 sm:p-4"
                    onClick={(e) => {
                        // Only close if clicking the backdrop, not the modal content
                        if (e.target === e.currentTarget) {
                            setShowFeedbackModal(false)
                        }
                    }}
                >
                    <div
                        className="bg-white w-full h-full sm:h-[600px] sm:max-w-md sm:rounded-2xl shadow-xl overflow-hidden flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <SupportChatWidgetV2
                            onClose={() => setShowFeedbackModal(false)}
                            themeColor={config.primary_color}
                        />
                    </div>
                </div>
            )}
            <Dialog
                open={showRegistrationOtpModal}
                onOpenChange={(open) => {
                    if (registrationCreatingAccount) return
                    setShowRegistrationOtpModal(open)
                    if (!open) {
                        setRegistrationOtpCode('')
                        setRegistrationOtpError('')
                    }
                }}
            >
                <DialogContent className="sm:max-w-md rounded-2xl" onPointerDownOutside={(e) => { if (registrationCreatingAccount) e.preventDefault() }}>
                    <DialogHeader>
                        <DialogTitle>{registrationCreatingAccount ? 'Creating Your Account' : 'Verify Mobile Number'}</DialogTitle>
                        <DialogDescription>
                            {registrationCreatingAccount
                                ? 'Your code has been verified. Please wait while we set up your account...'
                                : `Enter the 4-digit code sent to ${signUpEmailValue || loginEmail || 'your email'} to complete registration.`}
                        </DialogDescription>
                    </DialogHeader>

                    {registrationCreatingAccount ? (
                        <div className="flex flex-col items-center justify-center py-8 gap-3">
                            <Loader2 className="w-8 h-8 animate-spin text-primary" />
                            <p className="text-sm text-muted-foreground">Setting up your account...</p>
                            {registrationOtpError && (
                                <p className="text-xs text-red-500 mt-2 text-center">{registrationOtpError}</p>
                            )}
                        </div>
                    ) : (
                        <>
                            <div className="space-y-4 py-2">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">
                                        Verification Code
                                    </label>
                                    <Input
                                        type="text"
                                        inputMode="numeric"
                                        maxLength={4}
                                        placeholder="Enter 4-digit code"
                                        value={registrationOtpCode}
                                        onChange={(e) => {
                                            setRegistrationOtpCode(e.target.value.replace(/\D/g, '').slice(0, 4))
                                            setRegistrationOtpError('')
                                        }}
                                        className={`h-12 text-center text-lg tracking-[0.4em] ${registrationOtpError ? 'border-red-500 focus-visible:ring-red-500' : ''}`}
                                    />
                                    {registrationOtpError && (
                                        <p className="text-xs text-red-500 mt-2">{registrationOtpError}</p>
                                    )}
                                </div>

                                <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
                                    The verification code will be sent to your email address.
                                </div>
                            </div>

                            <DialogFooter className="flex-col gap-2 sm:flex-col">
                                <Button
                                    onClick={verifyRegistrationOtp}
                                    disabled={registrationOtpLoading || registrationOtpCode.length !== 4}
                                    className="w-full h-11"
                                    style={{ backgroundColor: config.button_color }}
                                >
                                    {registrationOtpLoading ? (
                                        <>
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                            Verifying Code...
                                        </>
                                    ) : (
                                        'Verify and Create Account'
                                    )}
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={async () => {
                                        try {
                                            await requestRegistrationOtp(true)
                                        } catch (error: any) {
                                            setRegistrationOtpError(error.message || 'Unable to resend the verification code.')
                                        }
                                    }}
                                    disabled={registrationOtpSending || registrationResendCooldown > 0}
                                    className="w-full h-11"
                                >
                                    {registrationOtpSending ? (
                                        <>
                                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                            Sending New Code...
                                        </>
                                    ) : registrationResendCooldown > 0 ? (
                                        `Resend available in ${Math.floor(registrationResendCooldown / 60)}:${String(registrationResendCooldown % 60).padStart(2, '0')}`
                                    ) : (
                                        'Resend Email Code'
                                    )}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
            {/* Reward Detail Modal — sticky actions so Collect stays visible on short phones */}
            <Dialog open={showRewardDetailModal} onOpenChange={setShowRewardDetailModal}>
                <DialogContent className="flex w-full max-w-[90vw] flex-col gap-0 overflow-hidden rounded-2xl bg-white p-0 top-[max(0.5rem,env(safe-area-inset-top))] max-h-[calc(100dvh-1rem)] translate-y-0 sm:top-[50%] sm:max-h-[min(92dvh,92vh)] sm:translate-y-[-50%]">
                    <DialogTitle className="sr-only">
                        {selectedRewardForDetail?.item_name || 'Reward Details'}
                    </DialogTitle>
                    {(() => {
                        const animationUrl = (selectedRewardForDetail as any)?.animation_url
                        const images = (selectedRewardForDetail?.additional_images && selectedRewardForDetail.additional_images.length > 0)
                            ? selectedRewardForDetail.additional_images
                            : [selectedRewardForDetail?.item_image_url].filter(Boolean) as string[]

                        // Build media array: animation first (if exists), then images
                        const mediaItems: { type: 'video' | 'image'; url: string }[] = []
                        if (animationUrl) {
                            mediaItems.push({ type: 'video', url: animationUrl })
                        }
                        images.forEach(img => mediaItems.push({ type: 'image', url: img }))

                        return (
                            <div className="relative h-[min(8.5rem,20dvh)] w-full shrink-0 overflow-hidden bg-white sm:h-56">
                                <button
                                    type="button"
                                    onClick={() => setShowRewardDetailModal(false)}
                                    className="absolute top-3 right-3 z-20 rounded-full bg-black/10 p-2 transition-colors hover:bg-black/20"
                                >
                                    <X className="h-5 w-5 text-gray-600" />
                                </button>

                                {mediaItems.length > 0 ? (
                                    <motion.div
                                        className="flex h-full"
                                        style={{ width: `${mediaItems.length * 100}%` }}
                                        animate={{ x: `-${currentRewardImageIndex * (100 / mediaItems.length)}%` }}
                                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                                        drag={mediaItems.length > 1 ? "x" : false}
                                        dragElastic={0.2}
                                        onDragEnd={(e, { offset, velocity }) => {
                                            const swipe = offset.x
                                            const swipeThreshold = 50

                                            if (swipe < -swipeThreshold && currentRewardImageIndex < mediaItems.length - 1) {
                                                setCurrentRewardImageIndex(currentRewardImageIndex + 1)
                                            } else if (swipe > swipeThreshold && currentRewardImageIndex > 0) {
                                                setCurrentRewardImageIndex(currentRewardImageIndex - 1)
                                            }
                                        }}
                                    >
                                        {mediaItems.map((media, idx) => (
                                            <div
                                                key={idx}
                                                className="relative h-full"
                                                style={{ width: `${100 / mediaItems.length}%` }}
                                            >
                                                {media.type === 'video' ? (
                                                    <video
                                                        src={getStorageUrl(media.url) || media.url}
                                                        className="h-full w-full object-contain p-4"
                                                        controls
                                                        autoPlay
                                                        loop
                                                        playsInline
                                                    />
                                                ) : (
                                                    <Image
                                                        src={getStorageUrl(media.url) || media.url}
                                                        alt={selectedRewardForDetail?.item_name || 'Reward'}
                                                        fill
                                                        className="object-contain p-4"
                                                        priority={idx === currentRewardImageIndex}
                                                        draggable={false}
                                                    />
                                                )}
                                            </div>
                                        ))}
                                    </motion.div>
                                ) : (
                                    <div className="flex h-full w-full items-center justify-center">
                                        <Gift className="h-20 w-20 text-gray-300" />
                                    </div>
                                )}

                                {/* Media indicator dots */}
                                {mediaItems.length > 1 && (
                                    <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
                                        {mediaItems.map((_, idx) => (
                                            <button
                                                key={idx}
                                                type="button"
                                                onClick={() => setCurrentRewardImageIndex(idx)}
                                                className={`h-2 w-2 rounded-full transition-colors ${idx === currentRewardImageIndex
                                                    ? 'bg-gray-800'
                                                    : 'bg-gray-300'
                                                    }`}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>
                        )
                    })()}

                    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 py-3 sm:space-y-4 sm:px-6 sm:py-4">
                        <div>
                            <h3 className="text-lg font-bold text-gray-900 sm:text-xl">{selectedRewardForDetail?.item_name}</h3>
                            <p className="mt-1 text-sm text-gray-500">{selectedRewardForDetail?.item_description || 'No description available'}</p>
                        </div>

                        <div className="flex items-center justify-between border-b border-t border-gray-100 py-3 sm:py-4">
                            <div className="space-y-1">
                                {(selectedRewardForDetail as any)?.category === 'point' ? (
                                    <>
                                        <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Bonus Points</p>
                                        <div className="flex items-center gap-2">
                                            <div className="rounded-full bg-green-100 p-1.5">
                                                <Star className="h-4 w-4 fill-green-600 text-green-600" />
                                            </div>
                                            <span className="text-2xl font-bold text-green-600">
                                                +{formatNumber((selectedRewardForDetail as any)?.point_reward_amount || 0)}
                                            </span>
                                        </div>
                                        <p className="text-xs text-green-600">Free to collect!</p>
                                    </>
                                ) : (
                                    <>
                                        <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Points Required</p>
                                        <div className="flex items-center gap-2">
                                            <div className="rounded-full bg-amber-100 p-1.5">
                                                <Star className="h-4 w-4 fill-amber-600 text-amber-600" />
                                            </div>
                                            <span className="text-2xl font-bold text-gray-900">
                                                {formatNumber(selectedRewardForDetail?.point_offer || selectedRewardForDetail?.points_required)}
                                            </span>
                                        </div>
                                    </>
                                )}
                            </div>
                            <div className="space-y-1 text-right">
                                <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Stock</p>
                                <p className="text-lg font-semibold text-gray-900">
                                    {selectedRewardForDetail?.stock_quantity === null ? 'Unlimited' : selectedRewardForDetail?.stock_quantity}
                                </p>
                            </div>
                        </div>

                        <div className="space-y-3 pt-1">
                            <div className="flex items-center gap-2 text-sm text-gray-600">
                                <CheckCircle2 className="h-4 w-4 text-green-500" />
                                <span>Staff verification not required</span>
                            </div>
                            <div className="flex items-center gap-2 text-sm text-gray-600">
                                <CheckCircle2 className="h-4 w-4 text-green-500" />
                                <span>No per-consumer limit set</span>
                            </div>
                        </div>
                    </div>

                    <div
                        className="flex shrink-0 gap-3 border-t border-gray-100 bg-white px-4 pt-3"
                        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}
                    >
                        <Button
                            type="button"
                            variant="outline"
                            className="h-12 flex-1 rounded-xl border-gray-200"
                            onClick={() => setShowRewardDetailModal(false)}
                        >
                            Close
                        </Button>
                        {selectedRewardForDetail && (
                            (selectedRewardForDetail as any)?.category === 'point' ? (
                                <Button
                                    type="button"
                                    className="h-12 flex-1 rounded-xl text-white shadow-lg shadow-green-500/20"
                                    style={{ backgroundColor: '#10B981' }}
                                    onClick={() => {
                                        setShowRewardDetailModal(false)
                                        handleRedeemReward(selectedRewardForDetail)
                                    }}
                                    disabled={!isAuthenticated}
                                >
                                    <Gift className="mr-2 h-4 w-4" />
                                    Collect Points
                                </Button>
                            ) : userPoints < (selectedRewardForDetail.point_offer || selectedRewardForDetail.points_required) ? (
                                <Button
                                    type="button"
                                    className="h-12 flex-1 rounded-xl border-none bg-blue-100 text-blue-600 shadow-none hover:bg-blue-200"
                                    onClick={() => {
                                        setShowRewardDetailModal(false)
                                        setInsufficientPointsData({
                                            needed: selectedRewardForDetail.point_offer || selectedRewardForDetail.points_required,
                                            available: userPoints
                                        })
                                        setShowInsufficientPoints(true)
                                    }}
                                >
                                    <Coins className="mr-2 h-4 w-4" />
                                    Need more points
                                </Button>
                            ) : (
                                <Button
                                    type="button"
                                    className="h-12 flex-1 rounded-xl text-white shadow-lg shadow-blue-500/20"
                                    style={{ backgroundColor: config.button_color }}
                                    onClick={() => {
                                        setShowRewardDetailModal(false)
                                        handleRedeemReward(selectedRewardForDetail)
                                    }}
                                    disabled={!isAuthenticated}
                                >
                                    Redeem Now
                                </Button>
                            )
                        )}
                    </div>
                </DialogContent>
            </Dialog>
            </div>
        </div>
    )
}

// Utility function to adjust color brightness
function adjustColor(color: string, amount: number): string {
    const hex = color.replace('#', '')
    const num = parseInt(hex, 16)
    const r = Math.max(0, Math.min(255, (num >> 16) + amount))
    const g = Math.max(0, Math.min(255, ((num >> 8) & 0x00ff) + amount))
    const b = Math.max(0, Math.min(255, (num & 0x0000ff) + amount))
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}
