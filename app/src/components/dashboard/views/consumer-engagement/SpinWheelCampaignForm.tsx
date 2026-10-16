'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ArrowLeft, Save, Plus, Trash2, Gift, Smartphone, ChevronLeft, ChevronRight } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import dynamic from 'next/dynamic'

// Dynamically import Wheel to avoid SSR issues with canvas
const Wheel = dynamic(
  () => import('react-custom-roulette').then((mod) => mod.Wheel),
  { ssr: false }
)

const THEMES = [
    { id: 'default', name: 'Vibrant Party' },
    { id: 'casino', name: 'Casino Royale' },
    { id: 'cartoon_royal', name: 'Cartoon Royal' }
]

const TEMPLATE_STYLES: Record<string, any> = {
    default: {
        colors: [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', 
            '#F7DC6F', '#BB8FCE', '#F1948A', '#82E0AA', '#F5B041'
        ],
        outerBorderColor: '#f3f4f6',
        outerBorderWidth: 5,
        innerBorderColor: '#f3f4f6',
        innerRadius: 20,
        radiusLineColor: '#f3f4f6',
        radiusLineWidth: 1,
        textColor: '#ffffff'
    },
    casino: {
        colors: [
            '#8B0000', // Dark Red
            '#006400', // Dark Green
            '#4B0082', // Indigo
            '#00008B', // Dark Blue
            '#8B4500', // Saddle Brown
            '#B8860B'  // Dark Goldenrod
        ],
        outerBorderColor: '#1a1a1a',
        outerBorderWidth: 12,
        innerBorderColor: '#1a1a1a',
        innerRadius: 15,
        radiusLineColor: '#000000',
        radiusLineWidth: 2,
        textColor: '#ffffff'
    },
    cartoon_royal: {
        colors: ['#8E44AD', '#F39C12', '#8E44AD', '#F39C12', '#8E44AD', '#F39C12'],
        outerBorderColor: '#F1C40F',
        outerBorderWidth: 8,
        innerBorderColor: '#F1C40F',
        innerRadius: 0,
        radiusLineColor: '#F1C40F',
        radiusLineWidth: 2,
        textColor: '#ffffff',
        centerImage: 'https://api.dicebear.com/9.x/avataaars/svg?seed=Felix',
        buttonStyle: {
            background: 'linear-gradient(to bottom, #9B59B6, #8E44AD)',
            border: '4px solid #F1C40F',
            color: '#F1C40F',
            textShadow: '1px 1px 2px rgba(0,0,0,0.5)',
            boxShadow: '0 4px 0 #6C3483, 0 5px 10px rgba(0,0,0,0.3)'
        }
    }
}

const SpinWheelPreview = ({ rewards, themeConfig, maxTotalPlays }: { rewards: any[], themeConfig: any, maxTotalPlays: number }) => {
    const [mustSpin, setMustSpin] = useState(false)
    const [prizeNumber, setPrizeNumber] = useState(0)
    
    // Audio refs
    const spinAudioRef = useRef<HTMLAudioElement | null>(null)
    const winAudioRef = useRef<HTMLAudioElement | null>(null)

    useEffect(() => {
        // Initialize audio
        spinAudioRef.current = new Audio('/sounds/spin-wheel.mp3')
        spinAudioRef.current.loop = true
        spinAudioRef.current.volume = 0.4
        
        winAudioRef.current = new Audio('/sounds/win.mp3')
        winAudioRef.current.volume = 0.5
        
        return () => {
            if (spinAudioRef.current) {
                spinAudioRef.current.pause()
                spinAudioRef.current = null
            }
            if (winAudioRef.current) {
                winAudioRef.current.pause()
                winAudioRef.current = null
            }
        }
    }, [])

    const totalAllocated = rewards.reduce((sum, r) => sum + (parseInt(r.quantity_allocated) || 0), 0)
    const noPrizeCount = Math.max(0, maxTotalPlays - totalAllocated)
    
    const templateId = themeConfig.template_id || 'default'
    const style = TEMPLATE_STYLES[templateId] || TEMPLATE_STYLES.default
    
    // Combine rewards and no-prize into segments
    const segments = [
        ...rewards.map(r => ({ 
            option: r.name?.substring(0, 15) || 'Reward', 
            style: { backgroundColor: '#ffffff', textColor: style.textColor } 
        })),
        ...(noPrizeCount > 0 ? [{ 
            option: 'Try Again', 
            style: { backgroundColor: '#e2e8f0', textColor: '#64748b' } 
        }] : [])
    ]

    // Apply alternating colors if all are white
    const finalSegments = segments.map((seg, i) => {
        // Use template colors palette
        const color = style.colors[i % style.colors.length]
        return {
            ...seg,
            style: {
                backgroundColor: color,
                textColor: style.textColor
            }
        }
    })

    if (finalSegments.length === 0) {
        return (
            <div className="w-full aspect-square rounded-full bg-slate-100 flex items-center justify-center border-4 border-slate-200">
                <p className="text-slate-400">Add rewards to see preview</p>
            </div>
        )
    }

    const handleSpinClick = () => {
        if (!mustSpin) {
            const newPrizeNumber = Math.floor(Math.random() * finalSegments.length)
            setPrizeNumber(newPrizeNumber)
            setMustSpin(true)
            
            // Play spin sound
            if (spinAudioRef.current) {
                spinAudioRef.current.currentTime = 0
                spinAudioRef.current.play().catch(e => console.log('Audio play failed', e))
            }
        }
    }

    return (
        <div className="flex flex-col items-center">
            <div className="relative mx-auto my-8">
                <Wheel
                    mustStartSpinning={mustSpin}
                    prizeNumber={prizeNumber}
                    data={finalSegments}
                    spinDuration={0.6}
                    backgroundColors={style.colors}
                    textColors={[style.textColor]}
                    outerBorderColor={style.outerBorderColor}
                    outerBorderWidth={style.outerBorderWidth}
                    innerRadius={style.innerRadius}
                    innerBorderColor={style.innerBorderColor}
                    innerBorderWidth={0}
                    radiusLineColor={style.radiusLineColor}
                    radiusLineWidth={style.radiusLineWidth}
                    onStopSpinning={() => {
                        setMustSpin(false)
                        
                        // Stop spin sound
                        if (spinAudioRef.current) {
                            spinAudioRef.current.pause()
                            spinAudioRef.current.currentTime = 0
                        }
                        
                        // Play win sound
                        if (winAudioRef.current) {
                            winAudioRef.current.currentTime = 0
                            winAudioRef.current.play().catch(e => console.log('Audio play failed', e))
                        }
                    }}
                />
                {/* Center Image Overlay */}
                {style.centerImage && (
                    <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-24 h-24 z-10 pointer-events-none">
                        <img 
                            src={style.centerImage} 
                            alt="Center" 
                            className="w-full h-full object-contain drop-shadow-lg"
                        />
                    </div>
                )}
            </div>
            <Button 
                className="mt-4 px-12 py-6 text-2xl font-black rounded-full transition-transform active:scale-95 shadow-xl" 
                style={style.buttonStyle ? style.buttonStyle : { backgroundColor: themeConfig.primary_color }}
                onClick={handleSpinClick}
                disabled={mustSpin}
            >
                {mustSpin ? 'SPINNING...' : 'SPIN'}
            </Button>
        </div>
    )
}

