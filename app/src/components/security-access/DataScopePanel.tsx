'use client'

import { useMemo, useState } from 'react'
import { scopeLabels } from '@/lib/security-access/scope-labels'
import { EmptyState, SearchInput, InfoPopover, ToggleButton, ShowMore, useLimit } from './ui'

/**
 * Data Scope Definitions — reference catalogue only. Moved here from Roles &
 * Policies without changing its data, behaviour or authorization. Scope
 * selection and enforcement stay in the Group Policy assignment flows (User
 * Management, People & Access and the S&A grant form), which read the same
 * definitions and are validated server-side; this panel never widens access.
 */
export default function DataScopePanel({ scopes, organizations }: { scopes: any[]; organizations: any[] }) {
  const labels = useMemo(() => scopeLabels(scopes, new Map<string, string>(organizations.map((o: any) => [o.id, o.org_name]))), [scopes, organizations])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const q = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const map = new Map<string, any[]>()
    for (const s of scopes) {
      if (q && !`${labels.get(s.id) ?? s.display_name} ${s.scope_type}`.toLowerCase().includes(q)) continue
      map.set(s.scope_type, [...(map.get(s.scope_type) || []), s])
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [scopes, q, labels])
  const toggle = (id: string) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  return <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 p-4">
      <div className="min-w-0"><div className="flex items-center gap-2"><h2 className="font-semibold text-gray-950">Data Scope Definitions</h2>
        <InfoPopover label="About Data Scope"><p>Defines which organization, warehouse or own records the assigned access applies to. An empty scope does not mean global access.</p></InfoPopover></div></div>
      <SearchInput value={query} onChange={setQuery} placeholder="Search scopes" label="Search scopes" />
    </div>
    {groups.length === 0 && <EmptyState>{q ? `No scopes match “${query.trim()}”.` : 'No scopes defined.'}</EmptyState>}
    <ul className="divide-y divide-gray-100 text-sm">{groups.map(([type, list]) => {
      const isOpen = q ? true : open.has(type)
      return <li key={type}>
        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50/70">
          <ToggleButton open={isOpen} onClick={() => toggle(type)} label={`${type.replace(/_/g, ' ')} scopes, ${list.length}`}>
            <span className="font-semibold capitalize text-gray-900">{type.replace(/_/g, ' ')}</span>
          </ToggleButton>
          <span className="text-xs text-gray-500">{list.length}</span>
        </div>
        {isOpen && <ScopeList list={list} labels={labels} />}
      </li>
    })}</ul>
  </section>
}

function ScopeList({ list, labels }: { list: any[]; labels: Map<string, string> }) {
  const page = useLimit(25)
  return <>
    <ul className="divide-y divide-gray-50">{list.slice(0, page.limit).map(s =>
      <li key={s.id} className="py-1.5 pl-10 pr-4 text-sm text-gray-800">{labels.get(s.id) ?? s.display_name}</li>)}</ul>
    <ShowMore shown={Math.min(page.limit, list.length)} total={list.length} onMore={page.more} />
  </>
}