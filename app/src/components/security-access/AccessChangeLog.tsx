'use client'

import { useMemo, useState } from 'react'
import { formatDate } from './client-api'
import { permissionLabel } from '@/lib/security-access/labels'
import { EmptyState, FilterChips, SearchInput, ShowMore, useLimit } from './ui'
import { useReadModel } from './useSecurityAccessData'

const ACTION_LABELS: Record<string, string> = {
  'assignment.granted': 'Access granted', 'assignment.revoked': 'Access revoked', 'assignment.derived': 'Lifecycle access derived',
  'assignment.restored': 'Automatic access restored', 'policy_restore': 'Revoked grant restored', 'assignment.removed': 'Access removed with its role', 'role.deleted': 'Role deleted',
  'legacy_authorization.locked': 'Legacy authorization locked',
  'access_request.submitted': 'Access requested', 'access_request.approved': 'Request approved', 'access_request.denied': 'Request denied',
  'access_request.cancelled': 'Request cancelled', 'access_request.expired': 'Request expired',
  'delegation.created': 'Delegation created', 'delegation.revoked': 'Delegation revoked',
  'access_review.created': 'Review started', 'access_review.completed': 'Review completed', 'access_review.retain': 'Review: retained',
  'access_review.revoke': 'Review: revoked', 'access_review.modify': 'Review: end date set',
  'lifecycle.joiner': 'Joiner', 'lifecycle.mover': 'Mover', 'lifecycle.leaver': 'Leaver',
  'migration_mode.changed': 'Migration mode changed', 'scope.defined': 'Scope defined', 'sod.mitigation_granted': 'SoD exception granted',
  'governance.maintenance': 'Expiry maintenance',
}

const nameMap = (people: any[], actors: any[]) => {
  const map = new Map<string, string>()
  for (const p of [...people, ...actors]) map.set(p.id, p.full_name || p.email)
  return (id: string | null) => (id ? map.get(id) || 'Unknown user' : 'System')
}

type ChangeFilter = 'all' | 'access' | 'governance' | 'lifecycle' | 'modes'
const CATEGORY: Array<[ChangeFilter, (action: string) => boolean]> = [
  ['access', a => a.startsWith('assignment.') || a.startsWith('identity.') || a === 'policy_restore'],
  ['governance', a => /^(access_request|delegation|access_review|sod)\./.test(a)],
  ['lifecycle', a => a.startsWith('lifecycle.') || a === 'governance.maintenance'],
  ['modes', a => a.startsWith('migration_mode.') || a.startsWith('legacy_authorization.') || a.startsWith('scope.')],
]
const categoryOf = (action: string): ChangeFilter => CATEGORY.find(([, test]) => test(action))?.[0] ?? 'all'

/** Parity evidence: legacy role definitions vs Security & Access. */
export function ParityEvidence({ scopeKey = '' }: { scopeKey?: string }) {
  const [query, setQuery] = useState('')
  const [onlyGaps, setOnlyGaps] = useState(false)
  // Expensive (an identity × permission analysis): loaded only while this section is open.
  const model = useReadModel<any>('/api/security-access/governance/parity', scopeKey)
  if (model.status === 'denied') return <EmptyState>Parity evidence needs the Security audit view.</EmptyState>
  if (model.status === 'unauthenticated') return <EmptyState>Your session has expired. Sign in again.</EmptyState>
  if (!model.data) {
    if (model.status === 'loading') return <div role="status" aria-live="polite" className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-500">Analysing parity evidence… this can take several seconds.</div>
    return <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><span>Parity evidence is temporarily unavailable. {model.error}</span>
      <button type="button" onClick={model.reload} className="rounded-lg border border-orange-300 bg-white px-3 py-1.5 font-medium text-orange-700 hover:bg-orange-50">Retry</button></div>
  }
  const governance = model.data
  const parity: any[] = governance.shadowParity || []
  const q = query.trim().toLowerCase()
  const rows = parity.filter((p: any) => (!onlyGaps || p.legacy_allow_new_deny || p.legacy_deny_new_allow || p.other_mismatch)
    && (!q || `${permissionLabel(p.permission_key).label} ${p.permission_key}`.toLowerCase().includes(q)))
  return <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
    <div className="border-b border-gray-100 p-4"><h2 className="font-semibold text-gray-950">Parity evidence</h2>
      <p className="text-sm text-gray-500">Analytic check of every active business identity: legacy role definition vs Security & Access in the person's own organization. Observed shadow comparisons from the last 30 days follow.</p></div>
    <div className="grid gap-3 border-b border-gray-100 p-4 text-sm sm:grid-cols-3">
      {!governance.compatParity && <p className="text-gray-500 sm:col-span-3">The analytic parity report is not installed in this environment.</p>}
      <div><div className="text-2xl font-semibold">{governance.compatParity?.checked ?? '—'}</div><div className="text-gray-500">identity × permission checks</div></div>
      <div><div className={`text-2xl font-semibold ${governance.compatParity?.legacyAllowNewDeny ? 'text-red-700' : ''}`}>{governance.compatParity?.legacyAllowNewDeny ?? '—'}</div><div className="text-gray-500">legacy access missing in S&A</div></div>
      <div><div className="text-2xl font-semibold">{governance.compatParity?.legacyDenyNewAllow ?? '—'}</div><div className="text-gray-500">explicit S&A grants beyond legacy</div></div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-2">
      <FilterChips label="Show" value={onlyGaps ? 'gaps' : 'all'} onChange={v => setOnlyGaps(v === 'gaps')} items={[
        { id: 'all', label: 'All permissions', count: parity.length },
        { id: 'gaps', label: 'With differences', count: parity.filter((p: any) => p.legacy_allow_new_deny || p.legacy_deny_new_allow || p.other_mismatch).length },
      ]} />
      <SearchInput value={query} onChange={setQuery} placeholder="Search permissions" label="Search parity evidence" />
    </div>
    <div className="max-h-[480px] divide-y divide-gray-100 overflow-auto">{rows.map((p: any) => <div key={p.permission_key} className="flex flex-wrap justify-between gap-2 px-4 py-2 text-xs">
      <span className="font-medium text-gray-800">{permissionLabel(p.permission_key).label}</span>
      <span className="text-gray-500">{p.total} decisions · {p.match_allow + p.match_deny} match · <span className={p.legacy_allow_new_deny ? 'text-amber-700' : ''}>{p.legacy_allow_new_deny} legacy-only</span> · {p.legacy_deny_new_allow} new-only · {p.other_mismatch} other</span>
    </div>)}</div>
    {!rows.length && <EmptyState>{parity.length ? 'No permissions match.' : governance.shadowParityAvailable === false ? 'Shadow parity is not installed in this environment.' : 'No decisions recorded in the last 30 days.'}</EmptyState>}
  </section>
}

