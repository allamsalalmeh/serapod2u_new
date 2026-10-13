// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccessState from './AccessState'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('next/link', () => ({ default: ({ href, children }: any) => <a href={href}>{children}</a> }))
afterEach(cleanup)

describe('AccessState', () => {
  it('shows the ordinary denial copy and a working way back to My Workspace', () => {
    render(<AccessState kind="denied" homeHref="/hr/my-workspace" homeLabel="Back to My Workspace" />)
    expect(screen.getByText('You don’t have access to this page.')).toBeTruthy()
    expect(screen.getByText('Contact your administrator if you need access.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to My Workspace' }).getAttribute('href')).toBe('/hr/my-workspace')
  })

  it('falls back to an authorized destination when there is no workspace', () => {
    render(<AccessState kind="denied" />)
    expect(screen.getByRole('link', { name: 'Back to Dashboard' }).getAttribute('href')).toBe('/dashboard')
  })

  it('never carries technical diagnostics (role levels, permission keys, engine reasons, HR admin roles)', () => {
    for (const kind of ['denied', 'unavailable', 'signed_out', 'employee_pending'] as const) {
      const { container, unmount } = render(<AccessState kind={kind} />)
      expect(container.textContent).not.toMatch(/level|guest|permission|\bhr\.[a-z_]+\.|\bsa_|POLICY|LEGACY|HR admin/i)
      unmount()
    }
  })

  it('reports a failed permission check as temporary, not as a denial, and offers a retry', () => {
    render(<AccessState kind="unavailable" />)
    expect(screen.getByText('We couldn’t check your access right now.')).toBeTruthy()
    expect(screen.queryByText('You don’t have access to this page.')).toBeNull()
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(refresh).toHaveBeenCalled()
  })

  it('distinguishes an expired login and a pending employee setup', () => {
    const expired = render(<AccessState kind="signed_out" />)
    expect(screen.getByText('Your session has expired.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login')
    expired.unmount()
    render(<AccessState kind="employee_pending" />)
    expect(screen.getByText('Your employee setup is pending.')).toBeTruthy()
    expect(screen.getByText('Contact HR.')).toBeTruthy()
  })
})
