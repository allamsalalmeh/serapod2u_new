import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  canAcknowledgeOrderDocument,
  describeAcknowledgementDenial
} from '@/lib/documents/acknowledge-authorization'

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

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ documentId: string }> }
) {
  try {
    const { documentId } = await context.params

    if (!documentId) {
      return NextResponse.json({ error: 'Document id is required' }, { status: 400 })
    }

    const supabase = await createClient()
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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
      console.error('[acknowledge] Failed to load document:', documentError)
      return NextResponse.json({ error: 'Failed to load document' }, { status: 500 })
    }
    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }
    if (profileError) {
      console.error('[acknowledge] Failed to load user profile:', profileError)
      return NextResponse.json({ error: 'Failed to load user profile' }, { status: 500 })
    }
    if (!profile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 403 })
    }

    const { data: order, error: orderError } = await admin
      .from('orders')
      .select('id, order_no, order_type, buyer_org_id, seller_org_id, company_id')
      .eq('id', (document as any).order_id)
      .maybeSingle()

    if (orderError) {
      console.error('[acknowledge] Failed to load order:', orderError)
      return NextResponse.json({ error: 'Failed to load order' }, { status: 500 })
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
      return NextResponse.json(
        { error: describeAcknowledgementDenial(decision.reason), reason: decision.reason },
        { status: 409 }
      )
    }
    const saDenied = await guardUserOperation(user.id, 'supply_chain.document.acknowledge', {
      organizationId: (document as any).issued_to_org_id ?? null,
      resourceType: 'document',
      legacy: () => decision.allowed,
    })
    if (saDenied) {
      return decision.allowed
        ? saDenied
        : NextResponse.json({ error: describeAcknowledgementDenial(decision.reason), reason: decision.reason }, { status: 403 })
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
        const { message, details, hint, code } = rpcResult.error
        return NextResponse.json(
          { error: message || details || hint || `Acknowledgement failed (code ${code})` },
          { status: 400 }
        )
      }

      return NextResponse.json({ success: true, documentId, docType })
    }

    if (docType !== 'SO' && docType !== 'DO') {
      return NextResponse.json({ error: 'This document type cannot be acknowledged' }, { status: 400 })
    }

    // SO / DO: no RPC exists, and RLS would block the issued-to organization
    // from writing the row. Authorized above, applied here.
    const { error: signatureError } = await admin.rpc('add_document_signature', {
      p_document_id: documentId,
      p_signer_user_id: user.id,
      p_signer_role: (profile as any).role_code ?? null
    } as any)

    if (signatureError) {
      console.error('[acknowledge] Failed to record signature:', signatureError)
      return NextResponse.json(
        { error: signatureError.message || 'Failed to record document signature' },
        { status: 400 }
      )
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
      console.error('[acknowledge] Failed to acknowledge document:', updateError)
      return NextResponse.json(
        { error: updateError.message || 'Failed to acknowledge document' },
        { status: 400 }
      )
    }

    if (!updated) {
      return NextResponse.json(
        { error: 'This document has already been acknowledged.', reason: 'not_pending' },
        { status: 409 }
      )
    }

    return NextResponse.json({ success: true, documentId, docType, document: updated })
  } catch (error: any) {
    console.error('[acknowledge] Unexpected error:', error)
    return NextResponse.json(
      { error: error?.message || 'Failed to acknowledge document' },
      { status: 500 }
    )
  }
}
