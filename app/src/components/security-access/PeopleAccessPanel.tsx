'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Plus, RotateCcw, ShieldOff, SlidersHorizontal, StickyNote, UserRound, X } from 'lucide-react'
import SearchableSelect from './SearchableSelect'
import { sortGroupPolicies } from '@/lib/security-access/group-policies'
import { SCOPE_HELP, WAREHOUSE_PARTIAL_DETAIL, choiceAllowedForPolicy, warehousePartialNote, warehouseSupportFor, warehouseUnsupportedMessage } from '@/lib/security-access/scope-eligibility'
import { scopeLabels } from '@/lib/security-access/scope-labels'
import { callApi, formatDate, one, toIso } from './client-api'
import { FilterChips, FOCUS, InfoPopover, LIST_TEXT, SearchInput, ToggleButton } from './ui'
import {
  CROSS_MODULE, MODULE_FILTER_OPTIONS, OTHER_MODULE, classifyRole, groupByModule, moduleGroupName, roleInModule, rolePermissionKeys, type RoleModules,
} from '@/lib/security-access/modules'
import { partitionPoliciesForRecipient, recipientEligibility, unavailablePoliciesNote, type EligibilityModel } from '@/lib/security-access/recipient-eligibility'
import { COVERED_MODULES_NOTE, type CoverageRole, coveredPermissions, fullyCoveredModules, grantableModulePermissions, isRedundantPolicy } from '@/lib/security-access/grant-coverage'
import { CATEGORY_LABELS, GRANT_BLOCK_TEXT, type GrantBlock, ORG_TYPE_OPTIONS, categoryLabel, grantBlock, isPartnerOrgType, orgTypeLabel } from '@/lib/security-access/directory-labels'
import type { RootAccessCapability } from '@/lib/security-access/root-access-shared'
import { AccessLevelSelector, RootAccessCard, RootBadge, RootGrantForm, holdsRootAccess, type AccessLevel } from './RootAccess'
import RestoreGrantDialog, { type RestoreTarget } from './RestoreGrantDialog'

/** A profile chosen in Group Policies: preselects the role in the grant form; never grants anything by itself. */
export interface GrantIntent { roleId: string; roleName: string; orgTypes: string[]; nonce: number }

interface Props {
  data: any
  onChanged: () => void
  grantIntent?: GrantIntent | null
}

type PersonFilter = 'all' | 'granted' | 'temporary'
type AccessKind = 'granted' | 'automatic' | 'legacy'
interface Counts { all: number; granted: number; temporary: number; inactive: number; none: number }
interface Directory { people: any[]; total: number; counts: Counts; organizations: any[]; capabilities?: { userManagement?: boolean; rootAccess?: RootAccessCapability } }
const ALL = ''
const CATEGORY_OPTIONS = ['INTERNAL_EMPLOYEE', 'MANUFACTURER_USER', 'DISTRIBUTOR_USER', 'SHOP_STAFF', 'CONSUMER', 'UNCLASSIFIED'] as const

const PAGE_SIZE = 25
const ALL_ORGS = '__all'
const AUTOMATIC_SOURCES = new Set(['backfill', 'derived'])
const EMPTY_FORM = { userId: '', organizationId: '', module: 'all', roleId: '', scopeId: '', until: '', note: '' }
const NOTE_MAX = 500

/** Where automatic access comes from (sa_role_assignments.source). */
const AUTOMATIC_SOURCE: Record<string, string> = {
  derived: 'Managed by HR / User Management',
  backfill: 'Set up from the legacy role during migration',
}

/** Canonical active/validity (mirrors the server evaluator): a role assignment
 *  grants access only while status is 'active' and `now` lies within its
 *  [effective_from, effective_until) window. Revoked, expired and future-start
 *  rows are therefore not current access. */
const isExpired = (a: any, now: Date = new Date()) =>
  a.status === 'expired' || (a.status === 'active' && !!a.effective_until && new Date(a.effective_until).getTime() <= now.getTime())
const isFutureStart = (a: any, now: Date = new Date()) =>
  !!a.effective_from && new Date(a.effective_from).getTime() > now.getTime()
const isCurrent = (a: any, now: Date = new Date()) =>
  a.status === 'active' && !isExpired(a, now) && !isFutureStart(a, now)
