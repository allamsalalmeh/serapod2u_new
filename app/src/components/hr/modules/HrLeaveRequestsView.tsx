'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import {
    Plus,
    Search,
    Filter,
    CheckCircle2,
    XCircle,
    Clock,
    CalendarDays,
    FileText,
    ChevronDown,
    X,
    Ban,
    Eye,
    RefreshCw,
    User,
    AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import HrLeaveBalancesPanel from './HrLeaveBalancesPanel'
import { Switch } from '@/components/ui/switch'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { useToast } from '@/components/ui/use-toast'
import { getLeaveRepositoryForOrg } from '@/modules/hr/leave/repository'
import { SupabaseLeaveRepository } from '@/modules/hr/leave/supabaseRepository'
import { LEAVE_STEP_NOT_RECORDED, leaveErrorMessage } from '@/modules/hr/leave/leaveErrors'
import {
    formatDate,
    formatDateRange,
    formatDuration,
    timeAgo,
    calculateBusinessDays,
    todayISO,
} from '@/modules/hr/leave/utils'
import type {
    LeaveRequest,
    LeaveRequestStatus,
    LeaveType,
    LeaveBalance,
    PublicHoliday,
    HalfDayPeriod,
} from '@/modules/hr/leave/types'

// ── Status config ───────────────────────────────────────────────

