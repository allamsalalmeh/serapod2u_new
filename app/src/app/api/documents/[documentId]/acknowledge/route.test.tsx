import { beforeEach, describe, expect, it, vi } from 'vitest'

// S&A in legacy mode: this suite tests the route's own rules.
vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)

const authGetUser = vi.fn()
const userRpc = vi.fn()
const adminRpc = vi.fn()
const documentUpdate = vi.fn()

let documentRow: any
let userRow: any
let orderRow: any

const reportSystemFailure = vi.hoisted(() => vi.fn())
vi.mock('@/lib/system-logs/server', () => ({
  reportSystemFailure,
  referenceHeaders: (reference: string | null) => (reference ? { 'x-request-id': reference } : {})
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: authGetUser },
    rpc: userRpc
  })
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: adminRpc,
    from: (table: string) => {
      if (table === 'documents') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: documentRow, error: null }) })
          }),
          update: (patch: any) => {
            documentUpdate(patch)
            return {
              eq: () => ({
                eq: () => ({
                  select: () => ({
                    maybeSingle: async () => ({
                      data: { id: documentRow.id, status: 'acknowledged', acknowledged_at: patch.acknowledged_at },
                      error: null
                    })
                  })
                })
              })
            }
          }
        }
      }
      if (table === 'users') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: userRow, error: null }) }) })
        }
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: orderRow, error: null }) }) })
      }
    }
  })
}))

const { POST } = await import('./route')

const HQ_ORG = '11111111-1111-1111-1111-111111111111'
const MAXVAPER_ORG = '22222222-2222-2222-2222-222222222222'
const OTHER_DISTRIBUTOR_ORG = '33333333-3333-3333-3333-333333333333'

const call = () =>
  POST(
    { json: async () => ({}) } as any,
    { params: Promise.resolve({ documentId: 'doc-so-152' }) }
  )

const asUser = (organization_id: string, org_type_code: string, role_level: number) => {
  userRow = {
    id: 'user-1',
    organization_id,
    role_code: 'HQ',
    signature_url: 'https://example.test/sig.png',
    organizations: { org_type_code },
    roles: { role_level }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  adminRpc.mockResolvedValue({ data: null, error: null })
  userRpc.mockResolvedValue({ data: null, error: null })
  reportSystemFailure.mockReset()
  reportSystemFailure.mockResolvedValue('SYS-7K3M9QX2')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // D2H sales order SO26000152: issued by HQ to distributor MAXVAPER.
  documentRow = {
    id: 'doc-so-152',
    order_id: 'order-152',
    doc_type: 'SO',
    doc_no: 'ORD-DH-0826-52',
    display_doc_no: 'SO26000152',
    status: 'pending',
    issued_by_org_id: HQ_ORG,
    issued_to_org_id: MAXVAPER_ORG
  }
  orderRow = {
    id: 'order-152',
    order_no: 'ORD-DH-0826-52',
    order_type: 'D2H',
    buyer_org_id: MAXVAPER_ORG,
    seller_org_id: HQ_ORG,
    company_id: 'company-1'
  }
  asUser(HQ_ORG, 'HQ', 10)
})

describe('POST /api/documents/[documentId]/acknowledge', () => {
  it('rejects an unauthenticated caller', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const response = await call()
    expect(response.status).toBe(401)
    expect(documentUpdate).not.toHaveBeenCalled()
  })

  it('acknowledges a D2H sales order for an HQ admin at level 10', async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(documentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'acknowledged', acknowledged_by: 'user-1' })
    )
    expect(adminRpc).toHaveBeenCalledWith(
      'add_document_signature',
      expect.objectContaining({ p_document_id: 'doc-so-152', p_signer_user_id: 'user-1' })
    )
  })

  it('acknowledges a D2H sales order for the distributor it was issued to', async () => {
    asUser(MAXVAPER_ORG, 'DIST', 30)
    const response = await call()
    expect(response.status).toBe(200)
    expect(documentUpdate).toHaveBeenCalled()
  })

  it('refuses a different distributor calling the endpoint directly', async () => {
    asUser(OTHER_DISTRIBUTOR_ORG, 'DIST', 10)
    const response = await call()
    expect(response.status).toBe(403)
    expect(documentUpdate).not.toHaveBeenCalled()
  })

  it.each([40, 50])('refuses an HQ user at level %i on a delivery order', async (level) => {
    documentRow = { ...documentRow, id: 'doc-do-152', doc_type: 'DO' }
    asUser(HQ_ORG, 'HQ', level)
    const response = await call()
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ reason: 'hq_role_level_not_authorized' })
    expect(documentUpdate).not.toHaveBeenCalled()
  })

  it('refuses a manufacturer on a D2H invoice and never calls the RPC', async () => {
    documentRow = { ...documentRow, doc_type: 'INVOICE' }
    asUser('44444444-4444-4444-4444-444444444444', 'MFG', 10)
    const response = await call()
    expect(response.status).toBe(403)
    expect(userRpc).not.toHaveBeenCalled()
  })

  it('delegates an authorized invoice to invoice_acknowledge as the caller', async () => {
    documentRow = { ...documentRow, doc_type: 'INVOICE' }
    asUser(HQ_ORG, 'HQ', 20)
    const response = await call()
    expect(response.status).toBe(200)
    expect(userRpc).toHaveBeenCalledWith('invoice_acknowledge', {
      p_document_id: 'doc-so-152',
      p_payment_proof_url: undefined
    })
    expect(documentUpdate).not.toHaveBeenCalled()
  })

  it('refuses HQ on a purchase order — only the manufacturer may acknowledge it', async () => {
    documentRow = {
      ...documentRow,
      doc_type: 'PO',
      issued_by_org_id: HQ_ORG,
      issued_to_org_id: '44444444-4444-4444-4444-444444444444'
    }
    asUser(HQ_ORG, 'HQ', 10)
    const response = await call()
    expect(response.status).toBe(403)
    expect(userRpc).not.toHaveBeenCalled()
  })

  it('reports an already acknowledged document as a conflict', async () => {
    documentRow = { ...documentRow, status: 'acknowledged' }
    const response = await call()
    expect(response.status).toBe(409)
    expect(documentUpdate).not.toHaveBeenCalled()
  })
})

