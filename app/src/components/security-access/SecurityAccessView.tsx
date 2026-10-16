'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, ShieldCheck } from 'lucide-react'
import AccessSimulator from './AccessSimulator'
import DecisionLog from './DecisionLog'
import PeopleAccessPanel from './PeopleAccessPanel'
import RolesPoliciesPanel from './RolesPoliciesPanel'
import GovernancePanel from './GovernancePanel'
import TechnicalAccessPanel, { LegacyCompatibilityPanel } from './TechnicalAccessPanel'
import AccessChangeLog, { ParityEvidence } from './AccessChangeLog'
import DataScopePanel from './DataScopePanel'
import ApprovalLimitsPanel from './ApprovalLimitsPanel'
import { onTabKeyDown } from './ui'
import AdvancedNav from './AdvancedNav'
import SystemLogsShortcut from '@/components/system-logs/SystemLogsShortcut'
import { AUDIT_SECTIONS, GOVERNANCE_SECTIONS, destinationFor, visibleDestinations, type AdvancedDestination, type AdvancedSection, type AuditSection, type GovernanceSection } from './advanced-nav'
import { useReadModel, type LoadStatus } from './useSecurityAccessData'
import OverviewPanel, { type OverviewTarget } from './OverviewPanel'
import type { GrantIntent } from './PeopleAccessPanel'

type Tab = 'overview' | 'people' | 'roles' | 'advanced'
const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' }, { id: 'people', label: 'People & Access' },
  { id: 'roles', label: 'Roles & Policies' }, { id: 'advanced', label: 'Advanced' },
]
// Advanced destinations (and their per-destination visibility predicates) live in ./advanced-nav. The moved panels keep their
// own checks: Advanced gains no broader access just because a panel moved here.

/** URL is the single source of truth for navigation: ?tab=&section=&gov=&audit=&diff=1&q= (legacy ?tab=governance|technical|audit still works). */
type Nav = { tab: Tab; section: AdvancedSection; gov: GovernanceSection; audit: AuditSection; diff: boolean; q: string }
const DEFAULT_NAV: Nav = { tab: 'overview', section: 'governance', gov: 'requests', audit: 'decisions', diff: false, q: '' }
function parseNav(search: string): Nav {
  const sp = new URLSearchParams(search)
  const raw = sp.get('tab') || ''
  const nav: Nav = { ...DEFAULT_NAV }
  if (raw === 'governance' || raw === 'technical' || raw === 'audit') { nav.tab = 'advanced'; nav.section = raw }
  else if (raw === 'scopes' || raw === 'authority') { nav.tab = 'advanced'; nav.section = raw } // Old links to the moved Data Scope / Authority Policies panels.
  else if (raw === 'overview' || raw === 'people' || raw === 'roles' || raw === 'advanced') nav.tab = raw
  const section = sp.get('section')
  if (nav.tab === 'advanced' && (section === 'governance' || section === 'technical' || section === 'scopes' || section === 'authority' || section === 'audit')) nav.section = section
  // Old Roles & Policies deep links into the moved panels open the Advanced section instead.
  if (nav.tab === 'roles' && (section === 'scopes' || section === 'authority')) { nav.tab = 'advanced'; nav.section = section }
  const gov = sp.get('gov') as GovernanceSection | null
  if (gov && GOVERNANCE_SECTIONS.includes(gov)) nav.gov = gov
  const audit = sp.get('audit') as AuditSection | null
  if (audit && AUDIT_SECTIONS.includes(audit)) nav.audit = audit
  nav.diff = nav.tab === 'advanced' && nav.section === 'audit' && sp.get('diff') === '1'
  nav.q = nav.tab === 'roles' ? (sp.get('q') || '') : ''
  return nav
}
function navToSearch(nav: Nav, current: string) {
  const sp = new URLSearchParams(current)
  for (const k of ['tab', 'section', 'gov', 'audit', 'diff', 'q']) sp.delete(k)
  if (nav.tab !== 'overview') sp.set('tab', nav.tab)
  if (nav.tab === 'advanced') {
    sp.set('section', nav.section)
    if (nav.section === 'governance' && nav.gov !== 'requests') sp.set('gov', nav.gov)
    if (nav.section === 'audit') { if (nav.audit !== 'decisions') sp.set('audit', nav.audit); if (nav.diff) sp.set('diff', '1') }
  }
  if (nav.tab === 'roles' && nav.q) sp.set('q', nav.q)
  const out = sp.toString()
  return out ? `?${out}` : ''
}

