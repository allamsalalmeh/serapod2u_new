'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { BarChart3, Briefcase, HeartHandshake, HelpCircle, Landmark, Settings, ShieldCheck, Truck } from 'lucide-react'
import { filterRollout, rolloutMode, type Rollout, type RolloutNode, type RolloutPermission } from '@/lib/security-access/rollout'
import { FOCUS, InfoPopover, ModeStatus, SearchInput, ToggleButton } from './ui'

const GROUP_ICONS: Record<string, any> = {
  supply_chain: Truck, customer_growth: HeartHandshake, hr_payroll: Briefcase,
  finance: Landmark, security_access: ShieldCheck, platform_settings: Settings, reporting: BarChart3,
}

interface Props {
  rollout: Rollout
  title: string
  description?: string
  /** Short explanation shown behind the small ⓘ next to the title. */
  info?: React.ReactNode
  /** Show a count column per authorization mode (and the mode legend). */
  showModes?: boolean
  /** Extra facts / actions shown on a permission row (no separate column). */
  renderDetails?: (p: RolloutPermission) => React.ReactNode
  /** Extra line under the permission name (e.g. its description). */
  renderSubtitle?: (p: RolloutPermission) => React.ReactNode
  /** Action beside a module / subgroup name (outside its expand toggle, so it never opens or closes the row). */
  renderGroupActions?: (node: RolloutNode) => React.ReactNode
  initialQuery?: string
  searchPlaceholder?: string
  emptyText?: string
}

/**
 * Main group → Subgroup → Permission table, collapsed by default. Search
 * opens the ancestors of matches and restores the previous expansion when it
 * is cleared. One chevron-and-name button per row; collapsed rows are not
 * rendered, so nothing hidden can receive focus.
 */
