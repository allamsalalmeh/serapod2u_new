"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
    AlertCircle, CheckCheck, ChevronDown, ChevronRight, Download, Info, Loader2, Mail, MessageCircle, MessageSquare,
    MoreHorizontal, RefreshCw, Search, Send, SlidersHorizontal, Wifi, WifiOff,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
    DEFAULT_PAGE_SIZE,
    STATUS_LABELS,
    STATUS_MEANINGS,
    appDate,
    errorSummary,
    monitorCsv,
    shiftDate,
    type AnnotatedRecord,
    type FacetOption,
    type MonitorChannel,
    type MonitorKind,
    type MonitorStatus,
    type TypeFacetOption,
} from "@/lib/notifications/monitor/monitorCore"
import { isFailedStatus } from "@/lib/wa-recovery/activity-status"
import { MonitorDetailsSheet } from "./MonitorDetailsSheet"
import { QUICK_RECOVERY_ACTIONS, useWhatsAppRecovery, type RecoveryTarget } from "./useWhatsAppRecovery"
import { ActionMenu, StatusBadge, formatMonitorTime, formatRange } from "./monitorUi"

const CHANNELS: { id: MonitorChannel; label: string; icon: typeof Mail }[] = [
    { id: "whatsapp", label: "WhatsApp", icon: MessageCircle },
    { id: "sms", label: "SMS", icon: MessageSquare },
    { id: "email", label: "Email", icon: Mail },
]

const RANGE_PRESETS = [
    { id: "today", label: "Today", days: 1 },
    { id: "7d", label: "Last 7 days", days: 7 },
    { id: "30d", label: "Last 30 days", days: 30 },
    { id: "90d", label: "Last 90 days", days: 90 },
] as const

const SELECT_CLASS = "h-9 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 outline-none focus-visible:border-[var(--sera-orange)] focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/25"

interface QueryState {
    channel: MonitorChannel
    q: string
    module: string
    type: string
    from: string
    to: string
    status: MonitorStatus | "all"
    provider: string
    kind: MonitorKind
    page: number
}

interface MonitorResponse {
    rows: AnnotatedRecord[]
    total: number
    totalPages: number
    statusCounts: Record<MonitorStatus, number>
    kindCounts: Record<MonitorKind, number>
    matchingBeforeStatus: number
    facets: { modules: FacetOption[]; types: TypeFacetOption[]; providers: FacetOption[] }
    filters: QueryState
    range: { from: string; to: string; timezone: string }
    truncated: boolean
    sourceLimit: number
    statuses: MonitorStatus[]
    capabilityNote: string
    provider: { configured: boolean; active: boolean; name: string | null; lastTestStatus: string | null; lastTestAt: string | null; lastTestError: string | null; blockedReason: string | null }
    selected: { module: { value: string; label: string } | null; type: { value: string; notificationName: string; moduleId: string } | null }
}

function defaultQuery(channel: MonitorChannel): QueryState {
    const to = appDate()
    return { channel, q: "", module: "all", type: "all", from: shiftDate(to, -6), to, status: "all", provider: "all", kind: "original", page: 1 }
}

/** Filters from the address bar, so Monitor views can be linked (e.g. from Configure). */
function queryFromUrl(initialChannel: MonitorChannel): QueryState {
    const base = defaultQuery(initialChannel)
    if (typeof window === "undefined") return base
    const params = new URLSearchParams(window.location.search)
    const channel = CHANNELS.some((c) => c.id === params.get("channel")) ? params.get("channel") as MonitorChannel : initialChannel
    const date = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null)
    return {
        ...base,
        channel,
        q: params.get("q") || "",
        module: params.get("module") || "all",
        type: params.get("type") || "all",
        from: date(params.get("from")) || base.from,
        to: date(params.get("to")) || base.to,
        status: (params.get("status") as MonitorStatus) || "all",
        provider: params.get("provider") || "all",
        kind: channel === "whatsapp" && params.get("kind") === "recovery" ? "recovery" : "original",
    }
}

function toParams(query: QueryState, extra: Record<string, string> = {}) {
    const params = new URLSearchParams({ channel: query.channel, from: query.from, to: query.to })
    if (query.q) params.set("q", query.q)
    if (query.module !== "all") params.set("module", query.module)
    if (query.type !== "all") params.set("type", query.type)
    if (query.status !== "all") params.set("status", query.status)
    if (query.provider !== "all") params.set("provider", query.provider)
    if (query.kind !== "original") params.set("kind", query.kind)
    Object.entries(extra).forEach(([key, value]) => params.set(key, value))
    return params
}

