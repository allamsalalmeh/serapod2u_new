import { describe, expect, it } from 'vitest'
import { ACK_SYSTEM_FAILURE_MESSAGE, ACK_SYSTEM_FAILURE_TITLE, acknowledgeFailure, acknowledgeToast, expectedRpcFailure } from './acknowledge-failure'

describe('expectedRpcFailure', () => {
  it('recognises only the business rules the acknowledge RPCs raise on purpose', () => {
    expect(expectedRpcFailure({ message: 'PO must be pending' })?.code).toBe('ack_already_acknowledged')
    expect(expectedRpcFailure({ message: 'Payment document not found' })?.code).toBe('ack_not_found')
    expect(expectedRpcFailure({ message: 'Payment proof is required for this organization' })?.code).toBe('ack_payment_proof_required')
    expect(expectedRpcFailure({ code: '42501', message: 'permission denied for function po_acknowledge' })?.code).toBe('ack_access_denied')
  })

  it('leaves everything else to be handled as a system failure', () => {
    expect(expectedRpcFailure({ code: '23514', message: 'new row for relation "document_signatures" violates check constraint "document_signatures_document_type_check"' })).toBeNull()
    expect(expectedRpcFailure({ code: '57014', message: 'canceling statement due to statement timeout' })).toBeNull()
    expect(expectedRpcFailure(null)).toBeNull()
  })
})

describe('acknowledgeToast', () => {
  it('shows the agreed wording and the server reference for a system failure', () => {
    expect(acknowledgeToast({ code: 'ack_system_failure', referenceId: 'SYS-7K3M9QX2' })).toEqual({
      title: ACK_SYSTEM_FAILURE_TITLE,
      description: ACK_SYSTEM_FAILURE_MESSAGE,
      reference: 'SYS-7K3M9QX2',
    })
  })

  it('gives expected outcomes their own message and no reference', () => {
    const toast = acknowledgeToast({ code: 'ack_already_acknowledged' })
    expect(toast.title).toBe('Already Acknowledged')
    expect(toast.description).toBe(acknowledgeFailure('ack_already_acknowledged').message)
    expect(toast.reference).toBeUndefined()
  })

  it('treats a guard denial as access denied whatever its body says', () => {
    expect(acknowledgeToast({ code: 'sa_forbidden', error: 'forbidden' } as any, null, 403).title).toBe('Not Authorized')
    expect(acknowledgeToast(null, null, 401).title).toBe('Session Ended')
  })

  it('never shows the text of an unrecognised response', () => {
    const toast = acknowledgeToast({ code: 'whatever', error: 'relation "public.documents" at /app/src/x.ts' } as any, 'ERR-7K3M9QX2TB4R', 502)
    expect(toast).toEqual({ title: ACK_SYSTEM_FAILURE_TITLE, description: ACK_SYSTEM_FAILURE_MESSAGE, reference: 'ERR-7K3M9QX2TB4R' })
    expect(JSON.stringify(toast)).not.toContain('relation')
  })
})
