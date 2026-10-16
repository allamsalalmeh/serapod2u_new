// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Stable references: a new client per render would re-run the dialog's data-loading effects forever.
const stable = vi.hoisted(() => {
  const chain: any = { select: () => chain, order: () => chain, eq: () => chain, in: () => chain, then: (r: any) => r({ data: [], error: null }) }
  return { value: { supabase: { from: () => chain, rpc: async () => ({ data: false }) } } }
})
vi.mock('@/lib/hooks/useSupabaseAuth', () => ({ useSupabaseAuth: () => stable.value }))
vi.mock('@/lib/actions', () => ({ listInitialAccessRoles: async () => ({ success: true, roles: [], canAssign: false, legacyReadOnly: false }) }))

import UserDialogNew from './UserDialogNew'

afterEach(cleanup)
const props = { roles: [], organizations: [], onOpenChange: () => undefined, onSave: () => undefined } as any
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement

describe('Add User → credentials fields', () => {
  it('starts empty, with telephone semantics that the browser cannot read as the administrator login', () => {
    render(<UserDialogNew {...props} user={null} open />)
    const phone = field(/Phone Number/)
    expect(phone.value).toBe('')
    expect(phone.type).toBe('tel')
    expect(phone.getAttribute('inputmode')).toBe('tel')
    expect(phone.getAttribute('autocomplete')).toBe('off')
    expect(phone.placeholder).toBe('Enter your phone number')
    expect(phone.name).toBe('user_dialog_phone')
    expect(field(/^Email/).value).toBe('')
    const pw = field(/^Password/)
    const cf = field(/Confirm Password/)
    for (const input of [pw, cf]) {
      expect(input.value).toBe('')
      expect(input.getAttribute('autocomplete')).toBe('new-password')
    }
    expect(new Set([pw.id, cf.id, phone.id, field(/^Email/).id]).size).toBe(4)
  })

  it('Tab goes Password → Confirm Password → visibility buttons; Shift+Tab reverses; buttons toggle by keyboard with state', async () => {
    const user = userEvent.setup()
    render(<UserDialogNew {...props} user={null} open />)
    const pw = field(/^Password/)
    const cf = field(/Confirm Password/)
    pw.focus()
    await user.tab()
    expect(document.activeElement).toBe(cf)
    await user.tab()
    const showPw = screen.getByRole('button', { name: 'Show password' })
    expect(document.activeElement).toBe(showPw)
    expect(showPw.getAttribute('type')).toBe('button')
    expect(showPw.getAttribute('aria-pressed')).toBe('false')
    await user.keyboard('{Enter}')
    expect(pw.type).toBe('text')
    expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe('true')
    await user.tab()
    const showCf = screen.getByRole('button', { name: 'Show confirm password' })
    expect(document.activeElement).toBe(showCf)
    await user.keyboard(' ')
    expect(cf.type).toBe('text')
    await user.tab({ shift: true })
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(cf)
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(pw)
    expect(document.body.contains(showPw)).toBe(true)   // no tabindex tricks: still keyboard reachable
    expect(pw.closest('form, div')!.innerHTML).not.toMatch(/tabindex/i)
  })

  it('reopening starts clean and keeps what the user typed until then; edit mode shows the record and has no password fields', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<UserDialogNew {...props} user={null} open />)
    await user.type(field(/Phone Number/), '0123456789')
    expect(field(/Phone Number/).value).toBe('0123456789')
    rerender(<UserDialogNew {...props} user={null} open={false} />)
    rerender(<UserDialogNew {...props} user={null} open />)
    expect(field(/Phone Number/).value).toBe('')
    expect(field(/^Password/).value).toBe('')
    rerender(<UserDialogNew {...props} user={{ id: 'u1', email: 'a@b.test', full_name: 'Existing', phone: '+60123456789', role_code: 'USER', organization_id: null, is_active: true } as any} open />)
    expect(field(/Phone Number/).value).toBe('+60123456789')
    expect(screen.queryByLabelText(/^Password/)).toBeNull()
  })

  it('edit mode keeps the Active control, reflecting the record (Add User has none)', async () => {
    const edit = (active: boolean) => ({ id: 'u1', email: 'a@b.test', full_name: 'Existing', phone: '+60123456789', role_code: 'USER', organization_id: null, is_active: active } as any)
    const { rerender } = render(<UserDialogNew {...props} user={null} open />)
    expect(screen.queryByRole('switch')).toBeNull()
    rerender(<UserDialogNew {...props} user={edit(false)} open />)
    await userEvent.click(screen.getByRole('button', { name: /Next/ }))
    const sw = screen.getByRole('switch') as HTMLElement
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })
})
