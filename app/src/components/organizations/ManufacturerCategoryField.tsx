'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, Loader2, Package, Plus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { InfoPopover } from '@/components/security-access/ui'
import {
  categoriesOutsideClassification,
  categoryLabel,
  manufacturerProductsHref,
  suggestedCategories,
  type AssignedCategory,
  type CategoryFormMode,
  type CategoryOption,
  type ManufacturerCategorySummary,
} from '@/lib/organizations/manufacturer-categories'

interface ManufacturerCategoryFieldProps {
  mode: CategoryFormMode
  /** Product Master categories the viewer can read (inactive ones are offered only when already assigned). */
  options: CategoryOption[]
  /** Saved assignments; [] for a new manufacturer. */
  savedIds: string[]
  value: string[]
  onChange: (ids: string[]) => void
  /** Edit only: assigned + linked-product categories. null = could not be read. */
  summary?: ManufacturerCategorySummary | null
  summaryLoading?: boolean
  manufacturerId?: string
  error?: string | null
  disabled?: boolean
}

type Chip = { id: string; label: string; inactive: boolean }

/** Product Categories multi-select shared by Add and Edit Organization (manufacturers only). */
export default function ManufacturerCategoryField({
  mode,
  options,
  savedIds,
  value,
  onChange,
  summary,
  summaryLoading = false,
  manufacturerId,
  error,
  disabled = false,
}: ManufacturerCategoryFieldProps) {
  const [open, setOpen] = useState(false)

  const assignedById = useMemo(() => {
    const map = new Map<string, AssignedCategory>()
    for (const category of summary?.assigned || []) map.set(category.category_id, category)
    return map
  }, [summary])
  const optionById = useMemo(() => new Map(options.map((option) => [option.id, option])), [options])

  const describe = (id: string): Chip => {
    const option = optionById.get(id)
    if (option) return { id, label: option.category_name, inactive: option.is_active !== true }
    const assigned = assignedById.get(id)
    // Hidden by RLS (inactive category, non-HQ viewer) or deleted: keep it visible and honest.
    return { id, label: assigned ? categoryLabel(assigned) : 'Unavailable category', inactive: true }
  }

  const saved = new Set(savedIds)
  const pickable = options.filter((option) => option.is_active === true || saved.has(option.id))
  const selected = new Set(value)
  const chips = value.map(describe).sort((a, b) => a.label.localeCompare(b.label))

  const toggle = (id: string, checked: boolean) => {
    onChange(checked ? Array.from(new Set([...value, id])) : value.filter((current) => current !== id))
  }

  const derived = summary?.derived || []
  const suggestions = mode === 'edit' ? suggestedCategories(value, derived) : []
  const outside = mode === 'edit' && savedIds.length > 0 ? categoriesOutsideClassification(savedIds, derived) : []
  const outsideProducts = outside.reduce((total, category) => total + category.product_count, 0)

  return (
    <div className="space-y-2" data-testid="manufacturer-categories">
      <div className="flex flex-wrap items-center gap-1.5">
        <Label htmlFor="manufacturer-categories-trigger" className="mb-0">
          Product Categories{mode === 'create' ? ' *' : ''}
        </Label>
        <InfoPopover label="About manufacturer product categories">
          <p>The Product Master categories this manufacturer supplies. Select every category that applies.</p>
          <p>This is a classification only. It does not change products, ordering, product pickers, QR codes, loyalty programs or access.</p>
          {mode === 'edit' && (
            <p>
              &ldquo;Found in linked products&rdquo; is read from products that name this manufacturer. Those categories are
              suggestions and are saved only when you select them.
            </p>
          )}
        </InfoPopover>
        {mode === 'edit' && savedIds.length === 0 && (
          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[11px] font-medium text-amber-700">
            Not classified
          </Badge>
        )}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="manufacturer-categories-trigger"
            type="button"
            variant="outline"
            disabled={disabled}
            aria-invalid={Boolean(error)}
            className={`h-10 w-full justify-between font-normal ${error ? 'border-red-300' : ''}`}
          >
            <span className={value.length ? 'text-[var(--sera-ink)]' : 'text-[var(--sera-muted)]'}>
              {value.length ? `${value.length} selected` : 'Select categories'}
            </span>
            <ChevronDown className="h-4 w-4 opacity-60" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-56 p-1">
          {pickable.length === 0 ? (
            <p className="px-2 py-3 text-xs text-[var(--sera-muted)]">No active Product Master categories.</p>
          ) : (
            <div role="group" aria-label="Product categories" className="max-h-64 overflow-y-auto">
              {pickable.map((option) => {
                const inputId = `mfg-category-${option.id}`
                return (
                  <label
                    key={option.id}
                    htmlFor={inputId}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-gray-50"
                  >
                    <Checkbox
                      id={inputId}
                      checked={selected.has(option.id)}
                      onCheckedChange={(checked) => toggle(option.id, checked === true)}
                    />
                    <span className="flex-1">{option.category_name}</span>
                    {option.is_active !== true && (
                      <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Inactive</span>
                    )}
                  </label>
                )
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Selected product categories">
          {chips.map((chip) => (
            <span
              key={chip.id}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                chip.inactive
                  ? 'border-gray-200 bg-gray-50 text-gray-500'
                  : 'border-[var(--sera-orange)]/25 bg-[var(--sera-orange)]/[0.06] text-[var(--sera-orange-deep)]'
              }`}
            >
              {chip.label}
              {chip.inactive && <span className="text-[10px] uppercase tracking-wide">· Inactive</span>}
              <button
                type="button"
                disabled={disabled}
                onClick={() => toggle(chip.id, false)}
                aria-label={`Remove ${chip.label}`}
                className="rounded-full p-0.5 hover:bg-black/5"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}

      {mode === 'edit' && (
        <div className="space-y-1.5 rounded-lg border border-[var(--sera-line)] bg-gray-50/60 px-3 py-2 text-xs text-[var(--sera-muted)]">
          {summaryLoading ? (
            <p className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Checking linked products…</p>
          ) : summary === null ? (
            <p>Linked products could not be read.</p>
          ) : !summary || summary.product_count === 0 ? (
            <p>No linked products yet</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  Found in {summary.product_count} linked product{summary.product_count === 1 ? '' : 's'}
                  {summary.uncategorized_product_count > 0 && ` · ${summary.uncategorized_product_count} without a category`}
                </span>
                {manufacturerId && (
                  <Link
                    href={manufacturerProductsHref(manufacturerId)}
                    className="inline-flex items-center gap-1 font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline"
                  >
                    <Package className="h-3 w-3" aria-hidden /> View products
                  </Link>
                )}
              </div>
              {derived.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {derived.map((category) => (
                    <span key={category.category_id} className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-gray-700">
                      {categoryLabel(category)} ({category.product_count})
                    </span>
                  ))}
                </div>
              )}
              {suggestions.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span>Suggested:</span>
                  {suggestions.map((category) => (
                    <button
                      key={category.category_id}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggle(category.category_id, true)}
                      className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-[var(--sera-orange)]/40 px-2 py-0.5 text-[var(--sera-orange-deep)] hover:bg-[var(--sera-orange)]/[0.06]"
                      aria-label={`Assign ${categoryLabel(category)}`}
                    >
                      <Plus className="h-3 w-3" aria-hidden /> {categoryLabel(category)}
                    </button>
                  ))}
                </div>
              )}
              {outside.length > 0 && (
                <div className="flex items-center gap-1.5 text-amber-700">
                  <span>
                    {outsideProducts} linked product{outsideProducts === 1 ? '' : 's'} use{outsideProducts === 1 ? 's' : ''} other categories
                  </span>
                  <InfoPopover label="About the category mismatch" align="right">
                    <p>These linked products use categories outside this manufacturer&apos;s saved classification:</p>
                    <ul className="list-disc pl-4">
                      {outside.map((category) => (
                        <li key={category.category_id}>
                          {categoryLabel(category)}
                          {category.is_active === false ? ' (inactive)' : ''}: {category.product_count} product{category.product_count === 1 ? '' : 's'}
                        </li>
                      ))}
                    </ul>
                    <p>Nothing is changed automatically. Products keep their category and stay linked; add the category here or correct the product if needed.</p>
                  </InfoPopover>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