export default function SecurityAccessView({ userProfile }: { userProfile: any }) {
  const [nav, setNav] = useState<Nav>(DEFAULT_NAV)
  const [ready, setReady] = useState(false)
  // Scoped to the signed-in account and organization: switching either clears every verified read model.
  const scopeKey = `${userProfile?.id ?? ''}:${userProfile?.organization_id ?? ''}`
  const overview = useReadModel<any>('/api/security-access/overview', scopeKey, { isSchemaMissing: body => body?.schemaReady === false })
  // Governance read model needs security.audit.view; a denial keeps those sections informational.
  const governanceModel = useReadModel<any>('/api/security-access/governance', scopeKey)
  const data = overview.data
  const governance = governanceModel.status === 'ready' ? governanceModel.data : null
  const governanceError = governanceModel.status === 'ready' || governanceModel.status === 'loading' ? null
    : governanceModel.status === 'denied' ? 'Requires the Security audit view (security.audit.view).' : governanceModel.error || 'Unavailable'
  // Last Advanced section/audit view, so switching away and back keeps it.
  const lastAdvanced = useRef<Pick<Nav, 'section' | 'gov' | 'audit'>>({ section: 'governance', gov: 'requests', audit: 'decisions' })
  // Profile-first assignment: People & Access opens its existing grant form with this profile selected.
  const [grantIntent, setGrantIntent] = useState<GrantIntent | null>(null)

  useEffect(() => {
    const apply = () => { const n = parseNav(window.location.search); if (n.tab === 'advanced') lastAdvanced.current = { section: n.section, gov: n.gov, audit: n.audit }; setNav(n); setReady(true) }
    apply()
    window.addEventListener('popstate', apply)
    return () => window.removeEventListener('popstate', apply)
  }, [])

  const go = (next: Nav) => {
    if (next.tab === 'advanced') lastAdvanced.current = { section: next.section, gov: next.gov, audit: next.audit }
    setGrantIntent(null)
    setNav(next)
    const search = navToSearch(next, window.location.search)
    if (search !== window.location.search) window.history.pushState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`)
  }
  const selectTab = (tab: Tab) => go(tab === 'advanced' ? { ...DEFAULT_NAV, tab, ...lastAdvanced.current } : { ...DEFAULT_NAV, tab })
  const selectDestination = (d: AdvancedDestination) => go({ ...DEFAULT_NAV, tab: 'advanced', section: d.section, gov: d.gov ?? DEFAULT_NAV.gov, audit: d.audit ?? DEFAULT_NAV.audit })
  const assignProfile = (p: { id: string; name: string; orgTypes: string[] }) => { go({ ...DEFAULT_NAV, tab: 'people' }); setGrantIntent({ roleId: p.id, roleName: p.name, orgTypes: p.orgTypes, nonce: Date.now() }) }
  const navigate = (target: OverviewTarget) => {
    if (target.tab === 'audit') go({ ...DEFAULT_NAV, tab: 'advanced', section: 'audit', diff: target.differencesOnly })
    else if (target.tab === 'governance' || target.tab === 'technical') go({ ...DEFAULT_NAV, tab: 'advanced', section: target.tab })
    else if (target.tab === 'roles') go({ ...DEFAULT_NAV, tab: 'roles', q: target.query })
    else go({ ...DEFAULT_NAV, tab: 'people' })
  }
  const tab = nav.tab
  const destinations = visibleDestinations()
  // An unavailable (or unknown) destination falls back to the first one this viewer may open; panels still enforce their own access.
  const wanted = destinationFor(nav)
  const current = destinations.find(d => d.id === wanted.id) || destinations[0]
  const auditDifferencesOnly = nav.diff
  const auditSection = current?.audit
  const rolesQuery = nav.q

  // After a change: refresh both read models (only the latest response of each is applied).
  const reloadOverview = overview.reload, reloadGovernance = governanceModel.reload
  const load = useCallback(() => { reloadOverview(); reloadGovernance() }, [reloadOverview, reloadGovernance])

  if (ready && !data && overview.status !== 'loading') return <LoadProblem status={overview.status} error={overview.error} correlationId={overview.correlationId} onRetry={overview.reload} />
  if (!data || !ready) return <div className="p-6 lg:p-8" role="status" aria-live="polite"><span className="sr-only">Loading Security & Access…</span><div className="mx-auto max-w-7xl animate-pulse space-y-5"><div className="h-8 w-64 rounded bg-gray-200" /><div className="h-10 rounded bg-gray-100" /><div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="h-28 rounded-xl bg-gray-100" />)}</div><div className="h-72 rounded-xl bg-gray-100" /></div></div>
  return <div className="h-full overflow-y-auto p-6 lg:p-8">
    <div className="mx-auto max-w-7xl space-y-6">
      <div><div className="flex items-center gap-3"><ShieldCheck className="h-7 w-7 text-orange-500"/><h1 className="text-2xl font-semibold text-gray-950">Security & Access</h1></div><p className="mt-1 text-sm text-gray-600">Manage people, permissions and access controls.</p></div>
      {overview.status === 'schema_missing' && <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{data.error || 'The Security & Access schema has not been applied in this environment.'}{Array.isArray(data.missingDependency) && data.missingDependency.length ? ` Missing: ${data.missingDependency.join(', ')}.` : ''} The UI is read-only until the migration is reviewed and applied.</div>}
      {overview.stale && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900"><span>Couldn't refresh. Showing the last loaded data. {overview.error}</span><RetryButton onClick={overview.reload} busy={overview.refreshing} /></div>}
      <div role="tablist" aria-label="Security & Access sections" onKeyDown={onTabKeyDown} className="flex gap-1 overflow-x-auto border-b border-gray-200">{tabs.map(t => <button key={t.id} type="button" role="tab" id={`sa-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="sa-main-panel" tabIndex={tab === t.id ? 0 : -1} onClick={() => selectTab(t.id)} className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${tab === t.id ? 'border-orange-500 text-orange-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>{t.label}</button>)}</div>
      <div id="sa-main-panel" role="tabpanel" aria-labelledby={`sa-tab-${tab}`} className="space-y-6">

      {tab === 'overview' && <OverviewPanel data={data} onNavigate={navigate} />}

      {tab === 'people' && <PeopleAccessPanel data={data} onChanged={load} grantIntent={grantIntent} />}
      {tab === 'roles' && <RolesPoliciesPanel key={`roles-${rolesQuery}`} data={data} governance={governance} onChanged={load} initialQuery={rolesQuery} onAssignProfile={assignProfile} />}
      {tab === 'advanced' && <div className="space-y-4">
        {current ? <AdvancedNav destinations={destinations} current={current} onSelect={selectDestination} /> : <p role="alert" className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">You don't have access to any Advanced destinations.</p>}
      {current?.section === 'governance' && <GovernancePanel section={current.gov!} data={data} governance={governance} />}
      {current?.section === 'technical' && <div className="space-y-4"><TechnicalAccessPanel governance={governance} error={governanceError} /><LegacyCompatibilityPanel governance={governance} /></div>}
      {current?.section === 'scopes' && <DataScopePanel scopes={data.scopeDefinitions || []} organizations={data.organizations || []} />}
      {current?.section === 'authority' && <ApprovalLimitsPanel governance={governance} />}
      {current?.section === 'audit' && <div className="space-y-4">
        <SystemLogsShortcut />
        {auditSection === 'decisions' && <DecisionLog key={`log-${auditDifferencesOnly}`} initialFilter={auditDifferencesOnly ? 'differences' : 'all'} decisions={auditDifferencesOnly ? data.decisions || [] : data.recentDecisions?.length ? data.recentDecisions : data.decisions || []} actors={data.actors || []} people={data.people || []} organizations={data.organizations || []} roles={data.roles || []} />}
        {auditSection === 'changes' && <AccessChangeLog governance={governance} people={data.people || []} actors={data.actors || []} />}
        {auditSection === 'parity' && <ParityEvidence scopeKey={scopeKey} />}
        {auditSection === 'simulator' && <AccessSimulator userProfile={userProfile} people={data.people || []} actors={data.actors || []} permissions={data.permissions || []} organizations={data.organizations || []} disabled={!data.schemaReady} />}
      </div>}
      </div>}
      </div>
    </div>
  </div>
}

function RetryButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return <button type="button" onClick={onClick} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-orange-300 bg-white px-3 py-1.5 text-sm font-medium text-orange-700 hover:bg-orange-50 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"><RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden />{busy ? 'Retrying…' : 'Retry'}</button>
}

/** Nothing verified to show: say exactly why (never an empty dashboard). */
function LoadProblem({ status, error, correlationId, onRetry }: { status: LoadStatus; error: string | null; correlationId: string | null; onRetry: () => void }) {
  const copy = status === 'denied'
    ? { title: 'Access denied', body: 'You do not have the Security & Access view permission (security.access.view).', retry: false }
    : status === 'unauthenticated'
      ? { title: 'Session expired', body: 'Sign in again to continue.', retry: false }
      : { title: 'Security & Access is temporarily unavailable', body: error || 'The service did not respond.', retry: true }
  return <div className="p-6 lg:p-8"><div role="alert" className="mx-auto max-w-2xl rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
    <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-orange-500" aria-hidden /><h1 className="text-lg font-semibold text-gray-950">{copy.title}</h1></div>
    <p className="mt-2 text-sm text-gray-600">{copy.body}</p>
    {correlationId && <p className="mt-1 text-xs text-gray-400">Reference: {correlationId}</p>}
    <div className="mt-4 flex gap-2">{copy.retry && <RetryButton onClick={onRetry} />}{status === 'unauthenticated' && <a href="/login" className="inline-flex items-center rounded-lg bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700">Sign in</a>}</div>
  </div></div>
}
