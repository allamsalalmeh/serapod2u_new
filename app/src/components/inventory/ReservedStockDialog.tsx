'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AlertTriangle, Lock, PackageCheck } from 'lucide-react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { formatStockQuantity, type StockQuantity } from '@/lib/inventory/stock-count-quantity'
import {
  isExpectedReservingStatus,
  reservationStatusLabel,
  type ReservationSourceType,
} from '@/lib/inventory/reserved-stock'
import {
  loadReservationBreakdown,
  type ReservationLoadResult,
} from '@/lib/inventory/reserved-stock-loader'
import { splitQuantityLabel, TABLE_QUANTITY_UNIT } from './StockQuantityDisplay'

export interface ReservedStockDialogProps {
  open: boolean
  onClose: () => void
  variantId: string
  warehouseOrgId: string
  warehouseName: string | null
  productName: string
  variantName: string
  /** Configurations included in the clicked row (whole flavour or one configuration). */
  configIds: string[]
  /** Whole-flavour rows may also claim legacy ledger rows without a configuration. */
  includeUnconfigured: boolean
  /** Configuration label when the click came from a single configuration row. */
  scopeLabel?: string | null
  /** The Reserved figure that was clicked (stored quantity_allocated). */
  storedReserved: number
  /** Unit context for the figures (resolved by the aggregation). */
  unit: StockQuantity['unit']
  pcsPerCase: number
}

/** Same affordance as the Incoming popup's links. */
const LINK_CLASSES =
  'text-xs font-medium text-[var(--sera-orange)] underline decoration-dotted underline-offset-2 ' +
  'hover:text-[var(--sera-orange-deep)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/30 ' +
  'focus-visible:ring-offset-1 rounded-sm'

/**
 * Reserved detail for one variant at one warehouse: the records currently
 * holding product_inventory.quantity_allocated, from the allocation ledger.
 * Opening it never writes, releases or recalculates a reservation.
 */