interface SpinWheelCampaignFormProps {
    userProfile: any
    campaignId: string | null
    initialJourneyId?: string
    onBack: () => void
}

export default function SpinWheelCampaignForm({ userProfile, campaignId, initialJourneyId, onBack }: SpinWheelCampaignFormProps) {
    const [loading, setLoading] = useState(false)
    const [journeys, setJourneys] = useState<any[]>([])
    const [products, setProducts] = useState<any[]>([])
    const [pointValueRM, setPointValueRM] = useState(0)
    const { toast } = useToast()
    const supabase = createClient()

    const [formData, setFormData] = useState({
        name: '',
        description: '',
        journey_config_id: initialJourneyId || '',
        status: 'draft',
        start_at: '',
        end_at: '',
        plays_per_qr: 1,
        max_plays_per_day: 1,
        max_plays_total_per_consumer: 0, // 0 means unlimited
        max_total_plays: 0, // 0 means unlimited
        theme_config: {
            theme_id: 'modern',
            primary_color: '#3B82F6',
            title_text: 'Spin to Win!',
            success_message: 'You’ve won: {{reward_name}}',
            no_prize_message: 'Not this time, try again soon!',
            show_confetti: true,
            play_sound: true
        }
    })

    const [rewards, setRewards] = useState<any[]>([])
    const [winners, setWinners] = useState<any[]>([])

    useEffect(() => {
        fetchJourneys()
        fetchProducts()
        fetchOrgSettings()
        if (campaignId) {
            fetchCampaign()
            fetchWinners()
        }
    }, [campaignId])

    const fetchWinners = async () => {
        if (!campaignId) return
        const { data } = await supabase
            .from('spin_wheel_plays')
            .select(`
                *,
                spin_wheel_rewards (
                    name,
                    type,
                    image_url,
                    variant_id,
                    product_variants (
                        image_url
                    )
                )
            `)
            .eq('campaign_id', campaignId)
            .eq('is_win', true)
            .order('played_at', { ascending: false })
        
        if (data) setWinners(data)
    }

    // Auto-sync QR stats when journey is loaded
    useEffect(() => {
        const syncStats = async () => {
            if (formData.journey_config_id && journeys.length > 0) {
                const selectedJourney = journeys.find(j => j.id === formData.journey_config_id)
                
                if (selectedJourney?.order_id) {
                    try {
                        const response = await fetch(`/api/journey/qr-stats?order_id=${selectedJourney.order_id}`)
                        const data = await response.json()
                        
                        if (data.success && data.data) {
                            // Only update if value is different
                            if (formData.max_total_plays !== data.data.total_valid_links) {
                                setFormData(prev => ({ 
                                    ...prev, 
                                    max_total_plays: data.data.total_valid_links
                                }))
                            }
                        }
                    } catch (error) {
                        console.error('Error syncing QR stats:', error)
                    }
                }
            }
        }
        
        syncStats()
    }, [formData.journey_config_id, journeys, formData.max_total_plays])

    const handleThemeChange = (direction: 'next' | 'prev') => {
        const currentIndex = THEMES.findIndex(t => t.id === formData.theme_config.theme_id)
        let newIndex
        if (direction === 'next') {
            newIndex = (currentIndex + 1) % THEMES.length
        } else {
            newIndex = (currentIndex - 1 + THEMES.length) % THEMES.length
        }
        setFormData({
            ...formData,
            theme_config: { ...formData.theme_config, theme_id: THEMES[newIndex].id }
        })
    }

    const handleJourneyChange = async (journeyId: string) => {
        const selectedJourney = journeys.find(j => j.id === journeyId)
        
        setFormData(prev => ({ 
            ...prev, 
            journey_config_id: journeyId,
            start_at: selectedJourney?.start_at ? selectedJourney.start_at.split('T')[0] : '',
            end_at: selectedJourney?.end_at ? selectedJourney.end_at.split('T')[0] : ''
        }))
        
        if (!journeyId) return

        // Try to fetch accurate stats using the API if we have an order_id
        if (selectedJourney?.order_id) {
            try {
                const response = await fetch(`/api/journey/qr-stats?order_id=${selectedJourney.order_id}`)
                const data = await response.json()
                
                if (data.success && data.data) {
                    setFormData(prev => ({ 
                        ...prev, 
                        max_total_plays: data.data.total_valid_links,
                        max_plays_per_day: 0, // Unlimited (system rule)
                        max_plays_total_per_consumer: 0 // Unlimited (system rule)
                    }))
                    return // Exit if successful
                }
            } catch (error) {
                console.error('Error fetching QR stats:', error)
            }
        }

        // Fallback to RPC if API fails or no order_id
        const { data, error } = await supabase.rpc('get_journey_qr_count', {
            p_journey_config_id: journeyId
        })

        if (!error && typeof data === 'number') {
            setFormData(prev => ({ 
                ...prev, 
                max_total_plays: data,
                max_plays_per_day: 0, // Unlimited (system rule)
                max_plays_total_per_consumer: 0 // Unlimited (system rule)
            }))
        }
    }

    const fetchOrgSettings = async () => {
        const { data } = await supabase
            .from('organizations')
            .select('settings')
            .eq('id', userProfile.organization_id)
            .single()
        
        if (data?.settings && typeof data.settings === 'object') {
            const settings = data.settings as any
            if (settings.point_value_rm) {
                setPointValueRM(Number(settings.point_value_rm) || 0)
            }
        }
    }

    const fetchJourneys = async () => {
        const { data: journeysData } = await supabase
            .from('journey_configurations')
            .select('id, name, start_at, end_at')
            .eq('org_id', userProfile.organization_id)
            .eq('is_active', true)
        
        if (journeysData) {
            // Fetch linked orders
            const { data: links } = await supabase
                .from('journey_order_links')
                .select('journey_config_id, order_id')
                .in('journey_config_id', journeysData.map(j => j.id))

            const journeysWithOrder = journeysData.map(j => {
                const link = links?.find(l => l.journey_config_id === j.id)
                return {
                    ...j,
                    order_id: link?.order_id
                }
            })
            setJourneys(journeysWithOrder)
        }
    }

    const fetchProducts = async () => {
        try {
            const { data, error } = await supabase
                .from('product_inventory')
                .select(`
                    variant_id,
                    quantity_available,
                    product_variants (
                        id,
                        variant_name,
                        image_url,
                        base_cost,
                        products (
                            id,
                            product_name
                        )
                    )
                `)
                .gt('quantity_available', 0)

            if (error) throw error

            if (data) {
                const aggregatedProducts = new Map();

                data.forEach((item: any) => {
                    const variant = Array.isArray(item.product_variants) ? item.product_variants[0] : item.product_variants
                    if (!variant) return;

                    const variantId = item.variant_id;
                    const current = aggregatedProducts.get(variantId);
                    
                    if (current) {
                        current.quantity_available += item.quantity_available;
                    } else {
                        const product = variant.products ? (Array.isArray(variant.products) ? variant.products[0] : variant.products) : null
                        aggregatedProducts.set(variantId, {
                            variant_id: variantId,
                            product_id: product?.id,
                            product_name: product?.product_name || 'Unknown',
                            variant_name: variant.variant_name || 'Unknown',
                            quantity_available: item.quantity_available,
                            variant_image_url: variant.image_url,
                            base_cost: variant.base_cost
                        });
                    }
                });

                setProducts(Array.from(aggregatedProducts.values()));
            }
        } catch (error) {
            console.error('Error fetching products:', error)
            toast({ title: "Error", description: "Failed to load products", variant: "destructive" })
        }
    }

    const fetchCampaign = async () => {
        // Only called when campaignId is set (see the effect above).
        if (!campaignId) return
        setLoading(true)
        const { data: campaign, error } = await supabase
            .from('spin_wheel_campaigns')
            .select('*')
            .eq('id', campaignId)
            .single()

        if (error) {
            toast({ title: "Error", description: "Failed to load campaign", variant: "destructive" })
            onBack()
            return
        }

        setFormData({
            name: campaign.name,
            description: campaign.description || '',
            journey_config_id: campaign.journey_config_id || '',
            status: campaign.status,
            start_at: campaign.start_at ? campaign.start_at.split('T')[0] : '',
            end_at: campaign.end_at ? campaign.end_at.split('T')[0] : '',
            plays_per_qr: campaign.plays_per_qr || 1,
            max_plays_per_day: campaign.max_plays_per_day,
            max_plays_total_per_consumer: campaign.max_plays_total_per_consumer || 0,
            max_total_plays: campaign.max_total_plays || 0,
            theme_config: campaign.theme_config || formData.theme_config
        })

        const { data: rewardsData } = await supabase
            .from('spin_wheel_rewards')
            .select('*')
            .eq('campaign_id', campaignId)
        
        if (rewardsData) setRewards(rewardsData)
        setLoading(false)
    }

    const handleSave = async () => {
        if (!formData.name) {
            toast({ title: "Error", description: "Campaign name is required", variant: "destructive" })
            return
        }

        // Validate allocation
        const totalAllocated = rewards.reduce((sum, r) => sum + (parseInt(r.quantity_allocated) || 0), 0)
        if (formData.max_total_plays > 0 && totalAllocated > formData.max_total_plays) {
            toast({ 
                title: "Error", 
                description: `Total allocated rewards (${totalAllocated}) exceeds Max Total Plays (${formData.max_total_plays}).`, 
                variant: "destructive" 
            })
            return
        }

        setLoading(true)
        
        const campaignData = {
            org_id: userProfile.organization_id,
            name: formData.name,
            description: formData.description,
            journey_config_id: formData.journey_config_id || null,
            status: formData.status,
            start_at: formData.start_at ? new Date(formData.start_at).toISOString() : null,
            end_at: formData.end_at ? new Date(formData.end_at).toISOString() : null,
            plays_per_qr: formData.plays_per_qr,
            max_plays_per_day: null, // System rule: Unlimited daily plays (limited by QR)
            max_plays_total_per_consumer: null, // System rule: Unlimited consumer plays (limited by QR)
            max_total_plays: formData.max_total_plays || null,
            theme_config: formData.theme_config,
            updated_at: new Date().toISOString(),
            created_by: userProfile.id
        }

        let currentCampaignId = campaignId

        if (campaignId) {
            const { error } = await supabase
                .from('spin_wheel_campaigns')
                .update(campaignData)
                .eq('id', campaignId)
            
            if (error) {
                toast({ title: "Error", description: error.message, variant: "destructive" })
                setLoading(false)
                return
            }
        } else {
            const { data, error } = await supabase
                .from('spin_wheel_campaigns')
                .insert(campaignData)
                .select()
                .single()
            
            if (error) {
                toast({ title: "Error", description: error.message, variant: "destructive" })
                setLoading(false)
                return
            }
            currentCampaignId = data.id
        }

        // Save rewards
        let existingRewards: any[] = []
        if (campaignId) {
            const { data } = await supabase.from('spin_wheel_rewards').select('*').eq('campaign_id', campaignId)
            existingRewards = data || []
        }

        if (rewards.length > 0) {
            // 1. Handle Deletions
            const currentRewardIds = rewards.map(r => r.id).filter(Boolean)
            const rewardsToDelete = existingRewards.filter(r => !currentRewardIds.includes(r.id))
            
            if (rewardsToDelete.length > 0) {
                const { error: deleteError } = await supabase
                    .from('spin_wheel_rewards')
                    .delete()
                    .in('id', rewardsToDelete.map(r => r.id))
                
                if (deleteError) {
                    console.error("Failed to delete rewards:", deleteError)
                    toast({ 
                        title: "Warning", 
                        description: "Some removed rewards could not be deleted because they have already been played/won. They will remain in the system.", 
                        variant: "destructive" 
                    })
                }
            }

            // 2. Handle Upserts (Update or Insert)
            for (const reward of rewards) {
                const rewardData = {
                    campaign_id: currentCampaignId,
                    name: reward.name,
                    type: reward.type,
                    value_points: reward.value_points || null,
                    product_id: reward.product_id || null,
                    variant_id: reward.variant_id || null,
                    product_quantity: reward.product_quantity || 1,
                    quantity_allocated: reward.quantity_allocated || 0,
                    quantity_remaining: reward.quantity_allocated || 0,
                    external_link: reward.external_link || null,
                    image_url: reward.image_url || null,
                    max_winners_per_day: reward.max_winners_per_day || null,
                    is_active: reward.is_active !== false
                }

                if (reward.id) {
                    // Update
                    const { error: updateError } = await supabase
                        .from('spin_wheel_rewards')
                        .update(rewardData)
                        .eq('id', reward.id)
                    
                    if (updateError) {
                        console.error('Reward update error:', updateError)
                        toast({ title: "Error", description: `Failed to update reward: ${reward.name}`, variant: "destructive" })
                    }
                } else {
                    // Insert
                    const { error: insertError } = await supabase
                        .from('spin_wheel_rewards')
                        .insert(rewardData)
                    
                    if (insertError) {
                        console.error('Reward insert error:', insertError)
                        toast({ title: "Error", description: `Failed to create reward: ${reward.name}`, variant: "destructive" })
                    }
                }
            }

            // 3. Stock Movements
            try {
                const stockChanges = new Map<string, number>()

                // Add new requirements (deduct from stock)
                rewards.forEach(r => {
                    if (r.type === 'product' && r.variant_id && r.quantity_allocated) {
                        const itemsPerWin = r.product_quantity || 1
                        const totalItems = r.quantity_allocated * itemsPerWin
                        const current = stockChanges.get(r.variant_id) || 0
                        stockChanges.set(r.variant_id, current + totalItems)
                    }
                })

                // Subtract existing allocations (return to stock)
                existingRewards.forEach(r => {
                    if (r.type === 'product' && r.variant_id && r.quantity_allocated) {
                        const itemsPerWin = r.product_quantity || 1
                        const totalItems = r.quantity_allocated * itemsPerWin
                        const current = stockChanges.get(r.variant_id) || 0
                        stockChanges.set(r.variant_id, current - totalItems)
                    }
                })

                // Process stock movements
                for (const [variantId, change] of stockChanges.entries()) {
                    if (change === 0) continue

                    const { data: standardConfig } = await supabase.from('inventory_stock_configurations')
                        .select('id').eq('variant_id', variantId).eq('status', 'active')
                        .is('volume_ml', null).is('packaging', null).maybeSingle()
                    if (!standardConfig) throw new Error('Configured inventory rewards require an exact Stock SKU workflow and cannot be posted from this campaign screen.')

                    // Determine target organization
                    let targetOrgId = userProfile.organization_id
                    
                    const { data: inventoryData } = await supabase
                        .from('product_inventory')
                        .select('organization_id, quantity_available')
                        .eq('variant_id', variantId)
                        .eq('stock_config_id', standardConfig.id)
                        .gt('quantity_available', 0)
                        .order('quantity_available', { ascending: false })
                    
                    if (inventoryData && inventoryData.length > 0) {
                        if (change > 0) {
                            // Deducting: Prefer user's org if enough stock
                            const userOrgStock = inventoryData.find(i => i.organization_id === userProfile.organization_id)
                            if (userOrgStock && userOrgStock.quantity_available >= change) {
                                targetOrgId = userProfile.organization_id
                            } else {
                                targetOrgId = inventoryData[0].organization_id
                            }
                        } else {
                            // Returning: Prefer user's org
                            const userOrgStock = inventoryData.find(i => i.organization_id === userProfile.organization_id)
                            if (userOrgStock) {
                                targetOrgId = userProfile.organization_id
                            } else {
                                targetOrgId = inventoryData[0].organization_id
                            }
                        }
                    } else {
                         const { data: anyInventory } = await supabase
                            .from('product_inventory')
                            .select('organization_id')
                            .eq('variant_id', variantId)
                            .limit(1)
                        
                        if (anyInventory && anyInventory.length > 0) {
                            targetOrgId = anyInventory[0].organization_id
                        }
                    }

                    const quantityChange = -1 * change
                    const movementType = quantityChange < 0 ? 'spin_wheel_out' : 'spin_wheel_in'
                    
                    if (!targetOrgId) {
                        console.error('No target organization found for stock movement')
                        throw new Error('No target organization found for stock movement')
                    }
                    
                    const { error: stockMoveError } = await supabase.rpc('record_stock_movement', {
                        p_movement_type: movementType,
                        p_variant_id: variantId,
                        p_organization_id: targetOrgId,
                        p_quantity_change: quantityChange,
                        p_unit_cost: 0, 
                        p_reason: `Spin Wheel Campaign: ${formData.name}`,
                        p_reference_type: 'campaign',
                        p_reference_id: currentCampaignId,
                        p_created_by: userProfile.id,
                        p_stock_config_id: standardConfig.id,
                    })

                    if (stockMoveError) {
                        console.error('Stock movement RPC error:', JSON.stringify(stockMoveError, null, 2))
                        throw new Error(`Stock movement failed: ${stockMoveError.message || JSON.stringify(stockMoveError)}`)
                    }
                }
            } catch (stockError: any) {
                console.error('Stock movement error:', stockError)
                toast({ 
                    title: "Warning", 
                    description: `Campaign saved but stock updates failed: ${stockError.message || 'Unknown error'}`, 
                    variant: "destructive" 
                })
            }
        }

        toast({ title: "Success", description: "Campaign saved successfully" })
        setLoading(false)
        onBack()
    }

    const handleImageUpload = async (index: number, file: File) => {
        if (!file) return

        const reader = new FileReader()
        reader.onload = (e) => {
            const img = new Image()
            img.onload = () => {
                const canvas = document.createElement('canvas')
                const MAX_WIDTH = 150
                const MAX_HEIGHT = 150
                let width = img.width
                let height = img.height

                if (width > height) {
                    if (width > MAX_WIDTH) {
                        height *= MAX_WIDTH / width
                        width = MAX_WIDTH
                    }
                } else {
                    if (height > MAX_HEIGHT) {
                        width *= MAX_HEIGHT / height
                        height = MAX_HEIGHT
                    }
                }

                canvas.width = width
                canvas.height = height
                const ctx = canvas.getContext('2d')
                if (ctx) {
                    ctx.drawImage(img, 0, 0, width, height)
                    let dataUrl = canvas.toDataURL('image/webp', 0.5)
                    if (dataUrl.indexOf('data:image/webp') === -1) {
                        ctx.globalCompositeOperation = 'destination-over'
                        ctx.fillStyle = '#ffffff'
                        ctx.fillRect(0, 0, width, height)
                        dataUrl = canvas.toDataURL('image/jpeg', 0.5)
                    }
                    updateReward(index, 'image_url', dataUrl)
                }
            }
            img.src = e.target?.result as string
        }
        reader.readAsDataURL(file)
    }

    const addReward = () => {
        setRewards([...rewards, {
            name: 'New Reward',
            type: 'points',
            quantity_allocated: 0,
            is_active: true
        }])
    }

    const removeReward = (index: number) => {
        const newRewards = [...rewards]
        newRewards.splice(index, 1)
        setRewards(newRewards)
    }

    const updateReward = (index: number, field: string, value: any) => {
        const newRewards = [...rewards]
        newRewards[index] = { ...newRewards[index], [field]: value }
        setRewards(newRewards)
    }

    return (
        <div className="space-y-6 pb-20">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="icon" onClick={onBack}>
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <div>
                        <h2 className="text-2xl font-bold tracking-tight">
                            {campaignId ? 'Edit Spin Wheel Campaign' : 'New Spin Wheel Campaign'}
                        </h2>
                    </div>
                </div>
                <Button onClick={handleSave} disabled={loading}>
                    <Save className="mr-2 h-4 w-4" />
                    {loading ? 'Saving...' : 'Save Campaign'}
                </Button>
            </div>

            <Tabs defaultValue="basic" className="space-y-4">
                <TabsList>
                    <TabsTrigger value="basic">Basic Info</TabsTrigger>
                    <TabsTrigger value="rewards">Rewards & Segments</TabsTrigger>
                    <TabsTrigger value="design">Design & Experience</TabsTrigger>
                    <TabsTrigger value="winners">Winners</TabsTrigger>
                </TabsList>

                <TabsContent value="basic">
                    <Card>
                        <CardHeader>
                            <CardTitle>Campaign Details</CardTitle>
                            <CardDescription>Configure the basic settings for your spin wheel campaign.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>Campaign Name</Label>
                                    <Input 
                                        value={formData.name} 
                                        onChange={(e) => setFormData({...formData, name: e.target.value})}
                                        placeholder="e.g. Lucky Spin"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>Status</Label>
                                    <Select 
                                        value={formData.status} 
                                        onValueChange={(val) => setFormData({...formData, status: val})}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="draft">Draft</SelectItem>
                                            <SelectItem value="active">Active</SelectItem>
                                            <SelectItem value="scheduled">Scheduled</SelectItem>
                                            <SelectItem value="ended">Ended</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label>Linked Journey</Label>
                                <Select 
                                    value={formData.journey_config_id} 
                                    onValueChange={handleJourneyChange}
                                    disabled={journeys.length === 0 || !!initialJourneyId}
                                >
                                    <SelectTrigger>
                                        <SelectValue placeholder={journeys.length === 0 ? "No journeys found. Please create a journey first." : "Select a journey..."} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {journeys.map(j => (
                                            <SelectItem key={j.id} value={j.id}>{j.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            {formData.journey_config_id && (
                                <div className="bg-slate-50 border rounded-lg p-4 space-y-2">
                                    <h4 className="font-medium text-sm text-slate-900">Journey Info (Auto-Synced)</h4>
                                    <div className="grid grid-cols-2 gap-4 text-sm">
                                        <div>
                                            <span className="text-muted-foreground block">Start Date</span>
                                            <span className="font-medium">{formData.start_at || '-'}</span>
                                        </div>
                                        <div>
                                            <span className="text-muted-foreground block">End Date</span>
                                            <span className="font-medium">{formData.end_at || '-'}</span>
                                        </div>
                                        <div>
                                            <span className="text-muted-foreground block">Total QR Codes</span>
                                            <span className="font-medium">{formData.max_total_plays || 0}</span>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="space-y-2">
                                <Label>Plays per QR Code</Label>
                                <Input 
                                    type="number" 
                                    min="1"
                                    value={formData.plays_per_qr} 
                                    onChange={(e) => setFormData({...formData, plays_per_qr: parseInt(e.target.value) || 1})}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label>Description (Optional)</Label>
                                <Textarea 
                                    value={formData.description} 
                                    onChange={(e) => setFormData({...formData, description: e.target.value})}
                                    placeholder="Internal description..."
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="rewards">
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <div>
                                <CardTitle>Rewards & Segments</CardTitle>
                                <CardDescription>
                                    Each reward represents a segment on the wheel.
                                </CardDescription>
                            </div>
                            <Button size="sm" onClick={addReward}>
                                <Plus className="mr-2 h-4 w-4" /> Add Segment
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {rewards.map((reward, index) => {
                                const totalPlays = formData.max_total_plays > 0 ? formData.max_total_plays : rewards.reduce((sum, r) => sum + (parseInt(r.quantity_allocated) || 0), 0)
                                const chance = totalPlays > 0 ? ((reward.quantity_allocated || 0) / totalPlays * 100).toFixed(2) : '0.00'
                                
                                return (
                                <div key={index} className="flex gap-4 items-start p-4 border rounded-lg bg-slate-50">
                                    <div className="flex-1 grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <Label>Segment Name</Label>
                                            <Input 
                                                value={reward.name} 
                                                onChange={(e) => updateReward(index, 'name', e.target.value)}
                                                placeholder="e.g. 100 Points"
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Type</Label>
                                            <Select 
                                                value={reward.type} 
                                                onValueChange={(val) => updateReward(index, 'type', val)}
                                            >
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="points">Points</SelectItem>
                                                    <SelectItem value="product">Product Gift</SelectItem>
                                                    <SelectItem value="voucher">Voucher</SelectItem>
                                                    <SelectItem value="link">Mystery Gift</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        {reward.type === 'points' && (
                                            <div className="space-y-2">
                                                <Label>Points Value</Label>
                                                <Input 
                                                    type="number" 
                                                    value={reward.value_points || ''} 
                                                    onChange={(e) => {
                                                        const val = parseInt(e.target.value)
                                                        updateReward(index, 'value_points', isNaN(val) ? 0 : val)
                                                    }}
                                                />
                                            </div>
                                        )}

                                        {reward.type === 'product' && (
                                            <div className="space-y-2">
                                                <Label>Product</Label>
                                                <Select 
                                                    value={reward.variant_id || ''} 
                                                    onValueChange={(val) => {
                                                        const selected = products.find(p => p.variant_id === val)
                                                        const newRewards = [...rewards]
                                                        newRewards[index] = { 
                                                            ...newRewards[index], 
                                                            variant_id: val,
                                                            product_id: selected?.product_id || null
                                                        }
                                                        setRewards(newRewards)
                                                    }}
                                                    disabled={products.length === 0}
                                                >
                                                    <SelectTrigger>
                                                        <SelectValue placeholder={products.length === 0 ? "No products found" : "Select product..."} />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {products.length === 0 ? (
                                                            <SelectItem value="none" disabled>No products available</SelectItem>
                                                        ) : (
                                                            products.map(p => (
                                                                <SelectItem key={p.variant_id} value={p.variant_id}>
                                                                    <div className="flex justify-between w-full gap-4">
                                                                        <span>{p.product_name} - {p.variant_name}</span>
                                                                        <span className="text-muted-foreground">({p.quantity_available} Available)</span>
                                                                    </div>
                                                                </SelectItem>
                                                            ))
                                                        )}
                                                    </SelectContent>
                                                </Select>
                                                
                                                <div className="space-y-2 mt-2">
                                                    <Label>Items per Winner</Label>
                                                    <Input
                                                        type="number"
                                                        min="1"
                                                        value={reward.product_quantity || 1}
                                                        onChange={(e) => {
                                                            const val = parseInt(e.target.value)
                                                            updateReward(index, 'product_quantity', isNaN(val) ? 1 : val)
                                                        }}
                                                        placeholder="Qty"
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        <div className="space-y-2">
                                            <Label>Quantity to Allocate</Label>
                                            <Input 
                                                type="number" 
                                                min="0"
                                                value={reward.quantity_allocated || ''} 
                                                onChange={(e) => {
                                                    const val = parseInt(e.target.value)
                                                    updateReward(index, 'quantity_allocated', isNaN(val) ? 0 : val)
                                                }}
                                                placeholder="Total wins available"
                                            />
                                            <p className="text-xs text-muted-foreground">
                                                Implied Chance: {chance}%
                                            </p>
                                        </div>
                                    </div>
                                    <Button variant="ghost" size="icon" className="text-red-500 mt-8" onClick={() => removeReward(index)}>
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            )})}
                            
                            {/* No Prize Summary */}
                            {(() => {
                                const totalAllocated = rewards.reduce((sum, r) => sum + (parseInt(r.quantity_allocated) || 0), 0)
                                const noPrizeCount = Math.max(0, formData.max_total_plays - totalAllocated)
                                const totalPlays = formData.max_total_plays > 0 ? formData.max_total_plays : totalAllocated
                                const noPrizeChance = totalPlays > 0 ? (noPrizeCount / totalPlays * 100).toFixed(2) : '0.00'
                                
                                return (
                                    <div className="flex gap-4 items-center p-4 border rounded-lg bg-gray-100 text-gray-500">
                                        <div className="flex-1 grid grid-cols-2 gap-4">
                                            <div className="space-y-2">
                                                <Label>Segment Name</Label>
                                                <Input value="No Prize (Try Again)" disabled className="bg-gray-200" />
                                            </div>
                                            <div className="space-y-2">
                                                <Label>Type</Label>
                                                <Input value="System Generated" disabled className="bg-gray-200" />
                                            </div>
                                            <div className="space-y-2 col-span-2">
                                                <Label>Quantity (Auto-Calculated)</Label>
                                                <div className="flex items-center justify-between p-2 border rounded bg-gray-200">
                                                    <span className="font-mono font-bold">{noPrizeCount}</span>
                                                    <span className="text-sm text-gray-500">Implied Chance: {noPrizeChance}%</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="w-10"></div>
                                    </div>
                                )
                            })()}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="design">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <Card>
                            <CardHeader>
                                <CardTitle>Theme & Content</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="space-y-2">
                                    <Label>Wheel Template</Label>
                                    <Select 
                                        value={formData.theme_config.template_id || 'default'} 
                                        onValueChange={(val) => setFormData({
                                            ...formData, 
                                            theme_config: { ...formData.theme_config, template_id: val }
                                        })}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {THEMES.map(theme => (
                                                <SelectItem key={theme.id} value={theme.id}>
                                                    {theme.name}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div className="space-y-2">
                                    <Label>Primary Color</Label>
                                    <div className="flex gap-2">
                                        <Input 
                                            type="color" 
                                            value={formData.theme_config.primary_color} 
                                            onChange={(e) => setFormData({
                                                ...formData, 
                                                theme_config: { ...formData.theme_config, primary_color: e.target.value }
                                            })}
                                            className="w-12 h-10 p-1"
                                        />
                                        <Input 
                                            value={formData.theme_config.primary_color} 
                                            onChange={(e) => setFormData({
                                                ...formData, 
                                                theme_config: { ...formData.theme_config, primary_color: e.target.value }
                                            })}
                                        />
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <Label>Title Text</Label>
                                    <Input 
                                        value={formData.theme_config.title_text} 
                                        onChange={(e) => setFormData({
                                            ...formData, 
                                            theme_config: { ...formData.theme_config, title_text: e.target.value }
                                        })}
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label>Success Message</Label>
                                    <Input 
                                        value={formData.theme_config.success_message} 
                                        onChange={(e) => setFormData({
                                            ...formData, 
                                            theme_config: { ...formData.theme_config, success_message: e.target.value }
                                        })}
                                    />
                                </div>

                                <div className="space-y-2">
                                    <Label>No Prize Message</Label>
                                    <Input 
                                        value={formData.theme_config.no_prize_message} 
                                        onChange={(e) => setFormData({
                                            ...formData, 
                                            theme_config: { ...formData.theme_config, no_prize_message: e.target.value }
                                        })}
                                    />
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>Live Preview</CardTitle>
                                <CardDescription>This is how the wheel will look to consumers.</CardDescription>
                            </CardHeader>
                            <CardContent className="flex flex-col items-center justify-center bg-slate-50 min-h-[400px]">
                                <h3 className="text-xl font-bold mb-4" style={{ color: formData.theme_config.primary_color }}>
                                    {formData.theme_config.title_text}
                                </h3>
                                <SpinWheelPreview 
                                    rewards={rewards} 
                                    themeConfig={formData.theme_config} 
                                    maxTotalPlays={formData.max_total_plays}
                                />
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                <TabsContent value="winners">
                    <Card>
                        <CardHeader>
                            <CardTitle>Campaign Winners</CardTitle>
                            <CardDescription>List of users who have won rewards.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="rounded-md border">
                                <table className="w-full text-sm text-left">
                                    <thead className="bg-slate-50 text-slate-500 font-medium">
                                        <tr>
                                            <th className="p-3">Date</th>
                                            <th className="p-3">Winner</th>
                                            <th className="p-3">Contact</th>
                                            <th className="p-3">Reward</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {winners.length === 0 ? (
                                            <tr>
                                                <td colSpan={4} className="p-8 text-center text-muted-foreground">
                                                    No winners yet.
                                                </td>
                                            </tr>
                                        ) : (
                                            winners.map((w) => (
                                                <tr key={w.id} className="border-t">
                                                    <td className="p-3">{new Date(w.played_at).toLocaleDateString()}</td>
                                                    <td className="p-3 font-medium">{w.consumer_name || 'Anonymous'}</td>
                                                    <td className="p-3">{w.consumer_phone}</td>
                                                    <td className="p-3">{w.spin_wheel_rewards?.name}</td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    )
}
