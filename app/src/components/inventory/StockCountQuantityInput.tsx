'use client'

import { Input } from '@/components/ui/input'
import type { StockCountUnit } from '@/lib/inventory/stock-count-catalog'

interface StockCountQuantityInputProps {
  /** The count as stored on the row, in the row's stock unit ('' = not counted). */
  value: string
  disabled?: boolean
  onChange: (count: string) => void
  /**
   * Unit the product is stocked in: Cellera Hero/Zero are counted in cases,
   * every other product in pieces. The entry is never converted.
   */
  unit?: StockCountUnit
  countInputId?: string
  onEnter?: () => void
}

export default function StockCountQuantityInput({ value, disabled, onChange, unit = 'pcs', countInputId, onEnter }: StockCountQuantityInputProps) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        data-count-input={countInputId}
        aria-label={unit === 'cases' ? 'Physical count in cases' : 'Physical count in pieces'}
        inputMode="numeric"
        min="0"
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          onEnter?.()
        }}
        placeholder="Blank"
        className="w-24 font-semibold tabular-nums"
      />
      <span className="inline-flex h-6 items-center rounded-md bg-slate-100 px-2 text-[11px] font-medium text-slate-600">
        {unit}
      </span>
    </div>
  )
}
