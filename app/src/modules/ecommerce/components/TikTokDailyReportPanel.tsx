'use client'

import { useCallback, useEffect, useState } from 'react'
import { ClipboardList, Copy, Download, FileText, Loader2, RefreshCw } from 'lucide-react'

type Slot = 'packing' | 'shipped'

const todayMyt = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)

const inputClass = 'text-sm border border-[var(--sera-line)] rounded-lg bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/25 text-[var(--sera-ink)]'
const buttonClass = 'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-[var(--sera-line)] rounded-lg bg-white hover:bg-[var(--sera-mist)] transition-colors disabled:opacity-50 text-[var(--sera-ink)]'

export default function TikTokDailyReportPanel({ shopId, shopName, shopCount }: { shopId: string; shopName: string; shopCount: number }) {
    const [slot, setSlot] = useState<Slot>('packing')
    const [date, setDate] = useState(todayMyt())
    const [allShops, setAllShops] = useState(false)
    const [report, setReport] = useState<any>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)

    const query = useCallback((format: 'json' | 'xlsx' | 'txt') => {
        const params = new URLSearchParams({ shop_id: allShops ? 'all' : shopId, slot, format })
        if (slot === 'shipped') params.set('date', date)
        return `/api/ecommerce/tiktok-shop/daily-report?${params}`
    }, [allShops, shopId, slot, date])

    const load = useCallback(async () => {
        if (!shopId) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(query('json'))
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Failed to load the report')
            setReport(json.report)
        } catch (e) {
            setReport(null)
            setError((e as Error).message)
        } finally {
            setLoading(false)
        }
    }, [shopId, query])

    useEffect(() => { load() }, [load])

    const copy = async () => {
        if (!report?.text) return
        await navigator.clipboard.writeText(report.text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <div className="sera-sc-panel p-4 space-y-3">
            <div className="flex flex-col lg:flex-row lg:items-end gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--sera-ink)]">
                        <ClipboardList className="h-4 w-4" />
                        Daily shipping report
                    </div>
                    <p className="text-xs text-[var(--sera-muted)]">
                        The same report sent by email: parcels still to pack, or what shipped on a day. Combo and promo SKUs are counted as the items packed.
                    </p>
                </div>
                <div className="flex flex-wrap items-end gap-2 lg:ml-auto">
                    <div className="inline-flex rounded-lg border border-[var(--sera-line)] overflow-hidden">
                        {([['packing', 'To pack now'], ['shipped', 'Shipped']] as const).map(([value, text]) => (
                            <button
                                key={value}
                                onClick={() => setSlot(value)}
                                className={`px-3 py-2 text-xs font-medium transition-colors ${slot === value ? 'bg-[var(--sera-orange,#f97316)] text-white' : 'bg-white text-[var(--sera-ink)] hover:bg-[var(--sera-mist)]'}`}
                            >
                                {text}
                            </button>
                        ))}
                    </div>
                    {slot === 'shipped' && (
                        <input type="date" value={date} max={todayMyt()} onChange={e => e.target.value && setDate(e.target.value)} className={inputClass} />
                    )}
                    {shopCount > 1 && (
                        <select value={allShops ? 'all' : 'one'} onChange={e => setAllShops(e.target.value === 'all')} className={inputClass}>
                            <option value="one">{shopName || 'This shop'}</option>
                            <option value="all">All TikTok shops</option>
                        </select>
                    )}
                    <button onClick={load} disabled={loading} className={buttonClass}>
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                        View
                    </button>
                    <a href={query('xlsx')} className={buttonClass}>
                        <Download className="h-3.5 w-3.5" />
                        Excel
                    </a>
                    <a href={query('txt')} className={buttonClass}>
                        <FileText className="h-3.5 w-3.5" />
                        Text
                    </a>
                    <button onClick={copy} disabled={!report?.text} className={buttonClass}>
                        <Copy className="h-3.5 w-3.5" />
                        {copied ? 'Copied' : 'Copy'}
                    </button>
                </div>
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}
            {loading && !report && (
                <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            )}

            {report && (
                <div className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
                    <p className="text-xs text-[var(--sera-muted)]">
                        {report.subject}
                        {report.lastSyncAt ? ` · TikTok data as of ${new Date(report.lastSyncAt).toLocaleString('en-MY')}` : ''}
                    </p>
                    {report.shops.map((shop: any) => (
                        <div key={shop.shop} className="rounded-lg border border-[var(--sera-line)] p-3 space-y-3">
                            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                                <p className="text-sm font-semibold text-[var(--sera-ink)]">{shop.shop}</p>
                                <p className="text-xs text-[var(--sera-muted)]"><b className="text-[var(--sera-ink)]">{shop.parcels}</b> parcels · <b className="text-[var(--sera-ink)]">{shop.items}</b> items</p>
                                {shop.orderFrom && (
                                    <p className="text-xs text-[var(--sera-muted)]">Orders {shop.orderFrom}{shop.orderTo && shop.orderTo !== shop.orderFrom ? ` - ${shop.orderTo}` : ''}</p>
                                )}
                            </div>
                            {shop.parcels === 0 ? (
                                <p className="text-sm text-[var(--sera-muted)]">{slot === 'packing' ? 'Nothing to pack.' : 'Nothing shipped on this day.'}</p>
                            ) : (
                                <div className="grid gap-3 lg:grid-cols-2">
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                                                    <th className="py-1.5 pr-3 font-medium">Item</th>
                                                    <th className="py-1.5 pr-3 font-medium text-right">Qty</th>
                                                    <th className="py-1.5 font-medium">Variations</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-border">
                                                {shop.itemTotals.map((row: any) => (
                                                    <tr key={row.item}>
                                                        <td className="py-1.5 pr-3 font-medium">{row.item}</td>
                                                        <td className="py-1.5 pr-3 text-right tabular-nums">{row.quantity}</td>
                                                        <td className="py-1.5 text-xs text-[var(--sera-muted)]">{row.variations.map((v: any) => `${v.name} ${v.quantity}`).join(', ') || '—'}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    <div className="max-h-80 overflow-y-auto rounded-md bg-[var(--sera-mist)]/40 p-2">
                                        <ol className="space-y-1 text-xs">
                                            {shop.parcelRows.map((row: any) => (
                                                <li key={`${row.no}-${row.orderId}`} className="leading-snug">
                                                    <span className="text-[var(--sera-muted)]">{row.no}.</span>{' '}
                                                    <span className="font-mono">{row.orderId}</span>
                                                    {row.status ? <span className="text-[var(--sera-muted)]"> [{row.status}]</span> : null}: {row.contents}
                                                </li>
                                            ))}
                                        </ol>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
