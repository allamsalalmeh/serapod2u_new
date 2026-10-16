'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, Search, User } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import ModuleLightHeader from '@/components/layout/ModuleLightHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Node {
    key: string
    name: string
    jobTitle: string | null
    department: string | null
    managerKey: string | null
    isSelf: boolean
}

type State = { kind: 'loading' } | { kind: 'ready'; nodes: Node[] } | { kind: 'unavailable' } | { kind: 'denied' }

/**
 * Read-only staff organization chart: name, job title, department and reporting line only. The server returns exactly
 * those fields (see /api/hr/org-chart/staff); there is nothing here to edit and no link to an employee record.
 */
export default function HrStaffOrgChartView() {
    const [state, setState] = useState<State>({ kind: 'loading' })
    const [query, setQuery] = useState('')

    const load = useCallback(async () => {
        setState({ kind: 'loading' })
        try {
            const res = await fetch('/api/hr/org-chart/staff', { cache: 'no-store' })
            if (res.status === 401 || res.status === 403) return setState({ kind: 'denied' })
            if (!res.ok) return setState({ kind: 'unavailable' })
            const body = await res.json()
            setState(Array.isArray(body?.nodes) ? { kind: 'ready', nodes: body.nodes } : { kind: 'unavailable' })
        } catch {
            setState({ kind: 'unavailable' })
        }
    }, [])

    useEffect(() => { void load() }, [load])

    const nodes = state.kind === 'ready' ? state.nodes : []
    const { roots, children, matches } = useMemo(() => {
        const q = query.trim().toLowerCase()
        const byKey = new Map(nodes.map(n => [n.key, n]))
        const childMap = new Map<string, Node[]>()
        const rootList: Node[] = []
        for (const n of nodes) {
            if (n.managerKey && byKey.has(n.managerKey)) childMap.set(n.managerKey, [...(childMap.get(n.managerKey) ?? []), n])
            else rootList.push(n)
        }
        // A reporting cycle has no root of its own: surface one member so the chart is never blank because of bad data.
        const reached = new Set<string>()
        const walk = (n: Node) => {
            if (reached.has(n.key)) return
            reached.add(n.key)
            ;(childMap.get(n.key) ?? []).forEach(walk)
        }
        rootList.forEach(walk)
        for (const n of nodes) {
            if (!reached.has(n.key)) { rootList.push(n); walk(n) }
        }
        const hit = (n: Node) => !q || [n.name, n.jobTitle, n.department].some(v => v?.toLowerCase().includes(q))
        return { roots: rootList, children: childMap, matches: hit }
    }, [nodes, query])

    const renderNode = (node: Node, depth: number, seen: Set<string>): React.ReactNode => {
        if (seen.has(node.key)) return null // a reporting cycle never loops the screen
        const next = new Set(seen).add(node.key)
        const kids = children.get(node.key) ?? []
        return (
            <li key={node.key}>
                <div className={`flex min-w-[14rem] items-center gap-3 rounded-md border px-3 py-2 ${node.isSelf ? 'border-blue-300 bg-blue-50' : ''} ${matches(node) ? '' : 'opacity-50'}`}>
                    <User className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{node.name}{node.isSelf ? ' (you)' : ''}</div>
                        <div className="truncate text-xs text-muted-foreground">{[node.jobTitle, node.department].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                </div>
                {kids.length > 0 && depth < 20 && (
                    <ul className="ml-5 mt-2 space-y-2 border-l pl-4">{kids.map(k => renderNode(k, depth + 1, next))}</ul>
                )}
            </li>
        )
    }

    return (
        <div className="sera-module-landing" data-testid="hr-staff-org-chart">
            <ModuleLightHeader eyebrow="HR" title="Organization Chart" description="Who works where and who reports to whom." />
            <Card>
                <CardContent className="space-y-4">
                    {state.kind === 'ready' && (
                        <div className="relative max-w-sm">
                            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
                            <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name, title or department" className="pl-9" aria-label="Search the organization chart" />
                        </div>
                    )}
                    {state.kind === 'loading' && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>}
                    {state.kind === 'unavailable' && (
                        <div role="status" className="flex flex-wrap items-center justify-between gap-3 text-sm">
                            <span>We couldn’t load the organization chart right now. This is temporary and not a decision about your access.</span>
                            <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Try again</Button>
                        </div>
                    )}
                    {state.kind === 'denied' && <div role="alert" className="text-sm">You don’t have access to this page. Contact your administrator if you need access.</div>}
                    {state.kind === 'ready' && (nodes.length === 0
                        ? <p className="text-sm text-muted-foreground">No staff to show yet.</p>
                        // A deep reporting line pans inside this box; the page itself never overflows.
                        : (
                            <div className="max-w-full overflow-x-auto overscroll-x-contain" tabIndex={0} role="region" aria-label="Organization chart, scrollable">
                                <ul className="w-max min-w-full space-y-2">{roots.map(r => renderNode(r, 0, new Set()))}</ul>
                            </div>
                        ))}
                </CardContent>
            </Card>
        </div>
    )
}
