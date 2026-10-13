'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, KeyRound, Lock, Plus, Send, X, XCircle } from 'lucide-react'
import SearchableSelect from './SearchableSelect'
import { callApi, formatDate, toIso } from './client-api'
import { Collapsible, DisclosurePanel, EmptyState, FilterChips, FOCUS, InfoPopover, LIST_TEXT, ModuleFilterSelect, SearchInput, ShowMore, ToggleButton, useLimit } from './ui'
import type { GovernanceSection } from './advanced-nav'
import { OTHER_MODULE, classifyPermission, classifyRole, moduleGroupName, permissionModuleLabel } from '@/lib/security-access/modules'
import { OUTCOMES, RULE_KINDS, enforcementOf, groupSodRules, humanize, outcomeOf, ruleKindLabel, type SodMitigation, type SodRule, type SodViolation } from '@/lib/security-access/sod'
import { permissionLabel } from '@/lib/security-access/labels'
import { SCOPE_HELP, choiceAllowedForPolicy, warehousePartialNote, warehouseSupportFor, warehouseUnsupportedMessage } from '@/lib/security-access/scope-eligibility'
import { rolePermissionKeys } from '@/lib/security-access/modules'


const STATUS_TONE: Record<string, string> = {
  requested: 'bg-blue-50 text-blue-700', approved: 'bg-emerald-50 text-emerald-700', denied: 'bg-red-50 text-red-700',
  cancelled: 'bg-gray-100 text-gray-600', expired: 'bg-gray-100 text-gray-600', active: 'bg-emerald-50 text-emerald-700',
  revoked: 'bg-gray-100 text-gray-600', completed: 'bg-emerald-50 text-emerald-700', pending: 'bg-blue-50 text-blue-700',
  retain: 'bg-emerald-50 text-emerald-700', revoke: 'bg-red-50 text-red-700', modify: 'bg-amber-50 text-amber-800',
  enforce: 'bg-red-50 text-red-700', monitor: 'bg-amber-50 text-amber-800',
}
const Pill = ({ value }: { value: string }) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[value] || 'bg-gray-100 text-gray-600'}`}>{value.replace(/_/g, ' ')}</span>

interface Props {
  /** Which Governance destination to show; chosen by the single Advanced navigator. */
  section: GovernanceSection
  data: any
  governance: any | null
}

/**
 * Governance: access requests (no self-approval; access granted only when
 * approved), scoped non-transitive delegations, access review campaigns (no
 * self-certification), segregation of duties, and emergency access status.
 */
export default function GovernancePanel({ section, data, governance }: Props) {
  const people: any[] = data.people || []
  const nameOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of [...people, ...(data.actors || [])]) map.set(p.id, p.full_name || p.email)
    return (id: string | null | undefined) => (id ? map.get(id) || 'Unknown user' : '—')
  }, [people, data.actors])
  const orgName = useMemo(() => new Map((data.organizations || []).map((o: any) => [o.id, o.org_name])), [data.organizations])
  const roleName = useMemo(() => new Map((data.roles || []).map((r: any) => [r.id, r.name])), [data.roles])

  return <div className="space-y-4">
    {section === 'requests' && <AccessRequests data={data} nameOf={nameOf} orgName={orgName} roleName={roleName} />}
    {section === 'delegations' && <Delegations data={data} nameOf={nameOf} orgName={orgName} />}
    {section === 'reviews' && <Reviews data={data} nameOf={nameOf} orgName={orgName} roleName={roleName} />}
    {section === 'sod' && <SegregationOfDuties nameOf={nameOf} />}
    {section === 'emergency' && <EmergencyAccess governance={governance} />}
  </div>
}

function useList(url: string) {
  const [state, setState] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    const result = await callApi(url)
    if (result.ok) { setState(result.data); setError(null) } else setError(result.error || 'Unable to load')
  }, [url])
  useEffect(() => { reload() }, [reload])
  return { state, error, reload }
}

function Feedback({ message }: { message: { tone: 'ok' | 'error'; text: string } | null }) {
  if (!message) return null
  return <div className={`rounded-lg p-3 text-sm ${message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{message.text}</div>
}