/** Append-only access change log. */
export default function AccessChangeLog({ governance, people, actors }: { governance: any | null; people: any[]; actors: any[] }) {
  const nameOf = useMemo(() => nameMap(people, actors), [people, actors])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ChangeFilter>('all')
  const page = useLimit(30)
  if (!governance) return <EmptyState>The access change log needs the Security audit view.</EmptyState>
  const changes: any[] = governance.accessChanges || []
  const q = query.trim().toLowerCase()
  const rows = changes.filter((c: any) => (filter === 'all' || categoryOf(c.action) === filter)
    && (!q || `${ACTION_LABELS[c.action] || c.action} ${nameOf(c.target_user_id)} ${nameOf(c.actor_id)} ${c.reason || ''}`.toLowerCase().includes(q)))
  const count = (f: ChangeFilter) => changes.filter((c: any) => categoryOf(c.action) === f).length
  return <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 p-4">
      <div className="min-w-0"><h2 className="font-semibold text-gray-950">Access changes</h2><p className="text-sm text-gray-500">Append-only record of every grant, revocation, request, delegation, review, lifecycle event and mode change.</p></div>
      <SearchInput value={query} onChange={v => { setQuery(v); page.reset() }} placeholder="Search people, actions, reasons" label="Search access changes" />
    </div>
    <div className="border-b border-gray-100 px-4 py-2">
      <FilterChips label="Change type" value={filter} onChange={v => { setFilter(v); page.reset() }} items={[
        { id: 'all', label: 'All', count: changes.length },
        { id: 'access', label: 'Grants & revocations', count: count('access') },
        { id: 'governance', label: 'Requests, delegations & reviews', count: count('governance') },
        { id: 'lifecycle', label: 'Lifecycle', count: count('lifecycle') },
        { id: 'modes', label: 'Modes & scopes', count: count('modes') },
      ]} />
    </div>
    <ul className="divide-y divide-gray-100">{rows.slice(0, page.limit).map((c: any) => <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
      <div className="min-w-0"><span className="font-medium">{ACTION_LABELS[c.action] || c.action}</span>
        <span className="text-gray-500"> · {c.target_user_id ? `for ${nameOf(c.target_user_id)}` : c.entity_id && c.entity_type === 'sa_migration_mode' ? permissionLabel(c.entity_id).label : ''}</span>
        {c.reason && <div className="text-xs text-gray-500">“{c.reason}”</div>}</div>
      <div className="text-right text-xs text-gray-500">{nameOf(c.actor_id)}<div>{formatDate(c.occurred_at)}</div></div>
    </li>)}</ul>
    {!rows.length && <EmptyState>{changes.length ? 'No changes match.' : 'No access changes recorded yet.'}</EmptyState>}
    <ShowMore shown={Math.min(page.limit, rows.length)} total={rows.length} onMore={page.more} />
  </section>
}
