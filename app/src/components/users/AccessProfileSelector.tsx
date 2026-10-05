'use client'

import { Plus, X } from 'lucide-react'
import { isPartnerOrgType, orgTypeLabel } from '@/lib/security-access/directory-labels'

export interface SelectableProfile { id: string; name: string; description?: string | null; permissionCount?: number }
export interface SelectableScope { id: string; organization_id: string | null; scope_type: string; display_name: string }
export interface ProfileChoice { roleId: string; scopeId: string }
export type AccessMode = '' | 'self' | 'profiles'

interface Props {
  disabled?: boolean
  organizationName?: string | null
  organizationTypeCode?: string | null
  profiles: SelectableProfile[]
  scopes: SelectableScope[]
  mode: AccessMode
  items: ProfileChoice[]
  reason: string
  /** "Level 20 — Manager": the legacy compatibility level chosen above. */
  legacyLevelLabel?: string | null
  legacyReadOnly: boolean
  errors?: { mode?: string; items?: string; reason?: string }
  onMode: (mode: AccessMode) => void
  onItems: (items: ProfileChoice[]) => void
  onReason: (reason: string) => void
}

/**
 * Add User → Role & Access: choose one or more Access Profiles, each with its
 * OWN explicit data scope, and review the resulting access. The organization
 * and account type only filter which profiles are offered; they never grant
 * access, and nothing is defaulted to a broad scope. Job title, manager status
 * and department never imply payroll, Finance or security administration.
 */
