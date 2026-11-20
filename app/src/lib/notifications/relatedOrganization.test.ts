import { describe, expect, it } from 'vitest'
import { notificationDb, supplyChainWorld, u } from '@/test-support/notificationDb'
import { RELATED_ORG_AUTO, relatedOrgTargetState, resolveRelatedOrgContact, resolveRelatedOrganization } from './relatedOrganization'
import { collectConfiguredRecipients, previewNotificationRecipients, sourcesNotUsedWhenSending, type RecipientDiagnostic } from './configuredRecipients'

const world = () => {
  const data = supplyChainWorld()
  return { data, db: notificationDb({ organizations: data.organizations, orders: data.orders, documents: data.documents, users: data.users }) }
}

const related = { dynamic_target: RELATED_ORG_AUTO, recipient_targets: { dynamic_org: true, order_creator: false, roles: false, users: false, consumer: false } }

async function contact(db: any, eventCode: string, payload: Record<string, any>, channel = 'whatsapp', dynamicTarget: unknown = RELATED_ORG_AUTO) {
  return resolveRelatedOrgContact(db, { orgId: u('hq'), eventCode, channel, dynamicTarget, payload })
}

describe('Related organization — transaction mapping', () => {
  it('D2H sales order reaches its own distributor (Eariel), never another distributor', async () => {
    const { db } = world()
    const eariel = await contact(db, 'order_submitted', { order_id: u('o-d2h-eariel'), order_no: 'SO26000001' })
    expect(eariel).toMatchObject({ status: 'resolved', address: '+60123456001', relationship: 'buyer', organization: { id: u('dist-eariel'), name: 'Eariel Distributor' } })
    const other = await contact(db, 'order_submitted', { order_id: u('o-d2h-b'), order_no: 'SO26000002' })
    expect(other).toMatchObject({ status: 'resolved', address: '+60123456002', organization: { id: u('dist-b') } })
  })

  it('H2M purchase order reaches its own manufacturer: A for A, B for B', async () => {
    const { db } = world()
    const a = await contact(db, 'order_approved', { order_id: u('o-h2m-a') })
    const b = await contact(db, 'order_approved', { order_id: u('o-h2m-b') })
    expect(a).toMatchObject({ status: 'resolved', address: '+60123456101', relationship: 'seller', organization: { id: u('mfg-a') } })
    expect(b).toMatchObject({ status: 'resolved', address: '+60123456102', organization: { id: u('mfg-b') } })
  })

  it('S2D order reaches the distributor the shop ordered from', async () => {
    const { db } = world()
    expect(await contact(db, 'order_submitted', { order_id: u('o-s2d') })).toMatchObject({ status: 'resolved', organization: { id: u('dist-eariel') }, relationship: 'seller' })
  })

  it('uses the organization master-data phone for WhatsApp/SMS and email for Email', async () => {
    const { db } = world()
    const payload = { order_id: u('o-d2h-eariel') }
    expect(await contact(db, 'order_closed', payload, 'whatsapp')).toMatchObject({ address: '+60123456001' })
    expect(await contact(db, 'order_closed', payload, 'sms')).toMatchObject({ address: '+60123456001' })
    expect(await contact(db, 'order_closed', payload, 'email')).toMatchObject({ address: 'orders@eariel.test' })
  })

  it('a newly triggered event reads the current contact, not an earlier one', async () => {
    const { db, data } = world()
    expect(await contact(db, 'order_submitted', { order_id: u('o-d2h-eariel') })).toMatchObject({ address: '+60123456001' })
    data.organizations.find((org) => org.id === u('dist-eariel'))!.contact_phone = '+60123450999'
    expect(await contact(db, 'order_submitted', { order_id: u('o-d2h-eariel') })).toMatchObject({ address: '+60123450999' })
  })

  it('finds the order by its number when the producer sent no order id, inside the owning organization only', async () => {
    const { db } = world()
    expect(await contact(db, 'qr_batch_generated', { order_no: 'PO26000002' })).toMatchObject({ status: 'resolved', organization: { id: u('mfg-b') } })
    // SO26000099 belongs to another company: never resolved for HQ.
    expect(await contact(db, 'order_submitted', { order_no: 'SO26000099' })).toMatchObject({ status: 'unresolved', reason: 'transaction_not_found' })
    expect(await contact(db, 'order_submitted', { order_id: u('o-other') })).toMatchObject({ status: 'unresolved', reason: 'outside_organization' })
  })

  it('document events use the parent order, not an assumption that a PO is H2M', async () => {
    const { db } = world()
    const po = await contact(db, 'po_created', { doc_type: 'PO', doc_no: 'PO-ORD-H2M-2', order_no: 'ORD-H2M-2' })
    expect(po).toMatchObject({ status: 'resolved', organization: { id: u('mfg-b') }, documentId: u('doc-po-b'), orderId: u('o-h2m-b') })
    const invoice = await contact(db, 'invoice_created', { doc_type: 'INVOICE', doc_no: 'INV-ORD-D2H-1', order_no: 'ORD-D2H-1' }, 'email')
    expect(invoice).toMatchObject({ status: 'resolved', address: 'orders@eariel.test', organization: { id: u('dist-eariel') } })
    const byId = await contact(db, 'po_acknowledged', { document_id: u('doc-po-a') })
    expect(byId).toMatchObject({ status: 'resolved', organization: { id: u('mfg-a') } })
  })

  it('warehouse events can use a saved Warehouse choice from the transaction', async () => {
    const { db } = world()
    expect(await contact(db, 'warehouse_received', { order_id: u('o-h2m-a'), warehouse_org_id: u('wh-1') }, 'sms', 'warehouse')).toMatchObject({ status: 'resolved', organization: { id: u('wh-1') }, relationship: 'warehouse' })
  })
})

