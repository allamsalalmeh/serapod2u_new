'use client'
/**
 * Quality & Return Issues — Supply Chain > Quality & Returns > Product Return.
 *
 * Header: title + visibility chip + Export / Refresh / Log Manual Issue
 * KPI cards: Open / Pending Manufacturer / Acknowledged / Resolved / Rejected / Units Affected
 * Filters: search · Type · Manufacturer · Status · Date Range · More Filters
 * Two columns: Issues table (left) + Issue Details (right) with timeline, evidence, response
 *
 * Backed by:
 *   GET  /api/manufacturer/adjustments
 *   POST /api/manufacturer/adjustments/{id}                 (acknowledge)
 *   POST /api/admin/adjustments/{id}/status                 (SA set final status)
 *
 * Disabled actions show "Not available yet" tooltips — no backend support yet:
 *   - Export
 *   - Log Manual Issue
 *   - More Filters
 */
import { useEffect, useMemo, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import {
    AlertCircle, Clock, CheckCircle2, CheckCheck, XCircle, Package,
    Search, Filter, Download, Plus, RefreshCw, Loader2,
    Calendar, Image as ImageIcon, ExternalLink, ChevronRight, Upload, X,
    Send, Pencil, Trash2, Phone, FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogTitle, DialogHeader, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import SafeImage from '@/components/shared/SafeImage'
import {
    getEvidenceFileName,
    getIssueDisplayStatus,
    isImageEvidenceUrl,
    normalizeManufacturerWorkflowStatus,
} from '@/lib/quality-issues'
import { formatPhoneDisplay } from '@/utils/phone'

interface UserProfile { id: string; organization_id?: string; role_code?: string }

interface AdjustmentItem {
    id: string
    variant_id: string | null
    adjustment_quantity: number
    unit_cost?: number | null
    system_quantity?: number | null
    physical_quantity?: number | null
    product_name?: string | null
    product_code?: string | null
    sku?: string | null
    variant_name?: string | null
    product_image?: string | null
}

interface OrgRef {
    id: string
    org_name: string
    org_type_code?: string | null
    contact_phone?: string | null
}

interface AdjustmentAction {
    id: string
    adjustment_id: string
    manufacturer_org_id: string | null
    action_type: string
    notes: string | null
    created_by: string | null
    created_at: string
}

interface AttachmentPreview {
    file: File
    previewUrl: string | null
    isImage: boolean
}

interface Adjustment {
    id: string
    organization_id: string
    reason_id: string
    notes: string | null
    proof_images: string[] | null
    status: string | null
    created_at: string
    created_by: string | null
    target_manufacturer_org_id: string | null
    manufacturer_status: string | null
    manufacturer_acknowledged_at: string | null
    manufacturer_acknowledged_by: string | null
    manufacturer_notes: string | null
    manufacturer_assigned_at?: string | null
    stock_adjustment_items: AdjustmentItem[] | null
    stock_adjustment_reasons: { reason_code: string; reason_name: string } | null
    created_by_user: { full_name: string; email?: string } | null
    reporter_org?: OrgRef | null
    manufacturer_org?: OrgRef | null
    workflow_status?: string | null
    manufacturer_actions?: AdjustmentAction[] | null
}

interface SendPreviewData {
    issueCode: string
    manufacturerName: string
    manufacturerPhone: string
    templateBody: string
    text: string
    issueLink: string
}

// ── Helpers ──────────────────────────────────────────────────────
function shortId(id?: string | null) {
    if (!id) return '—'
    return id.length > 10 ? id.slice(0, 8) : id
}

function issueCode(a: Adjustment) {
    const year = new Date(a.created_at).getFullYear()
    return `QI-${year}-${a.id.slice(0, 5).toUpperCase()}`
}

function totalUnits(a: Adjustment) {
    return (a.stock_adjustment_items ?? []).reduce((sum, it) => sum + Math.abs(it.adjustment_quantity ?? 0), 0)
}

function firstIssueItem(issue: Adjustment | null | undefined) {
    return issue?.stock_adjustment_items?.[0] ?? null
}

function isManufacturerScope(a: Adjustment, profile: UserProfile) {
    return profile.role_code === 'SA' || profile.organization_id === a.target_manufacturer_org_id
}

function canManageDraftIssue(issue: Adjustment, profile: UserProfile) {
    return getIssueDisplayStatus(issue) === 'draft' && (profile.role_code === 'SA' || profile.organization_id === issue.organization_id)
}

function formatDate(iso?: string | null, withTime = true) {
    if (!iso) return '—'
    const d = new Date(iso)
    if (isNaN(d.getTime())) return '—'
    return withTime
        ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : d.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

function formatRelativeTime(iso?: string | null) {
    if (!iso) return '—'
    const time = new Date(iso).getTime()
    if (isNaN(time)) return '—'

    const diff = Date.now() - time
    if (diff < 60_000) return 'Just now'
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`
    if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))}h ago`
    if (diff < 2_592_000_000) return `${Math.max(1, Math.round(diff / 86_400_000))}d ago`
    return formatDate(iso, false)
}

function getIssueLastActivityAt(issue: Adjustment) {
    const candidates = [
        issue.created_at,
        issue.manufacturer_assigned_at,
        issue.manufacturer_acknowledged_at,
        ...(issue.manufacturer_actions || []).map((action) => action.created_at),
    ].filter(Boolean) as string[]

    return candidates.reduce<string | null>((latest, current) => {
        if (!latest) return current
        return new Date(current).getTime() > new Date(latest).getTime() ? current : latest
    }, null)
}

function buildIssueEvidenceUrl(issueId: string, index: number, download = false) {
    const suffix = download ? '?download=1' : ''
    return `/api/manufacturer/adjustments/${issueId}/evidence/${index}${suffix}`
}

function reasonTypeLabel(code?: string | null) {
    if (code === 'quality_issue') return { label: 'Quality Issue', tone: 'bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-200' }
    if (code === 'return_to_supplier') return { label: 'Return to Supplier', tone: 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200' }
    if (code === 'damaged_goods') return { label: 'Damaged Goods', tone: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200' }
    return { label: code ?? '—', tone: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200' }
}

function statusBadge(value: string | null | undefined) {
    if (!value) return null
    const tone =
        value === 'draft' ? 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200' :
            value === 'pending_manufacturer' ? 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200' :
        value === 'resolved' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200' :
            value === 'acknowledged' ? 'bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200' :
                value === 'rejected' ? 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200' :
                    value === 'pending' ? 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200' :
                        'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200'
    return (
        <span className={cn(
            'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize whitespace-nowrap',
            tone,
        )}>
            {value.replaceAll('_', ' ')}
        </span>
    )
}

// ── Stat card ────────────────────────────────────────────────────
function StatCard({
    label, value, tone, icon, hint,
}: {
    label: string
    value: number | string
    tone: 'orange' | 'amber' | 'blue' | 'emerald' | 'red' | 'slate'
    icon: React.ReactNode
    hint?: string
}) {
    const toneMap = {
        orange: 'bg-orange-50 text-orange-600',
        amber: 'bg-amber-50 text-amber-600',
        blue: 'bg-blue-50 text-blue-600',
        emerald: 'bg-emerald-50 text-emerald-600',
        red: 'bg-red-50 text-red-600',
        slate: 'bg-slate-100 text-slate-600',
    }
    return (
        <div className="rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_0_rgba(0,0,0,0.04)] p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-500">{label}</p>
                    <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{value}</p>
                    {hint && <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>}
                </div>
                <span className={cn('inline-flex h-8 w-8 items-center justify-center rounded-md', toneMap[tone])}>
                    {icon}
                </span>
            </div>
        </div>
    )
}

// ── Main ─────────────────────────────────────────────────────────
export default function QualityIssuesView({ userProfile }: { userProfile: UserProfile }) {
    const searchParams = useSearchParams()
    const { toast } = useToast()
    const [items, setItems] = useState<Adjustment[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [ackLoadingId, setAckLoadingId] = useState<string | null>(null)
    const [statusLoadingId, setStatusLoadingId] = useState<string | null>(null)
    const [createOpen, setCreateOpen] = useState(false)
    const [editingIssue, setEditingIssue] = useState<Adjustment | null>(null)
    const [sendPreviewIssue, setSendPreviewIssue] = useState<Adjustment | null>(null)
    const [sendPreview, setSendPreview] = useState<SendPreviewData | null>(null)
    const [sendLoadingId, setSendLoadingId] = useState<string | null>(null)
    const [sendSubmittingId, setSendSubmittingId] = useState<string | null>(null)
    const [deleteLoadingId, setDeleteLoadingId] = useState<string | null>(null)

    const [search, setSearch] = useState('')
    const [typeFilter, setTypeFilter] = useState('all')
    const [manufacturerFilter, setManufacturerFilter] = useState('all')
    const [statusFilter, setStatusFilter] = useState('all')
    const [rangeFilter, setRangeFilter] = useState('30d')

    const isSA = userProfile.role_code === 'SA'

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const resp = await fetch('/api/manufacturer/adjustments')
            const json = await resp.json()
            if (json.error) {
                setError(json.error)
                setItems([])
            } else {
                setItems(json.data || [])
            }
        } catch (err: any) {
            setError(err?.message ?? 'Failed to load issues')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { load() }, [load])

    const stats = useMemo(() => {
        return {
            draft: items.filter(i => getIssueDisplayStatus(i) === 'draft').length,
            pendingMfr: items.filter(i => getIssueDisplayStatus(i) === 'pending_manufacturer').length,
            acknowledged: items.filter(i => getIssueDisplayStatus(i) === 'acknowledged').length,
            resolved: items.filter(i => i.status === 'resolved').length,
            rejected: items.filter(i => getIssueDisplayStatus(i) === 'rejected').length,
            units: items.reduce((sum, i) => sum + totalUnits(i), 0),
        }
    }, [items])

    const manufacturerOptions = useMemo(() => {
        const set = new Map<string, string>()
        items.forEach(i => {
            if (i.target_manufacturer_org_id) {
                set.set(i.target_manufacturer_org_id, i.manufacturer_org?.org_name || shortId(i.target_manufacturer_org_id))
            }
        })
        return Array.from(set.entries())
    }, [items])

    const filtered = useMemo(() => {
        const s = search.trim().toLowerCase()
        const cutoff = (() => {
            if (rangeFilter === 'all') return null
            const days = rangeFilter === '7d' ? 7 : rangeFilter === '30d' ? 30 : 90
            return Date.now() - days * 86400_000
        })()
        return items.filter(it => {
            if (typeFilter !== 'all' && it.stock_adjustment_reasons?.reason_code !== typeFilter) return false
            if (manufacturerFilter !== 'all' && it.target_manufacturer_org_id !== manufacturerFilter) return false
            if (statusFilter !== 'all') {
                if (getIssueDisplayStatus(it) !== statusFilter) return false
            }
            if (cutoff != null) {
                const t = new Date(it.created_at).getTime()
                if (isNaN(t) || t < cutoff) return false
            }
            if (!s) return true
            const hay = [
                issueCode(it),
                it.id,
                it.notes,
                it.stock_adjustment_reasons?.reason_name,
                it.created_by_user?.full_name,
                it.target_manufacturer_org_id,
                it.reporter_org?.org_name,
                it.manufacturer_org?.org_name,
                ...(it.stock_adjustment_items || []).flatMap(item => [item.product_name, item.variant_name, item.sku]),
            ].filter(Boolean).join(' ').toLowerCase()
            return hay.includes(s)
        })
    }, [items, search, typeFilter, manufacturerFilter, statusFilter, rangeFilter])

    useEffect(() => {
        if (!selectedId && filtered.length) setSelectedId(filtered[0].id)
        if (selectedId && !filtered.some(it => it.id === selectedId) && filtered.length) {
            setSelectedId(filtered[0].id)
        }
    }, [filtered, selectedId])

    useEffect(() => {
        const requestedIssueId = searchParams.get('issueId')
        if (requestedIssueId && filtered.some(issue => issue.id === requestedIssueId)) {
            setSelectedId(requestedIssueId)
        }
    }, [filtered, searchParams])

    const selected = useMemo(() => items.find(it => it.id === selectedId) ?? null, [items, selectedId])

    async function ack(id: string) {
        setAckLoadingId(id)
        try {
            const resp = await fetch(`/api/manufacturer/adjustments/${id}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ notes: 'Acknowledged from manufacturer portal' }),
            })
            const json = await resp.json()
            if (json.error) {
                toast({ title: 'Acknowledge Failed', description: json.error, variant: 'destructive' })
            } else {
                toast({ title: 'Acknowledged', description: 'Manufacturer acknowledgement was recorded.' })
                await load()
            }
        } finally {
            setAckLoadingId(null)
        }
    }

    async function setFinalStatus(id: string) {
        const res = prompt('Set status (resolved/rejected)')
        if (!res) return
        setStatusLoadingId(id)
        try {
            const resp = await fetch(`/api/admin/adjustments/${id}/status`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ status: res }),
            })
            const json = await resp.json()
            if (json.error) {
                toast({ title: 'Status Update Failed', description: json.error, variant: 'destructive' })
            } else {
                toast({ title: 'Status Updated', description: `Issue marked as ${res}.` })
            }
            await load()
        } finally {
            setStatusLoadingId(null)
        }
    }

    async function openSendPreview(issue: Adjustment) {
        setSendPreviewIssue(issue)
        setSendPreview(null)
        setSendLoadingId(issue.id)
        try {
            const resp = await fetch(`/api/manufacturer/adjustments/${issue.id}/send`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ previewOnly: true }),
            })
            const json = await resp.json()
            if (!resp.ok) throw new Error(json.error || 'Unable to load WhatsApp preview')
            setSendPreview(json.preview)
        } catch (err: any) {
            setSendPreviewIssue(null)
            toast({ title: 'Preview Failed', description: err.message || 'Unable to load WhatsApp preview', variant: 'destructive' })
        } finally {
            setSendLoadingId(null)
        }
    }

    async function confirmSend() {
        if (!sendPreviewIssue) return
        setSendSubmittingId(sendPreviewIssue.id)
        try {
            const resp = await fetch(`/api/manufacturer/adjustments/${sendPreviewIssue.id}/send`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            })
            const json = await resp.json()
            if (!resp.ok) throw new Error(json.error || 'Failed to send issue to manufacturer')
            toast({ title: 'Sent to Manufacturer', description: 'WhatsApp was sent successfully and the issue is now pending manufacturer acknowledgement.' })
            const issueId = sendPreviewIssue.id
            setSendPreviewIssue(null)
            setSendPreview(null)
            await load()
            setSelectedId(issueId)
        } catch (err: any) {
            toast({ title: 'Send Failed', description: err.message || 'Unable to send WhatsApp to the manufacturer', variant: 'destructive' })
        } finally {
            setSendSubmittingId(null)
        }
    }

    async function deleteDraft(issue: Adjustment) {
        if (!confirm(`Delete draft issue ${issueCode(issue)}? This action cannot be undone.`)) return
        setDeleteLoadingId(issue.id)
        try {
            const resp = await fetch(`/api/manufacturer/adjustments/${issue.id}`, { method: 'DELETE' })
            const json = await resp.json().catch(() => ({}))
            if (!resp.ok) throw new Error(json.error || 'Unable to delete draft issue')
            toast({ title: 'Draft Deleted', description: 'The draft issue has been removed.' })
            if (selectedId === issue.id) setSelectedId(null)
            await load()
        } catch (err: any) {
            toast({ title: 'Delete Failed', description: err.message || 'Unable to delete draft issue', variant: 'destructive' })
        } finally {
            setDeleteLoadingId(null)
        }
    }

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h1 className="text-xl font-semibold text-slate-900">Quality &amp; Return Issues</h1>
                    <p className="text-sm text-slate-500 mt-0.5">Track product defects, damaged inventory, and return-to-supplier cases.</p>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 hidden sm:block">Visible to Manufacturer members &amp; Super Admin</span>
                    <Button variant="outline" size="sm" disabled title="Export not available yet">
                        <Download className="h-3.5 w-3.5 mr-1.5" />Export
                    </Button>
                    <Button variant="outline" size="sm" onClick={load} disabled={loading}>
                        {loading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                        Refresh
                    </Button>
                    <Button size="sm" onClick={() => { setEditingIssue(null); setCreateOpen(true) }} className="bg-orange-600 hover:bg-orange-700 text-white">
                        <Plus className="h-3.5 w-3.5 mr-1.5" />Create Issue
                    </Button>
                </div>
            </div>

            {/* Create Issue Modal */}
            <CreateIssueModal
                open={createOpen}
                onOpenChange={(nextOpen) => {
                    setCreateOpen(nextOpen)
                    if (!nextOpen) setEditingIssue(null)
                }}
                userProfile={userProfile}
                issueToEdit={editingIssue}
                onSaved={async (savedId) => {
                    setCreateOpen(false)
                    setEditingIssue(null)
                    await load()
                    if (savedId) setSelectedId(savedId)
                }}
            />

            <Dialog
                open={Boolean(sendPreviewIssue)}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen) {
                        setSendPreviewIssue(null)
                        setSendPreview(null)
                    }
                }}
            >
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Send to Manufacturer</DialogTitle>
                        <DialogDescription>
                            Review the WhatsApp message before sending this issue to the manufacturer. The status will only change after send succeeds.
                        </DialogDescription>
                    </DialogHeader>

                    {sendLoadingId && !sendPreview ? (
                        <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-8 text-sm text-slate-500">
                            <Loader2 className="h-4 w-4 animate-spin" />Loading WhatsApp preview…
                        </div>
                    ) : sendPreview ? (
                        <div className="space-y-4">
                            <div className="grid gap-3 rounded-md border border-slate-200 bg-slate-50/80 p-3 text-sm md:grid-cols-2">
                                <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Manufacturer</p>
                                    <p className="mt-1 font-medium text-slate-900">{sendPreview.manufacturerName}</p>
                                    <p className="text-xs text-slate-500">{formatPhoneDisplay(sendPreview.manufacturerPhone)}</p>
                                </div>
                                <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Issue Link</p>
                                    <a href={sendPreview.issueLink} target="_blank" rel="noreferrer" className="mt-1 inline-flex text-xs text-blue-600 hover:underline">
                                        {sendPreview.issueLink}
                                    </a>
                                </div>
                            </div>

                            <div>
                                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Message Preview</p>
                                <pre className="whitespace-pre-wrap rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-700">{sendPreview.text}</pre>
                            </div>
                        </div>
                    ) : null}

                    <DialogFooter>
                        <Button variant="ghost" onClick={() => { setSendPreviewIssue(null); setSendPreview(null) }} disabled={Boolean(sendSubmittingId)}>Cancel</Button>
                        <Button onClick={confirmSend} disabled={!sendPreview || Boolean(sendSubmittingId)} className="bg-orange-600 hover:bg-orange-700 text-white">
                            {sendSubmittingId ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                            Confirm Send
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* KPI cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                <StatCard label="Draft Issues" value={stats.draft} tone="slate" icon={<AlertCircle className="h-4 w-4" />} hint="Not sent yet" />
                <StatCard label="Pending Manufacturer" value={stats.pendingMfr} tone="amber" icon={<Clock className="h-4 w-4" />} hint="Awaiting ack" />
                <StatCard label="Acknowledged" value={stats.acknowledged} tone="blue" icon={<CheckCircle2 className="h-4 w-4" />} hint="By manufacturer" />
                <StatCard label="Resolved" value={stats.resolved} tone="emerald" icon={<CheckCheck className="h-4 w-4" />} hint="Final status" />
                <StatCard label="Rejected" value={stats.rejected} tone="red" icon={<XCircle className="h-4 w-4" />} hint="Not accepted" />
                <StatCard label="Units Affected" value={stats.units} tone="slate" icon={<Package className="h-4 w-4" />} hint="Across all issues" />
            </div>

            {/* Filters */}
            <div className="rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_0_rgba(0,0,0,0.04)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative">
                        <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                        <Input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search issues, reporters, manufacturers…"
                            className="pl-8 h-9 w-[260px]"
                        />
                    </div>
                    <Select value={typeFilter} onValueChange={setTypeFilter}>
                        <SelectTrigger className="w-[150px] h-9"><SelectValue placeholder="Type" /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Types</SelectItem>
                            <SelectItem value="quality_issue">Quality Issue</SelectItem>
                            <SelectItem value="return_to_supplier">Return to Supplier</SelectItem>
                            <SelectItem value="damaged_goods">Damaged Goods</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={manufacturerFilter} onValueChange={setManufacturerFilter}>
                        <SelectTrigger className="w-[170px] h-9"><SelectValue placeholder="Manufacturer" /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Manufacturers</SelectItem>
                            {manufacturerOptions.map(([id, label]) => (
                                <SelectItem key={id} value={id} className="font-mono text-xs">{label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                        <SelectTrigger className="w-[140px] h-9"><SelectValue placeholder="Status" /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Status</SelectItem>
                            <SelectItem value="draft">Draft</SelectItem>
                            <SelectItem value="pending_manufacturer">Pending Manufacturer</SelectItem>
                            <SelectItem value="acknowledged">Acknowledged</SelectItem>
                            <SelectItem value="resolved">Resolved</SelectItem>
                            <SelectItem value="rejected">Rejected</SelectItem>
                        </SelectContent>
                    </Select>
                    <Select value={rangeFilter} onValueChange={setRangeFilter}>
                        <SelectTrigger className="w-[150px] h-9">
                            <Calendar className="h-3.5 w-3.5 mr-1 text-slate-400" />
                            <SelectValue placeholder="Date range" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="7d">Last 7 days</SelectItem>
                            <SelectItem value="30d">Last 30 days</SelectItem>
                            <SelectItem value="90d">Last 90 days</SelectItem>
                            <SelectItem value="all">All time</SelectItem>
                        </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" disabled title="More filters not available yet">
                        <Filter className="h-3.5 w-3.5 mr-1.5" />More Filters
                    </Button>
                </div>
            </div>

            {/* Two-column layout */}
            <div className="grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] gap-4">
                {/* Issues table */}
                <div className="rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_0_rgba(0,0,0,0.04)] overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-slate-900">Issues</h2>
                        <span className="text-xs text-slate-500">{filtered.length} of {items.length}</span>
                    </div>
                    {loading ? (
                        <div className="py-12 flex items-center justify-center text-sm text-slate-500 gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />Loading…
                        </div>
                    ) : error ? (
                        <div className="py-12 px-6 text-center">
                            <div className="text-sm text-red-600">Failed to load: {error}</div>
                            <Button variant="outline" size="sm" className="mt-3" onClick={load}>Retry</Button>
                        </div>
                    ) : items.length === 0 ? (
                        <EmptyState forSA={isSA} onCreate={() => setCreateOpen(true)} />
                    ) : filtered.length === 0 ? (
                        <div className="py-12 px-6 text-center">
                            <h3 className="text-sm font-semibold text-slate-900">No matching issues</h3>
                            <p className="text-sm text-slate-500 mt-1">Try adjusting filters or search.</p>
                        </div>
                    ) : (
                        <div className="overflow-hidden">
                            <Table>
                                <TableHeader>
                                    <TableRow className="bg-slate-50/60 hover:bg-slate-50/60 border-slate-100">
                                        <TableHead className="h-9 w-[135px] text-[11px] font-semibold uppercase text-slate-500 tracking-wide">Issue</TableHead>
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide">Product</TableHead>
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide">Type</TableHead>
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide">Status</TableHead>
                                        <TableHead className="h-9 w-[110px] text-[11px] font-semibold uppercase text-slate-500 tracking-wide">Updated</TableHead>
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide text-right">Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map(r => {
                                        const isSel = selectedId === r.id
                                        const type = reasonTypeLabel(r.stock_adjustment_reasons?.reason_code)
                                        const firstItem = firstIssueItem(r)
                                        const workflowStatus = r.workflow_status || getIssueDisplayStatus(r)
                                        const extraCount = (r.stock_adjustment_items?.length ?? 0) - 1
                                        const canManageDraft = canManageDraftIssue(r, userProfile)
                                        const updatedAt = getIssueLastActivityAt(r)
                                        return (
                                            <TableRow
                                                key={r.id}
                                                onClick={() => setSelectedId(r.id)}
                                                className={cn(
                                                    'cursor-pointer border-slate-100 transition-colors',
                                                    isSel ? 'bg-orange-50/50 hover:bg-orange-50/70 border-l-[3px] border-l-orange-500' : 'hover:bg-slate-50/60',
                                                )}
                                            >
                                                <TableCell className="py-3 align-top">
                                                    <div className="space-y-0.5">
                                                        <div className="font-mono text-xs text-slate-700">{issueCode(r)}</div>
                                                        <div className="text-[11px] text-slate-500">{formatDate(r.created_at, false)}</div>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="py-3 text-sm text-slate-700">
                                                    <div className="flex items-start gap-2">
                                                        <div className="mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50">
                                                            {firstItem?.product_image ? (
                                                                // eslint-disable-next-line @next/next/no-img-element
                                                                <img src={firstItem.product_image} alt={firstItem.product_name || 'product'} className="h-full w-full object-cover" />
                                                            ) : (
                                                                <Package className="h-4 w-4 text-slate-300" />
                                                            )}
                                                        </div>
                                                        <div className="min-w-0">
                                                            <div className="truncate font-medium text-slate-900">{firstItem?.product_name || firstItem?.product_code || shortId(firstItem?.variant_id)}</div>
                                                            <div className="truncate text-[11px] text-slate-500">{firstItem?.variant_name || 'Standard variant'}</div>
                                                            {extraCount > 0 && (
                                                                <div className="text-[11px] text-slate-500">+{extraCount} more item{extraCount > 1 ? 's' : ''}</div>
                                                            )}
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="py-3 align-top">
                                                    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', type.tone)}>
                                                        {type.label}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="py-3 align-top">{statusBadge(workflowStatus)}</TableCell>
                                                <TableCell className="py-3 align-top text-xs text-slate-500">{formatRelativeTime(updatedAt)}</TableCell>
                                                <TableCell className="py-3 text-right align-top">
                                                    {canManageDraft ? (
                                                        <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
                                                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openSendPreview(r)} disabled={sendLoadingId === r.id || sendSubmittingId === r.id} title="Send to Manufacturer">
                                                                {(sendLoadingId === r.id || sendSubmittingId === r.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                                                            </Button>
                                                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditingIssue(r); setCreateOpen(true) }} title="Edit Draft">
                                                                <Pencil className="h-3.5 w-3.5" />
                                                            </Button>
                                                            <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600 hover:text-red-700" onClick={() => deleteDraft(r)} disabled={deleteLoadingId === r.id} title="Delete Draft">
                                                                {deleteLoadingId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                                            </Button>
                                                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelectedId(r.id)} title="Open Details">
                                                                <ChevronRight className="h-3.5 w-3.5" />
                                                            </Button>
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-center justify-end" onClick={(event) => event.stopPropagation()}>
                                                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelectedId(r.id)} title="Open Details">
                                                                <ChevronRight className="h-3.5 w-3.5" />
                                                            </Button>
                                                        </div>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </div>

                {/* Detail panel */}
                <IssueDetailPanel
                    issue={selected}
                    profile={userProfile}
                    onAck={ack}
                    ackLoadingId={ackLoadingId}
                    onSetStatus={setFinalStatus}
                    statusLoadingId={statusLoadingId}
                    onSendPreview={openSendPreview}
                    sendLoadingId={sendLoadingId}
                    sendSubmittingId={sendSubmittingId}
                    onDeleteDraft={deleteDraft}
                    deleteLoadingId={deleteLoadingId}
                    onEditDraft={(issue) => { setEditingIssue(issue); setCreateOpen(true) }}
                />
            </div>
        </div>
    )
}

// ── Empty state ──────────────────────────────────────────────────
function EmptyState({ forSA, onCreate }: { forSA: boolean; onCreate: () => void }) {
    if (forSA) {
        return (
            <div className="py-14 px-6 flex flex-col items-center text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-100 text-orange-600 mb-3">
                    <AlertCircle className="h-5 w-5" />
                </div>
                <h3 className="text-sm font-semibold text-slate-900">No quality or return issues yet</h3>
                <p className="mt-1 text-sm text-slate-500 max-w-md">
                    Issues will appear here when inventory movements are reported as Quality Issue or Return to Supplier.
                </p>
                <div className="mt-4 flex items-center gap-2">
                    <Button size="sm" onClick={onCreate}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />Create Issue
                    </Button>
                    <a
                        href="/inventory/stock-movements"
                        className="inline-flex items-center text-xs text-blue-600 hover:underline"
                    >
                        View Stock Movements <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                </div>
            </div>
        )
    }
    return (
        <div className="py-14 px-6 flex flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500 mb-3">
                <Package className="h-5 w-5" />
            </div>
            <h3 className="text-sm font-semibold text-slate-900">No assigned issues</h3>
            <p className="mt-1 text-sm text-slate-500 max-w-md">
                When HQ assigns a quality or return case to your organization, it will appear here for acknowledgement and resolution.
            </p>
        </div>
    )
}

// ── Detail panel ─────────────────────────────────────────────────
function IssueDetailPanel({
    issue, profile, onAck, ackLoadingId, onSetStatus, statusLoadingId,
    onSendPreview, sendLoadingId, sendSubmittingId, onDeleteDraft, deleteLoadingId, onEditDraft,
}: {
    issue: Adjustment | null
    profile: UserProfile
    onAck: (id: string) => void
    ackLoadingId: string | null
    onSetStatus: (id: string) => void
    statusLoadingId: string | null
    onSendPreview: (issue: Adjustment) => void
    sendLoadingId: string | null
    sendSubmittingId: string | null
    onDeleteDraft: (issue: Adjustment) => void
    deleteLoadingId: string | null
    onEditDraft: (issue: Adjustment) => void
}) {
    if (!issue) {
        return (
            <div className="rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_0_rgba(0,0,0,0.04)] p-6 flex flex-col items-center text-center min-h-[300px] justify-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400 mb-3">
                    <ChevronRight className="h-5 w-5" />
                </div>
                <h3 className="text-sm font-semibold text-slate-900">Select an issue</h3>
                <p className="mt-1 text-sm text-slate-500">Choose a row to view details, evidence, and timeline.</p>
            </div>
        )
    }

    const type = reasonTypeLabel(issue.stock_adjustment_reasons?.reason_code)
    const workflowStatus = issue.workflow_status || getIssueDisplayStatus(issue)
    const primaryItem = firstIssueItem(issue)
    const canAck = isManufacturerScope(issue, profile) && normalizeManufacturerWorkflowStatus(issue.manufacturer_status) === 'pending_manufacturer'
    const canManageDraft = canManageDraftIssue(issue, profile)
    const sentAction = issue.manufacturer_actions?.find((action) => action.action_type === 'sent_to_manufacturer') || null

    return (
        <div className="rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_0_rgba(0,0,0,0.04)] overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <div className="min-w-0">
                    <div className="text-xs font-mono text-slate-500">{issueCode(issue)}</div>
                    <h3 className="text-sm font-semibold text-slate-900 mt-0.5">
                        {issue.stock_adjustment_reasons?.reason_name ?? 'Issue Details'}
                    </h3>
                </div>
                <div className="flex items-center gap-2">
                    {statusBadge(workflowStatus)}
                </div>
            </div>

            <div className="p-4 space-y-4">
                {/* Type */}
                <div className="flex items-center gap-2">
                    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium', type.tone)}>
                        {type.label}
                    </span>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-md border border-slate-200 bg-slate-50/50 p-3">
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Product</p>
                        {primaryItem ? (
                            <div className="flex items-start gap-3">
                                <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-white">
                                    {primaryItem.product_image ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={primaryItem.product_image} alt={primaryItem.product_name || 'product'} className="h-full w-full object-cover" />
                                    ) : (
                                        <Package className="h-5 w-5 text-slate-300" />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-semibold text-slate-900">{primaryItem.product_name || primaryItem.product_code || shortId(primaryItem.variant_id)}</p>
                                    <p className="truncate text-xs text-slate-600">{primaryItem.variant_name || 'Standard variant'}</p>
                                    <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                                        <div>
                                            <span className="text-slate-400">Quantity Affected</span>
                                            <div className="font-medium text-slate-900 tabular-nums">{Math.abs(primaryItem.adjustment_quantity || 0)}</div>
                                        </div>
                                        <div>
                                            <span className="text-slate-400">Unit Cost</span>
                                            <div className="font-medium text-slate-900 tabular-nums">{primaryItem.unit_cost != null ? primaryItem.unit_cost.toFixed(2) : '—'}</div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <p className="text-xs text-slate-400">No product details available.</p>
                        )}
                    </div>

                    <div className="rounded-md border border-slate-200 bg-slate-50/50 p-3">
                        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Manufacturer</p>
                        <p className="text-sm font-semibold text-slate-900">{issue.manufacturer_org?.org_name || shortId(issue.target_manufacturer_org_id)}</p>
                        <div className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                            <Phone className="h-3.5 w-3.5 text-slate-400" />
                            <span>{issue.manufacturer_org?.contact_phone ? formatPhoneDisplay(issue.manufacturer_org.contact_phone) : 'WhatsApp number not configured'}</span>
                        </div>
                        {issue.manufacturer_org?.contact_phone && (
                            <a
                                href={`https://wa.me/${issue.manufacturer_org.contact_phone.replace(/\D/g, '')}`}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-2 inline-flex items-center gap-1 text-[11px] text-green-700 hover:underline"
                            >
                                <ExternalLink className="h-3 w-3" />Open WhatsApp chat
                            </a>
                        )}
                        <div className="mt-3">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Reported By</p>
                            <p className="mt-1 text-sm text-slate-800">{issue.created_by_user?.full_name ?? '—'}</p>
                            {issue.reporter_org?.org_name && <p className="text-[11px] text-slate-500">{issue.reporter_org.org_name}</p>}
                        </div>
                    </div>
                </div>

                {/* Reason / notes */}
                <div>
                    <p className="text-[11px] uppercase text-slate-500 font-semibold tracking-wide">Reason / Notes</p>
                    <p className="mt-1 text-sm text-slate-700 whitespace-pre-wrap">{issue.notes || <span className="text-slate-400 italic">No notes provided.</span>}</p>
                </div>

                {/* Evidence */}
                <div>
                    <p className="text-[11px] uppercase text-slate-500 font-semibold tracking-wide mb-1.5">Evidence</p>
                    {issue.proof_images && issue.proof_images.length > 0 ? (
                        <IssueEvidenceGallery issue={issue} />
                    ) : (
                        <div className="flex items-center gap-1.5 text-xs text-slate-400">
                            <ImageIcon className="h-3.5 w-3.5" />No attachments
                        </div>
                    )}
                </div>

                {/* Manufacturer response */}
                <div>
                    <p className="text-[11px] uppercase text-slate-500 font-semibold tracking-wide">Manufacturer Response</p>
                    <p className="mt-1 text-sm text-slate-700 whitespace-pre-wrap">
                        {issue.manufacturer_notes || <span className="text-slate-400 italic">No response yet.</span>}
                    </p>
                </div>

                {/* Timeline */}
                <div>
                    <p className="text-[11px] uppercase text-slate-500 font-semibold tracking-wide mb-2">Timeline</p>
                    <ol className="relative border-l border-slate-200 ml-2 space-y-3">
                        <TimelineEvent label="Draft Created" date={issue.created_at} tone="slate" />
                        {(sentAction?.created_at || issue.manufacturer_assigned_at) && (
                            <TimelineEvent label="Sent to Manufacturer" date={sentAction?.created_at || issue.manufacturer_assigned_at || null} tone="amber" />
                        )}
                        {issue.manufacturer_acknowledged_at && (
                            <TimelineEvent label="Acknowledged" date={issue.manufacturer_acknowledged_at} tone="emerald" />
                        )}
                        {issue.status === 'resolved' && (
                            <TimelineEvent label="Resolved" date={issue.manufacturer_acknowledged_at ?? issue.created_at} tone="emerald" />
                        )}
                        {(issue.status === 'rejected' || issue.manufacturer_status === 'rejected') && (
                            <TimelineEvent label="Rejected" date={issue.manufacturer_acknowledged_at ?? issue.created_at} tone="red" />
                        )}
                    </ol>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-100">
                    {canManageDraft && (
                        <>
                            <Button
                                size="sm"
                                onClick={() => onSendPreview(issue)}
                                disabled={sendLoadingId === issue.id || sendSubmittingId === issue.id}
                                className="bg-orange-600 hover:bg-orange-700 text-white"
                            >
                                {(sendLoadingId === issue.id || sendSubmittingId === issue.id) ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
                                Send to Manufacturer
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => onEditDraft(issue)}>
                                <Pencil className="h-3.5 w-3.5 mr-1.5" />Edit Draft
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => onDeleteDraft(issue)} disabled={deleteLoadingId === issue.id} className="text-red-600 hover:text-red-700">
                                {deleteLoadingId === issue.id ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1.5" />}
                                Delete Draft
                            </Button>
                        </>
                    )}
                    {canAck && (
                        <Button
                            size="sm"
                            onClick={() => onAck(issue.id)}
                            disabled={ackLoadingId === issue.id}
                            className="bg-blue-600 hover:bg-blue-700 text-white"
                        >
                            {ackLoadingId === issue.id ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />}
                            Acknowledge
                        </Button>
                    )}
                    {profile.role_code === 'SA' && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onSetStatus(issue.id)}
                            disabled={statusLoadingId === issue.id || workflowStatus === 'draft'}
                        >
                            {statusLoadingId === issue.id && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                            Set Final Status
                        </Button>
                    )}
                </div>
            </div>
        </div>
    )
}

function TimelineEvent({ label, date, tone }: { label: string; date: string | null; tone: 'blue' | 'amber' | 'emerald' | 'red' | 'slate' }) {
    const dot = {
        blue: 'bg-blue-500',
        amber: 'bg-amber-500',
        emerald: 'bg-emerald-500',
        red: 'bg-red-500',
        slate: 'bg-slate-500',
    }[tone]
    return (
        <li className="ml-3">
            <span className={cn('absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-white', dot)} />
            <p className="text-sm font-medium text-slate-800">{label}</p>
            <p className="text-[11px] text-slate-500">{formatDate(date)}</p>
        </li>
    )
}

function IssueEvidenceGallery({ issue }: { issue: Adjustment }) {
    const evidenceItems = issue.proof_images || []
    const [previewIndex, setPreviewIndex] = useState<number | null>(null)
    const [failedImageIndexes, setFailedImageIndexes] = useState<Record<number, boolean>>({})
    const activeReference = previewIndex != null ? evidenceItems[previewIndex] : null
    const activePreviewUrl = previewIndex != null ? buildIssueEvidenceUrl(issue.id, previewIndex) : null

    useEffect(() => {
        setPreviewIndex(null)
        setFailedImageIndexes({})
    }, [issue.id, issue.proof_images])

    return (
        <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                {evidenceItems.map((reference, index) => {
                    const isImage = isImageEvidenceUrl(reference)
                    const proxyUrl = buildIssueEvidenceUrl(issue.id, index)
                    const fileName = getEvidenceFileName(reference)
                    const isBroken = Boolean(failedImageIndexes[index])

                    if (!isImage) {
                        return (
                            <a
                                key={`${reference}-${index}`}
                                href={proxyUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="group overflow-hidden rounded-md border border-slate-200 bg-white hover:border-orange-300"
                            >
                                <div className="flex aspect-[4/3] items-center justify-center overflow-hidden border-b border-slate-200 bg-slate-50">
                                    <FileText className="h-6 w-6 text-slate-400" />
                                </div>
                                <div className="space-y-1 p-2">
                                    <p className="truncate text-[11px] font-medium text-slate-700">{fileName}</p>
                                    <p className="text-[10px] text-slate-500">Open file</p>
                                </div>
                            </a>
                        )
                    }

                    return (
                        <button
                            key={`${reference}-${index}`}
                            type="button"
                            onClick={() => !isBroken && setPreviewIndex(index)}
                            className="group overflow-hidden rounded-md border border-slate-200 bg-white text-left hover:border-orange-300 disabled:cursor-not-allowed"
                            disabled={isBroken}
                        >
                            <div className="flex aspect-[4/3] items-center justify-center overflow-hidden border-b border-slate-200 bg-slate-50">
                                {isBroken ? (
                                    <div className="flex flex-col items-center gap-1 text-slate-400">
                                        <ImageIcon className="h-5 w-5" />
                                        <span className="text-[10px]">Preview unavailable</span>
                                    </div>
                                ) : (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                        src={proxyUrl}
                                        alt={fileName}
                                        className="h-full w-full object-cover transition-transform group-hover:scale-[1.02]"
                                        onError={() => setFailedImageIndexes((current) => ({ ...current, [index]: true }))}
                                    />
                                )}
                            </div>
                            <div className="space-y-1 p-2">
                                <p className="truncate text-[11px] font-medium text-slate-700">{fileName}</p>
                                <p className="text-[10px] text-slate-500">{isBroken ? 'File missing or inaccessible' : 'Open preview'}</p>
                            </div>
                        </button>
                    )
                })}
            </div>

            <Dialog open={previewIndex != null} onOpenChange={(open) => { if (!open) setPreviewIndex(null) }}>
                <DialogContent className="max-w-5xl overflow-hidden p-0">
                    <DialogTitle className="sr-only">Evidence preview</DialogTitle>
                    {activeReference && activePreviewUrl ? (
                        <div className="flex min-h-[320px] flex-col bg-slate-950">
                            <div className="border-b border-slate-800 px-4 py-3 text-sm text-slate-200">{getEvidenceFileName(activeReference)}</div>
                            <div className="flex flex-1 items-center justify-center bg-black/90 p-4">
                                {failedImageIndexes[previewIndex ?? -1] ? (
                                    <div className="text-center text-slate-300">
                                        <p className="text-sm font-medium">Preview unavailable</p>
                                        <p className="mt-1 text-xs text-slate-400">The evidence file may be missing or no longer accessible.</p>
                                    </div>
                                ) : (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                        src={activePreviewUrl}
                                        alt={getEvidenceFileName(activeReference)}
                                        className="max-h-[75vh] max-w-full object-contain"
                                        onError={() => {
                                            if (previewIndex != null) {
                                                setFailedImageIndexes((current) => ({ ...current, [previewIndex]: true }))
                                            }
                                        }}
                                    />
                                )}
                            </div>
                        </div>
                    ) : null}
                </DialogContent>
            </Dialog>
        </>
    )
}

// ─────────────────────── Create Issue Modal ───────────────────────
interface VariantOption {
    id: string
    product_id: string
    product_name: string
    product_code: string | null
    variant_name: string | null
    variant_code: string | null
    manufacturer_sku: string | null
    barcode: string | null
    manufacturer_id: string | null
    manufacturer_name?: string | null
    image_url: string | null
    base_cost: number | null
    attributes?: Record<string, any> | null
}

function formatCurrency(amount?: number | null) {
    const numeric = Number(amount || 0)
    return numeric.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function collectAttributeValues(value: unknown): string[] {
    if (value == null) return []
    if (Array.isArray(value)) return value.flatMap(collectAttributeValues)
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(collectAttributeValues)
    return [String(value)]
}

function getAttributeSummary(attributes?: Record<string, any> | null) {
    const values = Array.from(new Set(collectAttributeValues(attributes).map(v => v.trim()).filter(Boolean)))
    return values.slice(0, 3).join(' • ')
}

function getVariantSkuLabel(variant: VariantOption) {
    return variant.manufacturer_sku || variant.variant_code || variant.product_code || variant.barcode || '—'
}

function buildVariantSearchText(variant: VariantOption) {
    return [
        variant.product_name,
        variant.product_code,
        variant.variant_name,
        variant.variant_code,
        variant.manufacturer_sku,
        variant.barcode,
        variant.manufacturer_name,
        ...collectAttributeValues(variant.attributes),
    ].filter(Boolean).join(' ').toLowerCase()
}

function CreateIssueModal({
    open, onOpenChange, userProfile, issueToEdit, onSaved,
}: {
    open: boolean
    onOpenChange: (v: boolean) => void
    userProfile: UserProfile
    issueToEdit: Adjustment | null
    onSaved: (savedId?: string | null) => void | Promise<void>
}) {
    const supabase = useMemo(() => createClient(), [])
    const isEditing = Boolean(issueToEdit)
    const [reasonCode, setReasonCode] = useState<'quality_issue' | 'return_to_supplier' | 'damaged_goods'>('quality_issue')
    const [allVariants, setAllVariants] = useState<VariantOption[]>([])
    const [selectedProductFilter, setSelectedProductFilter] = useState('all')
    const [variantSearch, setVariantSearch] = useState('')
    const [selectedVariant, setSelectedVariant] = useState<VariantOption | null>(null)
    const [quantity, setQuantity] = useState<string>('1')
    const [unitCost, setUnitCost] = useState<string>('')
    const [notes, setNotes] = useState('')
    const [existingProofImages, setExistingProofImages] = useState<string[]>([])
    const [files, setFiles] = useState<File[]>([])
    const [filePreviews, setFilePreviews] = useState<AttachmentPreview[]>([])
    const [submitting, setSubmitting] = useState(false)
    const [variantLoading, setVariantLoading] = useState(false)
    const [variantLoadError, setVariantLoadError] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    // Reset on close
    useEffect(() => {
        if (!open) {
            setReasonCode('quality_issue'); setVariantSearch(''); setAllVariants([]); setSelectedProductFilter('all')
            setSelectedVariant(null); setQuantity('1'); setUnitCost(''); setNotes('')
            setExistingProofImages([])
            setFiles([]); setError(null); setSubmitting(false)
            setVariantLoading(false); setVariantLoadError(null)
        }
    }, [open])

    useEffect(() => {
        if (!open) return
        if (!issueToEdit) {
            setExistingProofImages([])
            return
        }

        const firstItem = firstIssueItem(issueToEdit)
        setReasonCode((issueToEdit.stock_adjustment_reasons?.reason_code as any) || 'quality_issue')
        setQuantity(String(Math.abs(firstItem?.adjustment_quantity ?? 1) || 1))
        setUnitCost(firstItem?.unit_cost != null ? String(firstItem.unit_cost) : '')
        setNotes(issueToEdit.notes || '')
        setExistingProofImages(issueToEdit.proof_images || [])
    }, [open, issueToEdit])

    useEffect(() => {
        const previews = files.map((file) => ({
            file,
            previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
            isImage: file.type.startsWith('image/'),
        }))

        setFilePreviews(previews)

        return () => {
            previews.forEach((preview) => {
                if (preview.previewUrl) {
                    URL.revokeObjectURL(preview.previewUrl)
                }
            })
        }
    }, [files])

    // Load active variants once when the modal opens, then filter in memory.
    useEffect(() => {
        if (!open) return
        let cancelled = false
        async function loadVariants() {
            setVariantLoading(true)
            setVariantLoadError(null)
            try {
                const { data, error } = await (supabase as any)
                    .from('product_variants')
                    .select('id, product_id, variant_name, variant_code, manufacturer_sku, barcode, base_cost, image_url, attributes, is_active, products!inner(id, product_name, product_code, manufacturer_id)')
                    .eq('is_active', true)
                    .order('variant_name', { ascending: true })

                if (cancelled) return
                if (error) throw error

                const manufacturerIds = Array.from(new Set((data || []).map((variant: any) => variant.products?.manufacturer_id).filter(Boolean))) as string[]
                let manufacturerNames: Record<string, string> = {}
                if (manufacturerIds.length > 0) {
                    const { data: manufacturers, error: manufacturersError } = await (supabase as any)
                        .from('organizations')
                        .select('id, org_name')
                        .in('id', manufacturerIds)
                    if (manufacturersError) throw manufacturersError
                    manufacturerNames = Object.fromEntries((manufacturers || []).map((manufacturer: any) => [manufacturer.id, manufacturer.org_name]))
                }

                const variants: VariantOption[] = (data || []).map((variant: any) => ({
                    id: variant.id,
                    product_id: variant.products.id,
                    product_name: variant.products.product_name,
                    product_code: variant.products.product_code || null,
                    variant_name: variant.variant_name,
                    variant_code: variant.variant_code || null,
                    manufacturer_sku: variant.manufacturer_sku || null,
                    barcode: variant.barcode || null,
                    manufacturer_id: variant.products.manufacturer_id || null,
                    manufacturer_name: variant.products.manufacturer_id ? manufacturerNames[variant.products.manufacturer_id] || null : null,
                    image_url: variant.image_url || null,
                    base_cost: variant.base_cost != null ? Number(variant.base_cost) : null,
                    attributes: variant.attributes || null,
                })).sort((left: VariantOption, right: VariantOption) => {
                    const productCompare = left.product_name.localeCompare(right.product_name)
                    if (productCompare !== 0) return productCompare
                    return (left.variant_name || '').localeCompare(right.variant_name || '')
                })

                setAllVariants(variants)
            } catch (loadError) {
                console.error('Failed to load issue variants', loadError)
                if (!cancelled) {
                    setAllVariants([])
                    setVariantLoadError('Unable to load products right now. Please try again.')
                }
            } finally {
                if (!cancelled) setVariantLoading(false)
            }
        }

        loadVariants()
        return () => { cancelled = true }
    }, [open, supabase])

    useEffect(() => {
        if (!open || !issueToEdit || allVariants.length === 0) return
        const currentVariantId = firstIssueItem(issueToEdit)?.variant_id
        if (!currentVariantId) return
        const match = allVariants.find((variant) => variant.id === currentVariantId) || null
        setSelectedVariant(match)
        if (match) setSelectedProductFilter(match.product_id)
    }, [open, issueToEdit, allVariants])

    const productOptions = useMemo(() => {
        const counts = new Map<string, { id: string; name: string; count: number }>()
        allVariants.forEach((variant) => {
            const current = counts.get(variant.product_id)
            if (current) {
                current.count += 1
            } else {
                counts.set(variant.product_id, {
                    id: variant.product_id,
                    name: variant.product_name,
                    count: 1,
                })
            }
        })
        return Array.from(counts.values()).sort((left, right) => left.name.localeCompare(right.name))
    }, [allVariants])

    const filteredVariantOptions = useMemo(() => {
        const searchLower = variantSearch.trim().toLowerCase()
        return allVariants.filter((variant) => {
            if (selectedProductFilter !== 'all' && variant.product_id !== selectedProductFilter) return false
            if (!searchLower) return true
            return buildVariantSearchText(variant).includes(searchLower)
        })
    }, [allVariants, selectedProductFilter, variantSearch])

    function addFiles(list: FileList | null) {
        if (!list) return
        const arr: File[] = []
        for (let i = 0; i < list.length; i++) arr.push(list.item(i)!)
        setFiles(prev => [...prev, ...arr])
    }
    function removeFile(idx: number) { setFiles(prev => prev.filter((_, i) => i !== idx)) }
    function removeExistingProofImage(idx: number) { setExistingProofImages(prev => prev.filter((_, i) => i !== idx)) }

    async function uploadEvidence(): Promise<string[]> {
        if (files.length === 0) return []
        const urls: string[] = []
        for (const f of files) {
            const form = new FormData()
            form.set('file', f)
            const response = await fetch('/api/manufacturer/adjustments/evidence', {
                method: 'POST',
                body: form,
            })
            const body = await response.json().catch(() => null)
            if (!response.ok || !body?.path) {
                throw new Error(body?.error || 'Unable to upload evidence')
            }
            urls.push(body.path)
        }
        return urls
    }

    async function submit() {
        setError(null)
        if (!selectedVariant) { setError('Please select a product variant'); return }
        const qty = Number(quantity)
        if (!qty || qty <= 0) { setError('Quantity affected must be greater than 0'); return }
        if (!notes.trim()) { setError('Please describe the issue'); return }
        if (existingProofImages.length + files.length === 0) { setError('At least one evidence attachment is required'); return }
        setSubmitting(true)
        try {
            const proofImages = await uploadEvidence()
            const combinedProofImages = [...existingProofImages, ...proofImages]
            const endpoint = isEditing && issueToEdit ? `/api/manufacturer/adjustments/${issueToEdit.id}` : '/api/manufacturer/adjustments/create'
            const method = isEditing ? 'PATCH' : 'POST'
            const resp = await fetch(endpoint, {
                method,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    reason_code: reasonCode,
                    variant_id: selectedVariant.id,
                    target_manufacturer_org_id: selectedVariant.manufacturer_id,
                    quantity_affected: qty,
                    unit_cost: unitCost ? Number(unitCost) : null,
                    notes: notes.trim(),
                    proof_images: combinedProofImages,
                }),
            })
            const json = await resp.json()
            if (!resp.ok) { setError(json.error || 'Unable to save the issue right now'); return }
            await onSaved(issueToEdit?.id || json?.data?.id || null)
        } catch (e: any) {
            setError(e?.message || 'Unable to save the issue right now')
        } finally { setSubmitting(false) }
    }

    const totalAttachments = existingProofImages.length + files.length

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{isEditing ? 'Edit Draft Issue' : 'Create Issue'}</DialogTitle>
                    <DialogDescription>
                        {isEditing
                            ? 'Update the draft before sending it to the manufacturer.'
                            : 'Log a new quality or return-to-supplier case. The manufacturer will only be notified after you send the draft.'}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    {/* Issue type */}
                    <div>
                        <label className="text-xs font-medium text-slate-700">Issue Type</label>
                        <Select value={reasonCode} onValueChange={(v: any) => setReasonCode(v)}>
                            <SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="quality_issue">Quality Issue</SelectItem>
                                <SelectItem value="return_to_supplier">Return to Supplier</SelectItem>
                                <SelectItem value="damaged_goods">Damaged Goods</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    {/* Product picker */}
                    <div className="space-y-3">
                        <div>
                            <label className="text-xs font-medium text-slate-700">Filter by Product</label>
                            <Select value={selectedProductFilter} onValueChange={setSelectedProductFilter}>
                                <SelectTrigger className="mt-1 h-9">
                                    <SelectValue placeholder="Choose a product" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Products ({allVariants.length})</SelectItem>
                                    {productOptions.map((product) => (
                                        <SelectItem key={product.id} value={product.id}>
                                            {product.name} ({product.count})
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div>
                            <label className="text-xs font-medium text-slate-700">Search Variant</label>
                            <div className="relative mt-1">
                                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                                <Input
                                    placeholder="Search by product, variant, SKU, or attributes…"
                                    value={variantSearch}
                                    onChange={(event) => setVariantSearch(event.target.value)}
                                    className="h-9 pl-8"
                                />
                            </div>
                            <p className="mt-1 text-[11px] text-slate-500">
                                {filteredVariantOptions.length} of {allVariants.length} active variants available
                            </p>
                        </div>

                        <div>
                            <label className="text-xs font-medium text-slate-700">Select Variant *</label>
                            <div className="mt-1 overflow-hidden rounded-md border border-slate-200 bg-white">
                                {variantLoading ? (
                                    <div className="flex items-center gap-2 p-3 text-xs text-slate-500">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />Loading active variants…
                                    </div>
                                ) : variantLoadError ? (
                                    <div className="flex items-start gap-2 p-3 text-xs text-red-700 bg-red-50/70">
                                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />{variantLoadError}
                                    </div>
                                ) : filteredVariantOptions.length === 0 ? (
                                    <div className="p-3 text-xs text-slate-500">
                                        No variants match the current product filter or search.
                                    </div>
                                ) : (
                                    <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
                                        {filteredVariantOptions.map((variant) => {
                                            const attributeSummary = getAttributeSummary(variant.attributes)
                                            const isSelected = selectedVariant?.id === variant.id
                                            return (
                                                <button
                                                    key={variant.id}
                                                    type="button"
                                                    onClick={() => { setSelectedVariant(variant); setError(null) }}
                                                    className={cn(
                                                        'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
                                                        isSelected ? 'bg-orange-50' : 'hover:bg-slate-50',
                                                    )}
                                                >
                                                    <SafeImage
                                                        src={variant.image_url}
                                                        alt={variant.product_name}
                                                        className="h-10 w-10 flex-shrink-0 rounded-md border border-slate-200 object-cover"
                                                        fallbackClassName="h-10 w-10 flex-shrink-0 rounded-md border border-slate-200 bg-slate-50"
                                                    />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="truncate text-sm font-medium text-slate-900">{variant.product_name}</p>
                                                        <p className="truncate text-xs text-slate-600">
                                                            {variant.variant_name || 'Standard variant'}
                                                            {attributeSummary ? ` · ${attributeSummary}` : ''}
                                                        </p>
                                                        <p className="truncate text-[11px] text-slate-500">
                                                            SKU {getVariantSkuLabel(variant)}
                                                            {variant.manufacturer_name ? ` · ${variant.manufacturer_name}` : ''}
                                                        </p>
                                                    </div>
                                                    <div className="flex-shrink-0 text-right">
                                                        {variant.base_cost != null && (
                                                            <p className="text-xs font-semibold text-slate-900">RM {formatCurrency(variant.base_cost)}</p>
                                                        )}
                                                        <p className={cn('text-[11px] font-medium', isSelected ? 'text-orange-700' : 'text-slate-400')}>
                                                            {isSelected ? 'Selected' : 'Select'}
                                                        </p>
                                                    </div>
                                                </button>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>

                        {selectedVariant && (
                            <div className="rounded-md border border-orange-200 bg-orange-50/70 p-3">
                                <div className="flex items-start gap-3">
                                    <SafeImage
                                        src={selectedVariant.image_url}
                                        alt={selectedVariant.product_name}
                                        className="h-16 w-16 flex-shrink-0 rounded-md border border-orange-200 object-cover"
                                        fallbackClassName="h-16 w-16 flex-shrink-0 rounded-md border border-orange-200 bg-white"
                                        fallbackIconClassName="h-5 w-5 text-slate-300"
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-700">Selected Product</p>
                                        <p className="truncate text-sm font-semibold text-slate-900">{selectedVariant.product_name}</p>
                                        <p className="truncate text-xs text-slate-600">
                                            {selectedVariant.variant_name || 'Standard variant'}
                                            {getAttributeSummary(selectedVariant.attributes) ? ` · ${getAttributeSummary(selectedVariant.attributes)}` : ''}
                                        </p>
                                        <p className="truncate text-[11px] text-slate-500">
                                            SKU {getVariantSkuLabel(selectedVariant)}
                                            {selectedVariant.manufacturer_name ? ` • Manufacturer: ${selectedVariant.manufacturer_name}` : ''}
                                        </p>
                                        {selectedVariant.base_cost != null && (
                                            <p className="mt-1 text-[11px] text-slate-500">Base cost: RM {formatCurrency(selectedVariant.base_cost)}</p>
                                        )}
                                    </div>
                                    <Button variant="ghost" size="sm" type="button" onClick={() => setSelectedVariant(null)}>
                                        <X className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="text-xs font-medium text-slate-700">Quantity Affected *</label>
                            <Input type="number" min={1} value={quantity} onChange={e => setQuantity(e.target.value)} className="mt-1 h-9" />
                        </div>
                        <div>
                            <label className="text-xs font-medium text-slate-700">Unit Cost (optional)</label>
                            <Input type="number" step="0.01" min={0} value={unitCost} onChange={e => setUnitCost(e.target.value)} placeholder="0.00" className="mt-1 h-9" />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-medium text-slate-700">Description / Notes *</label>
                        <textarea
                            value={notes}
                            onChange={e => setNotes(e.target.value)}
                            placeholder="Describe the defect or reason for return…"
                            className="mt-1 w-full h-24 rounded-md border border-slate-200 p-2 text-sm"
                        />
                    </div>

                    <div>
                        <label className="text-xs font-medium text-slate-700">Evidence Attachments</label>
                        <div className="mt-1 flex items-center gap-2">
                            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 bg-white hover:bg-slate-50 cursor-pointer text-xs font-medium text-slate-700">
                                <Upload className="h-3.5 w-3.5" />Upload
                                <input type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={e => addFiles(e.target.files)} />
                            </label>
                            <span className="text-[11px] text-slate-500">{totalAttachments} file{totalAttachments === 1 ? '' : 's'} attached</span>
                            <span className="text-[11px] text-orange-600">Required</span>
                        </div>
                        {existingProofImages.length > 0 && (
                            <ul className="mt-2 grid grid-cols-3 gap-2">
                                {existingProofImages.map((url, index) => {
                                    const authorizedUrl = issueToEdit ? buildIssueEvidenceUrl(issueToEdit.id, index) : '#'
                                    return (
                                    <li key={`${url}-${index}`} className="relative overflow-hidden rounded-md border border-slate-200 bg-white">
                                        <button type="button" onClick={() => removeExistingProofImage(index)} className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/70 text-white">
                                            <X className="h-2.5 w-2.5" />
                                        </button>
                                        <a href={authorizedUrl} target="_blank" rel="noreferrer" className="block">
                                            <div className="flex aspect-[4/3] items-center justify-center overflow-hidden border-b border-slate-200 bg-slate-50">
                                                {isImageEvidenceUrl(url) ? (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img src={authorizedUrl} alt={getEvidenceFileName(url)} className="h-full w-full object-cover" />
                                                ) : (
                                                    <FileText className="h-5 w-5 text-slate-400" />
                                                )}
                                            </div>
                                            <div className="space-y-1 p-2">
                                                <div className="truncate text-[11px] font-medium text-slate-700">{getEvidenceFileName(url)}</div>
                                                <div className="text-[10px] text-slate-500">Saved attachment</div>
                                            </div>
                                        </a>
                                    </li>
                                    )
                                })}
                            </ul>
                        )}
                        {files.length > 0 && (
                            <ul className="mt-2 grid grid-cols-3 gap-2">
                                {filePreviews.map((preview, i) => (
                                    <li key={`${preview.file.name}-${i}`} className="relative overflow-hidden rounded-md border border-slate-200 bg-white">
                                        <button type="button" onClick={() => removeFile(i)} className="absolute right-1 top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/70 text-white">
                                            <X className="h-2.5 w-2.5" />
                                        </button>
                                        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden border-b border-slate-200 bg-slate-50">
                                            {preview.isImage && preview.previewUrl ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={preview.previewUrl} alt={preview.file.name} className="h-full w-full object-cover" />
                                            ) : (
                                                <div className="flex h-full w-full items-center justify-center px-2 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                                    {preview.file.name.split('.').pop() || 'file'}
                                                </div>
                                            )}
                                        </div>
                                        <div className="space-y-1 p-2">
                                            <div className="truncate text-[11px] font-medium text-slate-700">{preview.file.name}</div>
                                            <div className="text-[10px] text-slate-500">
                                                {preview.isImage ? 'Image preview ready' : 'Document attached'}
                                            </div>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    {error && (
                        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700 flex items-start gap-1.5">
                            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />{error}
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
                    <Button onClick={submit} disabled={submitting} className="bg-orange-600 hover:bg-orange-700 text-white">
                        {submitting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
                        {isEditing ? 'Save Draft' : 'Create Draft'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
