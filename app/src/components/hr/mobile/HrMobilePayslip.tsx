'use client'

import { useState, useEffect } from 'react'
import { useHrMobile } from './HrMobileContext'
import {
  FileText,
  Download,
  ChevronLeft,
  ChevronRight,
  Loader2,
  DollarSign,
  Minus,
  TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'

/* ─── Types ───────────────────────────────────────────────────────── */

interface PayslipSummary {
  id: string
  period_start: string
  period_end: string
  gross_amount: number
  deductions_amount: number
  net_amount: number
  basic_salary: number
  allowances: number
  epf_employee: number
  socso_employee: number
  eis_employee: number
  pcb_amount: number
  status: string
}

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-MY', {
    style: 'currency',
    currency: 'MYR',
    minimumFractionDigits: 2,
  }).format(amount)
}

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/* ─── Component ───────────────────────────────────────────────────── */

export default function HrMobilePayslip() {
  const { toast } = useToast()

  const now = new Date()
  const [selectedYear, setSelectedYear] = useState(now.getFullYear())
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth()) // 0-indexed
  const [payslip, setPayslip] = useState<PayslipSummary | null>(null)
  const [loading, setLoading] = useState(true)

  /* ── Load payslip for selected month ────────────────────────── */

  useEffect(() => {
    loadPayslip()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, selectedMonth])

  async function loadPayslip() {
    setLoading(true)
    try {
      // Calculate period boundaries for the selected month
      const periodStart = `${selectedYear}-${String(selectedMonth + 1).padStart(2, '0')}-01`
      const lastDay = new Date(selectedYear, selectedMonth + 1, 0).getDate()
      const periodEnd = `${selectedYear}-${String(selectedMonth + 1).padStart(2, '0')}-${lastDay}`

      // Own, published payslips only: the server resolves the employee from the signed-in account (no employee id is
      // sent) and returns items of final payroll runs (approved/posted) only.
      const res = await fetch(
        `/api/hr/self-service/payslips?periodStart=${periodStart}&periodEnd=${periodEnd}`,
        { cache: 'no-store' },
      )
      const data = res.ok ? ((await res.json())?.data as any[] | undefined) ?? [] : []

      if (data && data.length > 0) {
        const item = data[0] as any
        const run = item.hr_payroll_runs

        // Allowances is a numeric column now
        const totalAllowances = (item.allowances_amount || 0) + (item.other_allowances || 0)

        setPayslip({
          id: item.id,
          period_start: run.period_start,
          period_end: run.period_end,
          gross_amount: item.gross_amount || 0,
          deductions_amount: item.deductions_amount || 0,
          net_amount: item.net_amount || 0,
          basic_salary: item.basic_salary || 0,
          allowances: totalAllowances,
          epf_employee: item.epf_employee || 0,
          socso_employee: item.socso_employee || 0,
          eis_employee: item.eis_employee || 0,
          pcb_amount: item.pcb_amount || 0,
          status: run.status,
        })
      } else {
        setPayslip(null)
      }
    } catch (err) {
      console.error('Error loading payslip:', err)
      setPayslip(null)
    } finally {
      setLoading(false)
    }
  }

  /* ── Month navigation ───────────────────────────────────────── */

  function prevMonth() {
    if (selectedMonth === 0) {
      setSelectedMonth(11)
      setSelectedYear((y) => y - 1)
    } else {
      setSelectedMonth((m) => m - 1)
    }
  }

  function nextMonth() {
    // Don't go beyond current month
    if (
      selectedYear === now.getFullYear() &&
      selectedMonth >= now.getMonth()
    )
      return
    if (selectedMonth === 11) {
      setSelectedMonth(0)
      setSelectedYear((y) => y + 1)
    } else {
      setSelectedMonth((m) => m + 1)
    }
  }

  const isCurrentMonth =
    selectedYear === now.getFullYear() && selectedMonth >= now.getMonth()

  /* ── Download stub ──────────────────────────────────────────── */

  function handleDownload() {
    toast({
      title: '📄 Coming Soon',
      description:
        'PDF payslip download will be available soon. Contact HR for a copy.',
    })
  }

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="px-4 pt-6 space-y-5">
      <h1 className="text-xl font-bold text-foreground">Payslip</h1>

      {/* ── Month selector ────────────────────────────────────── */}
      <div className="flex items-center justify-between bg-card rounded-2xl border border-border p-3">
        <button
          onClick={prevMonth}
          aria-label="Previous month"
          className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-accent transition-colors"
        >
          <ChevronLeft className="h-5 w-5 text-foreground" />
        </button>
        <div className="text-center">
          <p className="text-base font-semibold text-foreground">
            {months[selectedMonth]}
          </p>
          <p className="text-xs text-muted-foreground">{selectedYear}</p>
        </div>
        <button
          onClick={nextMonth}
          disabled={isCurrentMonth}
          aria-label="Next month"
          className={cn(
            'flex h-11 w-11 items-center justify-center rounded-lg transition-colors',
            isCurrentMonth
              ? 'opacity-30 cursor-not-allowed'
              : 'hover:bg-accent',
          )}
        >
          <ChevronRight className="h-5 w-5 text-foreground" />
        </button>
      </div>

      {/* ── Payslip content ───────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        </div>
      ) : payslip ? (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-1 gap-3 min-[460px]:grid-cols-3">
            <SummaryCard
              icon={TrendingUp}
              label="Gross"
              amount={payslip.gross_amount}
              color="green"
            />
            <SummaryCard
              icon={Minus}
              label="Deductions"
              amount={payslip.deductions_amount}
              color="red"
            />
            <SummaryCard
              icon={DollarSign}
              label="Net Pay"
              amount={payslip.net_amount}
              color="blue"
            />
          </div>

          {/* Earnings breakdown */}
          <div className="bg-card rounded-2xl border border-border p-4 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Earnings</h3>
            <Row label="Basic Salary" amount={payslip.basic_salary} />
            {payslip.allowances > 0 && (
              <Row label="Allowances" amount={payslip.allowances} />
            )}
            <div className="border-t border-border pt-2">
              <Row
                label="Total Gross"
                amount={payslip.gross_amount}
                bold
              />
            </div>
          </div>

          {/* Deductions breakdown */}
          <div className="bg-card rounded-2xl border border-border p-4 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">
              Deductions
            </h3>
            {payslip.epf_employee > 0 && (
              <Row label="EPF (Employee)" amount={payslip.epf_employee} />
            )}
            {payslip.socso_employee > 0 && (
              <Row label="SOCSO (Employee)" amount={payslip.socso_employee} />
            )}
            {payslip.eis_employee > 0 && (
              <Row label="EIS (Employee)" amount={payslip.eis_employee} />
            )}
            {payslip.pcb_amount > 0 && (
              <Row label="PCB / Income Tax" amount={payslip.pcb_amount} />
            )}
            <div className="border-t border-border pt-2">
              <Row
                label="Total Deductions"
                amount={payslip.deductions_amount}
                bold
              />
            </div>
          </div>

          {/* Net pay highlight */}
          <div className="bg-blue-50 dark:bg-blue-950/40 rounded-2xl border border-blue-200 dark:border-blue-800 p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                Net Pay
              </p>
              <p className="text-2xl font-bold text-blue-900 dark:text-blue-100">
                {formatCurrency(payslip.net_amount)}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleDownload}
              aria-label="Download PDF payslip (not available yet)"
              className="min-h-11 gap-1.5"
            >
              <Download className="h-3.5 w-3.5" />
              PDF
            </Button>
          </div>
        </>
      ) : (
        /* Empty state */
        <div className="text-center py-12">
          <FileText className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-medium text-muted-foreground">
            No payslip available
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Payslip for {months[selectedMonth]} {selectedYear} has not been
            generated yet.
          </p>
        </div>
      )}

      <div className="h-4" />
    </div>
  )
}

