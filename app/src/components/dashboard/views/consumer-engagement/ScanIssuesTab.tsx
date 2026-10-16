'use client'

/**
 * Scan Issues tab — track failed QR scans and drive WhatsApp follow-up.
 *
 * Layout mirrors the UI/UX draft (Image 6 from 2026-05-13 brief):
 *  - Header (title, subtitle, action buttons)
 *  - 4 KPI cards
 *  - Filter row + table + pagination
 *  - Right-side issue detail drawer
 *  - Bottom row: Admin WhatsApp Notification settings + Message Templates editor
 */

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import {
    AlertTriangle,
    Clock,
    CheckCircle2,
    Flame,
    RefreshCw,
    Download,
    MessageCircle,
    Send,
    Eye,
    X,
} from 'lucide-react'
import {
  SeraModalOverlay,
  SeraModalPanel,
  SeraModalHeader,
  SeraModalBody,
} from '@/components/ui/sera-modal'

type Issue = {
    id: string
    issue_no: string
    qr_code_text: string
    qr_code_id: string | null
    order_id: string | null
    product_name_snapshot: string | null
    shop_name_snapshot: string | null
    consumer_name_snapshot: string | null
    consumer_phone_snapshot: string | null
    consumer_email_snapshot: string | null
    consumer_whatsapp_number: string | null
    order_no_snapshot: string | null
    display_doc_no_snapshot: string | null
    issue_type: string
    error_code: string | null
    error_message: string
    user_facing_message: string | null
    status: 'pending' | 'in_progress' | 'resolved' | 'ignored'
    priority: 'low' | 'medium' | 'high' | 'urgent'
    scan_attempted_at: string
    scan_date: string
    consumer_notification_status: string
    consumer_notification_sent_at: string | null
    admin_notification_status: string
    admin_notification_sent_at: string | null
    rescan_notification_status: string
    rescan_notification_sent_at: string | null
    resolution_note: string | null
    attempt_count: number
}

type Kpis = {
    total_issues: number
    pending: number
    resolved_today: number
    high_priority: number
}

type Template = {
    id: string
    template_key: string
    template_name: string
    recipient_type: 'consumer' | 'admin'
    body: string
    is_active: boolean
    org_id: string | null
}

const ISSUE_TYPE_BADGE: Record<string, { label: string; className: string }> = {
    not_shipped_yet: { label: 'Not Shipped Yet', className: 'sera-sc-badge sera-sc-badge--ink bg-red-50 text-red-700' },
    buffer_unpromoted: { label: 'Buffer (Unpromoted)', className: 'sera-sc-badge sera-sc-badge--ink bg-red-50 text-red-700' },
    qr_not_found: { label: 'Invalid QR Code', className: 'sera-sc-badge sera-sc-badge--orange' },
    already_collected: { label: 'Already Collected', className: 'sera-sc-badge sera-sc-badge--info' },
    expired_qr: { label: 'Expired Code', className: 'sera-sc-badge sera-sc-badge--orange' },
    blocked_qr: { label: 'Blocked Code', className: 'sera-sc-badge sera-sc-badge--ink' },
    qr_not_active: { label: 'Not Active', className: 'sera-sc-badge sera-sc-badge--orange' },
    invalid_status: { label: 'Invalid Status', className: 'sera-sc-badge sera-sc-badge--orange' },
    authentication_failed: { label: 'Auth Failed', className: 'sera-sc-badge sera-sc-badge--ink bg-red-50 text-red-700' },
    system_error: { label: 'System Error', className: 'sera-sc-badge sera-sc-badge--ink bg-red-50 text-red-700' },
    unknown_error: { label: 'Unknown', className: 'sera-sc-badge sera-sc-badge--ink' },
}

const STATUS_BADGE: Record<string, string> = {
    pending: 'sera-sc-badge sera-sc-badge--orange',
    in_progress: 'sera-sc-badge sera-sc-badge--info',
    resolved: 'sera-sc-badge sera-sc-badge--success',
    ignored: 'sera-sc-badge sera-sc-badge--ink',
}

