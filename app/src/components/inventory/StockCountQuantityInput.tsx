'use client'

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { casesToPieces, isWholeNumberEntry, type CountEntryUnit } from '@/lib/inventory/stock-count-units'

interface StockCountQuantityInputProps {
  /** The count in pieces, as stored on the row ('' = not counted). */
  value: string
  disabled?: boolean
  /** Receives the count in pieces. */
  onChange: (pieces: string) => void
  countInputId?: string
  onEnter?: () => void
}

export default function StockCountQuantityInput({ value, disabled, onChange, countInputId, onEnter }: StockCountQuantityInputProps) {
  const [unit, setUnit] = useState<CountEntryUnit>('pcs')
  const [cases, setCases] = useState('')
  const [perCase, setPerCase] = useState('')
  const emitted = useRef(value)
  const perCaseRef = useRef<HTMLInputElement>(null)

  // A count replaced from outside (draft reload, Excel import, reset) is shown in pieces again.
  useEffect(() => {
    if (unit === 'case' && value !== emitted.current) setUnit('pcs')
  }, [unit, value])

  const changeCases = (nextCases: string, nextPerCase: string) => {
    if (!isWholeNumberEntry(nextCases) || !isWholeNumberEntry(nextPerCase)) return
    setCases(nextCases)
    setPerCase(nextPerCase)
    const pieces = casesToPieces(nextCases, nextPerCase)
    const next = pieces === null ? '' : String(pieces)
    emitted.current = next
    onChange(next)
  }

  const changeUnit = (next: CountEntryUnit) => {
    if (next === 'case') {
      emitted.current = value
      setCases('')
    }
    setUnit(next)
  }

  const enter = (event: React.KeyboardEvent<HTMLInputElement>, field: 'main' | 'perCase') => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (field === 'main' && unit === 'case' && perCase === '') perCaseRef.current?.focus()
    else onEnter?.()
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <select
          aria-label="Count unit"
          value={unit}
          disabled={disabled}
          onChange={event => changeUnit(event.target.value as CountEntryUnit)}
          className="h-10 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="pcs">Pieces</option>
          <option value="case">Cases</option>
        </select>
        <Input
          data-count-input={countInputId}
          aria-label={unit === 'pcs' ? 'Physical count in pieces' : 'Number of cases'}
          inputMode="numeric"
          min="0"
          value={unit === 'pcs' ? value : cases}
          disabled={disabled}
          onChange={event => unit === 'pcs' ? onChange(event.target.value) : changeCases(event.target.value, perCase)}
          onKeyDown={event => enter(event, 'main')}
          placeholder={unit === 'pcs' ? 'Blank' : 'Cases'}
          className="w-24 font-semibold tabular-nums"
        />
      </div>
      {unit === 'case' && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
          <span>×</span>
          <Input
            ref={perCaseRef}
            aria-label="Pieces per case"
            inputMode="numeric"
            min="1"
            value={perCase}
            disabled={disabled}
            onChange={event => changeCases(cases, event.target.value)}
            onKeyDown={event => enter(event, 'perCase')}
            placeholder="pcs"
            className="h-7 w-16 px-2 text-xs tabular-nums"
          />
          <span>pcs per case</span>
          <span className="font-semibold text-slate-700">= {value === '' ? '—' : Number(value).toLocaleString('en-US')} pcs</span>
        </div>
      )}
    </div>
  )
}
