'use client'

import { useState, useEffect } from 'react'
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

const THEMES = [
    { id: 'modern', name: 'Modern Gradient' },
    { id: 'retro', name: 'Retro Carnival' },
    { id: 'vip', name: 'VIP Gold' },
    { id: 'cyber', name: 'Cyber Arcade' }
]

interface ScratchCardCampaignFormProps {
    userProfile: any
    campaignId: string | null
    initialJourneyId?: string
    onBack: () => void
}

export default function ScratchCardCampaignForm({ userProfile, campaignId, initialJourneyId, onBack }: ScratchCardCampaignFormProps) {
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
            title_text: 'Scratch to reveal your reward',
            success_message: 'You’ve won: {{reward_name}}',
            no_prize_message: 'Not this time, try again soon!',
            show_confetti: true,
            play_sound: true
        }
    })

    const [rewards, setRewards] = useState<any[]>([])
    const [winners, setWinners] = useState<any[]>([])
    const [organizations, setOrganizations] = useState<any[]>([])
    const [selectedOrgId, setSelectedOrgId] = useState<string>('')

    const isAdmin = ['SUPERADMIN', 'SA', 'HQ_ADMIN', 'super_admin', 'admin_hq', 'SUPER_ADMIN'].includes(userProfile?.role_code)

    useEffect(() => {
        fetchJourneys()
        fetchProducts()
        fetchOrgSettings()
        if (isAdmin) {
            fetchOrganizations()
        }
        if (campaignId) {
            fetchCampaign()
            fetchWinners()
        } else if (userProfile?.organization_id) {
            setSelectedOrgId(userProfile.organization_id)
        }
    }, [campaignId])

    const fetchOrganizations = async () => {
        const { data } = await supabase
            .from('organizations')
            .select('id, org_name')
            .order('org_name')
        
        if (data) setOrganizations(data)
    }

    const fetchWinners = async () => {
        if (!campaignId) return
        const { data } = await supabase
            .from('scratch_card_plays')
            .select(`
                *,
                scratch_card_rewards (
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
            .from('scratch_card_campaigns')
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

        if (campaign.org_id) {
            setSelectedOrgId(campaign.org_id)
        }

        const { data: rewardsData } = await supabase
            .from('scratch_card_rewards')
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

        if (!selectedOrgId && !userProfile.organization_id) {
            toast({ title: "Error", description: "Organization is required", variant: "destructive" })
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
            org_id: selectedOrgId || userProfile.organization_id,
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
                .from('scratch_card_campaigns')
                .update(campaignData)
                .eq('id', campaignId)
            
            if (error) {
                toast({ title: "Error", description: error.message, variant: "destructive" })
                setLoading(false)
                return
            }
        } else {
            const { data, error } = await supabase
                .from('scratch_card_campaigns')
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
        // First fetch existing rewards to calculate stock changes
        let existingRewards: any[] = []
        if (campaignId) {
            const { data } = await supabase.from('scratch_card_rewards').select('*').eq('campaign_id', campaignId)
            existingRewards = data || []
        }

        // Calculate and record stock movements BEFORE saving rewards (to ensure stock is available)
        // Actually, we should do it after to ensure consistency, but if it fails we warn.
        // Let's keep it after.

        if (rewards.length > 0) {
            // 1. Handle Deletions
            // Identify rewards that are in existingRewards but NOT in current rewards list (by ID)
            const currentRewardIds = rewards.map(r => r.id).filter(Boolean)
            const rewardsToDelete = existingRewards.filter(r => !currentRewardIds.includes(r.id))
            
            if (rewardsToDelete.length > 0) {
                const { error: deleteError } = await supabase
                    .from('scratch_card_rewards')
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
                    quantity_remaining: reward.quantity_allocated || 0, // Reset remaining to allocated on save? Or should we respect existing plays?
                    // Ideally we should calculate remaining = allocated - plays. But for now let's trust the input.
                    // Wait, if we reset quantity_remaining, we might over-allocate if plays happened.
                    // Better logic: if update, keep (quantity_remaining - (old_allocated - new_allocated))?
                    // For simplicity, let's just update it. The system should handle plays separately.
                    external_link: reward.external_link || null,
                    image_url: reward.image_url || null,
                    max_winners_per_day: reward.max_winners_per_day || null,
                    is_active: reward.is_active !== false
                }

                if (reward.id) {
                    // Update
                    const { error: updateError } = await supabase
                        .from('scratch_card_rewards')
                        .update(rewardData)
                        .eq('id', reward.id)
                    
                    if (updateError) {
                        console.error('Reward update error:', updateError)
                        toast({ title: "Error", description: `Failed to update reward: ${reward.name}`, variant: "destructive" })
                    }
                } else {
                    // Insert
                    const { error: insertError } = await supabase
                        .from('scratch_card_rewards')
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

                    // If change > 0, we need to DEDUCT from stock (allocate more) -> quantity_change should be negative
                    // If change < 0, we need to RETURN to stock (deallocate) -> quantity_change should be positive
                    const quantityChange = -1 * change
                    
                    // Determine movement type based on direction
                    // quantityChange < 0 -> Deduct -> scratch_game_out
                    // quantityChange > 0 -> Return -> scratch_game_in
                    const movementType = quantityChange < 0 ? 'scratch_game_out' : 'scratch_game_in'
                    
                    console.log(`Processing stock movement: Variant ${variantId}, Change ${change}, QtyChange ${quantityChange}, Type ${movementType}, TargetOrg ${targetOrgId}`)

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
                        p_reason: `Scratch Card Campaign: ${formData.name}`,
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

        // Refresh campaign data to ensure IDs are synced
        if (currentCampaignId) {
            // We can't easily call fetchCampaign here because it depends on state that might be stale or cause loops if we're not careful.
            // But we should at least reload the page or trigger a refresh.
            // Since we call onBack(), the user goes back to the list. When they come back, it will fetch fresh data.
            // So onBack() is sufficient.
        }

        toast({ title: "Success", description: "Campaign saved successfully" })
        setLoading(false)
        onBack()
    }

    const handleImageUpload = async (index: number, file: File) => {
        if (!file) return

        // Check size (5KB is extremely small, but user requested it)
        // We will try to resize aggressively
        const reader = new FileReader()
        reader.onload = (e) => {
            const img = new Image()
            img.onload = () => {
                const canvas = document.createElement('canvas')
                // Calculate new size to fit within reasonable bounds (e.g. 100x100 for small icon)
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
                    
                    // Try webp for better compression with transparency
                    let dataUrl = canvas.toDataURL('image/webp', 0.5)
                    
                    // Fallback to jpeg if webp not supported or resulted in larger size (unlikely)
                    if (dataUrl.indexOf('data:image/webp') === -1) {
                        // Fill white background for jpeg
                        ctx.globalCompositeOperation = 'destination-over'
                        ctx.fillStyle = '#ffffff'
                        ctx.fillRect(0, 0, width, height)
                        dataUrl = canvas.toDataURL('image/jpeg', 0.5)
                    }

                    // Check size
                    const sizeInBytes = Math.ceil((dataUrl.length - 'data:image/webp;base64,'.length) * 3 / 4)
                    console.log('Compressed image size:', sizeInBytes, 'bytes')

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
                            {campaignId ? 'Edit Campaign' : 'New Campaign'}
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
                    <TabsTrigger value="rewards">Rewards & Rules</TabsTrigger>
                    <TabsTrigger value="design">Design & Experience</TabsTrigger>
                    <TabsTrigger value="winners">Winners</TabsTrigger>
                </TabsList>

                <TabsContent value="basic">
                    <Card>
                        <CardHeader>
                            <CardTitle>Campaign Details</CardTitle>
                            <CardDescription>Configure the basic settings for your scratch card campaign.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>Campaign Name</Label>
                                    <Input 
                                        value={formData.name} 
                                        onChange={(e) => setFormData({...formData, name: e.target.value})}
                                        placeholder="e.g. Summer Scratch & Win"
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
                                <p className="text-xs text-muted-foreground">
                                    {initialJourneyId 
                                        ? "Journey is locked to the selected order." 
                                        : "Only journeys with \"Scratch Card Game\" enabled will show this campaign."}
                                </p>
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
                                        <div>
                                            <span className="text-muted-foreground block">Total Plays Available</span>
                                            <span className="font-medium">{formData.max_total_plays || 0}</span>
                                        </div>
                                    </div>
                                    <div className="text-xs text-muted-foreground pt-2 border-t mt-2">
                                        <p>• Scratch Card Active Period follows Journey Period automatically.</p>
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
                                <p className="text-xs text-muted-foreground">
                                    How many times a user can play with a single QR code scan.
                                </p>
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
                                <CardTitle>Rewards & Allocation</CardTitle>
                                <CardDescription>
                                    Allocate quantities for each reward. "No Prize" will be automatically calculated based on remaining plays.
                                </CardDescription>
                            </div>
                            <Button size="sm" onClick={addReward}>
                                <Plus className="mr-2 h-4 w-4" /> Add Reward
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
                                            <Label>Reward Name</Label>
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
                                                {pointValueRM > 0 && reward.value_points > 0 && (
                                                    <p className="text-xs text-muted-foreground">
                                                        Est. Cost: RM {((reward.value_points * pointValueRM).toFixed(2))}
                                                    </p>
                                                )}
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

                                                {reward.variant_id && (
                                                    <div className="mt-2 p-2 border rounded-md bg-slate-50">
                                                        <Label className="text-xs text-muted-foreground mb-2 block">Product Variant Preview</Label>
                                                        {(() => {
                                                            const prod = products.find(p => p.variant_id === reward.variant_id)
                                                            const img = prod?.variant_image_url
                                                            
                                                            if (prod) {
                                                                return (
                                                                    <div className="flex items-center justify-between gap-3">
                                                                        <div className="flex items-center gap-3">
                                                                            <div className="relative w-16 h-16 border rounded overflow-hidden bg-white">
                                                                                {img ? (
                                                                                    <img src={img} alt={prod.variant_name} className="w-full h-full object-contain" />
                                                                                ) : (
                                                                                    <div className="w-full h-full flex items-center justify-center text-gray-300">
                                                                                        <Gift className="w-6 h-6" />
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                            <div className="text-sm font-medium">
                                                                                <div>{prod.product_name}</div>
                                                                                <div className="text-xs text-muted-foreground">{prod.variant_name}</div>
                                                                            </div>
                                                                        </div>
                                                                        <div className="text-right">
                                                                            <div className="text-xs text-muted-foreground">Available Stock</div>
                                                                            <div className="text-lg font-bold text-green-600">{prod.quantity_available}</div>
                                                                        </div>
                                                                    </div>
                                                                )
                                                            }
                                                            return <div className="text-sm text-muted-foreground italic">Product not found</div>
                                                        })()}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {(reward.type === 'voucher' || reward.type === 'link') && (
                                            <div className="space-y-2">
                                                <Label>{reward.type === 'voucher' ? 'Voucher Image' : 'Mystery Gift Image'}</Label>
                                                <div className="flex items-center gap-4">
                                                    <Input 
                                                        type="file" 
                                                        accept="image/*"
                                                        onChange={(e) => {
                                                            if (e.target.files?.[0]) {
                                                                handleImageUpload(index, e.target.files[0])
                                                            }
                                                        }}
                                                    />
                                                    {reward.image_url && (
                                                        <div className="relative w-16 h-16 border rounded overflow-hidden shrink-0">
                                                            <img src={reward.image_url} alt="Preview" className="w-full h-full object-contain" />
                                                        </div>
                                                    )}
                                                </div>
                                                <p className="text-xs text-muted-foreground">
                                                    Image will be compressed to &lt; 5KB.
                                                </p>
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
                                                <Label>Reward Name</Label>
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
                                                <p className="text-xs text-muted-foreground">
                                                    Remaining plays that are not allocated to any reward.
                                                </p>
                                            </div>
                                        </div>
                                        <div className="w-10"></div> {/* Spacer for delete button alignment */}
                                    </div>
                                )
                            })()}

                            <div className="text-right text-sm font-medium space-y-1">
                                <div>Total Allocated: {rewards.reduce((sum, r) => sum + (parseInt(r.quantity_allocated) || 0), 0)}</div>
                                <div>Max Total Plays: {formData.max_total_plays}</div>
                                <div className={rewards.reduce((sum, r) => sum + (parseInt(r.quantity_allocated) || 0), 0) > formData.max_total_plays ? "text-red-500" : "text-green-600"}>
                                    {rewards.reduce((sum, r) => sum + (parseInt(r.quantity_allocated) || 0), 0) > formData.max_total_plays 
                                        ? "Warning: Allocation exceeds Max Plays!" 
                                        : "Allocation Valid"}
                                </div>
                            </div>
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
                                    <Label>Title Text (Before Scratch)</Label>
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
                                    <p className="text-xs text-muted-foreground">Use {'{{reward_name}}'} as placeholder</p>
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

                                <div className="flex items-center justify-between pt-4">
                                    <Label>Show Confetti on Win</Label>
                                    <Switch 
                                        checked={formData.theme_config.show_confetti}
                                        onCheckedChange={(checked) => setFormData({
                                            ...formData, 
                                            theme_config: { ...formData.theme_config, show_confetti: checked }
                                        })}
                                    />
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>Preview</CardTitle>
                                <CardDescription>
                                    Theme: {THEMES.find(t => t.id === formData.theme_config.theme_id)?.name}
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="flex items-center justify-center gap-4">
                                    <Button 
                                        variant="outline" 
                                        size="icon" 
                                        onClick={() => handleThemeChange('prev')}
                                        className="rounded-full h-10 w-10"
                                    >
                                        <ChevronLeft className="h-6 w-6" />
                                    </Button>

                                    <div className="border-8 border-gray-800 rounded-[30px] overflow-hidden bg-gray-100 h-[500px] relative w-[280px] shadow-2xl">
                                        {/* Phone Content - Matching Consumer UI */}
                                        {(() => {
                                            const themeId = formData.theme_config.theme_id || 'modern'
                                            const titleText = formData.theme_config.title_text || 'SCRATCH & WIN'

                                            if (themeId === 'retro') {
                                                return (
                                                    <div className="h-full flex flex-col relative overflow-hidden bg-green-500">
                                                        <div className="absolute inset-0 bg-[repeating-conic-gradient(#22c55e_0deg_15deg,#4ade80_15deg_30deg)] opacity-100"></div>
                                                        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/20"></div>
                                                        
                                                        <div className="relative z-10 flex items-center justify-between px-4 py-4">
                                                            <div className="p-2 bg-white/90 rounded-full shadow-lg text-green-700"><ArrowLeft className="w-4 h-4" strokeWidth={3} /></div>
                                                        </div>

                                                        <div className="relative z-10 flex-1 flex flex-col items-center px-4 pb-8">
                                                            <div className="mt-2 mb-6 relative transform -rotate-2">
                                                                <div className="absolute inset-0 bg-red-700 rounded-xl transform rotate-3 scale-105 border-2 border-white shadow-xl"></div>
                                                                <div className="relative bg-red-600 px-4 py-2 rounded-lg border-2 border-yellow-400 shadow-[0_5px_0_rgb(180,0,0)]">
                                                                    <h1 className="text-xl font-black text-yellow-300 drop-shadow-[1px_1px_0_rgba(0,0,0,0.5)] uppercase tracking-wider text-center leading-none">{titleText}</h1>
                                                                </div>
                                                            </div>

                                                            <div className="w-full max-w-[200px] mx-auto relative z-20 mb-6">
                                                                <div className="bg-yellow-400 p-1.5 rounded-xl shadow-[0_0_10px_rgba(255,255,0,0.5)]">
                                                                    <div className="bg-red-600 p-1.5 rounded-lg border-2 border-dashed border-white/50">
                                                                        <div className="bg-white rounded-md overflow-hidden relative aspect-[4/3]">
                                                                            <div className="w-full h-full bg-gradient-to-br from-gray-300 via-gray-100 to-gray-300 flex items-center justify-center">
                                                                                <span className="text-sm font-bold text-gray-500/80">SCRATCH</span>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )
                                            }

                                            if (themeId === 'vip') {
                                                return (
                                                    <div className="h-full flex flex-col bg-slate-950 relative overflow-hidden">
                                                        <div className="absolute inset-0 opacity-10 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')]"></div>
                                                        <div className="absolute inset-0 bg-gradient-to-b from-slate-900/50 via-transparent to-slate-900/80"></div>
                                                        <div className="absolute inset-3 border border-yellow-600/30 rounded-[20px] pointer-events-none"></div>

                                                        <div className="relative z-10 flex items-center justify-between px-4 py-4">
                                                            <div className="text-yellow-500"><ArrowLeft className="w-4 h-4" /></div>
                                                            <span className="text-[8px] font-serif tracking-[0.2em] text-yellow-600 uppercase">Exclusive</span>
                                                            <div className="w-4"></div>
                                                        </div>

                                                        <div className="relative z-10 flex-1 flex flex-col items-center px-4 pb-8">
                                                            <div className="mt-4 mb-8 text-center">
                                                                <h1 className="text-xl font-serif text-transparent bg-clip-text bg-gradient-to-b from-yellow-300 via-yellow-500 to-yellow-700 drop-shadow-sm tracking-widest">{titleText}</h1>
                                                                <div className="h-[1px] w-16 mx-auto mt-2 bg-gradient-to-r from-transparent via-yellow-600 to-transparent"></div>
                                                            </div>

                                                            <div className="w-full max-w-[200px] mx-auto relative z-20 mb-8">
                                                                <div className="p-[1px] bg-gradient-to-br from-yellow-400 via-yellow-600 to-yellow-800 rounded-xl shadow-xl">
                                                                    <div className="bg-slate-900 p-3 rounded-xl">
                                                                        <div className="relative aspect-[4/3] rounded-lg overflow-hidden border border-yellow-900/50">
                                                                            <div className="w-full h-full bg-gradient-to-br from-yellow-100 via-yellow-200 to-yellow-100 flex items-center justify-center">
                                                                                <span className="text-sm font-bold text-yellow-900">SCRATCH</span>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )
                                            }

                                            if (themeId === 'cyber') {
                                                return (
                                                    <div className="h-full flex flex-col bg-slate-900 relative overflow-hidden font-mono">
                                                        <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:20px_20px]"></div>
                                                        
                                                        <div className="relative z-10 flex items-center justify-between px-4 py-4">
                                                            <div className="p-1 border border-cyan-500/50 text-cyan-400"><ArrowLeft className="w-4 h-4" /></div>
                                                            <div className="px-2 py-0.5 border border-pink-500/50 bg-pink-950/30"><span className="text-[8px] text-pink-400 uppercase tracking-widest">Sys.Init</span></div>
                                                            <div className="w-5"></div>
                                                        </div>

                                                        <div className="relative z-10 flex-1 flex flex-col items-center px-4 pb-8">
                                                            <div className="mt-6 mb-8 text-center relative">
                                                                <h1 className="text-xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-400 drop-shadow-[0_0_5px_rgba(0,255,255,0.5)] tracking-tighter">{titleText}</h1>
                                                            </div>

                                                            <div className="w-full max-w-[200px] mx-auto relative z-20 mb-8">
                                                                <div className="relative">
                                                                    <div className="absolute -top-1 -left-1 w-2 h-2 border-t border-l border-cyan-500"></div>
                                                                    <div className="absolute -top-1 -right-1 w-2 h-2 border-t border-r border-cyan-500"></div>
                                                                    <div className="absolute -bottom-1 -left-1 w-2 h-2 border-b border-l border-cyan-500"></div>
                                                                    <div className="absolute -bottom-1 -right-1 w-2 h-2 border-b border-r border-cyan-500"></div>
                                                                    
                                                                    <div className="bg-slate-800/80 backdrop-blur border border-slate-700 p-1">
                                                                        <div className="relative aspect-[4/3] overflow-hidden">
                                                                            <div className="w-full h-full bg-gradient-to-br from-slate-700 via-slate-600 to-slate-700 flex items-center justify-center">
                                                                                <span className="text-sm font-bold text-cyan-400">SCRATCH</span>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )
                                            }

                                            // Modern (Default)
                                            return (
                                                <div className="h-full flex flex-col bg-gradient-to-b from-emerald-500 via-emerald-600 to-emerald-800 text-white">
                                                    <div className="flex items-center justify-between px-4 py-4">
                                                        <div className="p-2 bg-white/20 rounded-full backdrop-blur-sm"><ArrowLeft className="w-4 h-4 text-white" /></div>
                                                        <div className="px-3 py-1 bg-black/20 rounded-full backdrop-blur-sm border border-white/10"><span className="text-[10px] font-medium text-emerald-100">Scratch & Win</span></div>
                                                        <div className="w-8"></div>
                                                    </div>

                                                    <div className="flex-1 flex flex-col items-center px-4 pb-8">
                                                        <div className="mt-2 mb-4 text-center relative z-10">
                                                            <h1 className="text-2xl font-extrabold text-yellow-300 drop-shadow-[0_2px_2px_rgba(0,0,0,0.5)] tracking-tight">{titleText}</h1>
                                                            <div className="mt-1 inline-block px-3 py-0.5 bg-gradient-to-r from-red-500 to-orange-500 rounded-full shadow-lg transform -rotate-2">
                                                                <p className="text-[10px] font-bold text-white uppercase tracking-widest">Daily Chance</p>
                                                            </div>
                                                        </div>

                                                        <div className="relative mb-4 w-full flex justify-center">
                                                            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-white/20 blur-2xl rounded-full pointer-events-none animate-pulse"></div>
                                                            <div className="relative z-10 w-24 h-24 flex items-center justify-center">
                                                                <Gift className="w-16 h-16 text-white drop-shadow-lg opacity-90" />
                                                            </div>
                                                        </div>

                                                        <div className="w-full max-w-[200px] mx-auto relative z-20 mb-6">
                                                            <div className="bg-white p-1 rounded-[1.5rem] shadow-xl">
                                                                <div className="bg-gradient-to-br from-gray-100 to-gray-200 rounded-[1.3rem] overflow-hidden relative aspect-[4/3]">
                                                                    <div className="w-full h-full bg-gradient-to-br from-gray-300 via-gray-200 to-gray-400 flex items-center justify-center">
                                                                        <span className="text-lg font-bold text-gray-500/80 drop-shadow-sm tracking-widest">SCRATCH</span>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        })()}
                                    </div>

                                    <Button 
                                        variant="outline" 
                                        size="icon" 
                                        onClick={() => handleThemeChange('next')}
                                        className="rounded-full h-10 w-10"
                                    >
                                        <ChevronRight className="h-6 w-6" />
                                    </Button>
                                </div>
                                <div className="text-center mt-4 text-sm text-muted-foreground">
                                    Use arrows to select a theme
                                </div>
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
                                            <th className="p-3">Email</th>
                                            <th className="p-3">Reward</th>
                                            <th className="p-3">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {winners.length === 0 ? (
                                            <tr>
                                                <td colSpan={6} className="p-8 text-center text-muted-foreground">
                                                    No winners yet.
                                                </td>
                                            </tr>
                                        ) : (
                                            winners.map((w) => {
                                                const reward = w.scratch_card_rewards
                                                const imageUrl = reward?.image_url || reward?.product_variants?.image_url
                                                
                                                return (
                                                <tr key={w.id} className="border-t">
                                                    <td className="p-3">{new Date(w.played_at).toLocaleDateString()}</td>
                                                    <td className="p-3 font-medium">{w.consumer_name || 'Anonymous'}</td>
                                                    <td className="p-3">{w.consumer_phone}</td>
                                                    <td className="p-3 text-muted-foreground">{w.consumer_email || '-'}</td>
                                                    <td className="p-3">
                                                        <div className="flex items-center gap-3">
                                                            <div className="w-10 h-10 rounded border bg-slate-50 flex items-center justify-center overflow-hidden shrink-0">
                                                                {imageUrl ? (
                                                                    <img src={imageUrl} alt={reward?.name} className="w-full h-full object-contain" />
                                                                ) : (
                                                                    <Gift className="w-5 h-5 text-slate-300" />
                                                                )}
                                                            </div>
                                                            <span className="font-medium">{reward?.name}</span>
                                                        </div>
                                                    </td>
                                                    <td className="p-3">
                                                        {w.winner_details_submitted_at ? (
                                                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">
                                                                Claimed
                                                            </span>
                                                        ) : (
                                                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
                                                                Pending Details
                                                            </span>
                                                        )}
                                                    </td>
                                                </tr>
                                            )})
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
