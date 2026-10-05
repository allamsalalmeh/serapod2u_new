'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Info, Plus, RotateCcw, ShieldOff, SlidersHorizontal, UserRound } from 'lucide-react'
import SearchableSelect from './SearchableSelect'
import { scopeLabels } from '@/lib/security-access/scope-labels'
import { callApi, formatDate, one, toIso } from './client-api'
import { DisclosurePanel, EmptyState, FilterChips, FOCUS, LIST_TEXT, SearchInput, ToggleButton } from './ui'
import {
  CROSS_MODULE, MODULE_FILTER_OPTIONS, OTHER_MODULE, classifyRole, groupByModule, moduleGroupName, roleInModule, type RoleModules,
} from '@/lib/security-access/modules'
import { CATEGORY_LABELS, GRANT_BLOCK_TEXT, type GrantBlock, ORG_TYPE_OPTIONS, categoryLabel, grantBlock, isPartnerOrgType, orgTypeLabel } from '@/lib/security-access/directory-labels'

/** A profile chosen in Access Profiles: preselects the role in the grant form; never grants anything by itself. */
export interface GrantIntent { roleId: string; roleName: string; orgTypes: string[]; nonce: number }

interface Props {
  data: any
  onChanged: () => void
  grantIntent?: GrantIntent | null
}

type PersonFilter = 'all' | 'granted' | 'temporary'
type AccessKind = 'granted' | 'automatic' | 'legacy'
interface Counts { all: number; granted: number; temporary: number; inactive: number; none: number }
interface Directory { people: any[]; total: number; counts: Counts; organizations: any[]; capabilities?: { userManagement?: boolean } }
const ALL = ''
const CATEGORY_OPTIONS = ['INTERNAL_EMPLOYEE', 'MANUFACTURER_USER', 'DISTRIBUTOR_USER', 'SHOP_STAFF', 'CONSUMER', 'UNCLASSIFIED'] as const

const PAGE_SIZE = 25
const ALL_ORGS = '__all'
const AUTOMATIC_SOURCES = new Set(['backfill', 'derived'])
const EMPTY_FORM = { userId: '', organizationId: '', module: 'all', roleId: '', scopeId: '', until: '', reason: '' }

/** Where automatic access comes from (sa_role_assignments.source). */
const AUTOMATIC_SOURCE: Record<string, string> = {
  derived: 'Managed by HR / User Management',
  backfill: 'Set up from the legacy role during migration',
}

const activeAssignments = (p: any) => (p.membership || []).flatMap((m: any) => (m.assignments || []).filter((a: any) => a.status === 'active'))
const isTemporary = (a: any) => a.status === 'active' && !!a.effective_until
const isLegacyRole = (a: any) => one(a.role)?.source === 'legacy'
const accessKind = (a: any): AccessKind => (isLegacyRole(a) ? 'legacy' : AUTOMATIC_SOURCES.has(a.source) ? 'automatic' : 'granted')
const isGranted = (a: any) => accessKind(a) === 'granted'
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** A membership can receive a grant here when active and (when the server told us) grantable. */
const canGrantOn = (m: any) => m.status === 'active' && m.grantable !== false

/** Fallback when the directory migration is not applied: the overview's own-organization list, filtered locally. */
function localDirectory(people: any[], q: string, filter: string, orgId: string): Directory {
  const counts: Counts = { all: 0, granted: 0, temporary: 0, inactive: 0, none: 0 }
  const inOrg = people.filter(p => !orgId || (p.membership || []).some((m: any) => m.organization_id === orgId) || p.organization_id === orgId)
  for (const p of inOrg) {
    const active = activeAssignments(p)
    counts.all += 1
    if (active.some(isGranted)) counts.granted += 1
    if (active.some(isTemporary)) counts.temporary += 1
    if (!p.is_active) counts.inactive += 1
    if (!(p.membership || []).length) counts.none += 1
  }
  const needle = q.trim().toLowerCase()
  const rows = inOrg.filter(p => {
    if (needle && !`${p.full_name || ''} ${p.email || ''} ${p.role_code || ''}`.toLowerCase().includes(needle)) return false
    const active = activeAssignments(p)
    return filter === 'granted' ? active.some(isGranted) : filter === 'temporary' ? active.some(isTemporary)
      : filter === 'inactive' ? !p.is_active : filter === 'none' ? !(p.membership || []).length : true
  })
  return { people: rows, total: rows.length, counts, organizations: [] }
}

/**
 * People & Access: person → organization membership → access. The directory is
 * searched and paged ON THE SERVER across the organizations this administrator
 * is authorized for (never a client-side filter over a truncated list). Each
 * membership separates explicitly Granted access, Automatic (lifecycle)
 * access and Legacy compatibility access; roles are grouped by the shared S&A
 * module taxonomy (display only). Viewing a person never implies the right to
 * grant: grant eligibility is computed per membership by the server and again
 * by the database when the grant is submitted.
 */
