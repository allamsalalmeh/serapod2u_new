'use client'

import { useEffect, useMemo, useState } from 'react'
import { modeLabel, permissionLabel } from '@/lib/security-access/labels'
import { buildRollout, type RolloutNode } from '@/lib/security-access/rollout'
import { CROSS_MODULE, MODULE_FILTER_OPTIONS, OTHER_MODULE, classifyRole, groupByModule, moduleGroupName, permissionModuleLabel, roleInModule, rolePermissionKeys, type RoleModules } from '@/lib/security-access/modules'
import AccessProfilesPanel from './AccessProfilesPanel'
import type { ProfileSummary } from '@/lib/security-access/profiles'
import BulkModeDialog from './BulkModeDialog'
import ModeChangeDialog from './ModeChangeDialog'
import PermissionTree from './PermissionTree'
import { EmptyState, Feedback, FilterChips, SearchInput, SectionTabs, ToggleButton } from './ui'

interface Props {
  data: any
  governance: any | null
  onChanged: () => void
  /** Starting search (e.g. opened from Overview for one permission). */
  initialQuery?: string
  /** Profile-first assignment: hands the profile to People & Access (the existing grant form). */
  onAssignProfile?: (profile: ProfileSummary) => void
}

const MODES = ['LEGACY_ENFORCED', 'SHADOW', 'NEW_ENFORCED', 'LEGACY_RETIRED'] as const
type Section = 'modes' | 'roles' | 'catalogue'
/** Explicit, so reordering the tabs never changes which one opens first. */
const DEFAULT_SECTION: Section = 'modes'

/**
 * Roles & Policies: migration modes (with enforcement readiness), Group
 * Policies and the permission catalogue — one section at a time, grouped and
 * collapsed like the Overview. Data Scope and Approval Limits live under
 * Advanced (DataScopePanel / ApprovalLimitsPanel); their data, authorization
 * and scope enforcement in the assignment flows are unchanged.
 */
