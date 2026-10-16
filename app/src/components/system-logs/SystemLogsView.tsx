'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, RefreshCw, ScrollText, Search } from 'lucide-react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useToast } from '@/components/ui/use-toast'
import { LOG_CATEGORIES, LOG_ENVIRONMENTS } from '@/lib/system-logs/contract'
import { MODULE_OPTIONS } from '@/lib/system-logs/query'
import { buildDiagnosticReport, type LogEventDetail } from '@/lib/system-logs/report'
import { useSystemLogsAccessInfo } from './useSystemLogsAccess'

/**
 * Settings → System → System Logs. Two tabs:
 *   Errors         stored diagnostic occurrences (default: last 24 hours, this server's environment, severity error)
 *   User Activity  important business/security actions from authoritative server records only
 * Server-side keyset pagination; every request is authorized by /api/system-logs (platform.system_logs.view).
 */

type Tab = 'errors' | 'activity'
type ListState = 'loading' | 'ok' | 'not_installed' | 'unavailable' | 'denied' | 'error'

interface Filters {
  range: '1h' | '24h' | '7d' | '30d' | 'custom'
  from: string
  to: string
  user: string
  module: string
  environment: string
  severity: string
  category: string
  outcome: string
  q: string
}

const RANGE_MS: Record<Exclude<Filters['range'], 'custom'>, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }
const PAGE_SIZE = 50
const INPUT = 'h-9 rounded-md border border-gray-200 bg-white px-2 text-sm text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500'

const defaultFilters = (tab: Tab, environment = ''): Filters => ({
  range: tab === 'errors' ? '24h' : '7d', from: '', to: '', user: '', module: '', environment: tab === 'errors' ? environment : '',
  severity: tab === 'errors' ? 'error' : '', category: '', outcome: '', q: '',
})

const ACTIVITY_LABELS: Record<string, string> = {
  'order.created': 'Order created', 'order.created_submitted': 'Order created and submitted', 'order.submitted': 'Order submitted',
  'order.updated': 'Order edited', 'order.approved': 'Order approved', 'order.cancelled': 'Order cancelled', 'order.status_changed': 'Order status changed',
  'assignment.granted': 'Group Policy granted', 'assignment.revoked': 'Group Policy revoked', 'assignment.restored': 'Group Policy restored',
  'assignment.removed': 'Group Policy removed', 'identity.status_changed': 'Account status changed', 'identity.reactivated': 'Account reactivated',
  'lifecycle.suspended': 'Access suspended (lifecycle)', 'lifecycle.leaver': 'Access ended (leaver)', 'user.password_reset': 'Administrative password reset',
  'migration_mode.changed': 'Migration mode changed', 'migration_mode.bulk_changed': 'Migration modes changed (bulk)', 'access_request.submitted': 'Access request submitted',
}

function formatTime(iso?: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function ResultBadge({ row, tab }: { row: any; tab: Tab }) {
  if (tab === 'activity') {
    const tone = row.outcome === 'success' ? 'bg-emerald-50 text-emerald-700' : row.outcome === 'denied' ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-700'
    return <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>{row.outcome ?? '—'}</span>
  }
  const tone = row.severity === 'error' ? 'bg-rose-50 text-rose-700' : row.severity === 'warning' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-700'
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {row.category ?? row.severity}{row.http_status ? ` · ${row.http_status}` : ''}
    </span>
  )
}

const actionOf = (row: any, tab: Tab) => tab === 'activity'
  ? (ACTIVITY_LABELS[row.action] ?? row.action)
  : (row.action || row.page_path || row.api_route || '—')
const referenceOf = (row: any, tab: Tab) => tab === 'activity' ? (row.reference_id || row.correlation_id || row.entity_id || '—') : row.reference_id

