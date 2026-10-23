// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ArchiveIdentityDialog from './ArchiveIdentityDialog'

const A = { id: '00000000-0000-0000-0000-00000000a001', name: 'Ann Archive' }
const B = { id: '00000000-0000-0000-0000-00000000b001', name: 'Bob Other' }
const preview = (userId: string, over: Record<string, unknown> = {}) => ({
  target: { user_id: userId, full_name: userId === A.id ? 'Ann Archive' : 'Bob Other', email: `${userId}@example.test`, phone: null, organization_name: 'HQ', employee_no: 7 },
  employment: [{ employee_no: 7, onboarding_status: 'completed', status: 'active' }],
  archived: false, identifiers_released: false, releasable: true, blockers: [], warnings: [],
  confirmation_phrase: `${userId}@example.test`, preview_token: `tok-${userId}`, archive_allowed: true, release_allowed: false, ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
let previewOver: Record<string, unknown> = {}
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
beforeEach(() => {
  previewOver = {}
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/identity/archive?')) return json({ success: true, data: preview(new URL(url, 'http://x').searchParams.get('user_id')!, previewOver) })
    if (init?.method === 'POST') return json({ success: true, data: { status: 'completed', actionId: 'a-1', released: true } })
    return json({ success: false }, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  globalThis.crypto.randomUUID = (() => '00000000-0000-0000-0000-00000000f001') as any
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const releaseBox = () => screen.getByRole('checkbox', { name: 'Release email and phone for reuse' })
const isChecked = () => (releaseBox() as HTMLInputElement).checked
const ui = (target: typeof A | null) => <ArchiveIdentityDialog target={target} entry="user_management" onClose={vi.fn()} onDone={vi.fn()} />

async function confirmAndSubmit(userId: string) {
  fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Resigned effective today' } })
  fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: `${userId}@example.test` } })
  fireEvent.click(screen.getByRole('checkbox', { name: /should lose all access/ }))
  const submit = screen.getByRole('button', { name: /Archive & revoke access/ }) as HTMLButtonElement
  await waitFor(() => expect(submit.disabled).toBe(false))
  fireEvent.click(submit)
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(true))
  return JSON.parse((fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')![1] as RequestInit).body as string)
}

describe('Archive & Revoke Access: email/phone release defaults to checked', () => {
  it('a new archive opens with release checked and submits release_identifiers: true', async () => {
    render(ui(A))
    await screen.findByText(/This is not a deletion/)
    expect(isChecked()).toBe(true)
    const body = await confirmAndSubmit(A.id)
    expect(body).toMatchObject({ action: 'archive', user_id: A.id, release_identifiers: true, employment_end: 'resigned', preview_token: `tok-${A.id}` })
  })

  it('the administrator can opt out: unchecked submits release_identifiers: false', async () => {
    render(ui(A))
    await screen.findByText(/This is not a deletion/)
    fireEvent.click(releaseBox())
    expect(isChecked()).toBe(false)
    expect((await confirmAndSubmit(A.id)).release_identifiers).toBe(false)
  })

  it('closing and reopening resets it to checked', async () => {
    const { rerender } = render(ui(A))
    await screen.findByText(/This is not a deletion/)
    fireEvent.click(releaseBox())
    expect(isChecked()).toBe(false)
    rerender(ui(null))
    rerender(ui(A))
    await waitFor(() => expect(isChecked()).toBe(true))
  })

  it('switching to another person starts checked again', async () => {
    const { rerender } = render(ui(A))
    await screen.findByText(/This is not a deletion/)
    fireEvent.click(releaseBox())
    rerender(ui(B))
    await screen.findByText('Bob Other')
    await waitFor(() => expect(isChecked()).toBe(true))
    expect((await confirmAndSubmit(B.id))).toMatchObject({ user_id: B.id, release_identifiers: true })
  })

  it('never forces a release the preview says is not possible', async () => {
    previewOver = { releasable: false }
    render(ui(A))
    await screen.findByText(/This is not a deletion/)
    expect(screen.queryByRole('checkbox', { name: 'Release email and phone for reuse' })).toBeNull()
    expect((await confirmAndSubmit(A.id)).release_identifiers).toBe(false)
  })

  it('confirmation rules are unchanged: reason, typed phrase and confirmation are still required', async () => {
    render(ui(A))
    await screen.findByText(/This is not a deletion/)
    const submit = screen.getByRole('button', { name: /Archive & revoke access/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Resigned effective today' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /should lose all access/ }))
    expect(submit.disabled).toBe(true) // typed phrase still missing
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'wrong@example.test' } })
    expect(submit.disabled).toBe(true)
  })
})
