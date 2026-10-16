'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { groupByTaxonomy } from '@/lib/security-access/modules'
import { POST_CREATION_ASSIGNMENT_NOTE } from '@/lib/security-access/group-policies'
import { scopeLabels } from '@/lib/security-access/scope-labels'
import { SCOPE_HELP, WAREHOUSE_PARTIAL_DETAIL, choiceAllowedForPolicy, warehousePartialNote, warehouseUnsupportedMessage } from '@/lib/security-access/scope-eligibility'
import {
  autoSelectSoleScopes, buildCatalogue, coveredByFullAccess, fullAccessLabel, fullAccessModuleOf, scopeGroups, scopesOf, selectedPolicyIds, setScopeFor, togglePolicy,
  type CatalogueModule, type ProfileChoice, type SelectableProfile, type SelectableScope,
} from '@/lib/security-access/group-policy-picker'
import { FOCUS, InfoPopover, SearchInput, ToggleButton, onTabKeyDown } from '@/components/security-access/ui'

interface Props {
  disabled?: boolean
  profiles: SelectableProfile[]
  scopes: SelectableScope[]
  orgNames?: Record<string, string>
  items: ProfileChoice[]
  onItems: (items: ProfileChoice[]) => void
  error?: string
}

type Tab = 'standard' | 'custom'

const matches = (p: SelectableProfile, q: string) => !q || p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q)

/**
 * Add User → Group Policies: a compact module accordion (Standard / Custom). Arrow on the left expands, checkbox on the right
 * selects; the two are independent, and collapsing never clears a selection. A tick updates the pending selection directly;
 * the grants are only created by the final user-creation submit. A module's Full Access checkbox selects that ONE policy; its
 * included permissions are read-only. Search only narrows what is shown, never what is selected.
 */
