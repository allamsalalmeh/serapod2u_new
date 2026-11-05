// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import AcknowledgeButton from './AcknowledgeButton'

const toast = vi.hoisted(() => vi.fn())
const reportClientError = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('@/lib/system-logs/client', () => ({ reportClientError }))

const ORG = '11111111-1111-1111-1111-111111111111'
const document: any = { id: 'doc-1', order_id: 'order-1', doc_type: 'SO', doc_no: 'SO-1', status: 'pending', issued_by_org_id: 'seller', issued_to_org_id: ORG }
const userProfile: any = { id: 'user-1', organization_id: ORG, signature_url: 'https://x.test/sig.png', organizations: { org_type_code: 'HQ' }, roles: { role_level: 10 } }
const respond = (status: number, body: unknown) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body, headers: new Headers() }))
const lastToast = () => {
  const { title, description, variant } = toast.mock.calls.at(-1)![0]
  return { title, variant, text: typeof description === 'string' ? description : renderToStaticMarkup(description) }
}
const acknowledge = async (onSuccess = vi.fn()) => {
  render(<AcknowledgeButton document={document} userProfile={userProfile} onSuccess={onSuccess} />)
  fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }))
  await waitFor(() => expect(toast).toHaveBeenCalled())
  return onSuccess
}

beforeEach(() => {
  toast.mockReset()
  reportClientError.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AcknowledgeButton messages', () => {
  it('confirms a valid acknowledgement', async () => {
    vi.stubGlobal('fetch', respond(200, { success: true }))
    const onSuccess = await acknowledge()
    expect(onSuccess).toHaveBeenCalled()
    expect(lastToast().text).toBe('Sales Order acknowledged.')
  })

  it('shows the agreed message and server reference for a system failure', async () => {
    vi.stubGlobal('fetch', respond(500, { error: 'x', code: 'ack_system_failure', referenceId: 'SYS-7K3M9QX2' }))
    await acknowledge()
    const shown = lastToast()
    expect(shown.title).toBe('Unable to acknowledge document')
    expect(shown.text).toContain('Please contact your administrator if the issue continues.')
    expect(shown.text).toContain('Reference: SYS-7K3M9QX2')
    expect(reportClientError).not.toHaveBeenCalled()
  })

  it('never shows raw technical text, even from an old or malformed response', async () => {
    vi.stubGlobal('fetch', respond(400, { error: 'new row violates check constraint "document_signatures_document_type_check"' }))
    reportClientError.mockReturnValue('ERR-7K3M9QX2TB4R')
    await acknowledge()
    expect(lastToast().text).not.toContain('document_signatures')
    expect(lastToast().text).toContain('Reference: ERR-7K3M9QX2TB4R')
  })

  it('gives a reference when the request never reaches the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    reportClientError.mockReturnValue('ERR-7K3M9QX2TB4R')
    await acknowledge()
    expect(lastToast().title).toBe('Unable to acknowledge document')
    expect(lastToast().text).toContain('ERR-7K3M9QX2TB4R')
    expect(lastToast().text).not.toContain('Failed to fetch')
  })

  it('shows expected outcomes without a reference', async () => {
    vi.stubGlobal('fetch', respond(409, { error: 'x', code: 'ack_already_acknowledged' }))
    await acknowledge()
    expect(lastToast().title).toBe('Already Acknowledged')
    expect(lastToast().text).not.toContain('Reference')
    expect(reportClientError).not.toHaveBeenCalled()
  })

  it('shows an access denial from the Security & Access guard as not authorized', async () => {
    vi.stubGlobal('fetch', respond(403, { error: 'Forbidden', code: 'sa_forbidden' }))
    await acknowledge()
    expect(lastToast().title).toBe('Not Authorized')
  })
})