export default function AccessProfileSelector({
  disabled, organizationName, organizationTypeCode, profiles, scopes, mode, items, reason, legacyLevelLabel, legacyReadOnly, errors = {}, onMode, onItems, onReason,
}: Props) {
  const partner = isPartnerOrgType(organizationTypeCode)
  const accountLabel = partner ? 'Partner account' : 'Internal staff'
  const profileById = new Map(profiles.map(p => [p.id, p]))
  const scopeById = new Map(scopes.map(s => [s.id, s]))
  const used = new Set(items.map(i => i.roleId).filter(Boolean))
  const canAdd = items.length < 10 && profiles.some(p => !used.has(p.id))
  const update = (index: number, patch: Partial<ProfileChoice>) => onItems(items.map((it, i) => (i === index ? { ...it, ...patch } : it)))
  const chosen = items.filter(i => i.roleId && i.scopeId)

  return <div className="space-y-3 rounded-lg border border-[var(--sera-line)] p-4">
    <div>
      <div className="text-sm font-medium">Business access <span className="text-red-500">*</span></div>
      <p className="text-xs text-[var(--sera-muted)]">
        Access Profiles decide what this person can do. Each profile is given its own data scope (for example one warehouse). The account type and organization only filter the profiles offered; they never grant access.
      </p>
    </div>
    <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
      <div><dt className="inline text-[var(--sera-muted)]">Account type: </dt><dd className="inline font-medium">{accountLabel}</dd></div>
      <div><dt className="inline text-[var(--sera-muted)]">Organization: </dt><dd className="inline font-medium">{organizationName || '—'}{organizationTypeCode ? ` (${orgTypeLabel(organizationTypeCode)})` : ''}</dd></div>
    </dl>

    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="sr-only">Business access choice</legend>
      <label className="flex items-start gap-2 text-sm"><input type="radio" name="access-mode" className="mt-1" checked={mode === 'self'} onChange={() => onMode('self')} />
        <span>Employee self-service only<span className="block text-xs text-[var(--sera-muted)]">No Access Profile. Partner accounts do not get HR employee or self-service access from this choice.</span></span></label>
      <label className="flex items-start gap-2 text-sm"><input type="radio" name="access-mode" className="mt-1" checked={mode === 'profiles'} onChange={() => { onMode('profiles'); if (items.length === 0) onItems([{ roleId: '', scopeId: '' }]) }} />
        <span>Assign Access Profiles<span className="block text-xs text-[var(--sera-muted)]">Choose one or more profiles; each needs its own scope.</span></span></label>
    </fieldset>
    {errors.mode && <p role="alert" className="text-xs text-red-600">{errors.mode}</p>}

    {mode === 'profiles' && <div className="space-y-2">
      {profiles.length === 0 && <p role="note" className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">No Access Profile applies to this organization and account type. Choose employee self-service only, or ask an administrator to publish a suitable profile.</p>}
      {items.map((item, index) => {
        const taken = new Set(items.filter((_, i) => i !== index).map(i => i.roleId))
        return <div key={index} className="grid gap-2 rounded-md border border-[var(--sera-line)] p-2 sm:grid-cols-[1fr_1fr_auto]">
          <label className="text-xs"><span className="text-[var(--sera-muted)]">Access Profile</span>
            <select aria-label={`Access Profile ${index + 1}`} value={item.roleId} onChange={e => update(index, { roleId: e.target.value })} disabled={disabled}
              className="mt-1 w-full rounded-md border border-[var(--sera-line)] bg-white px-2 py-2 text-sm">
              <option value="">Choose a profile</option>
              {profiles.filter(p => !taken.has(p.id)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
          <label className="text-xs"><span className="text-[var(--sera-muted)]">Data scope for this profile</span>
            <select aria-label={`Scope for profile ${index + 1}`} value={item.scopeId} onChange={e => update(index, { scopeId: e.target.value })} disabled={disabled || !scopes.length}
              className="mt-1 w-full rounded-md border border-[var(--sera-line)] bg-white px-2 py-2 text-sm">
              <option value="">{scopes.length ? 'Choose a scope' : 'No scope defined for this organization'}</option>
              {scopes.map(s => <option key={s.id} value={s.id}>{s.display_name} ({s.scope_type.replace(/_/g, ' ')})</option>)}
            </select></label>
          <button type="button" aria-label={`Remove profile ${index + 1}`} onClick={() => onItems(items.filter((_, i) => i !== index))} disabled={disabled}
            className="self-end rounded-md p-2 text-[var(--sera-muted)] hover:bg-red-50 hover:text-red-700"><X className="h-4 w-4" aria-hidden /></button>
          {item.roleId && profileById.get(item.roleId)?.description && <p className="text-xs text-[var(--sera-muted)] sm:col-span-3">{profileById.get(item.roleId)!.description}</p>}
        </div>
      })}
      <button type="button" onClick={() => onItems([...items, { roleId: '', scopeId: '' }])} disabled={disabled || !canAdd}
        className="inline-flex items-center gap-1 rounded-md border border-[var(--sera-line)] px-2 py-1 text-xs font-medium disabled:opacity-40"><Plus className="h-3 w-3" aria-hidden />Add another profile</button>
      {errors.items && <p role="alert" className="text-xs text-red-600">{errors.items}</p>}
      <label className="block text-xs"><span className="text-[var(--sera-muted)]">Reason (recorded in the access audit)</span>
        <input value={reason} onChange={e => onReason(e.target.value)} disabled={disabled} placeholder="Why does this person need this access?"
          className="mt-1 w-full rounded-md border border-[var(--sera-line)] px-2 py-2 text-sm" /></label>
      {errors.reason && <p role="alert" className="text-xs text-red-600">{errors.reason}</p>}
    </div>}

    <div role="region" aria-label="Review of resulting access" className="rounded-md bg-[var(--sera-orange)]/[0.05] p-3 text-xs">
      <div className="font-semibold">Review of resulting access</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {mode === 'profiles' && chosen.map((c, i) => <li key={i}><strong>{profileById.get(c.roleId)?.name ?? 'Profile'}</strong> — scope: {scopeById.get(c.scopeId)?.display_name ?? '—'}</li>)}
        {mode === 'profiles' && chosen.length === 0 && <li>No Access Profile selected yet.</li>}
        {mode === 'self' && <li>No Access Profile.</li>}
        <li>{partner ? 'Partner accounts are not enrolled into HR or employee self-service.' : 'Employee self-service baseline: added automatically by the lifecycle (own record only).'}</li>
        <li>Legacy compatibility level{legacyLevelLabel ? ` (${legacyLevelLabel})` : ''}: {legacyReadOnly ? 'compatibility only; it does not grant access by itself.' : 'still decides access for features not yet moved to Security & Access, in addition to the profiles above.'}</li>
        <li>Job title, manager status and department never grant payroll, Finance or security administration.</li>
      </ul>
    </div>
  </div>
}
