'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Download, Loader2, Search } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

type Kind = 'sales' | 'settlement' | 'shipping'
type Period = 'day' | 'week' | 'month'

const ORANGE = '#e85d04'
const ORDERS_SHOWN = 50

const todayMyt = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
const rm = (v: unknown) => `RM ${Math.abs(Number(v) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signedRm = (v: unknown) => `${Number(v) < 0 ? '− ' : ''}${rm(v)}`
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toLocaleString('en-MY', { maximumFractionDigits: 1 })}%`)
const count = (v: unknown) => (Number(v) || 0).toLocaleString('en-MY')
const shortDate = (d: string) => new Date(`${d}T00:00:00+08:00`).toLocaleDateString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short' })
const myTime = (iso: string) => new Date(iso).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const compactRm = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('en-MY', { maximumFractionDigits: 1 })}k` : String(Math.round(v)))

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
    return (
        <div role="tablist" aria-label={label} className="inline-flex rounded-lg bg-[var(--sera-mist)] p-0.5">
            {options.map(([v, text]) => (
                <button
                    key={v}
                    role="tab"
                    aria-selected={value === v}
                    onClick={() => onChange(v)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${value === v ? 'bg-white text-[var(--sera-ink)] shadow-sm' : 'text-[var(--sera-muted)] hover:text-[var(--sera-ink)]'}`}
                >
                    {text}
                </button>
            ))}
        </div>
    )
}

function delta(value: number | null, label: string) {
    if (value === null) return undefined
    const arrow = value > 0.0005 ? '↑' : value < -0.0005 ? '↓' : '→'
    return `${arrow} ${pct(Math.abs(value))} ${label}`
}

function Kpi({ label, value, note, warn }: { label: string; value: ReactNode; note?: ReactNode; warn?: boolean }) {
    return (
        <div className="sera-sc-kpi">
            <p className="sera-sc-kpi__label">{label}</p>
            <p className="sera-sc-kpi__value tabular-nums">{value}</p>
            {note !== undefined && <p className={`text-xs ${warn ? 'text-amber-700' : 'text-[var(--sera-muted)]'}`}>{note}</p>}
        </div>
    )
}

function Card({ title, hint, action, children, className = '' }: { title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
    return (
        <section className={`sera-sc-panel p-4 sm:p-5 space-y-3 ${className}`}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--sera-ink)]">{title}</h3>
                    {hint && <p className="text-xs text-[var(--sera-muted)] mt-0.5">{hint}</p>}
                </div>
                {action}
            </div>
            {children}
        </section>
    )
}

