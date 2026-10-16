'use client'

import { isPartnerOrgType, orgTypeLabel } from '@/lib/security-access/directory-labels'
import { POST_CREATION_ASSIGNMENT_NOTE } from '@/lib/security-access/group-policies'
import { scopeLabels } from '@/lib/security-access/scope-labels'
import { MANUFACTURER_NO_POLICY_DETAIL, MANUFACTURER_NO_POLICY_TITLE, isManufacturerOrgType, unavailablePoliciesNote } from '@/lib/security-access/recipient-eligibility'
import { scopesForPolicy, type ProfileChoice, type SelectableProfile, type SelectableScope } from '@/lib/security-access/group-policy-picker'
import { InfoPopover, FOCUS } from '@/components/security-access/ui'
import { useMemo } from 'react'
import GroupPolicyPicker from './GroupPolicyPicker'

export { scopesForPolicy }
export type { ProfileChoice, SelectableProfile, SelectableScope }
export type AccessMode = '' | 'self' | 'profiles'

interface Props {
  disabled?: boolean
  organizationName?: string | null
  organizationTypeCode?: string | null
  /** Employee Self Service is HQ-only: its option is offered (and named) only for an HQ organization. */
  essAllowed?: boolean
  /** Link target for Group Policies; supplied only when the actor may open Security & Access. */
  groupPoliciesHref?: string | null
  profiles: SelectableProfile[]
  /** Applicable policies that cannot be assigned while creating a person (sensitive); shown as a note. */
  deferredProfiles?: Array<{ id: string; name: string }>
  /** Published policies not eligible for this organization type, with why (never selectable). */
  ineligibleProfiles?: Array<{ id: string; name: string; message: string }>
  scopes: SelectableScope[]
  /** organization id → name, so identically named scopes can be told apart (own record per organization, same-name org/warehouse). */
  orgNames?: Record<string, string>
  mode: AccessMode
  items: ProfileChoice[]
  errors?: { mode?: string; items?: string }
  /** HQ only: Employee Self Service is excluded for this (non-employee) account. Never set for a non-HQ organization. */
  essExcluded?: boolean
  onEssExcluded?: (excluded: boolean) => void
  onMode: (mode: AccessMode) => void
  onItems: (items: ProfileChoice[]) => void
}

/**
 * Add User → Group Policies: tick one or more policies (Standard / Custom checkbox hierarchy); each policy's data scope
 * is chosen explicitly (or shown when exactly one is valid). The organization and account type only filter what is
 * offered; they never grant access, and nothing is defaulted to a broad scope. The summary lists exactly what is chosen
 * here, not the person's complete effective access.
 */