export default function PermissionTree({
  rollout, title, description, info, showModes = true, renderDetails, renderSubtitle, renderGroupActions, initialQuery = '',
  searchPlaceholder = 'Search modules', emptyText = 'No permissions are registered in this environment yet.',
}: Props) {
  const [query, setQuery] = useState(initialQuery)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [searchOpen, setSearchOpen] = useState<Set<string>>(new Set())
  const filtered = useMemo(() => filterRollout(rollout, query), [rollout, query])
  useEffect(() => { setSearchOpen(new Set(filtered.autoOpen)) }, [filtered])
  const searching = query.trim().length > 0
  const view = filtered.rollout
  const expanded = searching ? searchOpen : open
  const columns = showModes ? view.columns : []
  const span = columns.length + 1

  const toggle = (id: string) => (searching ? setSearchOpen : setOpen)(prev => {
    const next = new Set(prev)
    if (next.has(id)) {
      for (const key of Array.from(next)) if (key === id || key.startsWith(`${id}/`)) next.delete(key)
    } else next.add(id)
    return next
  })
  const collapseAll = () => (searching ? setSearchOpen : setOpen)(new Set())

  const countCells = (node: RolloutNode, strong?: boolean) => columns.map(mode => (
    <td key={mode} className={`px-3 py-1.5 text-right tabular-nums ${node.counts[mode] ? `${strong ? 'font-semibold' : 'font-medium'} ${rolloutMode(mode).text}` : 'text-gray-300'}`}>
      {node.counts[mode] ?? 0}
    </td>
  ))

  const permissionRow = (p: RolloutPermission, indent: string) => (
    <tr key={p.key} className="border-t border-gray-50">
      <th scope="row" className={`py-1.5 pr-4 text-left font-normal ${indent}`}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <div className="text-sm text-gray-900">{p.label}</div>
            {renderSubtitle?.(p)}
            <code className="text-[11px] text-gray-400">{p.key}</code>
          </div>
          {renderDetails && <div className="text-xs">{renderDetails(p)}</div>}
        </div>
      </th>
      {columns.map(mode => (
        <td key={mode} className="px-3 py-1.5 text-right align-top">
          {p.mode === mode ? <ModeStatus mode={mode} short /> : <span className="sr-only">no</span>}
        </td>
      ))}
    </tr>
  )

  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm" aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><h2 className="font-semibold text-gray-950">{title}</h2>
            {info && <InfoPopover label={`About ${title}`}>{info}</InfoPopover>}</div>
          {description && <p className="text-sm text-gray-500">{description}</p>}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <SearchInput value={query} onChange={setQuery} placeholder={searchPlaceholder} label="Search modules or permissions" />
          <button type="button" onClick={collapseAll} disabled={expanded.size === 0}
            className={`shrink-0 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:cursor-default disabled:opacity-40 ${FOCUS}`}>
            Collapse all
          </button>
        </div>
      </div>

      {showModes && (
        <details className="group border-b border-gray-100 bg-gray-50/50 text-xs text-gray-500">
          <summary className={`cursor-pointer select-none px-4 py-1.5 font-medium text-gray-600 hover:text-gray-900 ${FOCUS}`}>About access modes</summary>
          <dl className="grid gap-x-6 gap-y-1.5 px-4 pb-2.5 sm:grid-cols-2">
            {view.columns.map(mode => (
              <div key={mode} className="flex items-baseline gap-1.5">
                <dt className="shrink-0 whitespace-nowrap"><ModeStatus mode={mode} /></dt>
                <dd>{rolloutMode(mode).help}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {searching && view.total > 0 && (
        <p className="border-b border-gray-100 bg-orange-50/40 px-4 py-1.5 text-xs text-gray-600" role="status">
          Showing {view.total} of {rollout.total} permissions matching “{query.trim()}”. Counts reflect the filtered results.
        </p>
      )}

      {rollout.total === 0 ? (
        <p className="p-6 text-center text-sm text-gray-500">{emptyText}</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className={`w-full text-sm ${showModes ? 'min-w-[640px]' : 'min-w-[480px]'}`}>
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs font-medium text-gray-500">
                <th scope="col" className="px-4 py-2">Module</th>
                {columns.map(mode => (
                  <th key={mode} scope="col" className="w-28 px-3 py-2 text-right"><ModeStatus mode={mode} /></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.groups.length === 0 && (
                <tr><td colSpan={span} className="px-4 py-6 text-center text-sm text-gray-500">No modules or permissions match “{query.trim()}”.</td></tr>
              )}
              {view.groups.map(g => {
                const Icon = GROUP_ICONS[g.id] ?? HelpCircle
                const gOpen = expanded.has(g.id)
                return (
                  <Fragment key={g.id}>
                    <tr className="border-t border-gray-100 bg-gray-50/70">
                      <th scope="row" className="px-4 py-2 text-left">
                        <div className="flex items-center justify-between gap-3">
                          <ToggleButton open={gOpen} onClick={() => toggle(g.id)} label={`${g.name}, ${g.total} permission${g.total === 1 ? '' : 's'}`}>
                            <Icon className="h-4 w-4 shrink-0 text-gray-500" aria-hidden />
                            <span className="font-semibold text-gray-900">{g.name}</span>
                            <span className="text-xs font-normal text-gray-400">{g.total} permission{g.total === 1 ? '' : 's'}</span>
                          </ToggleButton>
                          {renderGroupActions?.(g)}
                        </div>
                      </th>
                      {countCells(g, true)}
                    </tr>
                    {gOpen && g.children.map(c => {
                      const cOpen = expanded.has(c.id)
                      return (
                        <Fragment key={c.id}>
                          <tr className="border-t border-gray-100">
                            <th scope="row" className="py-1.5 pl-10 pr-4 text-left">
                              <div className="flex items-center justify-between gap-3">
                                <ToggleButton open={cOpen} onClick={() => toggle(c.id)} label={`${g.name}: ${c.name}, ${c.total} permission${c.total === 1 ? '' : 's'}`}>
                                  <span className="font-medium text-gray-800">{c.name}</span>
                                  <span className="text-xs font-normal text-gray-400">{c.total}</span>
                                </ToggleButton>
                                {renderGroupActions?.(c)}
                              </div>
                            </th>
                            {countCells(c)}
                          </tr>
                          {cOpen && c.permissions.map(p => permissionRow(p, 'pl-[5.5rem]'))}
                        </Fragment>
                      )
                    })}
                    {gOpen && g.permissions.map(p => permissionRow(p, 'pl-16'))}
                  </Fragment>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-200 font-semibold text-gray-900">
                <th scope="row" className="px-4 py-2 text-left">
                  {searching ? 'Filtered total' : 'Total'} <span className="text-xs font-normal text-gray-400">{view.total} permission{view.total === 1 ? '' : 's'}</span>
                </th>
                {columns.map(mode => (
                  <td key={mode} className="px-3 py-2 text-right tabular-nums">{view.totals[mode] ?? 0}</td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}
