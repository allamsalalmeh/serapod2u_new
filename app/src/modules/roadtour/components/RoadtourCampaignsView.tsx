'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
    AlertCircle, Calendar, CheckCircle2, Edit, Info, Loader2, Map as MapIcon, MapPin, Plus,
    Search, ShieldAlert, Store, Trash2, Users, Eye, Play, Pause, Archive, X, ClipboardList,
    Coins, Gift, Globe, ShieldCheck, Sparkles, FileText
} from 'lucide-react'
import { SeraLoadingState } from '@/components/ui/SeraLoader'
import { toast } from '@/components/ui/use-toast'
import {
    DUPLICATE_POLICY_LABEL,
    POINT_RELEASE_RULE_LABEL,
    PRODUCT_QR_COUNTING_PERIOD_LABEL,
    buildRoadtourRunMap,
    fetchRoadtourRuns,
    type RoadtourRun,
} from '@/lib/roadtour/events'
import { capitalizeFirstOnly, toTitleCase } from '@/lib/roadtour/campaign-text'
import { CreateRoadtourEventDialog } from './CreateRoadtourEventDialog'
import { RoadtourStateFlag } from './RoadtourStateFlag'

interface RoadtourCampaignsViewProps {
    userProfile: any
    onViewChange: (viewId: string) => void
}

interface Campaign {
    id: string
    name: string
    description: string | null
    start_date: string
    end_date: string
    status: string
    region_scope: string[] | null
    default_points: number
    reward_mode: string
    survey_template_id: string | null
    qr_mode: string
    notes: string | null
    created_at: string
    roadtour_run_id: string | null
    _manager_count?: number
    _visit_count?: number
    _scan_count?: number
    _managers?: { full_name: string; phone: string }[]
}

interface AccountManager {
    id: string
    user_id: string
    full_name: string
    email: string
    phone: string
    is_active: boolean
}

interface ReferenceOption {
    id: string
    full_name: string
    call_name?: string | null
    email: string
    phone: string
}

interface SurveyTemplateOption {
    id: string
    name: string
    description: string | null
}

const MALAYSIAN_STATES = [
    'Johor', 'Kedah', 'Kelantan', 'Melaka', 'Negeri Sembilan', 'Pahang',
    'Penang', 'Perak', 'Perlis', 'Sabah', 'Sarawak', 'Selangor',
    'Terengganu', 'Kuala Lumpur', 'Labuan', 'Putrajaya'
]

const statusColors: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700',
    active: 'bg-emerald-100 text-emerald-700',
    paused: 'bg-amber-100 text-amber-700',
    completed: 'bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)]',
    archived: 'bg-slate-100 text-slate-600',
}

