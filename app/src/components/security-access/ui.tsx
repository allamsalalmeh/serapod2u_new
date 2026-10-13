'use client'

/**
 * Small shared presentation pieces for the Security & Access tabs (compact,
 * accessible, one design language). Presentation only.
 */
import { useEffect, useId, useRef, useState, type Ref } from 'react'
import { ChevronDown, ChevronRight, Info, Plus, Search, X } from 'lucide-react'
import { rolloutMode } from '@/lib/security-access/rollout'
import { moduleGroupName, moduleGroupRank } from '@/lib/security-access/modules'

/** Base size for grouped lists (headings, row names): matches Migration modes / Group Policies. Detail text stays text-xs. */
export const LIST_TEXT = 'text-sm'
export const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500'

export function ModeStatus({ mode, short }: { mode: string; short?: boolean }) {
  const m = rolloutMode(mode)
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${m.text}`} title={m.help}>
      <span className={`h-2 w-2 rounded-full ${m.dot}`} aria-hidden />{short ? m.shortLabel : m.label}
    </span>
  )
}

/** Chevron + label as one expansion control. */
export function ToggleButton({ open, onClick, label, children, controls, className = '' }: {
  open: boolean; onClick: () => void; label: string; children: React.ReactNode; controls?: string; className?: string
}) {
  return (
    <button type="button" onClick={onClick} aria-expanded={open} aria-controls={controls} aria-label={`${label}, ${open ? 'collapse' : 'expand'}`}
      className={`flex min-w-0 items-center gap-2 rounded text-left ${className} ${FOCUS}`}>
      {open ? <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />}
      {children}
    </button>
  )
}

export function SearchInput({ value, onChange, placeholder, label, className = 'sm:w-64' }: {
  value: string; onChange: (v: string) => void; placeholder: string; label: string; className?: string
}) {
  return (
    <label className={`relative min-w-0 flex-1 sm:flex-none ${className}`}>
      <span className="sr-only">{label}</span>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full rounded-lg border border-gray-200 py-1.5 pl-9 pr-8 text-sm focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100" />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search"
          className={`absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:text-gray-700 ${FOCUS}`}>
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </label>
  )
}

/** Arrow/Home/End roving focus for a tablist; stops propagation so a nested tablist never drives the outer one. */
export function onTabKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const tabsEls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(':scope > [role="tab"]'))
  const idx = tabsEls.indexOf(document.activeElement as HTMLElement)
  if (idx < 0) return
  e.preventDefault(); e.stopPropagation()
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabsEls.length - 1 : (idx + (e.key === 'ArrowRight' ? 1 : -1) + tabsEls.length) % tabsEls.length
  tabsEls[next].focus(); tabsEls[next].click()
}

/** Secondary navigation inside a tab (underlined, like the main tabs but smaller). */
export function SectionTabs<T extends string>({ value, onChange, items, label }: {
  value: T; onChange: (v: T) => void; items: Array<{ id: T; label: string; count?: number | null }>; label: string
}) {
  return (
    <div role="tablist" aria-label={label} onKeyDown={onTabKeyDown} className="flex gap-1 overflow-x-auto rounded-lg border border-gray-200 bg-white p-1">
      {items.map(item => {
        const active = item.id === value
        return (
          <button key={item.id} type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} onClick={() => onChange(item.id)}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${active ? 'bg-orange-50 text-orange-700' : 'text-gray-600 hover:bg-gray-50'} ${FOCUS}`}>
            {item.label}
            {typeof item.count === 'number' && <span className={`ml-1.5 text-xs ${active ? 'text-orange-600' : 'text-gray-400'}`}>{item.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Filter chips that also act as the summary counts. */
export function FilterChips<T extends string>({ value, onChange, items, label }: {
  value: T; onChange: (v: T) => void; items: Array<{ id: T; label: string; count?: number }>; label: string
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {items.map(item => {
        const active = item.id === value
        return (
          <button key={item.id} type="button" aria-pressed={active} onClick={() => onChange(item.id)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${active ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'} ${FOCUS}`}>
            {item.label}{typeof item.count === 'number' && <span className="ml-1 tabular-nums">{item.count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** A form or detail block that stays closed until asked for. */
export function DisclosurePanel({ title, description, info, open, onToggle, actionLabel, children, headingRef }: {
  headingRef?: Ref<HTMLHeadingElement>; title: string; description?: string; /** Long explanation tucked behind a small ⓘ instead of a visible paragraph. */ info?: React.ReactNode; open: boolean; onToggle: () => void; actionLabel: string; children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5"><h3 ref={headingRef} tabIndex={headingRef ? -1 : undefined} className="scroll-mt-24 font-semibold text-gray-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">{title}</h3>
            {info && <InfoPopover label={`About ${title}`}>{info}</InfoPopover>}</div>
          {description && <p className="text-sm text-gray-500">{description}</p>}
        </div>
        <button type="button" onClick={onToggle} aria-expanded={open}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ${open ? 'border border-gray-200 text-gray-700 hover:bg-gray-50' : 'bg-orange-500 text-white hover:bg-orange-600'} ${FOCUS}`}>
          {open ? <X className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}{open ? 'Close' : actionLabel}
        </button>
      </div>
      {open && <div className="border-t border-gray-100">{children}</div>}
    </section>
  )
}

/** A quiet collapsible block for secondary information. */
export function Collapsible({ title, meta, defaultOpen = false, children }: {
  title: string; meta?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <ToggleButton open={open} onClick={() => setOpen(!open)} label={title}>
          <span className="font-semibold text-gray-950">{title}</span>
        </ToggleButton>
        {meta && <div className="text-xs text-gray-500">{meta}</div>}
      </div>
      {open && <div className="border-t border-gray-100">{children}</div>}
    </section>
  )
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-sm text-gray-500">{children}</p>
}

export function Feedback({ message }: { message: { tone: 'ok' | 'error'; text: string } | null }) {
  if (!message) return null
  return <div role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{message.text}</div>
}

/** "Show more" paging for long lists. */
export function useLimit(step = 25) {
  const [limit, setLimit] = useState(step)
  return { limit, more: () => setLimit(l => l + step), reset: () => setLimit(step), step }
}

export function ShowMore({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  if (shown >= total) return null
  return (
    <div className="border-t border-gray-100 px-4 py-2 text-center">
      <button type="button" onClick={onMore} className={`rounded text-sm font-medium text-orange-600 hover:text-orange-700 ${FOCUS}`}>
        Show more <span className="text-gray-400">({shown} of {total})</span>
      </button>
    </div>
  )
}

/**
 * Module filter (shared S&A taxonomy). Lists only the module groups present in
 * `available`; filtering is display only and never narrows authorization.
 */
export function ModuleFilterSelect({ value, onChange, available, label = 'Module' }: {
  value: string; onChange: (v: string) => void; available: Iterable<string>; label?: string
}) {
  const ids = Array.from(new Set(available)).sort((a, b) => moduleGroupRank(a) - moduleGroupRank(b))
  return (
    <select value={value} onChange={e => onChange(e.target.value)} aria-label={label}
      className={`rounded-lg border border-gray-200 bg-white py-1.5 pl-2.5 pr-7 text-sm text-gray-700 ${FOCUS}`}>
      <option value="all">All modules</option>
      {ids.map(id => <option key={id} value={id}>{moduleGroupName(id)}</option>)}
    </select>
  )
}

/**
 * Circled information icon with a readable popover (descriptions and explanatory notes).
 * Opens on hover, keyboard focus and click/tap; stays open while the pointer or focus is inside it;
 * Escape or an outside click closes it (Escape returns focus to the icon). It is a sibling of accordion
 * buttons and stops click propagation, so it never toggles the surrounding row. Informational only:
 * errors, validation and assignment warnings stay visible elsewhere.
 */
export function InfoPopover({ label, children, className = '', align = 'left' }: { label: string; children: React.ReactNode; className?: string; align?: 'left' | 'right' }) {
  const [pinned, setPinned] = useState(false)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()
  const open = pinned || hover || focus
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPinned(false); setHover(false); setFocus(false); button.current?.focus({ preventScroll: true }); e.stopPropagation() } }
    const onDown = (e: Event) => { if (root.current && !root.current.contains(e.target as Node)) { setPinned(false); setHover(false); setFocus(false) } }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown)
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('pointerdown', onDown) }
  }, [open])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const enter = () => { if (timer.current) clearTimeout(timer.current); setHover(true) }
  const leave = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setHover(false), 150) }
  return (
    <span ref={root} className={`relative inline-flex ${className}`} onMouseEnter={enter} onMouseLeave={leave}
      onBlur={e => { if (!root.current?.contains(e.relatedTarget as Node)) setFocus(false) }}>
      <button ref={button} type="button" aria-label={label} aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
        onClick={e => { e.stopPropagation(); setPinned(v => !v) }} onFocus={() => setFocus(true)}
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full border border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700 ${FOCUS}`}>
        <Info className="h-3 w-3" aria-hidden />
      </button>
      {open && <div id={id} role="dialog" aria-label={label} onClick={e => e.stopPropagation()}
        className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-full z-30 mt-1 w-80 max-w-[calc(100vw-2rem)] max-sm:fixed max-sm:inset-x-4 max-sm:bottom-4 max-sm:top-auto max-sm:mt-0 max-sm:max-h-[60vh] max-sm:w-auto max-sm:overflow-y-auto space-y-1.5 rounded-lg border border-gray-200 bg-white p-3 text-left text-xs font-normal leading-relaxed text-gray-700 shadow-lg`}>
        {children}
      </div>}
    </span>
  )
}
