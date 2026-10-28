// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// UI/UX reconciliation 2026-10-26 (BL-31): a company-wide entitlement run / carry-forward is previewed first; applying
// is a separate step that needs a reason AND an explicit "owner authorization" confirmation.
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

import HrLeaveBalancesPanel from './HrLeaveBalancesPanel'

const overview = (types: any[], employees: any[]) => ({ year: 2026, types, employees })
const annual = { id: 'al', code: 'AL', name: 'Annual', is_paid: true, has_tiers: true, carry_forward: { enabled: true, maxDays: 5 } }
let data: any
let posts: any[] = []
beforeEach(() => {
  toast.mockReset(); posts = []
  data = overview([annual], [{ employee_id: 'e1', employee_no: 1, name: 'E One', hire_date: '2020-01-01', balances: {} }])
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body); posts.push(body)
      return new Response(JSON.stringify({ success: true, data: body.dry_run ? { rows: [{ employee_id: 'e1', name: 'E One', days: 12, status: 'would_set', years_of_service: 6 }] } : { applied: 1 } }))
    }
    return new Response(JSON.stringify({ success: true, data }))
  }) as any
})
afterEach(cleanup)

describe('HrLeaveBalancesPanel', () => {
  it('previews the entitlement run without writing, and applies only with reason + explicit authorization', async () => {
    render(<HrLeaveBalancesPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /Preview entitlement run/ }))
    await screen.findByText(/Company-wide change/)
    expect(posts).toEqual([expect.objectContaining({ action: 'entitlement_run', dry_run: true })])
    const apply = screen.getByRole('button', { name: /Apply to 1 employee/ }) as HTMLButtonElement
    fireEvent.change(screen.getAllByRole('textbox').at(-1)!, { target: { value: 'Annual entitlement 2026' } })
    expect(apply.disabled).toBe(true) // reason alone is not enough
    fireEvent.click(screen.getByRole('checkbox', { name: /explicit owner authorization/ }))
    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ action: 'entitlement_run', dry_run: false, reason: 'Annual entitlement 2026' }))
  })

  it('explains an empty configuration instead of showing an empty table', async () => {
    data = overview([], [])
    render(<HrLeaveBalancesPanel />)
    expect(await screen.findByText(/No active leave types yet/)).toBeTruthy()
  })
})
