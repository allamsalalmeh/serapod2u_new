'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import type { StockCountUnit } from '@/lib/inventory/stock-count-catalog'
import { normalizeStockQuantity, parseStockQuantityEntry } from '@/lib/inventory/stock-count-quantity'

export interface StockCountQuantityValue {
  cases: string
  pcs: string
}

interface StockCountQuantityInputProps {
  /** Whole stock units as stored ('' = not counted). */
  cases: string
  /** Loose pieces as stored ('' = none typed). */
  pcs: string
  disabled?: boolean
  onChange: (next: StockCountQuantityValue) => void
  /**
   * Unit the product is stocked in: Cellera Hero/Zero are counted in cases,
   * every other product in pieces.
   */
  unit?: StockCountUnit
  /** Pieces in one stock case. Enables the adjacent Pcs box. */
  unitsPerCase?: number
  countInputId?: string
  onEnter?: () => void
}

/**
 * Two adjacent Physical Count boxes: Cases and Pcs.
 *
 * Case-stocked products get both boxes, piece-stocked products only Pcs. The
 * operator types freely — "100" cases and "7" pcs are accepted as typed — and
 * the entry is normalised when editing finishes (on blur), never on every
 * keystroke, so the cursor never jumps: 100 cases + 7 pcs at 4 pcs/case settles
 * to 101 cases + 3 pcs.
 *
 * Both boxes blank stays "not counted". It is never coerced to zero.
 */
export default function StockCountQuantityInput({
  cases,
  pcs,
  disabled,
  onChange,
  unit = 'pcs',
  unitsPerCase = 1,
  countInputId,
  onEnter,
}: StockCountQuantityInputProps) {
  const pack = unitsPerCase >= 1 ? Math.floor(unitsPerCase) : 1
  const hasPcsBox = unit === 'cases' && pack > 1
  const [casesDraft, setCasesDraft] = useState(cases)
  const [pcsDraft, setPcsDraft] = useState(pcs)

  // Re-sync when the row is reloaded (draft re-open, Excel import, filter).
  useEffect(() => { setCasesDraft(cases) }, [cases])
  useEffect(() => { setPcsDraft(pcs) }, [pcs])

  const entry = parseStockQuantityEntry(casesDraft, pcsDraft, pack)
  const digitsOnly = (raw: string) => raw.replace(/[^\d]/g, '')

  const normalise = () => {
    const parsed = parseStockQuantityEntry(casesDraft, pcsDraft, pack)
    if (parsed.error || parsed.quantity === null) {
      // Leave the operator's text alone so the message can be acted on.
      onChange({ cases: casesDraft, pcs: pcsDraft })
      return
    }
    const folded = normalizeStockQuantity(parsed.quantity.cases, parsed.quantity.pcs, pack)
    const next = { cases: String(folded.cases), pcs: folded.pcs === 0 ? '' : String(folded.pcs) }
    setCasesDraft(next.cases)
    setPcsDraft(next.pcs)
    onChange(next)
  }

  const keyHandler = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    normalise()
    onEnter?.()
  }

  if (!hasPcsBox) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <Input
            data-count-input={countInputId}
            aria-label={unit === 'cases' ? 'Physical count in cases' : 'Physical count in pieces'}
            inputMode="numeric"
            min="0"
            value={casesDraft}
            disabled={disabled}
            onChange={event => {
              const next = digitsOnly(event.target.value)
              // Single-box products keep their quantity in the row's stock unit,
              // which for a piece-stocked product IS pieces.
              setCasesDraft(next)
              onChange({ cases: next, pcs: '' })
            }}
            onBlur={normalise}
            onKeyDown={keyHandler}
            placeholder="Blank"
            className="w-24 font-semibold tabular-nums"
          />
          <span className="inline-flex h-6 items-center rounded-md bg-slate-100 px-2 text-[11px] font-medium text-slate-600">
            {unit === 'cases' ? 'cases' : 'pcs'}
          </span>
        </div>
        {entry.error && <p role="alert" className="text-[11px] font-medium text-red-600">{entry.error}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-1.5">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-800">Cases</span>
          <Input
            data-count-input={countInputId}
            aria-label="Physical count in cases"
            inputMode="numeric"
            min="0"
            value={casesDraft}
            disabled={disabled}
            onChange={event => {
              const next = digitsOnly(event.target.value)
              setCasesDraft(next)
              onChange({ cases: next, pcs: pcsDraft })
            }}
            onBlur={normalise}
            onKeyDown={keyHandler}
            placeholder="0"
            className="w-20 font-semibold tabular-nums"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-teal-600">Pcs</span>
          <Input
            aria-label="Physical count in extra pieces"
            inputMode="numeric"
            min="0"
            value={pcsDraft}
            disabled={disabled}
            onChange={event => {
              const next = digitsOnly(event.target.value)
              setPcsDraft(next)
              onChange({ cases: casesDraft, pcs: next })
            }}
            onBlur={normalise}
            onKeyDown={keyHandler}
            placeholder="0"
            className="w-16 font-semibold tabular-nums"
          />
        </label>
      </div>
      {entry.error && <p role="alert" className="text-[11px] font-medium text-red-600">{entry.error}</p>}
    </div>
  )
}