export default function AccessProfileSelector({
  disabled, organizationName, organizationTypeCode, essAllowed = false, groupPoliciesHref = null, profiles, deferredProfiles = [], ineligibleProfiles = [], scopes, orgNames, mode, items, errors = {}, essExcluded = false, onEssExcluded, onMode, onItems,
}: Props) {
  const partner = isPartnerOrgType(organizationTypeCode)
  const fallbackLabels = useMemo(() => scopeLabels(scopes, new Map(Object.entries(orgNames ?? {}))), [scopes, orgNames])
  // Canonical choices carry their own label ("Serapod HQ — HQ and all its warehouses"); legacy payloads keep the generic labels.
  const labels = useMemo(() => new Map(scopes.map(s => [s.id, s.label ?? fallbackLabels.get(s.id) ?? s.display_name])), [scopes, fallbackLabels])
  const coverageOf = useMemo(() => new Map(scopes.map(s => [s.id, s.coverage ?? ''])), [scopes])
  const profileById = useMemo(() => new Map(profiles.map(p => [p.id, p])), [profiles])

  const choose = (m: AccessMode) => onMode(m)

  return <div id="user-dialog-access" tabIndex={-1} className="space-y-3 text-sm focus:outline-none">
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <h4 className="font-semibold text-gray-950">Group Policies{!essAllowed && <> <span className="text-red-500" aria-hidden>*</span></>}</h4>
      <InfoPopover label="About Group Policies">
        <p>Group Policies decide what this person can do. Tick a module Full Access policy and/or narrower groups, then give each its data scope (for example one warehouse). Nothing is assigned until you create the user.</p>
        <p>The organization and account type only filter the policies offered; they never grant access. Job title, manager status and department never grant payroll, Finance or security administration.</p>
      </InfoPopover>
      <span className="text-xs text-gray-500 max-sm:basis-full sm:ml-auto">{partner ? 'Partner account' : 'Internal staff'}{organizationName ? ` · ${organizationName}` : ''}{organizationTypeCode ? ` (${orgTypeLabel(organizationTypeCode)})` : ''}</span>
    </div>

    {essAllowed ? <div className="space-y-1.5">
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border px-3 py-2 ${essExcluded ? 'border-gray-200 bg-gray-50 text-gray-500' : 'border-orange-300 bg-orange-50 text-orange-900'}`}>
        <span aria-hidden className="text-base leading-none">{essExcluded ? '○' : '✓'}</span>
        <span className={`font-medium ${essExcluded ? 'line-through' : ''}`}>Employee Self Service</span>
        <span className="text-xs">{essExcluded ? 'Excluded for this account.' : 'Basic access for HQ staff.'}</span>
        <InfoPopover label="About Employee Self Service">
          <p>Employee Self Service is the basic HQ staff access. It covers only this person’s own eligible employee records — never HR administration, other employees’ records or organization-wide access. It is added automatically and is kept when you add Group Policies below.</p>
          <p>Being in an HQ organization does not by itself open any employee record. Employee features stay unavailable until the account is linked to a verified HR employee record; assigning Employee Self Service does not create or link one.</p>
        </InfoPopover>
      </div>
      {onEssExcluded && <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-gray-500">
        <input type="checkbox" className="accent-orange-500" disabled={disabled} checked={essExcluded} onChange={e => onEssExcluded(e.target.checked)} />
        Exclude Employee Self Service (external or technical account that is not an employee)
      </label>}
    </div> : <fieldset className="flex flex-wrap gap-2" disabled={disabled}>
      <legend className="sr-only">Group Policy choice</legend>
      {([['profiles', 'Assign Group Policies'], ['self', 'No Group Policy for now']] as const).map(([value, label]) => (
        <label key={value} className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${mode === value ? 'border-orange-400 bg-orange-50 text-orange-800' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'}`}>
          <input type="radio" name="access-mode" className="accent-orange-500" checked={mode === value} onChange={() => choose(value)} />{label}
        </label>
      ))}
    </fieldset>}
    {errors.mode && <p role="alert" className="text-xs text-red-600">{errors.mode}</p>}

    {!essAllowed && mode !== 'self' && profiles.length === 0 && <div role="note" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <p className="font-semibold">{isManufacturerOrgType(organizationTypeCode) ? MANUFACTURER_NO_POLICY_TITLE : 'No Group Policy available'}</p>
      <p>{isManufacturerOrgType(organizationTypeCode) ? MANUFACTURER_NO_POLICY_DETAIL : 'No Group Policy can be assigned here for this organization and account type.'} Choose “No Group Policy for now” to create the account without one{groupPoliciesHref ? ', or publish a suitable policy first.' : ', or ask a Security & Access administrator to publish a suitable policy.'}</p>
      {groupPoliciesHref && <a href={groupPoliciesHref} target="_blank" rel="noopener noreferrer" className={`inline-block rounded font-medium underline ${FOCUS}`}>Open Group Policies</a>}
    </div>}

    {essAllowed && profiles.length === 0 && <p role="note" className="text-xs text-gray-500">No additional Group Policy can be assigned here for this organization and account type.{groupPoliciesHref ? ' ' : ''}{groupPoliciesHref && <a href={groupPoliciesHref} target="_blank" rel="noopener noreferrer" className={`rounded font-medium underline ${FOCUS}`}>Open Group Policies</a>}</p>}
    {(essAllowed || mode === 'profiles') && profiles.length > 0 && <div className="space-y-2">
      {essAllowed && <h5 className="text-sm font-medium text-gray-900">Additional Group Policies <span className="text-xs font-normal text-gray-500">(optional)</span></h5>}
      <GroupPolicyPicker disabled={disabled} profiles={profiles} scopes={scopes} orgNames={orgNames} items={items} onItems={onItems} />
      {errors.items && <p role="alert" className="text-xs text-red-600">{errors.items}</p>}
      {deferredProfiles.length > 0 && <div className="flex items-center gap-1 text-xs text-gray-500">{deferredProfiles.length} {deferredProfiles.length === 1 ? 'policy is' : 'policies are'} not offered here
        <InfoPopover label="Policies not offered while creating a person"><p>{POST_CREATION_ASSIGNMENT_NOTE}</p><p>Not offered here: {deferredProfiles.map(d => d.name).join(', ')}.</p></InfoPopover></div>}
    </div>}

    {ineligibleProfiles.length > 0 && <div className="flex items-center gap-1 text-xs text-gray-500" data-testid="ineligible-policies">
      {unavailablePoliciesNote(ineligibleProfiles.length, organizationTypeCode)}
      <InfoPopover label="Policies not available for this organization type">
        <p>Each Group Policy lists the organization types it may be granted to. Eligibility follows the organization of the person’s membership, not yours, and is checked again when the user is created.</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">{ineligibleProfiles.map(p => <li key={p.id}><strong>{p.name}</strong> — {p.message}</li>)}</ul>
      </InfoPopover>
    </div>}

    <div role="region" aria-label="Access summary" className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700">
      <div className="flex items-center gap-1.5 font-semibold text-gray-900">Access summary
        <InfoPopover label="About the access summary"><p>Lists only what you choose here. Automatic lifecycle access and the legacy compatibility level may add access that is not listed, so this is not the person’s complete effective access.</p></InfoPopover>
      </div>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {essAllowed && <li data-testid="summary-ess">{essExcluded ? <><strong>Employee Self Service excluded</strong> — non-employee HQ account.</> : <><strong>Employee Self Service</strong> — own employee record only (basic HQ access).</>}</li>}
        {(essAllowed || mode === 'profiles') && items.map(c => <li key={`${c.roleId}:${c.scopeId}`}><strong>{profileById.get(c.roleId)?.name ?? 'Policy'}</strong> — scope: {c.scopeId ? labels.get(c.scopeId) ?? '—' : 'not chosen yet'}{coverageOf.get(c.scopeId) ? ` (covers: ${coverageOf.get(c.scopeId)})` : ''}</li>)}
        {!essAllowed && mode === 'profiles' && items.length === 0 && <li>No Group Policy selected yet.</li>}
        {essAllowed && items.length === 0 && <li>No additional Group Policy.</li>}
        {!essAllowed && mode === 'self' && <li>No Group Policy selected.</li>}
        {!essAllowed && mode === '' && <li>Not chosen yet.</li>}
      </ul>
    </div>
  </div>
}