function presetOf(query: QueryState) {
    const today = appDate()
    if (query.to !== today) return "custom"
    return RANGE_PRESETS.find((preset) => shiftDate(today, -(preset.days - 1)) === query.from)?.id || "custom"
}

function downloadText(text: string, filename: string) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
}

const toTarget = (record: AnnotatedRecord): RecoveryTarget => ({ id: record.id, createdAt: record.createdAt, purpose: record.purpose, recoveryStatus: record.recovery?.status || null, action: record.action || {} })
const isRecoverable = (record: AnnotatedRecord) => record.channel === "whatsapp" && isFailedStatus(record.rawStatus) && Boolean(record.action?.phone)

export default function NotificationMonitor({ initialChannel = "whatsapp" }: { initialChannel?: MonitorChannel }) {
    const [query, setQuery] = useState<QueryState>(() => queryFromUrl(initialChannel))
    const [searchInput, setSearchInput] = useState(query.q)
    const [data, setData] = useState<MonitorResponse | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [selected, setSelected] = useState<Map<string, AnnotatedRecord>>(new Map())
    const [details, setDetails] = useState<AnnotatedRecord | null>(null)
    const [moreFilters, setMoreFilters] = useState(false)
    const [gatewayOpen, setGatewayOpen] = useState(false)
    const [waGateway, setWaGateway] = useState<{ loading: boolean; connected: boolean; phone?: string | null; providerName?: string | null; providerType?: string | null }>({ loading: true, connected: false })
    const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
    const [reloadKey, setReloadKey] = useState(0)
    const [exporting, setExporting] = useState(false)
    const requestSeq = useRef(0)

    const notify = useCallback((kind: "ok" | "err", text: string) => {
        setToast({ kind, text })
        window.setTimeout(() => setToast(null), 4000)
    }, [])
    const reload = useCallback(() => setReloadKey((key) => key + 1), [])
    const recovery = useWhatsAppRecovery({ notify, onChanged: () => { setSelected(new Map()); reload() } })

    // Any filter change (not paging) starts at page 1 and drops the selection.
    const update = (patch: Partial<QueryState>) => {
        setQuery((current) => ({ ...current, page: 1, ...patch }))
        if (!("page" in patch)) setSelected(new Map())
    }

    useEffect(() => {
        const timer = window.setTimeout(() => { if (searchInput.trim() !== query.q) update({ q: searchInput.trim() }) }, 300)
        return () => window.clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchInput])

    useEffect(() => {
        const params = toParams(query, { page: String(query.page), pageSize: String(DEFAULT_PAGE_SIZE) })
        const seq = ++requestSeq.current
        setLoading(true)
        setError(null)
        fetch(`/api/settings/notifications/monitor?${params}`)
            .then(async (response) => {
                const payload = await response.json()
                if (!response.ok) throw new Error(payload.error || "Failed to load notification activity")
                if (seq === requestSeq.current) setData(payload)
            })
            .catch((err) => { if (seq === requestSeq.current) setError(err.message || "Failed to load notification activity") })
            .finally(() => { if (seq === requestSeq.current) setLoading(false) })
        // Keep the address bar shareable without a navigation.
        const url = `${window.location.pathname}?${toParams(query)}`
        if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", url)
    }, [query, reloadKey])

    const loadWaGateway = useCallback(async () => {
        setWaGateway((state) => ({ ...state, loading: true }))
        try {
            const response = await fetch("/api/settings/whatsapp/status")
            const payload = response.ok ? await response.json() : null
            setWaGateway({ loading: false, connected: !!payload?.connected, phone: payload?.phone_number, providerName: payload?.provider_name, providerType: payload?.provider_type })
        } catch {
            setWaGateway({ loading: false, connected: false })
        }
    }, [])
    useEffect(() => { if (query.channel === "whatsapp") void loadWaGateway() }, [query.channel, loadWaGateway])

    // ---- facets -----------------------------------------------------------
    const moduleOptions = useMemo(() => {
        const list = [...(data?.facets.modules || [])]
        if (query.module !== "all" && !list.some((m) => m.value === query.module)) list.push({ value: query.module, label: data?.selected.module?.label || query.module, count: 0 })
        return list
    }, [data, query.module])
    const typeOptions = useMemo(() => {
        const list = (data?.facets.types || []).filter((type) => query.module === "all" || type.moduleId === query.module)
        if (query.type !== "all" && !list.some((t) => t.value === query.type)) {
            list.push({ value: query.type, label: data?.selected.type?.notificationName || query.type, count: 0, moduleId: data?.selected.type?.moduleId || "" })
        }
        return list
    }, [data, query.module, query.type])

    const changeModule = (moduleId: string) => {
        const typeModule = (data?.facets.types || []).find((type) => type.value === query.type)?.moduleId || data?.selected.type?.moduleId
        const keepType = query.type === "all" || moduleId === "all" || typeModule === moduleId
        update({ module: moduleId, type: keepType ? query.type : "all" })
    }

    // ---- selection & export ----------------------------------------------
    const pageRows = data?.rows || []
    const selectableOnPage = pageRows
    const allOnPageSelected = selectableOnPage.length > 0 && selectableOnPage.every((row) => selected.has(row.id))
    const toggleRow = (row: AnnotatedRecord) => setSelected((current) => {
        const next = new Map(current)
        if (next.has(row.id)) next.delete(row.id)
        else next.set(row.id, row)
        return next
    })
    const togglePage = (checked: boolean) => setSelected((current) => {
        const next = new Map(current)
        selectableOnPage.forEach((row) => (checked ? next.set(row.id, row) : next.delete(row.id)))
        return next
    })
    const selectedRows = Array.from(selected.values())
    const selectedRecoverable = selectedRows.filter(isRecoverable)

    const exportAll = async () => {
        setExporting(true)
        try {
            const response = await fetch(`/api/settings/notifications/monitor?${toParams(query, { format: "csv" })}`)
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Export failed")
            downloadText(await response.text(), `notification-monitor_${query.channel}_${query.from}_${query.to}.csv`)
        } catch (err: any) {
            notify("err", err.message || "Export failed")
        } finally {
            setExporting(false)
        }
    }
    const exportSelected = () => downloadText(monitorCsv(selectedRows), `notification-monitor_${query.channel}_selected_${selectedRows.length}.csv`)

    const loadFailedTargets = async (): Promise<RecoveryTarget[]> => {
        const response = await fetch(`/api/settings/notifications/monitor?${toParams(query, { targets: "failed" })}`)
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error || "Failed to load failed recipients")
        return payload.targets || []
    }
    const runQuickAction = async (action: typeof QUICK_RECOVERY_ACTIONS[number]) => {
        try {
            const targets = (await loadFailedTargets()).filter((target) => action.match(String(target.purpose || "").toLowerCase()))
            if (targets.length === 0) return notify("err", "No failed recipients match the current filters for this action.")
            recovery.bulk(`${action.label} (current filters)`, targets, action.key)
        } catch (err: any) {
            notify("err", err.message)
        }
    }
    const customForFiltered = async () => {
        try {
            recovery.customForMany(selectedRecoverable.length ? selectedRecoverable.map(toTarget) : await loadFailedTargets())
        } catch (err: any) {
            notify("err", err.message)
        }
    }

    // ---- SMS actions (unchanged endpoints) ----------------------------------
    const [smsCheck, setSmsCheck] = useState<{ open: boolean; phone: string; message: string; sending: boolean; result: string | null }>({ open: false, phone: "", message: "", sending: false, result: null })
    const [smsEdit, setSmsEdit] = useState<{ record: AnnotatedRecord; phone: string; message: string; saving: boolean; error: string | null } | null>(null)
    const [refreshingStatus, setRefreshingStatus] = useState(false)

    // Prefills the saved SMS Delivery Check template; the server falls back to it when empty.
    const openSmsCheck = async () => {
        setSmsCheck({ open: true, phone: "", message: "", sending: false, result: null })
        try {
            const response = await fetch("/api/notifications/sms-check")
            const result = await response.json().catch(() => ({}))
            const message = String(result.message || "").trim()
            if (response.ok && message) setSmsCheck((state) => (state.message ? state : { ...state, message }))
        } catch { /* the server still resolves the saved template on send */ }
    }

    const sendSmsCheck = async () => {
        if (!smsCheck.phone.trim() || smsCheck.sending) return
        setSmsCheck((state) => ({ ...state, sending: true, result: null }))
        try {
            const response = await fetch("/api/notifications/sms-check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: smsCheck.phone.trim(), message: smsCheck.message.trim() }) })
            const result = await response.json()
            if (!response.ok) throw new Error(result.error || "SMS check failed")
            setSmsCheck((state) => ({ ...state, sending: false, result: `Sent to ${result.to}.` }))
            reload()
        } catch (err: any) {
            setSmsCheck((state) => ({ ...state, sending: false, result: err.message || "SMS check failed" }))
        }
    }

    // Asks the SMS gateway for delivery reports now; bounded by a client timeout.
    const refreshSmsStatus = async () => {
        if (refreshingStatus) return
        setRefreshingStatus(true)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        try {
            const response = await fetch("/api/settings/notifications/sms-activity/refresh-status", { method: "POST", signal: controller.signal })
            const result = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(result.error || "Failed to check gateway status")
            notify("ok", result.timedOut ? `Gateway slow: checked ${result.checked ?? 0}, updated ${result.updated ?? 0}.` : `Checked ${result.checked ?? 0} message(s), updated ${result.updated ?? 0}.`)
        } catch (err: any) {
            notify("err", err?.name === "AbortError" ? "Gateway did not respond in time." : err.message || "Failed to check gateway status")
        } finally {
            clearTimeout(timer)
            setRefreshingStatus(false)
            reload()
        }
    }

    const saveSmsEdit = async (send: boolean) => {
        if (!smsEdit) return
        const phone = smsEdit.phone.trim()
        const message = smsEdit.message.trim()
        if (!phone) return setSmsEdit({ ...smsEdit, error: "Enter a phone number" })
        if (send && !message) return setSmsEdit({ ...smsEdit, error: "Enter the SMS message text to send" })
        setSmsEdit({ ...smsEdit, saving: true, error: null })
        const action = smsEdit.record.action || {}
        try {
            const response = await fetch("/api/settings/notifications/sms-activity", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: action.id, source: action.source, outboxId: action.outboxId, eventCode: action.eventCode, phone, message, send }),
            })
            const result = await response.json()
            if (!response.ok) throw new Error(result.error || "Failed to save SMS")
            setSmsEdit(null)
            setDetails(null)
            notify("ok", send ? `SMS sent to ${result.to}.` : "SMS saved.")
            reload()
        } catch (err: any) {
            setSmsEdit((state) => (state ? { ...state, saving: false, error: err.message || "Failed to save SMS" } : state))
        }
    }

    // ---- render -----------------------------------------------------------
    const statuses = (data?.statuses || []).filter((status) => status !== "other" || (data?.statusCounts.other || 0) > 0)
    const channelLabel = CHANNELS.find((c) => c.id === query.channel)!.label
    const preset = presetOf(query)
    const provider = data?.provider
    const gatewayOk = query.channel === "whatsapp" ? waGateway.connected : Boolean(provider?.active && !provider?.blockedReason)
    const gatewayText = query.channel === "whatsapp"
        ? (waGateway.loading ? "Checking gateway…" : waGateway.connected ? "Gateway connected" : "Gateway disconnected")
        : !provider ? "Provider…" : !provider.configured ? "Provider not configured" : provider.blockedReason ? "Provider failing test" : provider.active ? "Provider active" : "Provider inactive"

    return (
        <div className="space-y-4">
            <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <h1 className="text-xl font-semibold text-slate-950">Notification Monitor</h1>
                    <p className="mt-0.5 text-sm text-slate-500">Delivery activity for every notification, by channel.</p>
                    <div role="group" aria-label="Channel" className="mt-3 inline-flex rounded-lg border border-slate-200 bg-slate-50 p-1">
                        {CHANNELS.map((channel) => {
                            const Icon = channel.icon
                            const active = channel.id === query.channel
                            return (
                                <button
                                    key={channel.id}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => !active && update({ channel: channel.id, status: "all", provider: "all", kind: "original" })}
                                    className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40 ${active ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                                >
                                    <Icon className="h-3.5 w-3.5" aria-hidden />{channel.label}
                                </button>
                            )
                        })}
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        aria-expanded={gatewayOpen}
                        aria-controls="monitor-gateway"
                        onClick={() => setGatewayOpen((open) => !open)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40 ${gatewayOk ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-800"}`}
                    >
                        {gatewayOk ? <Wifi className="h-3.5 w-3.5" aria-hidden /> : <WifiOff className="h-3.5 w-3.5" aria-hidden />}
                        {channelLabel} · {gatewayText}
                        {gatewayOpen ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
                    </button>
                    <Button variant="outline" size="sm" onClick={() => { reload(); if (query.channel === "whatsapp") void loadWaGateway() }}>
                        <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Refresh
                    </Button>
                    {query.channel !== "email" ? (
                        <ActionMenu
                            trigger={<Button variant="outline" size="sm"><MoreHorizontal className="mr-1.5 h-3.5 w-3.5" />{query.channel === "whatsapp" ? "Recovery & tools" : "Tools"}</Button>}
                            items={query.channel === "whatsapp"
                                ? [
                                    { heading: true, label: "Recovery messages to failed rows in the current filters (you confirm each send)" },
                                    ...QUICK_RECOVERY_ACTIONS.map((action) => ({ label: `${action.label}…`, onSelect: () => void runQuickAction(action) })),
                                    { label: "Custom recovery message…", onSelect: () => void customForFiltered() },
                                    "separator" as const,
                                    { label: "Recovery templates…", onSelect: () => void recovery.openTemplates() },
                                ]
                                : [
                                    { label: "Check delivery reports with the SMS gateway", onSelect: () => void refreshSmsStatus(), disabled: refreshingStatus },
                                    "separator" as const,
                                    { label: "Send a test SMS (SMS check)…", onSelect: () => void openSmsCheck() },
                                ]}
                        />
                    ) : null}
                </div>
            </header>

            {gatewayOpen ? (
                <div id="monitor-gateway" className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
                    {query.channel === "whatsapp" ? (
                        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
                            <div><dt className="text-slate-400">Provider</dt><dd className="text-slate-800">{waGateway.providerName || "No default provider"}{waGateway.providerType ? ` (${waGateway.providerType})` : ""}</dd></div>
                            <div><dt className="text-slate-400">Connection</dt><dd className="text-slate-800">{waGateway.connected ? "Connected" : "Disconnected"}</dd></div>
                            <div><dt className="text-slate-400">Number</dt><dd className="text-slate-800">{waGateway.phone || "—"}</dd></div>
                        </dl>
                    ) : provider ? (
                        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-3">
                            <div><dt className="text-slate-400">Provider</dt><dd className="text-slate-800">{provider.name || "—"} · {provider.configured ? (provider.active ? "active" : "inactive") : "not configured"}</dd></div>
                            <div><dt className="text-slate-400">Last provider test</dt><dd className="text-slate-800">{provider.lastTestStatus ? `${provider.lastTestStatus} · ${formatMonitorTime(provider.lastTestAt)}` : "Never tested"}</dd></div>
                            <div><dt className="text-slate-400">Issue</dt><dd className="text-slate-800">{provider.blockedReason || provider.lastTestError || "None reported"}</dd></div>
                        </dl>
                    ) : "Loading…"}
                    <p className="mt-2 text-[11px] text-slate-500">Provider setup and test sends are under Notifications → Providers.</p>
                </div>
            ) : null}

            {/* Filter bar */}
            <section aria-label="Filters" className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto]">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
                        <Input type="search" aria-label="Search" placeholder="Search recipient, notification, reference, error" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} className="h-9 pl-8" />
                    </div>
                    <select aria-label="Module" value={query.module} onChange={(event) => changeModule(event.target.value)} className={SELECT_CLASS}>
                        <option value="all">All modules</option>
                        {moduleOptions.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
                    </select>
                    <select aria-label="Notification Type" value={query.type} onChange={(event) => update({ type: event.target.value })} className={SELECT_CLASS}>
                        <option value="all">{query.module === "all" ? "All notification types" : "All types in this module"}</option>
                        {typeOptions.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
                    </select>
                    <select
                        aria-label="Date range"
                        value={preset}
                        onChange={(event) => {
                            const chosen = RANGE_PRESETS.find((item) => item.id === event.target.value)
                            if (chosen) { const to = appDate(); update({ from: shiftDate(to, -(chosen.days - 1)), to }) }
                        }}
                        className={SELECT_CLASS}
                    >
                        {RANGE_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                        <option value="custom" disabled={preset !== "custom"}>Custom range</option>
                    </select>
                    <Button type="button" variant="outline" size="sm" className="h-9" aria-expanded={moreFilters} aria-controls="monitor-more-filters" onClick={() => setMoreFilters((open) => !open)}>
                        <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />More filters{query.provider !== "all" ? " (1)" : ""}
                    </Button>
                </div>
                {moreFilters ? (
                    <div id="monitor-more-filters" className="grid grid-cols-1 gap-2 border-t border-slate-100 pt-2 sm:grid-cols-4">
                        <label className="text-xs text-slate-600">From
                            <Input type="date" value={query.from} max={query.to} onChange={(event) => event.target.value && update({ from: event.target.value })} className="mt-1 h-9" />
                        </label>
                        <label className="text-xs text-slate-600">To
                            <Input type="date" value={query.to} min={query.from} onChange={(event) => event.target.value && update({ to: event.target.value })} className="mt-1 h-9" />
                        </label>
                        <label className="text-xs text-slate-600">Provider
                            <select value={query.provider} onChange={(event) => update({ provider: event.target.value })} className={`${SELECT_CLASS} mt-1`}>
                                <option value="all">All providers</option>
                                {(data?.facets.providers || []).map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
                            </select>
                        </label>
                    </div>
                ) : null}
                <p className="text-xs text-slate-500">
                    Showing <span className="font-medium text-slate-700">{formatRange(query.from, query.to)}</span> (Malaysia time). Counts and table use the same range and filters.
                </p>
            </section>

            {/* WhatsApp: original notifications vs recovery messages */}
            {query.channel === "whatsapp" ? (
                <div role="group" aria-label="Message kind" className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-xs">
                    {(["original", "recovery"] as MonitorKind[]).map((kind) => (
                        <button
                            key={kind}
                            type="button"
                            aria-pressed={query.kind === kind}
                            onClick={() => query.kind !== kind && update({ kind, status: "all" })}
                            className={`rounded px-2.5 py-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40 ${query.kind === kind ? "bg-white text-[var(--sera-orange)] shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
                        >
                            {kind === "original" ? "Original notifications" : "Recovery messages"} ({data?.kindCounts[kind] ?? "–"})
                        </button>
                    ))}
                </div>
            ) : null}

            {/* Summary cards = the single status selector */}
            <div role="group" aria-label="Status" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
                {(["all", ...statuses] as const).map((status) => {
                    const count = status === "all" ? data?.matchingBeforeStatus : data?.statusCounts[status]
                    const active = query.status === status
                    return (
                        <button
                            key={status}
                            type="button"
                            aria-pressed={active}
                            onClick={() => update({ status })}
                            title={status === "all" ? "Every status" : STATUS_MEANINGS[status]}
                            className={`rounded-lg border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40 ${active ? "border-[var(--sera-orange)] bg-orange-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                        >
                            <span className="block text-xs text-slate-500">{status === "all" ? "All" : STATUS_LABELS[status]}</span>
                            <span className="block text-lg font-semibold tabular-nums text-slate-900">{count ?? "–"}</span>
                            <span className="block truncate text-[10px] text-slate-400">{status === "all" ? "Every status" : STATUS_MEANINGS[status]}</span>
                        </button>
                    )
                })}
            </div>
            {data ? <p className="flex items-start gap-1.5 text-xs text-slate-500"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{data.capabilityNote}</p> : null}
            {data?.truncated ? (
                <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                    This range has more than {data.sourceLimit.toLocaleString()} records in one source, so only the latest {data.sourceLimit.toLocaleString()} per source are included. Narrow the date range for complete counts.
                </p>
            ) : null}

            {/* Table */}
            <section aria-label="Notification activity" className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-xs text-slate-600">
                    <span role="status" aria-live="polite">
                        {loading ? "Loading…" : `${data?.total ?? 0} result${data?.total === 1 ? "" : "s"}`}
                        {selectedRows.length ? ` · ${selectedRows.length} selected` : ""}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                        {selectedRows.length ? (
                            <>
                                {query.channel === "whatsapp" ? (
                                    <Button size="sm" className="h-8 bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange)]/90" disabled={selectedRecoverable.length === 0 || recovery.busy} onClick={() => recovery.bulk("Send recovery message to selected", selectedRecoverable.map(toTarget))}>
                                        <Send className="mr-1.5 h-3.5 w-3.5" />Send recovery message ({selectedRecoverable.length} failed)
                                    </Button>
                                ) : null}
                                <Button size="sm" variant="ghost" className="h-8" onClick={() => setSelected(new Map())}>Clear selection</Button>
                            </>
                        ) : null}
                        <ActionMenu
                            trigger={(
                                <Button size="sm" variant="outline" className="h-8" disabled={exporting}>
                                    {exporting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}Export
                                </Button>
                            )}
                            items={[
                                { label: `All matching results (${data?.total ?? 0})`, disabled: !data?.total, onSelect: () => void exportAll() },
                                { label: `Selected rows only (${selectedRows.length})`, disabled: !selectedRows.length, onSelect: exportSelected },
                            ]}
                        />
                    </div>
                </div>

                {error ? (
                    <p className="flex items-center gap-2 p-4 text-sm text-red-700"><AlertCircle className="h-4 w-4" />{error}</p>
                ) : !loading && pageRows.length === 0 ? (
                    <p className="p-8 text-center text-sm text-slate-500">No {channelLabel} activity matches these filters in {formatRange(query.from, query.to)}.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[760px] text-left text-sm">
                            <thead className="bg-slate-50 text-xs text-slate-500">
                                <tr>
                                    <th className="w-8 px-3 py-2"><Checkbox aria-label="Select all rows on this page" checked={allOnPageSelected} onCheckedChange={(checked) => togglePage(!!checked)} /></th>
                                    <th className="px-2 py-2 font-medium">Time</th>
                                    <th className="px-2 py-2 font-medium">Recipient</th>
                                    <th className="px-2 py-2 font-medium">Notification</th>
                                    <th className="px-2 py-2 font-medium">Reference</th>
                                    <th className="px-2 py-2 font-medium">Status</th>
                                    <th className="px-2 py-2 text-right font-medium">Details</th>
                                </tr>
                            </thead>
                            <tbody className={`divide-y divide-slate-100 ${loading ? "opacity-60" : ""}`}>
                                {pageRows.map((row) => {
                                    const summary = row.status === "failed" ? errorSummary(row.errorMessage) : null
                                    return (
                                        <tr key={row.id} className="align-top hover:bg-slate-50/60">
                                            <td className="px-3 py-2.5"><Checkbox aria-label={`Select ${row.notificationName} to ${row.recipient || "unknown"}`} checked={selected.has(row.id)} onCheckedChange={() => toggleRow(row)} /></td>
                                            <td className="whitespace-nowrap px-2 py-2.5 text-xs text-slate-600">{formatMonitorTime(row.createdAt)}</td>
                                            <td className="max-w-[200px] px-2 py-2.5">
                                                {row.recipientName ? <div className="truncate text-slate-900">{row.recipientName}</div> : null}
                                                <div className={`truncate font-mono text-xs ${row.recipientName ? "text-slate-500" : "text-slate-800"}`}>{row.recipient || "—"}</div>
                                                {row.organizationName ? <div className="truncate text-[11px] text-slate-500">{row.organizationName}</div> : null}
                                            </td>
                                            <td className="max-w-[240px] px-2 py-2.5">
                                                <div className="truncate text-slate-900">{row.notificationName}</div>
                                                <div className="truncate text-xs text-slate-500">{row.moduleName}</div>
                                            </td>
                                            <td className="max-w-[160px] px-2 py-2.5 text-xs">{row.reference ? <span className="block truncate font-mono text-slate-700" title={row.reference.id || undefined}>{row.reference.label}</span> : <span className="text-slate-400">—</span>}</td>
                                            <td className="px-2 py-2.5">
                                                <StatusBadge status={row.status} />
                                                {summary ? <div className="mt-0.5 max-w-[200px] truncate text-[11px] text-red-600" title={row.errorMessage || undefined}>{summary}</div> : null}
                                                {row.recovery ? <div className="mt-0.5 text-[11px] text-slate-500">Recovery {row.recovery.status.replace(/_/g, " ")}</div> : null}
                                            </td>
                                            <td className="px-2 py-2.5 text-right">
                                                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-[var(--sera-orange)]" onClick={() => setDetails(row)} aria-label={`Details for ${row.notificationName} to ${row.recipient || "unknown"}`}>View</Button>
                                            </td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}

                {data && data.totalPages > 1 ? (
                    <nav aria-label="Pagination" className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
                        <span>Page {data.filters.page} of {data.totalPages}</span>
                        <div className="flex gap-2">
                            <Button size="sm" variant="outline" className="h-8" disabled={data.filters.page <= 1 || loading} onClick={() => setQuery((current) => ({ ...current, page: data.filters.page - 1 }))}>Previous</Button>
                            <Button size="sm" variant="outline" className="h-8" disabled={data.filters.page >= data.totalPages || loading} onClick={() => setQuery((current) => ({ ...current, page: data.filters.page + 1 }))}>Next</Button>
                        </div>
                    </nav>
                ) : null}
            </section>

            <MonitorDetailsSheet
                record={details}
                onClose={() => setDetails(null)}
                onRecover={(record) => recovery.confirm(toTarget(record))}
                onCustomRecover={(record) => recovery.customForOne(toTarget(record))}
                onClear={(record) => { setDetails(null); recovery.clear(toTarget(record)) }}
                onEditSms={(record) => setSmsEdit({ record, phone: record.recipient || "", message: record.message || "", saving: false, error: null })}
            />
            {recovery.dialogs}

            <Dialog open={smsCheck.open} onOpenChange={(open) => !smsCheck.sending && setSmsCheck((state) => ({ ...state, open }))}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Send a test SMS</DialogTitle>
                        <DialogDescription>Sends one SMS check through the active SMS provider to the number you enter. Nothing is sent until you click Send.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-1.5">
                        <Label htmlFor="sms-check-phone">Phone number</Label>
                        <Input id="sms-check-phone" placeholder="0123456789 or +60123456789" value={smsCheck.phone} onChange={(event) => setSmsCheck((state) => ({ ...state, phone: event.target.value }))} />
                        <Label htmlFor="sms-check-message" className="pt-1">Message</Label>
                        <Textarea id="sms-check-message" rows={3} placeholder="Leave empty to use the saved SMS Delivery Check template" value={smsCheck.message} onChange={(event) => setSmsCheck((state) => ({ ...state, message: event.target.value }))} />
                        {smsCheck.result ? <p role="status" className="text-xs text-slate-600">{smsCheck.result}</p> : null}
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setSmsCheck((state) => ({ ...state, open: false }))} disabled={smsCheck.sending}>Close</Button>
                        <Button onClick={sendSmsCheck} disabled={smsCheck.sending || !smsCheck.phone.trim()}>
                            {smsCheck.sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}Send test SMS
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!smsEdit} onOpenChange={(open) => { if (!open && !smsEdit?.saving) setSmsEdit(null) }}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Edit / resend SMS</DialogTitle>
                        <DialogDescription>Change the number and message for this SMS. Save keeps the record; Save &amp; send sends it now through the SMS provider.</DialogDescription>
                    </DialogHeader>
                    {smsEdit ? (
                        <div className="space-y-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="sms-edit-phone">Phone</Label>
                                <Input id="sms-edit-phone" value={smsEdit.phone} disabled={smsEdit.saving} onChange={(event) => setSmsEdit({ ...smsEdit, phone: event.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="sms-edit-message">Message</Label>
                                <Textarea id="sms-edit-message" rows={6} value={smsEdit.message} disabled={smsEdit.saving} placeholder={smsEdit.record.message ? "" : "Original body was not stored. Enter the text to send."} onChange={(event) => setSmsEdit({ ...smsEdit, message: event.target.value })} />
                            </div>
                            {smsEdit.error ? <p className="text-sm text-red-600">{smsEdit.error}</p> : null}
                        </div>
                    ) : null}
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setSmsEdit(null)} disabled={smsEdit?.saving}>Cancel</Button>
                        <Button variant="secondary" onClick={() => saveSmsEdit(false)} disabled={smsEdit?.saving}>Save</Button>
                        <Button onClick={() => saveSmsEdit(true)} disabled={smsEdit?.saving}>
                            {smsEdit?.saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}Save &amp; send
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {toast ? (
                <div role="status" className={`fixed bottom-4 right-4 z-50 rounded-lg border px-4 py-3 text-sm shadow-lg ${toast.kind === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
                    <div className="flex items-center gap-2">{toast.kind === "ok" ? <CheckCheck className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}{toast.text}</div>
                </div>
            ) : null}
        </div>
    )
}
