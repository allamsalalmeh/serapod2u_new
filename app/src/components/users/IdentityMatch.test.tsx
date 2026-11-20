// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdentityMatchNotice, type LookupView } from './IdentityMatch'

afterEach(cleanup)

const employee = {
  status: 'employee' as const, matchedBy: 'email' as const, userId: 'emp-1', name: 'Aisyah Rahman',
  organizationName: 'Serapod HQ', employeeNo: 7,
  fills: [{ field: 'full_name' as const, label: 'Full name', value: 'Aisyah Rahman' }],
}

const lookup = (result = employee): LookupView => ({ phase: 'done', result, retry: vi.fn() })

describe('employee linking confirmation', () => {
  it('keeps the replacement preview through unrelated parent renders and links only after confirmation', async () => {
    const onLink = vi.fn()
    const props = { link: null, currentName: 'Ali Hassan', onLink, onUnlink: vi.fn() }
    const { rerender } = render(<IdentityMatchNotice {...props} state={lookup()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Use employee details' }))
    expect(screen.getByText(/“Ali Hassan” → “Aisyah Rahman”/)).toBeTruthy()
    expect(onLink).not.toHaveBeenCalled()

    // The lookup hook returns a fresh view wrapper when another form field/status renders.
    rerender(<IdentityMatchNotice {...props} state={lookup()} />)
    expect(screen.getByText(/replaces these fields/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Replace and link' }))
    expect(onLink).toHaveBeenCalledExactlyOnceWith(true)

    rerender(<IdentityMatchNotice {...props} state={lookup()} link={{
      userId: employee.userId, name: employee.name, organizationName: employee.organizationName,
      employeeNo: employee.employeeNo, key: 'ali@example.com|0123456789|hq',
    }} />)
    expect(screen.getByText('Linked to HR employee')).toBeTruthy()
  })

  it('clears the replacement preview when a different lookup result arrives', async () => {
    const props = { link: null, currentName: 'Ali Hassan', onLink: vi.fn(), onUnlink: vi.fn() }
    const { rerender } = render(<IdentityMatchNotice {...props} state={lookup()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Use employee details' }))
    rerender(<IdentityMatchNotice {...props} state={lookup({ ...employee, userId: 'emp-2' })} />)
    expect(screen.queryByText(/replaces these fields/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Use employee details' })).toBeTruthy()
    expect(props.onLink).not.toHaveBeenCalled()
  })
})
