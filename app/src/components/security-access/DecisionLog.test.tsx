// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import DecisionLog from './DecisionLog'

afterEach(cleanup)

const decision = {
  id: 'ce4cce54-74ef-432e-abeb-6a92fa1f2a5a', actor_id: 'u1', permission_key: 'security.access.view', resource_type: 'security_access',
  occurred_at: '2026-09-30T03:31:18Z', legacy_decision: null, new_decision: 'ALLOW', comparison: 'MATCH_ALLOW',
  reason_code: 'ALLOWED_BY_ASSIGNMENT', migration_mode: 'LEGACY_RETIRED', policy_version: 'sa-final-v1',
  matched_assignments: [{ assignmentId: 'dbd3ffb6-2c8b-4672-b03e-df2c63d77025', roleId: 'r1', roleKey: 'security-admin' }],
  resolved_scopes: [{ assignmentId: 'dbd3ffb6', scopeType: 'organization', scopeValue: 'org-1', matched: true }],
}

describe('Authorization decision details', () => {
  it('explains a decision in names and keeps identifiers folded for support', async () => {
    render(<DecisionLog decisions={[decision]} actors={[]} people={[{ id: 'u1', full_name: 'Super Admin', role_code: 'SA' }]}
      organizations={[{ id: 'org-1', org_name: 'Serapod Technology Sdn Bhd' } as any]} roles={[{ id: 'r1', role_key: 'security-admin', name: 'Security Administrator' }]} />)
    await userEvent.click(screen.getByRole('button', { name: /Show details of/ }))
    expect(screen.getByText('Security Administrator')).toBeTruthy()
    expect(screen.getByText('Granted by')).toBeTruthy()
    expect(screen.queryByText(decision.id)).toBeNull()
    expect(screen.queryByText(/dbd3ffb6-2c8b/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Technical reference/ }))
    expect(screen.getByText(decision.id)).toBeTruthy()
  })

  it('filters by module through the permission key, with a no-results state', async () => {
    const hr = { ...decision, id: 'hr-1', permission_key: 'hr.payroll.approve' }
    render(<DecisionLog decisions={[decision, hr]} actors={[]} people={[{ id: 'u1', full_name: 'Super Admin', role_code: 'SA' }]}
      organizations={[{ id: 'org-1', org_name: 'Serapod Technology Sdn Bhd' } as any]} />)
    const select = screen.getByRole('combobox', { name: 'Module' }) as HTMLSelectElement
    expect(Array.from(select.options).map(o => o.text)).toEqual(['All modules', 'HR & Payroll', 'Security & Access'])
    await userEvent.selectOptions(select, 'hr_payroll')
    expect(screen.getByText('Approve Payroll')).toBeTruthy()
    expect(screen.queryByText('View Security & Access')).toBeNull()
    await userEvent.type(screen.getByRole('textbox', { name: 'Search decisions' }), 'zzz')
    expect(screen.getByText('No decisions match these filters.')).toBeTruthy()
  })
})
