'use client'

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { casesToPieces, isWholeNumberEntry, piecesToWholeCases, type CountEntryUnit } from '@/lib/inventory/stock-count-units'

interface StockCountQuantityInputProps {
  /** The count in pieces, as stored on the row ('' = not counted). */
  value: string
  disabled?: boolean
  /** Receives the count in pieces. */
  onChange: (pieces: string) => void
  /** Known pieces per case: the row starts in Cases and the case size is fixed. */
  piecesPerCase?: number | null
  countInputId?: string
  onEnter?: () => void
}

export default function StockCountQuantityInput({ value, disabled, onChange, piecesPerCase, countInputId, onEnter }: StockCountQuantityInputProps) {
  const fixedSize = piecesPerCase && piecesPerCase > 1 ? piecesPerCase : null
  const casesFor = (pieces: string) => (fixedSize ? piecesToWholeCases(pieces, fixedSize) : null)
  const [unit, setUnit] = useState<CountEntryUnit>(() => (fixedSize && (value === '' || casesFor(value) !== null) ? 'case' : 'pcs'))
  const [cases, setCases] = useState(() => { const n = casesFor(value); return n === null ? '' : String(n) })
  const [perCase, setPerCase] = useState(fixedSize ? String(fixedSize) : '')
  const emitted = useRef(value)
  const perCaseRef = useRef<HTMLInputElement>(null)

  // A count replaced from outside (draft reload, Excel import, reset) is restated in
  // cases when it divides evenly by a known case size, otherwise shown in pieces.
  useEffect(() => {
    if (value === emitted.current) return
    emitted.current = value
    if (unit !== 'case') return
    const n = casesFor(value)
    if (value === '' && fixedSize) setCases('')
    else if (n !== null) setCases(String(n))
    else setUnit('pcs')
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const n = casesFor(value)
      setCases(n === null ? '' : String(n))
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
          <option value="case">Cases</option>
          <option value="pcs">Pieces</option>
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
          {fixedSize ? (
            <span>{fixedSize} pcs per case</span>
          ) : (
            <>
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
            </>
          )}
          <span className="font-semibold text-slate-700">= {value === '' ? '—' : Number(value).toLocaleString('en-US')} pcs</span>
        </div>
      )}
    </div>
  )
}
