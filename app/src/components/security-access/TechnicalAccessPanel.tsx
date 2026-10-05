'use client'

import { useEffect, useMemo, useState } from 'react'
import { Bot, History, KeyRound } from 'lucide-react'
import { formatDate } from './client-api'
import { Collapsible, EmptyState, FilterChips, FOCUS, LIST_TEXT, SearchInput, ToggleButton } from './ui'
import {
  CREDENTIAL_STATES, LIFECYCLE, credentialState, moduleOfService, filterServices, groupServices, lifecycleLabel, serviceKindLabel,
  type CredentialState, type ServiceGroup, type ServiceIdentity,
} from '@/lib/security-access/service-identities'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const ROW = 'grid grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-[minmax(0,1fr)_8.5rem_10.5rem_6rem_11rem] md:items-center'

function CredentialBadge({ state }: { state: CredentialState }) {
  const c = CREDENTIAL_STATES[state]
  return <span title={c.help} className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${c.tone}`}>{c.label}</span>
}

function Lifecycle({ status }: { status: string }) {
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-gray-600">
    <span className={`h-1.5 w-1.5 rounded-full ${LIFECYCLE[status]?.dot ?? 'bg-gray-300'}`} aria-hidden />{lifecycleLabel(status)}
  </span>
}

function GroupSummary({ g }: { g: ServiceGroup }) {
  const credentials = (Object.keys(CREDENTIAL_STATES) as CredentialState[]).filter(k => g.credentials[k])
    .map(k => `${g.credentials[k]} ${CREDENTIAL_STATES[k].short}`)
  const lifecycle = Object.entries(g.lifecycle).map(([status, n]) => `${n} ${lifecycleLabel(status).toLowerCase()}`)
  return <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-normal text-gray-500">
    <span><span className="sr-only">Credentials: </span>{credentials.join(' · ')}</span>
    <span className="text-gray-400"><span className="sr-only">Lifecycle: </span>{lifecycle.join(' · ')}</span>
  </span>
}

/**
 * Technical Access: non-human service identities, grouped by module. Metadata
 * only — the credential is shown by environment variable NAME with a
 * configured-here flag; secret values are never read into the UI or logs.
 */
export default function TechnicalAccessPanel({ governance, error }: { governance: any | null; error?: string | null }) {
  const identities: ServiceIdentity[] = useMemo(() => governance?.serviceIdentities || [], [governance])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [filterOpen, setFilterOpen] = useState<Set<string>>(new Set())
  const [openService, setOpenService] = useState<Set<string>>(new Set())
  const [credential, setCredential] = useState<'all' | 'missing'>('all')
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')

  const filtering = credential !== 'all' || kind !== 'all' || query.trim().length > 0
  const rows = useMemo(() => filterServices(identities, { query, kind, credential }), [identities, query, kind, credential])
  const groups = useMemo(() => groupServices(rows), [rows])
  // Filters open every group with a match; clearing them restores what was open before.
  useEffect(() => { setFilterOpen(new Set(groups.map(g => g.id))) }, [groups])
  const expanded = filtering ? filterOpen : open
  const setExpanded = filtering ? setFilterOpen : setOpen
  const kinds = useMemo(() => Array.from(new Set(identities.map(s => s.identity_kind))).sort((a, b) => serviceKindLabel(a).localeCompare(serviceKindLabel(b))), [identities])
  const missing = identities.filter(s => credentialState(s) === 'missing').length

  const flip = (set: (fn: (p: Set<string>) => Set<string>) => void, id: string) =>
    set(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const clearFilters = () => { setQuery(''); setKind('all'); setCredential('all') }

  if (!governance) {
    return error
      ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">Service identities could not be loaded: {error}</div>
      : <div role="status" className="p-6 text-sm text-gray-500">Loading technical access…</div>
  }

  return <section className="rounded-xl border border-gray-200 bg-white shadow-sm" aria-label="Service identities">
    <div className="space-y-3 border-b border-gray-100 p-4">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 font-semibold text-gray-950"><Bot className="h-4 w-4" aria-hidden />Service identities</h2>
        <p className="text-sm text-gray-500">Workers, integrations and webhooks are modelled separately from human administrators. Credentials are never displayed and are not rotated automatically.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search service, module or type" label="Search service identities" className="basis-full sm:basis-auto sm:w-72" />
        <label className="text-xs text-gray-500">
          <span className="sr-only">Service type</span>
          <select value={kind} onChange={e => setKind(e.target.value)} aria-label="Service type"
            className={`rounded-lg border border-gray-200 bg-white py-1.5 pl-2.5 pr-7 text-sm text-gray-700 ${FOCUS}`}>
            <option value="all">All types</option>
            {kinds.map(k => <option key={k} value={k}>{serviceKindLabel(k)}</option>)}
          </select>
        </label>
        <FilterChips label="Credential" value={credential} onChange={setCredential} items={[
          { id: 'all', label: 'All', count: identities.length },
          { id: 'missing', label: 'Credential not configured here', count: missing },
        ]} />
        <div className="ml-auto flex items-center gap-2">
          {filtering && <button type="button" onClick={clearFilters} className={`rounded text-xs font-medium text-orange-600 hover:text-orange-700 ${FOCUS}`}>Clear filters</button>}
          <button type="button" onClick={() => setExpanded(new Set())} disabled={expanded.size === 0}
            className={`shrink-0 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-default disabled:opacity-40 ${FOCUS}`}>
            Collapse all
          </button>
        </div>
      </div>
    </div>

    {filtering && identities.length > 0 && (
      <p role="status" className="border-b border-gray-100 bg-orange-50/40 px-4 py-1.5 text-xs text-gray-600">
        Showing {rows.length} of {plural(identities.length, 'service')}.
      </p>
    )}

    {identities.length === 0 ? <EmptyState>No service identities registered.</EmptyState>
      : rows.length === 0 ? <EmptyState>
          {credential === 'missing' && !query.trim() && kind === 'all' ? 'Every service identity has its credential configured here.' : 'No services match these filters.'}{' '}
          <button type="button" onClick={clearFilters} className={`rounded font-medium text-orange-600 hover:text-orange-700 ${FOCUS}`}>Clear filters</button>
        </EmptyState>
      : <div>
          <div className={`${ROW} hidden border-b border-gray-100 px-4 py-2 text-xs font-medium text-gray-500 md:grid`} aria-hidden>
            <span>Module / service</span><span>Type</span><span>Credential</span><span>Lifecycle</span><span>Last recorded usage</span>
          </div>
          <ul className={LIST_TEXT}>{groups.map(g => {
            const gOpen = expanded.has(g.id)
            return <li key={g.id} className="border-t border-gray-100 first:border-t-0">
              <div className="bg-gray-50/70 px-4 py-2">
                <ToggleButton open={gOpen} onClick={() => flip(setExpanded, g.id)} label={`${g.name}, ${plural(g.services.length, 'service')}`}>
                  <span className="min-w-0">
                    <span className="flex items-baseline gap-2"><span className="font-semibold text-gray-900">{g.name}</span>
                      <span className="text-xs text-gray-400">{plural(g.services.length, 'service')}</span></span>
                    <GroupSummary g={g} />
                  </span>
                </ToggleButton>
              </div>
              {gOpen && <ul className="divide-y divide-gray-50">{g.services.map(s => {
                const sOpen = openService.has(s.id)
                return <li key={s.id}>
                  <div className={`${ROW} py-2 pl-6 pr-4 text-sm md:pl-10`}>
                    <ToggleButton open={sOpen} onClick={() => flip(setOpenService, s.id)} label={s.name}>
                      <span className="min-w-0"><span className="block truncate font-medium text-gray-900">{s.name}</span>
                        {moduleOfService(s).areaName && <span className="block truncate text-xs text-gray-400">{moduleOfService(s).areaName}</span>}</span>
                    </ToggleButton>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 md:contents">
                      <span><span className="inline-block whitespace-nowrap rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-600">{serviceKindLabel(s.identity_kind)}</span></span>
                      <span><CredentialBadge state={credentialState(s)} /></span>
                      <span><Lifecycle status={s.status} /></span>
                      <span className="text-xs text-gray-500">{s.last_used_at ? formatDate(s.last_used_at) : 'No usage recorded'}</span>
                    </div>
                  </div>
                  {sOpen && <ServiceDetails s={s} />}
                </li>
              })}</ul>}
            </li>
          })}</ul>
        </div>}
  </section>
}

function ServiceDetails({ s }: { s: ServiceIdentity }) {
  return <dl className="grid gap-3 bg-gray-50/60 py-3 pl-12 pr-4 md:pl-16 text-xs sm:grid-cols-3">
    <div className="sm:col-span-2"><dt className="text-gray-400">Purpose</dt><dd className="text-gray-700">{s.purpose}</dd>
      <dt className="mt-2 text-gray-400">Scope</dt><dd className="text-gray-700">{s.scope_description}</dd></div>
    <div><dt className="text-gray-400">Credential</dt>
      <dd className="flex items-center gap-1 text-gray-700"><KeyRound className="h-3 w-3" aria-hidden />{String(s.credential_type ?? '').replace(/_/g, ' ')}</dd>
      {s.credential_reference && <dd><code className="text-gray-500">{s.credential_reference}</code></dd>}
      <dd className="mt-1 text-gray-500">{CREDENTIAL_STATES[credentialState(s)].help}</dd>
      {(s.last_rotated_at || s.rotation_due_at) && <>
        <dt className="mt-2 text-gray-400">Rotation</dt>
        <dd className="text-gray-700">Last rotated {s.last_rotated_at ? formatDate(s.last_rotated_at) : 'not recorded'}{s.rotation_due_at ? ` · due ${formatDate(s.rotation_due_at)}` : ''}</dd>
      </>}
    </div>
  </dl>
}

/**
 * Legacy compatibility (read-only): the legacy role levels and department
 * overrides that Settings → Authorization used to edit, shown with the
 * compatibility role each maps to. Nothing here is writable; enterprise
 * access is granted through business roles.
 */
export function LegacyCompatibilityPanel({ governance }: { governance: any | null }) {
  const legacy = governance?.legacyCompatibility
  if (!legacy) return null
  return <Collapsible title="Legacy compatibility" meta={`${legacy.roles.length} legacy roles · read-only`}>
    <div className="border-b p-4">
      <p className="flex items-start gap-2 text-sm text-gray-500"><History className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span>Legacy role levels are compatibility metadata only: they never make anyone staff and never override a Security &amp; Access decision.
        {legacy.readOnly
          ? ' Legacy authorization stores are read-only in this environment.'
          : ' Legacy authorization stores are still writable in this environment (Settings → Authorization); they become read-only at cutover.'}</span></p>
    </div>
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
          <tr><th className="px-4 py-2">Legacy role</th><th className="px-4 py-2">Level</th><th className="px-4 py-2">Compatibility role</th><th className="px-4 py-2">Permissions</th><th className="px-4 py-2">Holders</th></tr>
        </thead>
        <tbody className="divide-y">
          {legacy.roles.map((r: any) => <tr key={r.roleCode} className={r.isActive ? '' : 'text-gray-400'}>
            <td className="px-4 py-2">{r.roleName || r.roleCode} <code className="text-xs text-gray-400">{r.roleCode}</code>{r.isActive ? null : <span className="ml-1 text-xs">(inactive)</span>}</td>
            <td className="px-4 py-2">{r.roleLevel}</td>
            <td className="px-4 py-2">{r.compatRoleKey ? <code className="text-xs">{r.compatRoleKey}</code> : <span className="text-gray-400">—</span>}</td>
            <td className="px-4 py-2">{r.compatPermissions}</td>
            <td className="px-4 py-2">{r.compatAssignments}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <div className="border-t p-4 text-xs text-gray-500">Departments with legacy permission overrides: {legacy.departmentsWithOverrides}</div>
  </Collapsible>
}
