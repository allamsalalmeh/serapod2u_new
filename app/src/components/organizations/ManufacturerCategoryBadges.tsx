'use client'

import Link from 'next/link'
import { Package } from 'lucide-react'
import {
  categoriesOutsideClassification,
  categoryLabel,
  manufacturerProductsHref,
  type ManufacturerCategorySummary,
} from '@/lib/organizations/manufacturer-categories'

/** Compact assigned-category badges plus linked-product facts for a manufacturer row/card. */
export default function ManufacturerCategoryBadges({
  manufacturerId,
  summary,
  showProductsLink = false,
}: {
  manufacturerId: string
  /** undefined = loading/not loaded, null = unavailable */
  summary: ManufacturerCategorySummary | null | undefined
  showProductsLink?: boolean
}) {
  if (!summary) return null
  const assignedIds = summary.assigned.map((category) => category.category_id)
  const outside = categoriesOutsideClassification(assignedIds, summary.derived)
  const derivedNames = summary.derived.map(categoryLabel).join(', ')
  const outsideNames = outside.map(categoryLabel).join(', ')

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        {summary.assigned.length === 0 ? (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
            Not classified
          </span>
        ) : (
          summary.assigned.map((category) => (
            <span
              key={category.category_id}
              title={category.is_active === true ? undefined : 'Inactive category'}
              className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                category.is_active === true
                  ? 'border-[var(--sera-orange)]/25 bg-[var(--sera-orange)]/[0.06] text-[var(--sera-orange-deep)]'
                  : 'border-gray-200 bg-gray-50 text-gray-500'
              }`}
            >
              {categoryLabel(category)}
              {category.is_active === true ? '' : ' · inactive'}
            </span>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--sera-muted)]">
        <span>
          {summary.product_count === 0
            ? 'No linked products yet'
            : `${summary.product_count} linked product${summary.product_count === 1 ? '' : 's'}`}
        </span>
        {summary.assigned.length === 0 && derivedNames && <span>· Found in products: {derivedNames}</span>}
        {summary.assigned.length > 0 && outsideNames && (
          <span className="text-amber-700" title="Linked products use categories outside this classification">
            · Also in products: {outsideNames}
          </span>
        )}
        {showProductsLink && summary.product_count > 0 && (
          <Link
            href={manufacturerProductsHref(manufacturerId)}
            className="inline-flex items-center gap-0.5 font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline"
          >
            <Package className="h-3 w-3" aria-hidden /> View products
          </Link>
        )}
      </div>
    </div>
  )
}