/** Temporary = currently active but with a planned end. */
const isTemporary = (a: any) => isCurrent(a) && !!a.effective_until
/** Current (in-window active) assignments across every membership. */
const activeAssignments = (p: any) => (p.membership || []).flatMap((m: any) => (m.assignments || []).filter((a: any) => isCurrent(a)))
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
  // The recipient-eligibility rule the database enforces (overview payload); the stricter organization-type rule when absent.
  const eligibilityModel: EligibilityModel = data.eligibilityModel === 'legacy' ? 'legacy' : 'org_type'
  const asRecipientPolicy = (r: any) => ({ ...r, roleKey: r.role_key, accountTypes: r.applicable_account_types, orgTypes: r.applicable_org_types, permissionKeys: rolePermissionKeys(r) })
  // Automatic access an administrator revoked; restoring hands it back to the lifecycle.
  const restorable = useMemo(() => new Set<string>(data.restorableAssignmentIds || []), [data.restorableAssignmentIds])
  const orgName = useMemo(() => new Map((data.organizations || []).map((o: any) => [o.id, o.org_name])), [data.organizations])
  // Disambiguated scope names (several scopes share a display name), shared with Roles & Policies.
  const scopeNames = useMemo(() => scopeLabels(data.scopeDefinitions || [], orgName as Map<string, string>), [data.scopeDefinitions, orgName])
  const roleModules = useMemo(() => new Map<string, RoleModules>(allRoles.map((r: any) => [r.id, classifyRole(r)])), [allRoles])
  const coverageRoles = useMemo(() => new Map<string, CoverageRole>(allRoles.map((r: any) => [r.id, { id: r.id, status: r.status, source: r.source, permissionKeys: rolePermissionKeys(r) }])), [allRoles])
  const orgParents = useMemo(() => new Map<string, string | null>((data.organizations || []).map((o: any) => [o.id, o.parent_org_id ?? null])), [data.organizations])
  const moduleRequirements = useMemo(() => grantableModulePermissions(
    allRoles.filter((r: any) => r.source !== 'legacy' && r.status === 'active').map((r: any) => ({ permissionKeys: rolePermissionKeys(r) })), data.permissions,
  ), [allRoles, data.permissions])
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
  // Standard (Group Policy) or Root Access. Root is offered only when the migration is applied and the viewer is a Root Administrator.
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('standard')
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // One-click restore of a revoked administrator grant (Access history → Restore → Confirm Restore).
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null)
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
  const rootCapability = dir?.capabilities?.rootAccess
  const rootMode = accessLevel === 'root' && !!rootCapability?.available && rootCapability.viewerIsRoot

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

  // ── Grant flow: Person → Membership → Module filter → Role → Scope → (optional note)
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
    // The chosen person is a snapshot: fresher directory / search rows (after a grant or revoke) replace it.
    if (formPerson) map.set(formPerson.id, formPerson)
    for (const p of [...(fallback ? data.people || [] : []), ...grantResults, ...people]) map.set(p.id, p)
    return map
  }, [grantResults, people, formPerson, fallback, data.people])
  const grantCandidates = Array.from(known.values()).filter(p => p.id !== data.viewerId && (p.membership || []).some(canGrantOn))

  // Memberships the pinned policy is not eligible for (by the membership organization's type) are shown but not selectable (the database checks too).
  const pinnedRole = pinned ? grantableRoles.find(r => r.id === pinned.roleId) : null
  const applies = (m: any) => !pinnedRole || recipientEligibility(asRecipientPolicy(pinnedRole), one(m.organization)?.org_type_code, eligibilityModel).ok
  const eligibleMemberships = (userId: string): any[] => ((known.get(userId)?.membership) || []).filter(canGrantOn)
  const memberships: any[] = form.userId ? eligibleMemberships(form.userId) : []
  // Profiles the person already holds in this membership are shown as "Already held" (not selectable):
  // granting again would duplicate access or take over automatic access.
  const heldKinds = new Map<string, AccessKind>()
  // Where an existing grant already reaches: an organization scope on the membership organization covers every warehouse beneath it.
  const heldScopes = new Map<string, { names: string[]; coversWarehouses: boolean }>()
  for (const a of memberships.filter(m => m.organization_id === form.organizationId)
    .flatMap((m: any) => (m.assignments || []).filter((x: any) => x.status === 'active' && !(x.effective_until && new Date(x.effective_until) <= new Date())))) {
    const id = one(a.role)?.id
    if (!id) continue
    heldKinds.set(id, accessKind(a))
    const defs = (a.scopes || []).map((x: any) => one(x.scope)).filter(Boolean)
    heldScopes.set(id, {
      names: defs.map((d: any) => scopeNames.get(d.id) || d.display_name).filter(Boolean),
      coversWarehouses: defs.some((d: any) => d.scope_type === 'organization' && d.scope_value === form.organizationId),
    })
  }
  const HELD_TEXT: Record<AccessKind, string> = { granted: 'Already held — granted by an administrator', automatic: 'Already held — automatic access (managed by HR / User Management)', legacy: 'Already held — compatibility access' }
  // An identical active grant is never added again (the database upserts and would replace its scopes), so the policy is listed as held with where it reaches.
  const heldDescription = (roleId: string, kind: AccessKind) => {
    const info = heldScopes.get(roleId)
    const where = info?.names.length ? ` · Scope: ${info.names.join(', ')}` : ''
    return `${HELD_TEXT[kind]}${where}${info?.coversWarehouses ? ' · Already covers every warehouse; a warehouse grant would not restrict it — revoke it first to narrow access' : ''}`
  }
  // Recipient eligibility (shared with Add User, Edit User and the server): judged on the chosen MEMBERSHIP organization's type,
  // never the administrator's. Policies listing other organization types are not offered; the server and database refuse them too.
  const grantOrgType = one(memberships.find(m => m.organization_id === form.organizationId)?.organization)?.org_type_code
  const { eligible: eligibleRoles, ineligible: ineligibleRoles } = form.organizationId
    ? partitionPoliciesForRecipient(grantableRoles.map(asRecipientPolicy), grantOrgType, eligibilityModel)
    : { eligible: grantableRoles, ineligible: [] as Array<{ policy: any; message: string }> }
  const visibleRoles = eligibleRoles.filter(r => roleInModule(r, form.module, roleModules.get(r.id)))
  // Existing access already covering this membership organization (current, published, whole-organization scope; by actual
  // permissions, never by name). Policies it fully contains and modules it fully covers are not offered: granting them would
  // add nothing. Display only — the server re-checks every grant.
  const coverage = useMemo(() => {
    const none = { covered: new Set<string>(), modules: new Set<string>() }
    if (!form.userId || !form.organizationId) return none
    const assignments = (known.get(form.userId)?.membership || []).filter((m: any) => m.status === 'active' && m.organization_id === form.organizationId).flatMap((m: any) => m.assignments || [])
    const covered = coveredPermissions({ assignments, organizationId: form.organizationId, roles: coverageRoles, parents: orgParents })
    if (!covered.size) return none
    return { covered, modules: fullyCoveredModules(moduleRequirements, covered) }
  }, [form.userId, form.organizationId, known, coverageRoles, orgParents, moduleRequirements])
  const redundant = (r: any) => isRedundantPolicy(rolePermissionKeys(r), coverage.covered)
  // Module Full Access policies first, then narrower policies by name. A held policy that its own whole-organization grant
  // already covers is hidden with the rest; one held on a narrower scope stays listed (not selectable) with where it reaches.
  const roleOptions = sortGroupPolicies(visibleRoles.filter(r => !heldKinds.has(r.id) && !redundant(r)), r => r.role_key, r => r.name)
  const heldRoles = sortGroupPolicies(visibleRoles.filter(r => heldKinds.has(r.id) && !redundant(r)), r => r.role_key, r => r.name)
  const hiddenCovered = visibleRoles.filter(redundant).length
  // Scope choices come from the shared eligibility on the server (HQ: the HQ and its own warehouses only, limited to organizations where
  // this administrator may grant). They are reloaded whenever the membership organization changes; a stale list is never reused.
  const [choiceState, setChoiceState] = useState<{ org: string; status: 'loading' | 'ready' | 'failed'; choices: any[] }>({ org: '', status: 'ready', choices: [] })
  const [scopeRetry, setScopeRetry] = useState(0)
  useEffect(() => {
    const org = form.organizationId
    if (!org) { setChoiceState({ org: '', status: 'ready', choices: [] }); return }
    let cancelled = false
    setChoiceState({ org, status: 'loading', choices: [] })
    callApi(`/api/security-access/scope-choices?${new URLSearchParams({ organizationId: org })}`).then(res => {
      if (cancelled) return
      setChoiceState(res.ok && Array.isArray(res.data?.choices) ? { org, status: 'ready', choices: res.data.choices } : { org, status: 'failed', choices: [] })
    })
    return () => { cancelled = true }
  }, [form.organizationId, reloadKey, scopeRetry])
  const selectedRole = grantableRoles.find(r => r.id === form.roleId)
  const warehouseSupport = selectedRole ? warehouseSupportFor(rolePermissionKeys(selectedRole)) : null
  const choicesReady = !!form.organizationId && choiceState.org === form.organizationId && choiceState.status === 'ready'
  const allChoices = choicesReady ? choiceState.choices : []
  const scopeOptions = allChoices.filter(s => choiceAllowedForPolicy({ kind: s.kind }, warehouseSupport))
  const hiddenWarehouseChoices = allChoices.length - scopeOptions.length
  // Never submit a selection that is no longer offered (stale after a filter change).
  const roleValid = roleOptions.some(r => r.id === form.roleId)
  const scopeValid = scopeOptions.some(s => s.id === form.scopeId)
  const membershipValid = memberships.some(m => m.organization_id === form.organizationId && applies(m))
  // Exactly one valid scope is selected for you; a selection that is no longer offered (policy or organization changed) is cleared.
  const scopeKey = scopeOptions.map(s => s.id).join('|')
  useEffect(() => {
    if (!choicesReady) return
    const ids = scopeKey ? scopeKey.split('|') : []
    setForm(f => {
      if (ids.length === 1) return f.scopeId === ids[0] ? f : { ...f, scopeId: ids[0] }
      return f.scopeId && !ids.includes(f.scopeId) ? { ...f, scopeId: '' } : f
    })
  }, [choicesReady, scopeKey, form.roleId, form.organizationId])

  // Preflight: the server runs the SAME checks as the submission (self, ESS, duplicate, scope + authority, sensitive policy)
  // for exactly this person, membership, policy and scope. Any change of those makes a new key: the old answer is dropped
  // and a late response for an earlier key is ignored. The submission re-checks everything regardless.
  const complete = !!form.userId && membershipValid && roleValid && scopeValid
  const checkKey = complete ? [form.userId, form.organizationId, form.roleId, form.scopeId].join('|') : ''
  const [check, setCheck] = useState<{ key: string; status: 'checking' | 'allowed' | 'denied' | 'failed'; reason?: string }>({ key: '', status: 'checking' })
  const [checkRetry, setCheckRetry] = useState(0)
  useEffect(() => {
    if (!checkKey) return
    let cancelled = false
    setCheck({ key: checkKey, status: 'checking' })
    const [userId, organizationId, roleId, scopeId] = checkKey.split('|')
    callApi('/api/security-access/assignments', { body: { action: 'preflight', userId, organizationId, roleId, scopeIds: [scopeId] }, readOnly: true }).then(res => {
      if (cancelled) return
      // Losing the grant authority itself is a confirmed answer, not a failed check.
      if (!res.ok && res.code === 'sa_forbidden') setCheck({ key: checkKey, status: 'denied', reason: 'You no longer hold the authority to assign Group Policies.' })
      else if (!res.ok) setCheck({ key: checkKey, status: 'failed', reason: res.error })
      else if (res.data?.allowed) setCheck({ key: checkKey, status: 'allowed' })
      else setCheck({ key: checkKey, status: 'denied', reason: res.data?.reason || 'This grant is not allowed.' })
    })
    return () => { cancelled = true }
  }, [checkKey, checkRetry])
  const checkState = checkKey && check.key === checkKey ? check.status : 'checking'
  const [noteOpen, setNoteOpen] = useState(false)

  const pickPerson = (userId: string) => {
    const person = userId ? known.get(userId) ?? null : null
    setFormPerson(person)
    const eligible = userId ? eligibleMemberships(userId).filter(applies) : []
    // Exactly one eligible membership is selected for you; never a default HQ.
    setForm(f => ({ ...EMPTY_FORM, roleId: pinned && f.roleId === pinned.roleId ? f.roleId : '', userId, organizationId: eligible.length === 1 ? eligible[0].organization_id : '' }))
    setNoteOpen(false)
  }
  const pickModule = (module: string) => setForm(f => ({
    ...f, module, roleId: grantableRoles.some(r => r.id === f.roleId && roleInModule(r, module, roleModules.get(r.id))) ? f.roleId : '',
  }))

  const toggle = (id: string) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const startGrant = (userId = '') => {
    if (userId) setFormPerson(known.get(userId) ?? null)
    pickPerson(userId)
    setAccessLevel('standard')
    setMessage(null)
    setFormOpen(true)
    setScrollRequest(n => n + 1)
  }
  const closeForm = () => { setFormOpen(false); setPinned(null); setAccessLevel('standard') }

  // Profile-first entry: open the same grant form with the chosen profile selected (no person yet).
  useEffect(() => {
    if (!grantIntent) return
    setPinned({ roleId: grantIntent.roleId, roleName: grantIntent.roleName, orgTypes: (grantIntent.orgTypes || []).map(t => t.toUpperCase()) })
    setFormPerson(null); setForm({ ...EMPTY_FORM, roleId: grantIntent.roleId }); setAccessLevel('standard'); setMessage(null); setFormOpen(true)
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
    if (!complete || checkState !== 'allowed' || grantLock.current) return
    grantLock.current = true
    setBusy(true); setMessage(null)
    // The submission carries exactly what was preflighted; the server re-authorizes and re-checks it.
    const who = selectedPerson?.full_name || selectedPerson?.email || 'the person'
    const result = await callApi('/api/security-access/assignments', { body: {
      action: 'grant', userId: form.userId, roleId: form.roleId, organizationId: form.organizationId,
      scopeIds: [form.scopeId], effectiveUntil: toIso(form.until), note: form.note.trim() || null,
    } })
    setBusy(false); grantLock.current = false
    if (!result.ok) {
      const held = result.code === 'ROLE_ALREADY_HELD' || result.code === 'sa_role_already_held'
      setMessage({ tone: 'error', text: held ? 'Already assigned: this person already holds that policy. Nothing was changed.' : `${result.error || 'Unable to grant access.'}${/nothing was changed/i.test(result.error || '') ? '' : ' Nothing was changed.'}` })
      if (held) afterChange() // the directory was stale: reload so the existing assignment is visible
      else setCheckRetry(n => n + 1) // conditions changed since the preflight (authority, scope…): check again
      return
    }
    setMessage({ tone: 'ok', text: `Access granted to ${who} and recorded in the access change log${result.data?.noteRecorded ? ' with your note' : ''}.` })
    setForm(EMPTY_FORM); setNoteOpen(false)
    setFormOpen(false); setPinned(null)
    afterChange()
  }

  async function revoke(assignment: any) {
    const name = one(assignment.role)?.name || 'this role'
    const automatic = accessKind(assignment) !== 'granted'
    const reason = window.prompt(automatic
      ? `${name} is automatic access (${AUTOMATIC_SOURCE[assignment.source] ?? 'lifecycle'}). Revoking overrides the automatic rule for this person; it will not be re-added automatically (an administrator can restore it later). Reason for revoking?`
      : `Revoke ${name}? Only this entry is revoked; other granted, automatic or legacy access stays in place. Reason for revoking?`)
    if (!reason || reason.trim().length < 5) return
    const result = await callApi('/api/security-access/assignments', { body: { action: 'revoke', assignmentId: assignment.id, reason } })
    setMessage(result.ok ? { tone: 'ok', text: 'Access revoked. Any other access this person holds is unchanged.' } : { tone: 'error', text: result.error || 'Unable to revoke' })
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

  /** Opens the confirmation for a revoked grant the server reported as restorable; the server decides again on Confirm. */
  function openRestoreGrant(assignment: any, person: any, organizationName: string) {
    setMessage(null)
    setRestoreTarget({
      assignmentId: assignment.id,
      personName: person.full_name || person.email || 'This person',
      personEmail: person.email ?? null,
      policyName: one(assignment.role)?.name || 'Group Policy',
      organizationName,
      scopeText: assignmentScopeText(assignment, scopeNames),
      effectiveFrom: assignment.restore?.effectiveFrom ?? null,
      effectiveUntil: assignment.restore?.effectiveUntil ?? null,
    })
  }

  function restoredGrant() {
    const t = restoreTarget
    setRestoreTarget(null)
    setMessage({ tone: 'ok', text: `${t?.policyName ?? 'Access'} restored for ${t?.personName ?? 'the person'} as a new grant. The revoked entry stays in Access history.` })
    afterChange()
  }

  const selectedPerson = known.get(form.userId)
  const moduleSelect = [{ id: 'all', name: 'All modules' }, ...MODULE_FILTER_OPTIONS, CROSS_MODULE, OTHER_MODULE]
    .filter(m => m.id === 'all' || (!coverage.modules.has(m.id) && eligibleRoles.some(r => !redundant(r) && roleInModule(r, m.id, roleModules.get(r.id)))))
  const coveredModuleNames = MODULE_FILTER_OPTIONS.filter(m => coverage.modules.has(m.id)).map(m => m.name)
  // A module that stopped being offered (person or membership changed) falls back to All modules; one that is covered again
  // after a revoke or expiry reappears on the next directory refresh.
  const moduleOffered = moduleSelect.some(m => m.id === form.module)
  useEffect(() => { if (!moduleOffered) setForm(f => ({ ...f, module: 'all' })) }, [moduleOffered])
  // "View existing access": show this person's access summary in the directory below (search + expanded row).
  const viewExistingAccess = () => {
    const p = selectedPerson
    if (!p) return
    const q = String(p.email || p.full_name || '')
    clearFilters(); setQuery(q); setDebounced(q)
    setOpen(prev => new Set(prev).add(p.id))
  }
  const selectedBlocked = selectedPerson && memberships.length === 0
  const formBlock = selectedPerson ? grantBlock(selectedPerson, data.viewerId) : null

  return <div className="space-y-4">
    {message && <div role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{message.text}</div>}
    {fallback && <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      Only your own organization is listed: searching every authorized organization needs the database migration <code>20261005100000_sa_directory_visibility.sql</code>, which has not been applied here yet.</div>}
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><h2 className="text-base font-semibold text-gray-950">People &amp; Access</h2>
            <InfoPopover label="About People & Access"><p>Granted access is given by an administrator or an approved request. Automatic access follows HR and User Management; leavers lose business access automatically.</p><p>Search and filters cover everyone in your authorized scope.</p></InfoPopover></div>
          <p className="text-sm text-gray-500">Find people and manage their access.</p>
        </div>
        <button type="button" onClick={() => (formOpen ? closeForm() : startGrant())} aria-expanded={formOpen}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${formOpen ? 'border border-gray-200 text-gray-700 hover:bg-gray-50' : 'bg-orange-500 text-white hover:bg-orange-600'} ${FOCUS}`}>
          {formOpen ? <X className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}{formOpen ? 'Close' : 'Grant access'}</button>
      </div>
      {formOpen && <div className="border-b border-gray-100">
        <div className="flex items-center gap-2 px-4 pt-3">
          <h3 ref={headingRef} tabIndex={-1} className="scroll-mt-24 font-semibold text-gray-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">Grant a Group Policy</h3>
          <InfoPopover label="About granting a Group Policy"><p>Access is granted to one organization membership and always carries a scope. Module only narrows the policy list; it never grants module-wide access.</p><p>Granting a policy does not create an organization or department membership and does not enroll anyone in HR or employee self-service.</p><p>Nobody can grant access to themselves. Your authority in the organization, the scope and sensitive permissions are checked as you choose, and checked again together with separation of duties when you grant.</p><p>Every grant is recorded in the access change log with you, the person, organization, policy, scope and validity. A note is optional.</p></InfoPopover>
        </div>
      {pinned && <p role="note" className="border-b border-gray-100 bg-orange-50/40 px-4 py-2 text-xs text-gray-700">
        Assigning the policy <span className="font-medium">{pinned.roleName}</span>. Choose a person, an active membership and an explicit scope. {grantableRoles.some(r => r.id === pinned.roleId) ? 'The policy itself is not changed.' : 'This policy is no longer assignable (draft, retired or compatibility), so it cannot be granted here.'}</p>}
      {rootCapability?.available && <AccessLevelSelector value={rootMode ? 'root' : 'standard'} onChange={setAccessLevel} capability={rootCapability} />}
      {rootMode
        ? <RootGrantForm candidates={grantResults.length || grantQuery ? grantResults : people} viewerId={data.viewerId} onQueryChange={fallback ? undefined : setGrantQuery} searching={grantSearching}
            onCancel={closeForm} onGranted={text => { setMessage({ tone: 'ok', text }); closeForm(); afterChange() }} />
        : <>
      <div className="grid gap-4 p-4 md:grid-cols-3">
        <SearchableSelect label="Person" value={form.userId} onChange={pickPerson} onQueryChange={fallback ? undefined : setGrantQuery} loading={grantSearching}
          options={grantCandidates.map(p => ({ value: p.id, label: p.full_name || p.email, description: `${p.email} · ${(p.membership || []).filter(canGrantOn).map(nameOf).join(', ')}`, keywords: p.role_code }))}
          placeholder="Search a person you can grant to" emptyText="No grantable person matches." />
        <div>
          <SearchableSelect label="Membership organization" value={form.organizationId} onChange={v => setForm({ ...form, organizationId: v, scopeId: '' })}
            options={memberships.map(m => ({ value: m.organization_id, label: nameOf(m), disabled: !applies(m), description: `${orgTypeLabel(one(m.organization)?.org_type_code)}${m.is_primary ? ' · Primary membership' : ''}${applies(m) ? '' : ' · Policy does not apply to this organization type'}` }))}
            placeholder={!form.userId ? 'Choose a person first' : memberships.length ? 'Choose a membership' : 'No active membership'} disabled={!form.userId || memberships.length === 0} />
          {form.userId && memberships.length === 1 && <p className="mt-1 text-xs text-gray-500">Their only active membership — selected for you.</p>}
          {form.userId && selectedBlocked && <p role="note" className="mt-1 text-xs text-gray-600">{GRANT_BLOCK_TEXT[formBlock ?? 'no_membership']}</p>}
          {memberships.length > 1 && !form.organizationId && <p className="mt-1 text-xs text-gray-500">{memberships.length} active memberships — choose the one this access is for.</p>}
        </div>
        <div className="text-sm"><label className="block"><span className="text-gray-600">Module (filters the policy list)</span>
          <select value={form.module} onChange={e => pickModule(e.target.value)} aria-label="Module filter"
            className={`mt-1 w-full rounded-lg border bg-white px-3 py-2 ${FOCUS}`}>
            {moduleSelect.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select></label>
          {coveredModuleNames.length > 0 && <p role="note" className="mt-1 text-xs text-gray-600">{COVERED_MODULES_NOTE} <span className="text-gray-500">Not offered: {coveredModuleNames.join(', ')}.</span>{' '}
            <button type="button" onClick={viewExistingAccess} className={`rounded font-medium text-orange-700 underline hover:text-orange-800 ${FOCUS}`}>View existing access</button></p>}
        </div>
        <div><SearchableSelect label="Group Policy" value={roleValid ? form.roleId : ''} onChange={v => setForm({ ...form, roleId: v })}
          options={[...roleOptions, ...heldRoles].map(r => {
            const cls = roleModules.get(r.id)
            const tags = cls?.crossModule ? cls.modules.map(moduleGroupName).join(', ') : (cls?.related || []).map(moduleGroupName).join(', ')
            const held = heldKinds.get(r.id)
            return { value: r.id, label: r.name, disabled: !!held, description: held ? heldDescription(r.id, held) : [r.description, tags && `Also: ${tags}`].filter(Boolean).join(' · ') || undefined, group: cls ? moduleGroupName(cls.groupId) : undefined }
          })}
          placeholder={roleOptions.length ? 'Choose a policy' : hiddenCovered ? 'Existing access already covers these policies' : 'No policies in this module'} />
          {ineligibleRoles.length > 0 && <div className="mt-1 flex items-center gap-1 text-xs text-gray-500" data-testid="ineligible-policies">{unavailablePoliciesNote(ineligibleRoles.length, grantOrgType)}
            <InfoPopover label="Policies not available for this membership"><p>Eligibility follows the organization type of the membership you grant in, not your own organization. Visibility in Group Policies does not make a policy grantable here.</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">{ineligibleRoles.slice(0, 30).map(x => <li key={x.policy.id}><strong>{x.policy.name}</strong> — {x.message}</li>)}</ul>
              {ineligibleRoles.length > 30 && <p>…and {ineligibleRoles.length - 30} more.</p>}</InfoPopover></div>}
          {hiddenCovered > 0 && <p role="note" className="mt-1 text-xs text-gray-500">{hiddenCovered} {hiddenCovered === 1 ? 'policy' : 'policies'} not listed: this person’s current access in this organization already includes every permission {hiddenCovered === 1 ? 'it holds' : 'they hold'}.</p>}</div>
        <SearchableSelect label="Scope" value={scopeValid ? form.scopeId : ''} onChange={v => setForm({ ...form, scopeId: v })}
          options={scopeOptions.map(s => ({ value: s.id, label: s.label ?? s.display_name, description: s.coverage }))}
          placeholder={!form.organizationId ? 'Choose a membership first' : choiceState.status === 'loading' || choiceState.org !== form.organizationId ? 'Loading scopes…' : 'Choose a scope'} disabled={!form.organizationId || !choicesReady} />
        <div className="md:col-span-3 space-y-1" aria-live="polite">
          {!!form.organizationId && <div className="flex items-center gap-1 text-xs text-gray-500">About scopes
            <InfoPopover label="About scopes">{SCOPE_HELP.map(t => <p key={t}>{t}</p>)}
              {warehouseSupport?.level === 'partial' && <p>{warehousePartialNote(warehouseSupport)} {WAREHOUSE_PARTIAL_DETAIL}</p>}
              {hiddenWarehouseChoices > 0 && <p>{warehouseUnsupportedMessage}</p>}
              {scopeOptions.length === 1 && <p>Only one scope is valid for this policy and membership, so it is selected for you.</p>}</InfoPopover></div>}
          {choiceState.status === 'failed' && !!form.organizationId && <p role="alert" className="text-xs text-red-600">The scopes you may grant here could not be loaded. Nothing can be granted until they load.{' '}
            <button type="button" onClick={() => setScopeRetry(n => n + 1)} className={`rounded font-medium underline ${FOCUS}`}>Retry</button></p>}
          {choicesReady && allChoices.length === 0 && <p role="note" className="text-xs text-gray-600">No scope is available to you for this organization. You can grant only inside organizations where you hold the grant authority.</p>}
          {scopeValid && <p role="note" className="text-xs text-gray-700"><span className="font-medium">Scope:</span> {scopeOptions.find(s => s.id === form.scopeId)?.label ?? scopeOptions.find(s => s.id === form.scopeId)?.display_name}{scopeOptions.length === 1 ? ' (only option)' : ''} · <span className="font-medium">Covers:</span> {scopeOptions.find(s => s.id === form.scopeId)?.coverage}
            {warehouseSupport?.level === 'partial' && scopeOptions.find(s => s.id === form.scopeId)?.kind === 'warehouse' ? ` · ${warehousePartialNote(warehouseSupport)}` : ''}</p>}
        </div>
        <label className="text-sm"><span className="text-gray-600">Ends (optional — temporary access)</span>
          <input type="datetime-local" value={form.until} onChange={e => setForm({ ...form, until: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <div className="text-sm md:col-span-3">
          {!noteOpen
            ? <button type="button" onClick={() => setNoteOpen(true)} aria-expanded={false}
              className={`inline-flex items-center gap-1.5 rounded text-sm font-medium text-gray-600 hover:text-gray-900 ${FOCUS}`}>
              <StickyNote className="h-4 w-4" aria-hidden />Add note (optional)</button>
            : <div><div className="flex items-center justify-between gap-2">
                <label htmlFor="grant-note" className="text-gray-600">Note (optional)</label>
                <button type="button" onClick={() => { setNoteOpen(false); setForm(f => ({ ...f, note: '' })) }}
                  className={`rounded text-xs font-medium text-gray-500 hover:text-gray-800 ${FOCUS}`}>Remove note</button></div>
              <textarea id="grant-note" autoFocus rows={2} maxLength={NOTE_MAX} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })}
                aria-describedby="grant-note-help" placeholder="Context for the access change log, e.g. a ticket number" className="mt-1 w-full rounded-lg border px-3 py-2" />
              <p id="grant-note-help" className="text-xs text-gray-400">{form.note.length}/{NOTE_MAX} · Recorded with the grant in the access change log.</p></div>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 p-4">
        <button disabled={busy || !complete || checkState !== 'allowed'} aria-describedby="grant-status"
          onClick={grant} className={`inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 ${FOCUS}`}>
          <Plus className="h-4 w-4" aria-hidden />{busy ? 'Granting…' : 'Grant access'}</button>
        <GrantStatus id="grant-status" busy={busy} missing={!form.userId ? 'a person' : !membershipValid ? 'a membership organization' : !roleValid ? 'a Group Policy' : !scopeValid ? 'a scope' : null}
          scopesFailed={choiceState.status === 'failed' && !!form.organizationId} onRetryScopes={() => setScopeRetry(n => n + 1)}
          scopesLoading={!!form.organizationId && !choicesReady && choiceState.status !== 'failed'}
          check={checkState} reason={checkKey && check.key === checkKey ? check.reason : undefined} onRetryCheck={() => setCheckRetry(n => n + 1)} />
      </div>
      </>}
      </div>}
      <div className="space-y-3 border-b border-gray-100 p-4">
        {!fallback && <div role="group" aria-label="Directory filters" className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))_auto]">
          <div className="text-xs font-medium text-gray-600"><span className="hidden lg:block lg:invisible" aria-hidden>Search</span><SearchInput value={query} onChange={setQuery} placeholder="Search name or email" label="Search people" className="mt-1 lg:w-full" /></div>
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
          <button type="button" aria-expanded={moreOpen} aria-controls="people-more-filters" onClick={() => setMoreOpen(v => !v)}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 ${FOCUS}`}>
            <SlidersHorizontal className="h-4 w-4" aria-hidden />More filters{status !== 'all' || membershipFilter !== 'all' ? ' (active)' : ''}</button>
        </div>}
        {fallback && <SearchInput value={query} onChange={setQuery} placeholder="Search name or email" label="Search people" className="sm:w-72" />}
        {moreOpen && !fallback && <div id="people-more-filters" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-medium text-gray-600">Account status
            <select aria-label="Account status" value={status} onChange={e => setStatus(e.target.value)} className={selectClass}>
              <option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
          <label className="text-xs font-medium text-gray-600">Business membership
            <select aria-label="Business membership" value={membershipFilter} onChange={e => setMembershipFilter(e.target.value)} className={selectClass}>
              <option value="all">All</option><option value="has">Has active membership</option><option value="none">No active membership</option></select></label>
        </div>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2">
        <FilterChips label="Access" value={filter} onChange={setFilter} items={[
          { id: 'all', label: 'Everyone', count: counts.all },
          { id: 'granted', label: 'With granted policies', count: counts.granted },
          { id: 'temporary', label: 'Temporary access', count: counts.temporary },
        ]} />
        <InfoPopover label="About these counts"><p>Counts cover {scopeLabel} with the category, type, organization, status and membership filters applied; search and the access filter narrow the list, not the counts.</p></InfoPopover>
        {filtersActive && <button type="button" onClick={clearFilters} className={`rounded text-xs font-medium text-orange-600 hover:text-orange-700 ${FOCUS}`}>Clear filters</button>}
      </div>

      {loading && <p role="status" className="px-4 py-6 text-center text-sm text-gray-500">Loading people…</p>}
      {!loading && loadError && <div role="alert" className="px-4 py-6 text-center text-sm text-red-700">
        {loadError.text} <button type="button" onClick={() => setReloadKey(k => k + 1)} className={`rounded font-medium underline ${FOCUS}`}>Try again</button></div>}
      {!loading && !loadError && people.length === 0 && <div className="px-4 py-6 text-center text-sm text-gray-500">
        {debounced ? `No people match “${debounced}” in ${scopeLabel}.` : filtersActive ? `No people match these filters in ${scopeLabel}.` : `No people in ${scopeLabel} for this view.`}
        {filtersActive && <> <button type="button" onClick={clearFilters} className={`rounded font-medium text-orange-600 underline ${FOCUS}`}>Clear filters</button></>}</div>}
      <div aria-hidden className={`hidden border-b border-gray-100 bg-gray-50/60 px-4 py-2 text-xs font-medium text-gray-500 md:grid ${PEOPLE_GRID}`}>
        <span>Person</span><span>Organization</span><span>User category</span><span>Access summary</span><span className="md:text-right">Actions</span>
      </div>
      <ul className={`divide-y divide-gray-100 ${LIST_TEXT}`}>
        {!loading && people.map(p => {
          const active = activeAssignments(p)
          const count = (k: AccessKind) => active.filter((a: any) => accessKind(a) === k).length
          const temporary = active.filter(isTemporary).length
          const memberships: any[] = p.membership || []
          const primary = memberships.find((m: any) => m.is_primary) || memberships[0]
          const homeOrg = one(p.organization)
          const orgTypeCode = one(primary?.organization)?.org_type_code ?? homeOrg?.org_type_code
          const isOpen = open.has(p.id)
          const block = grantBlock(p, data.viewerId)
          const who = p.full_name || p.email
          const legacy = count('legacy')
          return <li key={p.id}>
            <div className={`grid grid-cols-1 gap-x-4 gap-y-2 px-4 py-3 md:items-center ${PEOPLE_GRID}`}>
              <div className="min-w-0">
                <ToggleButton open={isOpen} onClick={() => toggle(p.id)} label={`${who}, ${active.length} active role${active.length === 1 ? '' : 's'}`}>
                  <UserRound className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
                  <span className="min-w-0">
                    <span className="block break-words font-medium text-gray-900">{who}{holdsRootAccess(p) && <> <RootBadge /></>}</span>
                    <span className="block break-all text-xs text-gray-500">{p.email}</span>
                  </span>
                </ToggleButton>
              </div>
              <div className="min-w-0 pl-6 md:pl-0">
                <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400 md:sr-only">Organization</span>
                <div className="break-words text-sm text-gray-800" title={memberships.length > 1 ? memberships.map(nameOf).join(', ') : undefined}>{primary ? nameOf(primary) : homeOrg?.org_name ? String(homeOrg.org_name) : 'No business membership'}
                  {memberships.length > 1 && <span className="text-xs text-gray-400"> +{memberships.length - 1} more</span>}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                  {orgTypeCode && <span>{orgTypeLabel(orgTypeCode)}</span>}
                  {isPartnerOrgType(orgTypeCode) && <span className="rounded-full bg-indigo-50 px-1.5 text-[11px] font-medium text-indigo-700">Partner</span>}
                </div>
              </div>
              <div className="min-w-0 pl-6 md:pl-0">
                <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400 md:sr-only">User category</span>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-gray-700" title="User category (identity classification)">{categoryLabel(p.principal_type)}</span>
                  {!p.is_active && <span className="rounded-full bg-red-50 px-2 py-0.5 font-medium text-red-700">Inactive</span>}
                </div>
              </div>
              <div className="min-w-0 space-y-0.5 pl-6 text-xs md:pl-0">
                <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400 md:sr-only">Access summary</span>
                <div className="flex flex-wrap items-center gap-x-1.5">
                  <span className={count('granted') ? 'font-medium text-blue-700' : 'text-gray-400'}>{count('granted')} granted</span>
                  <span aria-hidden className="text-gray-300">·</span>
                  <span className="text-gray-600">{count('automatic')} automatic</span>
                </div>
                {(legacy > 0 || temporary > 0) && <div className="flex flex-wrap items-center gap-x-1.5">
                  {legacy > 0 && <span className="text-gray-500">{legacy} legacy</span>}
                  {legacy > 0 && temporary > 0 && <span aria-hidden className="text-gray-300">·</span>}
                  {temporary > 0 && <span className="inline-flex items-center gap-1 text-amber-700" title="Temporary entries may also be counted as granted, automatic or legacy"><Clock className="h-3 w-3" aria-hidden />{temporary} temporary</span>}
                </div>}
              </div>
              <div className="pl-6 md:pl-0 md:text-right">
                <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400 md:sr-only">Actions</span>
                <div>{!block
                  ? <button type="button" onClick={() => startGrant(p.id)} className={`inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 ${FOCUS}`}>
                    <Plus className="h-3.5 w-3.5" aria-hidden />Grant policy<span className="sr-only"> to {who}</span></button>
                  : <GrantUnavailable person={p} block={block} partner={isPartnerOrgType(orgTypeCode) || ['MANUFACTURER_USER', 'DISTRIBUTOR_USER', 'SHOP_STAFF'].includes(p.principal_type)} userManagementLink={Boolean(dir?.capabilities?.userManagement)} />}</div>
              </div>
            </div>
            {isOpen && <PersonDetail person={p} orgName={orgName} scopeNames={scopeNames} roleModules={roleModules} canRevoke={p.id !== data.viewerId} onRevoke={revoke} restorable={restorable} onRestore={restore}
              onRestoreGrant={(a, orgLabel) => openRestoreGrant(a, p, orgLabel)}
              rootCard={<RootAccessCard person={p} viewerIsRoot={!!rootCapability?.viewerIsRoot} isViewer={p.id === data.viewerId} onChanged={m => { setMessage(m); if (m.tone === 'ok') afterChange() }} />} />}
          </li>
        })}
      </ul>
      {!loading && !loadError && dir && people.length < dir.total && <div className="border-t border-gray-100 px-4 py-2 text-center">
        <button type="button" onClick={loadMore} disabled={loadingMore} className={`rounded text-sm font-medium text-orange-600 hover:text-orange-700 disabled:opacity-50 ${FOCUS}`}>
          {loadingMore ? 'Loading…' : 'Show more'} <span className="text-gray-400">({people.length} of {dir.total})</span></button></div>}
    </section>
    {restoreTarget && <RestoreGrantDialog target={restoreTarget} onClose={() => setRestoreTarget(null)} onRestored={restoredGrant} />}
  </div>
}

