// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccessProfileSelector, { type AccessMode, type ProfileChoice } from './AccessProfileSelector'

afterEach(cleanup)

const PROFILES = [{ id: 'wh', name: 'Warehouse Operator', description: 'Operates the warehouse' }, { id: 'rcv', name: 'Receiver' }, { id: 'mfg', name: 'Manufacturer Operator' }]
const SCOPES = [
  { id: 's-bal', organization_id: 'o', scope_type: 'organization', display_name: 'Balakong WH' },
  { id: 's-alma', organization_id: 'o2', scope_type: 'organization', display_name: 'Alma WH' },
]

function Harness(props: Partial<React.ComponentProps<typeof AccessProfileSelector>> & { onState?: (s: any) => void }) {
  const [mode, setMode] = useState<AccessMode>(props.mode ?? '')
  const [items, setItems] = useState<ProfileChoice[]>(props.items ?? [])
  const [reason, setReason] = useState('')
  props.onState?.({ mode, items, reason })
  return <AccessProfileSelector profiles={PROFILES} scopes={SCOPES} organizationName="Balakong WH" organizationTypeCode="WH" legacyReadOnly={false} legacyLevelLabel="Level 20 — Manager"
    {...props} mode={mode} items={items} reason={reason} onMode={setMode} onItems={setItems} onReason={setReason} />
}

describe('Add User → Access Profiles', () => {
  it('classifies the account from the organization and keeps self-service an explicit choice', () => {
    render(<Harness />)
    expect(screen.getByText('Internal staff')).toBeTruthy()
    expect((screen.getByRole('radio', { name: /Employee self-service only/ }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByLabelText('Access Profile 1')).toBeNull()
    cleanup()
    render(<Harness organizationName="Manu Manufacturing" organizationTypeCode="MFG" />)
    expect(screen.getByText('Partner account')).toBeTruthy()
    expect(screen.getByText(/Partner accounts are not enrolled into HR or employee self-service/)).toBeTruthy()
  })

  it('assigns several profiles, each with its OWN scope (none defaulted), each profile once', async () => {
    let state: any
    render(<Harness onState={s => { state = s }} />)
    await userEvent.click(screen.getByRole('radio', { name: /Assign Access Profiles/ }))
    expect(state.items).toEqual([{ roleId: '', scopeId: '' }])        // an empty row; no scope preselected
    await userEvent.selectOptions(screen.getByLabelText('Access Profile 1'), 'wh')
    await userEvent.selectOptions(screen.getByLabelText('Scope for profile 1'), 's-bal')
    await userEvent.click(screen.getByRole('button', { name: 'Add another profile' }))
    // the first profile is no longer offered in row 2
    expect(within(screen.getByLabelText('Access Profile 2')).queryByRole('option', { name: 'Warehouse Operator' })).toBeNull()
    await userEvent.selectOptions(screen.getByLabelText('Access Profile 2'), 'rcv')
    expect((screen.getByLabelText('Scope for profile 2') as HTMLSelectElement).value).toBe('')
    await userEvent.selectOptions(screen.getByLabelText('Scope for profile 2'), 's-alma')
    expect(state.items).toEqual([{ roleId: 'wh', scopeId: 's-bal' }, { roleId: 'rcv', scopeId: 's-alma' }])
    const review = within(screen.getByRole('region', { name: 'Review of resulting access' }))
    expect(review.getByText(/Warehouse Operator/)).toBeTruthy()
    expect(review.getByText(/scope: Alma WH/)).toBeTruthy()
    expect(review.getByText(/Level 20 — Manager/)).toBeTruthy()
    expect(review.getByText(/never grant payroll, Finance or security administration/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Remove profile 2' }))
    expect(state.items).toHaveLength(1)
  })

  it('describes the legacy level as compatibility and does not claim it was retired', () => {
    render(<Harness mode="self" legacyReadOnly={false} />)
    expect(screen.getByText(/still decides access for features not yet moved to Security & Access/)).toBeTruthy()
    cleanup()
    render(<Harness mode="self" legacyReadOnly />)
    expect(screen.getByText(/compatibility only; it does not grant access by itself/)).toBeTruthy()
  })

  it('explains an empty profile list and a missing scope instead of defaulting', async () => {
    render(<Harness profiles={[]} scopes={[]} mode="profiles" items={[{ roleId: '', scopeId: '' }]} />)
    expect(screen.getByText(/No Access Profile applies to this organization and account type/)).toBeTruthy()
    expect(screen.getByLabelText('Scope for profile 1').textContent).toContain('No scope defined for this organization')
  })

  it('shows validation errors passed by the form', () => {
    render(<Harness mode="profiles" items={[{ roleId: 'wh', scopeId: '' }]} errors={{ items: 'Each Access Profile needs its own scope.', reason: 'A reason is required' }} />)
    expect(screen.getAllByRole('alert').map(a => a.textContent)).toEqual(['Each Access Profile needs its own scope.', 'A reason is required'])
  })
})
