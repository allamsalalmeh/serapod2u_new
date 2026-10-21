'use client'

import { useMemo, type ReactNode } from 'react'
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { adjacentReportingMonths, buildReportingMonthOptions } from '@/lib/reporting/consumer-analytics'

interface ReportingMonthSelectorProps {
  /** DOM id for the select trigger; the label points at it. */
  id: string
  /** Selected `YYYY-MM`. */
  month: string
  onMonthChange: (month: string) => void
  /**
   * Months the report has records for. Only the earliest matters: every month
   * from it to the current Malaysia month is selectable, with or without data.
   */
  availableMonths?: readonly string[]
  disabled?: boolean
  /** Period caption under the controls, e.g. "01 Oct 2026 – 20 Oct 2026 (month to date)". */
  caption?: ReactNode
}

/**
 * The one Reporting Month control used by every Executive Dashboard tab:
 * month/year dropdown plus previous/next buttons over the same contiguous
 * month list, so no tab can skip an empty month or step past the current one.
 */
export default function ReportingMonthSelector({
  id, month, onMonthChange, availableMonths = [], disabled = false, caption,
}: ReportingMonthSelectorProps) {
  const options = useMemo(
    () => buildReportingMonthOptions([...availableMonths, month]),
    [availableMonths, month],
  )
  const { older, newer } = adjacentReportingMonths(options, month)

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-[var(--sera-muted)]">
        Reporting Month
      </label>
      <div className="flex items-center gap-1.5">
        <Select value={month} onValueChange={onMonthChange} disabled={disabled}>
          <SelectTrigger
            id={id}
            className="h-10 min-w-0 flex-1 border-[var(--sera-line)] bg-white text-sm lg:h-9 lg:w-[190px] lg:flex-none"
          >
            <Calendar className="mr-2 h-3.5 w-3.5 shrink-0 text-[var(--sera-muted)]" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline" size="icon"
          className="h-10 w-10 shrink-0 border-[var(--sera-line)] lg:h-9 lg:w-9"
          onClick={() => older && onMonthChange(older)}
          disabled={disabled || !older}
          title="Previous month"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline" size="icon"
          className="h-10 w-10 shrink-0 border-[var(--sera-line)] lg:h-9 lg:w-9"
          onClick={() => newer && onMonthChange(newer)}
          disabled={disabled || !newer}
          title="Next month"
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      {caption ? <p className="text-[11px] leading-tight text-[var(--sera-muted)]">{caption}</p> : null}
    </div>
  )
}
