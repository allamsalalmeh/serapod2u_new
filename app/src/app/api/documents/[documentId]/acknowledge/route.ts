import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  canAcknowledgeOrderDocument,
  describeAcknowledgementDenial
} from '@/lib/documents/acknowledge-authorization'
import {
  ACK_SYSTEM_FAILURE_MESSAGE,
  acknowledgeFailure,
  expectedRpcFailure,
  type AcknowledgeFailure
} from '@/lib/documents/acknowledge-failure'
import { referenceHeaders, reportSystemFailure } from '@/lib/system-logs/server'

/**
 * Server-side acknowledgement gate.
 *
 * Every acknowledgement goes through here so authorization is enforced in one
 * place: hiding the button in React is a convenience, this route is the rule.
 * A user who is not authorized cannot acknowledge by calling the endpoint (or
 * the underlying RPC path) by hand.
 *
 * SO and DO have no database RPC of their own, and RLS `documents_write` only
 * lets the issuing organization write the row — which would lock the
 * distributor out of its own Sales Order. Those two are therefore applied with
 * the service-role client *after* this route has authorized the caller.
 * PO / INVOICE / PAYMENT keep their existing RPCs, called with the caller's own
 * session so `auth.uid()` still drives signatures and downstream document
 * creation.
 */

type AcknowledgeableDocType = 'PO' | 'SO' | 'DO' | 'INVOICE' | 'PAYMENT'

const RPC_DOC_TYPES: readonly string[] = ['PO', 'INVOICE', 'PAYMENT']

const failed = (failure: AcknowledgeFailure, reason?: string) =>
  NextResponse.json({ error: failure.message, code: failure.code, ...(reason ? { reason } : {}) }, { status: failure.status })

/**
 * An unexpected failure: the technical detail goes to System Logs on the server, the user gets the reference.
 * Only the error's code and message are passed: a database error's `details` can quote row values.
 */
