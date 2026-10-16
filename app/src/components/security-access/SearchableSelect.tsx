'use client'

import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
  description?: string
  group?: string
  /** Extra text that matches the search box but is not shown. */
  keywords?: string
  /** Shown but not selectable (e.g. already held). */
  disabled?: boolean
}

interface SearchableSelectProps {
  label: string
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  emptyText?: string
  disabled?: boolean
  allowClear?: boolean
  hint?: string
  /** Server-side search: called as the user types; the list is then not filtered locally. */
  onQueryChange?: (query: string) => void
  loading?: boolean
}

export default function SearchableSelect({
  label, options, value, onChange, placeholder = 'Select…', emptyText = 'No matches.', disabled, allowClear, hint, onQueryChange, loading,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const selected = options.find(o => o.value === value)
  const groups = useMemo(() => {
    const map = new Map<string, SelectOption[]>()
    for (const option of options) {
      const key = option.group ?? ''
      map.set(key, [...(map.get(key) ?? []), option])
    }
    return Array.from(map.entries())
  }, [options])

  return (
    <div className="text-xs font-medium text-gray-600">
      <span>{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-label={label}
            disabled={disabled}
            className="mt-1 flex w-full items-center justify-between gap-2 rounded-lg border bg-white px-3 py-2 text-left text-sm font-normal text-gray-900 disabled:opacity-50"
          >
            <span className="min-w-0 flex-1 truncate">
              {selected ? (
                <>
                  <span>{selected.label}</span>
                  {selected.description && <span className="ml-2 text-xs text-gray-500">{selected.description}</span>}
                </>
              ) : <span className="text-gray-400">{placeholder}</span>}
            </span>
            {allowClear && selected
              ? <X className="h-4 w-4 shrink-0 text-gray-400" onClick={e => { e.stopPropagation(); onChange('') }} aria-label={`Clear ${label}`} />
              : <ChevronsUpDown className="h-4 w-4 shrink-0 text-gray-400" />}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[18rem] p-0" align="start">
          <Command shouldFilter={!onQueryChange}>
            <CommandInput placeholder={`Search ${label.toLowerCase()}…`} onValueChange={onQueryChange} />
            <CommandList className="max-h-72">
              <CommandEmpty>{loading ? 'Searching…' : emptyText}</CommandEmpty>
              {groups.map(([group, items]) => (
                <CommandGroup key={group || 'all'} heading={group || undefined}>
                  {items.map(option => (
                    <CommandItem
                      key={option.value}
                      disabled={option.disabled}
                      value={`${option.label} ${option.description ?? ''} ${option.keywords ?? ''} ${option.value}`}
                      onSelect={() => { onChange(option.value); setOpen(false) }}
                    >
                      <Check className={cn('mr-2 h-4 w-4 shrink-0', option.value === value ? 'opacity-100 text-orange-600' : 'opacity-0')} />
                      <div className="min-w-0">
                        <div className="truncate text-sm">{option.label}</div>
                        {option.description && <div className="truncate text-xs text-gray-500">{option.description}</div>}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {hint && <p className="mt-1 text-[11px] font-normal text-gray-400">{hint}</p>}
    </div>
  )
}
