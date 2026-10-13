// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import UserPasswordResetSection from './UserPasswordResetSection'

const toastMock = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: toastMock }) }))

let capability: { allowed: boolean; enforced: boolean; unavailable?: true } | null = null
let capabilityStatus = 200

describe('UserPasswordResetSection', () => {
  beforeEach(() => {
    toastMock.mockReset()
    // Not enforced yet (SHADOW): the legacy rule decides.
    capability = { allowed: false, enforced: false }
    capabilityStatus = 200
    vi.stubGlobal('fetch', vi.fn(async (url: string) => String(url).includes('/me/capabilities')
      ? { ok: capabilityStatus === 200, status: capabilityStatus, json: async () => ({ capabilities: capability ? { 'platform.user.password_reset': capability } : {} }) }
      : { ok: true, json: async () => ({ success: true }) }) as any)
  })

  const renderSection = (level = 10) => render(<UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={level} targetOrganizationId="org-hq" />)

  it('shows a checking state in Account security while the permission is looked up', async () => {
    let release: (v: any) => void = () => undefined
    ;(fetch as any).mockImplementationOnce(() => new Promise(r => { release = r }))
    renderSection()
    expect(screen.getByRole('heading', { name: 'Account security' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toMatch(/Checking password reset permission/)
    expect(screen.queryByRole('button', { name: /^Reset password/i })).toBeNull()
    release({ ok: true, status: 200, json: async () => ({ capabilities: { 'platform.user.password_reset': { allowed: false, enforced: false } } }) })
    expect(await screen.findByRole('button', { name: /^Reset password/i })).toBeTruthy()
  })

  for (const [label, setup] of [
    ['the request fails (503)', () => { capabilityStatus = 503 }],
    ['the evaluator was unavailable', () => { capability = { allowed: false, enforced: true, unavailable: true } }],
    ['the answer is missing', () => { capability = null }],
  ] as const) {
    it(`reports a failed permission check accurately, with Retry, when ${label}`, async () => {
      setup()
      renderSection()
      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toMatch(/Couldn’t check whether you can reset this password/)
      expect(screen.queryByRole('button', { name: /^Reset password/i })).toBeNull()
      // Retry asks again; a successful answer shows the action.
      capabilityStatus = 200
      capability = { allowed: false, enforced: false }
      await userEvent.click(screen.getByRole('button', { name: /Retry/ }))
      expect(await screen.findByRole('button', { name: /^Reset password/i })).toBeTruthy()
      expect((fetch as any).mock.calls.filter(([u]: any[]) => String(u).includes('/me/capabilities')).length).toBe(2)
    })
  }

  it('a genuine denial hides the section (no error, no button)', async () => {
    renderSection(1) // Super Admin: the historical rule while not enforced is role level exactly 10
    await waitFor(() => expect((fetch as any).mock.calls.length).toBe(1))
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByRole('heading', { name: 'Account security' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows reset password only to role level 10 while not enforced', async () => {
    const { rerender } = render(<UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={10} />)
    expect(await screen.findByRole('button', { name: /^Reset password/i })).toBeTruthy()

    rerender(<UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={20} />)
    expect(screen.queryByRole('button', { name: /^Reset password/i })).toBeNull()
  })

  it('follows the enforced Security & Access answer for delegated administrators', async () => {
    capability = { allowed: true, enforced: true }
    render(<UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={20} />)
    expect(await screen.findByRole('button', { name: /^Reset password/i })).toBeTruthy()
  })

  it('hides the action when enforced Security & Access denies it, even at level 10', async () => {
    capability = { allowed: false, enforced: true }
    render(<UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={10} />)
    await waitFor(() => expect((fetch as any).mock.calls.length).toBe(1))
    await new Promise(r => setTimeout(r, 0))
    expect(screen.queryByRole('button', { name: /^Reset password/i })).toBeNull()
  })

  it('asks for the dedicated permission in the TARGET organization, not the profile permission', async () => {
    render(<UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={10} targetOrganizationId="11111111-1111-4111-8111-111111111111" />)
    await screen.findByRole('button', { name: /^Reset password/i })
    const url = String((fetch as any).mock.calls[0][0])
    expect(url).toContain('permissions=platform.user.password_reset')
    expect(url).toContain('organizationId=11111111-1111-4111-8111-111111111111')
    expect(url).not.toContain('platform.user.manage')
  })

  it('says the reset is separate, immediate and not undone by cancelling the form', async () => {
    const user = userEvent.setup()
    render(<UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={10} />)
    await user.click(await screen.findByRole('button', { name: /^Reset password/i }))
    const dialog = screen.getByTestId('password-reset-modal')
    expect(dialog.textContent).toMatch(/separate action/i)
    expect(dialog.textContent).toMatch(/does not save other changes/i)
    expect(dialog.textContent).toMatch(/cancelling that form later does not undo it/i)
  })

  it('keeps the dialog open with the server error when the reset is refused, and never echoes the password', async () => {
    const user = userEvent.setup()
    ;(fetch as any).mockImplementation(async (url: string) => String(url).includes('/me/capabilities')
      ? { ok: true, json: async () => ({ capabilities: { 'platform.user.password_reset': { allowed: false, enforced: false } } }) }
      : { ok: false, json: async () => ({ success: false, error: 'Forbidden - You are not authorized to reset this user\'s password' }) })
    render(<UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={10} />)
    await user.click(await screen.findByRole('button', { name: /^Reset password/i }))
    await user.type(screen.getByLabelText('New Password'), 'new-password')
    await user.type(screen.getByLabelText('Confirm New Password'), 'new-password')
    await user.click(screen.getAllByRole('button', { name: /^Reset password/i }).at(-1)!)
    expect((await screen.findByRole('alert')).textContent).toMatch(/not authorized/)
    expect(screen.getByTestId('password-reset-modal')).toBeTruthy()
    expect(document.body.textContent).not.toContain('new-passwordnew-password')
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Password reset failed' }))
    expect(JSON.stringify(toastMock.mock.calls)).not.toContain('new-password')
  })

  it('blocks password mismatch', async () => {
    const user = userEvent.setup()
    render(<UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={10} />)
    await user.click(await screen.findByRole('button', { name: /^Reset password/i }))
    await user.type(screen.getByLabelText('New Password'), 'new-password')
    await user.type(screen.getByLabelText('Confirm New Password'), 'different-password')

    expect(screen.getByText('Passwords do not match.')).toBeTruthy()
    expect((screen.getAllByRole('button', { name: /^Reset password/i }).at(-1) as HTMLButtonElement).disabled).toBe(true)
    expect((fetch as any).mock.calls.some(([u]: [string]) => u === '/api/users/reset-password')).toBe(false)
  })

  it('renders one higher-layer portal and cancel preserves the Edit User form', async () => {
    const user = userEvent.setup()
    render(
      <div data-testid="edit-user-modal" className="fixed z-[100]">
        <label htmlFor="edit-user-name">Edit User Name</label>
        <input id="edit-user-name" defaultValue="Unsaved name" />
        <UserPasswordResetSection
          targetUserId="target-1"
          targetUserName="Target User"
          targetUserEmail="target@example.com"
          currentUserRoleLevel={10}
        />
      </div>,
    )

    await user.clear(screen.getByLabelText('Edit User Name'))
    await user.type(screen.getByLabelText('Edit User Name'), 'Changed but unsaved')
    await user.click(await screen.findByRole('button', { name: /^Reset password/i }))

    const modal = screen.getByTestId('password-reset-modal')
    expect(modal.className).toContain('z-[120]')
    expect(screen.getByText(/Target User \(target@example.com\)/)).toBeTruthy()
    expect(document.querySelectorAll('.password-reset-overlay')).toHaveLength(1)
    expect(document.querySelector('.password-reset-overlay')?.className).toContain('z-[110]')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('password-reset-modal')).toBeNull()
    expect(screen.getByTestId('edit-user-modal')).toBeTruthy()
    expect((screen.getByLabelText('Edit User Name') as HTMLInputElement).value).toBe('Changed but unsaved')
    expect(document.querySelectorAll('.password-reset-overlay')).toHaveLength(0)
  })

  it('Escape closes only the reset modal', async () => {
    const user = userEvent.setup()
    render(
      <div data-testid="edit-user-modal">
        <UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={10} />
      </div>,
    )
    await user.click(await screen.findByRole('button', { name: /^Reset password/i }))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('password-reset-modal')).toBeNull()
    expect(screen.getByTestId('edit-user-modal')).toBeTruthy()
  })

  it('submits a valid reset without changing other user fields', async () => {
    const user = userEvent.setup()
    render(<UserPasswordResetSection targetUserId="target-1" targetUserName="Target User" targetUserEmail="target@example.com" currentUserRoleLevel={10} />)
    await user.click(await screen.findByRole('button', { name: /^Reset password/i }))
    await user.type(screen.getByLabelText('New Password'), 'new-password')
    await user.type(screen.getByLabelText('Confirm New Password'), 'new-password')
    await user.click(screen.getAllByRole('button', { name: /^Reset password/i }).at(-1)!)

    await waitFor(() => expect((fetch as any).mock.calls.filter(([u]: [string]) => u === '/api/users/reset-password')).toHaveLength(1))
    const [, init] = (fetch as any).mock.calls.find(([u]: [string]) => u === '/api/users/reset-password')
    expect(JSON.parse(init.body)).toEqual({ user_id: 'target-1', new_password: 'new-password' })
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Password reset' }))
  })
})
