'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Pencil, Plus, UserPlus, Users } from 'lucide-react'
import { callApi } from './client-api'
import { EmptyState, Feedback, FilterChips, FOCUS, InfoPopover, SearchInput, ToggleButton } from './ui'
import ProfileEditorDialog from './ProfileEditorDialog'
import ProfilePublishDialog from './ProfilePublishDialog'
import { CROSS_MODULE, MODULE_TAXONOMY, OTHER_MODULE, classifyPermission, classifyRole, groupByTaxonomy, moduleGroupName, roleInModule } from '@/lib/security-access/modules'
import { permissionLabel } from '@/lib/security-access/labels'
import { ACCOUNT_TYPE_LABELS, isSensitivePermission, type ProfileSummary } from '@/lib/security-access/profiles'
import { BREAK_GLASS_POLICIES, BREAK_GLASS_POLICY_NAMES, DESTRUCTIVE_PERMISSIONS, POST_CREATION_ASSIGNMENT_NOTE, fullAccessPolicy, isBreakGlassPolicy, sortGroupPolicies } from '@/lib/security-access/group-policies'
import { orgTypeLabel } from '@/lib/security-access/directory-labels'
import { supportingReadsIn } from '@/lib/security-access/policy-dependencies'

type View = 'standard' | 'custom' | 'compatibility'
interface Props {
  /** sa_permissions rows (catalogue) used by the editor. */
  permissions: any[]
  onChanged: () => void
  /** Opens People & Access with this profile preselected in the existing grant form (no second assignment path). */
  onAssignProfile?: (profile: ProfileSummary) => void
  /** Read-only role list shown when profile management is unavailable (migration not applied). */
  fallback: React.ReactNode
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 60)

/**
 * Group Policies: Standard (protected templates), Custom (copied or created,
 * edited through draft → review → publish) and Compatibility roles (managed by
 * the lifecycle, shown separately and never editable). A profile is a business
 * role; assigning it, scopes and SoD all work exactly as before.
 */
