'use client'
/**
 * Data tab — KPI actuals, source mappings, validation queue, source health.
 *
 * Top stat cards: Connected Sources / Recent Imports / Pending Validation / Metrics Updated
 * Right-side actions: Import Data / Map Sources
 * Main: KPI Actuals table (left) + Recent Imports / Validation Queue / Source Health (right)
 *
 * Backed by:
 *   GET  /api/hr/kpi/actuals?period_id=…
 *   GET  /api/hr/kpi/data-mappings
 *   POST /api/hr/kpi/data-mappings/{id}/validate
 *   POST /api/hr/kpi/data-mappings  (used by Map Sources dialog)
 *   GET  /api/hr/kpi/metrics
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    Database, Upload, ShieldCheck, TrendingUp, Search, Filter, Columns3, MoreHorizontal,
    Eye, Loader2, Plus, Link2, ArrowUp, ArrowDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import {
    KPIStatCard, KPIStatusBadge, KPIEmptyState, KPICenteredLoader, KPIChartCard,
    PerspectiveLabel,
} from '../shared'
import { kpiFetch, Metric, formatDate } from '../types'

// ── Types ────────────────────────────────────────────────────────
interface Actual {
    id: string
    period_id: string
    assignment_id: string
    metric_id: string
    actual_value: number | null
    actual_unit?: string | null
    calculated_at?: string | null
    calculation_source?: string | null
    status: string
    hr_kpi_metrics?: {
        kpi_code: string
        name: string
        unit: string
        perspective?: string | null
        measurement_direction?: string | null
    }
    hr_kpi_periods?: { name: string }
}

interface DataMapping {
    id: string
    metric_id: string
    calculation_type: string
    source_module: string | null
    source_table: string | null
    validation_status: string
    last_validated_at: string | null
    last_error: string | null
    hr_kpi_metrics?: { kpi_code: string; name: string }
}

// ── Helpers ──────────────────────────────────────────────────────
function sourceLabel(m?: DataMapping | null) {
    if (!m) return { label: 'Manual', module: 'manual' }
    if (m.calculation_type === 'manual') return { label: 'Manual entry', module: 'manual' }
    const mod = m.source_module ?? 'system'
    return { label: m.source_table ? `${mod} · ${m.source_table}` : mod, module: mod }
}

function healthTone(status: string): 'emerald' | 'amber' | 'red' | 'slate' {
    if (status === 'valid' || status === 'mapped') return 'emerald'
    if (status === 'failed' || status === 'invalid') return 'red'
    if (status === 'unmapped') return 'slate'
    return 'amber'
}

function healthLabel(status: string) {
    if (status === 'valid' || status === 'mapped') return 'Healthy'
    if (status === 'failed' || status === 'invalid') return 'Failed'
    if (status === 'unmapped') return 'Unmapped'
    return 'Degraded'
}

// ── Main ─────────────────────────────────────────────────────────
export function KPIDataTab({ periodId }: { periodId: string | null }) {
    const [actuals, setActuals] = useState<Actual[]>([])
    const [mappings, setMappings] = useState<DataMapping[]>([])
    const [metrics, setMetrics] = useState<Metric[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [sourceFilter, setSourceFilter] = useState<string>('all')
    const [openMap, setOpenMap] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        const [a, dm, m] = await Promise.all([
            periodId
                ? kpiFetch<Actual[]>(`/api/hr/kpi/actuals?period_id=${periodId}`)
                : Promise.resolve<{ success: boolean; data?: Actual[]; error?: string }>({ success: true, data: [] }),
            kpiFetch<DataMapping[]>('/api/hr/kpi/data-mappings'),
            kpiFetch<Metric[]>('/api/hr/kpi/metrics'),
        ])
        if (!a.success) setError(a.error ?? 'Failed to load actuals')
        if (a.success && a.data) setActuals(a.data)
        if (dm.success && dm.data) setMappings(dm.data)
        if (m.success && m.data) setMetrics(m.data)
        setLoading(false)
    }, [periodId])

    useEffect(() => { load() }, [load])

    // Index mapping by metric_id for quick lookup
    const mappingByMetric = useMemo(() => {
        const map: Record<string, DataMapping> = {}
        for (const m of mappings) map[m.metric_id] = m
        return map
    }, [mappings])

    // Group sources for "Connected Sources" / "Source Health"
    const sources = useMemo(() => {
        const grouped: Record<string, { module: string; mappings: DataMapping[] }> = {}
        for (const m of mappings) {
            const key = m.source_module ?? (m.calculation_type === 'manual' ? 'manual' : 'unknown')
            if (!grouped[key]) grouped[key] = { module: key, mappings: [] }
            grouped[key].mappings.push(m)
        }
        return Object.values(grouped)
    }, [mappings])

    const stats = useMemo(() => {
        const validatedMappings = mappings.filter(m => m.validation_status === 'valid' || m.validation_status === 'mapped').length
        const pending = mappings.filter(m => m.validation_status === 'pending' || m.validation_status === 'unmapped' || m.validation_status === 'draft').length
        // "Recent Imports" = unique mappings validated in the last 7 days (best-effort using last_validated_at)
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
        const recent = mappings.filter(m => m.last_validated_at && new Date(m.last_validated_at).getTime() >= sevenDaysAgo).length
        return {
            connectedSources: sources.length,
            activeSources: sources.filter(s => s.mappings.some(m => m.validation_status === 'valid' || m.validation_status === 'mapped')).length,
            inactiveSources: Math.max(0, sources.length - sources.filter(s => s.mappings.some(m => m.validation_status === 'valid' || m.validation_status === 'mapped')).length),
            recentImports: recent,
            pendingValidation: pending,
            metricsUpdated: actuals.length,
            lastSync: actuals.reduce<string | null>((acc, a) => {
                const ts = a.calculated_at
                if (!ts) return acc
                if (!acc) return ts
                return new Date(ts) > new Date(acc) ? ts : acc
            }, null),
            validatedMappings,
        }
    }, [sources, mappings, actuals])

    const filtered = useMemo(() => {
        const s = search.trim().toLowerCase()
        return actuals.filter(a => {
            if (sourceFilter !== 'all') {
                const m = mappingByMetric[a.metric_id]
                const mod = m?.source_module ?? (m?.calculation_type === 'manual' ? 'manual' : 'unknown')
                if (mod !== sourceFilter) return false
            }
            if (!s) return true
            const hay = [a.hr_kpi_metrics?.name, a.hr_kpi_metrics?.kpi_code].filter(Boolean).join(' ').toLowerCase()
            return hay.includes(s)
        })
    }, [actuals, search, sourceFilter, mappingByMetric])

    // Source health list
    const sourceHealth = sources.map(s => {
        const failing = s.mappings.some(m => m.validation_status === 'failed' || m.validation_status === 'invalid')
        const allOk = s.mappings.every(m => m.validation_status === 'valid' || m.validation_status === 'mapped')
        const lastSync = s.mappings.reduce<string | null>((acc, m) => {
            if (!m.last_validated_at) return acc
            if (!acc) return m.last_validated_at
            return new Date(m.last_validated_at) > new Date(acc) ? m.last_validated_at : acc
        }, null)
        return {
            module: s.module,
            count: s.mappings.length,
            status: failing ? 'failed' : allOk ? 'valid' : 'pending',
            lastSync,
        }
    })

    // Recent imports list (rendered as mapping validation events)
    const recentImports = mappings
        .filter(m => m.last_validated_at)
        .sort((a, b) => new Date(b.last_validated_at!).getTime() - new Date(a.last_validated_at!).getTime())
        .slice(0, 6)

    // Validation queue: pending / unmapped mappings
    const validationQueue = mappings.filter(m =>
        m.validation_status === 'pending'
        || m.validation_status === 'unmapped'
        || m.validation_status === 'draft',
    ).slice(0, 6)

    async function validate(id: string) {
        const r = await kpiFetch(`/api/hr/kpi/data-mappings/${id}/validate`, { method: 'POST' })
        if (r.success) {
            toast({ title: 'Validated' })
            load()
        } else {
            toast({ title: 'Failed', description: r.error, variant: 'destructive' })
        }
    }

    return (
        <div className="space-y-4 mt-4">
            {/* Top stat cards + right actions */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
                <KPIStatCard
                    label="Connected Sources" value={stats.connectedSources}
                    hint={`${stats.activeSources} Active · ${stats.inactiveSources} Inactive`}
                    icon={<Database className="h-4 w-4" />} tone="blue"
                />
                <KPIStatCard
                    label="Recent Imports" value={stats.recentImports}
                    hint="Last 7 days"
                    icon={<Upload className="h-4 w-4" />} tone="emerald"
                />
                <KPIStatCard
                    label="Pending Validation" value={stats.pendingValidation}
                    hint={stats.pendingValidation > 0 ? `Across ${sources.length} sources` : 'All clean'}
                    icon={<ShieldCheck className="h-4 w-4" />}
                    tone={stats.pendingValidation > 0 ? 'amber' : 'slate'}
                />
                <KPIStatCard
                    label="Metrics Updated" value={stats.metricsUpdated}
                    hint={stats.lastSync ? `Last sync: ${formatDate(stats.lastSync)}` : 'No actuals yet'}
                    icon={<TrendingUp className="h-4 w-4" />} tone="blue"
                />
                <div className="grid grid-rows-2 gap-2">
                    <Button disabled title="Import flow not available yet" className="bg-blue-600 hover:bg-blue-700 text-white h-full justify-center">
                        <Upload className="h-4 w-4 mr-1.5" />Import Data
                    </Button>
                    <Button variant="outline" onClick={() => setOpenMap(true)} className="h-full justify-center">
                        <Link2 className="h-4 w-4 mr-1.5" />Map Sources
                    </Button>
                </div>
            </div>

            {/* Main: actuals table + right column */}
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4">
                <div className="rounded-lg border border-slate-200 bg-white shadow-[0_1px_2px_0_rgba(0,0,0,0.04)] overflow-hidden">
                    {/* Toolbar */}
                    <div className="px-4 py-3 border-b border-slate-100 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                            <h3 className="text-sm font-semibold text-slate-900">KPI Actuals</h3>
                            <p className="text-xs text-slate-500 mt-0.5">Latest actual values for all tracked KPI metrics.</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="relative">
                                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                                <Input
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    placeholder="Search metrics…"
                                    className="pl-8 h-9 w-[200px]"
                                />
                            </div>
                            <Select value={sourceFilter} onValueChange={setSourceFilter}>
                                <SelectTrigger className="w-[140px] h-9">
                                    <Filter className="h-3.5 w-3.5 mr-1.5" />
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Sources</SelectItem>
                                    {sources.map(s => (
                                        <SelectItem key={s.module} value={s.module}>{s.module}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Button variant="outline" size="sm" disabled title="Column controls not available yet">
                                <Columns3 className="h-3.5 w-3.5 mr-1.5" />Columns
                            </Button>
                            <Button variant="ghost" size="icon" disabled title="More actions not available yet" className="h-9 w-9">
                                <MoreHorizontal className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    {loading ? (
                        <KPICenteredLoader />
                    ) : error ? (
                        <KPIEmptyState
                            title="Unable to load actuals"
                            description={error}
                            actions={<Button size="sm" variant="outline" onClick={load}>Retry</Button>}
                        />
                    ) : actuals.length === 0 ? (
                        <KPIEmptyState
                            title="No KPI actuals imported yet"
                            description="Import actual values or map sources so scorecards can be calculated."
                            actions={(
                                <>
                                    <Button size="sm" disabled title="Import flow not available yet"><Upload className="h-3.5 w-3.5 mr-1.5" />Import Data</Button>
                                    <Button size="sm" variant="outline" onClick={() => setOpenMap(true)}><Link2 className="h-3.5 w-3.5 mr-1.5" />Map Sources</Button>
                                </>
                            )}
                        />
                    ) : filtered.length === 0 ? (
                        <KPIEmptyState
                            title="No matching actuals"
                            description="Try a different search or source filter."
                            searchMode
                        />
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow className="bg-slate-50/60 hover:bg-slate-50/60 border-slate-100">
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide">Metric</TableHead>
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide">Source</TableHead>
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide text-right">Latest Value</TableHead>
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide">Period</TableHead>
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide">Last Sync</TableHead>
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide">Validation Status</TableHead>
                                        <TableHead className="h-9 text-[11px] font-semibold uppercase text-slate-500 tracking-wide text-right">Actions</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {filtered.map(a => {
                                        const mp = mappingByMetric[a.metric_id]
                                        const src = sourceLabel(mp)
                                        const unit = a.actual_unit ?? a.hr_kpi_metrics?.unit ?? ''
                                        return (
                                            <TableRow key={a.id} className="border-slate-100 hover:bg-slate-50/60">
                                                <TableCell className="py-2.5">
                                                    <div className="flex items-center gap-2">
                                                        {a.hr_kpi_metrics?.perspective ? (
                                                            <PerspectiveLabel value={a.hr_kpi_metrics.perspective} />
                                                        ) : (
                                                            <span className="h-1.5 w-1.5 rounded-full bg-slate-400 inline-block" />
                                                        )}
                                                        <span className="font-medium text-slate-900 text-sm">
                                                            {a.hr_kpi_metrics?.name ?? 'Unknown'}
                                                            {a.hr_kpi_metrics?.kpi_code && <span className="text-slate-400 font-mono text-[11px] ml-1">({a.hr_kpi_metrics.kpi_code})</span>}
                                                        </span>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="py-2.5 text-xs text-slate-700">
                                                    <span className="inline-flex items-center gap-1.5 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px]">{src.label}</span>
                                                </TableCell>
                                                <TableCell className="py-2.5 text-right tabular-nums text-sm text-slate-900 font-medium">
                                                    {a.actual_value != null ? Number(a.actual_value).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}{unit && <span className="text-slate-500 text-xs"> {unit}</span>}
                                                </TableCell>
                                                <TableCell className="py-2.5 text-xs text-slate-700">{a.hr_kpi_periods?.name ?? '—'}</TableCell>
                                                <TableCell className="py-2.5 text-xs text-slate-500">{formatDate(a.calculated_at)}</TableCell>
                                                <TableCell className="py-2.5"><KPIStatusBadge value={a.status} /></TableCell>
                                                <TableCell className="py-2.5 text-right">
                                                    <Button variant="ghost" size="icon" disabled title="View not available yet" className="h-7 w-7">
                                                        <Eye className="h-3.5 w-3.5" />
                                                    </Button>
                                                    <Button variant="ghost" size="icon" disabled title="Row menu not available yet" className="h-7 w-7">
                                                        <MoreHorizontal className="h-3.5 w-3.5" />
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                            <div className="px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
                                Showing 1 to {filtered.length} of {actuals.length} metrics
                            </div>
                        </div>
                    )}
                </div>

                {/* Right column */}
                <div className="space-y-4">
                    <KPIChartCard
                        title="Recent Imports"
                        action={<button className="text-xs text-blue-600 hover:underline" disabled title="Not available yet">View All</button>}
                    >
                        {recentImports.length === 0 ? (
                            <p className="text-xs text-slate-400 py-2">No recent imports.</p>
                        ) : (
                            <ul className="space-y-2.5">
                                {recentImports.map(m => (
                                    <li key={m.id} className="flex items-start justify-between gap-2 text-sm">
                                        <div className="min-w-0">
                                            <div className="font-medium text-slate-800 text-xs truncate">
                                                {m.source_module ?? m.calculation_type} {m.source_table && `· ${m.source_table}`}
                                            </div>
                                            <div className="text-[11px] text-slate-500">
                                                {m.hr_kpi_metrics?.name ?? 'Metric'} · {formatDate(m.last_validated_at)}
                                            </div>
                                        </div>
                                        <KPIStatusBadge value={m.validation_status} />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </KPIChartCard>

                    <KPIChartCard
                        title="Validation Queue"
                        description={validationQueue.length > 0 ? `${validationQueue.length} mappings need attention` : 'All mappings validated'}
                    >
                        {validationQueue.length === 0 ? (
                            <p className="text-xs text-slate-400 py-2">No items pending.</p>
                        ) : (
                            <ul className="space-y-2.5">
                                {validationQueue.map(m => (
                                    <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                                        <div className="min-w-0">
                                            <div className="font-medium text-slate-800 text-xs truncate">
                                                {m.hr_kpi_metrics?.name ?? 'Metric'}
                                            </div>
                                            <div className="text-[11px] text-slate-500">
                                                {m.source_module ?? m.calculation_type}
                                            </div>
                                        </div>
                                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => validate(m.id)}>Validate</Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </KPIChartCard>

                    <KPIChartCard
                        title="Source Health"
                        action={<button className="text-xs text-blue-600 hover:underline" disabled title="Not available yet">View All</button>}
                    >
                        {sourceHealth.length === 0 ? (
                            <p className="text-xs text-slate-400 py-2">No sources connected.</p>
                        ) : (
                            <ul className="space-y-2">
                                {sourceHealth.map(h => (
                                    <li key={h.module} className="flex items-center justify-between gap-2 text-sm">
                                        <div className="min-w-0">
                                            <div className="font-medium text-slate-800 text-xs capitalize truncate">{h.module}</div>
                                            <div className="text-[11px] text-slate-500">
                                                {h.lastSync ? `Last sync: ${formatDate(h.lastSync)}` : 'Never synced'} · {h.count} mappings
                                            </div>
                                        </div>
                                        <span className={cn(
                                            'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize',
                                            h.status === 'failed' ? 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200' :
                                                h.status === 'valid' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200' :
                                                    'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200',
                                        )}>
                                            {healthLabel(h.status)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </KPIChartCard>
                </div>
            </div>

            {openMap && (
                <MapSourceDialog
                    open={openMap}
                    onClose={() => setOpenMap(false)}
                    metrics={metrics}
                    onCreated={load}
                />
            )}
        </div>
    )
}

// ── Map Source dialog ────────────────────────────────────────────
function MapSourceDialog({
    open, onClose, metrics, onCreated,
}: { open: boolean; onClose: () => void; metrics: Metric[]; onCreated: () => void }) {
    const [form, setForm] = useState({
        metric_id: '',
        calculation_type: 'manual',
        source_module: '',
        source_table: '',
    })
    const [saving, setSaving] = useState(false)

    async function save() {
        if (!form.metric_id) {
            toast({ title: 'Select a metric', variant: 'destructive' })
            return
        }
        setSaving(true)
        const payload: any = {
            metric_id: form.metric_id,
            calculation_type: form.calculation_type,
        }
        if (form.calculation_type !== 'manual') {
            if (form.source_module) payload.source_module = form.source_module
            if (form.source_table) payload.source_table = form.source_table
        }
        const r = await kpiFetch('/api/hr/kpi/data-mappings', { method: 'POST', body: JSON.stringify(payload) })
        setSaving(false)
        if (r.success) {
            toast({ title: 'Mapping saved' })
            onCreated()
            onClose()
        } else {
            toast({ title: 'Failed', description: r.error, variant: 'destructive' })
        }
    }

    return (
        <Dialog open={open} onOpenChange={o => !o && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Map Data Source</DialogTitle>
                    <DialogDescription>Link a metric to a data source for automatic calculation.</DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                    <div>
                        <Label>Metric *</Label>
                        <Select value={form.metric_id} onValueChange={v => setForm(f => ({ ...f, metric_id: v }))}>
                            <SelectTrigger><SelectValue placeholder="Choose a metric" /></SelectTrigger>
                            <SelectContent>
                                {metrics.length === 0 ? (
                                    <div className="px-2 py-3 text-xs text-slate-500">No metrics available.</div>
                                ) : metrics.map(m => (
                                    <SelectItem key={m.id} value={m.id}>{m.name} <span className="font-mono text-[10px] text-slate-500 ml-1">{m.kpi_code}</span></SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div>
                        <Label>Calculation Type</Label>
                        <Select value={form.calculation_type} onValueChange={v => setForm(f => ({ ...f, calculation_type: v }))}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="manual">Manual</SelectItem>
                                <SelectItem value="auto">Auto</SelectItem>
                                <SelectItem value="hybrid">Hybrid</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    {form.calculation_type !== 'manual' && (
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <Label>Source Module</Label>
                                <Input value={form.source_module} onChange={e => setForm(f => ({ ...f, source_module: e.target.value }))} placeholder="e.g. orders" />
                            </div>
                            <div>
                                <Label>Source Table</Label>
                                <Input value={form.source_table} onChange={e => setForm(f => ({ ...f, source_table: e.target.value }))} placeholder="e.g. sales_orders" />
                            </div>
                        </div>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
                    <Button onClick={save} disabled={saving || !form.metric_id}>
                        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