const STATUS_CONFIG: Record<LeaveRequestStatus, { label: string; color: string; icon: typeof Clock }> = {
    draft: { label: 'Draft', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300', icon: FileText },
    pending: { label: 'Pending', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', icon: Clock },
    approved: { label: 'Approved', color: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300', icon: CheckCircle2 },
    rejected: { label: 'Rejected', color: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', icon: XCircle },
    cancelled: { label: 'Cancelled', color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', icon: XCircle },
}

function statusBadge(status: LeaveRequestStatus) {
    // Historical rows can carry a legacy status value (frozen by the B2A guard, reported by hr_leave_containment_review).
    const cfg = STATUS_CONFIG[status] ?? { label: String(status || 'Unknown'), color: STATUS_CONFIG.draft.color, icon: AlertCircle }
    const Icon = cfg.icon
    return (
        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium', cfg.color)}>
            <Icon className="h-3 w-3" />
            {cfg.label}
        </span>
    )
}

function initials(name: string) {
    return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
}

/** Server leave quote (Wave 3 ledger): working days by the database calendar, balance after, blocking errors. */
interface LeaveQuote {
    working_days: number
    warnings: string[]
    errors: string[]
    non_working_dates: { date: string; day_type: string }[]
    per_year: { year: number; days: number; available_after: number; balance: { has_entitlement: boolean; available: number } }[]
}

type ConfirmAction = 'approve' | 'reject' | 'cancel' | 'withdraw'
const CONFIRM_COPY: Record<ConfirmAction, { title: string; hint: string; button: string; done: string }> = {
    approve: { title: 'Approve request', hint: 'Add an optional comment. The leave is posted to the balance ledger.', button: 'Approve', done: 'Leave approved' },
    reject: { title: 'Reject request', hint: 'Add a comment so the employee knows why.', button: 'Reject', done: 'Leave rejected' },
    cancel: { title: 'Cancel approved leave (HR)', hint: 'Only HR can cancel approved leave. The days are returned to the balance; the original approval stays in the history.', button: 'Cancel leave', done: 'Approved leave cancelled' },
    withdraw: { title: 'Withdraw my request', hint: 'The request is cancelled before anyone decides it.', button: 'Withdraw', done: 'Request withdrawn' },
}

// ── Component ───────────────────────────────────────────────────

export default function HrLeaveRequestsView({
    organizationId,
    userId,
}: {
    organizationId?: string
    userId?: string
}) {
    const repo = useMemo(() => {
        if (organizationId && userId) {
            return new SupabaseLeaveRepository(organizationId, userId)
        }
        return getLeaveRepositoryForOrg(null, null)
    }, [organizationId, userId])
    const { toast } = useToast()
    const searchParams = useSearchParams()
    const [section, setSection] = useState<'requests' | 'balances'>(searchParams?.get('tab') === 'balances' ? 'balances' : 'requests')
    useEffect(() => { setSection(searchParams?.get('tab') === 'balances' ? 'balances' : 'requests') }, [searchParams])

    // Data
    const [requests, setRequests] = useState<LeaveRequest[]>([])
    const [leaveTypes, setLeaveTypes] = useState<LeaveType[]>([])
    const [balances, setBalances] = useState<LeaveBalance[]>([])
    const [holidays, setHolidays] = useState<PublicHoliday[]>([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)

    // UI State
    const [activeTab, setActiveTab] = useState<'my' | 'team' | 'all'>('all')
    const [statusFilter, setStatusFilter] = useState<LeaveRequestStatus | 'all'>('all')
    const [typeFilter, setTypeFilter] = useState<string>('all')
    const [searchQuery, setSearchQuery] = useState('')
    const [dialogOpen, setDialogOpen] = useState(false)
    const [detailRequest, setDetailRequest] = useState<LeaveRequest | null>(null)
    const [approveConfirm, setApproveConfirm] = useState<{ id: string; action: ConfirmAction } | null>(null)
    const [approveComment, setApproveComment] = useState('')

    // Form
    const [formLeaveType, setFormLeaveType] = useState('')
    const [formStartDate, setFormStartDate] = useState('')
    const [formEndDate, setFormEndDate] = useState('')
    const [formIsHalfDay, setFormIsHalfDay] = useState(false)
    const [formHalfDayPeriod, setFormHalfDayPeriod] = useState<HalfDayPeriod>('morning')
    const [formReason, setFormReason] = useState('')
    const [saving, setSaving] = useState(false)

    // ── Load data ────────────────────────────────────────────────

    const loadData = useCallback(async () => {
        setLoading(true)
        try {
            const [reqs, types, bals, hols] = await Promise.all([
                repo.getLeaveRequests({ scope: activeTab }),
                repo.getLeaveTypes(),
                repo.getLeaveBalances(userId || ''),
                repo.getPublicHolidays(new Date().getFullYear()),
            ])
            setRequests(reqs)
            setLeaveTypes(types)
            setBalances(bals)
            setHolidays(hols)
            setLoadError(null)
        } catch (e) {
            console.error('Failed to load leave requests', e)
            setLoadError(leaveErrorMessage(e, 'Leave requests could not be loaded.'))
        } finally {
            setLoading(false)
        }
    }, [repo, activeTab])

    useEffect(() => { loadData() }, [loadData])

    // ── Computed duration ────────────────────────────────────────

    const computedDuration = useMemo(() => {
        if (!formStartDate || !formEndDate) return 0
        return calculateBusinessDays(formStartDate, formEndDate, holidays, formIsHalfDay)
    }, [formStartDate, formEndDate, holidays, formIsHalfDay])

    // The database quote (policy workdays, national + work-state holidays, balance). The local count is only a fallback
    // while the quote is loading or unavailable; the database recalculates the days on submission either way.
    const [quote, setQuote] = useState<LeaveQuote | null>(null)
    const quoteSeq = useRef(0)
    useEffect(() => {
        if (!dialogOpen || !formLeaveType || !formStartDate || !formEndDate || formEndDate < formStartDate || (formIsHalfDay && formStartDate !== formEndDate)) { setQuote(null); return }
        const seq = ++quoteSeq.current
        const params = new URLSearchParams({ leave_type_id: formLeaveType, start_date: formStartDate, end_date: formEndDate, ...(formIsHalfDay ? { half_day: '1' } : {}) })
        const timer = setTimeout(async () => {
            try {
                const res = await fetch(`/api/hr/leave/quote?${params.toString()}`)
                const json = await res.json().catch(() => null)
                if (seq === quoteSeq.current) setQuote(res.ok && json?.success ? (json.data as LeaveQuote) : null)
            } catch {
                if (seq === quoteSeq.current) setQuote(null)
            }
        }, 300)
        return () => clearTimeout(timer)
    }, [dialogOpen, formLeaveType, formStartDate, formEndDate, formIsHalfDay])
    const quoteBlocked = !!quote && quote.errors.length > 0

    // ── Selected leave type balance ──────────────────────────────

    const selectedBalance = useMemo(() => {
        if (!formLeaveType) return null
        return balances.find((b) => b.leaveTypeId === formLeaveType) ?? null
    }, [formLeaveType, balances])

    // ── Filtered requests ────────────────────────────────────────

    const filtered = useMemo(() => {
        let result = requests
        if (statusFilter !== 'all') result = result.filter((r) => r.status === statusFilter)
        if (typeFilter !== 'all') result = result.filter((r) => r.leaveTypeId === typeFilter)
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase()
            result = result.filter(
                (r) =>
                    r.employeeName.toLowerCase().includes(q) ||
                    r.leaveTypeName.toLowerCase().includes(q) ||
                    r.reason.toLowerCase().includes(q)
            )
        }
        return result
    }, [requests, statusFilter, typeFilter, searchQuery])

    // ── Stats ────────────────────────────────────────────────────

    const pendingCount = requests.filter((r) => r.status === 'pending').length
    const approvedThisMonth = requests.filter((r) => {
        if (r.status !== 'approved') return false
        const d = new Date(r.updatedAt)
        const now = new Date()
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    }).length

    // ── Handlers ─────────────────────────────────────────────────

    function openCreate() {
        setFormLeaveType(leaveTypes[0]?.id ?? '')
        setFormStartDate('')
        setFormEndDate('')
        setFormIsHalfDay(false)
        setFormHalfDayPeriod('morning')
        setFormReason('')
        setQuote(null)
        setDialogOpen(true)
    }

    async function handleSubmit() {
        if (!formLeaveType || !formStartDate || !formEndDate || !formReason) return
        setSaving(true)
        try {
            const lt = leaveTypes.find((t) => t.id === formLeaveType)
            await repo.createLeaveRequest({
                employeeId: userId || '',
                employeeName: '',
                employeeAvatar: null,
                departmentId: '',
                departmentName: '',
                leaveTypeId: formLeaveType,
                leaveTypeName: lt?.name ?? '',
                leaveTypeColor: lt?.color ?? '#3b82f6',
                startDate: formStartDate,
                endDate: formEndDate,
                totalDays: quote?.working_days ?? computedDuration,
                isHalfDay: formIsHalfDay,
                halfDayPeriod: formIsHalfDay ? formHalfDayPeriod : null,
                reason: formReason,
                attachmentUrl: null,
            })
            setDialogOpen(false)
            toast({ title: 'Leave request submitted', description: 'Your request is pending approval.' })
            await loadData()
        } catch (e) {
            console.error('Failed to create leave request', e)
            toast({ title: 'Leave request not submitted', description: leaveErrorMessage(e, 'Failed to create leave request'), variant: 'destructive' })
        } finally {
            setSaving(false)
        }
    }

    async function handleApproveReject() {
        if (!approveConfirm || saving) return
        const action = approveConfirm.action
        const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled'
        setSaving(true)
        try {
            // The repository throws when the database refuses the decision or row-level security hides the row,
            // and returns the request as stored: success is shown only for the status the database actually holds.
            const saved = await repo.updateLeaveRequestStatus(approveConfirm.id, status as LeaveRequestStatus, approveComment || undefined)
            if (saved.status !== status) throw new Error('The decision was not saved.')
            toast({
                title: CONFIRM_COPY[action].done,
                description: saved.approvalStepRecorded === false ? LEAVE_STEP_NOT_RECORDED : undefined,
            })
            setApproveConfirm(null)
            setApproveComment('')
        } catch (e) {
            toast({ title: action === 'withdraw' ? 'Request not withdrawn' : action === 'cancel' ? 'Leave not cancelled' : 'Decision not saved', description: leaveErrorMessage(e, 'The decision could not be saved.'), variant: 'destructive' })
        } finally {
            setSaving(false)
        }
        await loadData()
    }

    // ── Render ───────────────────────────────────────────────────

    return (
        <div className="w-full space-y-6">
            {/* ── Header ─────────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                    <h1 className="text-lg font-semibold tracking-tight">Leave Requests &amp; Approvals</h1>
                    <p className="text-sm text-muted-foreground mt-1">Decide pending requests, cancel approved leave and manage balances. Employees apply from My Leave.</p>
                </div>
                {section === 'requests' && (
                    <Button onClick={openCreate} className="gap-2">
                        <Plus className="h-4 w-4" />
                        New Request
                    </Button>
                )}
            </div>

            <Tabs value={section} onValueChange={(v) => setSection(v as 'requests' | 'balances')}>
                <TabsList>
                    <TabsTrigger value="requests">Requests &amp; approvals{pendingCount > 0 ? ` (${pendingCount})` : ''}</TabsTrigger>
                    <TabsTrigger value="balances">Balances &amp; entitlements</TabsTrigger>
                </TabsList>
                {/* Wave 3 leave ledger: HR balance administration (the page is gated by explicit HR leave authority;
                    the database decides each change). Mounted only on its tab, so it loads only when opened. */}
                <TabsContent value="balances" className="mt-4">
                    {section === 'balances' && <HrLeaveBalancesPanel />}
                </TabsContent>
            </Tabs>

            {section === 'requests' && (<>
            {loadError && (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    <span className="min-w-0">{loadError}</span>
                    <Button size="sm" variant="outline" onClick={() => void loadData()}><RefreshCw className="h-4 w-4 mr-1" />Try again</Button>
                </div>
            )}

            {/* ── Balance Cards ───────────────────────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {balances.slice(0, 4).map((b) => (
                    <Card key={b.leaveTypeId}>
                        <CardContent className="p-3">
                            <div className="flex items-center gap-2 mb-2">
                                <div className="h-2 w-2 rounded-full" style={{ backgroundColor: b.leaveTypeColor }} />
                                <span className="text-xs font-medium truncate">{b.leaveTypeName}</span>
                            </div>
                            <div className="flex items-baseline gap-1">
                                <span className="text-xl font-bold">{b.remaining}</span>
                                <span className="text-xs text-muted-foreground">/ {b.entitled}</span>
                            </div>
                            <div className="flex gap-2 mt-1 text-[10px] text-muted-foreground">
                                <span>Taken: {b.taken}</span>
                                {b.pending > 0 && <span className="text-amber-600">Pending: {b.pending}</span>}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {/* ── Tabs + Filters ──────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'my' | 'team' | 'all')} className="flex-1">
                    <TabsList>
                        <TabsTrigger value="my">My Requests</TabsTrigger>
                        <TabsTrigger value="team">Team</TabsTrigger>
                        <TabsTrigger value="all">All Requests</TabsTrigger>
                    </TabsList>
                </Tabs>
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                        <input
                            className="h-8 rounded-md border bg-background pl-8 pr-3 text-sm w-48"
                            placeholder="Search…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </div>
                    <select className="h-8 rounded-md border bg-background px-2 text-xs" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as LeaveRequestStatus | 'all')}>
                        <option value="all">All Status</option>
                        <option value="pending">Pending</option>
                        <option value="approved">Approved</option>
                        <option value="rejected">Rejected</option>
                        <option value="cancelled">Cancelled</option>
                    </select>
                    <select className="h-8 rounded-md border bg-background px-2 text-xs" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                        <option value="all">All Types</option>
                        {leaveTypes.filter((t) => t.status === 'active').map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* ── Stats row ──────────────────────────────────────── */}
            <div className="flex items-center gap-4 text-sm">
                {pendingCount > 0 && (
                    <button type="button" onClick={() => setStatusFilter('pending')} className="flex items-center gap-1.5 text-amber-600 hover:underline">
                        <Clock className="h-4 w-4" />
                        <strong>{pendingCount}</strong> pending approval
                    </button>
                )}
                <span className="flex items-center gap-1.5 text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    <strong>{approvedThisMonth}</strong> approved this month
                </span>
                <span className="text-muted-foreground">
                    {filtered.length} request{filtered.length !== 1 ? 's' : ''} shown
                </span>
            </div>

            {/* ── Requests List ───────────────────────────────────── */}
            {loading ? (
                <div className="space-y-3">
                    {[1, 2, 3].map((i) => <div key={i} className="h-20 rounded-lg border bg-card animate-pulse" />)}
                </div>
            ) : filtered.length === 0 ? (
                <div className="text-center py-16">
                    <CalendarDays className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
                    <p className="text-muted-foreground">{loadError ? 'Leave requests could not be loaded.' : 'No leave requests found'}</p>
                    {!loadError && leaveTypes.filter((t) => t.status === 'active').length === 0 && (
                        <p className="text-xs text-muted-foreground mt-2">No active leave types yet — create them under Leave Management → Leave Types.</p>
                    )}
                </div>
            ) : (
                <div className="space-y-2">
                    {filtered.map((req) => (
                        <Card key={req.id} className="group hover:shadow-sm transition-shadow">
                            <CardContent className="p-4">
                                <div className="flex items-start gap-3">
                                    {/* Avatar */}
                                    <Avatar className="h-9 w-9 shrink-0">
                                        <AvatarFallback className="text-xs bg-muted">{initials(req.employeeName)}</AvatarFallback>
                                    </Avatar>

                                    {/* Main info */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-medium text-sm">{req.employeeName}</span>
                                            <span className="text-xs text-muted-foreground">•</span>
                                            <span className="text-xs text-muted-foreground">{req.departmentName}</span>
                                        </div>
                                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                                            <span
                                                className="inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded"
                                                style={{ backgroundColor: req.leaveTypeColor + '18', color: req.leaveTypeColor }}
                                            >
                                                <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: req.leaveTypeColor }} />
                                                {req.leaveTypeName}
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                                {formatDateRange(req.startDate, req.endDate)}
                                            </span>
                                            <span className="text-xs font-medium">
                                                {formatDuration(req.totalDays)}
                                                {req.isHalfDay && req.halfDayPeriod && (
                                                    <span className="text-muted-foreground font-normal"> ({req.halfDayPeriod})</span>
                                                )}
                                            </span>
                                        </div>
                                        {req.reason && (
                                            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{req.reason}</p>
                                        )}

                                        {/* Approval trail */}
                                        {req.approvals.length > 0 && (
                                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                                                {req.approvals.map((ap, i) => (
                                                    <span key={ap.id} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                                        {i > 0 && <span className="mx-0.5">→</span>}
                                                        <User className="h-2.5 w-2.5" />
                                                        <span>{ap.approverName}</span>
                                                        {ap.action === 'approve' && <CheckCircle2 className="h-2.5 w-2.5 text-green-500" />}
                                                        {ap.action === 'reject' && <XCircle className="h-2.5 w-2.5 text-red-500" />}
                                                        {ap.action === null && <Clock className="h-2.5 w-2.5 text-amber-500" />}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Right side */}
                                    <div className="flex flex-col items-end gap-2 shrink-0">
                                        {statusBadge(req.status)}
                                        <span className="text-[10px] text-muted-foreground">{timeAgo(req.createdAt)}</span>

                                        {/* Actions for pending requests (never on the viewer's own request: no self-approval) */}
                                        {req.status === 'pending' && req.employeeId !== userId && (
                                            <div className="flex gap-1">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-6 text-[10px] px-2 text-green-600 border-green-200 hover:bg-green-50"
                                                    onClick={() => setApproveConfirm({ id: req.id, action: 'approve' })}
                                                >
                                                    Approve
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="h-6 text-[10px] px-2 text-red-600 border-red-200 hover:bg-red-50"
                                                    onClick={() => setApproveConfirm({ id: req.id, action: 'reject' })}
                                                >
                                                    Reject
                                                </Button>
                                            </div>
                                        )}

                                        {/* Own request still undecided: the employee may withdraw it (B2A SELF rule). */}
                                        {(req.status === 'pending' || req.status === 'draft') && req.employeeId === userId && (
                                            <Button variant="outline" size="sm" className="h-6 text-[10px] px-2" onClick={() => setApproveConfirm({ id: req.id, action: 'withdraw' })}>
                                                Withdraw
                                            </Button>
                                        )}
                                        {/* Approved leave of someone else: only HR may cancel it (the database decides). */}
                                        {req.status === 'approved' && req.employeeId !== userId && (
                                            <Button variant="outline" size="sm" className="h-6 text-[10px] px-2 text-red-600 border-red-200 hover:bg-red-50" onClick={() => setApproveConfirm({ id: req.id, action: 'cancel' })}>
                                                <Ban className="h-3 w-3 mr-1" />Cancel leave
                                            </Button>
                                        )}

                                        {req.attachmentUrl && (
                                            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                                                <FileText className="h-2.5 w-2.5" /> Attachment
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}
            </>)}

            {/* ── Approve / Reject / Cancel / Withdraw Dialog ─────── */}
            {approveConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
                    <div className="bg-popover rounded-lg border shadow-lg p-6 max-w-sm w-full mx-4">
                        <div className="flex items-center gap-3 mb-4">
                            <div className={cn(
                                'h-10 w-10 rounded-full flex items-center justify-center',
                                approveConfirm.action === 'approve' ? 'bg-green-100' : approveConfirm.action === 'withdraw' ? 'bg-muted' : 'bg-red-100'
                            )}>
                                {approveConfirm.action === 'approve'
                                    ? <CheckCircle2 className="h-5 w-5 text-green-600" />
                                    : <XCircle className="h-5 w-5 text-red-600" />}
                            </div>
                            <div>
                                <h3 className="font-semibold">{CONFIRM_COPY[approveConfirm.action].title}</h3>
                                <p className="text-sm text-muted-foreground">{CONFIRM_COPY[approveConfirm.action].hint}</p>
                            </div>
                        </div>
                        {(approveConfirm.action === 'approve' || approveConfirm.action === 'reject') ? (
                            <textarea
                                className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none mb-4"
                                rows={3}
                                placeholder="Comment (optional)…"
                                value={approveComment}
                                onChange={(e) => setApproveComment(e.target.value)}
                            />
                        ) : <div className="mb-4" />}
                        <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={() => { setApproveConfirm(null); setApproveComment('') }}>Back</Button>
                            <Button
                                size="sm"
                                className={approveConfirm.action === 'approve' ? 'bg-green-600 hover:bg-green-700' : approveConfirm.action === 'withdraw' ? '' : 'bg-red-600 hover:bg-red-700'}
                                disabled={saving}
                                onClick={handleApproveReject}
                            >
                                {CONFIRM_COPY[approveConfirm.action].button}
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── New Request Dialog ──────────────────────────────── */}
            {dialogOpen && (
                <div className="fixed inset-0 z-50 flex items-start justify-center pt-[5vh] bg-black/40 overflow-y-auto pb-10">
                    <div className="bg-popover rounded-lg border shadow-xl w-full max-w-lg mx-4">
                        <div className="flex items-center justify-between px-6 py-4 border-b">
                            <h2 className="text-lg font-semibold">New Leave Request</h2>
                            <button onClick={() => setDialogOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
                        </div>

                        <div className="px-6 py-5 space-y-4">
                            {/* Leave type */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium">Leave Type *</label>
                                <select
                                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                                    value={formLeaveType}
                                    onChange={(e) => setFormLeaveType(e.target.value)}
                                >
                                    <option value="">Select leave type…</option>
                                    {leaveTypes.filter((t) => t.status === 'active').map((t) => (
                                        <option key={t.id} value={t.id}>{t.name} ({t.code})</option>
                                    ))}
                                </select>
                                {selectedBalance && (
                                    <p className="text-xs text-muted-foreground">
                                        Balance: <strong>{selectedBalance.remaining}</strong> / {selectedBalance.entitled} days remaining
                                        {selectedBalance.pending > 0 && <span className="text-amber-600"> ({selectedBalance.pending} pending)</span>}
                                    </p>
                                )}
                            </div>

                            {/* Date range */}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium">Start Date *</label>
                                    <input type="date" className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={formStartDate} onChange={(e) => { setFormStartDate(e.target.value); if (!formEndDate) setFormEndDate(e.target.value) }} min={todayISO()} />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-sm font-medium">End Date *</label>
                                    <input type="date" className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={formEndDate} onChange={(e) => setFormEndDate(e.target.value)} min={formStartDate || todayISO()} />
                                </div>
                            </div>

                            {/* Half day */}
                            <div className="flex items-center gap-4">
                                <label className="flex items-center gap-2">
                                    <Switch checked={formIsHalfDay} onCheckedChange={setFormIsHalfDay} />
                                    <span className="text-sm">Half day</span>
                                </label>
                                {formIsHalfDay && (
                                    <select className="rounded-md border bg-background px-2 py-1 text-sm" value={formHalfDayPeriod} onChange={(e) => setFormHalfDayPeriod(e.target.value as HalfDayPeriod)}>
                                        <option value="morning">Morning</option>
                                        <option value="afternoon">Afternoon</option>
                                    </select>
                                )}
                            </div>

                            {/* Duration */}
                            {formStartDate && formEndDate && (
                                <div className="rounded-lg border p-3 bg-muted/30" data-testid="leave-duration">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm text-muted-foreground">{quote ? 'Working days (company calendar)' : 'Duration (estimate)'}</span>
                                        <span className="text-lg font-bold">{formatDuration(quote ? quote.working_days : computedDuration)}</span>
                                    </div>
                                    {quote && quote.non_working_dates.length > 0 && (
                                        <p className="mt-1 text-xs text-muted-foreground">Not counted: {quote.non_working_dates.map((d) => `${formatDate(d.date)} (${d.day_type.replace('_', ' ')})`).join(', ')}</p>
                                    )}
                                    {quote?.per_year.filter((y) => y.balance.has_entitlement).map((y) => (
                                        <p key={y.year} className="mt-1 text-xs text-muted-foreground">{y.year}: {y.balance.available} available → {y.available_after} after this request</p>
                                    ))}
                                    {quote?.errors.map((e) => (
                                        <div key={e} className="flex items-center gap-1.5 mt-2 text-xs text-red-600"><AlertCircle className="h-3.5 w-3.5" />{e}</div>
                                    ))}
                                    {quote?.warnings.map((w) => (
                                        <div key={w} className="mt-1 text-xs text-amber-700">{w}</div>
                                    ))}
                                    {!quote && selectedBalance && computedDuration > selectedBalance.remaining && (
                                        <div className="flex items-center gap-1.5 mt-2 text-xs text-red-600">
                                            <AlertCircle className="h-3.5 w-3.5" />
                                            Exceeds available balance ({selectedBalance.remaining} days remaining)
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Reason */}
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium">Reason *</label>
                                <textarea
                                    className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none"
                                    rows={3}
                                    placeholder="Describe the reason for your leave…"
                                    value={formReason}
                                    onChange={(e) => setFormReason(e.target.value)}
                                />
                            </div>

                            {/* No attachment upload exists yet: say so instead of showing a drop zone that does nothing. */}
                            <p className="text-xs text-muted-foreground">Supporting documents (e.g. a medical certificate) are not uploaded here yet — give them to HR separately.</p>
                        </div>

                        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t">
                            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
                            <Button
                                onClick={handleSubmit}
                                disabled={saving || quoteBlocked || !formLeaveType || !formStartDate || !formEndDate || !formReason}
                            >
                                {saving ? 'Submitting…' : 'Submit Request'}
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