async function systemFailure(
  request: NextRequest,
  step: string,
  error: unknown,
  context: { documentId?: string; docType?: string; actorId?: string; organizationId?: string | null } = {}
) {
  const e = (error ?? {}) as { name?: string; code?: string; message?: string; stack?: string }
  console.error(`[acknowledge] ${step} failed:`, { code: e.code ?? null, name: e.name ?? null })
  const referenceId = await reportSystemFailure({
    error: { name: e.name, code: e.code, message: e.message, stack: e.stack },
    status: 500,
    module: 'Supply Chain',
    action: `document.acknowledge.${step}`,
    apiRoute: request.nextUrl?.pathname ?? null,
    method: 'POST',
    pagePath: request.headers?.get('referer') ?? null,
    actorId: context.actorId ?? null,
    organizationId: context.organizationId ?? null,
    userAgent: request.headers?.get('user-agent') ?? null,
    details: { step, document_id: context.documentId, doc_type: context.docType }
  })
  return NextResponse.json(
    { error: ACK_SYSTEM_FAILURE_MESSAGE, code: 'ack_system_failure', referenceId },
    { status: 500, headers: referenceHeaders(referenceId) }
  )
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ documentId: string }> }
) {
  let documentId: string | undefined
  let actorId: string | undefined
  try {
    documentId = (await context.params).documentId

    if (!documentId) {
      return failed(acknowledgeFailure('ack_invalid_request'))
    }

    const supabase = await createClient()
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return failed(acknowledgeFailure('ack_unauthenticated'))
    }
    actorId = user.id

    let body: { paymentProofUrl?: string | null } = {}
    try {
      body = await request.json()
    } catch {
      // Body is optional; only the invoice flow sends one.
    }

    const admin = createAdminClient()

    // Read the document and the caller's profile with the service role so the
    // decision is made on the true rows, not on whatever RLS lets the caller
    // see. Authorization is decided below, never by row visibility.
    const [{ data: document, error: documentError }, { data: profile, error: profileError }] =
      await Promise.all([
        admin
          .from('documents')
          .select('id, order_id, doc_type, doc_no, display_doc_no, status, issued_by_org_id, issued_to_org_id')
          .eq('id', documentId)
          .maybeSingle(),
        admin
          .from('users')
          .select('id, organization_id, role_code, signature_url, organizations!fk_users_organization(org_type_code), roles(role_level)')
          .eq('id', user.id)
          .maybeSingle()
      ])

    if (documentError) {
      return systemFailure(request, 'load_document', documentError, { documentId, actorId })
    }
    if (!document) {
      return failed(acknowledgeFailure('ack_not_found'))
    }
    if (profileError) {
      return systemFailure(request, 'load_profile', profileError, { documentId, actorId })
    }
    if (!profile) {
      return failed(acknowledgeFailure('ack_access_denied'))
    }
    const reportContext = {
      documentId,
      actorId,
      docType: String((document as any).doc_type),
      organizationId: (profile as any).organization_id ?? null
    }

    const { data: order, error: orderError } = await admin
      .from('orders')
      .select('id, order_no, order_type, buyer_org_id, seller_org_id, company_id')
      .eq('id', (document as any).order_id)
      .maybeSingle()

    if (orderError) {
      return systemFailure(request, 'load_order', orderError, reportContext)
    }

    const organization = Array.isArray((profile as any).organizations)
      ? (profile as any).organizations[0]
      : (profile as any).organizations
    const role = Array.isArray((profile as any).roles)
      ? (profile as any).roles[0]
      : (profile as any).roles

    const decision = canAcknowledgeOrderDocument({
      actor: {
        organizationId: (profile as any).organization_id,
        orgTypeCode: organization?.org_type_code ?? null,
        roleLevel: role?.role_level ?? null
      },
      document: document as any,
      order: (order as any) ?? null
    })

    // Workflow validity (pending state) stays with the module; authority is
    // the S&A decision for the organization the document is issued to (a
    // trusted row), with the historical rule as the legacy evaluator.
    if (!decision.allowed && decision.reason === 'not_pending') {
      return failed(acknowledgeFailure('ack_already_acknowledged'), decision.reason)
    }
    const saDenied = await guardUserOperation(user.id, 'supply_chain.document.acknowledge', {
      organizationId: (document as any).issued_to_org_id ?? null,
      resourceType: 'document',
      legacy: () => decision.allowed,
    })
    if (saDenied) {
      return decision.allowed
        ? saDenied
        : NextResponse.json(
            { error: describeAcknowledgementDenial(decision.reason), code: acknowledgeFailure('ack_access_denied').code, reason: decision.reason },
            { status: 403 }
          )
    }

    const docType = String((document as any).doc_type).toUpperCase() as AcknowledgeableDocType

    if (RPC_DOC_TYPES.includes(docType)) {
      // Existing RPCs, called as the signed-in user so auth.uid() stays correct.
      const rpcResult =
        docType === 'PO'
          ? await supabase.rpc('po_acknowledge', { p_document_id: documentId })
          : docType === 'INVOICE'
            ? await supabase.rpc('invoice_acknowledge', {
                p_document_id: documentId,
                // Omitted rather than null so the RPC's own DEFAULT NULL applies.
                p_payment_proof_url: body?.paymentProofUrl ?? undefined
              })
            : await (supabase as any).rpc('payment_acknowledge', { p_document_id: documentId })

      if (rpcResult.error) {
        const expected = expectedRpcFailure(rpcResult.error)
        return expected ? failed(expected) : systemFailure(request, 'rpc', rpcResult.error, reportContext)
      }

      return NextResponse.json({ success: true, documentId, docType })
    }

    if (docType !== 'SO' && docType !== 'DO') {
      return failed(acknowledgeFailure('ack_invalid_request'))
    }

    // SO / DO: no RPC exists, and RLS would block the issued-to organization
    // from writing the row. Authorized above, applied here.
    const { error: signatureError } = await admin.rpc('add_document_signature', {
      p_document_id: documentId,
      p_signer_user_id: user.id,
      p_signer_role: (profile as any).role_code ?? null
    } as any)

    if (signatureError) {
      return systemFailure(request, 'record_signature', signatureError, reportContext)
    }

    const acknowledgedAt = new Date().toISOString()
    const { data: updated, error: updateError } = await admin
      .from('documents')
      .update({
        status: 'acknowledged',
        acknowledged_by: user.id,
        acknowledged_at: acknowledgedAt,
        updated_at: acknowledgedAt
      })
      .eq('id', documentId)
      // Guard against a concurrent acknowledgement between the check and the write.
      .eq('status', 'pending')
      .select('id, status, acknowledged_at')
      .maybeSingle()

    if (updateError) {
      return systemFailure(request, 'update_document', updateError, reportContext)
    }

    if (!updated) {
      return failed(acknowledgeFailure('ack_already_acknowledged'), 'not_pending')
    }

    return NextResponse.json({ success: true, documentId, docType, document: updated })
  } catch (error: any) {
    return systemFailure(request, 'unexpected', error, { documentId, actorId })
  }
}
