// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MyAccessRequests from './MyAccessRequests'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const OPTIONS = {
  memberships: [{ organizationId: 'org-hq', organizationName: 'Serapod HQ', heldRoleIds: ['r-crm'] }],
  scopes: [{ id: 's-hq', organization_id: 'org-hq', scope_type: 'organization', display_name: 'Serapod HQ' }],
  roles: [{ id: 'r-crm', name: 'CRM User', description: null }, { id: 'r-wh', name: 'Warehouse Operator', description: null }],
}

function stubApi(options: any, requests: any[] = []) {
  const calls: Array<{ url: string; body: any }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ url, body })
    if (url === '/api/security-access/me/request-options') return { ok: true, json: async () => options }
    if (url === '/api/security-access/access-requests' && !body) return { ok: true, json: async () => ({ requests }) }
    return { ok: true, json: async () => ({ ok: true, requestId: 'req-1' }) }
  }))
  return calls
}

describe('MyAccessRequests (self-service access requests)', () => {
  it('offers only roles the person does not hold and submits a scoped, reasoned request', async () => {
    const calls = stubApi(OPTIONS)
    render(<MyAccessRequests />)
    const role = await screen.findByRole('combobox', { name: 'Group Policy' }) as HTMLSelectElement
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Organization' }) as HTMLSelectElement).value).toBe('org-hq'))
    expect(Array.from(role.options).map(o => o.text)).toEqual(['Choose a policy', 'Warehouse Operator'])
    const submit = screen.getByRole('button', { name: 'Submit request' })
    await userEvent.selectOptions(role, 'r-wh')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Scope' }), 's-hq')
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), 'short')
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), ' but now long enough')
    await userEvent.click(submit)
    expect(calls.find(c => c.body?.action === 'submit')?.body).toEqual({
      action: 'submit', roleId: 'r-wh', organizationId: 'org-hq', scopeIds: ['s-hq'], effectiveUntil: null, reason: 'short but now long enough',
    })
    expect(await screen.findByText(/Request submitted/)).toBeTruthy()
  })

  it('lists my requests and lets me cancel a pending one', async () => {
    const calls = stubApi(OPTIONS, [{ id: 'q1', role_id: 'r-wh', status: 'requested', created_at: '2026-10-01T00:00:00Z' }])
    render(<MyAccessRequests />)
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(calls.find(c => c.body?.action === 'cancel')?.body).toEqual({ action: 'cancel', requestId: 'q1' })
  })

  it('renders nothing for someone without a business membership', async () => {
    stubApi({ memberships: [], scopes: [], roles: [] })
    const { container } = render(<MyAccessRequests />)
    await waitFor(() => expect(container.textContent).toBe(''))
  })
})