export default function AccessProfilesPanel({ permissions, onChanged, onAssignProfile, fallback }: Props) {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null)
  const [error, setError] = useState<{ text: string; code?: string } | null>(null)
  const [view, setView] = useState<View>('standard')
  const [query, setQuery] = useState('')
  // Normal expansion (module headers `m:<id>` and profiles `p:<id>`) and a separate one used only while
  // searching, so a search reveals matching paths without changing what the user had open.
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [searchOpen, setSearchOpen] = useState<Set<string>>(new Set())
  const [moduleFilter, setModuleFilter] = useState('all')
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [editor, setEditor] = useState<{ profile: ProfileSummary | null } | null>(null)
  const [publish, setPublish] = useState<ProfileSummary | null>(null)
  const [copying, setCopying] = useState<ProfileSummary | null>(null)
  const [holders, setHolders] = useState<Record<string, any>>({})
  const [migrationReady, setMigrationReady] = useState(true)
  const [canAssign, setCanAssign] = useState(false)
  const [holdersOpen, setHoldersOpen] = useState<Set<string>>(new Set())
  const holderRequest = useRef<Record<string, number>>({})

  const load = useCallback(async () => {
    const res = await callApi('/api/security-access/profiles')
    if (!res.ok) { setError({ text: res.error || 'Group Policies could not be loaded.', code: res.code }); setProfiles(null); return }
    setError(null); setProfiles(res.data.profiles); setMigrationReady(res.data.migrationReady !== false); setCanAssign(res.data.capabilities?.canAssign === true)
  }, [])
  useEffect(() => { load() }, [load])
  const refresh = () => { load(); onChanged() }

  const counts = useMemo(() => ({
    standard: (profiles || []).filter(p => p.kind === 'standard').length,
    custom: (profiles || []).filter(p => p.kind === 'custom').length,
    compatibility: (profiles || []).filter(p => p.kind === 'compatibility').length,
  }), [profiles])
  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const classes = useMemo(() => new Map((profiles || []).map(p => [p.id, classifyRole({ permissions: p.permissionKeys })])), [profiles])
  const nameHit = (p: ProfileSummary) => `${p.name} ${p.roleKey} ${p.description || ''}`.toLowerCase().includes(q)
  const permHit = (p: ProfileSummary) => p.permissionKeys.some(k => `${k} ${permissionLabel(k).label}`.toLowerCase().includes(q))
  const rows = (profiles || []).filter(p => p.kind === view && roleInModule({ permissions: p.permissionKeys }, moduleFilter, classes.get(p.id)) && (!searching || nameHit(p) || permHit(p)))
  // Every profile appears ONCE, under its display module (Shared / Cross-module when its substantive
  // permissions span several modules), so holder totals are never duplicated.
  const byGroup = useMemo(() => {
    const map = new Map<string, ProfileSummary[]>()
    for (const p of rows) { const id = classes.get(p.id)?.groupId ?? OTHER_MODULE.id; map.set(id, [...(map.get(id) || []), p]) }
    return map
  }, [rows, classes])
  // All legitimate module headers are listed (even without profiles); Shared / Other only when used.
  const groupIds = [...MODULE_TAXONOMY.map(g => g.id), ...(byGroup.has(CROSS_MODULE.id) ? [CROSS_MODULE.id] : []), ...(byGroup.has(OTHER_MODULE.id) ? [OTHER_MODULE.id] : [])]
    .filter(id => view !== 'custom' && !searching && moduleFilter === 'all' ? true : byGroup.has(id))
  const uncovered = useMemo(() => {
    // Informational only: catalogue permissions of a module that no (non-compatibility) profile contains.
    const inProfile = new Set((profiles || []).filter(p => p.kind !== 'compatibility' && p.status !== 'deprecated').flatMap(p => p.permissionKeys))
    const map = new Map<string, number>()
    for (const perm of permissions) {
      if (perm.status === 'deprecated' || inProfile.has(perm.permission_key)) continue
      const g = classifyPermission(perm.permission_key).groupId
      map.set(g, (map.get(g) || 0) + 1)
    }
    return map
  }, [profiles, permissions])
  // Active catalogue permissions per functional area ("module/area"), so a standard policy can show what it leaves out.
  const catalogueByArea = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const m of groupByTaxonomy(permissions.filter(perm => perm.status !== 'deprecated').map(perm => String(perm.permission_key)), k => k)) {
      for (const a of m.areas) map.set(`${m.id}/${a.id}`, a.items as string[])
    }
    return map
  }, [permissions])
  // A module filter chosen in another tab may not exist in this one; fall back to all modules.
  useEffect(() => { setModuleFilter('all') }, [view])
  const expanded = searching ? searchOpen : open
  const setExpanded = searching ? setSearchOpen : setOpen
  // Opening the search path: matching modules, and profiles that matched through a permission.
  useEffect(() => {
    if (!searching) return
    const next = new Set<string>()
    for (const p of rows) { next.add(`m:${classes.get(p.id)?.groupId ?? OTHER_MODULE.id}`); if (!nameHit(p) && permHit(p)) { next.add(`p:${p.id}`); for (const m of groupByTaxonomy(p.permissionKeys, k => k)) for (const a of m.areas) if (a.items.some(k => `${k} ${permissionLabel(k).label}`.toLowerCase().includes(q))) next.add(`c:${p.id}:${m.id}/${a.id}`) } }
    setSearchOpen(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, view, moduleFilter, profiles])
  const flip = (id: string) => setExpanded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const expandAll = () => setExpanded(new Set([...groupIds.map(id => `m:${id}`), ...rows.map(p => `p:${p.id}`)]))
  const collapseAll = () => setExpanded(new Set())
  const moduleOptions = [{ id: 'all', name: 'All modules' }, ...MODULE_TAXONOMY.map(g => ({ id: g.id, name: g.name })), CROSS_MODULE, OTHER_MODULE]
    .filter(m => m.id === 'all' || (profiles || []).some(p => p.kind === view && roleInModule({ permissions: p.permissionKeys }, m.id, classes.get(p.id))))

  async function loadHolders(id: string) {
    const token = (holderRequest.current[id] = (holderRequest.current[id] ?? 0) + 1)
    const res = await callApi('/api/security-access/profiles', { body: { action: 'holders', roleId: id } })
    if (token !== holderRequest.current[id]) return // a newer request superseded this one
    setHolders(h => ({ ...h, [id]: res.ok ? res.data.result : { error: res.error || 'Holders could not be loaded.' } }))
  }
  // Only profiles with holders are ever requested; collapsing keeps the data but never re-requests it.
  function toggleHolders(p: ProfileSummary) {
    if (p.holders === 0) return
    const opening = !holdersOpen.has(p.id)
    setHoldersOpen(prev => { const n = new Set(prev); if (opening) n.add(p.id); else n.delete(p.id); return n })
    if (opening) { setHolders(h => { const { [p.id]: _drop, ...rest } = h; return rest }); loadHolders(p.id) }
  }
  // After a reload (grant, revoke, publish) the counts changed: refresh holder lists that are open.
  useEffect(() => {
    if (!profiles) return
    for (const id of holdersOpen) {
      const p = profiles.find(x => x.id === id)
      if (p && p.holders > 0) loadHolders(id)
      else setHolders(h => { const { [id]: _drop, ...rest } = h; return rest })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles])
  async function retire(p: ProfileSummary) {
    const reason = window.prompt(`Retire “${p.name}”? It can no longer be assigned. Reason?`)
    if (!reason || reason.trim().length < 10) { if (reason !== null) setMessage({ tone: 'error', text: 'A reason of at least 10 characters is required.' }); return }
    const res = await callApi('/api/security-access/profiles', { body: { action: 'retire', roleId: p.id, reason } })
    setMessage(res.ok ? { tone: 'ok', text: 'Policy retired.' } : { tone: 'error', text: res.error || 'Unable to retire' })
    if (res.ok) refresh()
  }

  function profileRow(p: ProfileSummary) {
    const isOpen = expanded.has(`p:${p.id}`)
    const h = holders[p.id]
    const cls = classes.get(p.id)
    const spans = cls?.crossModule ? cls.modules : (cls?.related ?? [])
    const tree = groupByTaxonomy(p.permissionKeys, k => k)
    // Permission categories (the existing module → functional area mapping), keyed by stable ids.
    const categories = tree.flatMap(m => m.areas.map(a => ({ key: `c:${p.id}:${m.id}/${a.id}`, area: `${m.id}/${a.id}`, module: m.name, name: a.name, items: a.items as string[] })))
    // From the policy's own mapping: reads it includes to support its operations, and (standard, non-Full-Access policies)
    // the operations of the same area it does not include.
    const supports = supportingReadsIn(p.permissionKeys)
    const notIncluded = (area: string) => p.kind === 'standard' && !p.fullAccess
      ? (catalogueByArea.get(area) ?? []).filter(k => !p.permissionKeys.includes(k)) : []
    const multiModule = tree.length > 1
    const allCategoriesOpen = categories.length > 0 && categories.every(c => expanded.has(c.key))
    const setCategories = (open: boolean) => setExpanded(prev => { const n = new Set(prev); for (const c of categories) { if (open) n.add(c.key); else n.delete(c.key) } return n })
    const sensitive = p.permissionKeys.some(isSensitivePermission)
    const full = p.fullAccess ? fullAccessPolicy(p.roleKey) : null
    const driftCount = p.drift?.catalogueNotCovered.length ?? 0
    const breakGlass = p.kind === 'standard' && isBreakGlassPolicy(p.roleKey)
    // Destructive operations of this module that live in a break-glass policy instead (20261110100000).
    const excludedDestructive = full ? DESTRUCTIVE_PERMISSIONS.filter(k => classifyPermission(k).groupId === full.moduleId) : []
    const hasInfo = Boolean(p.description) || Boolean(full)
    return <li key={p.id} className={p.fullAccess ? 'bg-orange-50/40' : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 pl-8 pr-4">
        <div className="flex min-w-0 items-center gap-2">
          <ToggleButton open={isOpen} onClick={() => flip(`p:${p.id}`)} controls={`policy-${p.id}`} label={`${p.name}, ${p.permissionKeys.length} permission${p.permissionKeys.length === 1 ? '' : 's'}`}>
            <span className="font-medium text-gray-900">{p.name}</span>
            {p.fullAccess && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-800">Full Access</span>}
            {breakGlass && <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700" title="Destructive operation: grant only for a planned operation, preferably with an end date.">Break-glass</span>}
          </ToggleButton>
          {hasInfo && <InfoPopover label={`About ${p.name}`}>
            {p.description && <p>{p.description}</p>}
            {full && <>
              <p>Standard module policy: every {moduleGroupName(full.moduleId)} permission, listed one by one ({p.permissionKeys.length}). It is explicit, not a wildcard, and permissions added to the catalogue later are <strong>not</strong> included automatically.</p>
              {excludedDestructive.length > 0 && <p>Not included: {excludedDestructive.map(k => permissionLabel(k).label).join(', ')}. Destructive operations are granted only through their break-glass policy ({Object.entries(BREAK_GLASS_POLICIES).filter(([, keys]) => keys.some(k => excludedDestructive.includes(k))).map(([role]) => BREAK_GLASS_POLICY_NAMES[role] ?? role).join(', ')}).</p>}
              <p>Assigning it needs a data scope. Each operation keeps its own guards: separation of duties, special-operation requirements and scope checks still apply, and it does not create an organization, department or HR/ESS enrollment.</p>
              {sensitive && <p>{POST_CREATION_ASSIGNMENT_NOTE}</p>}
              {driftCount > 0 && <p>{driftCount} newer {moduleGroupName(full.moduleId)} permission{driftCount === 1 ? '' : 's'} not included yet: {p.drift!.catalogueNotCovered.map(k => permissionLabel(k).label).join(', ')}. Holders are unchanged until a reviewed update adds {driftCount === 1 ? 'it' : 'them'}.</p>}
            </>}
          </InfoPopover>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          {p.status === 'draft' && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">Draft · not assignable</span>}
          {p.status === 'deprecated' && <span className="rounded-full bg-gray-100 px-2 py-0.5">Retired</span>}
          {p.draft && p.status !== 'draft' && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">{p.draft.status === 'in_review' ? 'Change in review' : 'Draft change'}</span>}
          {driftCount > 0 && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">{driftCount} newer not included</span>}
          {spans.map(t => <span key={t} className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600" title="Module this policy's permissions touch">{moduleGroupName(t)}</span>)}
          {p.accountTypes.map(t => <span key={t} className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600">{ACCOUNT_TYPE_LABELS[t] ?? t}</span>)}
          {p.orgTypes.map(t => <span key={t} className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600">{orgTypeLabel(t)}</span>)}
          {p.orgTypes.length === 0 && p.kind !== 'compatibility' && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800" title="No eligible organization types: this policy cannot be granted to anyone until they are chosen.">Unclassified · not grantable</span>}
          <span>{p.permissionKeys.length} permission{p.permissionKeys.length === 1 ? '' : 's'}</span>
          <span title="Active holders">{p.holders} holder{p.holders === 1 ? '' : 's'}</span>
          <span className="text-gray-400">v{p.version}</span>
        </div>
      </div>
      {isOpen && <div id={`policy-${p.id}`} className="space-y-3 bg-gray-50/60 pb-3 pl-14 pr-4 pt-2">
        <div className="flex flex-wrap gap-2">
          {p.kind === 'standard' && <button type="button" onClick={() => setCopying(p)} disabled={!migrationReady} className={`inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40 ${FOCUS}`}><Copy className="h-3 w-3" aria-hidden />Copy &amp; Customize<span className="sr-only"> {p.name}</span></button>}
          {p.kind === 'custom' && p.status !== 'deprecated' && <button type="button" onClick={() => setEditor({ profile: p })} className={`inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 ${FOCUS}`}><Pencil className="h-3 w-3" aria-hidden />{p.draft ? 'Continue draft' : 'Edit (as draft)'}<span className="sr-only"> {p.name}</span></button>}
          {p.kind === 'custom' && p.draft?.status === 'in_review' && <button type="button" onClick={() => setPublish(p)} className={`rounded-md bg-orange-500 px-2 py-1 text-xs font-medium text-white hover:bg-orange-600 ${FOCUS}`}>Review &amp; publish<span className="sr-only"> {p.name}</span></button>}
          {p.kind !== 'compatibility' && (p.holders > 0
            ? <button type="button" onClick={() => toggleHolders(p)} aria-expanded={holdersOpen.has(p.id)} aria-controls={`holders-${p.id}`}
                title="Counts active assignments; a person holding the policy in several organizations counts once per assignment."
                className={`inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 ${FOCUS}`}><Users className="h-3 w-3" aria-hidden />{holdersOpen.has(p.id) ? 'Hide' : 'Show'} holders ({p.holders})<span className="sr-only"> of {p.name}</span></button>
            : <span className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-500"><Users className="h-3 w-3" aria-hidden />0 holders</span>)}
          {canAssign && onAssignProfile && p.kind !== 'compatibility' && p.status === 'active' && <button type="button" onClick={() => onAssignProfile(p)} disabled={!migrationReady}
            title="Opens the People & Access grant form with this policy selected. Nothing is granted until you submit it there."
            className={`inline-flex items-center gap-1 rounded-md border border-orange-200 bg-orange-50 px-2 py-1 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-40 ${FOCUS}`}><UserPlus className="h-3 w-3" aria-hidden />Assign policy<span className="sr-only"> {p.name}</span></button>}
          {p.kind === 'custom' && p.status !== 'deprecated' && <button type="button" onClick={() => retire(p)} disabled={p.holders > 0} title={p.holders > 0 ? 'Revoke or replace the assignments first' : undefined}
            className={`rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-40 ${FOCUS}`}>Retire<span className="sr-only"> {p.name}</span></button>}
        </div>
        {p.kind === 'compatibility' && <p className="text-xs text-gray-500">Managed by the lifecycle; not editable.</p>}
        {holdersOpen.has(p.id) && p.holders > 0 && <div id={`holders-${p.id}`}>
          {!h && <p role="status" className="text-xs text-gray-500">Loading holders…</p>}
          {h && (h.error ? <p role="alert" className="text-xs text-red-700">{h.error}</p> : <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Holders · {h.visible} assignment{h.visible === 1 ? '' : 's'} shown{new Set(h.holders.map((x: any) => x.userId)).size !== h.holders.length ? ` (${new Set(h.holders.map((x: any) => x.userId)).size} people)` : ''}{h.total > h.visible ? ` · ${h.total - h.visible} more in organizations you cannot view` : ''}</div>
          {h.holders.length === 0 ? <p className="text-xs text-gray-500">No active holders in your organizations.</p> : <ul className="mt-1 divide-y divide-gray-100 rounded-md border border-gray-200 bg-white text-xs">
            {h.holders.map((x: any) => <li key={x.assignmentId} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1">
              <span><span className="font-medium text-gray-900">{x.name}</span> <span className="text-gray-500">{x.email}</span></span>
              <span className="text-gray-600">{x.organization} ({orgTypeLabel(x.organizationType)}) · Scope: {(x.scopes || []).join(', ') || '—'}</span></li>)}
          </ul>}
        </div>)}
        </div>}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Permission categories · {categories.length} · {p.permissionKeys.length} permission{p.permissionKeys.length === 1 ? '' : 's'}</div>
            {categories.length > 0 && <div className="flex gap-1.5">
              <button type="button" onClick={() => setCategories(true)} disabled={allCategoriesOpen} className={`rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-default disabled:opacity-40 ${FOCUS}`}>Expand all<span className="sr-only"> categories of {p.name}</span></button>
              <button type="button" onClick={() => setCategories(false)} disabled={!categories.some(c => expanded.has(c.key))} className={`rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-default disabled:opacity-40 ${FOCUS}`}>Collapse all<span className="sr-only"> categories of {p.name}</span></button>
            </div>}
          </div>
          {categories.length === 0 ? <p className="mt-1 text-xs text-gray-500">{p.status === 'draft' ? 'None until published.' : 'No permissions.'}</p> : <ul className="mt-1 ml-1 space-y-0.5 border-l border-gray-200">
            {categories.map(c => {
              const cOpen = expanded.has(c.key)
              return <li key={c.key} className="pl-3">
                <ToggleButton open={cOpen} onClick={() => flip(c.key)} controls={`${c.key}:list`} label={`${multiModule ? `${c.module} · ` : ''}${c.name}, ${c.items.length} permission${c.items.length === 1 ? '' : 's'}`}>
                  <span className="text-sm font-medium text-gray-800">{multiModule ? `${c.module} · ${c.name}` : c.name}</span>
                  <span className="text-xs font-normal text-gray-400">{c.items.length}</span>
                </ToggleButton>
                {cOpen && <ul id={`${c.key}:list`} className="ml-2 mt-0.5 space-y-0.5 border-l border-gray-200 py-0.5 pl-4">
                  {c.items.map(k => <li key={k} title={k} className="text-sm text-gray-900">{permissionLabel(k).label}
                    {supports.has(k) && <span className="ml-1.5 text-xs text-gray-500">· included to support {supports.get(k)!.map(x => permissionLabel(x).label).join(', ')}</span>}</li>)}
                  {notIncluded(c.area).length > 0 && <li className="pt-0.5 text-xs text-gray-500">Does not include: {notIncluded(c.area).map(k => permissionLabel(k).label).join(', ')}</li>}
                </ul>}
              </li>
            })}
          </ul>}
        </div>
      </div>}
    </li>
  }

  if (!profiles && !error) return <p role="status" className="rounded-xl border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">Loading Group Policies…</p>
  if (error) return <div className="space-y-3">
    <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {error.code === 'profiles_migration_missing' ? error.text : `${error.text} Showing the read-only role list.`}</div>
    {fallback}
  </div>

  return <section className="rounded-xl border border-gray-200 bg-white shadow-sm" aria-label="Group Policies">
    <div className="space-y-3 border-b border-gray-100 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0"><div className="flex items-center gap-2"><h2 className="font-semibold text-gray-950">Group Policies</h2><InfoPopover label="About Group Policies"><p>A group of policies assigned together to a user.</p><p>A Group Policy is a named set of permissions you assign to a person together with a data scope. Standard policies are protected: copy one to customize it (Copy & Customize). Changes to a custom policy are drafted, reviewed and published, and never affect current access until then. Assigning a policy does not create organization or department membership and does not enroll anyone in HR or employee self-service.</p></InfoPopover></div></div>
        {view === 'custom' && <button type="button" onClick={() => setEditor({ profile: null })} disabled={!migrationReady}
          className={`inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-40 ${FOCUS}`}><Plus className="h-4 w-4" aria-hidden />New policy</button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterChips label="Policy type" value={view} onChange={setView} items={[
          { id: 'standard', label: 'Standard', count: counts.standard }, { id: 'custom', label: 'Custom', count: counts.custom }, { id: 'compatibility', label: 'Compatibility', count: counts.compatibility },
        ]} />
        <SearchInput value={query} onChange={setQuery} placeholder="Search policies or permissions" label="Search policies" className="ml-auto basis-full sm:basis-auto sm:w-64" />
      </div>
      {view === 'compatibility' && <p className="text-xs text-gray-500">Compatibility roles mirror the legacy role levels and are kept up to date by the lifecycle. They are not Group Policies and cannot be edited, copied or assigned manually.</p>}
    </div>
    <Feedback message={message} />
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2">
      <select value={moduleFilter} onChange={e => setModuleFilter(e.target.value)} aria-label="Module"
        className={`rounded-lg border border-gray-200 bg-white py-1.5 pl-2.5 pr-7 text-sm text-gray-700 ${FOCUS}`}>
        {moduleOptions.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <div className="ml-auto flex items-center gap-2">
        <button type="button" onClick={expandAll} className={`rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 ${FOCUS}`}>Expand all</button>
        <button type="button" onClick={collapseAll} disabled={expanded.size === 0} className={`rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-default disabled:opacity-40 ${FOCUS}`}>Collapse all</button>
      </div>
    </div>
    {searching && <p role="status" className="border-b border-gray-100 bg-orange-50/40 px-4 py-1.5 text-xs text-gray-600">Showing {rows.length} matching profile{rows.length === 1 ? '' : 's'}. Your normal expansion returns when the search is cleared.</p>}
    {rows.length === 0 && (searching || moduleFilter !== 'all') && (counts[view] > 0 || searching) && <EmptyState>{searching ? `No policies match “${query.trim()}”.` : `No ${view} policies match the current filters.`}</EmptyState>}
    {view === 'custom' && counts.custom === 0 && <div role="status" className="flex flex-wrap items-center gap-3 px-4 py-4 text-sm text-gray-500">
      <span>No custom Group Policies yet.</span>
      <button type="button" onClick={() => setView('standard')} className={`rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 ${FOCUS}`}>Browse Standard policies</button>
    </div>}
    <ul className="text-sm">{groupIds.map(gid => {
      const items = byGroup.get(gid) || []
      const mOpen = expanded.has(`m:${gid}`)
      const assignments = items.reduce((n, p) => n + p.holders, 0)
      const label = gid === CROSS_MODULE.id ? CROSS_MODULE.name : moduleGroupName(gid)
      return <li key={gid} className="border-t border-gray-100 first:border-t-0">
        <div className="flex flex-wrap items-center gap-2 bg-gray-50/70 px-4 py-2">
          <ToggleButton open={mOpen} controls={`module-${gid}`} onClick={() => flip(`m:${gid}`)} label={`${label}, ${items.length} profile${items.length === 1 ? '' : 's'}`}>
            <span className="font-semibold text-gray-900">{label}</span>
            <span className="text-xs font-normal text-gray-400">{items.length} profile{items.length === 1 ? '' : 's'}{assignments ? ` · ${assignments} assignment${assignments === 1 ? '' : 's'}` : ''}</span>
          </ToggleButton>
          {gid === CROSS_MODULE.id && <InfoPopover label={`About ${label}`}><p>These policies hold substantive permissions in more than one module. Each is listed once here (and also found through each module filter).</p></InfoPopover>}
        </div>
        {mOpen && items.length === 0 && <div className="flex items-center gap-2 px-8 py-3 text-xs text-gray-500">
          <span>No {view} policies in {label}.</span>
          {uncovered.get(gid) ? <InfoPopover label={`About ${label} coverage`}><p>{uncovered.get(gid)} permission{uncovered.get(gid) === 1 ? ' in this module is' : 's in this module are'} not in any policy yet. That is informational; a custom policy can include {uncovered.get(gid) === 1 ? 'it' : 'them'}.</p></InfoPopover> : null}</div>}
        {mOpen && items.length > 0 && (() => {
          const ordered = sortGroupPolicies(items, p => p.fullAccess ? p.roleKey : null, p => p.name)
          const full = ordered.filter(p => p.fullAccess)
          const rest = ordered.filter(p => !p.fullAccess)
          return <>
            {full.length > 0 && <ul className="divide-y divide-gray-50" aria-label={`${label} Full Access`}>{full.map(p => profileRow(p))}</ul>}
            {full.length > 0 && rest.length > 0 && <p className="px-8 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Narrower policies</p>}
            {rest.length > 0 && <ul className="divide-y divide-gray-50">{rest.map(p => profileRow(p))}</ul>}
          </>
        })()}
      </li>
    })}</ul>

    {editor && <ProfileEditorDialog profile={editor.profile} permissions={permissions} onClose={() => setEditor(null)}
      onSaved={(note, submitted) => { setMessage({ tone: 'ok', text: note }); refresh(); if (!submitted) return; setEditor(null) }} />}
    {publish && <ProfilePublishDialog profile={publish} permissions={permissions} onClose={() => setPublish(null)} onPublished={() => { setMessage({ tone: 'ok', text: 'Policy published and audited.' }); setPublish(null); refresh() }} />}
    {copying && <CopyDialog profile={copying} onClose={() => setCopying(null)} onCopied={() => { setMessage({ tone: 'ok', text: 'Copy created as a draft. Customize it, submit it for review, then publish.' }); setCopying(null); setView('custom'); refresh() }} />}
  </section>
}

function CopyDialog({ profile, onClose, onCopied }: { profile: ProfileSummary; onClose: () => void; onCopied: () => void }) {
  const [name, setName] = useState(`${profile.name} (custom)`)
  const [key, setKey] = useState(slug(`${profile.roleKey}-custom`))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = name.trim().length > 0 && /^[a-z][a-z0-9_-]*$/.test(key) && reason.trim().length >= 10
  async function copy() {
    setBusy(true); setError(null)
    const res = await callApi('/api/security-access/profiles', { body: { action: 'copy', sourceId: profile.id, roleKey: key, name: name.trim(), reason: reason.trim() } })
    setBusy(false)
    if (!res.ok) { setError(res.error || 'Unable to copy'); return }
    onCopied()
  }
  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" role="presentation">
    <div role="dialog" aria-modal="true" aria-labelledby="copy-profile-title" className="my-8 w-full max-w-lg space-y-3 rounded-xl bg-white p-4 shadow-xl">
      <h2 id="copy-profile-title" className="font-semibold text-gray-950">Copy &amp; Customize: {profile.name}</h2>
      <p className="text-sm text-gray-500">Creates your own draft with the same {profile.permissionKeys.length} permissions. The standard original is not changed, and the copy cannot be assigned until it is published.</p>
      <label className="block text-sm"><span className="text-gray-600">Name</span><input value={name} onChange={e => setName(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
      <label className="block text-sm"><span className="text-gray-600">Policy key</span><input value={key} onChange={e => setKey(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 font-mono text-xs" /></label>
      <label className="block text-sm"><span className="text-gray-600">Reason (audited)</span><input value={reason} onChange={e => setReason(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`rounded-lg border border-gray-200 px-3 py-1.5 text-sm ${FOCUS}`}>Cancel</button>
        <button type="button" onClick={copy} disabled={!valid || busy} className={`rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 ${FOCUS}`}>{busy ? 'Copying…' : 'Create copy'}</button>
      </div>
    </div>
  </div>
}