describe('Related organization — missing data and unsupported mappings', () => {
  it('missing or invalid contact gives a reason and never falls back to another organization', async () => {
    const { db, data } = world()
    const eariel = data.organizations.find((org) => org.id === u('dist-eariel'))!
    eariel.contact_email = null as any
    expect(await contact(db, 'order_submitted', { order_id: u('o-d2h-eariel') }, 'email')).toMatchObject({ status: 'unresolved', reason: 'missing_email' })
    eariel.contact_phone = 'not a phone'
    expect(await contact(db, 'order_submitted', { order_id: u('o-d2h-eariel') }, 'sms')).toMatchObject({ status: 'unresolved', reason: 'invalid_phone' })
    const recipients = await collectConfiguredRecipients(db, { orgId: u('hq'), eventCode: 'order_submitted', channel: 'sms', recipientConfig: related, payload: { order_id: u('o-d2h-eariel') } })
    expect(recipients).toEqual([])
  })

  it('unknown order types, unexpected org types and inactive organizations resolve nobody', async () => {
    const { db, data } = world()
    data.orders.push({ id: u('o-weird'), order_no: 'W', display_doc_no: 'W1', order_type: 'X2Y', company_id: u('hq'), buyer_org_id: u('hq'), seller_org_id: u('mfg-a'), warehouse_org_id: null, created_by: null as any })
    expect(await contact(db, 'order_submitted', { order_id: u('o-weird') })).toMatchObject({ status: 'unresolved', reason: 'unsupported_transaction_type' })
    data.orders.push({ id: u('o-bad'), order_no: 'B', display_doc_no: 'B1', order_type: 'H2M', company_id: u('hq'), buyer_org_id: u('hq'), seller_org_id: u('shop-1'), warehouse_org_id: null, created_by: null as any })
    expect(await contact(db, 'order_submitted', { order_id: u('o-bad') })).toMatchObject({ status: 'unresolved', reason: 'unexpected_organization_type' })
    data.organizations.find((org) => org.id === u('mfg-a'))!.is_active = false
    expect(await contact(db, 'order_submitted', { order_id: u('o-h2m-a') })).toMatchObject({ status: 'unresolved', reason: 'organization_inactive' })
  })

  it('events without a transaction, and saved settings without a target, add nobody and say why', async () => {
    const { db } = world()
    expect(await contact(db, 'user_created', { order_id: u('o-h2m-a') })).toMatchObject({ reason: 'unsupported_event' })
    expect(await contact(db, 'order_submitted', { order_id: u('o-h2m-a') }, 'sms', null)).toMatchObject({ reason: 'not_configured' })
    expect(await contact(db, 'order_submitted', { order_id: u('o-h2m-a') }, 'sms', 'org_contact')).toMatchObject({ reason: 'legacy_target_ambiguous' })
  })

  it('an order number shared by two orders is ambiguous rather than guessed', async () => {
    const { db, data } = world()
    data.orders.push({ ...data.orders[2], id: u('o-dup') })
    expect(await resolveRelatedOrganization(db, { orgId: u('hq'), eventCode: 'order_submitted', dynamicTarget: RELATED_ORG_AUTO, payload: { order_no: 'PO26000001' } }))
      .toMatchObject({ status: 'unresolved', reason: 'transaction_ambiguous' })
  })
})