export default function PeopleAccessPanel({ data, onChanged, grantIntent = null }: Props) {
  const allRoles: any[] = useMemo(() => data.roles || [], [data.roles])
  const grantableRoles: any[] = allRoles.filter((r: any) => r.source !== 'legacy' && r.status === 'active')
  const scopes: any[] = data.scopeDefinitions || []
  // Automatic access an administrator revoked; restoring hands it back to the lifecycle.
  const restorable = useMemo(() => new Set<string>(data.restorableAssignmentIds || []), [data.restorableAssignmentIds])
  const orgName = useMemo(() => new Map((data.organizations || []).map((o: any) => [o.id, o.org_name])), [data.organizations])
  const roleModules = useMemo(() => new Map<string, RoleModules>(allRoles.map((r: any) => [r.id, classifyRole(r)])), [allRoles])
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [filter, setFilter] = useState<PersonFilter>('all')
  const [orgFilter, setOrgFilter] = useState(ALL_ORGS)
  const [category, setCategory] = useState(ALL)
  const [orgType, setOrgType] = useState(ALL)
  const [status, setStatus] = useState('all')
  const [membershipFilter, setMembershipFilter] = useState('all')
  const [moreOpen, setMoreOpen] = useState(false)
  const [dir, setDir] = useState<Directory | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<{ text: string; code?: string } | null>(null)
  const [fallback, setFallback] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const grantLock = useRef(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Profile pinned by "Assign profile"; survives choosing a person but not closing the form.
  const [pinned, setPinned] = useState<{ roleId: string; roleName: string; orgTypes: string[] } | null>(null)
  // Bumped only by an explicit grant start; the effect below scrolls once the form is rendered.
  const [scrollRequest, setScrollRequest] = useState(0)

  useEffect(() => { const t = setTimeout(() => setDebounced(query.trim()), 250); return () => clearTimeout(t) }, [query])

  const fetchPage = useCallback(async (offset: number) => {
    const params = new URLSearchParams({ q: debounced, filter, offset: String(offset), limit: String(PAGE_SIZE) })
    if (orgFilter !== ALL_ORGS) params.set('org', orgFilter)
    if (category) params.set('category', category)
    if (orgType) params.set('orgType', orgType)
    if (status !== 'all') params.set('status', status)
    if (membershipFilter !== 'all') params.set('membership', membershipFilter)
    return callApi(`/api/security-access/people?${params}`)
  }, [debounced, filter, orgFilter, category, orgType, status, membershipFilter])

  // First page whenever the search, filter, organization or data version changes.
  useEffect(() => {
    const id = ++request.current
    setLoading(true); setLoadError(null)
    fetchPage(0).then(res => {
      if (id !== request.current) return
      setLoading(false)
      if (res.ok) { setFallback(false); setDir(res.data); return }
      if (res.code === 'directory_migration_missing') { setFallback(true); setDir(localDirectory(data.people || [], debounced, filter, orgFilter === ALL_ORGS ? '' : orgFilter)); return }
      setDir(null)
      setLoadError({ text: res.error || 'The directory could not be loaded.', code: res.code })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage, reloadKey])

  async function loadMore() {
    if (!dir || fallback) return
    setLoadingMore(true)
    const res = await fetchPage(dir.people.length)
    setLoadingMore(false)
    if (res.ok) setDir(prev => prev ? { ...res.data, people: [...prev.people, ...res.data.people] } : res.data)
    else setLoadError({ text: res.error || 'More people could not be loaded.', code: res.code })
  }
  const afterChange = () => { setReloadKey(k => k + 1); onChanged() }

  const people: any[] = dir?.people ?? []
  const counts: Counts = dir?.counts ?? { all: 0, granted: 0, temporary: 0, inactive: 0, none: 0 }
  const organizations: any[] = dir?.organizations?.length ? dir.organizations : []
  // The organization list follows the organization-type selection, so the two can't contradict each other.
  const orgOptions = [{ value: ALL_ORGS, label: 'All authorized organizations', description: organizations.length ? `${organizations.length} organizations` : undefined },
    ...organizations.filter((o: any) => !orgType || String(o.org_type_code).toUpperCase() === orgType)
      .map((o: any) => ({ value: o.organization_id ?? o.id, label: o.org_name, description: `${orgTypeLabel(o.org_type_code)} · ${plural(Number(o.people_count ?? 0), 'person').replace('persons', 'people')}`, keywords: `${o.org_type_code}` }))]
  const changeOrgType = (next: string) => {
    setOrgType(next)
    // An organization of another type would give an empty result: reset it instead.
    const selected = organizations.find((o: any) => (o.organization_id ?? o.id) === orgFilter)
    if (next && selected && String(selected.org_type_code).toUpperCase() !== next) setOrgFilter(ALL_ORGS)
  }
  const filtersActive = Boolean(category || orgType || orgFilter !== ALL_ORGS || status !== 'all' || membershipFilter !== 'all' || query.trim() || filter !== 'all')
  const clearFilters = () => { setCategory(ALL); setOrgType(ALL); setOrgFilter(ALL_ORGS); setStatus('all'); setMembershipFilter('all'); setQuery(''); setDebounced(''); setFilter('all') }
  const selectClass = `mt-1 w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-sm text-gray-800 ${FOCUS}`
  const scopeLabel = orgFilter === ALL_ORGS ? 'all authorized organizations' : String(organizations.find((o: any) => (o.organization_id ?? o.id) === orgFilter)?.org_name ?? 'the selected organization')
  const nameOf = (m: any) => String(one(m.organization)?.org_name || orgName.get(m.organization_id) || 'Organization')

  // ── Grant flow: Person → Membership → Module filter → Role → Scope → Reason
  // The person picker is a server search (same visibility rules, grantable memberships only).
  const [grantQuery, setGrantQuery] = useState('')
  const [grantResults, setGrantResults] = useState<any[]>([])
  const [grantSearching, setGrantSearching] = useState(false)
  const [formPerson, setFormPerson] = useState<any | null>(null)
  useEffect(() => {
    if (!formOpen || fallback) return
    let cancelled = false
    const t = setTimeout(async () => {
      setGrantSearching(true)
      const res = await callApi(`/api/security-access/people?${new URLSearchParams({ q: grantQuery.trim(), filter: 'all', offset: '0', limit: '20' })}`)
      if (!cancelled) { setGrantSearching(false); if (res.ok) setGrantResults(res.data.people || []) }
    }, grantQuery ? 250 : 0)
    return () => { cancelled = true; clearTimeout(t) }
  }, [formOpen, grantQuery, fallback, reloadKey])
  const known = useMemo(() => {
    const map = new Map<string, any>()
    for (const p of [...(fallback ? data.people || [] : []), ...grantResults, ...people]) map.set(p.id, p)
    if (formPerson) map.set(formPerson.id, formPerson)
    return map
  }, [grantResults, people, formPerson, fallback, data.people])
  const grantCandidates = Array.from(known.values()).filter(p => p.id !== data.viewerId && (p.membership || []).some(canGrantOn))

  // Memberships whose organization type the pinned profile does not cover are shown but not selectable (the database checks too).
  const applies = (m: any) => !pinned || pinned.orgTypes.length === 0 || pinned.orgTypes.includes(String(one(m.organization)?.org_type_code ?? '').toUpperCase())
  const eligibleMemberships = (userId: string): any[] => ((known.get(userId)?.membership) || []).filter(canGrantOn)
  const memberships: any[] = form.userId ? eligibleMemberships(form.userId) : []
  // Profiles the person already holds in this membership are shown as "Already held" (not selectable):
  // granting again would duplicate access or take over automatic access.
  const heldKinds = new Map<string, AccessKind>()
  for (const a of memberships.filter(m => m.organization_id === form.organizationId)
    .flatMap((m: any) => (m.assignments || []).filter((x: any) => x.status === 'active' && !(x.effective_until && new Date(x.effective_until) <= new Date())))) {
    const id = one(a.role)?.id
    if (id) heldKinds.set(id, accessKind(a))
  }
  const HELD_TEXT: Record<AccessKind, string> = { granted: 'Already held — granted by an administrator', automatic: 'Already held — automatic access (managed by HR / User Management)', legacy: 'Already held — compatibility access' }
  const visibleRoles = grantableRoles.filter(r => roleInModule(r, form.module, roleModules.get(r.id)))
  const roleOptions = visibleRoles.filter(r => !heldKinds.has(r.id))
  const heldRoles = visibleRoles.filter(r => heldKinds.has(r.id))
  const scopeText = useMemo(() => scopeLabels(scopes, new Map<string, string>((data.organizations || []).map((o: any) => [o.id, o.org_name]))), [scopes, data.organizations])
  const scopeOptions = scopes.filter(s => !!form.organizationId && s.organization_id === form.organizationId && s.scope_type !== 'own_record')
  // Never submit a selection that is no longer offered (stale after a filter change).
  const roleValid = roleOptions.some(r => r.id === form.roleId)
  const scopeValid = scopeOptions.some(s => s.id === form.scopeId)
  const membershipValid = memberships.some(m => m.organization_id === form.organizationId && applies(m))

  const pickPerson = (userId: string) => {
    const person = userId ? known.get(userId) ?? null : null
    setFormPerson(person)
    const eligible = userId ? eligibleMemberships(userId).filter(applies) : []
    // Exactly one eligible membership is selected for you; never a default HQ.
    setForm(f => ({ ...EMPTY_FORM, roleId: pinned && f.roleId === pinned.roleId ? f.roleId : '', userId, organizationId: eligible.length === 1 ? eligible[0].organization_id : '' }))
  }
  const pickModule = (module: string) => setForm(f => ({
    ...f, module, roleId: grantableRoles.some(r => r.id === f.roleId && roleInModule(r, module, roleModules.get(r.id))) ? f.roleId : '',
  }))

  const toggle = (id: string) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const startGrant = (userId = '') => {
    if (userId) setFormPerson(known.get(userId) ?? null)
    pickPerson(userId)
    setMessage(null)
    setFormOpen(true)
    setScrollRequest(n => n + 1)
  }
  const closeForm = () => { setFormOpen(false); setPinned(null) }

  // Profile-first entry: open the same grant form with the chosen profile selected (no person yet).
  useEffect(() => {
    if (!grantIntent) return
    setPinned({ roleId: grantIntent.roleId, roleName: grantIntent.roleName, orgTypes: (grantIntent.orgTypes || []).map(t => t.toUpperCase()) })
    setFormPerson(null); setForm({ ...EMPTY_FORM, roleId: grantIntent.roleId }); setMessage(null); setFormOpen(true)
    setScrollRequest(n => n + 1)
  }, [grantIntent?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll the real scrolling container (this page nests one) to the form heading, then focus it. Runs after the
  // form is committed and only for an explicit grant start — never for searches or background refreshes.
  useEffect(() => {
    if (scrollRequest === 0) return
    const el = headingRef.current
    if (!el) return
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    try { el.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }) } catch { /* not supported */ }
    el.focus({ preventScroll: true })
  }, [scrollRequest])

  async function grant() {
    if (!roleValid || !scopeValid || !membershipValid || grantLock.current) return
    grantLock.current = true
    setBusy(true); setMessage(null)
    const result = await callApi('/api/security-access/assignments', { body: {
      action: 'grant', userId: form.userId, roleId: form.roleId, organizationId: form.organizationId,
      scopeIds: [form.scopeId], effectiveUntil: toIso(form.until), reason: form.reason,
    } })
    setBusy(false); grantLock.current = false
    if (!result.ok) {
      const held = /already holds/i.test(result.error || '')
      setMessage({ tone: 'error', text: held ? 'Already assigned: this person already holds that profile. Nothing was changed.' : result.error || 'Unable to grant access' })
      if (held) afterChange() // the directory was stale: reload so the existing assignment is visible
      return
    }
    setMessage({ tone: 'ok', text: 'Access granted and recorded in the access change log.' })
    setForm(EMPTY_FORM)
    setFormOpen(false); setPinned(null)
    afterChange()
  }

  async function revoke(assignment: any) {
    const name = one(assignment.role)?.name || 'this role'
    const automatic = accessKind(assignment) !== 'granted'
    const reason = window.prompt(automatic
      ? `${name} is automatic access (${AUTOMATIC_SOURCE[assignment.source] ?? 'lifecycle'}). Revoking overrides the automatic rule for this person; it will not be re-added automatically (an administrator can restore it later). Reason for revoking?`
      : `Reason for revoking ${name}?`)
    if (!reason || reason.trim().length < 5) return
    const result = await callApi('/api/security-access/assignments', { body: { action: 'revoke', assignmentId: assignment.id, reason } })
    setMessage(result.ok ? { tone: 'ok', text: 'Access revoked.' } : { tone: 'error', text: result.error || 'Unable to revoke' })
    if (result.ok) afterChange()
  }

  async function restore(assignment: any) {
    const name = one(assignment.role)?.name || 'this role'
    const reason = window.prompt(`Restore ${name}? It returns to automatic access managed by HR / User Management. Reason for restoring?`)
    if (!reason || reason.trim().length < 5) return
    const result = await callApi('/api/security-access/assignments', { body: { action: 'restore', assignmentId: assignment.id, reason } })
    setMessage(result.ok ? { tone: 'ok', text: 'Access restored to automatic management.' } : { tone: 'error', text: result.error || 'Unable to restore' })
    if (result.ok) afterChange()
  }

  const selectedPerson = known.get(form.userId)
  const moduleSelect = [{ id: 'all', name: 'All modules' }, ...MODULE_FILTER_OPTIONS, CROSS_MODULE, OTHER_MODULE]
    .filter(m => m.id === 'all' || grantableRoles.some(r => roleInModule(r, m.id, roleModules.get(r.id))))
  const selectedBlocked = selectedPerson && memberships.length === 0
  const formBlock = selectedPerson ? grantBlock(selectedPerson, data.viewerId) : null

  return <div className="space-y-4">
    <DisclosurePanel headingRef={headingRef} title="Grant a business role" open={formOpen} onToggle={() => (formOpen ? closeForm() : startGrant())} actionLabel="Grant access"
      description="Access is granted to one organization membership and always carries a scope. Module only narrows the role list; it never grants module-wide access.">
      {pinned && <p role="note" className="border-b border-gray-100 bg-orange-50/40 px-4 py-2 text-xs text-gray-700">
        Assigning the profile <span className="font-medium">{pinned.roleName}</span>. Choose a person, an active membership and an explicit scope, then give a reason. {grantableRoles.some(r => r.id === pinned.roleId) ? 'The profile itself is not changed.' : 'This profile is no longer assignable (draft, retired or compatibility), so it cannot be granted here.'}</p>}
      <div className="grid gap-4 p-4 md:grid-cols-3">
        <SearchableSelect label="Person" value={form.userId} onChange={pickPerson} onQueryChange={fallback ? undefined : setGrantQuery} loading={grantSearching}
          options={grantCandidates.map(p => ({ value: p.id, label: p.full_name || p.email, description: `${p.email} · ${(p.membership || []).filter(canGrantOn).map(nameOf).join(', ')}`, keywords: p.role_code }))}
          placeholder="Search a person you can grant to" emptyText="No grantable person matches." />
        <div>
          <SearchableSelect label="Membership organization" value={form.organizationId} onChange={v => setForm({ ...form, organizationId: v, scopeId: '' })}
            options={memberships.map(m => ({ value: m.organization_id, label: nameOf(m), disabled: !applies(m), description: `${orgTypeLabel(one(m.organization)?.org_type_code)}${m.is_primary ? ' · Primary membership' : ''}${applies(m) ? '' : ' · Profile does not apply to this organization type'}` }))}
            placeholder={!form.userId ? 'Choose a person first' : memberships.length ? 'Choose a membership' : 'No active membership'} disabled={!form.userId || memberships.length === 0} />
          {form.userId && memberships.length === 1 && <p className="mt-1 text-xs text-gray-500">Their only active membership — selected for you.</p>}
          {form.userId && selectedBlocked && <p role="note" className="mt-1 text-xs text-gray-600">{GRANT_BLOCK_TEXT[formBlock ?? 'no_membership']}</p>}
          {memberships.length > 1 && !form.organizationId && <p className="mt-1 text-xs text-gray-500">{memberships.length} active memberships — choose the one this access is for.</p>}
        </div>
        <label className="text-sm"><span className="text-gray-600">Module (filters the role list)</span>
          <select value={form.module} onChange={e => pickModule(e.target.value)} aria-label="Module filter"
            className={`mt-1 w-full rounded-lg border bg-white px-3 py-2 ${FOCUS}`}>
            {moduleSelect.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select></label>
        <SearchableSelect label="Business role" value={roleValid ? form.roleId : ''} onChange={v => setForm({ ...form, roleId: v })}
          options={[...roleOptions, ...heldRoles].map(r => {
            const cls = roleModules.get(r.id)
            const tags = cls?.crossModule ? cls.modules.map(moduleGroupName).join(', ') : (cls?.related || []).map(moduleGroupName).join(', ')
            const held = heldKinds.get(r.id)
            return { value: r.id, label: r.name, disabled: !!held, description: held ? HELD_TEXT[held] : [r.description, tags && `Also: ${tags}`].filter(Boolean).join(' · ') || undefined, group: cls ? moduleGroupName(cls.groupId) : undefined }
          })}
          placeholder={roleOptions.length ? 'Choose a role' : 'No roles in this module'} />
        <SearchableSelect label="Scope" value={scopeValid ? form.scopeId : ''} onChange={v => setForm({ ...form, scopeId: v })}
          options={scopeOptions.map(s => ({ value: s.id, label: scopeText.get(s.id) ?? s.display_name, description: s.scope_type.replace(/_/g, ' ') }))}
          placeholder={form.organizationId ? 'Choose a scope' : 'Choose a membership first'} disabled={!form.organizationId} />
        <label className="text-sm"><span className="text-gray-600">Ends (optional — temporary access)</span>
          <input type="datetime-local" value={form.until} onChange={e => setForm({ ...form, until: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <label className="text-sm md:col-span-3"><span className="text-gray-600">Reason</span>
          <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="Why is this access needed?" className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 p-4">
        <button disabled={busy || !form.userId || !membershipValid || !roleValid || !scopeValid || form.reason.trim().length < 5}
          onClick={grant} className={`inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 ${FOCUS}`}>
          <Plus className="h-4 w-4" aria-hidden />Grant access</button>
        <span className="text-xs text-gray-500">You cannot grant access to yourself. Scope, separation of duties and your own authority in the target organization are checked when you submit.</span>
      </div>
    </DisclosurePanel>

    {message && <div role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{message.text}</div>}
    {fallback && <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      Only your own organization is listed: searching every authorized organization needs the database migration <code>20261005100000_sa_directory_visibility.sql</code>, which has not been applied here yet.</div>}

    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="space-y-3 border-b border-gray-100 p-4">
        <div className="min-w-0"><h2 className="font-semibold text-gray-950">People and their access</h2>
          <p className="text-sm text-gray-500">Granted access is given by an administrator. Automatic access follows HR and User Management; leavers lose business access automatically. Search and filters cover everyone in your authorized scope.</p></div>
        {!fallback && <div role="group" aria-label="Directory filters" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-medium text-gray-600">User category
            <select aria-label="User category" value={category} onChange={e => setCategory(e.target.value)} className={selectClass}>
              <option value="">All categories</option>
              {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select></label>
          <label className="text-xs font-medium text-gray-600">Organization type
            <select aria-label="Organization type" value={orgType} onChange={e => changeOrgType(e.target.value)} className={selectClass}>
              <option value="">All types</option>
              {ORG_TYPE_OPTIONS.map(t => <option key={t} value={t}>{orgTypeLabel(t)}</option>)}
            </select></label>
          <SearchableSelect label="Organization" value={orgFilter} onChange={v => setOrgFilter(v || ALL_ORGS)} options={orgOptions} placeholder="All authorized organizations" />
          <div className="text-xs font-medium text-gray-600"><span>Search</span><SearchInput value={query} onChange={setQuery} placeholder="Search name or email" label="Search people" className="mt-1" /></div>
        </div>}
        {fallback && <SearchInput value={query} onChange={setQuery} placeholder="Search name or email" label="Search people" className="sm:w-72" />}
        {!fallback && <div className="flex flex-wrap items-center gap-2">
          <button type="button" aria-expanded={moreOpen} aria-controls="people-more-filters" onClick={() => setMoreOpen(v => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 ${FOCUS}`}>
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />More filters{status !== 'all' || membershipFilter !== 'all' ? ' (active)' : ''}</button>
          {filtersActive && <button type="button" onClick={clearFilters} className={`rounded text-xs font-medium text-orange-600 hover:text-orange-700 ${FOCUS}`}>Clear filters</button>}
        </div>}
        {moreOpen && !fallback && <div id="people-more-filters" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-medium text-gray-600">Account status
            <select aria-label="Account status" value={status} onChange={e => setStatus(e.target.value)} className={selectClass}>
              <option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
          <label className="text-xs font-medium text-gray-600">Business membership
            <select aria-label="Business membership" value={membershipFilter} onChange={e => setMembershipFilter(e.target.value)} className={selectClass}>
              <option value="all">All</option><option value="has">Has active membership</option><option value="none">No active membership</option></select></label>
        </div>}
      </div>
      <div className="border-b border-gray-100 px-4 py-2">
        <FilterChips label="Access" value={filter} onChange={setFilter} items={[
          { id: 'all', label: 'Everyone', count: counts.all },
          { id: 'granted', label: 'With granted roles', count: counts.granted },
          { id: 'temporary', label: 'Temporary access', count: counts.temporary },
        ]} />
        <p className="mt-1 text-xs text-gray-400">Counts cover {scopeLabel} with the category, type, organization, status and membership filters applied; search and the access filter narrow the list, not the counts.</p>
      </div>

      {loading && <p role="status" className="px-4 py-6 text-center text-sm text-gray-500">Loading people…</p>}
      {!loading && loadError && <div role="alert" className="px-4 py-6 text-center text-sm text-red-700">
        {loadError.text} <button type="button" onClick={() => setReloadKey(k => k + 1)} className={`rounded font-medium underline ${FOCUS}`}>Try again</button></div>}
      {!loading && !loadError && people.length === 0 && <div className="px-4 py-6 text-center text-sm text-gray-500">
        {debounced ? `No people match “${debounced}” in ${scopeLabel}.` : filtersActive ? `No people match these filters in ${scopeLabel}.` : `No people in ${scopeLabel} for this view.`}
        {filtersActive && <> <button type="button" onClick={clearFilters} className={`rounded font-medium text-orange-600 underline ${FOCUS}`}>Clear filters</button></>}</div>}
      <ul className={`divide-y divide-gray-100 ${LIST_TEXT}`}>
        {!loading && people.map(p => {
          const active = activeAssignments(p)
          const count = (k: AccessKind) => active.filter((a: any) => accessKind(a) === k).length
          const temporary = active.filter(isTemporary).length
          const primary = (p.membership || []).find((m: any) => m.is_primary) || (p.membership || [])[0]
          const homeOrg = one(p.organization)
          const orgTypeCode = one(primary?.organization)?.org_type_code ?? homeOrg?.org_type_code
          const isOpen = open.has(p.id)
          const block = grantBlock(p, data.viewerId)
          return <li key={p.id}>
            <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1 px-4 py-2.5 md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_auto]">
              <ToggleButton open={isOpen} onClick={() => toggle(p.id)} label={`${p.full_name || p.email}, ${active.length} active role${active.length === 1 ? '' : 's'}`}>
                <UserRound className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-gray-900">{p.full_name || p.email}</span>
                  <span className="block truncate text-xs text-gray-500">{p.email}</span>
                </span>
              </ToggleButton>
              <div className="min-w-0 pl-6 text-xs text-gray-600 md:pl-0">
                <div className="truncate">{primary ? nameOf(primary) : homeOrg?.org_name ? String(homeOrg.org_name) : 'No business membership'}
                  {(p.membership || []).length > 1 && <span className="text-gray-400"> +{(p.membership || []).length - 1} more</span>}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-gray-400">
                  {orgTypeCode && <span className="rounded border border-gray-200 px-1 text-[11px] text-gray-600">{orgTypeLabel(orgTypeCode)}</span>}
                  {isPartnerOrgType(orgTypeCode) && <span className="rounded-full bg-indigo-50 px-1.5 text-[11px] font-medium text-indigo-700">Partner</span>}
                  <span className="rounded border border-gray-200 px-1 text-[11px] text-gray-600" title="User category (identity classification)">{categoryLabel(p.principal_type)}</span>
                  <span title="Legacy role code (compatibility input only)">Legacy role: {p.role_code || '—'}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 pl-6 text-xs md:pl-0">
                {!p.is_active && <span className="rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-700">Inactive</span>}
                <span className={count('granted') ? 'rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700' : 'text-gray-400'}>{count('granted')} granted</span>
                <span className="text-gray-500">{count('automatic')} automatic</span>
                {count('legacy') > 0 && <span className="text-gray-400">{count('legacy')} legacy</span>}
                {temporary > 0 && <span className="inline-flex items-center gap-1 text-amber-700"><Clock className="h-3 w-3" aria-hidden />{temporary} temporary</span>}
              </div>
              <div className="pl-6 md:pl-0 md:text-right">
                {!block
                  ? <button type="button" onClick={() => startGrant(p.id)} className={`inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 ${FOCUS}`}>
                    <Plus className="h-3 w-3" aria-hidden />Grant role<span className="sr-only"> to {p.full_name || p.email}</span></button>
                  : <GrantUnavailable person={p} block={block} partner={isPartnerOrgType(orgTypeCode) || ['MANUFACTURER_USER', 'DISTRIBUTOR_USER', 'SHOP_STAFF'].includes(p.principal_type)} userManagementLink={Boolean(dir?.capabilities?.userManagement)} />}
              </div>
            </div>
            {isOpen && <PersonDetail person={p} orgName={orgName} roleModules={roleModules} canRevoke={p.id !== data.viewerId} onRevoke={revoke} restorable={restorable} onRestore={restore} />}
          </li>
        })}
      </ul>
      {!loading && !loadError && dir && people.length < dir.total && <div className="border-t border-gray-100 px-4 py-2 text-center">
        <button type="button" onClick={loadMore} disabled={loadingMore} className={`rounded text-sm font-medium text-orange-600 hover:text-orange-700 disabled:opacity-50 ${FOCUS}`}>
          {loadingMore ? 'Loading…' : 'Show more'} <span className="text-gray-400">({people.length} of {dir.total})</span></button></div>}
    </section>
  </div>
}

const SECTIONS: Array<{ kind: AccessKind; title: string; help: string }> = [
  { kind: 'granted', title: 'Granted access', help: 'Given by a Security & Access administrator or an approved request.' },
  { kind: 'automatic', title: 'Automatic access', help: 'Follows HR / User Management facts; added and removed by the lifecycle.' },
  { kind: 'legacy', title: 'Legacy access', help: 'Compatibility roles mirroring the legacy role code.' },
]

function PersonDetail({ person: p, orgName, roleModules, canRevoke, onRevoke, restorable, onRestore }: {
  person: any; orgName: Map<any, any>; roleModules: Map<string, RoleModules>; canRevoke: boolean; onRevoke: (a: any) => void
  restorable: Set<string>; onRestore: (a: any) => void
}) {
  // Toggled ids; granted sections and their modules start open, the rest folded.
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const flip = (id: string) => setToggled(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  if (!(p.membership || []).length) {
    return <div className="bg-gray-50/60 px-4 py-3 pl-10 text-sm text-gray-600">
      <p>No active business membership</p>
      <p className="text-xs text-gray-400">Category: {categoryLabel(p.principal_type)}. Business access is shown here only when an active membership exists; this says nothing about other kinds of access.</p></div>
  }
  return <div className="space-y-3 bg-gray-50/60 px-4 py-3 md:pl-10">
    {(p.membership || []).map((m: any) => {
      const list: any[] = m.assignments || []
      return <div key={m.id} className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
          {String(one(m.organization)?.org_name || orgName.get(m.organization_id) || one(p.organization)?.org_name || 'Organization')}{one(m.organization)?.org_type_code ? ` (${orgTypeLabel(one(m.organization)?.org_type_code)})` : ''} · {m.status}{m.is_primary ? ' · primary' : ''}
        </div>
        {list.length === 0 && <p className="px-3 py-2 text-sm text-gray-500">No role assignments.</p>}
        {SECTIONS.map(section => {
          const items = list.filter(a => accessKind(a) === section.kind)
          if (!items.length) return null
          const sectionId = `${m.id}/${section.kind}`
          const startsOpen = section.kind === 'granted'
          const sectionOpen = startsOpen !== toggled.has(sectionId)
          const groups = groupByModule(items, a => roleModules.get(one(a.role)?.id)?.groupId ?? OTHER_MODULE.id)
          return <div key={section.kind} className="border-t border-gray-100 first:border-t-0">
            <div className="flex flex-wrap items-center justify-between gap-x-3 px-3 py-2">
              <ToggleButton open={sectionOpen} onClick={() => flip(sectionId)} label={`${section.title}, ${items.length}`}>
                <span className="text-sm font-semibold text-gray-800">{section.title}</span>
                <span className="text-xs text-gray-400">{plural(items.length, 'role')} · {plural(groups.length, 'module')}</span>
              </ToggleButton>
              <span className="hidden text-xs text-gray-400 sm:inline">{section.help}</span>
            </div>
            {sectionOpen && <ul className="pb-1">{groups.map(g => {
              const gid = `${sectionId}/${g.id}`
              const gOpen = startsOpen !== toggled.has(gid)
              return <li key={g.id}>
                <div className="flex items-center gap-2 bg-gray-50/70 py-1.5 pl-8 pr-3">
                  <ToggleButton open={gOpen} onClick={() => flip(gid)} label={`${section.title}: ${g.name}, ${plural(g.items.length, 'role')}`}>
                    <span className="whitespace-nowrap text-sm font-medium text-gray-800">{g.name}</span>
                    <span className="text-xs text-gray-400">{g.items.length}</span>
                  </ToggleButton>
                  {!gOpen && <span className="hidden min-w-0 truncate text-xs text-gray-400 md:inline">{g.items.map(a => one(a.role)?.name).filter(Boolean).join(', ')}</span>}
                </div>
                {gOpen && <AssignmentList list={g.items} kind={section.kind} roleModules={roleModules} canRevoke={canRevoke} onRevoke={onRevoke} restorable={restorable} onRestore={onRestore} />}
              </li>
            })}</ul>}
          </div>
        })}
      </div>
    })}
  </div>
}

function AssignmentList({ list, kind, roleModules, canRevoke, onRevoke, restorable, onRestore }: {
  list: any[]; kind: AccessKind; roleModules: Map<string, RoleModules>; canRevoke: boolean; onRevoke: (a: any) => void
  restorable: Set<string>; onRestore: (a: any) => void
}) {
  return <ul className="divide-y divide-gray-50">{list.map((a: any) => {
    const role = one(a.role)
    const cls = roleModules.get(role?.id)
    const scopeNames = (a.scopes || []).map((s: any) => one(s.scope)?.display_name).filter(Boolean).join(', ') || '—'
    const expired = a.effective_until && new Date(a.effective_until) <= new Date()
    const current = a.status === 'active' && !expired
    const tags = cls?.crossModule ? cls.modules : cls?.related || []
    return <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 pl-14 pr-3 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={current ? 'font-medium text-gray-900' : 'text-gray-400 line-through'}>{role?.name || 'Role'}</span>
        {tags.length > 0 && <span className="text-[11px] text-gray-400" title="Other modules this role's permissions touch">also {tags.map(moduleGroupName).join(', ')}</span>}
        <span className="text-xs text-gray-500">Scope: {scopeNames}</span>
        {a.source === 'access_request' && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700">Approved request</span>}
        {kind !== 'granted' && AUTOMATIC_SOURCE[a.source] && <span className="text-[11px] text-gray-400">{AUTOMATIC_SOURCE[a.source]}</span>}
        {a.effective_until && <span className="inline-flex items-center gap-1 text-xs text-amber-700"><Clock className="h-3 w-3" aria-hidden />{a.status === 'revoked' ? 'Ended' : expired ? 'Expired' : 'Until'} {formatDate(a.effective_until)}</span>}
        {a.status !== 'active' && <span className="text-xs text-gray-400">{a.status}</span>}
        {restorable.has(a.id) && <span className="text-[11px] text-gray-400">Automatic access revoked by an administrator</span>}
      </div>
      {a.status === 'active' && canRevoke && <button type="button" onClick={() => onRevoke(a)}
        title={kind === 'granted' ? undefined : 'Overrides the automatic rule for this person'}
        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-red-50 hover:text-red-700 ${FOCUS}`}>
        <ShieldOff className="h-3 w-3" aria-hidden />Revoke<span className="sr-only"> {role?.name || 'role'}</span></button>}
      {restorable.has(a.id) && canRevoke && <button type="button" onClick={() => onRestore(a)}
        title="Returns this role to automatic management"
        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-emerald-50 hover:text-emerald-700 ${FOCUS}`}>
        <RotateCcw className="h-3 w-3" aria-hidden />Restore<span className="sr-only"> {role?.name || 'role'}</span></button>}
    </li>
  })}</ul>
}


/**
 * Neutral explanation of why Grant is unavailable: a normal state (not an error). It is a real
 * button (keyboard and touch), not a hover tooltip on a disabled control, and the text is
 * always in the DOM once opened.
 */
function GrantUnavailable({ person, block, partner, userManagementLink }: { person: any; block: GrantBlock; partner: boolean; userManagementLink: boolean }) {
  const [open, setOpen] = useState(false)
  const id = `grant-why-${person.id}`
  const name = person.full_name || person.email
  return <div className="md:ml-auto md:max-w-[16rem]">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(v => !v)}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 ${FOCUS}`}>
      <Info className="h-3 w-3" aria-hidden />Grant unavailable<span className="sr-only"> for {name}: show why</span></button>
    {open && <p id={id} role="note" className="mt-1 text-left text-[11px] leading-snug text-gray-600">
      {GRANT_BLOCK_TEXT[block]}
      {block === 'no_membership' && partner && userManagementLink && <> Partner accounts are onboarded in <a href="/users" className="font-medium text-orange-600 underline">User Management</a>.</>}
    </p>}
  </div>
}