function SimpleTable({ head, rows, empty }: { head: { label: string; right?: boolean }[]; rows: ReactNode[][]; empty?: string }) {
    if (!rows.length) return <p className="text-sm text-[var(--sera-muted)] py-2">{empty || 'Nothing in this period.'}</p>
    return (
        <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-xs text-[var(--sera-muted)]">
                        {head.map(h => <th key={h.label} className={`px-1 pb-2 font-medium whitespace-nowrap ${h.right ? 'text-right' : 'text-left'}`}>{h.label}</th>)}
                    </tr>
                </thead>
                <tbody className="divide-y divide-[var(--sera-line)]">
                    {rows.map((cells, i) => (
                        <tr key={i}>
                            {cells.map((c, j) => <td key={j} className={`px-1 py-2 ${head[j]?.right ? 'text-right tabular-nums whitespace-nowrap' : ''}`}>{c}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function ListRow({ title, sub, value, strong }: { title: ReactNode; sub?: ReactNode; value: ReactNode; strong?: boolean }) {
    return (
        <div className="flex items-baseline justify-between gap-3 py-2">
            <div className="min-w-0">
                <p className={`truncate ${strong ? 'font-semibold text-[var(--sera-ink)]' : 'text-[var(--sera-ink)]'}`}>{title}</p>
                {sub && <p className="text-xs text-[var(--sera-muted)] truncate">{sub}</p>}
            </div>
            <p className={`tabular-nums whitespace-nowrap ${strong ? 'font-semibold' : ''}`}>{value}</p>
        </div>
    )
}

// ── Sales ────────────────────────────────────────────────────────────

function SalesView({ report }: { report: any }) {
    const d = report.data
    const cmp = report.range.compareLabel
    const hasSales = d.trend.some((p: any) => p.sales > 0)
    return (
        <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Kpi label="Sales" value={rm(d.totals.sales)} note={delta(d.change.sales, cmp)} />
                <Kpi label="Orders" value={count(d.totals.orders)} note={d.totals.cancelled ? `${count(d.totals.cancelled)} cancelled (${pct(d.cancelRate)})` : delta(d.change.orders, cmp)} />
                <Kpi label="Items sold" value={count(d.totals.items)} note={delta(d.change.items, cmp)} />
                <Kpi label="Average order" value={rm(d.totals.aov)} note={delta(d.change.aov, cmp)} />
            </div>

            {!hasSales && !d.totals.cancelled ? (
                <div className="sera-sc-panel p-10 text-center text-sm text-[var(--sera-muted)]">No sales in this period yet.</div>
            ) : (<>
            <Card title={report.period === 'day' ? 'Sales by hour' : 'Sales by day'}>
                {hasSales ? (
                    <div className="h-56 -ml-2">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={d.trend} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                                <CartesianGrid vertical={false} stroke="#eef0f2" />
                                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} interval="preserveStartEnd" minTickGap={8} />
                                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#9ca3af' }} width={40} tickFormatter={compactRm} />
                                <Tooltip
                                    cursor={{ fill: 'rgba(232, 93, 4, 0.06)' }}
                                    content={({ active, payload }) => {
                                        if (!active || !payload?.length) return null
                                        const p = payload[0].payload
                                        return (
                                            <div className="rounded-lg border border-[var(--sera-line)] bg-white px-3 py-2 text-xs shadow-sm">
                                                <p className="font-medium text-[var(--sera-ink)]">{report.period === 'day' ? p.label : shortDate(p.key)}</p>
                                                <p className="text-[var(--sera-muted)]">{rm(p.sales)} · {p.orders} orders</p>
                                            </div>
                                        )
                                    }}
                                />
                                <Bar dataKey="sales" fill={ORANGE} radius={[3, 3, 0, 0]} maxBarSize={28} />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                ) : (
                    <p className="text-sm text-[var(--sera-muted)] py-8 text-center">No sales in this period yet.</p>
                )}
            </Card>

            <div className="grid gap-3 lg:grid-cols-2">
                <Card title="Best sellers">
                    {d.topProducts.length ? (
                        <div className="divide-y divide-[var(--sera-line)] text-sm">
                            {d.topProducts.map((p: any) => <ListRow key={p.product} title={p.product} sub={`${count(p.items)} items`} value={rm(p.sales)} />)}
                        </div>
                    ) : <p className="text-sm text-[var(--sera-muted)]">Nothing sold in this period.</p>}
                </Card>
                <Card title="Selling slowly" hint="Products with the fewest items sold in this period">
                    {d.lowProducts.length ? (
                        <div className="divide-y divide-[var(--sera-line)] text-sm">
                            {d.lowProducts.map((p: any) => <ListRow key={p.product} title={p.product} sub={`${count(p.items)} items`} value={rm(p.sales)} />)}
                        </div>
                    ) : <p className="text-sm text-[var(--sera-muted)]">Every product sold in this period is in Best sellers.</p>}
                </Card>
            </div>

            {d.shops.length > 0 && (
                <Card title="By shop">
                    <SimpleTable
                        head={[{ label: 'Shop' }, { label: 'Sales', right: true }, { label: 'Orders', right: true }, { label: 'Items', right: true }, { label: 'Cancelled', right: true }]}
                        rows={d.shops.map((s: any) => [s.shop, rm(s.sales), count(s.orders), count(s.items), count(s.cancelled)])}
                    />
                </Card>
            )}
            </>)}

            <p className="text-xs text-[var(--sera-muted)]">
                Sales are product prices after discounts, without shipping, by order time (Malaysia). Cancelled and unpaid orders are not counted.
            </p>
        </>
    )
}

// ── Settlement ───────────────────────────────────────────────────────

function SettlementView({ report }: { report: any }) {
    const d = report.data
    const lines = d.waterfall.filter((l: any) => l.key !== 'revenue' && Math.round(l.amount * 100) !== 0)
    const base = Math.max(Math.abs(d.revenue), 0.01)
    return (
        <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Kpi label="Gross revenue" value={rm(d.revenue)} note={`${count(d.ordersSettled)} orders settled`} />
                <Kpi label="Fees & deductions" value={signedRm(d.deductions)} note={d.revenue ? `${pct(Math.abs(d.deductions) / base)} of revenue` : undefined} />
                <Kpi label="Net settlement" value={signedRm(d.net)} note="Paid into the TikTok balance" />
                <Kpi label="Paid to bank" value={rm(d.paidToBank)} note={d.withdrawals.length ? `${d.withdrawals.length} withdrawal${d.withdrawals.length > 1 ? 's' : ''}` : 'No withdrawal in this period'} />
            </div>

            <div className="grid gap-3 lg:grid-cols-5">
                <Card title="From sales to bank" hint="Orders TikTok settled in this period" className="lg:col-span-3">
                    <div className="text-sm">
                        <ListRow title="Gross revenue" value={rm(d.revenue)} strong />
                        {lines.map((l: any) => (
                            <div key={l.key} className="py-1.5">
                                <div className="flex items-baseline justify-between gap-3">
                                    <p className="text-[var(--sera-ink)]">{l.label}</p>
                                    <p className="tabular-nums text-[var(--sera-muted)]">{signedRm(l.amount)}</p>
                                </div>
                                <div className="mt-1 h-1 rounded-full bg-[var(--sera-mist)]">
                                    <div className="h-1 rounded-full bg-[#e85d04]/50" style={{ width: `${Math.min(100, (Math.abs(l.amount) / base) * 100)}%` }} />
                                </div>
                            </div>
                        ))}
                        <div className="border-t border-[var(--sera-line)] mt-2">
                            <ListRow title="Net settlement" value={signedRm(d.net)} strong />
                        </div>
                        <div className="rounded-lg bg-[#f6f7f8] px-3 mt-1">
                            <ListRow title="Paid to bank in this period" value={rm(d.paidToBank)} />
                        </div>
                    </div>
                    {d.withdrawals.length > 0 && (
                        <div className="divide-y divide-[var(--sera-line)] text-sm">
                            {d.withdrawals.map((w: any) => (
                                <ListRow key={w.reference} title={`${shortDate(w.date)}${report.shops.length > 1 ? ` · ${w.shop}` : ''}`} sub={`${w.status || ''} · Ref ${w.reference}`} value={rm(w.amount)} />
                            ))}
                        </div>
                    )}
                    {d.refunds > 0 && (
                        <p className="text-xs text-[var(--sera-muted)]">Buyer refunds of {rm(d.refunds)} are already taken out of gross revenue.</p>
                    )}
                </Card>

                <div className="space-y-3 lg:col-span-2">
                    <Card title="Not settled yet" hint="Orders TikTok still has to pay (estimated)">
                        <div>
                            <p className="text-2xl font-semibold tabular-nums text-[var(--sera-ink)]">{rm(d.pending.amount)}</p>
                            <p className="text-xs text-[var(--sera-muted)]">{count(d.pending.orders)} orders</p>
                        </div>
                        {d.pending.reasons.length > 0 && (
                            <div className="divide-y divide-[var(--sera-line)] text-sm">
                                {d.pending.reasons.map((r: any) => <ListRow key={r.reason} title={r.reason} sub={`${count(r.orders)} orders`} value={rm(r.amount)} />)}
                            </div>
                        )}
                        <p className="text-xs text-[var(--sera-muted)]">
                            {d.timing.deliveryToSettledDays !== null
                                ? `TikTok settles about ${d.timing.deliveryToSettledDays} days after delivery (${count(d.timing.orders)} orders in this period). `
                                : ''}
                            {d.pending.syncedAt ? `Checked ${myTime(d.pending.syncedAt)}.` : 'Updated by the hourly sync.'}
                        </p>
                    </Card>
                    <Card title="Since last withdrawal" hint="Settled into the TikTok balance after the last bank withdrawal">
                        <div className="divide-y divide-[var(--sera-line)] text-sm">
                            {d.balances.map((b: any) => (
                                <ListRow key={b.shop} title={b.shop} sub={b.lastWithdrawal ? `Last withdrawal ${shortDate(b.lastWithdrawal)}` : 'No withdrawal yet'} value={rm(b.settledSince)} />
                            ))}
                        </div>
                    </Card>
                </div>
            </div>

            {d.shops.length > 0 && (
                <Card title="By shop">
                    <SimpleTable
                        head={[{ label: 'Shop' }, { label: 'Gross revenue', right: true }, { label: 'Fees & deductions', right: true }, { label: 'Net', right: true }, { label: 'Paid to bank', right: true }, { label: 'Not settled', right: true }]}
                        rows={d.shops.map((s: any) => [s.shop, rm(s.revenue), signedRm(s.deductions), signedRm(s.net), rm(s.paidToBank), rm(s.pending)])}
                    />
                </Card>
            )}
        </>
    )
}

// ── Shipping ─────────────────────────────────────────────────────────

function ShippingView({ report }: { report: any }) {
    const d = report.data
    const [search, setSearch] = useState('')
    const [showAll, setShowAll] = useState(false)
    const multi = report.shops.length > 1
    const timed = d.speed.within24 + d.speed.within48 + d.speed.over48
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase()
        return q ? d.orders.filter((o: any) => o.orderId.includes(q) || String(o.tracking || '').toLowerCase().includes(q)) : d.orders
    }, [d.orders, search])
    const shown = showAll ? filtered : filtered.slice(0, ORDERS_SHOWN)
    const segments = [
        { label: 'Within 24 h', value: d.speed.within24, className: 'bg-[var(--sera-orange)]' },
        { label: '24 – 48 h', value: d.speed.within48, className: 'bg-[#e85d04]/40' },
        { label: 'Over 48 h', value: d.speed.over48, className: 'bg-slate-300' },
    ]
    return (
        <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Kpi label="Shipped" value={count(d.shipped)} note={d.cancelled ? `${count(d.cancelled)} cancelled` : 'Handed to the courier'} />
                <Kpi label="Delivered" value={count(d.delivered)} note={d.deliveryDays !== null ? `About ${d.deliveryDays} days on the road` : undefined} />
                <Kpi label="To pack now" value={count(d.toPack)} note={d.toPackLate ? `${count(d.toPackLate)} waiting over 48 h` : 'None waiting over 48 h'} warn={d.toPackLate > 0} />
                <Kpi label="Shipped within 24 h" value={pct(d.within24h)} note={d.speed.medianHours !== null ? `Usually ${d.speed.medianHours} h after payment` : undefined} />
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
                <Card title="Time to ship" hint="From payment to courier pick-up">
                    {timed ? (
                        <>
                            <div className="flex h-2.5 overflow-hidden rounded-full bg-[var(--sera-mist)]">
                                {segments.map(s => s.value > 0 && <div key={s.label} className={s.className} style={{ width: `${(s.value / timed) * 100}%` }} />)}
                            </div>
                            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--sera-muted)]">
                                {segments.map(s => (
                                    <span key={s.label} className="inline-flex items-center gap-1.5">
                                        <span className={`h-2 w-2 rounded-full ${s.className}`} />
                                        {s.label} <b className="text-[var(--sera-ink)] tabular-nums">{count(s.value)}</b>
                                    </span>
                                ))}
                            </div>
                        </>
                    ) : <p className="text-sm text-[var(--sera-muted)]">Nothing shipped in this period.</p>}
                    {d.couriers.length > 0 && (
                        <SimpleTable
                            head={[{ label: 'Courier' }, { label: 'Shipped', right: true }, { label: 'Delivered', right: true }, { label: 'Days to deliver', right: true }]}
                            rows={d.couriers.map((c: any) => [c.courier, count(c.shipped), count(c.delivered), c.medianDeliveryDays ?? '—'])}
                        />
                    )}
                </Card>
                <Card title="Shipping cost" hint="Orders TikTok settled in this period">
                    <div className="divide-y divide-[var(--sera-line)] text-sm">
                        <ListRow title="Paid by buyers" value={signedRm(d.money.buyerPaid)} />
                        <ListRow title="TikTok shipping subsidy" value={signedRm(d.money.subsidy)} />
                        <ListRow title="Courier cost" value={signedRm(d.money.courierCost)} />
                        {Math.round(d.money.returns * 100) !== 0 && <ListRow title="Return shipping" value={signedRm(d.money.returns)} />}
                        {Math.round(d.money.other * 100) !== 0 && <ListRow title="Other shipping" value={signedRm(d.money.other)} />}
                        <ListRow title="Net shipping cost" value={signedRm(d.money.net)} strong />
                    </div>
                </Card>
            </div>

            <Card
                title="Shipped orders"
                hint={`${count(d.orders.length)} orders handed to the courier in this period`}
                action={d.orders.length > 0 && (
                    <label className="relative">
                        <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--sera-muted)]" />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Order or tracking no."
                            aria-label="Search shipped orders"
                            className="w-44 sm:w-56 text-xs border border-[var(--sera-line)] rounded-lg bg-white pl-8 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-[#e85d04]/25"
                        />
                    </label>
                )}
            >
                <SimpleTable
                    head={[{ label: 'Shipped' }, ...(multi ? [{ label: 'Shop' }] : []), { label: 'Order ID' }, { label: 'Courier' }, { label: 'Tracking no.' }, { label: 'Hours to ship', right: true }, { label: 'Status' }]}
                    rows={shown.map((o: any) => [
                        <span key="t" className="whitespace-nowrap">{myTime(o.shippedAt)}</span>,
                        ...(multi ? [o.shop] : []),
                        <span key="o" className="font-mono text-xs">{o.orderId}</span>,
                        o.courier || '—',
                        <span key="k" className="font-mono text-xs">{o.tracking || '—'}</span>,
                        o.hoursToShip ?? '—',
                        <span key="s" className="text-[var(--sera-muted)] whitespace-nowrap">{o.status || '—'}</span>,
                    ])}
                    empty={search ? 'No shipped order matches.' : 'Nothing shipped in this period.'}
                />
                {filtered.length > ORDERS_SHOWN && (
                    <button onClick={() => setShowAll(v => !v)} className="text-xs font-medium text-[var(--sera-orange)] hover:underline">
                        {showAll ? 'Show fewer' : `Show all ${count(filtered.length)}`}
                    </button>
                )}
            </Card>

            {d.shops.length > 0 && (
                <Card title="By shop">
                    <SimpleTable
                        head={[{ label: 'Shop' }, { label: 'Shipped', right: true }, { label: 'Delivered', right: true }, { label: 'To pack now', right: true }, { label: 'Hours to ship', right: true }]}
                        rows={d.shops.map((s: any) => [s.shop, count(s.shipped), count(s.delivered), count(s.toPack), s.medianHours ?? '—'])}
                    />
                </Card>
            )}
        </>
    )
}