export default function RolesPoliciesPanel({ data, governance, onChanged, initialQuery = '', onAssignProfile }: Props) {
  const [section, setSection] = useState<Section>(DEFAULT_SECTION)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [bulkGroup, setBulkGroup] = useState<{ id: string; name: string; total: number } | null>(null)
  const [modeChange, setModeChange] = useState<{ permissionKey: string; from: string; to: string } | null>(null)
  const readiness = useMemo(() => new Map<string, any>((governance?.readiness || []).map((r: any) => [r.permission_key, r])), [governance])
  const roles: any[] = data.roles || []
  // Display only (the server and database enforce): hidden/disabled only when the server says the viewer cannot manage modes.
  const canManageModes = data.capabilities?.canManageModes !== false

  const modeRollout = useMemo(() => buildRollout((data.modes || []).map((m: any) => ({
    key: m.permission_key, label: permissionLabel(m.permission_key).label, mode: m.mode, enforcementReady: readiness.has(m.permission_key),
  }))), [data.modes, readiness])
  // Full (unfiltered) group sizes: a search never narrows what a group action applies to.
  const fullGroups = useMemo(() => {
    const map = new Map<string, RolloutNode>()
    for (const g of modeRollout.groups) { map.set(g.id, g); for (const c of g.children) map.set(c.id, c) }
    return map
  }, [modeRollout])
  const modeByKey = useMemo(() => new Map<string, string>((data.modes || []).map((m: any) => [m.permission_key, m.mode])), [data.modes])
  const catalogue = useMemo(() => buildRollout((data.permissions || []).map((p: any) => ({
    key: p.permission_key, label: permissionLabel(p.permission_key).label, mode: modeByKey.get(p.permission_key) ?? 'UNREGISTERED', enforcementReady: false,
  }))), [data.permissions, modeByKey])
  const describe = useMemo(() => new Map<string, any>((data.permissions || []).map((p: any) => [p.permission_key, p])), [data.permissions])

  function changeMode(permissionKey: string, mode: string) {
    setMessage(null)
    setModeChange({ permissionKey, from: modeByKey.get(permissionKey) ?? 'UNREGISTERED', to: mode })
  }

  return <div className="space-y-4">
    <SectionTabs label="Roles & Policies sections" value={section} onChange={setSection} items={[
      { id: 'catalogue', label: 'Policies', count: catalogue.total },
      { id: 'roles', label: 'Group Policies', count: roles.length },
      { id: 'modes', label: 'Migration Modes', count: modeRollout.total },
    ]} />
    <Feedback message={message} />

    {section === 'modes' && <PermissionTree
      rollout={modeRollout}
      initialQuery={initialQuery}
      searchPlaceholder="Search permissions"
      title="Operations and migration modes"
      description="Only operations whose every path is wired (server route and database backstop) can be enforced. A new-model denial never falls back to a legacy allow."
      renderGroupActions={node => {
        if (!canManageModes) return null
        const full = fullGroups.get(node.id) ?? node
        return <button type="button" onClick={() => setBulkGroup({ id: full.id, name: full.level === 'subgroup' ? `${fullGroups.get(full.id.split('/')[0])?.name ?? ''} · ${full.name}` : full.name, total: full.total })}
          aria-label={`Change group mode for ${full.name}, ${full.total} permission${full.total === 1 ? '' : 's'}`}
          className="shrink-0 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          Change group mode
        </button>
      }}
      renderSubtitle={p => {
        const tightening = readiness.get(p.key)?.intentional_tightening
        return tightening ? <div className="text-xs text-amber-700" title="Expected difference when enforced">Tightening: {tightening}</div> : null
      }}
      renderDetails={p => {
        const ready = readiness.get(p.key)
        return <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={ready ? 'text-emerald-700' : 'text-gray-500'} title={ready ? ready.notes : 'Not every path is wired for enforcement; only Legacy enforced or Monitoring / Shadow can be chosen'}>
            {ready ? `Ready · ${String(ready.database_backstop).replace(/_/g, ' ')}` : 'Not ready for enforcement'}
          </span>
          <select aria-label={`Change mode for ${p.label}`} value="" disabled={!canManageModes} title={canManageModes ? undefined : 'Changing migration modes needs the “Manage permissions” authority'} onChange={e => e.target.value && changeMode(p.key, e.target.value)}
            className="rounded-md border border-gray-200 px-2 py-1 text-xs focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100">
            <option value="">Change…</option>
            {MODES.filter(x => x !== p.mode).map(x => <option key={x} value={x} disabled={(x === 'NEW_ENFORCED' || x === 'LEGACY_RETIRED') && !ready}>{modeLabel(x).label}</option>)}
          </select>
        </div>
      }}
    />}

    {modeChange && <ModeChangeDialog permissionKey={modeChange.permissionKey} currentMode={modeChange.from} targetMode={modeChange.to}
      onClose={() => setModeChange(null)}
      onChanged={() => { setModeChange(null); setMessage({ tone: 'ok', text: 'Mode changed and audited.' }); onChanged() }} />}

    {bulkGroup && <BulkModeDialog groupId={bulkGroup.id} groupName={bulkGroup.name} total={bulkGroup.total} onClose={() => setBulkGroup(null)} onChanged={onChanged} />}

    {section === 'roles' && <AccessProfilesPanel permissions={data.permissions || []} onChanged={onChanged} onAssignProfile={onAssignProfile} fallback={<BusinessRoles roles={roles} />} />}

    {section === 'catalogue' && <PermissionTree
      rollout={catalogue}
      showModes={false}
      searchPlaceholder="Search permissions"
      title="Policies"
      info={<p>Individual access permissions included in a Group Policy.</p>}
      renderSubtitle={p => describe.get(p.key)?.description ? <div className="text-xs text-gray-500">{describe.get(p.key).description}</div> : null}
      renderDetails={p => describe.get(p.key)?.audit_sensitivity === 'security_sensitive'
        ? <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-700" title="Every decision is kept (never purged automatically).">Sensitive audit</span>
        : <span className="text-gray-400">Ordinary audit</span>}
    />}

  </div>
}

type RoleFilter = 'business' | 'compatibility' | 'all'