const PRIORITY_BADGE: Record<string, string> = {
    low: 'sera-sc-badge sera-sc-badge--ink',
    medium: 'sera-sc-badge sera-sc-badge--orange',
    high: 'sera-sc-badge sera-sc-badge--ink bg-red-50 text-red-700',
    urgent: 'sera-sc-badge sera-sc-badge--ink bg-red-100 text-red-800',
}

function fmtDateTime(s: string | null | undefined) {
    if (!s) return '-'
    return new Date(s).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour12: false })
}

function maskPhone(p: string | null | undefined) {
    if (!p) return '-'
    return p
}

export default function ScanIssuesTab() {
    const { toast } = useToast()

    // ---------- list state ----------
    const [issues, setIssues] = useState<Issue[]>([])
    const [kpis, setKpis] = useState<Kpis>({ total_issues: 0, pending: 0, resolved_today: 0, high_priority: 0 })
    const [loading, setLoading] = useState(false)
    const [filterStatus, setFilterStatus] = useState('all')
    const [filterType, setFilterType] = useState('all')
    const [filterPriority, setFilterPriority] = useState('all')
    const [q, setQ] = useState('')
    const [dateFrom, setDateFrom] = useState('')
    const [dateTo, setDateTo] = useState('')
    const [page, setPage] = useState(1)
    const [pageSize] = useState(10)
    const [totalCount, setTotalCount] = useState(0)
    const [selected, setSelected] = useState<Issue | null>(null)

    // ---------- settings ----------
    const [settings, setSettings] = useState<any>(null)
    const [adminNumbersInput, setAdminNumbersInput] = useState('')

    // ---------- templates ----------
    const [templates, setTemplates] = useState<Template[]>([])
    const [templatesOpen, setTemplatesOpen] = useState(false)
    const [editingTemplate, setEditingTemplate] = useState<Template | null>(null)
    const [editingBody, setEditingBody] = useState('')

    // ---------- load list ----------
    const loadIssues = async () => {
        setLoading(true)
        try {
            const params = new URLSearchParams({
                page: String(page),
                page_size: String(pageSize),
            })
            if (filterStatus !== 'all') params.set('status', filterStatus)
            if (filterType !== 'all') params.set('issue_type', filterType)
            if (filterPriority !== 'all') params.set('priority', filterPriority)
            if (q) params.set('q', q)
            if (dateFrom) params.set('date_from', dateFrom)
            if (dateTo) params.set('date_to', dateTo)
            const res = await fetch(`/api/scan-issues?${params.toString()}`)
            if (!res.ok) throw new Error(await res.text())
            const json = await res.json()
            setIssues(json.rows || [])
            setTotalCount(json.total_count || 0)
            setKpis(json.kpis || { total_issues: 0, pending: 0, resolved_today: 0, high_priority: 0 })
        } catch (err: any) {
            toast({ title: 'Failed to load scan issues', description: err?.message || 'unknown', variant: 'destructive' })
        } finally {
            setLoading(false)
        }
    }

    const loadSettings = async () => {
        try {
            const res = await fetch('/api/scan-issues/settings')
            if (!res.ok) return
            const json = await res.json()
            setSettings(json.settings)
            const nums = Array.isArray(json.settings?.admin_whatsapp_numbers) ? json.settings.admin_whatsapp_numbers : []
            setAdminNumbersInput(nums.join('\n'))
        } catch { /* ignore */ }
    }

    const loadTemplates = async () => {
        try {
            const res = await fetch('/api/scan-issues/templates')
            if (!res.ok) return
            const json = await res.json()
            setTemplates(json.templates || [])
        } catch { /* ignore */ }
    }

    useEffect(() => { loadIssues(); /* eslint-disable-next-line */ }, [page, filterStatus, filterType, filterPriority])
    useEffect(() => { loadSettings(); loadTemplates() }, [])

    const onSearch = () => { setPage(1); loadIssues() }

    const updateIssue = async (id: string, body: any) => {
        const res = await fetch(`/api/scan-issues/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        if (!res.ok) {
            const t = await res.text()
            toast({ title: 'Update failed', description: t, variant: 'destructive' })
            return null
        }
        const j = await res.json()
        return j.issue as Issue
    }

    const sendNotification = async (id: string, templateKey: string, recipientType: 'consumer' | 'admin') => {
        const res = await fetch(`/api/scan-issues/${id}/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ template_key: templateKey, recipient_type: recipientType }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json.ok) {
            toast({ title: 'Send failed', description: json?.error || 'unknown', variant: 'destructive' })
            return
        }
        toast({ title: 'Sent', description: `WhatsApp ${templateKey} sent to ${recipientType}` })
        loadIssues()
    }

    const saveSettings = async () => {
        const nums = adminNumbersInput
            .split(/\n|,/)
            .map((s) => s.trim())
            .filter(Boolean)
        const res = await fetch('/api/scan-issues/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                admin_whatsapp_numbers: nums,
                notify_on_new_issue: settings?.notify_on_new_issue ?? true,
                notify_on_high_priority: settings?.notify_on_high_priority ?? true,
                notify_on_status_change: settings?.notify_on_status_change ?? false,
                notify_on_resolved: settings?.notify_on_resolved ?? false,
            }),
        })
        const j = await res.json().catch(() => ({}))
        if (!res.ok) {
            toast({ title: 'Save failed', description: j?.error || 'unknown', variant: 'destructive' })
            return
        }
        setSettings(j.settings)
        if (j.invalid_numbers?.length) {
            toast({ title: 'Saved (some invalid)', description: `Skipped: ${j.invalid_numbers.join(', ')}`, variant: 'destructive' })
        } else {
            toast({ title: 'Settings saved' })
        }
    }

    const saveTemplate = async () => {
        if (!editingTemplate) return
        const res = await fetch(`/api/scan-issues/templates?id=${editingTemplate.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: editingBody, is_active: editingTemplate.is_active }),
        })
        if (!res.ok) {
            toast({ title: 'Template save failed', variant: 'destructive' })
            return
        }
        toast({ title: 'Template saved' })
        setEditingTemplate(null)
        loadTemplates()
    }

    const exportCsv = () => {
        if (!issues.length) return
        const header = ['issue_no', 'issue_type', 'status', 'priority', 'qr_code_text', 'order_no_snapshot', 'consumer_phone_snapshot', 'error_message', 'scan_attempted_at'].join(',')
        const rows = issues.map((r) => [
            r.issue_no,
            r.issue_type,
            r.status,
            r.priority,
            r.qr_code_text,
            r.order_no_snapshot || '',
            r.consumer_phone_snapshot || '',
            JSON.stringify(r.error_message),
            r.scan_attempted_at,
        ].join(','))
        const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `scan-issues-${new Date().toISOString().slice(0, 10)}.csv`
        a.click()
        URL.revokeObjectURL(url)
    }

    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
    const ackTemplate = useMemo(() => templates.find((t) => t.template_key === 'issue_acknowledgement') || null, [templates])
    const rescanTemplate = useMemo(() => templates.find((t) => t.template_key === 'issue_resolved_rescan') || null, [templates])

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
                <div>
                    <div className="h-1 w-10 rounded-sm bg-[var(--sera-orange)] mb-3 sera-sc-header__bar" />
                    <h2 className="font-display text-2xl font-semibold tracking-tight text-[var(--sera-ink)] flex items-center gap-2">
                        <AlertTriangle className="h-6 w-6 text-[var(--sera-orange)]" />
                        Scan Issues
                    </h2>
                    <p className="text-sm text-[var(--sera-muted)] mt-1">Track and manage QR scan issues reported by consumers</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" className="border-[var(--sera-line)]" onClick={() => setTemplatesOpen(true)}>
                        <MessageCircle className="h-4 w-4 mr-1" /> Message Templates
                    </Button>
                    <Button variant="outline" size="sm" className="border-[var(--sera-line)]" onClick={exportCsv} disabled={!issues.length}>
                        <Download className="h-4 w-4 mr-1" /> Export
                    </Button>
                    <Button variant="outline" size="sm" className="border-[var(--sera-line)]" onClick={loadIssues}>
                        <RefreshCw className="h-4 w-4 mr-1" /> Refresh
                    </Button>
                </div>
            </div>

            {/* KPI cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">Total Issues</p><p className="sera-sc-kpi__value">{kpis.total_issues.toLocaleString()}</p></div>
                <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">Pending</p><p className="sera-sc-kpi__value text-[var(--sera-orange)]">{kpis.pending.toLocaleString()}</p></div>
                <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">Resolved Today</p><p className="sera-sc-kpi__value">{kpis.resolved_today.toLocaleString()}</p></div>
                <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">High Priority</p><p className="sera-sc-kpi__value">{kpis.high_priority.toLocaleString()}</p></div>
            </div>

            {/* Filters */}
            <div className="sera-sc-panel p-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                        <Input className="border-[var(--sera-line)]" placeholder="Search QR / Order / Phone / Issue No" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSearch()} />
                        <Select value={filterType} onValueChange={(v) => { setFilterType(v); setPage(1) }}>
                            <SelectTrigger className="border-[var(--sera-line)] bg-white"><SelectValue placeholder="All Types" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Types</SelectItem>
                                {Object.entries(ISSUE_TYPE_BADGE).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
                            </SelectContent>
                        </Select>
                        <Select value={filterStatus} onValueChange={(v) => { setFilterStatus(v); setPage(1) }}>
                            <SelectTrigger><SelectValue placeholder="All Status" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Status</SelectItem>
                                <SelectItem value="pending">Pending</SelectItem>
                                <SelectItem value="in_progress">In Progress</SelectItem>
                                <SelectItem value="resolved">Resolved</SelectItem>
                                <SelectItem value="ignored">Ignored</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={filterPriority} onValueChange={(v) => { setFilterPriority(v); setPage(1) }}>
                            <SelectTrigger><SelectValue placeholder="All Priority" /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All Priority</SelectItem>
                                <SelectItem value="low">Low</SelectItem>
                                <SelectItem value="medium">Medium</SelectItem>
                                <SelectItem value="high">High</SelectItem>
                                <SelectItem value="urgent">Urgent</SelectItem>
                            </SelectContent>
                        </Select>
                        <div className="grid grid-cols-2 gap-2">
                            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                        </div>
                    </div>
                    <div className="flex justify-end mt-3">
                        <Button size="sm" className="sera-sc-btn-primary" onClick={onSearch}>Apply Filters</Button>
                    </div>
            </div>

            {/* Layout: table (full width). Drawer is a slide-over panel on top. */}
            <div>
                <div className="sera-sc-panel overflow-hidden">
                    <div className="sera-sc-panel__body pt-4 overflow-x-auto">
                        <table className="sera-sc-table min-w-full">
                            <thead>
                                <tr>
                                    <Th>Issue ID</Th>
                                    <Th>Type</Th>
                                    <Th>QR Code</Th>
                                    <Th>Order No</Th>
                                    <Th>Consumer Phone</Th>
                                    <Th>Scan Time</Th>
                                    <Th>Status</Th>
                                    <Th>Priority</Th>
                                    <Th>Last Notification</Th>
                                    <Th></Th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    <tr><td colSpan={10} className="sera-sc-table__empty">Loading...</td></tr>
                                ) : issues.length === 0 ? (
                                    <tr><td colSpan={10} className="sera-sc-table__empty">No scan issues yet</td></tr>
                                ) : issues.map((r) => {
                                    const t = ISSUE_TYPE_BADGE[r.issue_type] || { label: r.issue_type, className: 'sera-sc-badge--ink' }
                                    const isSelected = selected?.id === r.id
                                    return (
                                        <tr key={r.id} className={`cursor-pointer ${isSelected ? 'bg-[var(--sera-orange)]/6' : ''}`} onClick={() => setSelected(r)}>
                                            <Td><button className="text-[var(--sera-orange)] hover:underline font-medium" onClick={(e) => { e.stopPropagation(); setSelected(r) }}>{r.issue_no}</button></Td>
                                            <Td><Badge className={t.className}>{t.label}</Badge></Td>
                                            <Td className="truncate max-w-[180px] font-mono text-[11px]" title={r.qr_code_text}>{r.qr_code_text}</Td>
                                            <Td>{r.display_doc_no_snapshot || r.order_no_snapshot || '-'}</Td>
                                            <Td>{maskPhone(r.consumer_phone_snapshot)}</Td>
                                            <Td>{fmtDateTime(r.scan_attempted_at)}</Td>
                                            <Td><Badge className={STATUS_BADGE[r.status] || ''}>{r.status}</Badge></Td>
                                            <Td><Badge className={PRIORITY_BADGE[r.priority] || ''}>{r.priority}</Badge></Td>
                                            <Td>{r.consumer_notification_status === 'sent' ? fmtDateTime(r.consumer_notification_sent_at) : r.consumer_notification_status}</Td>
                                            <Td>
                                                <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelected(r) }}>
                                                    <Eye className="h-4 w-4" />
                                                </Button>
                                            </Td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                        {/* Pagination */}
                        <div className="flex items-center justify-between mt-4 text-sm text-[var(--sera-muted)] px-1">
                            <div>Showing {issues.length} of {totalCount}</div>
                            <div className="flex gap-2 items-center">
                                <Button size="sm" variant="outline" className="border-[var(--sera-line)]" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
                                <span className="text-[var(--sera-ink)]">Page {page} of {totalPages}</span>
                                <Button size="sm" variant="outline" className="border-[var(--sera-line)]" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right slide-over drawer */}
                {selected && (
                    <>
                        <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setSelected(null)} aria-hidden />
                        <aside
                            role="dialog"
                            aria-label="Issue details"
                            className="fixed top-0 right-0 z-50 h-full w-full sm:w-[480px] lg:w-[520px] max-w-[95vw] bg-white shadow-xl border-l border-[var(--sera-line)] flex flex-col"
                        >
                            <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white z-10">
                                <div className="flex items-center gap-2 min-w-0">
                                    <h3 className="text-base font-semibold truncate">Issue Details</h3>
                                    <Badge className={STATUS_BADGE[selected.status] || ''}>{selected.status}</Badge>
                                </div>
                                <Button size="sm" variant="ghost" onClick={() => setSelected(null)} aria-label="Close"><X className="h-4 w-4" /></Button>
                            </div>

                            <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
                                <div>
                                    <div className="text-[var(--sera-orange)] font-semibold text-base">{selected.issue_no}</div>
                                    <div className="text-xs text-[var(--sera-muted)]">Reported: {fmtDateTime(selected.scan_attempted_at)}</div>
                                </div>

                                <Section title="Consumer & Contact">
                                    <KV k="Phone (WhatsApp)" v={selected.consumer_whatsapp_number ? '+' + selected.consumer_whatsapp_number : (selected.consumer_phone_snapshot || '-')} />
                                    <KV k="Email" v={selected.consumer_email_snapshot || '-'} />
                                    <KV k="Name" v={selected.consumer_name_snapshot || '-'} />
                                </Section>

                                <Section title="QR & Order Details">
                                    <div className="space-y-2">
                                        <div>
                                            <div className="text-[11px] text-gray-500 mb-1">QR Code</div>
                                            <div className="bg-gray-50 border rounded p-2 font-mono text-[11px] break-all whitespace-pre-wrap">{selected.qr_code_text}</div>
                                        </div>
                                        <KV k="Order No" v={selected.display_doc_no_snapshot || selected.order_no_snapshot || '-'} />
                                        <KV k="Product" v={selected.product_name_snapshot || '-'} />
                                        <KV k="Shop" v={selected.shop_name_snapshot || '-'} />
                                    </div>
                                </Section>

                                <Section title="Issue">
                                    <KV k="Type" v={<Badge className={(ISSUE_TYPE_BADGE[selected.issue_type]?.className) || ''}>{ISSUE_TYPE_BADGE[selected.issue_type]?.label || selected.issue_type}</Badge>} />
                                    <div>
                                        <div className="text-[11px] text-gray-500 mb-1">Error</div>
                                        <div className="bg-red-50 border border-red-100 rounded p-2 text-[12px] text-red-700 break-words whitespace-pre-wrap">{selected.error_message}</div>
                                    </div>
                                    <KV k="Priority" v={<Badge className={PRIORITY_BADGE[selected.priority] || ''}>{selected.priority}</Badge>} />
                                    <KV k="Attempts" v={String(selected.attempt_count)} />
                                </Section>

                                <Section title="Actions">
                                    <div className="grid grid-cols-2 gap-2">
                                        <Button size="sm" variant="outline" onClick={async () => {
                                            const updated = await updateIssue(selected.id, { status: 'in_progress' })
                                            if (updated) { setSelected(updated); loadIssues() }
                                        }}>Mark In Progress</Button>
                                        <Button size="sm" onClick={async () => {
                                            const updated = await updateIssue(selected.id, { status: 'resolved', mark_rectified: true })
                                            if (updated) { setSelected(updated); loadIssues() }
                                        }}>Mark Resolved</Button>
                                    </div>
                                </Section>

                                <Section title="Send WhatsApp">
                                    <div className="space-y-2">
                                        <Button size="sm" className="w-full justify-start" onClick={() => sendNotification(selected.id, 'issue_acknowledgement', 'consumer')}>
                                            <Send className="h-3 w-3 mr-2" /> Send Acknowledgement
                                        </Button>
                                        <Button size="sm" className="w-full justify-start" variant="outline" onClick={() => sendNotification(selected.id, 'issue_resolved_rescan', 'consumer')}>
                                            <Send className="h-3 w-3 mr-2" /> Send Rescan Notification
                                        </Button>
                                        <Button size="sm" className="w-full justify-start" variant="ghost" onClick={() => sendNotification(selected.id, 'admin_new_issue_alert', 'admin')}>
                                            <Send className="h-3 w-3 mr-2" /> Send Admin Alert
                                        </Button>
                                    </div>
                                </Section>

                                <Section title="Notification History">
                                    <KV k="Consumer" v={`${selected.consumer_notification_status}${selected.consumer_notification_sent_at ? ' • ' + fmtDateTime(selected.consumer_notification_sent_at) : ''}`} />
                                    <KV k="Admin" v={`${selected.admin_notification_status}${selected.admin_notification_sent_at ? ' • ' + fmtDateTime(selected.admin_notification_sent_at) : ''}`} />
                                    <KV k="Rescan" v={`${selected.rescan_notification_status}${selected.rescan_notification_sent_at ? ' • ' + fmtDateTime(selected.rescan_notification_sent_at) : ''}`} />
                                </Section>
                            </div>
                        </aside>
                    </>
                )}
            </div>

            {/* Settings + Templates row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="sera-sc-panel p-4 space-y-3">
                        <h3 className="font-display text-base font-semibold text-[var(--sera-ink)]">Admin WhatsApp Notifications (System Alerts)</h3>
                        <div>
                            <label className="text-xs font-medium text-gray-600">Admin WhatsApp Numbers (one per line)</label>
                            <textarea
                                value={adminNumbersInput}
                                onChange={(e) => setAdminNumbersInput(e.target.value)}
                                rows={3}
                                className="w-full mt-1 border rounded p-2 text-sm font-mono"
                                placeholder="60123456789&#10;60198765432"
                            />
                            <p className="text-[11px] text-gray-500 mt-1">Auto-normalized: removes +, spaces, dashes. 0xx → 60xx for Malaysia.</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={settings?.notify_on_new_issue ?? true} onChange={(e) => setSettings({ ...(settings || {}), notify_on_new_issue: e.target.checked })} />
                                New issue created
                            </label>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={settings?.notify_on_high_priority ?? true} onChange={(e) => setSettings({ ...(settings || {}), notify_on_high_priority: e.target.checked })} />
                                High priority only
                            </label>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={settings?.notify_on_status_change ?? false} onChange={(e) => setSettings({ ...(settings || {}), notify_on_status_change: e.target.checked })} />
                                Status updated
                            </label>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={settings?.notify_on_resolved ?? false} onChange={(e) => setSettings({ ...(settings || {}), notify_on_resolved: e.target.checked })} />
                                Issue resolved
                            </label>
                        </div>
                        <Button size="sm" className="sera-sc-btn-primary" onClick={saveSettings}>Save Settings</Button>
                </div>

                <div className="sera-sc-panel p-4">
                        <div className="flex items-center justify-between mb-3">
                        <h3 className="font-display text-base font-semibold text-[var(--sera-ink)]">Message Templates</h3>
                        <Button size="sm" variant="outline" className="border-[var(--sera-line)]" onClick={() => setTemplatesOpen(true)}>Manage</Button>
                        </div>
                        <div className="space-y-2">
                            {[ackTemplate, rescanTemplate].filter(Boolean).map((tpl) => (
                                <div key={tpl!.id} className="border rounded p-2">
                                    <div className="flex items-center justify-between mb-1">
                                        <div className="text-sm font-medium">{tpl!.template_name}</div>
                                        <Badge className={tpl!.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}>{tpl!.is_active ? 'Active' : 'Inactive'}</Badge>
                                    </div>
                                    <pre className="text-[11px] text-gray-600 whitespace-pre-wrap font-sans">{tpl!.body.slice(0, 220)}{tpl!.body.length > 220 ? '…' : ''}</pre>
                                </div>
                            ))}
                        </div>
                </div>
            </div>

            {/* Templates modal */}
            {templatesOpen && (
                <SeraModalOverlay onBackdropClick={() => { setTemplatesOpen(false); setEditingTemplate(null) }}>
                    <SeraModalPanel className="overflow-y-auto">
                        <SeraModalHeader
                            title="Message Templates"
                            onClose={() => { setTemplatesOpen(false); setEditingTemplate(null) }}
                        />
                        <SeraModalBody>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                {templates.map((t) => (
                                    <div key={t.id} className={`border rounded p-2 cursor-pointer ${editingTemplate?.id === t.id ? 'border-[var(--sera-orange)]/50 bg-[var(--sera-orange)]/[0.06]' : 'border-[var(--sera-line)]'}`} onClick={() => { setEditingTemplate(t); setEditingBody(t.body) }}>
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="text-sm font-medium truncate">{t.template_name}</div>
                                                <div className="text-[11px] text-[var(--sera-muted)]">{t.template_key} · {t.recipient_type}</div>
                                            </div>
                                            <Badge className={t.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}>{t.is_active ? 'Active' : 'Inactive'}</Badge>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div>
                                {editingTemplate ? (
                                    <>
                                        <div className="mb-2 text-sm font-medium">{editingTemplate.template_name}</div>
                                        <textarea value={editingBody} onChange={(e) => setEditingBody(e.target.value)} rows={12} className="w-full border border-[var(--sera-line)] rounded p-2 text-sm font-mono" />
                                        <div className="text-[11px] text-[var(--sera-muted)] mt-1">Variables: <code>{'{{name}} {{consumer_phone}} {{qr_code}} {{order_no}} {{product_name}} {{issue_type}} {{error_message}} {{scan_time}} {{issue_no}} {{rescan_link}}'}</code></div>
                                        <div className="mt-3 bg-green-50 border border-green-200 rounded p-3">
                                            <div className="text-[10px] text-[var(--sera-muted)] mb-1">WhatsApp preview</div>
                                            <pre className="text-xs whitespace-pre-wrap font-sans">{editingBody}</pre>
                                        </div>
                                        <div className="flex flex-col sm:flex-row gap-2 mt-3">
                                            <Button size="sm" className="bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white" onClick={saveTemplate}>Save</Button>
                                            <Button size="sm" variant="outline" onClick={() => setEditingTemplate(null)}>Cancel</Button>
                                        </div>
                                    </>
                                ) : (
                                    <div className="text-sm text-[var(--sera-muted)]">Select a template on the left to edit.</div>
                                )}
                            </div>
                        </div>
                        </SeraModalBody>
                    </SeraModalPanel>
                </SeraModalOverlay>
            )}
        </div>
    )
}

function Th({ children }: { children?: React.ReactNode }) {
    return <th className="whitespace-nowrap">{children}</th>
}
function Td({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
    return <td className={className} title={title}>{children}</td>
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="text-xs font-semibold text-[var(--sera-ink)] mb-1">{title}</div>
            <div className="space-y-1">{children}</div>
        </div>
    )
}
function KV({ k, v }: { k: string; v: React.ReactNode }) {
    return (
        <div className="flex justify-between items-start gap-2 text-xs">
            <span className="text-[var(--sera-muted)] shrink-0">{k}</span>
            <span className="text-[var(--sera-ink-soft)] text-right break-all">{v}</span>
        </div>
    )
}
