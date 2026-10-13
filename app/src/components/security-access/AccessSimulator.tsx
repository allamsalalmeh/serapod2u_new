'use client'

import { useMemo, useState } from 'react'
import { CheckCircle2, KeyRound, XCircle } from 'lucide-react'
import SearchableSelect, { type SelectOption } from './SearchableSelect'
import {
  RESOURCE_TYPE_LABELS, modeLabel, orgTypeLabel, permissionLabel, reasonLabel,
  resourceTypeLabel, warehousesForOrganization, type DirectoryOrganization,
} from '@/lib/security-access/labels'
import { classifyPermission, moduleGroupRank, permissionModuleLabel } from '@/lib/security-access/modules'

interface SimulatorProps {
  userProfile: any
  people: any[]
  actors: any[]
  permissions: any[]
  organizations: DirectoryOrganization[]
  disabled?: boolean
}

const one = (value: any) => (Array.isArray(value) ? value[0] : value)

export default function AccessSimulator({ userProfile, people, actors, permissions, organizations, disabled }: SimulatorProps) {
  const orgById = useMemo(() => new Map(organizations.map(o => [o.id, o])), [organizations])
  const users = useMemo(() => {
    const byId = new Map<string, any>()
    for (const p of people) byId.set(p.id, { id: p.id, name: p.full_name, email: p.email, role: p.role_code, orgId: p.organization_id, orgName: one(p.organization)?.org_name })
    for (const a of actors) if (!byId.has(a.id)) byId.set(a.id, { id: a.id, name: a.full_name, email: a.email, role: a.role_code, orgId: a.organization_id, orgName: orgById.get(a.organization_id)?.org_name })
    if (!byId.has(userProfile.id)) byId.set(userProfile.id, { id: userProfile.id, name: userProfile.full_name, email: userProfile.email, role: userProfile.role_code, orgId: userProfile.organization_id, orgName: userProfile.organizations?.org_name })
    return Array.from(byId.values())
  }, [people, actors, userProfile, orgById])

  const [actorId, setActorId] = useState<string>(userProfile.id)
  const [permission, setPermission] = useState('inventory.stock_count.verify')
  const [organizationId, setOrganizationId] = useState<string>(userProfile.organization_id || '')
  const [warehouseId, setWarehouseId] = useState('')
  const [resourceOverride, setResourceOverride] = useState('')
  const [result, setResult] = useState<any>(null)
  const [submitted, setSubmitted] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [simulating, setSimulating] = useState(false)

  const resourceType = resourceOverride || permissionLabel(permission).resourceType
  const warehouses = useMemo(() => warehousesForOrganization(organizations, organizationId), [organizations, organizationId])

  const userOptions: SelectOption[] = users.map(u => ({
    value: u.id, label: u.name || u.email || 'Unnamed user',
    description: [u.role, u.orgName].filter(Boolean).join(' · '), keywords: u.email ?? '',
  }))
  const permissionOptions: SelectOption[] = [...permissions]
    .map(p => ({ key: p.permission_key, label: permissionLabel(p.permission_key).label, group: permissionModuleLabel(p.permission_key), rank: moduleGroupRank(classifyPermission(p.permission_key).groupId) }))
    .sort((a, b) => a.rank - b.rank || a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
    .map(({ key, label, group }) => ({ value: key, label, description: key, group }))
  const orgOptions: SelectOption[] = organizations.filter(o => o.org_type_code !== 'WH' || o.id === organizationId).map(o => ({
    value: o.id, label: o.org_name, description: orgTypeLabel(o.org_type_code), group: orgTypeLabel(o.org_type_code) || 'Other',
  }))
  const warehouseOptions: SelectOption[] = warehouses.map(w => ({ value: w.id, label: w.org_name, description: orgById.get(w.parent_org_id ?? '')?.org_name }))
  const resourceOptions: SelectOption[] = Object.entries(RESOURCE_TYPE_LABELS).map(([value, label]) => ({ value, label }))

  function selectActor(id: string) {
    setActorId(id)
    const user = users.find(u => u.id === id)
    if (user?.orgId) {
      const org = orgById.get(user.orgId)
      if (org?.org_type_code === 'WH') { setOrganizationId(org.id); setWarehouseId(org.id) } else { setOrganizationId(user.orgId); setWarehouseId('') }
    }
  }

  async function simulate(e: React.FormEvent) {
    e.preventDefault()
    setSimulating(true); setResult(null); setError(null)
    const body = { actorId, permission, resource: { type: resourceType, organizationId: organizationId || undefined, warehouseId: warehouseId || undefined } }
    try {
      const response = await fetch('/api/security-access/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const json = await response.json()
      if (!response.ok) setError(json?.error || 'Simulation failed')
      else { setResult(json); setSubmitted(body) }
    } catch {
      setError('Simulation failed')
    } finally {
      setSimulating(false)
    }
  }

  const actor = users.find(u => u.id === submitted?.actorId)
  const allowed = result?.decision === 'ALLOW'
  const newAuthoritative = result && (result.migrationMode === 'NEW_ENFORCED' || result.migrationMode === 'LEGACY_RETIRED')
  const scopeName = (id: string) => orgById.get(id)?.org_name ?? 'Unlisted organization'

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-orange-500" /><h2 className="font-semibold">Access Simulator / Explain Access</h2></div>
      <p className="mt-1 text-sm text-gray-500">Explains what the canonical evaluator would decide. Explain-only: nothing is recorded and nothing changes.</p>
      <form onSubmit={simulate} className="mt-4 grid gap-3 md:grid-cols-2">
        <SearchableSelect label="User" options={userOptions} value={actorId} onChange={selectActor} placeholder="Choose a user" />
        <SearchableSelect label="Permission" options={permissionOptions} value={permission} onChange={v => { setPermission(v); setResourceOverride('') }} placeholder="Choose a permission" />
        <SearchableSelect label="Organization" options={orgOptions} value={organizationId} onChange={v => { setOrganizationId(v); setWarehouseId('') }} placeholder="Any organization" allowClear />
        <SearchableSelect label="Warehouse" options={warehouseOptions} value={warehouseId} onChange={setWarehouseId} placeholder={warehouses.length ? 'No warehouse' : 'No warehouses under this organization'} allowClear hint="Only warehouses belonging to the selected organization are listed." />
        <SearchableSelect label="Resource type" options={resourceOptions} value={resourceType} onChange={setResourceOverride} hint={resourceOverride ? undefined : 'Set automatically from the permission.'} />
        <button disabled={simulating || disabled || !actorId || !permission} className="self-end rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{simulating ? 'Evaluating…' : 'Explain access'}</button>
      </form>

      {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

      {result && (
        <div className="mt-5 rounded-xl border border-gray-200">
          <div className={`flex items-center gap-3 rounded-t-xl p-4 ${allowed ? 'bg-emerald-50' : 'bg-red-50'}`}>
            {allowed ? <CheckCircle2 className="h-6 w-6 text-emerald-600" /> : <XCircle className="h-6 w-6 text-red-600" />}
            <div>
              <div className={`text-lg font-semibold ${allowed ? 'text-emerald-800' : 'text-red-800'}`}>{allowed ? 'ALLOW' : 'DENY'}</div>
              <div className="text-sm text-gray-700">{reasonLabel(result.reasonCode)}</div>
            </div>
          </div>
          <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2">
            <Row term="User" value={actor ? `${actor.name || actor.email} · ${actor.role ?? '—'}${actor.orgName ? ` · ${actor.orgName}` : ''}` : '—'} />
            <Row term="Group Policy" value={(result.matchedAssignments || []).map((a: any) => a.roleName).filter(Boolean).join(', ') || 'No matching role'} />
            <Row term="Permission" value={permissionLabel(result.permission).label} secondary={result.permission} />
            <Row term="Resource" value={resourceTypeLabel(submitted?.resource?.type ?? '')} />
            <Row term="Organization" value={submitted?.resource?.organizationId ? scopeName(submitted.resource.organizationId) : 'Not specified'} />
            <Row term="Scope / warehouse" value={
              (result.resolvedScopes || []).length
                ? (result.resolvedScopes as any[]).map(s => `${s.scopeType === 'warehouse' ? 'Warehouse' : 'Organization'}: ${scopeName(s.scopeValue)} ${s.matched ? '✓' : '✗'}`).join(' · ')
                : submitted?.resource?.warehouseId ? `Warehouse: ${scopeName(submitted.resource.warehouseId)}` : 'No warehouse'
            } />
            <Row term="Migration mode" value={modeLabel(result.migrationMode).label} secondary={modeLabel(result.migrationMode).help} />
            <Row term="Legacy decision" value={result.legacyDecision ?? 'Not consulted'} secondary={newAuthoritative ? 'Diagnostic only in this mode' : 'Authoritative in this mode'} />
            <Row term="New S&A decision" value={result.newDecision} secondary={newAuthoritative ? 'Authoritative in this mode' : 'Compared only in this mode'} />
            <Row term="Reason" value={reasonLabel(result.reasonCode)} secondary={!newAuthoritative && result.newReasonCode ? `New model: ${reasonLabel(result.newReasonCode)}` : undefined} />
          </dl>
          <details className="border-t p-4 text-xs text-gray-600">
            <summary className="cursor-pointer font-medium text-gray-700">Technical details</summary>
            <dl className="mt-3 grid gap-2 font-mono sm:grid-cols-2">
              <Tech term="Decision ID" value={`${result.decisionId} (explain-only, not recorded)`} />
              <Tech term="Policy version" value={result.policyVersion} />
              <Tech term="Actor ID" value={submitted?.actorId} />
              <Tech term="Organization ID" value={submitted?.resource?.organizationId} />
              <Tech term="Warehouse ID" value={submitted?.resource?.warehouseId} />
              <Tech term="Reason codes" value={[result.reasonCode, result.newReasonCode].filter(Boolean).join(' / ')} />
              <Tech term="Assignment IDs" value={(result.matchedAssignments || []).map((a: any) => a.assignmentId).join(', ')} />
              <Tech term="Resolved scopes" value={(result.resolvedScopes || []).map((s: any) => `${s.scopeType}:${s.scopeValue}:${s.matched ? 'match' : 'no-match'}`).join(', ')} />
            </dl>
          </details>
        </div>
      )}
    </section>
  )
}

function Row({ term, value, secondary }: { term: string; value: string; secondary?: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{term}</dt>
      <dd className="text-gray-900">{value}</dd>
      {secondary && <dd className="text-xs text-gray-500">{secondary}</dd>}
    </div>
  )
}

function Tech({ term, value }: { term: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="font-sans text-[11px] uppercase tracking-wide text-gray-400">{term}</dt>
      <dd className="break-all">{value || '—'}</dd>
    </div>
  )
}