export default function ReservedStockDialog({
  open,
  onClose,
  variantId,
  warehouseOrgId,
  warehouseName,
  productName,
  variantName,
  configIds,
  includeUnconfigured,
  scopeLabel,
  storedReserved,
  unit,
  pcsPerCase,
}: ReservedStockDialogProps) {
  const [result, setResult] = useState<ReservationLoadResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const { isReady, supabase } = useSupabaseAuth()
  const configKey = configIds.join(',')

  useEffect(() => {
    if (!open || !isReady || !variantId || !warehouseOrgId) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    loadReservationBreakdown(supabase, {
      variantId,
      warehouseOrgId,
      configIds: configKey ? configKey.split(',') : [],
      includeUnconfigured,
      storedReserved,
    })
      .then(value => { if (!cancelled) setResult(value) })
      .catch((error: any) => {
        console.error('Failed to load reserved stock detail:', error)
        if (!cancelled) setLoadError(error?.message || 'Failed to load reserved stock')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, isReady, variantId, warehouseOrgId, configKey, includeUnconfigured, storedReserved, supabase, attempt])

  const retry = useCallback(() => setAttempt(value => value + 1), [])

  const quantityText = (value: number) => formatStockQuantity({ cases: value, pcs: 0, pcsPerCase, unit }).primary
  const renderQuantity = (value: number, tone = '') => {
    const { figure, unit: label } = splitQuantityLabel(quantityText(value))
    return (
      <span className={`whitespace-nowrap text-xs font-medium tabular-nums ${tone}`}>
        {figure}
        {label && <span className={TABLE_QUANTITY_UNIT}>{label}</span>}
      </span>
    )
  }

  const formatDate = (value?: string | null) => {
    if (!value) return '—'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-GB')
  }

  const statusBadge = (sourceType: ReservationSourceType, status: string | null) => {
    if (!status) return <span className="text-xs text-[var(--sera-muted)]">—</span>
    const expected = isExpectedReservingStatus(sourceType, status)
    return (
      <Badge
        variant="outline"
        className={expected
          ? 'bg-[var(--sera-orange)]/[0.06] text-[var(--sera-orange-deep)] border-[var(--sera-orange)]/20'
          : 'bg-amber-50 text-amber-800 border-amber-200'}
        title={expected ? undefined : 'The ledger shows a reservation, but this status does not normally hold one. Review the record.'}
      >
        {reservationStatusLabel(sourceType, status)}
      </Badge>
    )
  }

  const rows = result?.rows ?? []
  const multipleSources = (result?.sources.length ?? 0) > 1
  const unreconciled = result?.unreconciled ?? 0
  const context = [scopeLabel, warehouseName].filter(Boolean).join(' · ')

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose() }}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="h-5 w-5 text-[var(--sera-ink)]" />
            Reserved Stock — {quantityText(storedReserved)}
          </DialogTitle>
          <DialogDescription>
            {productName} [{variantName}]{context ? ` — ${context}` : ''}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="py-8 text-center text-sm text-[var(--sera-muted)]">Loading reserved stock...</p>
        ) : loadError ? (
          <div className="py-8 text-center">
            <p className="text-sm text-red-600">{loadError}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={retry}>Retry</Button>
          </div>
        ) : !result ? null : (
          <div className="max-h-[480px] space-y-4 overflow-y-auto">
            {result.restrictedCount > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-[var(--sera-line)] bg-[var(--sera-ink)]/[0.03] px-3 py-2 text-xs text-[var(--sera-muted)]">
                <Lock className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  {result.restrictedCount} reserving record{result.restrictedCount === 1 ? ' is' : 's are'} outside your access.
                  Only the reserved quantity is shown; reference, party and status are hidden.
                </span>
              </div>
            )}

            {rows.length === 0 ? (
              <p className="rounded-md bg-[var(--sera-ink)]/[0.03] px-3 py-3 text-xs text-[var(--sera-muted)]/80">
                No order or transfer currently holds a reservation on this stock.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference No.</TableHead>
                    {multipleSources && <TableHead>Source</TableHead>}
                    <TableHead>Buyer / Destination</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Reserved</TableHead>
                    <TableHead>Reserved Since</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(row => (
                    <TableRow key={row.key}>
                      <TableCell className="text-xs">
                        {row.accessible ? (row.referenceNo || '—') : (
                          <span className="inline-flex items-center gap-1 text-[var(--sera-muted)]"><Lock className="h-3 w-3" />Restricted record</span>
                        )}
                      </TableCell>
                      {multipleSources && (
                        <TableCell className="text-xs">{row.sourceType === 'order' ? 'Sales order' : 'Stock transfer'}</TableCell>
                      )}
                      <TableCell className="text-xs">{row.counterpartyName || '—'}</TableCell>
                      <TableCell>{row.accessible ? statusBadge(row.sourceType, row.status) : <span className="text-xs text-[var(--sera-muted)]">—</span>}</TableCell>
                      <TableCell className="text-right">{renderQuantity(row.reserved)}</TableCell>
                      <TableCell className="text-xs text-[var(--sera-muted)]">{formatDate(row.reservedSince)}</TableCell>
                      <TableCell className="text-right">
                        {row.href ? (
                          <Link
                            href={row.href}
                            onClick={onClose}
                            className={LINK_CLASSES}
                            title={`Open ${row.sourceType === 'order' ? 'order' : 'transfer'} ${row.referenceNo ?? ''}`.trim()}
                          >
                            View
                          </Link>
                        ) : (
                          <span className="text-xs text-[var(--sera-muted)]">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {/* Reconciliation: always shown, totals across ALL records. */}
            <div className="rounded-md border border-[var(--sera-line)] px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[var(--sera-muted)]">Attributed to records above</span>
                {renderQuantity(result.attributedTotal)}
              </div>
              {unreconciled !== 0 && (
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-amber-800">
                  <span className="inline-flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {unreconciled > 0
                      ? 'Not attributable to an open order or transfer (legacy / unattributed reservation)'
                      : 'Ledger reservations exceed the stored Reserved figure'}
                  </span>
                  {renderQuantity(Math.abs(unreconciled), 'text-amber-800')}
                </div>
              )}
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--sera-line)] pt-1">
                <span className="font-medium text-[var(--sera-ink)]">Reserved (stored)</span>
                {renderQuantity(result.storedTotal)}
              </div>
              {(unreconciled !== 0 || result.anomalies.length > 0) && (
                <p className="mt-1 text-[11px] text-[var(--sera-muted)]">
                  Shown as recorded; nothing was changed.
                  {result.anomalies.length > 0 && ` ${result.anomalies.length} ledger entr${result.anomalies.length === 1 ? 'y releases' : 'ies release'} more than it reserved.`}
                  {result.cutoffBoundaryUncertain && ' The opening cut-off count for this warehouse could not be read, so pre-cut-off reservations may be included.'}
                  {' '}See docs/inventory/CASES_AND_PCS_IMPLEMENTATION.md §13.
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