export default function GroupPolicyPicker({ disabled, profiles, scopes, orgNames, items, onItems, error }: Props) {
  const ctx = useMemo(() => ({ profiles, scopes }), [profiles, scopes])
  const catalogue = useMemo(() => buildCatalogue(profiles), [profiles])
  const profileById = useMemo(() => new Map(profiles.map(p => [p.id, p])), [profiles])
  const fallbackLabels = useMemo(() => scopeLabels(scopes, new Map(Object.entries(orgNames ?? {}))), [scopes, orgNames])
  const labelOf = (s: SelectableScope) => s.label ?? fallbackLabels.get(s.id) ?? s.display_name
  const [tab, setTab] = useState<Tab>('standard')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const uid = useId()
  const q = query.trim().toLowerCase()
  const selected = useMemo(() => new Set(selectedPolicyIds(items)), [items])
  const groups = useMemo(() => scopeGroups(ctx, items), [ctx, items])

  // The only valid scope is applied and shown (never guessed when there is more than one, or none).
  useEffect(() => {
    const next = autoSelectSoleScopes(ctx, items)
    if (next !== items) onItems(next)
  }, [ctx, items, onItems])

  const tick = (id: string, on: boolean) => {
    const change = togglePolicy(ctx, items, id, on)
    setNotice(change.notice)
    if (change.items !== items) onItems(change.items)
  }
  const toggleScope = (policyIds: string[], scopeId: string, on: boolean) => {
    const change = setScopeFor(items, policyIds, scopeId, on)
    setNotice(change.notice)
    if (change.items !== items) onItems(change.items)
  }
  const isOpen = (key: string, fallback = false) => open[key] ?? fallback
  const flip = (key: string, fallback = false) => setOpen(prev => ({ ...prev, [key]: !(prev[key] ?? fallback) }))

  const countIn = (modules: CatalogueModule[]) => modules.reduce((n, m) => n + [m.fullAccess, ...m.policies].filter(p => p && selected.has(p.id)).length, 0)
  const tabs: Array<{ id: Tab; label: string; modules: CatalogueModule[] }> = [
    { id: 'standard', label: 'Standard', modules: catalogue.standard },
    { id: 'custom', label: 'Custom', modules: catalogue.custom },
  ]
  const active = tabs.find(t => t.id === tab)!
  // Selected policies the search currently hides (the search never changes the selection).
  const hiddenSelected = q ? Array.from(selected).filter(id => {
    const p = profileById.get(id)
    const faModule = p ? fullAccessModuleOf(p) : null
    return !!p && !matches(p, q) && !(faModule && fullAccessLabel(faModule).toLowerCase().includes(q))
  }).length : 0

  const checkbox = (id: string, label: string, policyId: string) =>
    <input id={id} type="checkbox" aria-label={label} checked={selected.has(policyId)} disabled={disabled} onChange={e => tick(policyId, e.target.checked)} value={policyId}
      className={`h-4 w-4 shrink-0 rounded border-gray-300 accent-orange-500 ${FOCUS}`} />

  // A narrower policy: name on the left, selection checkbox on the right.
  const policyRow = (p: SelectableProfile, faCover?: SelectableProfile | null) => {
    const id = `${uid}-p-${p.id}`
    return <li key={p.id} className="flex items-center gap-2 py-1.5 pl-9 pr-3">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm text-gray-900">{p.name}
        {faCover && coveredByFullAccess(faCover, p) && <span className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">Included in Full Access</span>}
      </label>
      {p.description && <InfoPopover label={`About ${p.name}`}><p>{p.description}</p></InfoPopover>}
      {checkbox(id, p.name, p.id)}
    </li>
  }

  // What a Full Access policy contains: read-only, nothing here is assigned separately.
  const includedPermissions = (p: SelectableProfile) => {
    const areas = groupByTaxonomy(p.permissionKeys ?? [], k => k).flatMap(g => g.areas)
    return <div className="space-y-0.5 py-1 pl-9 pr-3 text-xs text-gray-700">
      <div className="flex items-center gap-1 font-medium text-gray-600">Included permissions (read-only)
        <InfoPopover label={`About ${p.name} contents`}><p>What this policy contains. Nothing here is assigned separately; selecting the module’s Full Access box selects this one policy.</p></InfoPopover>
      </div>
      {areas.length === 0 && <p className="text-gray-500">The permission list is not available.</p>}
      {areas.map(a => {
        const key = `area:${p.id}:${a.id}`
        return <div key={a.id}>
          <ToggleButton open={isOpen(key)} onClick={() => flip(key)} label={`${a.name}, ${a.items.length} permissions`} controls={`${uid}-a-${p.id}-${a.id}`}>
            <span className="font-medium">{a.name}</span><span className="text-gray-500">{a.items.length}</span>
          </ToggleButton>
          {isOpen(key) && <ul id={`${uid}-a-${p.id}-${a.id}`} aria-label={`${a.name} permissions`} className="ml-6 list-disc space-y-0.5 pl-4 text-gray-600">
            {a.items.map(k => <li key={k}>{k}</li>)}
          </ul>}
        </div>
      })}
    </div>
  }

  const moduleBlock = (m: CatalogueModule, standard: boolean) => {
    const moduleMatch = !q || m.name.toLowerCase().includes(q)
    const shownPolicies = moduleMatch ? m.policies : m.policies.filter(p => matches(p, q))
    const fa = standard ? m.fullAccess : null
    const faShown = !!fa && (moduleMatch || matches(fa, q) || fullAccessLabel(m.id).toLowerCase().includes(q))
    if (!faShown && shownPolicies.length === 0) return null
    const pickedHere = m.policies.filter(p => selected.has(p.id)).length
    const faPicked = !!fa && selected.has(fa.id)
    const bodyId = `${uid}-m-${m.id}`
    const specificKey = `specific:${m.id}`
    // Searching reveals the matching modules; otherwise a module is open only when the user opened it.
    const expanded = !!q || isOpen(`module:${m.id}`)
    const specificOpen = !!q || isOpen(specificKey, pickedHere > 0)
    const faLabel = fullAccessLabel(m.id)
    const total = shownPolicies.length
    const sub = faShown
      ? `Full Access${total ? ` · ${total} specific group${total === 1 ? '' : 's'}` : ''}`
      : `${total} group${total === 1 ? '' : 's'}`
    return <section key={m.id} aria-label={m.name}>
      <div className="flex items-center gap-2 bg-gray-50/70 px-3 py-2">
        <ToggleButton open={expanded} onClick={() => flip(`module:${m.id}`)} label={m.name} controls={bodyId} className="flex-1 py-0.5">
          <span className="text-sm font-semibold text-gray-900">{m.name}</span>
          <span className="truncate text-xs text-gray-500">{sub}</span>
        </ToggleButton>
        {pickedHere > 0 && <span className="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-800">{pickedHere} selected</span>}
        {faShown
          ? <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-gray-600"><span className="max-sm:sr-only">Full Access</span>{checkbox(`${uid}-fa-${fa!.id}`, faLabel, fa!.id)}</label>
          : <span className="shrink-0 text-xs text-gray-600">Choose groups</span>}
      </div>
      {expanded && <div id={bodyId}>
        {faShown && includedPermissions(fa!)}
        {total > 0 && (faShown ? <div className="pl-9 pr-3 py-1">
          <ToggleButton open={specificOpen} onClick={() => flip(specificKey, pickedHere > 0)} label="Choose specific groups instead" controls={`${uid}-s-${m.id}`}>
            <span className="text-sm text-gray-700">Choose specific groups instead</span>
            <span className="text-xs text-gray-500">{pickedHere ? `${pickedHere} selected` : total}</span>
          </ToggleButton>
          {faPicked && !specificOpen && <p className="mt-0.5 pl-6 text-xs text-gray-500">Full Access is selected; choosing a specific group replaces it.</p>}
          {specificOpen && <ul id={`${uid}-s-${m.id}`} aria-label={`Specific groups in ${m.name}`} className="-ml-9 mt-1">{shownPolicies.map(p => policyRow(p, fa))}</ul>}
        </div> : <ul aria-label={`${m.name} Group Policies`} className="divide-y divide-gray-50">{shownPolicies.map(p => policyRow(p, null))}</ul>)}
      </div>}
    </section>
  }

  const blocks = active.modules.map(m => moduleBlock(m, tab === 'standard')).filter(Boolean)
  const selectedCount = selected.size

  return <div className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <div role="tablist" aria-label="Group Policy type" onKeyDown={onTabKeyDown} className="flex gap-1 rounded-lg border border-gray-200 bg-white p-1">
        {tabs.map(t => {
          const on = t.id === tab
          const n = countIn(t.modules)
          return <button key={t.id} type="button" role="tab" id={`${uid}-tab-${t.id}`} aria-selected={on} aria-controls={`${uid}-panel`} tabIndex={on ? 0 : -1} onClick={() => setTab(t.id)}
            className={`whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium ${on ? 'bg-orange-50 text-orange-700' : 'text-gray-600 hover:bg-gray-50'} ${FOCUS}`}>
            {t.label}{n > 0 && <span className="ml-1.5 rounded-full bg-orange-100 px-1.5 text-xs text-orange-800" aria-label={`, ${n} selected`}>{n}</span>}
          </button>
        })}
      </div>
      <InfoPopover label="Which Group Policies are listed">
        <p>Only published Group Policies you may assign to this organization and account type are listed. Ticking a module’s Full Access box selects that one policy only, not its narrower groups.</p>
        <p>Employee Self Service is for HQ users only, and a Manufacturer is offered only the Manufacturing policies designated for it.</p>
        <p>{POST_CREATION_ASSIGNMENT_NOTE}</p>
      </InfoPopover>
      <SearchInput value={query} onChange={setQuery} placeholder="Search Group Policies…" label="Search Group Policies" className="max-sm:basis-full sm:ml-auto sm:w-56" />
    </div>

    <div role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${tab}`} className="max-h-96 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200 bg-white">
      {blocks.length ? blocks : <p className="px-3 py-3 text-xs text-gray-500">{q ? 'No matching Group Policy.' : tab === 'standard' ? 'No standard Group Policy is available for this organization.' : 'No custom Group Policy is available for this organization.'}</p>}
    </div>
    {hiddenSelected > 0 && <p role="note" className="text-xs text-gray-600">{hiddenSelected} selected {hiddenSelected === 1 ? 'policy is' : 'policies are'} hidden by this search and still selected.</p>}
    <div aria-live="polite">{notice && <p role="status" className="rounded-md bg-orange-50 px-2 py-1.5 text-xs text-orange-900">{notice}</p>}</div>

    {selectedCount > 0 && <div className="space-y-1">
      <p className="text-xs font-medium text-gray-700">{selectedCount} Group {selectedCount === 1 ? 'Policy' : 'Policies'} selected</p>
      <ul aria-label="Selected Group Policies" className="flex flex-wrap gap-1.5">
        {Array.from(selected).map(id => {
          const p = profileById.get(id)
          const name = p ? (fullAccessModuleOf(p) ? fullAccessLabel(fullAccessModuleOf(p)!) : p.name) : 'Policy'
          return <li key={id} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white py-0.5 pl-2.5 pr-1 text-xs text-gray-900">
            <span className="font-medium">{name}</span>
            <button type="button" aria-label={`Remove ${p?.name ?? 'policy'}`} disabled={disabled} onClick={() => tick(id, false)}
              className={`rounded-full p-0.5 text-gray-500 hover:bg-red-50 hover:text-red-700 ${FOCUS}`}><X className="h-3 w-3" aria-hidden /></button>
          </li>
        })}
      </ul>
    </div>}

    {groups.map(g => {
      const names = g.policyIds.map(id => profileById.get(id)?.name ?? 'Policy')
      const heading = `Data scope for ${names.join(', ')}`
      const partial = g.policyIds.map(id => profileById.get(id)).find(p => p?.warehouseSupport?.level === 'partial')
      const hidden = g.policyIds.some(id => { const p = profileById.get(id); return !!p && scopes.some(s => !!s.kind && !choiceAllowedForPolicy({ kind: s.kind }, p.warehouseSupport)) })
      return <div key={g.key} role="group" aria-label={heading} className="space-y-1 rounded-lg border border-orange-200 bg-orange-50/40 px-3 py-2 text-xs">
        <div className="flex items-center gap-1 text-gray-700"><span>{heading}</span> <span className="text-red-500" aria-hidden>*</span>
          <InfoPopover label="About scopes">{SCOPE_HELP.map(t => <p key={t}>{t}</p>)}{partial && <p>{warehousePartialNote(partial.warehouseSupport!)} {WAREHOUSE_PARTIAL_DETAIL}</p>}{hidden && <p>{warehouseUnsupportedMessage}</p>}</InfoPopover></div>
        {g.options.length === 0 && <p role="alert" className="text-red-700">No data scope is available for {names.join(', ')}. Untick {g.policyIds.length === 1 ? 'it' : 'them'} or choose a different organization.</p>}
        {g.options.length === 1 && <p role="note" className="text-gray-800">Scope: <span className="font-medium">{labelOf(g.options[0])}</span>{g.options[0].coverage ? ` · Covers: ${g.options[0].coverage}` : ''} <span className="text-gray-500">(only option, selected)</span></p>}
        {g.options.length > 1 && <ul className="space-y-0.5">
          {g.options.map(s => {
            const cid = `${uid}-s-${g.key}-${s.id}`
            const on = g.policyIds.every(id => scopesOf(items, id).includes(s.id))
            return <li key={s.id} className="flex flex-wrap items-center gap-x-2">
              <input id={cid} type="checkbox" checked={on} disabled={disabled} onChange={e => toggleScope(g.policyIds, s.id, e.target.checked)}
                className={`h-4 w-4 rounded border-gray-300 accent-orange-500 ${FOCUS}`} />
              <label htmlFor={cid} className="cursor-pointer text-sm text-gray-800">{labelOf(s)}</label>
            </li>
          })}
        </ul>}
        {partial && g.policyIds.some(id => scopesOf(items, id).some(sid => scopes.find(x => x.id === sid)?.kind === 'warehouse')) && <p role="note" className="text-gray-600">{warehousePartialNote(partial.warehouseSupport!)}</p>}
      </div>
    })}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </div>
}