describe('Related organization — references and lookup failures', () => {
  it('a malformed order or document reference is reported, not ignored and not looked up', async () => {
    const { db } = world()
    expect(await contact(db, 'order_submitted', { order_id: 'ORD-123', order_no: 'SO26000001' }))
      .toMatchObject({ status: 'unresolved', reason: 'invalid_reference' })
    expect(await contact(db, 'po_created', { document_id: '42', doc_type: 'PO', doc_no: 'PO-ORD-H2M-1' }))
      .toMatchObject({ status: 'unresolved', reason: 'invalid_reference' })
    // Nothing was queried with the malformed value, and there was no fallback to order_no / doc_no.
    expect(db.queries.length).toBe(0)
  })

  it('an upper-case uuid is accepted (Postgres uuid comparison is case-insensitive)', async () => {
    const { db } = world()
    const upper = u('o-d2h-eariel').toUpperCase()
    expect(await contact(db, 'order_submitted', { order_id: upper })).toMatchObject({ status: 'resolved', organization: { id: u('dist-eariel') } })
    // The fixture stores lower-case ids, as Postgres returns them; the resolver normalises before querying.
    expect(db.queries[0].filters).toContainEqual(['eq', 'id', u('o-d2h-eariel')])
  })

  it('a database error is reported as a failed lookup, never as "not found"', async () => {
    const data = supplyChainWorld()
    const db = notificationDb({ organizations: data.organizations, orders: data.orders, documents: data.documents }, { errors: { orders: 'statement timeout' } })
    expect(await contact(db, 'order_submitted', { order_id: u('o-d2h-eariel') }))
      .toMatchObject({ status: 'unresolved', reason: 'lookup_failed', message: expect.stringContaining('statement timeout') })
  })

  it('a document of another company is outside the organization', async () => {
    const { db, data } = world()
    data.documents.push({ id: u('doc-foreign'), order_id: u('o-other'), doc_type: 'PO', doc_no: 'PO-X', company_id: u('hq-2'), issued_by_org_id: u('hq-2'), issued_to_org_id: u('mfg-a') })
    expect(await contact(db, 'po_created', { document_id: u('doc-foreign') })).toMatchObject({ status: 'unresolved', reason: 'outside_organization' })
  })

  it('a payload warehouse that differs from the order warehouse is not trusted', async () => {
    const { db } = world()
    expect(await contact(db, 'warehouse_received', { order_id: u('o-h2m-a'), warehouse_org_id: u('shop-1') }, 'sms', 'warehouse'))
      .toMatchObject({ status: 'unresolved', reason: 'transaction_ambiguous' })
  })
})

describe('Saved Related organization choices', () => {
  it('reads saved values without reinterpreting them', () => {
    expect(relatedOrgTargetState(RELATED_ORG_AUTO)).toEqual({ kind: 'auto' })
    expect(relatedOrgTargetState('manufacturer')).toEqual({ kind: 'explicit', target: 'manufacturer' })
    expect(relatedOrgTargetState('')).toEqual({ kind: 'unset' })
    expect(relatedOrgTargetState('org_contact')).toEqual({ kind: 'unknown', value: 'org_contact' })
  })

  it('a saved "manufacturer" choice reaches only the manufacturer party of that order', async () => {
    const { db } = world()
    expect(await contact(db, 'order_approved', { order_id: u('o-h2m-b') }, 'whatsapp', 'manufacturer')).toMatchObject({ organization: { id: u('mfg-b') } })
    // A D2H order has no manufacturer party: nobody, not "all manufacturers".
    expect(await contact(db, 'order_approved', { order_id: u('o-d2h-eariel') }, 'whatsapp', 'manufacturer')).toMatchObject({ status: 'unresolved', reason: 'unexpected_organization_type' })
    // "distributor" on a D2H order is the buying distributor (the old "Seller" label was wrong).
    expect(await contact(db, 'order_approved', { order_id: u('o-d2h-eariel') }, 'whatsapp', 'distributor')).toMatchObject({ organization: { id: u('dist-eariel') }, relationship: 'buyer' })
  })
})

