'use client'

import { formatStockQuantity, type StockQuantity } from '@/lib/inventory/stock-count-quantity'
import StockQuantityDisplay, { CLICKABLE_QUANTITY_FIGURE, splitQuantityLabel, TABLE_QUANTITY_UNIT } from './StockQuantityDisplay'

/**
 * The Reserved figure in View Inventory.
 *   zero     → plain muted text, not clickable
 *   non-zero → the Incoming figure styling (CLICKABLE_QUANTITY_FIGURE): orange,
 *              dotted underline, hover, focus ring; muted unit label beside it.
 * Activation (click / Enter / Space) never bubbles to the row's expand toggle.
 */
export default function ReservedQuantityTrigger({
  reserved,
  pcsPerCase,
  unit,
  onOpen,
  align = 'start',
}: {
  reserved: number
  pcsPerCase: number
  unit: StockQuantity['unit']
  onOpen: () => void
  align?: 'start' | 'end'
}) {
  if (reserved <= 0) {
    return (
      <StockQuantityDisplay
        quantity={{ cases: reserved, pcs: 0, pcsPerCase, unit }}
        tone="table"
        className={align === 'end' ? 'items-end' : 'items-start'}
      />
    )
  }
  const { figure, unit: label } = splitQuantityLabel(
    formatStockQuantity({ cases: reserved, pcs: 0, pcsPerCase, unit }).primary,
  )
  return (
    <span className="whitespace-nowrap">
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onOpen() }}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}
        className={CLICKABLE_QUANTITY_FIGURE}
        title="View the orders and transfers reserving this stock"
        aria-label={`View reservations for ${formatStockQuantity({ cases: reserved, pcs: 0, pcsPerCase, unit }).text}`}
      >
        {figure}
      </button>
      {label && <span className={TABLE_QUANTITY_UNIT}>{label}</span>}
    </span>
  )
}