/** Disambiguated scope names of one assignment, as Access history shows them. */
const assignmentScopeText = (a: any, scopeNames: Map<string, string>) =>
  (a.scopes || []).map((s: any) => { const sc = one(s.scope); return (sc?.id && scopeNames.get(sc.id)) || sc?.display_name }).filter(Boolean).join(', ') || '—'

const SECTIONS: Array<{ kind: AccessKind; title: string; help: string }> = [
  { kind: 'granted', title: 'Granted access', help: 'Given by a Security & Access administrator or an approved request.' },
  { kind: 'automatic', title: 'Automatic access', help: 'Follows HR / User Management facts; added and removed by the lifecycle.' },
  { kind: 'legacy', title: 'Legacy access', help: 'Compatibility roles mirroring the legacy role code.' },
]

/** Shared column template for the person list (desktop); on mobile each cell stacks under a visible label. */
const PEOPLE_GRID = 'md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(8rem,auto)]'
/** Column template for one access entry: Policy · Data scope · Source · Status / validity · Actions. */
const ENTRY_GRID = 'md:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.4fr)_minmax(0,1.5fr)_minmax(6rem,auto)]'
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

type EntryState = { label: string; tone: string; dateLabel: string | null }
function entryState(a: any): EntryState {
  if (a.status === 'revoked') return { label: 'Revoked', tone: 'bg-gray-100 text-gray-600', dateLabel: 'Ended' }
  if (isExpired(a)) return { label: 'Expired', tone: 'bg-gray-100 text-gray-600', dateLabel: 'Expired' }
  if (isFutureStart(a)) return { label: 'Scheduled', tone: 'bg-sky-50 text-sky-700', dateLabel: 'Starts' }
  if (a.status === 'active') return a.effective_until ? { label: 'Temporary', tone: 'bg-amber-50 text-amber-700', dateLabel: 'Until' } : { label: 'Active', tone: 'bg-emerald-50 text-emerald-700', dateLabel: null }
  return { label: cap(String(a.status || 'inactive')), tone: 'bg-gray-100 text-gray-600', dateLabel: a.effective_until ? 'Ended' : null }
}

