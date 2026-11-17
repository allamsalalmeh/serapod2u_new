'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Edit, Loader2, Plus, RefreshCw, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  allGroupKeys,
  buildCoaTree,
  filterCoaTree,
  formatCoaBalance,
  type CoaAccount,
  type CoaNode,
} from '@/lib/accounting/coa-tree'

interface ChartOfAccountsTreeProps {
  companyName?: string | null
  canManage: boolean
  /** Bumped by the parent after an account is saved, to reload. */
  reloadKey?: number
  onEdit: (accountId: string) => void
  /** Add an account under a group: a real parent account, or a type / subtype group. */
  onAddChild: (preset: { account_type: string; subtype: string | null; parent_account_id: string | null }) => void
}

export default function ChartOfAccountsTree({ companyName, canManage, reloadKey, onEdit, onAddChild }: ChartOfAccountsTreeProps) {
  const [accounts, setAccounts] = useState<CoaAccount[]>([])
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showDisabled, setShowDisabled] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/accounting/accounts/tree')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load accounts')
      setAccounts(data.accounts || [])
      setBalances(data.balances || {})
    } catch (e: any) {
      setError(e?.message || 'Failed to load accounts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, reloadKey])

  const tree = useMemo(() => buildCoaTree(accounts, balances, showDisabled), [accounts, balances, showDisabled])
  const filtered = useMemo(() => filterCoaTree(tree, query), [tree, query])

  // First load: open the type roots (like the reference screen).
  useEffect(() => {
    if (tree.length > 0 && expanded.size === 0) setExpanded(new Set(tree.map((r) => r.key)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree])

  const isOpen = (key: string) => expanded.has(key) || filtered.expand.has(key)
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const allKeys = useMemo(() => allGroupKeys(tree), [tree])
  const allOpen = allKeys.length > 0 && allKeys.every((k) => expanded.has(k))

  const renderNode = (node: CoaNode): ReactNode => {
    const hasChildren = node.children.length > 0
    const open = hasChildren && isOpen(node.key)
    return (
      <li key={node.key} className="relative">
        <div
          className={`group flex items-center gap-2 rounded-md py-1.5 pl-1 pr-2 hover:bg-gray-50 ${!node.isActive ? 'opacity-50' : ''}`}
        >
          <button
            type="button"
            className={`flex h-5 w-5 shrink-0 items-center justify-center text-gray-500 ${hasChildren ? '' : 'invisible'}`}
            onClick={() => toggle(node.key)}
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          <button
            type="button"
            className={`min-w-0 truncate text-left text-sm ${node.isGroup ? 'font-medium' : ''}`}
            onClick={() => (hasChildren ? toggle(node.key) : node.account && canManage && onEdit(node.account.id))}
          >
            {node.name}
          </button>
          {node.codeLabel && (
            <Badge variant="secondary" className="shrink-0 font-mono text-xs font-normal">{node.codeLabel}</Badge>
          )}
          {!node.isActive && <span className="shrink-0 text-xs text-gray-500">(disabled)</span>}
          {canManage && (
            <span className="ml-1 hidden shrink-0 gap-1 group-hover:flex">
              {node.isGroup && (
                <button
                  type="button"
                  title="Add account under this group"
                  className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-800"
                  onClick={() => onAddChild({
                    account_type: node.accountType,
                    subtype: node.account ? node.account.subtype : node.subtype,
                    parent_account_id: node.account ? node.account.id : null,
                  })}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
              {node.account && (
                <button
                  type="button"
                  title="Edit account"
                  className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-800"
                  onClick={() => onEdit(node.account!.id)}
                >
                  <Edit className="h-3.5 w-3.5" />
                </button>
              )}
            </span>
          )}
          <span className="ml-auto shrink-0 pl-4 font-mono text-sm tabular-nums text-gray-700">
            {formatCoaBalance(node.balance)}
          </span>
        </div>
        {open && (
          <ul className="ml-[13px] border-l border-gray-200 pl-3">
            {node.children.map((c) => renderNode(c))}
          </ul>
        )}
      </li>
    )
  }

  const total = tree.reduce((s, r) => s + r.balance, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <Input
            placeholder="Search by code or name..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-10"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={showDisabled} onCheckedChange={(v) => setShowDisabled(v === true)} />
          Show all (including disabled)
        </label>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExpanded(allOpen ? new Set(tree.map((r) => r.key)) : new Set(allKeys))}
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </Button>
          <Button variant="outline" size="sm" onClick={load} title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-gray-400" /></div>
      ) : error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border p-3">
          <div className="min-w-[520px]">
            <div className="flex items-center gap-2 py-1.5 pr-2">
              <ChevronDown className="h-4 w-4 text-gray-500" />
              <span className="text-sm font-semibold">{companyName || 'Company'}</span>
              <span className="ml-auto font-mono text-sm tabular-nums text-gray-500">{formatCoaBalance(total)}</span>
            </div>
            {filtered.tree.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">No accounts match.</p>
            ) : (
              <ul className="ml-[8px] border-l border-gray-200 pl-3">
                {filtered.tree.map((r) => renderNode(r))}
              </ul>
            )}
          </div>
        </div>
      )}
      <p className="text-xs text-gray-500">
        Balances: posted journals up to today (Dr = debit, Cr = credit). Groups by account type and subtype are for display; accounts are grouped under a parent account when one is set.
      </p>
    </div>
  )
}
