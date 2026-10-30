'use client'

import {
  formatStockChange,
  formatStockQuantity,
  type StockQuantity,
} from '@/lib/inventory/stock-count-quantity'

/**
 * The single way an inventory quantity is shown anywhere in the product.
 *
 *   Cases  — deep blue, primary size/weight
 *   Pcs    — teal, smaller but readable, always labelled
 *
 * Colour never carries the meaning on its own: the unit is always spelled out,
 * so the same readout survives greyscale printing and colour blindness.
 *
 * A quantity of nothing renders muted ("0 cases"), and "+ 0 pcs" is impossible
 * by construction — formatStockQuantity()/formatStockChange() never emit it.
 */
export interface StockQuantityDisplayProps {
  /** The pair to show. Use stockQuantityFromRow() to read one out of a row. */
  quantity: StockQuantity
  /** `change` renders signed variance/movement values instead of a balance. */
  variant?: 'balance' | 'change'
  /** `sm` for table cells, `md` for drawers, `lg` for summary values. */
  size?: 'sm' | 'md' | 'lg'
  /** Extra classes for the wrapper (alignment, truncation, etc.). */
  className?: string
  /** Hide the secondary "+ n pcs" line and render one flat string (Excel/print). */
  inline?: boolean
  /**
   * Shown beneath the quantity (amber) when the unit or packing ratio is
   * genuinely uncertain — see resolveStockUnit().conflict. Never used for a
   * routine readout, so its presence always means "check this".
   */
  note?: string | null
  /**
   * Visual treatment.
   *   `emphasis` (default) — cases deep blue / pcs teal, used by input screens
   *                          (Stock Count, Add Stock).
   *   `table`              — View Inventory: production's table styling. Dark
   *                          `text-xs font-medium` figure with a smaller muted
   *                          unit label inline beside it, muted figure for zero,
   *                          teal "+ n pcs" secondary line.
   */
  tone?: 'emphasis' | 'table'
  /** `table` tone only: overrides the figure colour (e.g. orange Incoming). */
  figureClassName?: string
}

/**
 * Split a primary label into figure and unit: "3,861 cases" → ["3,861", "cases"].
 * A label without a unit word (unknown unit, "No change") has no unit part.
 */
export function splitQuantityLabel(primary: string): { figure: string; unit: string | null } {
  const match = /^(.*\S)\s+(cases?|pcs?)$/.exec(primary)
  return match ? { figure: match[1], unit: match[2] } : { figure: primary, unit: null }
}

/** Production table tokens (origin/main InventoryView). */
export const TABLE_QUANTITY_FIGURE = 'text-xs font-medium'
export const TABLE_QUANTITY_ZERO = 'text-[var(--sera-muted)]/70'
export const TABLE_QUANTITY_UNIT = 'ml-1 text-[11px] font-normal text-[var(--sera-muted)]'
/**
 * Clickable figure in View Inventory (Incoming and Reserved): orange, dotted
 * underline, hover deepen, keyboard focus ring. Only the number carries it;
 * the unit label beside it stays TABLE_QUANTITY_UNIT.
 */
export const CLICKABLE_QUANTITY_FIGURE = 'text-xs font-medium tabular-nums text-[var(--sera-orange)] underline decoration-dotted underline-offset-2 hover:text-[var(--sera-orange-deep)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/30 focus-visible:ring-offset-1 rounded-sm'

const SIZE_CLASSES = {
  sm: { primary: 'text-xs font-semibold', secondary: 'text-[11px] font-medium' },
  md: { primary: 'text-sm font-semibold', secondary: 'text-xs font-medium' },
  lg: { primary: 'text-lg font-bold', secondary: 'text-sm font-semibold' },
} as const

export default function StockQuantityDisplay({
  quantity,
  variant = 'balance',
  size = 'sm',
  className = '',
  inline = false,
  note = null,
  tone = 'emphasis',
  figureClassName,
}: StockQuantityDisplayProps) {
  const labels = variant === 'change' ? formatStockChange(quantity) : formatStockQuantity(quantity)
  const sizes = SIZE_CLASSES[size]

  if (tone === 'table' && !inline) {
    const { figure, unit } = splitQuantityLabel(labels.primary)
    const figureTone = labels.isZero ? TABLE_QUANTITY_ZERO : (figureClassName ?? '')
    return (
      <span className={`inline-flex flex-col leading-tight tabular-nums ${className}`} title={labels.text}>
        {/* Figure and unit never separate: "3,861 cases" stays on one line. */}
        <span className={`whitespace-nowrap ${TABLE_QUANTITY_FIGURE} ${figureTone}`}>
          {figure}
          {unit && <span className={TABLE_QUANTITY_UNIT}>{unit}</span>}
        </span>
        {labels.secondary && (
          <span className="whitespace-nowrap text-[11px] font-medium text-teal-600">{labels.secondary}</span>
        )}
        {note && (
          <span className="whitespace-nowrap text-[10px] font-medium text-amber-700" title={note}>
            {quantity.unit === 'unknown' ? 'Unit unconfirmed' : 'Check pack size'}
          </span>
        )}
      </span>
    )
  }
  // Cases are deep blue; any readout in pieces (a piece-stocked balance, or a
  // case product holding only loose pieces) is teal. The unit word is always
  // printed, so colour is reinforcement only.
  const primaryIsPcs = / pcs?$/.test(labels.primary)
  const primaryIsUnlabelled = quantity.unit === 'unknown' && !primaryIsPcs
  const muted = labels.isZero
    ? 'text-[var(--sera-muted)]'
    : primaryIsUnlabelled ? 'text-[var(--sera-ink)]' : primaryIsPcs ? 'text-teal-600' : 'text-blue-800'
  const pcsTone = labels.isZero ? 'text-[var(--sera-muted)]' : 'text-teal-600'

  if (inline) {
    return (
      <span className={`tabular-nums ${sizes.primary} ${labels.isZero ? 'text-[var(--sera-muted)]' : 'text-[var(--sera-ink)]'} ${className}`}>
        {labels.text}
        {note ? <span className="sr-only"> ({note})</span> : null}
      </span>
    )
  }

  return (
    <span className={`inline-flex flex-col leading-tight tabular-nums ${className}`}>
      <span className={`${sizes.primary} ${muted}`}>{labels.primary}</span>
      {labels.secondary && (
        <span className={`${sizes.secondary} ${pcsTone}`}>{labels.secondary}</span>
      )}
      {note && (
        <span className="text-[10px] font-medium text-amber-700" title={note}>
          {quantity.unit === 'unknown' ? 'Unit unconfirmed' : 'Check pack size'}
        </span>
      )}
    </span>
  )
}
