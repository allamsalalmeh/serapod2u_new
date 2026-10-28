'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { monthLabel } from '@/lib/reporting/consumer-analytics'
import {
  OVERVIEW_DRILLDOWN_DEFAULT_PAGE_SIZE,
  OVERVIEW_DRILLDOWN_TITLE,
  type ActiveBuyerRow,
  type ConfirmedOrderRow,
  type OverviewDrilldown,
  type OverviewDrilldownMetric,
} from '@/lib/reporting/executive-overview-drilldown'
import { formatReportDate } from '@/lib/reporting/product-analytics'
import { supplyChainOrderPath } from '@/modules/supply-chain/supplyChainNav'
import { ReportingTabLoading } from './reportingChrome'

const STATUS_LABEL: Record<string, string> = {
  approved: 'Approved',
  warehouse_packed: 'Packed',
  shipped_distributor: 'Shipped',
  closed: 'Closed',
}

function formatRm(value: number) {
  return `RM ${(Number(value) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const formatCount = (value: number) => (Number(value) || 0).toLocaleString('en-MY')

/** Existing detail routes: Supply Chain order view and organisation view. */
export function overviewOrderHref(orderId: string): string | null {
  const path = supplyChainOrderPath('view-order', orderId)
  return path ? `/supply-chain/${path}` : null
}
export const overviewBuyerHref = (buyerId: string) => `/supply-chain/organizations/${encodeURIComponent(buyerId)}`

export interface OverviewDrilldownTarget {
  metric: OverviewDrilldownMetric
  /** Narrow Confirmed Sales Orders to one buyer (opened from the Active Buyers list). */
  buyer?: { id: string; name: string } | null
}

type AnyDrilldown = OverviewDrilldown<ConfirmedOrderRow | ActiveBuyerRow>

/**
 * Drill-down modal for the Executive Overview's Confirmed Sales Orders and
 * Active Buyers cards. Always reads the dashboard's CURRENT Reporting Month;
 * a slower earlier response (other page, month or metric) is dropped.
 */
export default function ExecutiveOverviewDrilldownDialog({ target, month, onTargetChange }: {
  target: OverviewDrilldownTarget | null
  month: string
  /** `null` closes the modal. */
  onTargetChange: (target: OverviewDrilldownTarget | null) => void
}) {
  const [page, setPage] = useState(0)
  const [data, setData] = useState<AnyDrilldown | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)
  const metric = target?.metric ?? null
  const buyerId = target?.buyer?.id ?? null

  const load = useCallback((scope: { metric: OverviewDrilldownMetric; month: string; buyerId: string | null; page: number }) => {
    const id = ++requestId.current
    setData(null)
    setError(null)
    setLoading(true)
    void (async () => {
      try {
        const params = new URLSearchParams({
          metric: scope.metric,
          month: scope.month,
          page: String(scope.page),
          pageSize: String(OVERVIEW_DRILLDOWN_DEFAULT_PAGE_SIZE),
        })
        if (scope.buyerId) params.set('buyer', scope.buyerId)
        const res = await fetch(`/api/reporting/stats/drilldown?${params}`, { cache: 'no-store', credentials: 'include' })
        const payload = await res.json().catch(() => ({}))
        if (id !== requestId.current) return
        if (!res.ok) throw new Error(payload?.error || `Unable to load details (${res.status})`)
        setData(payload.drilldown as AnyDrilldown)
      } catch (err: any) {
        if (id === requestId.current) setError(err?.message || 'Unable to load details')
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    })()
  }, [])

  // A new metric, buyer or month always starts again on the first page.
  useEffect(() => { setPage(0) }, [metric, buyerId, month])

  useEffect(() => {
    if (!metric) {
      requestId.current++
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    load({ metric, month, buyerId, page })
  }, [metric, buyerId, month, page, load])

  // Render only the response for the list on screen now: after a switch (Active Buyers → a buyer's orders) or
  // while closing, the previous response must never be drawn with the other list's columns.
  const shown = data && metric && data.metric === metric && (data.buyer?.id ?? null) === buyerId && data.period.month === month ? data : null
  const busy = loading || (metric !== null && !shown && !error)
  const title = metric ? OVERVIEW_DRILLDOWN_TITLE[metric] : ''
  const periodLabel = shown?.period.label ?? monthLabel(month)
  const isOrders = metric === 'confirmed_orders'
  const th = 'px-3 py-2 font-medium whitespace-nowrap'
  const td = 'px-3 py-2.5 align-top'
  const num = 'px-3 py-2.5 text-right tabular-nums align-top whitespace-nowrap'

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onTargetChange(null) }}>
      <DialogContent
        className="w-[calc(100vw-1.5rem)] max-w-4xl gap-0 p-0 sm:w-full"
        data-testid="overview-drilldown"
        aria-describedby="overview-drilldown-description"
      >
        <DialogHeader className="space-y-1 border-b border-[var(--sera-line)] px-4 pb-4 pt-5 pr-12 text-left sm:px-6">
          <DialogTitle className="text-base font-semibold text-[var(--sera-ink)] sm:text-lg">
            {title}{target?.buyer ? ` · ${target.buyer.name}` : ''} — {periodLabel}
          </DialogTitle>
          <DialogDescription id="overview-drilldown-description" className="text-xs text-[var(--sera-muted)]">
            {shown
              ? `${shown.period.rangeLabel}${shown.period.isCurrentMonth ? ' (month to date)' : ''} · Malaysia time`
              : `Reporting Month ${monthLabel(month)}`}
          </DialogDescription>
          {target?.buyer ? (
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 mt-1 h-7 gap-1 px-2 text-xs"
                onClick={() => onTargetChange({ metric: 'active_buyers' })}
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back to Active Buyers
              </Button>
            </div>
          ) : null}
        </DialogHeader>

        <div className="min-h-[12rem] px-4 py-4 sm:px-6">
          {busy ? (
            <div className="py-8"><ReportingTabLoading label="Loading details" /></div>
          ) : error ? (
            <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <span>{error}</span>
              {metric ? (
                <Button variant="outline" size="sm" className="gap-2 border-red-300 text-red-700 hover:bg-red-100" onClick={() => load({ metric, month, buyerId, page })}>
                  <RefreshCw className="h-3.5 w-3.5" /> Retry
                </Button>
              ) : null}
            </div>
          ) : !shown ? null : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2" data-testid="overview-drilldown-summary">
                <Badge variant="secondary" className="px-2 py-1 text-xs" data-testid="overview-drilldown-total">
                  {formatCount(shown.total)} {isOrders ? (shown.total === 1 ? 'order' : 'orders') : (shown.total === 1 ? 'buyer' : 'buyers')}
                </Badge>
                <Badge variant="secondary" className="px-2 py-1 text-xs">Total {formatRm(shown.totalValue)}</Badge>
              </div>
              <p className="text-xs text-[var(--sera-muted)]">{shown.definition}</p>

              {!shown.reconciled ? (
                <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  These records ({formatCount(shown.total)}) do not reconcile with the dashboard figure ({formatCount(shown.headline)}). Please report this.
                </div>
              ) : null}
              {!isOrders && shown.ordersWithoutBuyer > 0 ? (
                <p className="text-xs text-amber-700">
                  {formatCount(shown.ordersWithoutBuyer)} confirmed {shown.ordersWithoutBuyer === 1 ? 'order has' : 'orders have'} no buyer organisation and {shown.ordersWithoutBuyer === 1 ? 'is' : 'are'} not counted as a buyer.
                </p>
              ) : null}

              {shown.total === 0 ? (
                <div className="rounded-lg border border-[var(--sera-line)] bg-[var(--sera-mist)] p-6 text-center text-sm text-[var(--sera-muted)]" data-testid="overview-drilldown-empty">
                  {isOrders ? 'No confirmed sales orders' : 'No active buyers'} in {shown.period.label}.
                </div>
              ) : (
                <>
                  <div className="max-h-[55vh] overflow-auto rounded-lg border border-[var(--sera-line)]">
                    <table className="w-full min-w-[640px] text-sm" data-testid="overview-drilldown-table">
                      <thead className="sticky top-0 bg-white">
                        <tr className="border-b border-[var(--sera-line)] text-left text-xs text-[var(--sera-muted)]">
                          {isOrders ? (
                            <>
                              <th className={th}>Sales Order No.</th>
                              <th className={th}>Order Date</th>
                              <th className={th}>Buyer / Organization</th>
                              <th className={th}>Status</th>
                              <th className={cn(th, 'text-right')}>Total Amount</th>
                              <th className={cn(th, 'text-right')}>Action</th>
                            </>
                          ) : (
                            <>
                              <th className={th}>Buyer / Organization</th>
                              <th className={th}>Buyer Reference</th>
                              <th className={cn(th, 'text-right')}>Sales Orders</th>
                              <th className={cn(th, 'text-right')}>Total Sales</th>
                              <th className={cn(th, 'text-right')}>Action</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {isOrders
                          ? (shown.rows as ConfirmedOrderRow[]).map((row) => {
                            const href = overviewOrderHref(row.orderId)
                            return (
                              <tr key={row.orderId} className="border-b border-[var(--sera-line)]/60 last:border-0" data-testid="overview-drilldown-row">
                                <td className={cn(td, 'font-medium text-[var(--sera-ink)]')}>
                                  {row.orderNo}
                                  <span className="block text-[11px] font-normal text-[var(--sera-muted)]">{row.orderType}</span>
                                </td>
                                <td className={cn(td, 'whitespace-nowrap')}>{formatReportDate(row.orderDate)}</td>
                                <td className={td}>
                                  <span className="text-[var(--sera-ink)]">{row.buyerName}</span>
                                  {row.buyerCode ? <span className="block text-[11px] text-[var(--sera-muted)]">{row.buyerCode}</span> : null}
                                </td>
                                <td className={td}>{STATUS_LABEL[row.status] ?? row.status}</td>
                                <td className={num}>{formatRm(row.value)}</td>
                                <td className={cn(td, 'text-right')}>
                                  {href ? (
                                    <a href={href} className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-[var(--sera-orange-deep,#c2410c)] hover:underline" aria-label={`View order ${row.orderNo}`}>
                                      View order <ExternalLink className="h-3 w-3" aria-hidden />
                                    </a>
                                  ) : '—'}
                                </td>
                              </tr>
                            )
                          })
                          : (shown.rows as ActiveBuyerRow[]).map((row) => (
                            <tr key={row.buyerId} className="border-b border-[var(--sera-line)]/60 last:border-0" data-testid="overview-drilldown-row">
                              <td className={td}>
                                <span className="font-medium text-[var(--sera-ink)]">{row.buyerName}</span>
                                <span className="block text-[11px] text-[var(--sera-muted)]">{row.orderTypes.join(' · ')}</span>
                              </td>
                              <td className={cn(td, 'whitespace-nowrap')}>{row.buyerCode || '—'}</td>
                              <td className={num}>{formatCount(row.orders)}</td>
                              <td className={num}>{formatRm(row.value)}</td>
                              <td className={cn(td, 'text-right')}>
                                <span className="inline-flex flex-wrap justify-end gap-x-3 gap-y-1">
                                  <button
                                    type="button"
                                    className="whitespace-nowrap text-xs font-medium text-[var(--sera-orange-deep,#c2410c)] hover:underline"
                                    onClick={() => onTargetChange({ metric: 'confirmed_orders', buyer: { id: row.buyerId, name: row.buyerName } })}
                                    aria-label={`View confirmed orders for ${row.buyerName}`}
                                  >
                                    View orders
                                  </button>
                                  <a href={overviewBuyerHref(row.buyerId)} className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-[var(--sera-muted)] hover:text-[var(--sera-ink)] hover:underline" aria-label={`View buyer ${row.buyerName}`}>
                                    View buyer <ExternalLink className="h-3 w-3" aria-hidden />
                                  </a>
                                </span>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--sera-muted)]">
                    <span data-testid="overview-drilldown-range">
                      Showing {formatCount(shown.page * shown.pageSize + 1)}–{formatCount(shown.page * shown.pageSize + shown.rows.length)} of {formatCount(shown.total)}
                    </span>
                    {shown.pageCount > 1 ? (
                      <span className="flex items-center gap-2">
                        <Button variant="outline" size="sm" className="h-7 px-2" disabled={shown.page === 0} onClick={() => setPage(shown.page - 1)} aria-label="Previous page">
                          <ChevronLeft className="h-3.5 w-3.5" />
                        </Button>
                        Page {shown.page + 1} of {shown.pageCount}
                        <Button variant="outline" size="sm" className="h-7 px-2" disabled={shown.page >= shown.pageCount - 1} onClick={() => setPage(shown.page + 1)} aria-label="Next page">
                          <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                      </span>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