function PersonDetail({ person: p, orgName, scopeNames, roleModules, canRevoke, onRevoke, restorable, onRestore, onRestoreGrant, rootCard }: {
  person: any; orgName: Map<any, any>; scopeNames: Map<string, string>; roleModules: Map<string, RoleModules>; canRevoke: boolean; onRevoke: (a: any) => void
  restorable: Set<string>; onRestore: (a: any) => void
  /** Restore a revoked administrator grant of this person (membership organization name for the confirmation). */
  onRestoreGrant?: (a: any, organizationName: string) => void
  /** Root Access status (renders nothing unless the person holds active Root Access). */
  rootCard?: React.ReactNode
}) {
  // Toggled ids; granted sections and their modules start open, the rest folded.
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const flip = (id: string) => setToggled(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  if (!(p.membership || []).length) {
    return <div className="space-y-3 bg-gray-50/60 px-4 py-3 pl-10 text-sm text-gray-600">
      {rootCard}
      <div><p>No active business membership</p>
      <p className="text-xs text-gray-400">Category: {categoryLabel(p.principal_type)}. Business access is shown here only when an active membership exists; this says nothing about other kinds of access.</p></div></div>
  }
  const legacyHost = (p.membership || []).find((m: any) => m.is_primary) || (p.membership || [])[0]
  return <div className="space-y-3 bg-gray-50/60 px-4 py-3 md:pl-10">
    {rootCard}
    {(p.membership || []).map((m: any) => {
      const list: any[] = m.assignments || []
      const org = one(m.organization)
      const name = String(org?.org_name || orgName.get(m.organization_id) || one(p.organization)?.org_name || 'Organization')
      return <section key={m.id} aria-label={`Membership: ${name}`} className="rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="break-words text-sm font-semibold text-gray-900">{name}</h3>
            {org?.org_type_code && <span className="rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600">{orgTypeLabel(org.org_type_code)}</span>}
            <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${m.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>{cap(String(m.status || ''))}</span>
            {m.is_primary && <span className="rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600">Primary</span>}
          </div>
          {m === legacyHost && <p className="mt-0.5 text-xs text-gray-500" title="Legacy role code (compatibility input only)">Legacy role: {p.role_code || '—'}</p>}
        </div>
        {list.length === 0 && <p className="px-3 py-2 text-sm text-gray-500">No role assignments.</p>}
        {SECTIONS.map(section => {
          const items = list.filter(a => accessKind(a) === section.kind)
          if (!items.length) return null
          const sectionId = `${m.id}/${section.kind}`
          const startsOpen = section.kind === 'granted'
          const sectionOpen = startsOpen !== toggled.has(sectionId)
          const groupOf = (a: any) => roleModules.get(one(a.role)?.id)?.groupId ?? OTHER_MODULE.id
          const renderGroups = (groups: Array<{ id: string; name: string; items: any[] }>) => <ul className="pb-1">{groups.map(g => {
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
              {gOpen && <AssignmentList list={g.items} kind={section.kind} scopeNames={scopeNames} roleModules={roleModules} canRevoke={canRevoke} onRevoke={onRevoke} restorable={restorable} onRestore={onRestore} />}
            </li>
          })}</ul>

          // Granted access defaults to current (in-window active) grants only;
          // scheduled (future-start) and revoked/expired entries stay discoverable
          // in their own folded lists, never mixed into the active list.
          if (section.kind === 'granted') {
            const current: any[] = []
            const scheduled: any[] = []
            const history: any[] = []
            for (const a of items) {
              if (isCurrent(a)) current.push(a)
              else if (a.status === 'active' && isFutureStart(a) && !isExpired(a)) scheduled.push(a)
              else history.push(a)
            }
            const groups = groupByModule(current, groupOf)
            const scheduledId = `${m.id}/scheduled`
            const historyId = `${m.id}/history`
            const scheduledOpen = toggled.has(scheduledId)
            const historyOpen = toggled.has(historyId)
            return <div key={section.kind} className="border-t border-gray-100 first:border-t-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <ToggleButton open={sectionOpen} onClick={() => flip(sectionId)} label={`${section.title}, ${current.length}`}>
                  <span className="text-sm font-semibold text-gray-800">{section.title}</span>
                </ToggleButton>
                <InfoPopover label={`About ${section.title.toLowerCase()}`}><p>{section.help}</p></InfoPopover>
                <span className="text-xs text-gray-500">{current.length} active · {plural(groups.length, 'module')}</span>
              </div>
              {sectionOpen && (current.length
                ? renderGroups(groups)
                : <p className="px-3 pb-2 pl-9 text-sm text-gray-500">No active granted policies. {history.length > 0 ? 'Revoked or expired grants are kept in Access history below.' : 'Nothing is granted here.'}</p>)}
              {scheduled.length > 0 && <div className="border-t border-gray-100">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <ToggleButton open={scheduledOpen} onClick={() => flip(scheduledId)} label={`Scheduled access, ${scheduled.length}`}>
                    <span className="text-sm font-medium text-gray-700">Scheduled access</span>
                  </ToggleButton>
                  <span className="text-xs text-gray-500">Starts later — grants nothing until then</span>
                </div>
                {scheduledOpen && <AssignmentList list={scheduled} kind={section.kind} scopeNames={scopeNames} roleModules={roleModules} canRevoke={canRevoke} onRevoke={onRevoke} restorable={restorable} onRestore={onRestore} />}
              </div>}
              {history.length > 0 && <div className="border-t border-gray-100">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <ToggleButton open={historyOpen} onClick={() => flip(historyId)} label={`Access history, ${history.length}`}>
                    <span className="text-sm font-medium text-gray-700">Access history</span>
                  </ToggleButton>
                  <span className="text-xs text-gray-500">Revoked or expired — no longer grants access</span>
                </div>
                {historyOpen && <AssignmentList list={history} kind={section.kind} scopeNames={scopeNames} roleModules={roleModules} canRevoke={canRevoke} onRevoke={onRevoke} restorable={restorable} onRestore={onRestore}
                  onRestoreGrant={canRevoke && canGrantOn(m) && onRestoreGrant ? (a: any) => onRestoreGrant(a, name) : undefined} />}
              </div>}
            </div>
          }

          const groups = groupByModule(items, groupOf)
          const current = items.filter((a: any) => isCurrent(a)).length
          const history = items.length - current
          return <div key={section.kind} className="border-t border-gray-100 first:border-t-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <ToggleButton open={sectionOpen} onClick={() => flip(sectionId)} label={`${section.title}, ${items.length}`}>
                <span className="text-sm font-semibold text-gray-800">{section.title}</span>
              </ToggleButton>
              <InfoPopover label={`About ${section.title.toLowerCase()}`}><p>{section.help}</p></InfoPopover>
              <span className="text-xs text-gray-500">{current} active{history > 0 ? ` · ${history} historical` : ''} · {plural(groups.length, 'module')}</span>
            </div>
            {sectionOpen && renderGroups(groups)}
          </div>
        })}
      </section>
    })}
  </div>
}

function AssignmentList({ list, kind, scopeNames, roleModules, canRevoke, onRevoke, restorable, onRestore, onRestoreGrant }: {
  list: any[]; kind: AccessKind; scopeNames: Map<string, string>; roleModules: Map<string, RoleModules>; canRevoke: boolean; onRevoke: (a: any) => void
  restorable: Set<string>; onRestore: (a: any) => void
  /** Present only in Access history where this administrator may grant on the membership; absent = no Restore offered. */
  onRestoreGrant?: (a: any) => void
}) {
  const label = 'text-[11px] font-medium uppercase tracking-wide text-gray-400 md:sr-only'
  return <div>
    <div aria-hidden className={`hidden gap-x-3 border-b border-gray-100 py-1.5 pl-14 pr-3 text-xs font-medium text-gray-500 md:grid ${ENTRY_GRID}`}>
      <span>Policy</span><span>Data scope</span><span>Source</span><span>Status / validity</span><span className="text-right">Actions</span>
    </div>
    <ul className="divide-y divide-gray-50">{list.map((a: any) => {
      const role = one(a.role)
      const cls = roleModules.get(role?.id)
      const scopeText = assignmentScopeText(a, scopeNames)
      const state = entryState(a)
      const current = isCurrent(a)
      const tags = cls?.crossModule ? cls.modules : cls?.related || []
      const roleName = role?.name || 'Role'
      const source = a.source === 'access_request' ? <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700">Approved request</span>
        : kind !== 'granted' ? <span className="text-xs text-gray-500">{AUTOMATIC_SOURCE[a.source] ?? (kind === 'legacy' ? 'Legacy compatibility role' : '—')}</span>
        : <span className="text-xs text-gray-600">Administrator grant</span>
      return <li key={a.id} className={`grid grid-cols-1 gap-x-3 gap-y-1.5 py-2 pl-14 pr-3 text-sm md:items-start ${ENTRY_GRID} ${current ? '' : 'bg-gray-50/50'}`}>
        <div className="min-w-0">
          <span className={label}>Policy</span>
          <div className={`break-words ${current ? 'font-medium text-gray-900' : 'text-gray-500'}`}>{roleName}</div>
          {tags.length > 0 && <div className="text-[11px] text-gray-400" title="Other modules this role's permissions touch">also {tags.map(moduleGroupName).join(', ')}</div>}
        </div>
        <div className="min-w-0"><span className={label}>Data scope</span><div className="break-words text-xs text-gray-700">{scopeText}</div></div>
        <div className="min-w-0"><span className={label}>Source</span><div>{source}</div>
          {restorable.has(a.id) && <div className="text-[11px] text-gray-400">Automatic access revoked by an administrator</div>}</div>
        <div className="min-w-0"><span className={label}>Status / validity</span>
          <div><span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${state.tone}`}>
            {state.label === 'Temporary' && <Clock className="h-3 w-3" aria-hidden />}{state.label}</span></div>
          {state.dateLabel && (state.dateLabel === 'Starts' ? a.effective_from : a.effective_until) && <div className="mt-0.5 text-xs text-gray-500">{state.dateLabel} {formatDate(state.dateLabel === 'Starts' ? a.effective_from : a.effective_until)}</div>}</div>
        <div className="flex flex-wrap items-center gap-1 md:justify-end"><span className={label}>Actions</span>
          {(a.status === 'active' && !isExpired(a)) && canRevoke && <button type="button" onClick={() => onRevoke(a)}
            title={kind === 'granted' ? 'Revokes only this entry; other access is not affected' : 'Overrides the automatic rule for this person'}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-red-50 hover:text-red-700 ${FOCUS}`}>
            <ShieldOff className="h-3 w-3" aria-hidden />Revoke<span className="sr-only"> {roleName}</span></button>}
          {restorable.has(a.id) && canRevoke && <button type="button" onClick={() => onRestore(a)}
            title="Returns this role to automatic management"
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-emerald-50 hover:text-emerald-700 ${FOCUS}`}>
            <RotateCcw className="h-3 w-3" aria-hidden />Restore<span className="sr-only"> {roleName}</span></button>}
          {!restorable.has(a.id) && a.restore && onRestoreGrant && (a.restore.eligible
            ? <button type="button" onClick={() => onRestoreGrant(a)}
              title="Grants this policy again with the same organization, scope and validity"
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-600 hover:bg-emerald-50 hover:text-emerald-700 ${FOCUS}`}>
              <RotateCcw className="h-3 w-3" aria-hidden />Restore<span className="sr-only"> {roleName}</span></button>
            : <span className="inline-flex items-center gap-1 text-xs text-gray-400">Restore unavailable
              <InfoPopover label={`Why ${roleName} cannot be restored`} align="right"><p>{a.restore.message}</p></InfoPopover></span>)}
        </div>
      </li>
    })}</ul>
  </div>
}