function AccessRequests({ data, nameOf, orgName, roleName }: any) {
  const { state, error, reload } = useList('/api/security-access/access-requests')
  const [form, setForm] = useState({ targetUserId: '', roleId: '', organizationId: '', scopeId: '', until: '', reason: '' })
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [status, setStatus] = useState<'pending' | 'decided' | 'all'>('pending')
  const [moduleFilter, setModuleFilter] = useState('all')
  const roleById = useMemo(() => new Map<string, any>((data.roles || []).map((r: any) => [r.id, r])), [data.roles])
  // A request maps to modules through its business role; an unknown role stays under Other / Unmapped.
  const requestModules = (r: any): string[] => { const role = roleById.get(r.role_id); if (!role) return [OTHER_MODULE.id]; const c = classifyRole(role); return [c.groupId, ...c.modules] }
  const allRequests: any[] = state?.requests || []
  const requests = allRequests.filter((r: any) => (status === 'all' || (status === 'pending') === (r.status === 'requested'))
    && (moduleFilter === 'all' || requestModules(r).includes(moduleFilter)))
  // Previous (decided) requests exist under the current module filter, so "All" would show something.
  const hasPrevious = allRequests.some((r: any) => r.status !== 'requested' && (moduleFilter === 'all' || requestModules(r).includes(moduleFilter)))
  const roles = (data.roles || []).filter((r: any) => r.source !== 'legacy' && r.status === 'active')
  const target = (data.people || []).find((p: any) => p.id === (form.targetUserId || data.viewerId))
  const memberships = (target?.membership || []).filter((m: any) => m.status === 'active')
  // Canonical scope choices from the server (shared eligibility; an HQ offers itself and its own warehouses only). A request names a
  // scope but grants nothing; the approver decides, and POST /access-requests re-validates the same rules.
  const [choiceState, setChoiceState] = useState<{ org: string; status: 'loading' | 'ready' | 'failed'; choices: any[] }>({ org: '', status: 'ready', choices: [] })
  useEffect(() => {
    const org = form.organizationId
    if (!org) { setChoiceState({ org: '', status: 'ready', choices: [] }); return }
    let cancelled = false
    setChoiceState({ org, status: 'loading', choices: [] })
    callApi(`/api/security-access/scope-choices?${new URLSearchParams({ organizationId: org, purpose: 'request' })}`).then(res => {
      if (cancelled) return
      setChoiceState(res.ok && Array.isArray(res.data?.choices) ? { org, status: 'ready', choices: res.data.choices } : { org, status: 'failed', choices: [] })
    })
    return () => { cancelled = true }
  }, [form.organizationId])
  const pickedRole = roles.find((r: any) => r.id === form.roleId)
  const warehouseSupport = pickedRole ? warehouseSupportFor(rolePermissionKeys(pickedRole)) : null
  const choicesReady = !!form.organizationId && choiceState.org === form.organizationId && choiceState.status === 'ready'
  const allChoices = choicesReady ? choiceState.choices : []
  const offered = allChoices.filter((s: any) => choiceAllowedForPolicy({ kind: s.kind }, warehouseSupport))
  const scopeOptions = offered.map((s: any) => ({ value: s.id, label: s.label ?? s.display_name, description: s.coverage }))
  const scopeValid = offered.some((s: any) => s.id === form.scopeId)

  async function submit() {
    const result = await callApi('/api/security-access/access-requests', { body: {
      action: 'submit', targetUserId: form.targetUserId || undefined, roleId: form.roleId, organizationId: form.organizationId,
      scopeIds: form.scopeId ? [form.scopeId] : [], effectiveUntil: toIso(form.until), reason: form.reason,
    } })
    setMessage(result.ok ? { tone: 'ok', text: 'Request submitted. Nothing is granted until it is approved.' } : { tone: 'error', text: result.error || 'Unable to submit' })
    if (result.ok) { setForm({ targetUserId: '', roleId: '', organizationId: '', scopeId: '', until: '', reason: '' }); setFormOpen(false); reload() }
  }
  async function act(body: any, ok: string) {
    const result = await callApi('/api/security-access/access-requests', { body })
    setMessage(result.ok ? { tone: 'ok', text: ok } : { tone: 'error', text: result.error || 'Unable to complete' })
    if (result.ok) reload()
  }

  return <div className="space-y-4">
    <Feedback message={message} />
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm" aria-label="Access Requests">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="font-semibold text-gray-950">Access Requests</h3>
          <InfoPopover label="About access requests">
            <p>Request a Group Policy for yourself or a colleague. Nothing is granted until an approver decides.</p>
            <p>Temporary requests must end on the date you set. The requester and the person receiving access cannot approve the request.</p>
            <p>{state?.canApprove ? 'You are seeing all access requests.' : 'You are seeing your own access requests.'}</p>
          </InfoPopover>
        </div>
        <button type="button" onClick={() => setFormOpen(!formOpen)} aria-expanded={formOpen}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${formOpen ? 'border border-gray-200 text-gray-700 hover:bg-gray-50' : 'bg-orange-500 text-white hover:bg-orange-600'} ${FOCUS}`}>
          {formOpen ? <X className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}{formOpen ? 'Close' : 'New request'}
        </button>
      </div>
      {formOpen && <div className="border-t border-gray-100">
      <div className="grid gap-4 p-4 md:grid-cols-3">
        <SearchableSelect label="For" value={form.targetUserId} onChange={v => setForm({ ...form, targetUserId: v, organizationId: '', scopeId: '' })}
          options={(data.people || []).map((p: any) => ({ value: p.id, label: p.id === data.viewerId ? `${p.full_name || p.email} (me)` : p.full_name || p.email }))} placeholder="Myself" allowClear />
        <SearchableSelect label="Group Policy" value={form.roleId} onChange={v => setForm({ ...form, roleId: v })} options={roles.map((r: any) => ({ value: r.id, label: r.name, description: r.description || undefined, group: moduleGroupName(classifyRole(r).groupId) }))} />
        <SearchableSelect label="Membership organization" value={form.organizationId} onChange={v => setForm({ ...form, organizationId: v, scopeId: '' })}
          options={memberships.map((m: any) => ({ value: m.organization_id, label: String(orgName.get(m.organization_id) || 'Organization') }))} />
        <SearchableSelect label="Scope" value={scopeValid ? form.scopeId : ''} onChange={v => setForm({ ...form, scopeId: v })} options={scopeOptions} disabled={!form.organizationId || !choicesReady} />
        <div className="space-y-1 md:col-span-3" aria-live="polite">
          {choiceState.status === 'failed' && !!form.organizationId && <p role="alert" className="text-xs text-red-600">The scopes for this organization could not be loaded. Nothing can be requested until they load.</p>}
          {scopeValid && <p role="note" className="text-xs text-gray-700"><span className="font-medium">Coverage:</span> {offered.find((s: any) => s.id === form.scopeId)?.coverage}</p>}
          {allChoices.length > offered.length && <p role="note" className="text-xs text-gray-600">{warehouseUnsupportedMessage}</p>}
          {warehouseSupport?.level === 'partial' && offered.some((s: any) => s.kind === 'warehouse') && <p role="note" className="text-xs text-gray-600">{warehousePartialNote(warehouseSupport)}</p>}
          {!!form.organizationId && <div className="flex items-center gap-1 text-xs text-gray-500">About scopes<InfoPopover label="About scopes">{SCOPE_HELP.map(t => <p key={t}>{t}</p>)}</InfoPopover></div>}
        </div>
        <label className="text-sm"><span className="text-gray-600">Ends (temporary access)</span>
          <input type="datetime-local" value={form.until} onChange={e => setForm({ ...form, until: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <label className="text-sm"><span className="text-gray-600">Business justification</span>
          <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
      </div>
      <div className="border-t p-4"><button onClick={submit} disabled={!form.roleId || !form.organizationId || !scopeValid || form.reason.trim().length < 10}
        className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"><Send className="h-4 w-4" />Submit request</button></div>
      </div>}
      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-4 py-3">
        <FilterChips label="Request status" value={status} onChange={setStatus} items={[
          { id: 'pending', label: 'Pending', count: allRequests.filter((r: any) => r.status === 'requested').length },
          { id: 'decided', label: 'Decided', count: allRequests.filter((r: any) => r.status !== 'requested').length },
          { id: 'all', label: 'All', count: allRequests.length },
        ]} />
        <div className="ml-auto"><ModuleFilterSelect value={moduleFilter} onChange={setModuleFilter} available={allRequests.flatMap(requestModules)} /></div>
      </div>
      {error && <div role="alert" className="border-t border-gray-100 p-4 text-sm text-red-700">{error}</div>}
      <div className="divide-y border-t border-gray-100">{requests.map((r: any) => <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
        <div>
          <div className="font-medium">{roleName.get(r.role_id) || 'Role'} for {nameOf(r.target_user_id)}</div>
          <div className="text-xs text-gray-500">{orgName.get(r.organization_id) || 'Organization'} · requested by {nameOf(r.requester_id)} · {formatDate(r.created_at)}{r.effective_until ? ` · until ${formatDate(r.effective_until)}` : ''}</div>
          <div className="mt-1 text-xs text-gray-600">“{r.reason}”</div>
          {r.approver_id && <div className="text-xs text-gray-500">Decided by {nameOf(r.approver_id)} {r.decision_reason ? `— ${r.decision_reason}` : ''}</div>}
        </div>
        <div className="flex items-center gap-2"><Pill value={r.status} />
          {r.status === 'requested' && state?.canApprove && r.requester_id !== data.viewerId && r.target_user_id !== data.viewerId && <>
            <button onClick={() => act({ action: 'decide', requestId: r.id, approve: true }, 'Approved; access granted.')} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-xs text-white"><CheckCircle2 className="h-3 w-3" />Approve</button>
            <button onClick={() => { const reason = window.prompt('Reason for denial?') || ''; act({ action: 'decide', requestId: r.id, approve: false, reason }, 'Denied; nothing was granted.') }} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"><XCircle className="h-3 w-3" />Deny</button></>}
          {r.status === 'requested' && r.requester_id === data.viewerId && <button onClick={() => act({ action: 'cancel', requestId: r.id }, 'Request cancelled.')} className="rounded-md border px-2 py-1 text-xs">Cancel</button>}
        </div>
      </div>)}
        {state && !requests.length && <EmptyState>
          {status === 'pending' ? (moduleFilter !== 'all' ? 'No pending access requests in this module.' : 'No pending access requests.') : status === 'decided' ? (moduleFilter !== 'all' ? 'No decided access requests in this module.' : 'No decided access requests.') : moduleFilter !== 'all' ? 'No requests in this module.' : 'No access requests.'}
          {status === 'pending' && hasPrevious && <> <button type="button" onClick={() => setStatus('all')} className={`rounded font-medium text-orange-600 hover:text-orange-700 ${FOCUS}`}>Switch to All to view previous requests</button></>}
        </EmptyState>}</div>
    </section>
  </div>
}

function Delegations({ data, nameOf, orgName }: any) {
  const { state, error, reload } = useList('/api/security-access/delegations')
  const [form, setForm] = useState({ delegateId: '', organizationId: data.viewerOrganizationId || '', permission: '', until: '', reason: '' })
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [moduleFilter, setModuleFilter] = useState('all')
  const delegationModules = (d: any): string[] => { const ids = (d.permission_keys || []).map((k: string) => classifyPermission(k).groupId); return ids.length ? ids : [OTHER_MODULE.id] }
  const allDelegations: any[] = state?.delegations || []
  const delegations = allDelegations.filter(d => moduleFilter === 'all' || delegationModules(d).includes(moduleFilter))
  async function create() {
    const result = await callApi('/api/security-access/delegations', { body: {
      action: 'create', delegateId: form.delegateId, organizationId: form.organizationId, permissionKeys: [form.permission],
      effectiveUntil: toIso(form.until), reason: form.reason,
    } })
    setMessage(result.ok ? { tone: 'ok', text: 'Delegation created.' } : { tone: 'error', text: result.error || 'Unable to delegate' })
    if (result.ok) { setFormOpen(false); reload() }
  }
  async function revoke(id: string) {
    const reason = window.prompt('Reason for revoking this delegation?')
    if (!reason || reason.trim().length < 5) return
    const result = await callApi('/api/security-access/delegations', { body: { action: 'revoke', delegationId: id, reason } })
    setMessage(result.ok ? { tone: 'ok', text: 'Delegation revoked.' } : { tone: 'error', text: result.error || 'Unable to revoke' })
    if (result.ok) reload()
  }
  return <div className="space-y-4">
    <Feedback message={message} />
    <DisclosurePanel title="Delegate one of your permissions" open={formOpen} onToggle={() => setFormOpen(!formOpen)} actionLabel="New delegation"
      info={<p>Scoped and time-boxed. A delegate can never exceed what you currently hold, and cannot delegate onward.</p>}>
      <div className="grid gap-4 p-4 md:grid-cols-3">
        <SearchableSelect label="Delegate" value={form.delegateId} onChange={v => setForm({ ...form, delegateId: v })}
          options={(data.people || [])
            // Only active people with an active membership can receive a delegation.
            .filter((p: any) => p.id !== data.viewerId && p.is_active && (p.membership || []).some((m: any) => m.status === 'active'))
            .map((p: any) => ({ value: p.id, label: p.full_name || p.email, description: p.email }))} />
        <SearchableSelect label="Organization" value={form.organizationId} onChange={v => setForm({ ...form, organizationId: v })}
          options={(data.organizations || []).map((o: any) => ({ value: o.id, label: o.org_name }))} />
        <SearchableSelect label="Permission" value={form.permission} onChange={v => setForm({ ...form, permission: v })}
          options={(data.permissions || []).filter((p: any) => !p.permission_key.startsWith('security.')).map((p: any) => ({ value: p.permission_key, label: permissionLabel(p.permission_key).label, group: permissionModuleLabel(p.permission_key) }))} />
        <label className="text-sm"><span className="text-gray-600">Ends</span>
          <input type="datetime-local" value={form.until} onChange={e => setForm({ ...form, until: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <label className="text-sm md:col-span-2"><span className="text-gray-600">Reason</span>
          <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
      </div>
      <div className="border-t p-4"><button onClick={create} disabled={!form.delegateId || !form.organizationId || !form.permission || !form.until || form.reason.trim().length < 5}
        className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">Create delegation</button></div>
    </DisclosurePanel>
    <section className="rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><h3 className="font-semibold">{state?.canManage ? 'All delegations' : 'My delegations'}</h3>
        <ModuleFilterSelect value={moduleFilter} onChange={setModuleFilter} available={allDelegations.flatMap(delegationModules)} /></div>
      {error && <div className="p-4 text-sm text-red-700">{error}</div>}
      <div className="divide-y">{delegations.map((d: any) => <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
        <div><div className="font-medium">{nameOf(d.delegator_id)} → {nameOf(d.delegate_id)}</div>
          <div className="text-xs text-gray-500">{(d.permission_keys || []).map((k: string) => permissionLabel(k).label).join(', ')} · {orgName.get(d.organization_id) || 'Organization'} · until {formatDate(d.effective_until)}</div>
          <div className="text-xs text-gray-600">“{d.reason}”</div></div>
        <div className="flex items-center gap-2"><Pill value={d.status} />
          {d.status === 'active' && <button onClick={() => revoke(d.id)} className="rounded-md border px-2 py-1 text-xs">Revoke</button>}</div>
      </div>)}
        {state && !delegations.length && <EmptyState>{moduleFilter !== 'all' ? 'No delegations in this module.' : 'No delegations.'}</EmptyState>}</div>
    </section>
  </div>
}

function Reviews({ data, nameOf, orgName, roleName }: any) {
  const { state, error, reload } = useList('/api/security-access/reviews')
  const [form, setForm] = useState({ name: '', organizationId: '', roleId: '', reviewerId: '', due: '' })
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  // Active campaigns with pending items start open; everything else is folded.
  const [openCampaigns, setOpenCampaigns] = useState<Set<string> | null>(null)
  async function post(body: any, ok: string) {
    const result = await callApi('/api/security-access/reviews', { body })
    setMessage(result.ok ? { tone: 'ok', text: ok } : { tone: 'error', text: result.error || 'Unable to complete' })
    if (result.ok) reload()
  }
  const itemsByCampaign = useMemo(() => {
    const map = new Map<string, any[]>()
    for (const i of state?.items || []) map.set(i.campaign_id, [...(map.get(i.campaign_id) || []), i])
    return map
  }, [state])
  return <div className="space-y-4">
    <Feedback message={message} />
    {state?.canManage && <DisclosurePanel title="Start an access review" open={formOpen} onToggle={() => setFormOpen(!formOpen)} actionLabel="New review"
      info={<p>Snapshots current assignments for certification. Reviewers retain, revoke or shorten access; nobody certifies their own access.</p>}>
      <div className="grid gap-4 p-4 md:grid-cols-3">
        <label className="text-sm"><span className="text-gray-600">Name</span><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <SearchableSelect label="Organization (optional)" value={form.organizationId} onChange={v => setForm({ ...form, organizationId: v })} options={(data.organizations || []).map((o: any) => ({ value: o.id, label: o.org_name }))} allowClear />
        <SearchableSelect label="Role (optional)" value={form.roleId} onChange={v => setForm({ ...form, roleId: v })} options={(data.roles || []).map((r: any) => ({ value: r.id, label: r.name }))} allowClear />
        <SearchableSelect label="Reviewer" value={form.reviewerId} onChange={v => setForm({ ...form, reviewerId: v })} options={(data.people || []).map((p: any) => ({ value: p.id, label: p.full_name || p.email }))} />
        <label className="text-sm"><span className="text-gray-600">Due</span><input type="datetime-local" value={form.due} onChange={e => setForm({ ...form, due: e.target.value })} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
      </div>
      <div className="border-t p-4"><button onClick={() => post({ action: 'create', name: form.name, organizationId: form.organizationId || null, roleId: form.roleId || null, reviewerId: form.reviewerId, dueAt: toIso(form.due) }, 'Review started.')}
        disabled={form.name.trim().length < 3 || !form.reviewerId} className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">Start review</button></div>
    </DisclosurePanel>}
    {error && <div className="p-4 text-sm text-red-700">{error}</div>}
    {(state?.campaigns || []).map((c: any) => {
      const items = itemsByCampaign.get(c.id) || []
      const pending = items.filter((i: any) => i.decision === 'pending').length
      const isOpen = openCampaigns ? openCampaigns.has(c.id) : c.status === 'active' && pending > 0
      const toggleCampaign = () => setOpenCampaigns(prev => {
        const base = prev ?? new Set((state?.campaigns || []).filter((x: any) => x.status === 'active' && (itemsByCampaign.get(x.id) || []).some((i: any) => i.decision === 'pending')).map((x: any) => x.id))
        const n = new Set(base); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n
      })
      return <section key={c.id} className="rounded-xl border border-gray-200 bg-white">
        <div className={`flex flex-wrap items-center justify-between gap-3 p-4 ${isOpen ? 'border-b' : ''}`}>
          <div><ToggleButton open={isOpen} onClick={toggleCampaign} label={`${c.name}, ${pending} pending`}><h3 className="font-semibold">{c.name}</h3></ToggleButton>
            <p className="text-xs text-gray-500">Reviewer {nameOf(c.reviewer_id)} · {items.length} items · {pending} pending{c.due_at ? ` · due ${formatDate(c.due_at)}` : ''}</p></div>
          <div className="flex items-center gap-2"><Pill value={c.status} />
            {c.status === 'active' && pending === 0 && <button onClick={() => post({ action: 'complete', campaignId: c.id }, 'Review completed.')} className="rounded-md bg-emerald-600 px-2 py-1 text-xs text-white">Complete</button>}</div>
        </div>
        {isOpen && <div className="divide-y">{items.map((i: any) => <div key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
          <div><div className="font-medium">{nameOf(i.user_id)} — {i.snapshot?.role_name || roleName.get(i.role_id)}</div>
            <div className="text-xs text-gray-500">{orgName.get(i.snapshot?.organization_id) || ''} · {(i.snapshot?.scopes || []).map((s: any) => s.name).join(', ')}</div></div>
          <div className="flex items-center gap-2"><Pill value={i.decision} />
            {c.status === 'active' && i.decision === 'pending' && i.user_id !== data.viewerId && <>
              <button onClick={() => post({ action: 'decide', itemId: i.id, decision: 'retain' }, 'Retained.')} className="rounded-md border px-2 py-1 text-xs">Retain</button>
              <button onClick={() => { const reason = window.prompt('Reason for revoking?') || ''; post({ action: 'decide', itemId: i.id, decision: 'revoke', reason }, 'Revoked.') }} className="rounded-md border px-2 py-1 text-xs text-red-700">Revoke</button>
              <button onClick={() => { const until = window.prompt('New end date (YYYY-MM-DD)?'); const reason = window.prompt('Reason?') || ''; const iso = until ? toIso(`${until}T23:59`) : null; if (iso) post({ action: 'decide', itemId: i.id, decision: 'modify', reason, newEffectiveUntil: iso }, 'End date set.') }} className="rounded-md border px-2 py-1 text-xs">Set end date</button></>}
          </div>
        </div>)}</div>}
      </section>
    })}
    {state && !(state.campaigns || []).length && <div className="rounded-xl border bg-white p-4 text-sm text-gray-500">No access review campaigns.</div>}
  </div>
}

const SOD_ROW = 'grid grid-cols-1 gap-x-4 gap-y-1 md:grid-cols-[minmax(0,1fr)_8rem_7rem_5rem_6rem] md:items-center'
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function SegregationOfDuties({ nameOf }: any) {
  const { state, error } = useList('/api/security-access/sod')
  const rules: SodRule[] = useMemo(() => state?.rules || [], [state])
  const violations: SodViolation[] = useMemo(() => state?.violations || [], [state])
  const mitigations: SodMitigation[] = useMemo(() => state?.mitigations || [], [state])
  const ruleName = useMemo(() => new Map(rules.map(r => [r.id, r.name])), [rules])
  const conflictsByRule = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of violations) m.set(v.rule_id, (m.get(v.rule_id) ?? 0) + 1)
    return m
  }, [violations])

  const [query, setQuery] = useState('')
  const [enforcement, setEnforcement] = useState<'all' | 'enforce' | 'monitor'>('all')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [filterOpen, setFilterOpen] = useState<Set<string>>(new Set())
  const [openRule, setOpenRule] = useState<string | null>(null)
  const q = query.trim().toLowerCase()
  const filtering = q.length > 0 || enforcement !== 'all'
  const shown = useMemo(() => rules.filter(r => (enforcement === 'all' || r.enforcement === enforcement)
    && (!q || `${r.name} ${r.description ?? ''} ${humanize(r.document_type)} ${permissionLabel(r.left_key).label} ${permissionLabel(r.right_key).label}`.toLowerCase().includes(q))), [rules, enforcement, q])
  const groups = useMemo(() => groupSodRules(shown, conflictsByRule), [shown, conflictsByRule])
  useEffect(() => { setFilterOpen(new Set(groups.map(g => g.id))) }, [groups])
  const expanded = filtering ? filterOpen : open
  const setExpanded = filtering ? setFilterOpen : setOpen
  const flip = (id: string) => setExpanded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const clear = () => { setQuery(''); setEnforcement('all') }

  if (!state && !error) return <div role="status" className="p-6 text-sm text-gray-500">Loading segregation of duties…</div>
  const enforced = rules.filter(r => r.enforcement === 'enforce').length

  return <div className="space-y-4">
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm" aria-label="Segregation of duties rules">
      <div className="space-y-3 border-b border-gray-100 p-4">
        <div>
          <h3 className="font-semibold text-gray-950">Rules</h3>
          <p className="text-sm text-gray-500">
            <span className="font-medium text-red-700">Blocks</span> refuses the conflicting step. <span className="font-medium text-amber-800">Monitors</span> allows it and records the conflict for review.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={query} onChange={setQuery} placeholder="Search rules or permissions" label="Search rules" className="basis-full sm:basis-auto sm:w-72" />
          <FilterChips label="Enforcement" value={enforcement} onChange={setEnforcement} items={[
            { id: 'all', label: 'All', count: rules.length },
            { id: 'enforce', label: 'Blocks', count: enforced },
            { id: 'monitor', label: 'Monitors', count: rules.filter(r => r.enforcement === 'monitor').length },
          ]} />
          <div className="ml-auto flex items-center gap-2">
            {filtering && <button type="button" onClick={clear} className={`rounded text-xs font-medium text-orange-600 hover:text-orange-700 ${FOCUS}`}>Clear filters</button>}
            <button type="button" onClick={() => setExpanded(new Set())} disabled={expanded.size === 0}
              className={`rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-default disabled:opacity-40 ${FOCUS}`}>Collapse all</button>
          </div>
        </div>
      </div>
      {filtering && rules.length > 0 && <p role="status" className="border-b border-gray-100 bg-orange-50/40 px-4 py-1.5 text-xs text-gray-600">Showing {shown.length} of {plural(rules.length, 'rule')}.</p>}
      {rules.length === 0 ? <EmptyState>No segregation of duties rules are defined.</EmptyState>
        : shown.length === 0 ? <EmptyState>No rules match. <button type="button" onClick={clear} className={`rounded font-medium text-orange-600 ${FOCUS}`}>Clear filters</button></EmptyState>
        : <div>
          <div className={`${SOD_ROW} hidden border-b border-gray-100 px-4 py-2 text-xs font-medium text-gray-500 md:grid`} aria-hidden>
            <span>Module / rule</span><span>Type</span><span>Enforcement</span><span>Status</span><span className="md:text-right">Conflicts</span>
          </div>
          <ul className={LIST_TEXT}>{groups.map(g => {
            const gOpen = expanded.has(g.id)
            return <li key={g.id} className="border-t border-gray-100 first:border-t-0">
              <div className="bg-gray-50/70 px-4 py-2">
                <ToggleButton open={gOpen} onClick={() => flip(g.id)} label={`${g.name}, ${plural(g.rules.length, 'rule')}`}>
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold text-gray-900">{g.name}</span>
                    <span className="text-xs text-gray-400">{plural(g.rules.length, 'rule')}</span>
                    <span className="text-xs font-normal text-gray-500">
                      {[g.enforced && `${g.enforced} blocking`, g.monitored && `${g.monitored} monitoring`, g.conflicts && plural(g.conflicts, 'conflict')].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </ToggleButton>
              </div>
              {gOpen && <ul className="divide-y divide-gray-50">{g.rules.map(r => {
                const rOpen = openRule === r.id
                const e = enforcementOf(r.enforcement)
                const conflicts = conflictsByRule.get(r.id) ?? 0
                return <li key={r.id}>
                  <div className={`${SOD_ROW} py-2 pl-6 pr-4 text-sm md:pl-10`}>
                    <ToggleButton open={rOpen} onClick={() => setOpenRule(rOpen ? null : r.id)} label={r.name}>
                      <span className="min-w-0"><span className="block truncate font-medium text-gray-900">{r.name}</span>
                        <span className="block truncate text-xs text-gray-500">{r.description}</span></span>
                    </ToggleButton>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 md:contents">
                      <span title={RULE_KINDS[r.rule_kind]?.help} className="text-xs text-gray-600">{ruleKindLabel(r.rule_kind)}</span>
                      <span><span title={e.help} className={`rounded-full px-2 py-0.5 text-xs font-medium ${e.tone}`}>{e.label}</span></span>
                      <span className="text-xs text-gray-600">{r.status === 'active' ? 'Active' : humanize(r.status)}</span>
                      <span className={`text-xs tabular-nums md:text-right ${conflicts ? 'font-medium text-gray-900' : 'text-gray-400'}`}>{conflicts}<span className="md:sr-only"> {conflicts === 1 ? 'conflict' : 'conflicts'}</span></span>
                    </div>
                  </div>
                  {rOpen && <SodRuleDetails r={r} nameOf={nameOf}
                    exceptions={mitigations.filter(m => m.rule_id === r.id && m.status === 'active').length}
                    recent={violations.filter(v => v.rule_id === r.id).slice(0, 5)} />}
                </li>
              })}</ul>}
            </li>
          })}</ul>
        </div>}
    </section>
    <SodConflicts violations={violations} ruleName={ruleName} nameOf={nameOf} />
  </div>
}

function SodRuleDetails({ r, nameOf, exceptions, recent }: { r: SodRule; nameOf: (id: string) => string; exceptions: number; recent: SodViolation[] }) {
  const sameDoc = r.rule_kind === 'same_document'
  return <div className="space-y-3 bg-gray-50/60 py-3 pl-12 pr-4 text-xs md:pl-16">
    <dl className="grid gap-3 sm:grid-cols-3">
      <div><dt className="text-gray-400">{sameDoc ? 'First step' : 'Permission'}</dt><dd className="text-gray-800">{permissionLabel(r.left_key).label}</dd></div>
      <div><dt className="text-gray-400">{sameDoc ? `Must be a different person for` : 'Conflicts with'}</dt><dd className="text-gray-800">{permissionLabel(r.right_key).label}</dd></div>
      <div><dt className="text-gray-400">Applies to</dt><dd className="text-gray-800">{sameDoc ? `The same ${humanize(r.document_type) || 'document'}` : 'Anyone holding both'}</dd></div>
      <div><dt className="text-gray-400">In effect</dt><dd className="text-gray-800">{r.effective_from ? `From ${formatDate(r.effective_from)}` : 'Since creation'}{r.effective_until ? ` until ${formatDate(r.effective_until)}` : ''}</dd></div>
      <div><dt className="text-gray-400">Approved exceptions</dt><dd className="text-gray-800">{exceptions ? `${exceptions} active` : 'None'}</dd></div>
      <div><dt className="text-gray-400">What happens</dt><dd className="text-gray-800">{enforcementOf(r.enforcement).help}</dd></div>
    </dl>
    <div>
      <div className="text-gray-400">Latest conflicts</div>
      {recent.length === 0 ? <div className="text-gray-500">None recorded.</div>
        : <ul className="mt-1 space-y-1">{recent.map(v => <li key={v.id} className="flex flex-wrap items-center gap-2 text-gray-700">
          <span className={`rounded-full px-2 py-0.5 ${outcomeOf(v.outcome).tone}`}>{outcomeOf(v.outcome).label}</span>
          <span>{nameOf(v.user_id)}</span><span className="text-gray-400">{formatDate(v.detected_at)}</span>
        </li>)}</ul>}
    </div>
    <code className="block text-[11px] text-gray-400">{r.left_key} ↔ {r.right_key}</code>
  </div>
}

function SodConflicts({ violations, ruleName, nameOf }: { violations: SodViolation[]; ruleName: Map<string, string>; nameOf: (id: string) => string }) {
  const [outcome, setOutcome] = useState<string>('all')
  const [query, setQuery] = useState('')
  const page = useLimit(10)
  const count = (o: string) => violations.filter(v => v.outcome === o).length
  const q = query.trim().toLowerCase()
  const rows = violations.filter(v => (outcome === 'all' || v.outcome === outcome)
    && (!q || `${ruleName.get(v.rule_id) ?? ''} ${nameOf(v.user_id)} ${humanize(v.document_type)}`.toLowerCase().includes(q)))
  const blocked = count('blocked')
  return <Collapsible title="Recent conflicts" meta={violations.length ? `${plural(violations.length, 'conflict')}${blocked ? ` · ${blocked} blocked` : ''}` : 'None recorded'}>
    {violations.length === 0 ? <EmptyState>No conflicts recorded.</EmptyState> : <>
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 p-4">
        <SearchInput value={query} onChange={v => { setQuery(v); page.reset() }} placeholder="Search person or rule" label="Search conflicts" />
        <FilterChips label="Outcome" value={outcome} onChange={v => { setOutcome(v); page.reset() }} items={[
          { id: 'all', label: 'All', count: violations.length },
          ...Object.keys(OUTCOMES).filter(o => count(o)).map(o => ({ id: o, label: OUTCOMES[o].label, count: count(o) })),
        ]} />
      </div>
      {rows.length === 0 ? <EmptyState>No conflicts match.</EmptyState> : <ul className="divide-y divide-gray-100">
        {rows.slice(0, page.limit).map(v => <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
          <div className="min-w-0"><div className="font-medium text-gray-900">{ruleName.get(v.rule_id) ?? 'Rule'}</div>
            <div className="text-xs text-gray-500">{nameOf(v.user_id)}{v.document_type ? ` · ${humanize(v.document_type)}` : ''} · {formatDate(v.detected_at)}</div></div>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${outcomeOf(v.outcome).tone}`}>{outcomeOf(v.outcome).label}</span>
        </li>)}
      </ul>}
      <ShowMore shown={Math.min(page.limit, rows.length)} total={rows.length} onMore={page.more} />
    </>}
  </Collapsible>
}

function EmergencyAccess({ governance }: { governance: any }) {
  return <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
    <div className="flex items-start gap-3"><Lock className="mt-0.5 h-5 w-5 text-amber-700" />
      <div className="space-y-2 text-sm text-amber-900">
        <h3 className="font-semibold">Emergency access is not available</h3>
        <p>{governance?.emergencyAccess?.prerequisite || 'Multi-factor step-up authentication is required before emergency access can be enabled.'}</p>
        <p className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" />Break-glass access stays separate from Super Admin and, once enabled, will require a reason, a narrow scope, a short expiry, privileged-action logging and a post-use review.</p>
        <p className="flex items-center gap-2"><KeyRound className="h-4 w-4" />The database refuses to enable it while the prerequisite is unmet.</p>
      </div></div>
  </section>
}