export function RoadtourCampaignsView({ userProfile, onViewChange }: RoadtourCampaignsViewProps) {
    const supabase = createClient()
    const companyId = userProfile.organizations.id

    const [loading, setLoading] = useState(true)
    const [campaigns, setCampaigns] = useState<Campaign[]>([])
    const [searchTerm, setSearchTerm] = useState('')
    const [statusFilter, setStatusFilter] = useState('all')

    // RoadTour Event state
    const [runs, setRuns] = useState<RoadtourRun[]>([])
    const [runsLoading, setRunsLoading] = useState(true)
    const [selectedRunId, setSelectedRunId] = useState<string>('')
    const [createEventOpen, setCreateEventOpen] = useState(false)
    const [editingRun, setEditingRun] = useState<RoadtourRun | null>(null)
    const [deleteEventDialogOpen, setDeleteEventDialogOpen] = useState(false)
    const [deleteEventLoading, setDeleteEventLoading] = useState(false)
    const [formRunId, setFormRunId] = useState<string>('')

    // Dialog state
    const [dialogOpen, setDialogOpen] = useState(false)
    const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create')
    const [saving, setSaving] = useState(false)
    const [editId, setEditId] = useState<string | null>(null)

    // Form
    const [formName, setFormName] = useState('')
    const [formDesc, setFormDesc] = useState('')
    const [formStart, setFormStart] = useState('')
    const [formEnd, setFormEnd] = useState('')
    const [formPoints, setFormPoints] = useState(20)
    const [formRewardMode, setFormRewardMode] = useState('survey_submit')
    const [formSurveyTemplateId, setFormSurveyTemplateId] = useState('')
    const [formQrMode, setFormQrMode] = useState('persistent')
    const [formRegions, setFormRegions] = useState<string[]>([])
    const [formNotes, setFormNotes] = useState('')
    const [formReferenceIds, setFormReferenceIds] = useState<string[]>([])
    const [formReferenceSearch, setFormReferenceSearch] = useState('')

    // Point value from org settings
    const [pointValueRm, setPointValueRm] = useState(0.10)

    // Shop counts by state
    const [shopCountByState, setShopCountByState] = useState<Record<string, number>>({})

    // Region detail dialog
    const [regionDialogOpen, setRegionDialogOpen] = useState(false)
    const [regionDialogState, setRegionDialogState] = useState('')
    const [regionShops, setRegionShops] = useState<{ id: string; org_name: string; branch_name: string | null }[]>([])
    const [regionShopsLoading, setRegionShopsLoading] = useState(false)

    // References detail dialog
    const [refsDialogOpen, setRefsDialogOpen] = useState(false)
    const [refsDialogCampaignName, setRefsDialogCampaignName] = useState('')
    const [refsDialogManagers, setRefsDialogManagers] = useState<{ full_name: string; phone: string }[]>([])

    // Managers dialog
    const [managersDialogOpen, setManagersDialogOpen] = useState(false)
    const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null)
    const [selectedCampaignName, setSelectedCampaignName] = useState('')
    const [managers, setManagers] = useState<AccountManager[]>([])
    const [availableManagers, setAvailableManagers] = useState<{ id: string; full_name: string; call_name: string; email: string; phone: string }[]>([])
    const [surveyTemplates, setSurveyTemplates] = useState<SurveyTemplateOption[]>([])
    const [managersLoading, setManagersLoading] = useState(false)
    const [managerSearch, setManagerSearch] = useState('')
    const [eligibleReferencesLoading, setEligibleReferencesLoading] = useState(false)

    // Calculate working days (exclude weekends)
    const calcWorkingDays = (start: string, end: string): number => {
        if (!start || !end) return 0
        const s = new Date(start)
        const e = new Date(end)
        let count = 0
        const cur = new Date(s)
        while (cur <= e) {
            const day = cur.getDay()
            if (day !== 0 && day !== 6) count++
            cur.setDate(cur.getDate() + 1)
        }
        return count
    }

    // Load point_value_rm from org settings
    useEffect(() => {
        (async () => {
            const { data } = await supabase.from('organizations').select('settings').eq('id', companyId).single()
            if (data?.settings && typeof data.settings === 'object') {
                const pv = (data.settings as any).point_value_rm
                if (pv && !isNaN(Number(pv))) setPointValueRm(Number(pv))
            }
        })()
    }, [companyId, supabase])

    // Load shop counts by state
    useEffect(() => {
        (async () => {
            const { data } = await (supabase as any).from('organizations').select('state_id, states:state_id(state_name)').eq('org_type_code', 'SHOP').eq('is_active', true)
            if (data) {
                const counts: Record<string, number> = {}
                for (const r of data) {
                    const st = (r as any).states?.state_name?.trim()
                    if (st) counts[st] = (counts[st] || 0) + 1
                }
                setShopCountByState(counts)
            }
        })()
    }, [supabase])

    const openRegionShops = async (stateName: string) => {
        setRegionDialogState(stateName)
        setRegionDialogOpen(true)
        setRegionShopsLoading(true)
        try {
            // First get the state_id for this state name
            const { data: stateRow } = await (supabase as any).from('states').select('id').eq('state_name', stateName).single()
            if (!stateRow) { setRegionShops([]); return }
            const { data } = await (supabase as any).from('organizations').select('id, org_name, branch').eq('org_type_code', 'SHOP').eq('is_active', true).eq('state_id', stateRow.id).order('org_name')
            setRegionShops((data || []).map((r: any) => ({ id: r.id, org_name: r.org_name, branch_name: r.branch ?? null })))
        } catch {
            setRegionShops([])
        } finally {
            setRegionShopsLoading(false)
        }
    }

    const syncCampaignQrs = useCallback(async (campaignId: string, managerIds?: string[]) => {
        const targetManagerIds = managerIds && managerIds.length > 0
            ? managerIds
            : (() => { return [] })()

        let resolvedManagerIds = targetManagerIds
        if (resolvedManagerIds.length === 0) {
            const { data: assignedManagers, error: managerError } = await (supabase as any)
                .from('roadtour_campaign_managers')
                .select('user_id')
                .eq('campaign_id', campaignId)
                .eq('is_active', true)

            if (managerError) throw managerError
            resolvedManagerIds = (assignedManagers || []).map((row: any) => row.user_id)
        }

        if (resolvedManagerIds.length === 0) return 0

        let expiresAt: string | null = null
        const { data: settings } = await (supabase as any)
            .from('roadtour_settings')
            .select('qr_expiry_hours, qr_mode')
            .eq('org_id', companyId)
            .maybeSingle()

        if (settings?.qr_mode === 'time_limited' && settings?.qr_expiry_hours) {
            const expiry = new Date()
            expiry.setHours(expiry.getHours() + settings.qr_expiry_hours)
            expiresAt = expiry.toISOString()
        }

        const { data: existingRows, error: existingError } = await (supabase as any)
            .from('roadtour_qr_codes')
            .select('account_manager_user_id')
            .eq('campaign_id', campaignId)
            .eq('status', 'active')
            .is('shop_id', null)
            .in('account_manager_user_id', resolvedManagerIds)

        if (existingError) throw existingError

        const existingManagerIds = new Set((existingRows || []).map((row: any) => row.account_manager_user_id))
        const missingManagerIds = resolvedManagerIds.filter((managerId) => !existingManagerIds.has(managerId))

        if (missingManagerIds.length === 0) return 0

        const { error: insertError } = await (supabase as any)
            .from('roadtour_qr_codes')
            .insert(missingManagerIds.map((managerId) => ({
                campaign_id: campaignId,
                account_manager_user_id: managerId,
                token: crypto.randomUUID(),
                status: 'active',
                expires_at: expiresAt,
            })))

        if (insertError) throw insertError
        return missingManagerIds.length
    }, [companyId, supabase])

    const loadCampaigns = useCallback(async () => {
        try {
            setLoading(true)
            const { data, error } = await (supabase as any)
                .from('roadtour_campaigns')
                .select('*')
                .eq('org_id', companyId)
                .order('created_at', { ascending: false })

            if (error) throw error

            // Fetch managers for all campaigns
            const campaignIds = (data || []).map((c: any) => c.id)
            let managerMap: Record<string, { full_name: string; phone: string }[]> = {}
            if (campaignIds.length > 0) {
                const { data: mgrs } = await (supabase as any)
                    .from('roadtour_campaign_managers')
                    .select('campaign_id, users:user_id(full_name, phone)')
                    .in('campaign_id', campaignIds)
                    .eq('is_active', true)
                if (mgrs) {
                    for (const m of mgrs) {
                        if (!managerMap[m.campaign_id]) managerMap[m.campaign_id] = []
                        managerMap[m.campaign_id].push({
                            full_name: m.users?.full_name || '—',
                            phone: m.users?.phone || '',
                        })
                    }
                }
            }

            setCampaigns((data || []).map((c: any) => ({
                ...c,
                _managers: managerMap[c.id] || [],
            })))
        } catch (err: any) {
            toast({ title: 'Error', description: 'Failed to load campaigns.', variant: 'destructive' })
        } finally {
            setLoading(false)
        }
    }, [companyId, supabase])

    const loadEligibleReferences = useCallback(async () => {
        try {
            setEligibleReferencesLoading(true)
            const { data, error } = await supabase
                .from('users')
                .select('id, full_name, call_name, email, phone')
                .eq('can_be_reference', true)
                .eq('is_active', true)
                .order('full_name')

            if (error) throw error
            setAvailableManagers((data || []).map((row: any) => ({
                id: row.id,
                full_name: row.full_name || '',
                call_name: row.call_name || '',
                email: row.email || '',
                phone: row.phone || '',
            })))
        } catch {
            toast({ title: 'Error', description: 'Failed to load eligible references.', variant: 'destructive' })
        } finally {
            setEligibleReferencesLoading(false)
        }
    }, [supabase])

    const loadSurveyTemplates = useCallback(async () => {
        const { data, error } = await (supabase as any)
            .from('roadtour_survey_templates')
            .select('id, name, description')
            .eq('org_id', companyId)
            .eq('is_active', true)
            .order('name')

        if (error) throw error
        setSurveyTemplates((data || []).map((row: any) => ({
            id: row.id,
            name: row.name,
            description: row.description || null,
        })))
    }, [companyId, supabase])

    const loadCampaignReferenceIds = useCallback(async (campaignId: string) => {
        const { data, error } = await (supabase as any)
            .from('roadtour_campaign_managers')
            .select('user_id')
            .eq('campaign_id', campaignId)
            .eq('is_active', true)

        if (error) throw error
        return (data || []).map((row: any) => row.user_id)
    }, [supabase])

    const ensureCampaignHasReferences = useCallback(async (campaignId: string) => {
        const referenceIds = await loadCampaignReferenceIds(campaignId)
        if (referenceIds.length > 0) return referenceIds

        toast({
            title: 'Reference required',
            description: 'Please select at least one reference before activating this campaign.',
            variant: 'destructive',
        })
        return null
    }, [loadCampaignReferenceIds])

    const syncCampaignManagers = useCallback(async (campaignId: string, managerIds: string[]) => {
        const uniqueManagerIds = Array.from(new Set(managerIds))
        const { data: existingRows, error: existingError } = await (supabase as any)
            .from('roadtour_campaign_managers')
            .select('id, user_id, is_active')
            .eq('campaign_id', campaignId)

        if (existingError) throw existingError

        const existingByUserId = new Map<string, { id: string; user_id: string; is_active: boolean | null }>((existingRows || []).map((row: any) => [row.user_id, row]))
        const rowsToUpsert = uniqueManagerIds.map((userId) => ({
            campaign_id: campaignId,
            user_id: userId,
            assigned_by: userProfile.id,
            is_active: true,
            assigned_at: new Date().toISOString(),
        }))

        if (rowsToUpsert.length > 0) {
            const { error: upsertError } = await (supabase as any)
                .from('roadtour_campaign_managers')
                .upsert(rowsToUpsert, { onConflict: 'campaign_id,user_id' })
            if (upsertError) throw upsertError
        }

        const removedUserIds = (existingRows || [])
            .filter((row: any) => row.is_active && !uniqueManagerIds.includes(row.user_id))
            .map((row: any) => row.user_id)

        if (removedUserIds.length > 0) {
            const { error: deactivateError } = await (supabase as any)
                .from('roadtour_campaign_managers')
                .update({ is_active: false })
                .eq('campaign_id', campaignId)
                .in('user_id', removedUserIds)

            if (deactivateError) throw deactivateError
        }

        return {
            addedCount: uniqueManagerIds.filter((userId) => !existingByUserId.get(userId)?.is_active).length,
            removedUserIds,
        }
    }, [supabase, userProfile.id])

    useEffect(() => { loadCampaigns() }, [loadCampaigns])

    const loadRuns = useCallback(async () => {
        try {
            setRunsLoading(true)
            const rows = await fetchRoadtourRuns(supabase, companyId)
            setRuns(rows)
            // Auto-select: active first, then draft, then most recent
            const active = rows.filter((r) => r.status === 'active')
            const draft = rows.filter((r) => r.status === 'draft')
            const eligible = [...active, ...draft]
            if (eligible.length > 0) {
                setSelectedRunId((prev) => prev && eligible.find((r) => r.id === prev) ? prev : eligible[0]!.id)
            } else {
                setSelectedRunId('')
            }
        } catch (err) {
            // table missing in older envs — fail silently to keep page usable
            setRuns([])
            setSelectedRunId('')
        } finally {
            setRunsLoading(false)
        }
    }, [supabase, companyId])

    useEffect(() => { loadRuns() }, [loadRuns])

    const resetForm = () => {
        setFormName('')
        setFormDesc('')
        setFormStart('')
        setFormEnd('')
        setFormPoints(20)
        setFormRewardMode('survey_submit')
        setFormSurveyTemplateId('')
        setFormQrMode('persistent')
        setFormRegions([])
        setFormNotes('')
        setFormReferenceIds([])
        setFormReferenceSearch('')
        setFormRunId(selectedRunId || '')
        setEditId(null)
    }

    const openCreate = async () => {
        if (runs.length === 0) {
            toast({
                title: 'Create a RoadTour Event first',
                description: 'Campaigns must belong to an event so duplicate scan protection can work correctly.',
                variant: 'destructive',
            })
            setEditingRun(null)
            setCreateEventOpen(true)
            return
        }
        resetForm()
        await Promise.all([loadEligibleReferences(), loadSurveyTemplates()])
        setDialogMode('create')
        setDialogOpen(true)
    }

    const openEdit = async (c: Campaign) => {
        setFormName(c.name)
        setFormDesc(c.description || '')
        setFormStart(c.start_date)
        setFormEnd(c.end_date)
        setFormPoints(c.default_points)
        setFormRewardMode(c.reward_mode)
        setFormSurveyTemplateId(c.survey_template_id || '')
        setFormQrMode(c.qr_mode)
        setFormRegions(c.region_scope || [])
        setFormNotes(c.notes || '')
        setFormReferenceSearch('')
        setFormRunId(c.roadtour_run_id || selectedRunId || '')
        setEditId(c.id)
        await Promise.all([loadEligibleReferences(), loadSurveyTemplates()])
        try {
            setFormReferenceIds(await loadCampaignReferenceIds(c.id))
        } catch {
            setFormReferenceIds([])
        }
        setDialogMode('edit')
        setDialogOpen(true)
    }

    const getMissingCampaignSelections = () => {
        const missingFields: string[] = []

        if (formRewardMode === 'survey_submit' && !formSurveyTemplateId) {
            missingFields.push('survey template')
        }
        if (formRegions.length === 0) {
            missingFields.push('region')
        }
        if (formReferenceIds.length === 0) {
            missingFields.push('reference')
        }

        return missingFields
    }

    const formatMissingFieldsMessage = (missingFields: string[]) => {
        if (missingFields.length === 1) {
            return `Please select ${missingFields[0]}.`
        }

        if (missingFields.length === 2) {
            return `Please select ${missingFields[0]} and ${missingFields[1]}.`
        }

        return `Please select ${missingFields.slice(0, -1).join(', ')}, and ${missingFields[missingFields.length - 1]}.`
    }

    const handleSave = async () => {
        const sanitizedName = toTitleCase(formName.trim())
        const sanitizedDescription = capitalizeFirstOnly(formDesc.trim())

        if (!sanitizedName) { toast({ title: 'Validation', description: 'Campaign name is required.', variant: 'destructive' }); return }
        if (!formStart || !formEnd) { toast({ title: 'Validation', description: 'Start and end dates are required.', variant: 'destructive' }); return }
        if (!formRunId) {
            toast({
                title: 'RoadTour Event required',
                description: 'Select or create a RoadTour Event for this campaign.',
                variant: 'destructive',
            })
            return
        }
        const missingSelections = getMissingCampaignSelections()
        if (missingSelections.length > 0) {
            toast({
                title: 'Missing required details',
                description: formatMissingFieldsMessage(missingSelections),
                variant: 'destructive'
            })
            return
        }

        try {
            setSaving(true)
            const payload = {
                org_id: companyId,
                roadtour_run_id: formRunId,
                name: sanitizedName,
                description: sanitizedDescription || null,
                start_date: formStart,
                end_date: formEnd,
                default_points: formPoints,
                reward_mode: formRewardMode,
                survey_template_id: formRewardMode === 'survey_submit' ? formSurveyTemplateId : null,
                qr_mode: formQrMode,
                region_scope: formRegions.length > 0 ? formRegions : null,
                notes: formNotes.trim() || null,
                updated_by: userProfile.id,
            }

            if (editId) {
                const { error } = await (supabase as any).from('roadtour_campaigns').update(payload).eq('id', editId)
                if (error) throw error
                const { removedUserIds } = await syncCampaignManagers(editId, formReferenceIds)
                if (removedUserIds.length > 0) {
                    await (supabase as any)
                        .from('roadtour_qr_codes')
                        .update({ status: 'revoked' })
                        .eq('campaign_id', editId)
                        .in('account_manager_user_id', removedUserIds)
                        .eq('status', 'active')
                        .is('shop_id', null)
                }
                toast({ title: 'Campaign Updated', description: `"${sanitizedName}" has been updated.` })
            } else {
                const { data: createdCampaign, error } = await (supabase as any)
                    .from('roadtour_campaigns')
                    .insert({ ...payload, created_by: userProfile.id })
                    .select('id')
                    .single()
                if (error) throw error
                if (createdCampaign?.id && formReferenceIds.length > 0) {
                    await syncCampaignManagers(createdCampaign.id, formReferenceIds)
                }
                toast({ title: 'Campaign Created', description: `"${sanitizedName}" has been created.` })
            }

            setDialogOpen(false)
            loadCampaigns()
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        } finally {
            setSaving(false)
        }
    }

    const openCreateEvent = () => {
        setEditingRun(null)
        setCreateEventOpen(true)
    }

    const openEditSelectedEvent = () => {
        if (!selectedRun) return
        setEditingRun(selectedRun)
        setCreateEventOpen(true)
    }

    const updateStatus = async (campaignId: string, newStatus: string) => {
        try {
            if (newStatus === 'active') {
                const referenceIds = await ensureCampaignHasReferences(campaignId)
                if (!referenceIds) return
            }

            const { error } = await (supabase as any).from('roadtour_campaigns').update({ status: newStatus, updated_by: userProfile.id }).eq('id', campaignId)
            if (error) throw error
            let createdQrCount = 0
            if (newStatus === 'active') {
                createdQrCount = await syncCampaignQrs(campaignId)
            }

            toast({
                title: 'Status Updated',
                description: createdQrCount > 0
                    ? `Campaign activated and ${createdQrCount} QR code${createdQrCount === 1 ? '' : 's'} created automatically.`
                    : `Campaign status changed to "${newStatus}".`
            })
            loadCampaigns()
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        }
    }

    const deleteDraftCampaign = async (campaignId: string, campaignName: string) => {
        if (!window.confirm(`Delete draft campaign "${campaignName}"? This will remove it completely.`)) {
            return
        }

        try {
            const { data, error } = await (supabase as any)
                .from('roadtour_campaigns')
                .delete()
                .eq('id', campaignId)
                .eq('status', 'draft')
                .select('id')
                .maybeSingle()

            if (error) throw error
            if (!data) {
                throw new Error('Only draft campaigns can be deleted.')
            }

            toast({ title: 'Campaign Deleted', description: `"${campaignName}" has been deleted.` })
            loadCampaigns()
        } catch (err: any) {
            toast({ title: 'Error', description: err.message || 'Failed to delete campaign.', variant: 'destructive' })
        }
    }

    // Account Manager Assignment
    const openManagers = async (campaignId: string, campaignName: string) => {
        setSelectedCampaignId(campaignId)
        setSelectedCampaignName(campaignName)
        setManagersDialogOpen(true)
        setManagersLoading(true)

        try {
            // Load current assignments
            const { data: assigned, error: aErr } = await (supabase as any)
                .from('roadtour_campaign_managers')
                .select('id, user_id, is_active, users:user_id(full_name, email, phone)')
                .eq('campaign_id', campaignId)

            if (aErr) throw aErr

            setManagers((assigned || []).map((a: any) => ({
                id: a.id,
                user_id: a.user_id,
                full_name: a.users?.full_name || '',
                email: a.users?.email || '',
                phone: a.users?.phone || '',
                is_active: a.is_active,
            })))

            // Load eligible account managers (can_be_reference = true)
            await loadEligibleReferences()
        } catch (err: any) {
            toast({ title: 'Error', description: 'Failed to load account managers.', variant: 'destructive' })
        } finally {
            setManagersLoading(false)
        }
    }

    const selectedFormReferences = useMemo(() => {
        const selectedIds = new Set(formReferenceIds)
        return availableManagers.filter((reference) => selectedIds.has(reference.id))
    }, [availableManagers, formReferenceIds])

    const filteredFormReferences = useMemo(() => {
        const query = formReferenceSearch.trim().toLowerCase()
        return availableManagers.filter((reference) => {
            if (formReferenceIds.includes(reference.id)) return false
            if (!query) return true
            return [reference.full_name, reference.call_name, reference.email, reference.phone].some((value) => value?.toLowerCase().includes(query))
        })
    }, [availableManagers, formReferenceIds, formReferenceSearch])

    const toggleFormReference = (userId: string) => {
        setFormReferenceIds((current) => current.includes(userId)
            ? current.filter((id) => id !== userId)
            : [...current, userId])
    }

    const assignManager = async (userId: string) => {
        if (!selectedCampaignId) return
        try {
            const { error } = await (supabase as any).from('roadtour_campaign_managers').upsert({
                campaign_id: selectedCampaignId,
                user_id: userId,
                assigned_by: userProfile.id,
                is_active: true,
                assigned_at: new Date().toISOString(),
            }, { onConflict: 'campaign_id,user_id' })
            if (error) throw error
            const selectedCampaign = campaigns.find((campaign) => campaign.id === selectedCampaignId)
            let createdQrCount = 0
            if (selectedCampaign?.status === 'active') {
                createdQrCount = await syncCampaignQrs(selectedCampaignId, [userId])
            }

            toast({
                title: 'Assigned',
                description: createdQrCount > 0
                    ? 'Reference assigned and QR code created automatically.'
                    : 'Reference assigned to campaign.'
            })
            openManagers(selectedCampaignId, selectedCampaignName)
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        }
    }

    const removeManager = async (assignmentId: string) => {
        try {
            const removedManager = managers.find((manager) => manager.id === assignmentId)
            const { error } = await (supabase as any).from('roadtour_campaign_managers').update({ is_active: false }).eq('id', assignmentId)
            if (error) throw error

            if (selectedCampaignId && removedManager?.user_id) {
                await (supabase as any)
                    .from('roadtour_qr_codes')
                    .update({ status: 'revoked' })
                    .eq('campaign_id', selectedCampaignId)
                    .eq('account_manager_user_id', removedManager.user_id)
                    .eq('status', 'active')
                    .is('shop_id', null)
            }

            toast({ title: 'Removed', description: 'Reference removed from campaign.' })
            if (selectedCampaignId) openManagers(selectedCampaignId, selectedCampaignName)
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        }
    }

    const filtered = campaigns.filter((c) => {
        if (selectedRunId && c.roadtour_run_id !== selectedRunId) return false
        if (statusFilter !== 'all' && c.status !== statusFilter) return false
        if (searchTerm && !c.name.toLowerCase().includes(searchTerm.toLowerCase())) return false
        return true
    })

    const canManageRuns = (userProfile.roles?.role_level ?? 999) <= 20
    const runCampaignCountById = useMemo(() => {
        const counts = new Map<string, number>()

        for (const campaign of campaigns) {
            if (!campaign.roadtour_run_id) continue
            counts.set(campaign.roadtour_run_id, (counts.get(campaign.roadtour_run_id) || 0) + 1)
        }

        return counts
    }, [campaigns])

    const selectedRun = useMemo(() => runs.find((r) => r.id === selectedRunId) || null, [runs, selectedRunId])
    const selectedRunCampaignCount = selectedRun ? (runCampaignCountById.get(selectedRun.id) || 0) : 0
    const runById = useMemo(() => {
        return buildRoadtourRunMap(runs)
    }, [runs])

    const handleDeleteSelectedRun = async () => {
        if (!selectedRun) return

        try {
            setDeleteEventLoading(true)

            const response = await fetch(`/api/roadtour/events/${selectedRun.id}`, {
                method: 'DELETE',
            })

            const result = await response.json().catch(() => null)
            if (!response.ok) {
                throw new Error(result?.error || result?.message || 'Failed to delete RoadTour Event.')
            }

            toast({
                title: 'RoadTour Event deleted',
                description: `"${selectedRun.name}" has been deleted.`,
            })

            setDeleteEventDialogOpen(false)
            await Promise.all([loadRuns(), loadCampaigns()])
        } catch (err: any) {
            toast({
                title: 'Error',
                description: err.message || 'Failed to delete RoadTour Event.',
                variant: 'destructive',
            })
        } finally {
            setDeleteEventLoading(false)
        }
    }

    if (loading) return <SeraLoadingState variant="page" />

    return (
        <div className="sera-sc-page space-y-4 sm:space-y-6">
            <AlertDialog open={deleteEventDialogOpen} onOpenChange={setDeleteEventDialogOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete RoadTour Event?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This event has no campaigns. This action cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={deleteEventLoading}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleDeleteSelectedRun}
                            disabled={deleteEventLoading}
                            className="bg-red-600 hover:bg-red-700 focus:ring-red-500"
                        >
                            {deleteEventLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                            Delete Event
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                    <div className="sera-sc-header__bar mb-3 h-1 w-12 rounded-sm bg-[var(--sera-orange)]" />
                    <h3 className="font-display flex items-center gap-2 text-lg font-semibold tracking-tight text-[var(--sera-ink)] sm:text-xl"><MapIcon className="h-5 w-5 text-[var(--sera-orange)]" />RoadTour Campaigns</h3>
                    <p className="text-sm text-muted-foreground mt-1">Create, manage, and assign references to road tour campaigns.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={openCreateEvent} className="gap-2">
                        <MapIcon className="h-4 w-4" />Create RoadTour Event
                    </Button>
                    <Button onClick={openCreate} className="gap-2 bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]" disabled={runs.length === 0}>
                        <Plus className="h-4 w-4" />Create Campaign
                    </Button>
                </div>
            </div>

            {/* RoadTour Event selector / empty state */}
            {runsLoading ? (
                <Card><CardContent className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></CardContent></Card>
            ) : runs.length === 0 ? (
                <Card className="border-dashed border-2 border-amber-200 bg-amber-50/40">
                    <CardContent className="flex flex-col items-center text-center py-10 gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
                            <MapIcon className="h-6 w-6" />
                        </div>
                        <div>
                            <p className="text-base font-semibold">No RoadTour Event yet</p>
                            <p className="text-sm text-muted-foreground mt-1 max-w-md">
                                Create a RoadTour Event first before creating campaigns. Campaigns must belong to an event so duplicate scan protection can work correctly.
                            </p>
                        </div>
                        <Button onClick={openCreateEvent} className="gap-2">
                            <Plus className="h-4 w-4" />Create RoadTour Event
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <Card className="border-[var(--sera-orange)]/20 bg-[var(--sera-orange)]/[0.04]">
                    <CardContent className="py-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex items-center gap-3 flex-wrap">
                            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)]">
                                <MapIcon className="h-4 w-4" />
                            </div>
                            <div className="min-w-[220px]">
                                <Label className="text-[11px] text-muted-foreground">RoadTour Event</Label>
                                <Select value={selectedRunId} onValueChange={setSelectedRunId}>
                                    <SelectTrigger className="min-w-[220px]"><SelectValue placeholder="Select event" /></SelectTrigger>
                                    <SelectContent>
                                        {runs.map((r) => (
                                            <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            {canManageRuns && selectedRun && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={openEditSelectedEvent}
                                    title="Edit RoadTour Event"
                                    className="gap-1"
                                >
                                    <Edit className="h-4 w-4" />
                                    <span className="hidden sm:inline">Edit Event</span>
                                </Button>
                            )}
                            {canManageRuns && selectedRun && (
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setDeleteEventDialogOpen(true)}
                                    disabled={deleteEventLoading || runsLoading || selectedRunCampaignCount > 0}
                                    title={selectedRunCampaignCount > 0 ? 'Cannot delete event with existing campaigns.' : 'Delete RoadTour Event'}
                                    className="gap-1 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 disabled:border-border disabled:text-muted-foreground"
                                >
                                    <Trash2 className="h-4 w-4" />
                                    <span className="hidden sm:inline">Delete Event</span>
                                </Button>
                            )}
                            {selectedRun && (
                                <>
                                    <Badge className={statusColors[selectedRun.status] || ''}>{selectedRun.status}</Badge>
                                    <span className="text-xs text-muted-foreground">
                                        {selectedRun.start_date} — {selectedRun.end_date}
                                    </span>
                                </>
                            )}
                        </div>
                        {selectedRun && (
                            <div className="flex flex-col gap-2 text-xs lg:items-end">
                                <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1.5">
                                    <ShieldCheck className="h-3.5 w-3.5" />
                                    Duplicate protection: {DUPLICATE_POLICY_LABEL[selectedRun.duplicate_policy]}
                                </div>
                                <div className="flex items-center gap-2 text-[var(--sera-orange-deep)] bg-[var(--sera-orange)]/[0.06] border border-[var(--sera-orange)]/25 rounded-full px-3 py-1.5">
                                    <Gift className="h-3.5 w-3.5" />
                                    Reward release: {POINT_RELEASE_RULE_LABEL[selectedRun.point_release_rule]}
                                    {selectedRun.point_release_rule === 'product_qr_scan_target_once' && selectedRun.required_product_qr_scans && selectedRun.product_qr_counting_period ? (
                                        <span className="text-[var(--sera-orange)]">
                                            ({selectedRun.required_product_qr_scans} unique scans, {PRODUCT_QR_COUNTING_PERIOD_LABEL[selectedRun.product_qr_counting_period]})
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* Filters */}
            <div className="flex gap-3 flex-wrap">
                <div className="relative flex-1 min-w-[180px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input placeholder="Search campaigns..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-9" />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Status</SelectItem>
                        <SelectItem value="draft">Draft</SelectItem>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="paused">Paused</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="archived">Archived</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Campaigns Table */}
            <Card>
                <CardContent className="p-0 overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Campaign</TableHead>
                                <TableHead className="hidden xl:table-cell">Event</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead className="hidden md:table-cell">Period</TableHead>
                                <TableHead className="hidden md:table-cell">Days</TableHead>
                                <TableHead className="hidden lg:table-cell">Mode</TableHead>
                                <TableHead className="hidden lg:table-cell">Region</TableHead>
                                <TableHead>References</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {filtered.length === 0 && (
                                <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">No campaigns found.</TableCell></TableRow>
                            )}
                            {filtered.map((c) => {
                                const workDays = calcWorkingDays(c.start_date, c.end_date)
                                const costPerReward = c.default_points * pointValueRm
                                const eventRun = c.roadtour_run_id ? runById.get(c.roadtour_run_id) : null
                                return (
                                    <TableRow key={c.id}>
                                        <TableCell>
                                            <div>
                                                <p className="font-medium">{c.name}</p>
                                                {c.description && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{c.description}</p>}
                                                <p className="text-xs text-muted-foreground md:hidden">{c.start_date} — {c.end_date}</p>
                                            </div>
                                        </TableCell>
                                        <TableCell className="hidden xl:table-cell">
                                            {eventRun ? (
                                                <Badge variant="outline" className="text-xs gap-1"><MapIcon className="h-3 w-3" />{eventRun.name}</Badge>
                                            ) : (
                                                <span className="text-xs text-muted-foreground">—</span>
                                            )}
                                        </TableCell>
                                        <TableCell><Badge className={statusColors[c.status] || ''}>{c.status}</Badge></TableCell>
                                        <TableCell className="text-sm hidden md:table-cell">{c.start_date} — {c.end_date}</TableCell>
                                        <TableCell className="hidden md:table-cell text-sm">
                                            <div>
                                                <p className="font-medium">{workDays}</p>
                                                <p className="text-xs text-muted-foreground">{(() => { const today = new Date(); today.setHours(0, 0, 0, 0); const end = new Date(c.end_date); end.setHours(0, 0, 0, 0); const diff = Math.ceil((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)); return diff > 0 ? `${diff} days left` : diff === 0 ? 'Last day' : 'Ended' })()}</p>
                                            </div>
                                        </TableCell>
                                        <TableCell className="hidden lg:table-cell"><Badge variant="outline" className="text-xs">{c.reward_mode === 'survey_submit' ? 'Survey' : 'Direct'}</Badge></TableCell>
                                        <TableCell className="text-sm hidden lg:table-cell">
                                            {c.region_scope && c.region_scope.length > 0 ? (
                                                <div className="flex flex-wrap gap-2">
                                                    {c.region_scope.map((r) => (
                                                        <button
                                                            key={r}
                                                            type="button"
                                                            onClick={() => openRegionShops(r)}
                                                            title={`View shops in ${r}`}
                                                            aria-label={`View shops in ${r}`}
                                                            className="inline-flex items-center"
                                                        >
                                                            <RoadtourStateFlag stateName={r} size="md" fallback="badge" />
                                                        </button>
                                                    ))}
                                                </div>
                                            ) : '—'}
                                        </TableCell>
                                        <TableCell>
                                            {(c._managers && c._managers.length > 0) ? (
                                                <button
                                                    className="text-sm text-[var(--sera-orange)] hover:text-[var(--sera-ink-soft)] hover:underline hover:text-[var(--sera-orange-deep)] cursor-pointer"
                                                    onClick={() => openManagers(c.id, c.name)}
                                                >
                                                    Show ({c._managers.length})
                                                </button>
                                            ) : (
                                                <span className="text-xs text-muted-foreground">No references</span>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex gap-1 justify-end">
                                                <Button size="sm" variant="ghost" onClick={() => openManagers(c.id, c.name)} title="Manage references"><Users className="h-4 w-4" /></Button>
                                                <Button size="sm" variant="ghost" onClick={() => openEdit(c)} title="Edit"><Edit className="h-4 w-4" /></Button>
                                                {c.status === 'draft' && <Button size="sm" variant="ghost" onClick={() => deleteDraftCampaign(c.id, c.name)} title="Delete draft"><Trash2 className="h-4 w-4 text-red-600" /></Button>}
                                                {c.status === 'draft' && <Button size="sm" variant="ghost" onClick={() => updateStatus(c.id, 'active')} title="Activate"><Play className="h-4 w-4 text-emerald-600" /></Button>}
                                                {c.status === 'active' && <Button size="sm" variant="ghost" onClick={() => updateStatus(c.id, 'paused')} title="Pause"><Pause className="h-4 w-4 text-amber-600" /></Button>}
                                                {c.status === 'paused' && <Button size="sm" variant="ghost" onClick={() => updateStatus(c.id, 'active')} title="Resume"><Play className="h-4 w-4 text-emerald-600" /></Button>}
                                                {['completed', 'paused'].includes(c.status) && <Button size="sm" variant="ghost" onClick={() => updateStatus(c.id, 'archived')} title="Archive"><Archive className="h-4 w-4 text-slate-500" /></Button>}
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                )
                            })}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            {/* Create/Edit Dialog */}
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="max-w-6xl w-[96vw] max-h-[92vh] overflow-hidden p-0">
                    <DialogHeader className="px-6 pt-6 pb-4 border-b">
                        <DialogTitle className="text-xl">{dialogMode === 'create' ? 'Create RoadTour Campaign' : 'Edit RoadTour Campaign'}</DialogTitle>
                        <DialogDescription>Define a RoadTour campaign for your field activities.</DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-6 px-6 py-6 overflow-y-auto max-h-[70vh] lg:grid-cols-12">
                        {/* COLUMN 1: Event + Campaign Details */}
                        <div className="space-y-6 lg:col-span-4">
                            {/* Section 0 — RoadTour Event */}
                            <Card className="border-[var(--sera-orange)]/25 bg-[var(--sera-orange)]/[0.04]">
                                <CardHeader className="pb-3">
                                    <CardTitle className="flex items-center gap-2 text-sm">
                                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)]"><MapIcon className="h-3.5 w-3.5" /></span>
                                        RoadTour Event
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">RoadTour Event *</Label>
                                        <div className="flex gap-2">
                                            <Select value={formRunId} onValueChange={setFormRunId}>
                                                <SelectTrigger className="flex-1"><SelectValue placeholder="Select event" /></SelectTrigger>
                                                <SelectContent>
                                                    {runs.map((r) => (
                                                        <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                            <Button type="button" variant="outline" size="sm" onClick={() => setCreateEventOpen(true)} className="gap-1">
                                                <Plus className="h-3.5 w-3.5" />Create Event
                                            </Button>
                                        </div>
                                    </div>
                                    <div className="flex items-start gap-2 rounded-md border border-[var(--sera-orange)]/25 bg-[var(--sera-orange)]/[0.06] px-3 py-2 text-[11px] text-[var(--sera-orange-deep)]">
                                        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                        <span>If only one active event exists, it will be auto-selected.</span>
                                    </div>
                                    <p className="text-[11px] text-muted-foreground">
                                        All campaigns must belong to an event. This is the key grouping for duplicate scan protection.
                                    </p>
                                </CardContent>
                            </Card>

                            {/* Section 1 — Campaign Details */}
                            <Card className="border-[var(--sera-orange)]/20">
                                <CardHeader className="pb-3">
                                    <CardTitle className="flex items-center gap-2 text-sm">
                                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)] text-xs font-semibold">1</span>
                                        Campaign Details
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">Campaign Name *</Label>
                                        <Input value={formName} onChange={(e) => setFormName(toTitleCase(e.target.value))} placeholder="e.g. Northern Region April 2026" />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">Description</Label>
                                        <Textarea
                                            value={formDesc}
                                            onChange={(e) => setFormDesc(capitalizeFirstOnly(e.target.value.slice(0, 250)))}
                                            placeholder="Optional description..."
                                            rows={3}
                                            maxLength={250}
                                        />
                                        <p className="text-[11px] text-muted-foreground text-right">{formDesc.length} / 250</p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1.5">
                                            <Label className="text-xs">Start Date *</Label>
                                            <Input type="date" value={formStart} onChange={(e) => setFormStart(e.target.value)} />
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label className="text-xs">End Date *</Label>
                                            <Input type="date" value={formEnd} onChange={(e) => setFormEnd(e.target.value)} />
                                        </div>
                                    </div>
                                    {formStart && formEnd && (
                                        <p className="text-[11px] text-muted-foreground -mt-2">
                                            📅 {calcWorkingDays(formStart, formEnd)} working days (excl. weekends)
                                        </p>
                                    )}
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1.5">
                                            <Label className="text-xs">Reward Points *</Label>
                                            <Input type="number" min={1} value={formPoints} onChange={(e) => setFormPoints(parseInt(e.target.value || '20', 10) || 20)} />
                                        </div>
                                        <div className="space-y-1.5">
                                            <Label className="text-xs">Reward Mode *</Label>
                                            <Select value={formRewardMode} onValueChange={setFormRewardMode}>
                                                <SelectTrigger><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="direct_scan">Direct Scan</SelectItem>
                                                    <SelectItem value="survey_submit">Survey Submit</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">Survey Template {formRewardMode === 'survey_submit' ? '*' : ''}</Label>
                                        <Select value={formSurveyTemplateId} onValueChange={setFormSurveyTemplateId} disabled={formRewardMode !== 'survey_submit'}>
                                            <SelectTrigger>
                                                <SelectValue placeholder={surveyTemplates.length > 0 ? 'Select survey template' : 'No active survey templates'} />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {surveyTemplates.map((t) => (
                                                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <p className="text-[11px] text-muted-foreground">
                                            {formRewardMode === 'survey_submit'
                                                ? 'Rewards are issued after a survey response is saved.'
                                                : 'Rewards are issued directly on valid QR scan.'}
                                        </p>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Section 2 — Targeting */}
                            <Card className="border-[var(--sera-orange)]/20">
                                <CardHeader className="pb-3">
                                    <CardTitle className="flex items-center gap-2 text-sm">
                                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)] text-xs font-semibold">2</span>
                                        Targeting
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <Label className="text-xs">Select Regions *</Label>
                                    <div className="flex flex-wrap gap-1.5">
                                        {MALAYSIAN_STATES.map((s) => {
                                            const selected = formRegions.includes(s)
                                            return (
                                                <button
                                                    key={s}
                                                    type="button"
                                                    onClick={() => setFormRegions((prev) => prev.includes(s) ? prev.filter((r) => r !== s) : [...prev, s])}
                                                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${selected
                                                        ? 'border-[var(--sera-orange)]/40 bg-[var(--sera-orange)]/[0.06] text-[var(--sera-orange-deep)]'
                                                        : 'border-border bg-background hover:bg-muted'
                                                        }`}
                                                >
                                                    {s}
                                                    {selected ? <X className="h-3 w-3" /> : null}
                                                </button>
                                            )
                                        })}
                                    </div>
                                    <div className="flex items-center justify-between pt-1">
                                        <span className="inline-flex items-center gap-1 text-xs text-[var(--sera-orange)]">
                                            <CheckCircle2 className="h-3.5 w-3.5" />
                                            {formRegions.length} region{formRegions.length === 1 ? '' : 's'} selected
                                        </span>
                                        {formRegions.length > 0 && (
                                            <button
                                                type="button"
                                                onClick={() => setFormRegions([])}
                                                className="text-xs text-muted-foreground hover:text-foreground hover:underline hover:text-[var(--sera-orange-deep)]"
                                            >
                                                Clear all
                                            </button>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                        </div>

                        {/* COLUMN 2: References + Notes */}
                        <div className="space-y-6 lg:col-span-5">
                            <Card className="border-[var(--sera-orange)]/20">
                                <CardHeader className="pb-3">
                                    <CardTitle className="flex items-center justify-between text-sm">
                                        <span className="flex items-center gap-2">
                                            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)] text-xs font-semibold">3</span>
                                            References
                                        </span>
                                        <Badge variant="outline" className="text-[11px]">{formReferenceIds.length} selected</Badge>
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div className="relative">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            placeholder="Search by name, email, or phone"
                                            value={formReferenceSearch}
                                            onChange={(e) => setFormReferenceSearch(e.target.value)}
                                            className="pl-9"
                                        />
                                    </div>
                                    <div className="rounded-lg border">
                                        {eligibleReferencesLoading ? (
                                            <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>
                                        ) : filteredFormReferences.length === 0 && selectedFormReferences.length === 0 ? (
                                            <p className="px-3 py-8 text-sm text-center text-muted-foreground">No eligible references found.</p>
                                        ) : (
                                            <div className="max-h-72 overflow-y-auto divide-y">
                                                {selectedFormReferences.map((ref) => {
                                                    const initials = (ref.full_name || '?').split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
                                                    return (
                                                        <button
                                                            key={ref.id}
                                                            type="button"
                                                            onClick={() => toggleFormReference(ref.id)}
                                                            className="flex w-full items-center gap-3 px-3 py-3 text-left bg-[var(--sera-orange)]/[0.06] hover:bg-[var(--sera-orange)]/[0.06]"
                                                        >
                                                            <div className="flex h-4 w-4 items-center justify-center rounded border-2 border-[var(--sera-orange)] bg-[var(--sera-orange)]">
                                                                <CheckCircle2 className="h-3 w-3 text-white" />
                                                            </div>
                                                            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-rose-100 text-rose-700 text-xs font-semibold">{initials}</div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-sm font-medium truncate">{ref.full_name}</p>
                                                                <p className="text-xs text-muted-foreground truncate">{ref.email}{ref.phone ? ` · ${ref.phone}` : ''}</p>
                                                            </div>
                                                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                                                        </button>
                                                    )
                                                })}
                                                {filteredFormReferences.slice(0, 50).map((ref) => {
                                                    const initials = (ref.full_name || '?').split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
                                                    return (
                                                        <button
                                                            key={ref.id}
                                                            type="button"
                                                            onClick={() => toggleFormReference(ref.id)}
                                                            className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40"
                                                        >
                                                            <div className="h-4 w-4 rounded border-2 border-muted-foreground/40" />
                                                            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-700 text-xs font-semibold">{initials}</div>
                                                            <div className="flex-1 min-w-0">
                                                                <p className="text-sm font-medium truncate">{ref.full_name}</p>
                                                                <p className="text-xs text-muted-foreground truncate">{ref.email}{ref.phone ? ` · ${ref.phone}` : ''}</p>
                                                            </div>
                                                            <Plus className="h-4 w-4 text-muted-foreground" />
                                                        </button>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>
                                    <p className="text-[11px] text-muted-foreground">
                                        Attach at least one reference so the campaign can be activated immediately after save.
                                    </p>
                                </CardContent>
                            </Card>

                            <Card className="border-[var(--sera-orange)]/20">
                                <CardHeader className="pb-3">
                                    <CardTitle className="flex items-center gap-2 text-sm">
                                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)] text-xs font-semibold">4</span>
                                        Notes
                                    </CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <Textarea
                                        value={formNotes}
                                        onChange={(e) => setFormNotes(e.target.value.slice(0, 250))}
                                        rows={4}
                                        placeholder="Internal notes for this campaign..."
                                        maxLength={250}
                                    />
                                    <p className="text-[11px] text-muted-foreground text-right mt-1">{formNotes.length} / 250</p>
                                </CardContent>
                            </Card>
                        </div>

                        {/* COLUMN 3: Campaign Summary */}
                        <div className="lg:col-span-3">
                            <Card className="sticky top-0 border-slate-200 bg-slate-50/60">
                                <CardHeader className="pb-3">
                                    <CardTitle className="text-sm">Campaign Summary</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-5">
                                    <div>
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <Coins className="h-3.5 w-3.5 text-amber-500" />
                                            Estimated Reward Cost
                                        </div>
                                        <p className="mt-1 text-2xl font-bold text-amber-700">RM {(formPoints * pointValueRm).toFixed(2)}</p>
                                        <p className="text-[11px] text-muted-foreground">per reward</p>
                                    </div>

                                    <div>
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <MapIcon className="h-3.5 w-3.5 text-[var(--sera-orange)]" />
                                            RoadTour Event
                                        </div>
                                        <p className="mt-1 text-sm font-semibold">
                                            {runs.find((r) => r.id === formRunId)?.name || <span className="text-muted-foreground font-normal">Not selected</span>}
                                        </p>
                                    </div>

                                    <div>
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <Gift className="h-3.5 w-3.5 text-[var(--sera-orange)]" />
                                            Reward Mode
                                        </div>
                                        <p className="mt-1 text-sm font-semibold">{formRewardMode === 'survey_submit' ? 'Survey Submit' : 'Direct Scan'}</p>
                                    </div>

                                    {formRewardMode === 'survey_submit' && (
                                        <div>
                                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                <ClipboardList className="h-3.5 w-3.5 text-[var(--sera-muted)]" />
                                                Survey Template
                                            </div>
                                            <p className="mt-1 text-sm font-semibold">
                                                {surveyTemplates.find((t) => t.id === formSurveyTemplateId)?.name || <span className="text-muted-foreground font-normal">Not selected</span>}
                                            </p>
                                        </div>
                                    )}

                                    <div>
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <Globe className="h-3.5 w-3.5 text-[var(--sera-ink-soft)]" />
                                            Regions
                                        </div>
                                        <p className="mt-1 text-2xl font-bold">{formRegions.length} <span className="text-sm font-normal text-muted-foreground">selected</span></p>
                                        {formRegions.length > 0 && (
                                            <p className="text-[11px] text-muted-foreground">{formRegions.slice(0, 5).join(', ')}{formRegions.length > 5 ? '…' : ''}</p>
                                        )}
                                    </div>

                                    <div>
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <Users className="h-3.5 w-3.5 text-rose-500" />
                                            References
                                        </div>
                                        <p className="mt-1 text-2xl font-bold">{formReferenceIds.length} <span className="text-sm font-normal text-muted-foreground">selected</span></p>
                                    </div>

                                    {(() => {
                                        const ready = Boolean(formName.trim()) && Boolean(formStart) && Boolean(formEnd) &&
                                            Boolean(formRunId) &&
                                            (formRewardMode !== 'survey_submit' || Boolean(formSurveyTemplateId)) &&
                                            formRegions.length > 0 && formReferenceIds.length > 0
                                        return (
                                            <div className={`rounded-lg border p-3 ${ready ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50/60'}`}>
                                                <div className="flex items-center gap-2 text-xs">
                                                    <ShieldCheck className={`h-3.5 w-3.5 ${ready ? 'text-emerald-600' : 'text-amber-600'}`} />
                                                    <span className="text-muted-foreground">Activation Readiness</span>
                                                </div>
                                                <p className={`mt-1 text-sm font-semibold ${ready ? 'text-emerald-700' : 'text-amber-700'}`}>
                                                    {ready ? 'Ready to activate' : 'Needs more details'}
                                                </p>
                                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                                    {ready ? 'All required fields are filled.' : 'Fill required fields to activate.'}
                                                </p>
                                            </div>
                                        )
                                    })()}

                                    {/* Duplicate protection summary */}
                                    {(() => {
                                        const run = runs.find((r) => r.id === formRunId)
                                        if (!run) return null
                                        return (
                                            <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-xs">
                                                <div className="flex items-center gap-2 text-emerald-700 font-semibold">
                                                    <ShieldCheck className="h-3.5 w-3.5" />
                                                    Duplicate Protection
                                                </div>
                                                <p className="mt-1">{DUPLICATE_POLICY_LABEL[run.duplicate_policy]}</p>
                                                <p className="text-[11px] text-muted-foreground mt-0.5">Each shop can scan only once in <strong>{run.name}</strong>.</p>
                                            </div>
                                        )
                                    })()}
                                </CardContent>
                            </Card>
                        </div>
                    </div>

                    <DialogFooter className="px-6 py-4 border-t bg-slate-50/40">
                        <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleSave} disabled={saving}>
                            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                            {dialogMode === 'create' ? 'Create Campaign' : 'Update Campaign'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Account Managers Dialog */}
            <Dialog open={managersDialogOpen} onOpenChange={(open) => { setManagersDialogOpen(open); if (!open) loadCampaigns() }}>
                <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>References — {selectedCampaignName}</DialogTitle>
                        <DialogDescription>Assign eligible references (marked as &quot;Eligible as Reference&quot;) to this campaign.</DialogDescription>
                    </DialogHeader>
                    {managersLoading ? (
                        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
                    ) : (
                        <div className="space-y-4">
                            {/* Current Assignments */}
                            <div>
                                <Label className="text-sm font-semibold">Currently Assigned ({managers.filter((m) => m.is_active).length})</Label>
                                {managers.filter((m) => m.is_active).length === 0 && <p className="text-sm text-muted-foreground mt-1">No references assigned yet.</p>}
                                <div className="space-y-2 mt-2">
                                    {managers.filter((m) => m.is_active).map((m) => (
                                        <div key={m.id} className="flex items-center justify-between rounded-lg border p-3">
                                            <div>
                                                <p className="text-sm font-medium">{m.full_name}</p>
                                                <p className="text-xs text-muted-foreground">{m.email} · {m.phone}</p>
                                            </div>
                                            <Button size="sm" variant="ghost" onClick={() => removeManager(m.id)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Add New */}
                            <div>
                                <Label className="text-sm font-semibold">Add Reference</Label>
                                <Input placeholder="Search by name..." value={managerSearch} onChange={(e) => setManagerSearch(e.target.value)} className="mt-2" />
                                <div className="space-y-1 mt-2 max-h-48 overflow-y-auto">
                                    {availableManagers
                                        .filter((am) => !managers.some((m) => m.user_id === am.id && m.is_active))
                                        .filter((am) => !managerSearch || am.full_name.toLowerCase().includes(managerSearch.toLowerCase()))
                                        .slice(0, 20)
                                        .map((am) => (
                                            <button key={am.id} onClick={() => assignManager(am.id)}
                                                className="w-full flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50 text-left">
                                                <div>
                                                    <p className="text-sm font-medium">{am.full_name}</p>
                                                    <p className="text-xs text-muted-foreground">{am.email} · {am.phone}</p>
                                                </div>
                                                <Plus className="h-4 w-4 text-[var(--sera-orange)]" />
                                            </button>
                                        ))}
                                </div>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* Region Shops Dialog */}
            <Dialog open={regionDialogOpen} onOpenChange={setRegionDialogOpen}>
                <DialogContent className="sm:max-w-md max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle><MapPin className="inline h-4 w-4 mr-1" />{regionDialogState}</DialogTitle>
                        <DialogDescription>Shops registered under this state.</DialogDescription>
                    </DialogHeader>
                    {regionShopsLoading ? (
                        <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
                    ) : regionShops.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-8">No shops found in {regionDialogState}.</p>
                    ) : (
                        <div className="space-y-2">
                            <p className="text-sm text-muted-foreground">{regionShops.length} shops</p>
                            {regionShops.map((shop) => (
                                <div key={shop.id} className="rounded-lg border p-3">
                                    <p className="text-sm font-medium">{shop.org_name}</p>
                                    {shop.branch_name && <p className="text-xs text-muted-foreground">{shop.branch_name}</p>}
                                </div>
                            ))}
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* References Detail Dialog */}
            <Dialog open={refsDialogOpen} onOpenChange={setRefsDialogOpen}>
                <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>References — {refsDialogCampaignName}</DialogTitle>
                        <DialogDescription>{refsDialogManagers.length} reference{refsDialogManagers.length !== 1 ? 's' : ''} assigned</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                        {refsDialogManagers.map((m, i) => (
                            <div key={i} className="rounded-lg border p-3">
                                <p className="text-sm font-medium">{m.full_name}</p>
                                {m.phone && <p className="text-xs text-muted-foreground">{m.phone}</p>}
                            </div>
                        ))}
                    </div>
                </DialogContent>
            </Dialog>

            {/* Create RoadTour Event Dialog */}
            <CreateRoadtourEventDialog
                open={createEventOpen}
                onOpenChange={(open) => {
                    setCreateEventOpen(open)
                    if (!open) setEditingRun(null)
                }}
                supabase={supabase}
                orgId={companyId}
                createdBy={userProfile.id}
                event={editingRun}
                onCreated={async (run) => {
                    await loadRuns()
                    setSelectedRunId(run.id)
                    setFormRunId(run.id)
                }}
                onSaved={async (run) => {
                    await loadRuns()
                    setSelectedRunId(run.id)
                    setFormRunId(run.id)
                }}
            />
        </div>
    )
}