describe('POST /api/documents/[id]/acknowledge failure handling', () => {
  const constraintError = {
    code: '23514',
    message: 'new row for relation "document_signatures" violates check constraint "document_signatures_document_type_check"',
    details: 'Failing row contains (secret-row-value)',
    hint: null
  }
  const asHq = () => asUser(HQ_ORG, 'HQ', 10)
  const expectNothingTechnical = (body: unknown) => {
    const text = JSON.stringify(body)
    for (const leak of ['document_signatures', 'constraint', 'relation', 'secret-row-value', '23514']) expect(text).not.toContain(leak)
  }

  it('turns the SO constraint failure into a safe response linked to a recorded reference', async () => {
    asHq()
    adminRpc.mockResolvedValue({ data: null, error: constraintError })
    const response = await call()
    const body = await response.json()
    expect(response.status).toBe(500)
    expect(body).toMatchObject({ code: 'ack_system_failure', referenceId: 'SYS-7K3M9QX2' })
    expect(response.headers.get('x-request-id')).toBe('SYS-7K3M9QX2')
    expectNothingTechnical(body)
    expect(documentUpdate).not.toHaveBeenCalled()
  })

  it('records who, what and where, and never the row values the database quoted', async () => {
    asHq()
    adminRpc.mockResolvedValue({ data: null, error: constraintError })
    await call()
    const report = reportSystemFailure.mock.calls[0][0]
    expect(report).toMatchObject({
      module: 'Supply Chain',
      action: 'document.acknowledge.record_signature',
      actorId: 'user-1',
      organizationId: HQ_ORG,
      details: { step: 'record_signature', doc_type: 'SO' }
    })
    expect(report.error.code).toBe('23514')
    expect(JSON.stringify(report)).not.toContain('secret-row-value')
  })

  it('keeps an unexpected RPC failure generic', async () => {
    asHq()
    documentRow = { ...documentRow, doc_type: 'INVOICE' }
    userRpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout at /internal/path' } })
    const response = await call()
    const body = await response.json()
    expect(response.status).toBe(500)
    expect(body.referenceId).toBe('SYS-7K3M9QX2')
    expect(JSON.stringify(body)).not.toContain('/internal/path')
  })

  it('reports an expected business rule as itself, without a system log entry', async () => {
    asHq()
    documentRow = { ...documentRow, doc_type: 'INVOICE' }
    userRpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'Payment proof is required for this organization' } })
    const response = await call()
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('ack_payment_proof_required')
    expect(reportSystemFailure).not.toHaveBeenCalled()
  })

  it('does not record an already acknowledged document or an access denial', async () => {
    asHq()
    documentRow = { ...documentRow, status: 'acknowledged' }
    expect((await (await call()).json()).code).toBe('ack_already_acknowledged')
    documentRow = { ...documentRow, status: 'pending' }
    asUser(OTHER_DISTRIBUTOR_ORG, 'DIST', 10)
    const denied = await call()
    expect(denied.status).toBe(403)
    expect((await denied.json()).code).toBe('ack_access_denied')
    expect(reportSystemFailure).not.toHaveBeenCalled()
  })

  it('still answers safely when the reporter itself returns no reference', async () => {
    asHq()
    reportSystemFailure.mockResolvedValue(null)
    adminRpc.mockResolvedValue({ data: null, error: constraintError })
    const response = await call()
    expect(response.status).toBe(500)
    expect((await response.json()).code).toBe('ack_system_failure')
  })
})