// ── Panel ────────────────────────────────────────────────────────────

export default function TikTokReportsPanel({ shops, defaultShopId }: { shops: { id: string; shop_name: string }[]; defaultShopId: string }) {
    const [kind, setKind] = useState<Kind>('sales')
    const [period, setPeriod] = useState<Period>('day')
    const [date, setDate] = useState(todayMyt())
    const [scope, setScope] = useState(shops.length > 1 ? 'all' : defaultShopId)
    const [report, setReport] = useState<any>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (scope !== 'all' && !shops.some(s => s.id === scope)) setScope(shops.length > 1 ? 'all' : defaultShopId)
    }, [shops, scope, defaultShopId])

    const query = useMemo(() => new URLSearchParams({ shop_id: scope, report: kind, period, date }).toString(), [scope, kind, period, date])

    useEffect(() => {
        if (!scope) return
        const controller = new AbortController()
        setLoading(true)
        setError(null)
        fetch(`/api/ecommerce/tiktok-shop/reports?${query}`, { signal: controller.signal })
            .then(async res => {
                const json = await res.json().catch(() => ({}))
                if (!res.ok) throw new Error(json.error || 'Could not load the report')
                setReport(json.report)
            })
            .catch(e => {
                if (controller.signal.aborted) return
                setReport(null)
                setError((e as Error).message)
            })
            .finally(() => { if (!controller.signal.aborted) setLoading(false) })
        return () => controller.abort()
    }, [query, scope])

    const range = report && report.period === period ? report.range : null
    const current = report && report.kind === kind && report.period === period ? report : null
    const today = todayMyt()
    const showingToday = range ? range.isCurrent : date === today

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <Segmented label="Report" value={kind} onChange={setKind} options={[['sales', 'Sales'], ['settlement', 'Settlement'], ['shipping', 'Shipping']]} />
                    <div className="flex items-center gap-2 ml-auto">
                        {shops.length > 1 && (
                            <select
                                value={scope}
                                onChange={e => setScope(e.target.value)}
                                aria-label="Shop"
                                className="text-xs border border-[var(--sera-line)] rounded-lg bg-white px-2.5 py-2 text-[var(--sera-ink)] focus:outline-none focus:ring-2 focus:ring-[#e85d04]/25"
                            >
                                <option value="all">All shops</option>
                                {shops.map(s => <option key={s.id} value={s.id}>{s.shop_name}</option>)}
                            </select>
                        )}
                        <a
                            href={`/api/ecommerce/tiktok-shop/reports?${query}&format=xlsx`}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-[var(--sera-line)] rounded-lg bg-white hover:bg-[var(--sera-mist)] transition-colors text-[var(--sera-ink)]"
                        >
                            <Download className="h-3.5 w-3.5" />
                            Excel
                        </a>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Segmented label="Period" value={period} onChange={setPeriod} options={[['day', 'Day'], ['week', 'Week'], ['month', 'Month']]} />
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => range && setDate(range.prevDate)}
                            disabled={!range || loading}
                            aria-label="Previous period"
                            className="p-1.5 rounded-md text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)] disabled:opacity-40"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </button>
                        <span className="min-w-[9.5rem] text-center text-sm font-medium text-[var(--sera-ink)] tabular-nums">
                            {range ? range.label : '…'}
                        </span>
                        <button
                            onClick={() => range?.nextDate && setDate(range.nextDate)}
                            disabled={!range?.nextDate || loading}
                            aria-label="Next period"
                            className="p-1.5 rounded-md text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] hover:text-[var(--sera-ink)] disabled:opacity-40"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </button>
                        {!showingToday && (
                            <button onClick={() => setDate(today)} className="ml-1 text-xs font-medium text-[var(--sera-orange)] hover:underline">
                                Today
                            </button>
                        )}
                    </div>
                    <p className="ml-auto text-xs text-[var(--sera-muted)] inline-flex items-center gap-1.5">
                        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                        {report?.lastSyncAt ? `TikTok data as of ${myTime(report.lastSyncAt)}` : ''}
                    </p>
                </div>
            </div>

            {error && <div className="sera-sc-panel p-4 text-sm text-destructive">{error}</div>}

            {!current && loading && (
                <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-[var(--sera-muted)]" /></div>
            )}

            {current && (
                <div className={`space-y-3 transition-opacity ${loading ? 'opacity-60' : ''}`}>
                    {current.data.kind === 'sales' && <SalesView report={current} />}
                    {current.data.kind === 'settlement' && <SettlementView report={current} />}
                    {current.data.kind === 'shipping' && <ShippingView key={query} report={current} />}
                </div>
            )}
        </div>
    )
}
