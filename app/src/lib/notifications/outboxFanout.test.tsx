import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fanoutChildKeepsAddress,
  fanoutChildPayload,
  fanoutScope,
  selectFanoutRecipients,
} from './outboxFanout'

const worker = () => readFileSync(join(__dirname, '../../app/api/cron/notification-outbox-worker/route.ts'), 'utf8')

describe('notification fan-out', () => {
  it('a child row keeps the recipient it was queued for', () => {
    const child = fanoutChildPayload({ report_key: '2026-10-11:packing:9' })
    expect(fanoutChildKeepsAddress(child, 'sms', '+60120000002', null)).toBe(true)
    expect(fanoutChildKeepsAddress(child, 'email', null, 'a@b.com')).toBe(true)
    expect(fanoutChildKeepsAddress(child, 'sms', null, null)).toBe(false)
    expect(fanoutChildKeepsAddress({ report_key: 'x' }, 'sms', '+60120000002', null)).toBe(false)
  })

  it('groups the rows of one order or one report run', () => {
    expect(fanoutScope({ order_no: 'ORD1', report_key: 'k' })).toEqual({ order_no: 'ORD1' })
    expect(fanoutScope({ report_key: '2026-10-11:packing:9' })).toEqual({ report_key: '2026-10-11:packing:9' })
    expect(fanoutScope({})).toBeNull()
  })

  it('every configured person gets exactly one copy of a report', () => {
    const recipientList = ['+60120000001', '+60120000002', '+60120000003', '+60120000004']
    const origin = { report_key: '2026-10-11:packing:9' }
    const children = selectFanoutRecipients({ recipientList, channel: 'sms', payload: origin })
    expect(children).toEqual(recipientList.slice(1))

    // The worker leaves a child on its own address, so the delivered set is the list itself.
    const delivered = [recipientList[0], ...children.filter(phone => fanoutChildKeepsAddress(fanoutChildPayload(origin), 'sms', phone, null))]
    expect(new Set(delivered).size).toBe(recipientList.length)

    // A child never fans out again, and a retried origin skips people already queued.
    expect(selectFanoutRecipients({ recipientList, channel: 'sms', payload: fanoutChildPayload(origin) })).toEqual([])
    expect(selectFanoutRecipients({
      recipientList, channel: 'sms', payload: origin,
      existingSiblings: children.map(to_phone => ({ to_phone })),
    })).toEqual([])
  })

  it('the worker leaves fan-out children on their own address and scopes reports by run', () => {
    const source = worker()
    expect(source).toContain('!fanoutChildKeepsAddress(payload, channel, to_phone, to_email)')
    expect(source).toContain(".contains('payload_json', siblingScope)")
    expect(source).toContain(".contains('payload_json', duplicateScope)")
  })

  it('deactivated accounts are not recipients', () => {
    const source = worker()
    expect(source).toMatch(/\.in\('id', userIds\)\s*\.eq\('is_active', true\)/)
    expect(source).toMatch(/\.in\('role_code', resolvedRoleCodes\)\s*\.eq\('is_active', true\)/)
  })
})
