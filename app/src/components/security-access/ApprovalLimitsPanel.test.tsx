// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import ApprovalLimitsPanel from './ApprovalLimitsPanel'

afterEach(() => cleanup())

const governance = {
  authorityPolicies: [
    { id: 'ap1', name: 'Purchase approval', permission_key: 'procurement.order.approve', document_type: 'purchase_order', currency: 'MYR', min_amount: 0, max_amount: 5000 },
  ],
}

describe('Approval Limits (Advanced)', () => {
  it('lists configured approval limits evaluated against the trusted document', () => {
    render(<ApprovalLimitsPanel governance={governance} />)
    expect(screen.getByRole('heading', { name: 'Approval Limits' })).toBeTruthy()
    expect(screen.getByText('Purchase approval')).toBeTruthy()
    expect(screen.getByText(/purchase_order · MYR 0–5000/)).toBeTruthy()
  })

  it('explains that existing workflow approval rules apply unchanged when no limits are configured', () => {
    render(<ApprovalLimitsPanel governance={{ authorityPolicies: [] }} />)
    expect(screen.getByText(/No approval thresholds are configured/)).toBeTruthy()
    expect(screen.getByText(/existing workflow approval rules apply unchanged/)).toBeTruthy()
  })

  it('stays accurate without the Security audit view and keeps the longer explanation behind the ⓘ', async () => {
    render(<ApprovalLimitsPanel governance={null} />)
    expect(screen.getByText('Approval Limits need the Security audit view.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'About Approval Limits' }))
    expect(screen.getByText(/Permission alone is not approval authority/)).toBeTruthy()
    expect(screen.getByText(/existing workflow approval rules remain in effect/)).toBeTruthy()
  })
})
