'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Link2, Loader2, Plus, RefreshCw, Unlink, Upload } from 'lucide-react'
import SupplyChainPageHeader from '@/modules/supply-chain/components/SupplyChainPageHeader'
import { TIKTOK_CONNECT_MESSAGES } from '@/lib/marketplace/tiktok-connect-messages'

interface TikTokShopViewProps {
    userProfile: any
    onViewChange?: (view: string) => void
}

type Tab = 'summary' | 'orders' | 'settlements' | 'payouts' | 'history'

const money = (v: unknown) =>
    `RM ${(Number(v) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dateOnly = (v: unknown) => (v ? String(v).slice(0, 10) : '—')
const label = (key: string) => key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
const currentMonth = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7)

const inputClass = 'text-sm border border-[var(--sera-line)] rounded-lg bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/25 text-[var(--sera-ink)]'
const buttonClass = 'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-[var(--sera-line)] rounded-lg bg-white hover:bg-[var(--sera-mist)] transition-colors disabled:opacity-50 text-[var(--sera-ink)]'
const primaryClass = 'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[var(--sera-orange,#f97316)] text-white hover:opacity-90 transition-opacity disabled:opacity-50'

function readAsBase64(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
    })
}

function Table({ head, rows, empty }: { head: { label: string; right?: boolean }[]; rows: ReactNode[][]; empty: string }) {
    if (rows.length === 0) return <div className="sera-sc-panel p-8 text-center text-sm text-[var(--sera-muted)]">{empty}</div>
    return (
        <div className="bg-card border border-border rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="border-b border-border bg-accent/30">
                        {head.map(h => (
                            <th key={h.label} className={`${h.right ? 'text-right' : 'text-left'} px-4 py-3 font-medium text-muted-foreground whitespace-nowrap`}>{h.label}</th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {rows.map((cells, i) => (
                        <tr key={i} className="hover:bg-accent/20">
                            {cells.map((c, j) => (
                                <td key={j} className={`px-4 py-2.5 ${head[j]?.right ? 'text-right tabular-nums' : ''}`}>{c}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

export default function TikTokShopView(_props: TikTokShopViewProps) {
    const [shops, setShops] = useState<any[]>([])
    const [shopId, setShopId] = useState('')
    const [month, setMonth] = useState(currentMonth())
    const [data, setData] = useState<any>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [tab, setTab] = useState<Tab>('summary')

    const [newShop, setNewShop] = useState('')
    const [addingShop, setAddingShop] = useState(false)

    const [file, setFile] = useState<File | null>(null)
    const [fileInputKey, setFileInputKey] = useState(0)
    const [busy, setBusy] = useState<'preview' | 'import' | null>(null)
    const [preview, setPreview] = useState<any>(null)
    const [result, setResult] = useState<string | null>(null)
    const [syncing, setSyncing] = useState(false)

    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        const outcome = params.get('tiktok')
        if (!outcome) return
        const message = TIKTOK_CONNECT_MESSAGES[outcome] || TIKTOK_CONNECT_MESSAGES.error
        if (outcome === 'connected') setResult(message)
        else setError(message)
        const shop = params.get('shop')
        if (shop) setShopId(shop)
        params.delete('tiktok')
        params.delete('shop')
        const query = params.toString()
        window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
    }, [])

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const params = new URLSearchParams()
            if (shopId) { params.set('shop_id', shopId); params.set('month', month) }
            const res = await fetch(`/api/ecommerce/tiktok-shop?${params}`)
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Failed to load')
            setShops(json.shops || [])
            if (!shopId && json.shops?.length) setShopId(prev => prev || json.shops[0].id)
            setData(shopId ? json : null)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setLoading(false)
        }
    }, [shopId, month])

    useEffect(() => { load() }, [load])

    const addShop = async () => {
        if (!newShop.trim()) return
        setAddingShop(true)
        setError(null)
        try {
            const res = await fetch('/api/ecommerce/tiktok-shop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'add_shop', shop_name: newShop }),
            })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Failed to add shop')
            setNewShop('')
            setShopId(json.shop.id)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setAddingShop(false)
        }
    }

    const send = async (mode: 'preview' | 'import') => {
        if (!file || !shopId) return
        setBusy(mode)
        setError(null)
        setResult(null)
        try {
            const res = await fetch('/api/ecommerce/tiktok-shop/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shop_id: shopId, file_name: file.name, file_base64: await readAsBase64(file), mode }),
            })
            const json = await res.json()
            if (!res.ok) {
                setPreview(null)
                throw new Error(json.errors?.length > 1 ? json.errors.join(' • ') : json.error || 'Upload failed')
            }
            if (mode === 'preview') {
                setPreview(json)
            } else {
                const s = json.summary
                setResult(s.kind === 'orders'
                    ? `Imported: ${s.new_lines} new and ${s.updated_lines} updated order lines (${s.unchanged_lines} already up to date).`
                    : `Imported: ${s.new_settlements} new settlement rows, ${s.new_payouts} new and ${s.updated_payouts} updated payouts.`)
                setPreview(null)
                setFile(null)
                setFileInputKey(k => k + 1)
                if (s.period_end) setMonth(String(s.period_end).slice(0, 7))
                load()
            }
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setBusy(null)
        }
    }

    const syncNow = async () => {
        if (!shopId) return
        setSyncing(true)
        setError(null)
        setResult(null)
        const total = { lines: 0, updated: 0, settlements: 0, payouts: 0 }
        try {
            for (let run = 0; run < 10; run++) {
                const res = await fetch('/api/ecommerce/tiktok-shop/sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ shop_id: shopId }),
                })
                const json = await res.json()
                if (!res.ok) throw new Error(json.error || 'Sync failed')
                total.lines += json.counts.orderLinesInserted
                total.updated += json.counts.orderLinesUpdated
                total.settlements += json.counts.settlementsInserted
                total.payouts += json.counts.payoutsWritten
                if (json.done) break
            }
            setResult(`Synced from TikTok: ${total.lines} new and ${total.updated} updated order lines, ${total.settlements} new settlement rows, ${total.payouts} payouts.`)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setSyncing(false)
            load()
        }
    }

    const disconnect = async () => {
        if (!shopId || !window.confirm('Disconnect this shop from the TikTok Shop API? Data already brought in is kept.')) return
        setError(null)
        try {
            const res = await fetch('/api/ecommerce/tiktok-shop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'disconnect', shop_id: shopId }),
            })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Failed to disconnect')
            setResult('Disconnected from the TikTok Shop API.')
            load()
        } catch (e) {
            setError((e as Error).message)
        }
    }

    const conn = data?.connection
    const reconnectBy = conn?.refresh_token_expires_at && Date.parse(conn.refresh_token_expires_at) - Date.now() < 14 * 86400_000
        ? dateOnly(conn.refresh_token_expires_at)
        : null
    const s = data?.summary
    const p = preview?.summary
    const nothingNew = p && (p.kind === 'orders'
        ? p.new_lines + p.updated_lines === 0
        : p.new_settlements + p.new_payouts + p.updated_payouts === 0)

    return (
        <div className="sera-sc-page sera-page-enter w-full max-w-6xl mx-auto">
            <SupplyChainPageHeader
                eyebrow="Customer & Growth"
                title="TikTok Shop"
                description="Sales, settlements and payouts from the TikTok Shop API or Seller Center exports"
                actions={
                    <button onClick={load} disabled={loading} className={buttonClass}>
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                        Refresh
                    </button>
                }
            />

            {error && (
                <div className="bg-destructive/10 border border-destructive/20 text-destructive rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3">
                    <span>{error}</span>
                    <button onClick={() => setError(null)} className="underline text-xs shrink-0">Dismiss</button>
                </div>
            )}
            {result && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3">
                    <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />{result}</span>
                    <button onClick={() => setResult(null)} className="underline text-xs shrink-0">Dismiss</button>
                </div>
            )}

            <div className="sera-sc-panel p-4 flex flex-col md:flex-row md:items-end gap-3">
                <label className="flex flex-col gap-1 text-xs text-[var(--sera-muted)]">
                    Shop
                    <select value={shopId} onChange={e => { setShopId(e.target.value); setPreview(null) }} className={inputClass} disabled={shops.length === 0}>
                        {shops.length === 0 && <option value="">No shops yet</option>}
                        {shops.map(shop => <option key={shop.id} value={shop.id}>{shop.shop_name}</option>)}
                    </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-[var(--sera-muted)]">
                    Month
                    <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} className={inputClass} disabled={!shopId} />
                </label>
                <div className="flex items-end gap-2 md:ml-auto">
                    <label className="flex flex-col gap-1 text-xs text-[var(--sera-muted)]">
                        Add a TikTok shop
                        <input value={newShop} onChange={e => setNewShop(e.target.value)} placeholder="e.g. SeraOutdoor" maxLength={120} className={inputClass} />
                    </label>
                    <button onClick={addShop} disabled={addingShop || !newShop.trim()} className={buttonClass}>
                        {addingShop ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                        Add
                    </button>
                </div>
            </div>

            {shopId && data && (conn || data.api_configured) && (
                <div className="sera-sc-panel p-4 space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                        <div className="flex items-start gap-2 text-sm text-[var(--sera-ink)] min-w-0">
                            <Link2 className="h-4 w-4 mt-0.5 shrink-0" />
                            {conn ? (
                                <div className="min-w-0">
                                    <p className="font-medium">
                                        Connected to TikTok shop {conn.external_shop_name || conn.seller_name || ''}{conn.external_shop_code ? ` (${conn.external_shop_code})` : ''}
                                    </p>
                                    <p className="text-xs text-[var(--sera-muted)]">
                                        Settlements and payouts from {dateOnly(conn.data_from)} come from the API and sync every hour.
                                        {' '}Last sync: {conn.last_sync_at ? new Date(conn.last_sync_at).toLocaleString('en-MY') : 'not yet'}
                                        {conn.last_sync_status === 'failed' ? ' (failed)' : ''}
                                    </p>
                                </div>
                            ) : (
                                <div className="min-w-0">
                                    <p className="font-medium">Connect this shop to the TikTok Shop API</p>
                                    <p className="text-xs text-[var(--sera-muted)]">
                                        Log in to TikTok Seller Center for {shops.find(x => x.id === shopId)?.shop_name} in this browser first, then click Connect and approve.
                                    </p>
                                </div>
                            )}
                        </div>
                        <div className="flex gap-2 sm:ml-auto shrink-0">
                            {conn ? (
                                <>
                                    <button onClick={syncNow} disabled={syncing} className={primaryClass}>
                                        {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                        Sync now
                                    </button>
                                    <button onClick={disconnect} disabled={syncing} className={buttonClass}>
                                        <Unlink className="h-3.5 w-3.5" />
                                        Disconnect
                                    </button>
                                </>
                            ) : (
                                <a href={`/api/ecommerce/tiktok-shop/connect?shop_id=${encodeURIComponent(shopId)}`} className={primaryClass}>
                                    <Link2 className="h-3.5 w-3.5" />
                                    Connect TikTok
                                </a>
                            )}
                        </div>
                    </div>
                    {conn?.last_sync_error && (
                        <p className="flex items-start gap-2 text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />{conn.last_sync_error}</p>
                    )}
                    {reconnectBy && (
                        <p className="flex items-start gap-2 text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />The TikTok authorization ends on {reconnectBy}. Click Disconnect and connect again before then.</p>
                    )}
                </div>
            )}

            {shopId && (
                <div className="sera-sc-panel p-4 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--sera-ink)]">
                        <FileSpreadsheet className="h-4 w-4" />
                        Upload a TikTok export (.xlsx) for {shops.find(x => x.id === shopId)?.shop_name}
                    </div>
                    <p className="text-xs text-[var(--sera-muted)]">
                        Orders file (Orders → Export) or Transaction file (Finance → Transactions → Export). Use the file exactly as downloaded;
                        uploading the same or an overlapping period again only adds what is new. Customer names, phones and addresses are not stored.
                    </p>
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                        <input
                            key={fileInputKey}
                            type="file"
                            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                            onChange={e => { setFile(e.target.files?.[0] || null); setPreview(null); setResult(null) }}
                            className="text-sm"
                        />
                        <button onClick={() => send('preview')} disabled={!file || busy !== null} className={buttonClass}>
                            {busy === 'preview' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            Check file
                        </button>
                        <button onClick={() => send('import')} disabled={!preview || nothingNew || busy !== null} className={primaryClass}>
                            {busy === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                            Import
                        </button>
                    </div>

                    {p && (
                        <div className="rounded-lg border border-[var(--sera-line)] bg-[var(--sera-mist)]/40 p-3 text-sm space-y-1">
                            <p className="font-medium">
                                {p.kind === 'orders' ? 'Orders file' : 'Transaction file'} · {dateOnly(p.period_start)} to {dateOnly(p.period_end)}
                            </p>
                            {p.kind === 'orders' ? (
                                <p>{p.orders} orders, {p.lines} lines: <b>{p.new_lines} new</b>, <b>{p.updated_lines} updated</b>, {p.unchanged_lines} already imported.</p>
                            ) : (
                                <>
                                    <p>{p.settlements} settlement rows: <b>{p.new_settlements} new</b> ({money(p.new_settlement_amount)}), {p.already_imported_settlements} already imported.</p>
                                    <p>File total {money(p.file_total)}{p.report_total !== null ? ` matches the report total ${money(p.report_total)}` : ''}.</p>
                                    <p>{p.payouts} payout rows: <b>{p.new_payouts} new</b>, <b>{p.updated_payouts} updated</b>.</p>
                                </>
                            )}
                            {nothingNew && <p className="text-[var(--sera-muted)]">Nothing new to import, this file is already in.</p>}
                        </div>
                    )}
                    {preview?.warnings?.map((w: string) => (
                        <p key={w} className="flex items-start gap-2 text-xs text-amber-700"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />{w}</p>
                    ))}
                </div>
            )}

            {!shopId && !loading && (
                <div className="sera-sc-panel p-8 text-center text-sm text-[var(--sera-muted)]">
                    Add your first TikTok shop above (for example SeraOutdoor or Ellbow), then upload its exports.
                </div>
            )}

            {shopId && loading && !data && (
                <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            )}

            {s && (
                <>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">Orders</p><p className="sera-sc-kpi__value">{s.orders}</p></div>
                        <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">Units sold</p><p className="sera-sc-kpi__value">{s.units_sold}</p></div>
                        <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">Gross sales</p><p className="sera-sc-kpi__value">{money(s.gross_sales)}</p></div>
                        <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">Cancelled orders</p><p className="sera-sc-kpi__value">{s.cancelled_orders}</p></div>
                        <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">Settled revenue</p><p className="sera-sc-kpi__value">{money(s.settled_revenue)}</p></div>
                        <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">TikTok fees</p><p className="sera-sc-kpi__value">{money(s.settled_fees)}</p></div>
                        <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">Net settlement</p><p className="sera-sc-kpi__value">{money(s.settlement_amount)}</p></div>
                        <div className="sera-sc-kpi"><p className="sera-sc-kpi__label">Withdrawn to bank</p><p className="sera-sc-kpi__value">{money(s.withdrawn)}</p></div>
                    </div>
                    <p className="text-xs text-[var(--sera-muted)] -mt-2">
                        Orders and sales by order date; settlements by settlement date; payouts by request date ({s.month}, Malaysia time).
                    </p>

                    <div className="flex gap-1 border-b border-[var(--sera-line)] overflow-x-auto">
                        {([
                            ['summary', 'Summary'],
                            ['orders', `Orders (${data.totals.order_lines})`],
                            ['settlements', `Settlements (${data.totals.settlements})`],
                            ['payouts', `Payouts (${data.totals.payouts})`],
                            ['history', 'Import history'],
                        ] as const).map(([value, text]) => (
                            <button
                                key={value}
                                onClick={() => setTab(value)}
                                className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${tab === value
                                    ? 'border-[var(--sera-orange,#f97316)] text-[var(--sera-ink)]'
                                    : 'border-transparent text-[var(--sera-muted)] hover:text-[var(--sera-ink)]'}`}
                            >
                                {text}
                            </button>
                        ))}
                    </div>

                    {tab === 'summary' && (
                        <div className="grid gap-4 lg:grid-cols-2">
                            <div className="space-y-2">
                                <h3 className="text-sm font-semibold text-[var(--sera-ink)]">Top products</h3>
                                <Table
                                    head={[{ label: 'Seller SKU / product' }, { label: 'Units', right: true }, { label: 'Sales', right: true }]}
                                    rows={s.top_skus.map((k: any) => [
                                        <div key="p" className="min-w-0"><p className="font-medium truncate max-w-[260px]">{k.seller_sku || '(no seller SKU)'}</p><p className="text-[11px] text-muted-foreground truncate max-w-[260px]">{k.product_name}</p></div>,
                                        k.units,
                                        money(k.sales),
                                    ])}
                                    empty="No sold orders this month."
                                />
                            </div>
                            <div className="space-y-2">
                                <h3 className="text-sm font-semibold text-[var(--sera-ink)]">Fees and adjustments</h3>
                                <Table
                                    head={[{ label: 'Item' }, { label: 'Amount', right: true }]}
                                    rows={s.fee_breakdown.map((f: any) => [label(f.name), money(f.amount)])}
                                    empty="No settlements this month."
                                />
                                {s.shipping_fee_parts.length > 0 && (
                                    <>
                                        <h4 className="text-xs font-medium text-[var(--sera-muted)] pt-1">Seller shipping fee is made of</h4>
                                        <Table
                                            head={[{ label: 'Part' }, { label: 'Amount', right: true }]}
                                            rows={s.shipping_fee_parts.map((f: any) => [label(f.name), money(f.amount)])}
                                            empty=""
                                        />
                                    </>
                                )}
                            </div>
                        </div>
                    )}

                    {tab === 'orders' && (
                        <Table
                            head={[{ label: 'Order ID' }, { label: 'Created' }, { label: 'Status' }, { label: 'Seller SKU / product' }, { label: 'Qty', right: true }, { label: 'Sales', right: true }, { label: 'State' }]}
                            rows={data.order_lines.map((l: any) => [
                                <span key="o" className="font-mono text-xs">{l.order_id}</span>,
                                dateOnly(l.created_time),
                                l.order_status || '—',
                                <div key="p" className="min-w-0"><p className="truncate max-w-[240px]">{l.seller_sku || '(no seller SKU)'}</p><p className="text-[11px] text-muted-foreground truncate max-w-[240px]">{l.product_name}{l.variation ? ` · ${l.variation}` : ''}</p></div>,
                                l.quantity,
                                money(l.subtotal_after_discount),
                                l.buyer_state || '—',
                            ])}
                            empty="No orders this month. Upload the orders file for this month."
                        />
                    )}

                    {tab === 'settlements' && (
                        <Table
                            head={[{ label: 'Settled' }, { label: 'Order / adjustment ID' }, { label: 'Type' }, { label: 'Revenue', right: true }, { label: 'Fees', right: true }, { label: 'Settlement', right: true }]}
                            rows={data.settlements.map((r: any) => [
                                dateOnly(r.settled_date),
                                <span key="r" className="font-mono text-xs">{r.record_id}</span>,
                                r.transaction_type,
                                money(r.total_revenue),
                                money(r.total_fees),
                                money(r.total_settlement_amount),
                            ])}
                            empty="No settlements this month. Upload the transaction file for this month."
                        />
                    )}

                    {tab === 'payouts' && (
                        <Table
                            head={[{ label: 'Requested' }, { label: 'Reference' }, { label: 'Type' }, { label: 'Status' }, { label: 'Completed' }, { label: 'Amount', right: true }]}
                            rows={data.payouts.map((r: any) => [
                                dateOnly(r.request_date),
                                <span key="r" className="font-mono text-xs">{r.reference_id}</span>,
                                r.transaction_type,
                                r.status || '—',
                                dateOnly(r.success_date),
                                money(r.amount),
                            ])}
                            empty="No payouts this month."
                        />
                    )}

                    {tab === 'history' && (
                        <Table
                            head={[{ label: 'Imported' }, { label: 'File' }, { label: 'Type' }, { label: 'Period' }, { label: 'New', right: true }, { label: 'Updated', right: true }, { label: 'Unchanged', right: true }, { label: 'Status' }]}
                            rows={data.imports.map((r: any) => [
                                new Date(r.imported_at).toLocaleString('en-MY'),
                                <span key="f" className="truncate max-w-[220px] inline-block align-bottom">{r.file_name}</span>,
                                r.file_kind === 'orders' ? 'Orders' : 'Transactions',
                                `${dateOnly(r.period_start)} – ${dateOnly(r.period_end)}`,
                                r.rows_inserted,
                                r.rows_updated,
                                r.rows_unchanged,
                                r.status,
                            ])}
                            empty="No files imported yet."
                        />
                    )}

                    {(data.totals.order_lines > data.order_lines.length || data.totals.settlements > data.settlements.length) && (
                        <p className="text-xs text-[var(--sera-muted)]">Showing the latest 500 rows; the summary above covers the whole month.</p>
                    )}
                </>
            )}
        </div>
    )
}