/**
 * Neutral explanation of why Grant is unavailable: a normal state (not an error). The reason sits behind an ⓘ
 * popover (hover, keyboard focus and tap) and is never attached to a disabled control.
 */
function GrantUnavailable({ person, block, partner, userManagementLink }: { person: any; block: GrantBlock; partner: boolean; userManagementLink: boolean }) {
  const name = person.full_name || person.email
  return <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">Unavailable
    <InfoPopover label={`Why Grant policy is unavailable for ${name}`} align="right">
      <p>{GRANT_BLOCK_TEXT[block]}{block === 'no_membership' && partner && userManagementLink && <> Partner accounts are onboarded in <a href="/users" className="font-medium text-orange-600 underline">User Management</a>.</>}</p>
    </InfoPopover></span>
}

/**
 * One concise line beside Grant access saying why it is unavailable, or that it is ready. Only a confirmed refusal of
 * this exact grant reads as a denial; missing choices and pending checks are neutral, and a failed check offers Retry.
 */
function GrantStatus({ id, busy, missing, scopesLoading, scopesFailed, onRetryScopes, check, reason, onRetryCheck }: {
  id: string; busy: boolean; missing: string | null; scopesLoading: boolean; scopesFailed: boolean; onRetryScopes: () => void
  check: 'checking' | 'allowed' | 'denied' | 'failed'; reason?: string; onRetryCheck: () => void
}) {
  const retry = (onClick: () => void) => <button type="button" onClick={onClick} className={`rounded font-medium underline ${FOCUS}`}>Retry</button>
  let body: React.ReactNode
  if (busy) body = <span className="text-gray-500">Granting and checking again…</span>
  else if (scopesFailed) body = <span className="text-red-700">Scopes could not be loaded. {retry(onRetryScopes)}</span>
  else if (scopesLoading && missing === 'a scope') body = <span className="text-gray-500">Loading the scopes you may grant…</span>
  else if (missing) body = <span className="text-gray-500">Choose {missing} to continue.</span>
  else if (check === 'checking') body = <span className="text-gray-500">Checking this grant…</span>
  else if (check === 'failed') body = <span className="text-red-700">{reason || 'This grant could not be checked.'} {retry(onRetryCheck)}</span>
  else if (check === 'denied') body = <span className="text-amber-800">{reason}</span>
  else body = <span className="text-emerald-700">Ready to grant. Checked again when you grant.</span>
  return <span id={id} role="status" aria-live="polite" className="min-w-0 flex-1 basis-60 text-xs">{body}</span>
}