/* ─── Sub-components ──────────────────────────────────────────────── */

function SummaryCard({
  icon: Icon,
  label,
  amount,
  color,
}: {
  icon: any
  label: string
  amount: number
  color: string
}) {
  const bg: Record<string, string> = {
    green: 'bg-green-50 dark:bg-green-950/40',
    red: 'bg-red-50 dark:bg-red-950/40',
    blue: 'bg-blue-50 dark:bg-blue-950/40',
  }
  const fg: Record<string, string> = {
    green: 'text-green-600 dark:text-green-400',
    red: 'text-red-600 dark:text-red-400',
    blue: 'text-blue-600 dark:text-blue-400',
  }
  return (
    <div
      className={cn(
        'rounded-2xl p-3 flex flex-col items-center gap-1',
        bg[color],
      )}
    >
      <Icon className={cn('h-5 w-5', fg[color])} />
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={cn('max-w-full break-words text-center text-sm font-bold', fg[color])}>
        {formatCurrency(amount)}
      </p>
    </div>
  )
}

function Row({
  label,
  amount,
  bold,
}: {
  label: string
  amount: number
  bold?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <span
        className={cn(
          'text-sm',
          bold ? 'font-semibold text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          'text-sm',
          bold ? 'font-semibold text-foreground' : 'text-foreground',
        )}
      >
        {formatCurrency(amount)}
      </span>
    </div>
  )
}
