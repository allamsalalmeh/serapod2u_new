'use client'

import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import AccessSimulator from './AccessSimulator'
import DecisionLog from './DecisionLog'
import PeopleAccessPanel from './PeopleAccessPanel'
import RolesPoliciesPanel from './RolesPoliciesPanel'
import GovernancePanel from './GovernancePanel'
import TechnicalAccessPanel, { LegacyCompatibilityPanel } from './TechnicalAccessPanel'
import AccessChangeLog, { ParityEvidence } from './AccessChangeLog'
import { SectionTabs } from './ui'
import { callApi } from './client-api'
import OverviewPanel, { type OverviewTarget } from './OverviewPanel'
import type { GrantIntent } from './PeopleAccessPanel'

type Tab = 'overview' | 'people' | 'roles' | 'governance' | 'technical' | 'audit'
const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' }, { id: 'people', label: 'People & Access' },
  { id: 'roles', label: 'Roles & Policies' }, { id: 'governance', label: 'Governance' },
  { id: 'technical', label: 'Technical Access' }, { id: 'audit', label: 'Audit & Diagnostics' },
]

export default function SecurityAccessView({ userProfile }: { userProfile: any }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [data, setData] = useState<any>(null)
  const [governance, setGovernance] = useState<any>(null)
  const [governanceError, setGovernanceError] = useState<string | null>(null)
  // Overview links open other tabs with a starting filter; switching tabs
  // directly clears it.
  const [auditDifferencesOnly, setAuditDifferencesOnly] = useState(false)
  const [rolesQuery, setRolesQuery] = useState('')
  const [auditSection, setAuditSection] = useState<'decisions' | 'changes' | 'parity' | 'simulator'>('decisions')
  // Profile-first assignment: People & Access opens its existing grant form with this profile selected.
  const [grantIntent, setGrantIntent] = useState<GrantIntent | null>(null)
  const selectTab = (next: Tab) => { setAuditDifferencesOnly(false); setRolesQuery(''); setGrantIntent(null); setTab(next) }
  const assignProfile = (p: { id: string; name: string; orgTypes: string[] }) => { setGrantIntent({ roleId: p.id, roleName: p.name, orgTypes: p.orgTypes, nonce: Date.now() }); setTab('people') }
  const navigate = (target: OverviewTarget) => {
    setAuditDifferencesOnly(target.tab === 'audit' && target.differencesOnly)
    setRolesQuery(target.tab === 'roles' ? target.query : '')
    if (target.tab === 'audit') setAuditSection('decisions')
    setTab(target.tab)
  }

  const load = useCallback(() => {
    fetch('/api/security-access/overview', { cache: 'no-store' }).then(r => r.json()).then(setData)
      .catch(() => setData({ schemaReady: false, error: 'Unable to load Security & Access data.' }))
    // Governance read model needs security.audit.view; absent → sections stay informational.
    callApi('/api/security-access/governance').then(r => { setGovernance(r.ok ? r.data : null); setGovernanceError(r.ok ? null : r.error || 'Unavailable') })
  }, [])
  useEffect(() => { load() }, [load])

  if (!data) return <div className="p-6 lg:p-8" role="status" aria-live="polite"><span className="sr-only">Loading Security & Access…</span><div className="mx-auto max-w-7xl animate-pulse space-y-5"><div className="h-8 w-64 rounded bg-gray-200" /><div className="h-10 rounded bg-gray-100" /><div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map(i => <div key={i} className="h-28 rounded-xl bg-gray-100" />)}</div><div className="h-72 rounded-xl bg-gray-100" /></div></div>
  return <div className="h-full overflow-y-auto p-6 lg:p-8">
    <div className="mx-auto max-w-7xl space-y-6">
      <div><div className="flex items-center gap-3"><ShieldCheck className="h-7 w-7 text-orange-500"/><h1 className="text-2xl font-semibold text-gray-950">Security & Access</h1></div><p className="mt-1 text-sm text-gray-600">Manage people, permissions and access controls.</p></div>
      {!data.schemaReady && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{data.error} The UI is intentionally read-only until the additive migration is reviewed and applied.</div>}
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200">{tabs.map(t => <button key={t.id} onClick={() => selectTab(t.id)} aria-current={tab === t.id ? 'page' : undefined} className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium ${tab === t.id ? 'border-orange-500 text-orange-700' : 'border-transparent text-gray-500'}`}>{t.label}</button>)}</div>

      {tab === 'overview' && <OverviewPanel data={data} onNavigate={navigate} />}

      {tab === 'people' && <PeopleAccessPanel data={data} onChanged={load} grantIntent={grantIntent} />}
      {tab === 'roles' && <RolesPoliciesPanel key={`roles-${rolesQuery}`} data={data} governance={governance} onChanged={load} initialQuery={rolesQuery} onAssignProfile={assignProfile} />}
      {tab === 'governance' && <GovernancePanel data={data} governance={governance} />}
      {tab === 'technical' && <div className="space-y-4"><TechnicalAccessPanel governance={governance} error={governanceError} /><LegacyCompatibilityPanel governance={governance} /></div>}
      {tab === 'audit' && <div className="space-y-4">
        <SectionTabs label="Audit & Diagnostics sections" value={auditSection} onChange={setAuditSection} items={[
          { id: 'decisions', label: 'Authorization decisions' }, { id: 'changes', label: 'Access changes' },
          { id: 'parity', label: 'Parity evidence' }, { id: 'simulator', label: 'Access simulator' },
        ]} />
        {auditSection === 'decisions' && <DecisionLog key={`log-${auditDifferencesOnly}`} initialFilter={auditDifferencesOnly ? 'differences' : 'all'} decisions={auditDifferencesOnly ? data.decisions || [] : data.recentDecisions?.length ? data.recentDecisions : data.decisions || []} actors={data.actors || []} people={data.people || []} organizations={data.organizations || []} roles={data.roles || []} />}
        {auditSection === 'changes' && <AccessChangeLog governance={governance} people={data.people || []} actors={data.actors || []} />}
        {auditSection === 'parity' && <ParityEvidence governance={governance} />}
        {auditSection === 'simulator' && <AccessSimulator userProfile={userProfile} people={data.people || []} actors={data.actors || []} permissions={data.permissions || []} organizations={data.organizations || []} disabled={!data.schemaReady} />}
      </div>}
    </div>
  </div>
}
