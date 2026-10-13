'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { FOCUS } from './ui'
import { destinationTitle, type AdvancedDestination } from './advanced-nav'

/**
 * The one Advanced navigator: a compact grouped dropdown (single menu, no cascading submenus). Group headings are
 * non-selectable; choosing a destination opens it directly. Closed by default.
 * Keys: Enter/Space/ArrowDown opens; Arrow keys/Home/End move; Enter/Space selects; Escape or Tab closes (Escape refocuses the button).
 */
export default function AdvancedNav({ destinations, current, onSelect }: {
  destinations: AdvancedDestination[]; current: AdvancedDestination; onSelect: (d: AdvancedDestination) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const options = useRef<Array<HTMLElement | null>>([])
  const uid = useId()
  const menuId = `${uid}-menu`

  const focusOption = (i: number) => {
    const n = destinations.length
    options.current[((i % n) + n) % n]?.focus()
  }
  useEffect(() => {
    if (!open) return
    focusOption(Math.max(0, destinations.findIndex(d => d.id === current.id)))
    const onDown = (e: Event) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const close = (refocus: boolean) => { setOpen(false); if (refocus) button.current?.focus({ preventScroll: true }) }
  const choose = (d: AdvancedDestination) => { close(true); if (d.id !== current.id) onSelect(d) }
  const onMenuKey = (e: React.KeyboardEvent) => {
    const i = options.current.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
    else if (e.key === 'Tab') close(false)
    else if (e.key === 'ArrowDown') { e.preventDefault(); focusOption(i + 1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusOption(i - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusOption(0) }
    else if (e.key === 'End') { e.preventDefault(); focusOption(destinations.length - 1) }
  }

  let lastGroup: string | undefined
  return (
    <div ref={root} className="relative">
      <button ref={button} type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={`Advanced destination: ${destinationTitle(current)}`}
        onClick={() => setOpen(v => !v)}
        onKeyDown={e => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); setOpen(true) } }}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50 sm:w-auto sm:min-w-[20rem] ${FOCUS}`}>
        <span className="min-w-0 truncate"><span className="font-normal text-gray-500">Advanced: </span>{destinationTitle(current)}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && <div id={menuId} role="listbox" aria-label="Advanced destinations" onKeyDown={onMenuKey}
        className="absolute left-0 top-full z-30 mt-1 max-h-[70vh] w-full overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg sm:w-80">
        {destinations.map((d, i) => {
          const heading = d.group && d.group !== lastGroup ? d.group : null
          lastGroup = d.group
          const selected = d.id === current.id
          return <div key={d.id} role="presentation">
            {heading && <div role="presentation" className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{heading}</div>}
            <div ref={el => { options.current[i] = el }} role="option" aria-selected={selected} tabIndex={-1}
              aria-label={destinationTitle(d)}
              onClick={() => choose(d)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); choose(d) } }}
              className={`flex cursor-pointer items-center justify-between gap-2 py-1.5 pr-3 text-sm ${d.group ? 'pl-6' : 'pl-3 font-medium'} ${selected ? 'bg-orange-50 text-orange-700' : 'text-gray-800 hover:bg-gray-50'} ${FOCUS}`}>
              <span>{d.label}</span>{selected && <Check className="h-4 w-4 shrink-0" aria-hidden />}
            </div>
          </div>
        })}
      </div>}
    </div>
  )
}
