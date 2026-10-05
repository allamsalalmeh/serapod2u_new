import { describe, expect, it } from 'vitest'
import { collectConfiguredRecipients, previewNotificationRecipients, sourcesNotUsedWhenSending } from './configuredRecipients'

type Filter = [string, string, unknown]

/** Minimal users-table double that records filters so org scoping can be asserted. */
function usersClient(users: any[]) {
  const calls: Filter[][] = []
  return {
    calls,
    from: (_table: string) => {
      const filters: Filter[] = []
      calls.push(filters)
      const query: any = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.push(['eq', column, value]); return query },
        in: (column: string, values: unknown) => { filters.push(['in', column, values]); return query },
        then: (resolve: (value: any) => void) => resolve({
          data: users.filter((user) => filters.every(([op, column, value]) => (op === 'eq' ? user[column] === value : (value as unknown[]).includes(user[column])))),
          error: null,
        }),
      }
      return query
    },
  }
}

const people = [
  { id: 'u1', full_name: 'Una', phone: '0121111111', email: 'una@example.com', organization_id: 'org-1', role_code: 'HQ_ADMIN' },
  { id: 'u2', full_name: 'Other Org Admin', phone: '0122222222', email: 'other@example.com', organization_id: 'org-2', role_code: 'HQ_ADMIN' },
  { id: 'u3', full_name: 'Picked', phone: '0123333333', email: 'picked@example.com', organization_id: 'org-2', role_code: 'USER' },
]

const payload = { created_by: 'Creator', created_by_id: 'c1', created_by_phone: '0129999999', created_by_email: 'creator@example.com', customer_phone: '0128888888' }

const config = {
  roles: ['HQ_ADMIN'],
  recipient_users: ['u3'],
  manual_whatsapp_numbers: ['60127777777'],
  manual_email_addresses: ['Manual@Example.com'],
  recipient_targets: { order_creator: true, roles: true, users: true, consumer: true, dynamic_org: false },
}

describe('collectConfiguredRecipients (shared with the outbox worker)', () => {
  it('combines sources in worker order, dedupes, and keeps roles inside the organization', async () => {
    const client = usersClient(people)
    const whatsapp = await collectConfiguredRecipients(client, { orgId: 'org-1', eventCode: 'order_submitted', channel: 'whatsapp', recipientConfig: config, payload })
    expect(whatsapp.map((r) => [r.address, r.source])).toEqual([
      ['+60129999999', 'order_creator'],
      ['+60123333333', 'users'],
      ['+60121111111', 'roles'],
      ['+60127777777', 'manual_whatsapp'],
    ])
    // The other organization's admin is never included.
    expect(whatsapp.some((r) => r.name === 'Other Org Admin')).toBe(false)
    expect(client.calls[1]).toContainEqual(['eq', 'organization_id', 'org-1'])
  })

  it('uses channel-appropriate manual entries and consumer phones', async () => {
    const email = await collectConfiguredRecipients(usersClient(people), { orgId: 'org-1', eventCode: 'order_submitted', channel: 'email', recipientConfig: config, payload })
    expect(email.map((r) => r.address)).toEqual(['creator@example.com', 'picked@example.com', 'una@example.com', 'manual@example.com'])
    const sms = await collectConfiguredRecipients(usersClient(people), { orgId: 'org-1', eventCode: 'order_submitted', channel: 'sms', recipientConfig: config, payload })
    expect(sms.map((r) => r.source)).toEqual(['order_creator', 'users', 'roles', 'consumer'])
    expect(sms.some((r) => r.source === 'manual_whatsapp')).toBe(false)
  })

  it('returns nothing when nothing is configured', async () => {
    const none = await collectConfiguredRecipients(usersClient(people), {
      orgId: 'org-1', eventCode: 'order_submitted', channel: 'whatsapp',
      recipientConfig: { recipient_targets: { order_creator: false, roles: false, users: false, consumer: false, dynamic_org: false } },
      payload,
    })
    expect(none).toEqual([])
  })
})

describe('previewNotificationRecipients', () => {
  it('applies the creator-only shortcut exactly like the worker', async () => {
    const recipients = await previewNotificationRecipients(usersClient(people), {
      orgId: 'org-1', eventCode: 'order_rejected', channel: 'whatsapp', payload,
      recipientConfig: { recipient_targets: { order_creator: true } },
      eventAddress: { phone: '0129999999' },
    })
    expect(recipients).toEqual([{ address: '+60129999999', source: 'order_creator', name: 'Creator', userId: 'c1' }])
  })

  it('adds the address the event queues itself', async () => {
    const recipients = await previewNotificationRecipients(usersClient(people), {
      orgId: 'org-1', eventCode: 'order_submitted', channel: 'sms', payload,
      recipientConfig: { recipient_targets: { order_creator: false, roles: false, users: false, consumer: false } },
      eventAddress: { phone: '0128888888' },
    })
    expect(recipients).toEqual([{ address: '+60128888888', source: 'event_address', name: null, userId: null }])
  })

  it('reports Related organization as unused rather than resolving it', () => {
    expect(sourcesNotUsedWhenSending({ recipient_targets: { dynamic_org: true } })).toEqual(['dynamic_org'])
  })
})