export default function SystemLogsView() {
  const access = useSystemLogsAccessInfo()
  const { toast } = useToast()
  const [tab, setTab] = useState<Tab>('errors')
  const [filters, setFilters] = useState<Filters>(defaultFilters('errors'))
  const [envInitialized, setEnvInitialized] = useState(false)
  const [searchDraft, setSearchDraft] = useState('')
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const [state, setState] = useState<ListState>('loading')
  const [rows, setRows] = useState<any[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ environment?: string; window?: { from: string; to: string } }>({})
  const [selected, setSelected] = useState<any | null>(null)
  const [knownUsers, setKnownUsers] = useState<Record<string, string>>({})
  const requestSeq = useRef(0)
  // Relative ranges are re-anchored to "now" on every refresh.
  const [tick, setTick] = useState(0)

  // Default the environment filter to this server's own environment (keeps localhost noise out of staging results).
  useEffect(() => {
    if (!access || envInitialized) return
    setEnvInitialized(true)
    if (access.environment) setFilters(f => (tab === 'errors' && !f.environment ? { ...f, environment: access.environment! } : f))
  }, [access, envInitialized, tab])

  const query = useMemo(() => {
    const p = new URLSearchParams({ tab, limit: String(PAGE_SIZE) })
    if (filters.range === 'custom') {
      if (filters.from) p.set('from', new Date(filters.from).toISOString())
      if (filters.to) p.set('to', new Date(filters.to).toISOString())
    } else {
      p.set('from', new Date(Date.now() - RANGE_MS[filters.range]).toISOString())
    }
    for (const key of ['user', 'module', 'q'] as const) if (filters[key]) p.set(key, filters[key])
    if (tab === 'errors') {
      if (filters.environment) p.set('environment', filters.environment)
      if (filters.severity) p.set('severity', filters.severity)
      if (filters.category) p.set('category', filters.category)
    } else if (filters.outcome) p.set('outcome', filters.outcome)
    return p
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, filters, tick])

  const page = cursors.length - 1
  const load = useCallback(async () => {
    if (!envInitialized) return
    const seq = ++requestSeq.current
    setState('loading')
    const p = new URLSearchParams(query)
    const cursor = cursors[cursors.length - 1]
    if (cursor) p.set('cursor', cursor)
    try {
      const res = await fetch(`/api/system-logs?${p.toString()}`, { cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (seq !== requestSeq.current) return
      if (res.status === 401 || res.status === 403) { setState('denied'); setRows([]); return }
      if (!res.ok && body?.state !== 'unavailable') { setState('error'); setRows([]); return }
      setMeta({ environment: body.environment, window: body.window })
      setState(body.state === 'not_installed' ? 'not_installed' : body.state === 'unavailable' ? 'unavailable' : 'ok')
      const items: any[] = Array.isArray(body.items) ? body.items : []
      setRows(items)
      setNextCursor(body.nextCursor ?? null)
      setKnownUsers(prev => {
        const next = { ...prev }
        for (const r of items) if (r.actor_id && (r.actor_name || r.actor_email)) next[r.actor_id] = r.actor_name || r.actor_email
        return next
      })
    } catch {
      if (seq === requestSeq.current) { setState('error'); setRows([]) }
    }
  }, [query, cursors, envInitialized])

  useEffect(() => { void load() }, [load])

  const update = (patch: Partial<Filters>) => { setFilters(f => ({ ...f, ...patch })); setCursors([null]) }
  const switchTab = (next: Tab) => {
    if (next === tab) return
    setTab(next); setFilters(defaultFilters(next, access?.environment ?? '')); setSearchDraft(''); setCursors([null]); setSelected(null)
  }
  const reset = () => { setFilters(defaultFilters(tab, access?.environment ?? '')); setSearchDraft(''); setCursors([null]) }

  // Debounced search (reference id or message).
  useEffect(() => {
    const t = setTimeout(() => { if (searchDraft.trim() !== filters.q) update({ q: searchDraft.trim() }) }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft])

  return (
    <div className="mx-auto w-full max-w-7xl space-y-3 px-3 py-4 sm:px-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-slate-600" aria-hidden />
          <div>
            <h1 className="text-lg font-semibold text-gray-900">System Logs</h1>
            <p className="text-xs text-gray-500">
              Recorded diagnostics and user activity{meta.environment ? <> · this server: <span className="font-medium text-gray-700">{meta.environment}</span></> : null}. Diagnostics are kept 30 days.
            </p>
          </div>
        </div>
        <button type="button" onClick={() => { setCursors([null]); setTick(t => t + 1) }} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50">
          <RefreshCw className={`h-4 w-4 ${state === 'loading' ? 'animate-spin' : ''}`} aria-hidden /> Refresh
        </button>
      </header>

      <div role="tablist" aria-label="System Logs" className="flex gap-1 border-b border-gray-200">
        {(['errors', 'activity'] as Tab[]).map(t => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => switchTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t ? 'border-orange-500 text-orange-700' : 'border-transparent text-gray-600 hover:text-gray-900'}`}>
            {t === 'errors' ? 'Errors' : 'User Activity'}
          </button>
        ))}
      </div>

      <section aria-label="Filters" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <label className="flex flex-col gap-0.5 text-xs text-gray-600">Date range
          <select className={INPUT} value={filters.range} onChange={e => update({ range: e.target.value as Filters['range'] })}>
            <option value="1h">Last hour</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option><option value="custom">Custom…</option>
          </select>
        </label>
        {filters.range === 'custom' && <>
          <label className="flex flex-col gap-0.5 text-xs text-gray-600">From
            <input type="datetime-local" className={INPUT} value={filters.from} onChange={e => update({ from: e.target.value })} />
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-gray-600">To
            <input type="datetime-local" className={INPUT} value={filters.to} onChange={e => update({ to: e.target.value })} />
          </label>
        </>}
        <label className="flex flex-col gap-0.5 text-xs text-gray-600">User
          <select className={INPUT} value={filters.user} onChange={e => update({ user: e.target.value })}>
            <option value="">All users</option>
            {Object.entries(knownUsers).sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-xs text-gray-600">Module
          <select className={INPUT} value={filters.module} onChange={e => update({ module: e.target.value })}>
            <option value="">All modules</option>
            {MODULE_OPTIONS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        {tab === 'errors' ? <>
          <label className="flex flex-col gap-0.5 text-xs text-gray-600">Environment
            <select className={INPUT} value={filters.environment} onChange={e => update({ environment: e.target.value })}>
              <option value="">All environments</option>
              {LOG_ENVIRONMENTS.map(env => <option key={env} value={env}>{env}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-gray-600">Severity
            <select className={INPUT} value={filters.severity} onChange={e => update({ severity: e.target.value })}>
              <option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option><option value="">All</option>
            </select>
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-gray-600">Category
            <select className={INPUT} value={filters.category} onChange={e => update({ category: e.target.value })}>
              <option value="">All categories</option>
              {LOG_CATEGORIES.filter(c => c !== 'cancelled').map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
            </select>
          </label>
        </> : (
          <label className="flex flex-col gap-0.5 text-xs text-gray-600">Result
            <select className={INPUT} value={filters.outcome} onChange={e => update({ outcome: e.target.value })}>
              <option value="">All results</option><option value="success">Success</option><option value="failure">Failed</option><option value="denied">Denied</option>
            </select>
          </label>
        )}
        <label className="col-span-2 flex flex-col gap-0.5 text-xs text-gray-600 sm:col-span-3 lg:col-span-2">Search
          <span className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-gray-400" aria-hidden />
            <input type="search" className={`${INPUT} w-full pl-7`} placeholder={tab === 'errors' ? 'Reference ID or message' : 'Reference, order no. or action'}
              value={searchDraft} onChange={e => setSearchDraft(e.target.value)} maxLength={120} />
          </span>
        </label>
        <div className="flex items-end">
          <button type="button" onClick={reset} className="h-9 text-sm text-gray-600 underline-offset-2 hover:underline">Reset filters</button>
        </div>
      </section>

      {tab === 'activity' && (
        <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Activity comes only from server records: Group Policy grants/revokes, account status changes and lifecycle (Security &amp; Access change log),
          administrative password resets (audit log) and committed order create/submit/edit/status events (database). These records do not carry
          an environment (localhost and staging share the database). Actions before these sources existed are not shown.
        </p>
      )}

      <StateBanner state={state} />

      {state !== 'not_installed' && state !== 'denied' && (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-lg border border-gray-200 bg-white md:block">
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col className="w-40" /><col className="w-36" /><col className="w-32" /><col className="w-48" /><col className="w-28" /><col /><col className="w-40" />
              </colgroup>
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                <tr>{['Time', 'User', 'Module', 'Action / Page', 'Result', 'Message', 'Reference ID'].map(h => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map(row => (
                  <tr key={row.id ?? row.sort_key} tabIndex={0} onClick={() => setSelected(row)} onKeyDown={e => { if (e.key === 'Enter') setSelected(row) }}
                    className="cursor-pointer hover:bg-orange-50/40 focus:bg-orange-50/60 focus:outline-none">
                    <td className="truncate px-3 py-2 text-xs text-gray-600">{formatTime(row.occurred_at)}</td>
                    <td className="truncate px-3 py-2" title={row.actor_email ?? undefined}>{row.actor_name || row.actor_email || <span className="text-gray-400">{row.actor_id ? 'Unknown user' : 'System'}</span>}</td>
                    <td className="truncate px-3 py-2 text-gray-700">{row.module ?? '—'}</td>
                    <td className="truncate px-3 py-2 text-gray-700" title={actionOf(row, tab)}>{actionOf(row, tab)}</td>
                    <td className="px-3 py-2"><ResultBadge row={row} tab={tab} /></td>
                    <td className="truncate px-3 py-2 text-gray-900" title={row.message}>
                      {row.message || '—'}{row.occurrence_count > 1 && <span className="ml-1.5 rounded bg-gray-100 px-1 text-xs text-gray-600">×{row.occurrence_count}</span>}
                    </td>
                    <td className="truncate px-3 py-2 font-mono text-xs text-gray-600">{referenceOf(row, tab)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-2 md:hidden">
            {rows.map(row => (
              <li key={row.id ?? row.sort_key}>
                <button type="button" onClick={() => setSelected(row)} className="w-full rounded-lg border border-gray-200 bg-white p-3 text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-500">{formatTime(row.occurred_at)}</span>
                    <ResultBadge row={row} tab={tab} />
                  </div>
                  <p className="mt-1 line-clamp-2 text-sm text-gray-900">{row.message || actionOf(row, tab)}</p>
                  <p className="mt-1 truncate text-xs text-gray-600">{[row.module, actionOf(row, tab), row.actor_name || row.actor_email].filter(Boolean).join(' · ')}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-gray-500">{referenceOf(row, tab)}{row.occurrence_count > 1 ? ` · ×${row.occurrence_count}` : ''}</p>
                </button>
              </li>
            ))}
          </ul>

          {state === 'ok' && rows.length === 0 && (
            <p className="rounded-lg border border-dashed border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
              {tab === 'errors' ? 'No recorded errors match these filters.' : 'No recorded activity matches these filters.'}
            </p>
          )}

          <nav aria-label="Pagination" className="flex items-center justify-between text-sm text-gray-600">
            <span>Page {page + 1}{rows.length ? ` · ${rows.length} row${rows.length === 1 ? '' : 's'}` : ''}</span>
            <span className="flex gap-2">
              <button type="button" disabled={page === 0 || state === 'loading'} onClick={() => setCursors(c => c.slice(0, -1))}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 disabled:opacity-40"><ChevronLeft className="h-4 w-4" aria-hidden />Previous</button>
              <button type="button" disabled={!nextCursor || state === 'loading'} onClick={() => nextCursor && setCursors(c => [...c, nextCursor])}
                className="inline-flex h-8 items-center gap-1 rounded-md border border-gray-200 bg-white px-2 disabled:opacity-40">Next<ChevronRight className="h-4 w-4" aria-hidden /></button>
            </span>
          </nav>
        </>
      )}

      <LogDetailDrawer row={selected} tab={tab} onClose={() => setSelected(null)} onOpenEvent={id => setSelected({ id })}
        onFilterUser={(id, name) => { setKnownUsers(u => ({ ...u, [id]: name })); update({ user: id }); setSelected(null) }}
        onCopied={ok => toast(ok ? { title: 'Diagnostic report copied', description: 'Sanitized facts only — paste it into Coder AI.' } : { title: 'Copy failed', description: 'Select the report text and copy it manually.', variant: 'destructive' })} />
    </div>
  )
}

function StateBanner({ state }: { state: ListState }) {
  const copy: Partial<Record<ListState, { tone: string; text: string }>> = {
    not_installed: { tone: 'border-amber-200 bg-amber-50 text-amber-900', text: 'System Logs storage is not installed in this database yet (migration 20261017100000_system_logs_foundation.sql pending). The application keeps working; diagnostics are not being stored until it is applied.' },
    unavailable: { tone: 'border-amber-200 bg-amber-50 text-amber-900', text: 'System Logs could not be read right now. This is temporary; the rest of the application is unaffected.' },
    error: { tone: 'border-rose-200 bg-rose-50 text-rose-800', text: 'Could not load System Logs. Check your connection and refresh.' },
    denied: { tone: 'border-gray-200 bg-gray-50 text-gray-700', text: 'You don’t have access to System Logs. Ask an administrator for the System Log Viewer group policy.' },
  }
  const c = copy[state]
  return c ? <p role="status" className={`rounded-md border px-3 py-2 text-sm ${c.tone}`}>{c.text}</p> : null
}

/** Detail for activity rows read from sa_access_change_log / audit_logs (no stored occurrence to fetch). */
function activityDetail(row: any): LogEventDetail {
  return {
    event: {
      id: row.sort_key, kind: 'activity', occurred_at: row.occurred_at, reference_id: row.reference_id ?? row.sort_key,
      correlation_id: row.correlation_id, source: row.source_table === 'system_log_events' ? 'database' : `database (${row.source_table})`,
      severity: 'info', module: row.module, action: row.action, message: row.message || ACTIVITY_LABELS[row.action] || row.action,
      outcome: row.outcome, entity_type: row.entity_type, entity_id: row.entity_id, organization_id: row.organization_id,
      actor_id: row.actor_id, details: row.details ?? {},
    },
    actor: row.actor_id ? { id: row.actor_id, name: row.actor_name, email: row.actor_email } : null,
    group: null,
    related: [],
  }
}

function LogDetailDrawer({ row, tab, onClose, onOpenEvent, onFilterUser, onCopied }: {
  row: any | null; tab: Tab; onClose: () => void; onOpenEvent: (id: string) => void
  onFilterUser: (id: string, name: string) => void; onCopied: (ok: boolean) => void
}) {
  const [detail, setDetail] = useState<LogEventDetail | null>(null)
  const [orgName, setOrgName] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'missing' | 'error'>('idle')

  useEffect(() => {
    setDetail(null); setOrgName(null)
    if (!row) { setStatus('idle'); return }
    const fromOtherSource = tab === 'activity' && row.sort_key && !String(row.sort_key).startsWith('ev:')
    if (fromOtherSource) { setDetail(activityDetail(row)); setStatus('ok'); return }
    const id = row.id ?? (row.sort_key ? String(row.sort_key).slice(3) : null)
    if (!id) { setStatus('missing'); return }
    let active = true
    setStatus('loading')
    fetch(`/api/system-logs/${id}`, { cache: 'no-store' })
      .then(async res => ({ res, body: await res.json().catch(() => ({})) }))
      .then(({ res, body }) => {
        if (!active) return
        if (res.ok && body.detail) { setDetail(body.detail); setOrgName(body.organizationName ?? null); setStatus('ok') }
        else setStatus(res.status === 404 ? 'missing' : 'error')
      })
      .catch(() => { if (active) setStatus('error') })
    return () => { active = false }
  }, [row, tab])

  const copy = async () => {
    if (!detail) return
    const text = buildDiagnosticReport(detail)
    try { await navigator.clipboard.writeText(text); onCopied(true) } catch { onCopied(false) }
  }

  const e = detail?.event
  const client = (e?.client ?? {}) as Record<string, any>
  return (
    <Sheet open={!!row} onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="space-y-1 border-b border-gray-100 p-4 text-left">
          <SheetTitle className="pr-6 text-base leading-snug">{e?.message ?? (status === 'loading' ? 'Loading…' : 'Log entry')}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{e?.reference_id ?? ''}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 p-4 text-sm">
          {status === 'missing' && <p className="text-gray-600">This entry is no longer available (retention) or is outside your scope.</p>}
          {status === 'error' && <p className="text-rose-700">Could not load this entry. Try again.</p>}
          {detail && e && <>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={copy} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-orange-600 px-3 text-sm font-medium text-white hover:bg-orange-700">
                <Copy className="h-4 w-4" aria-hidden /> Copy diagnostic report
              </button>
              {detail.actor?.id && (
                <button type="button" onClick={() => onFilterUser(detail.actor!.id, detail.actor!.name || detail.actor!.email || 'User')}
                  className="inline-flex h-9 items-center rounded-md border border-gray-200 px-3 text-sm text-gray-700 hover:bg-gray-50">Only this user</button>
              )}
            </div>
            <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
              <Fact label="Occurred" value={formatTime(e.occurred_at)} />
              {e.received_at && <Fact label="Received" value={formatTime(e.received_at)} />}
              <Fact label="User" value={detail.actor ? (detail.actor.name || detail.actor.email || detail.actor.id) : e.actor_kind === 'system' || !e.actor_id ? 'System (no user)' : 'Unknown user'} />
              <Fact label="Organization" value={orgName ?? e.organization_id ?? 'Not recorded'} />
              <Fact label="Environment" value={e.environment ?? (e.kind === 'activity' ? 'Not recorded (database event)' : null)} />
              <Fact label="Source" value={e.source} />
              <Fact label="App build" value={e.app_build} />
              <Fact label="Module" value={e.module} />
              <Fact label="Action" value={tab === 'activity' ? (ACTIVITY_LABELS[e.action ?? ''] ?? e.action) : e.action} />
              <Fact label="Page" value={e.page_path} />
              <Fact label="API" value={e.api_route || e.http_status ? `${e.http_method ?? ''} ${e.api_route ?? ''}${e.http_status ? ` → ${e.http_status}` : ''}`.trim() : null} />
              <Fact label="Category / code" value={[e.category, e.code].filter(Boolean).join(' / ') || null} />
              <Fact label={e.kind === 'activity' ? 'Result' : 'Severity'} value={e.kind === 'activity' ? e.outcome : e.severity} />
              {e.entity_type && <Fact label="Record" value={`${e.entity_type}${e.entity_id ? ` ${e.entity_id}` : ''}`} />}
              <Fact label="Reference ID" value={e.reference_id} mono />
              <Fact label="Correlation ID" value={e.correlation_id} mono />
              <Fact label="Server reference" value={e.server_reference_id} mono />
              {e.counted === false && <Fact label="Counting" value="Linked to the server's report of the same failure (not counted twice)" />}
              <Fact label="Browser / device" value={[client.browser, client.os, client.device, client.viewport, client.online === false ? 'offline' : null].filter(Boolean).join(' · ') || null} />
            </dl>
            {detail.group && (
              <section className="rounded-md bg-gray-50 p-3 text-xs text-gray-700">
                <h3 className="mb-1 font-semibold text-gray-900">Grouped error</h3>
                <p>{detail.group.occurrence_count} occurrence{detail.group.occurrence_count === 1 ? '' : 's'} · first seen {formatTime(detail.group.first_seen_at)} · last seen {formatTime(detail.group.last_seen_at)}</p>
                <p className="mt-0.5 text-gray-500">Same organization, environment ({detail.group.environment}) and build ({detail.group.app_build}).</p>
                {!!detail.group.recent_references?.length && (
                  <p className="mt-1 break-all font-mono text-[11px] text-gray-500">Counted but not stored (rate-limited): {detail.group.recent_references.slice(-5).join(', ')}</p>
                )}
              </section>
            )}
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">Related events</h3>
              {detail.related.length === 0 ? <p className="text-xs text-gray-500">None recorded with a shared id.</p> : (
                <ul className="divide-y divide-gray-100 rounded-md border border-gray-100">
                  {detail.related.map(r => (
                    <li key={r.id}>
                      <button type="button" onClick={() => onOpenEvent(r.id)} className="w-full px-2 py-1.5 text-left text-xs hover:bg-gray-50">
                        <span className="text-gray-500">{formatTime(r.occurred_at)}</span> · <span className="font-medium">{r.source}</span>
                        {r.http_status ? ` · ${r.http_status}` : ''} · <span className="text-gray-500">{r.link.replace('_', ' ')}</span>
                        <span className="block truncate text-gray-800">{r.message}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {(e.stack || (e.details && Object.keys(e.details).length > 0)) && (
              <details className="rounded-md border border-gray-100 p-2 text-xs">
                <summary className="cursor-pointer font-medium text-gray-700">Technical details</summary>
                {e.details && Object.keys(e.details).length > 0 && <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-50 p-2 text-[11px]">{JSON.stringify(e.details, null, 2)}</pre>}
                {e.stack && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-50 p-2 text-[11px]">{e.stack}</pre>}
              </details>
            )}
          </>}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Fact({ label, value, mono }: { label: string; value: unknown; mono?: boolean }) {
  if (value === null || value === undefined || value === '') return null
  return <>
    <dt className="text-gray-500">{label}</dt>
    <dd className={`break-words text-gray-900 ${mono ? 'font-mono text-[11px]' : ''}`}>{String(value)}</dd>
  </>
}