function BusinessRoles({ roles }: { roles: any[] }) {
  const [filter, setFilter] = useState<RoleFilter>('business')
  const [moduleFilter, setModuleFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [groupsOpen, setGroupsOpen] = useState<Set<string>>(new Set())
  const [filterOpen, setFilterOpen] = useState<Set<string>>(new Set())
  const classes = useMemo(() => new Map<string, RoleModules>(roles.map(r => [r.id, classifyRole(r)])), [roles])
  const isCompat = (r: any) => r.source === 'legacy'
  const q = query.trim().toLowerCase()
  const rows = useMemo(() => roles.filter(r => (filter === 'all' || (filter === 'compatibility') === isCompat(r))
    && roleInModule(r, moduleFilter, classes.get(r.id))
    && (!q || `${r.name} ${r.role_key} ${r.description || ''} ${rolePermissionKeys(r).map(k => `${k} ${permissionLabel(k).label}`).join(' ')}`.toLowerCase().includes(q))),
  [roles, filter, moduleFilter, q, classes])
  const groups = useMemo(() => groupByModule(rows, r => classes.get(r.id)?.groupId ?? OTHER_MODULE.id), [rows, classes])
  const filtering = q.length > 0 || moduleFilter !== 'all'
  useEffect(() => { setFilterOpen(new Set(groups.map(g => g.id))) }, [groups])
  const expanded = filtering ? filterOpen : groupsOpen
  const setExpanded = filtering ? setFilterOpen : setGroupsOpen
  const flip = (set: (fn: (p: Set<string>) => Set<string>) => void, id: string) => set(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const pool = roles.filter(r => filter === 'all' || (filter === 'compatibility') === isCompat(r))
  const moduleOptions = [{ id: 'all', name: 'All modules' }, ...MODULE_FILTER_OPTIONS, CROSS_MODULE, OTHER_MODULE]
    .filter(m => m.id === 'all' || pool.some(r => roleInModule(r, m.id, classes.get(r.id))))

  return <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
    <div className="space-y-3 border-b border-gray-100 p-4">
      <div className="min-w-0"><h2 className="font-semibold text-gray-950">Group Policies (read-only list)</h2>
        <p className="text-sm text-gray-500">Grouped by the module of their permissions; roles spanning several modules are under Shared / Cross-module and also appear in each module's filter. Grouping is display only.</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder="Search roles or permissions" label="Search roles" className="basis-full sm:basis-auto sm:w-64" />
        <select value={moduleFilter} onChange={e => setModuleFilter(e.target.value)} aria-label="Module"
          className="rounded-lg border border-gray-200 bg-white py-1.5 pl-2.5 pr-7 text-sm text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
          {moduleOptions.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <FilterChips label="Role type" value={filter} onChange={setFilter} items={[
          { id: 'business', label: 'Group Policies', count: roles.filter(r => !isCompat(r)).length },
          { id: 'compatibility', label: 'Compatibility', count: roles.filter(isCompat).length },
          { id: 'all', label: 'All', count: roles.length },
        ]} />
        <div className="ml-auto flex items-center gap-2">
          {filtering && <button type="button" onClick={() => { setQuery(''); setModuleFilter('all') }} className="rounded text-xs font-medium text-orange-600 hover:text-orange-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">Clear filters</button>}
          <button type="button" onClick={() => setExpanded(new Set())} disabled={expanded.size === 0}
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-default disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">Collapse all</button>
        </div>
      </div>
    </div>
    {filtering && <p role="status" className="border-b border-gray-100 bg-orange-50/40 px-4 py-1.5 text-xs text-gray-600">Showing {rows.length} of {pool.length} roles.</p>}
    {rows.length === 0 && <EmptyState>{q ? `No roles match “${query.trim()}”.` : 'No roles in this view.'}</EmptyState>}
    <ul className="text-sm">{groups.map(g => {
      const gOpen = expanded.has(g.id)
      return <li key={g.id} className="border-t border-gray-100 first:border-t-0">
        <div className="flex items-center gap-2 bg-gray-50/70 px-4 py-2">
          <ToggleButton open={gOpen} onClick={() => flip(setExpanded, g.id)} label={`${g.name}, ${g.items.length} role${g.items.length === 1 ? '' : 's'}`}>
            <span className="font-semibold text-gray-900">{g.name}</span>
            <span className="text-xs text-gray-400">{g.items.length} role{g.items.length === 1 ? '' : 's'}</span>
          </ToggleButton>
          {!gOpen && <span className="hidden min-w-0 truncate text-xs text-gray-400 md:inline">{g.items.map(r => r.name).join(', ')}</span>}
        </div>
        {gOpen && <ul className="divide-y divide-gray-50">{g.items.map(r => {
          const keys = rolePermissionKeys(r)
          const cls = classes.get(r.id)
          const tags = cls ? (cls.crossModule ? cls.modules : cls.related) : []
          const isOpen = open.has(r.id)
          const byArea = new Map<string, string[]>()
          for (const k of keys) { const label = permissionModuleLabel(k); byArea.set(label, [...(byArea.get(label) || []), k]) }
          return <li key={r.id}>
            <div className="flex flex-wrap items-center justify-between gap-2 py-2 pl-10 pr-4">
              <ToggleButton open={isOpen} onClick={() => flip(setOpen, r.id)} label={`${r.name}, ${keys.length} permission${keys.length === 1 ? '' : 's'}`}>
                <span className="font-medium text-gray-900">{r.name}</span>
              </ToggleButton>
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                {tags.map(t => <span key={t} className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600">{moduleGroupName(t)}</span>)}
                <span>{keys.length} permission{keys.length === 1 ? '' : 's'}</span>
                {r.source !== 'template' && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">{isCompat(r) ? 'Compatibility' : 'Custom'}</span>}
                {r.status !== 'active' && <span className="text-gray-400">{r.status}</span>}
              </div>
            </div>
            {isOpen && <div className="space-y-2 bg-gray-50/60 pb-3 pl-16 pr-4 pt-1">
              {r.description && <p className="text-sm text-gray-600">{r.description}</p>}
              {keys.length === 0 && <p className="text-sm text-gray-500">No permissions.</p>}
              {Array.from(byArea.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([area, ks]) => <div key={area}>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{area} · {ks.length}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">{ks.sort().map(k =>
                  <span key={k} title={k} className="rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-700">{permissionLabel(k).label}</span>)}</div>
              </div>)}
            </div>}
          </li>
        })}</ul>}
      </li>
    })}</ul>
  </section>
}