describe('Related organization + Specific users', () => {
  const both = { ...related, recipient_users: [u('u-sales'), u('u-eariel-owner')], recipient_targets: { ...related.recipient_targets, users: true } }

  it('related only → the organization contact; users only → the users; both → the union', async () => {
    const { db } = world()
    const payload = { order_id: u('o-d2h-eariel') }
    const orgOnly = await collectConfiguredRecipients(db, { orgId: u('hq'), eventCode: 'order_submitted', channel: 'whatsapp', recipientConfig: related, payload })
    expect(orgOnly.map((r) => [r.address, r.source])).toEqual([['+60123456001', 'related_org']])
    const usersOnly = await collectConfiguredRecipients(db, { orgId: u('hq'), eventCode: 'order_submitted', channel: 'whatsapp', payload, recipientConfig: { recipient_users: [u('u-sales')], recipient_targets: { users: true } } })
    expect(usersOnly.map((r) => [r.address, r.source])).toEqual([['+60128888888', 'users']])
    const union = await collectConfiguredRecipients(db, { orgId: u('hq'), eventCode: 'order_submitted', channel: 'whatsapp', recipientConfig: both, payload })
    // Eariel Owner has the organization's phone (in local format): sent once.
    expect(union.map((r) => [r.address, r.source])).toEqual([['+60123456001', 'related_org'], ['+60128888888', 'users']])
    const email = await collectConfiguredRecipients(db, { orgId: u('hq'), eventCode: 'order_submitted', channel: 'email', recipientConfig: both, payload })
    // ORDERS@eariel.test and orders@eariel.test are one address.
    expect(email.map((r) => r.address)).toEqual(['orders@eariel.test', 'sam@serapod.test'])
  })

  it('reports unavailable users and an unresolved organization instead of hiding them', async () => {
    const { db, data } = world()
    data.organizations.find((org) => org.id === u('dist-eariel'))!.contact_phone = null as any
    const diagnostics: RecipientDiagnostic[] = []
    const recipients = await collectConfiguredRecipients(db, {
      orgId: u('hq'), eventCode: 'order_submitted', channel: 'sms', payload: { order_id: u('o-d2h-eariel') }, diagnostics,
      recipientConfig: { ...related, recipient_users: [u('u-sales'), u('u-gone')], recipient_targets: { ...related.recipient_targets, users: true } },
    })
    expect(recipients.map((r) => r.source)).toEqual(['users'])
    expect(diagnostics.map((d) => [d.source, d.reason])).toEqual([['related_org', 'missing_phone'], ['users', 'users_unavailable']])
  })
})

describe('Preview / worker parity', () => {
  it('the drawer preview resolves the same recipients the worker collects, plus the queued address', async () => {
    const { db } = world()
    const config = { ...related, recipient_users: [u('u-sales')], recipient_targets: { ...related.recipient_targets, users: true } }
    for (const channel of ['whatsapp', 'sms', 'email']) {
      for (const orderId of [u('o-d2h-eariel'), u('o-h2m-a'), u('o-h2m-b')]) {
        const input = { orgId: u('hq'), eventCode: 'order_submitted', channel, recipientConfig: config, payload: { order_id: orderId } }
        const worker = await collectConfiguredRecipients(db, input)
        const preview = await previewNotificationRecipients(db, { ...input, eventAddress: {} })
        expect(preview.map((r) => [r.address, r.source])).toEqual(worker.map((r) => [r.address, r.source]))
      }
    }
    expect(sourcesNotUsedWhenSending(config)).toEqual([])
  })
})
