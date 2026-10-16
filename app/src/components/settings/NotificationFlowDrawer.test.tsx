/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NotificationFlowDrawer, { type DrawerDelivery } from './NotificationFlowDrawer'

vi.mock('./recipients/UserMultiSelect', () => ({
  UserMultiSelect: ({ selectedUserIds }: { selectedUserIds: string[] }) => <div data-testid="user-select">{selectedUserIds.length} selected</div>,
}))

const allAvailable = { whatsapp_only: true, email_only: true, sms_only: true, whatsapp_email_fallback: true, whatsapp_sms_email_fallback: true }

const orderSubmitted = {
  event_code: 'order_submitted',
  event_name: 'Order Submitted',
  event_description: 'A new order needs approval',
  category: 'order',
  available_channels: ['whatsapp', 'email', 'sms'],
  is_system: false,
}

function baseSetting(overrides: Record<string, any> = {}) {
  return {
    org_id: 'org-1',
    event_code: 'order_submitted',
    enabled: true,
    channels_enabled: ['whatsapp'],
    priority: 'normal',
    templates: { whatsapp: 'Order {{order_no}} by {{User}}', email: 'Email for {{order_no}}' },
    recipient_config: {
      roles: ['HQ_ADMIN'],
      recipient_users: ['user-a'],
      recipient_targets: { roles: false, dynamic_org: false, users: true, consumer: false, order_creator: true },
    },
    ...overrides,
  }
}

function delivery(overrides: Partial<DrawerDelivery> = {}): DrawerDelivery {
  return {
    preset: 'whatsapp_email_fallback',
    source: 'category',
    inherited: { preset: 'whatsapp_email_fallback', source: 'category' },
    eventPreset: null,
    savedEventPreset: null,
    forced: false,
    presetAvailable: allAvailable,
    ...overrides,
  }
}

function renderDrawer(props: { setting?: any; type?: any; delivery?: DrawerDelivery } = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onOpenChange = vi.fn()
  render(
    <NotificationFlowDrawer
      open
      onOpenChange={onOpenChange}
      setting={props.setting || baseSetting()}
      type={props.type || orderSubmitted}
      delivery={props.delivery || delivery()}
      onSave={onSave}
    />,
  )
  return { onSave, onOpenChange }
}

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('NotificationFlowDrawer', () => {
  it('shows one screen with summary, recipients and message instead of tabs', () => {
    renderDrawer()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByText('Flow')).toBeNull()
    const summary = screen.getByLabelText('Summary')
    expect(summary.textContent).toContain('Order Submitted')
    expect(summary.textContent).toContain('Order creator, Specific users · 1')
    expect(summary.textContent).toContain('WhatsApp → Email')
    const chips = within(screen.getByRole('list', { name: 'Selected recipients' })).getAllByRole('listitem').map((item) => item.textContent)
    expect(chips).toEqual(['Order creator', 'Specific users · 1'])
    expect(screen.getByText('Inherited from category')).toBeTruthy()
    // Additional options and Test notification start collapsed.
    expect(screen.getByRole('button', { name: 'Additional options' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: 'Test notification' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('states the real behavior when no recipient source is selected', () => {
    renderDrawer({ setting: baseSetting({ recipient_config: { roles: [], recipient_targets: { roles: false, dynamic_org: false, users: false, consumer: false, order_creator: false } } }) })
    expect(screen.getByText(/No recipient sources selected/)).toBeTruthy()
    expect(screen.getByLabelText('Summary').textContent).toContain('No recipient sources')
  })

  it('keeps recipient and per-channel template edits across inline editors and saves them all', async () => {
    const { onSave } = renderDrawer()
    await userEvent.click(screen.getByRole('button', { name: /Edit recipients/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /WhatsApp numbers/ }))
    await userEvent.type(screen.getByLabelText('WhatsApp numbers'), '0123456789')
    await userEvent.click(screen.getByRole('checkbox', { name: /^Roles/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('WhatsApp numbers · 1')).toBeTruthy()
    expect(screen.getByText('Roles · Admin')).toBeTruthy()

    // Edit the Email message, switch channels, and come back: both drafts survive.
    await userEvent.click(screen.getByRole('button', { name: /Edit message/ }))
    await userEvent.click(within(screen.getByRole('group', { name: 'Message channel' })).getByRole('button', { name: /Email/ }))
    const editor = screen.getByLabelText('Email message') as HTMLTextAreaElement
    expect(editor.value).toBe('Email for {{order_no}}')
    await userEvent.type(editor, ' updated')
    await userEvent.click(within(screen.getByRole('group', { name: 'Message channel' })).getByRole('button', { name: /WhatsApp/ }))
    expect((screen.getByLabelText('WhatsApp message') as HTMLTextAreaElement).value).toBe('Order {{order_no}} by {{User}}')
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))

    await userEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(onSave).toHaveBeenCalledTimes(1)
    const [saved, options] = onSave.mock.calls[0]
    expect(saved.templates).toEqual({ whatsapp: 'Order {{order_no}} by {{User}}', email: 'Email for {{order_no}} updated' })
    expect(saved.recipient_config.manual_whatsapp_numbers).toEqual(['60123456789'])
    expect(saved.recipient_config.recipient_targets).toMatchObject({ order_creator: true, users: true, roles: true })
    expect(saved.recipient_config.recipient_users).toEqual(['user-a'])
    // Delivery untouched: the drawer does not publish routing.
    expect(options).toBeUndefined()
  })

  it('blocks save on invalid manual numbers and reopens the recipients editor', async () => {
    const { onSave } = renderDrawer({ setting: baseSetting({ recipient_config: { recipient_targets: { order_creator: true }, manual_whatsapp_numbers: ['60123456789'] } }) })
    await userEvent.click(screen.getByRole('button', { name: /Edit recipients/ }))
    await userEvent.type(screen.getByLabelText('WhatsApp numbers'), '\nabc')
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    await userEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('invalid WhatsApp number')
    expect(screen.getByLabelText('WhatsApp numbers')).toBeTruthy()
  })

  it('Cancel closes without saving draft changes', async () => {
    const { onSave, onOpenChange } = renderDrawer()
    await userEvent.click(screen.getByRole('button', { name: /Edit message/ }))
    await userEvent.type(screen.getByLabelText('WhatsApp message'), ' draft')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps a custom delivery custom even when it matches the inherited one', async () => {
    const { onSave } = renderDrawer()
    await userEvent.click(screen.getByRole('button', { name: 'Additional options' }))
    const select = screen.getByLabelText('Delivery for Order Submitted') as HTMLSelectElement
    expect(select.selectedOptions[0].textContent).toBe('Inherit · Category · WhatsApp → Email')
    await userEvent.selectOptions(select, 'whatsapp_email_fallback')
    expect(screen.getByText('Custom for this notification')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(onSave.mock.calls[0][1]).toEqual({ eventPreset: 'whatsapp_email_fallback' })
  })

  it('can return a custom delivery to inherit', async () => {
    const { onSave } = renderDrawer({ delivery: delivery({ preset: 'sms_only', source: 'custom', eventPreset: 'sms_only', savedEventPreset: 'sms_only' }) })
    expect(screen.getByText('Custom for this notification')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Additional options' }))
    await userEvent.selectOptions(screen.getByLabelText('Delivery for Order Submitted'), 'inherit')
    expect(screen.getByText('Inherited from category')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(onSave.mock.calls[0][1]).toEqual({ eventPreset: null })
  })

  it('previews with sample data, keeps unknown placeholders visible and flags them', () => {
    renderDrawer({ setting: baseSetting({ templates: { whatsapp: 'Hi {{user}}, order {{order_no}} by {{User}}' } }) })
    const preview = screen.getByTestId('message-preview')
    expect(preview.textContent).toContain('order ORD26000048 by Order Creator')
    expect(within(preview).getByText('{{user}}').tagName).toBe('MARK')
    expect(screen.getByText(/\{\{user\}\} is not supplied for this notification/)).toBeTruthy()
  })

  it('labels SMS tests as SMS and posts the draft SMS template', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) })
    renderDrawer({
      setting: baseSetting({ templates: { sms: 'os_sms_1' } }),
      delivery: delivery({ preset: 'sms_only', source: 'custom', eventPreset: 'sms_only', savedEventPreset: 'sms_only' }),
    })
    await userEvent.click(screen.getByRole('button', { name: 'Test notification' }))
    expect(screen.queryByText(/WhatsApp/)).toBeNull()
    await userEvent.type(screen.getByLabelText('Send to a phone number'), '0123456789')
    await userEvent.click(screen.getByRole('button', { name: 'Send test SMS' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.channel).toBe('sms')
    expect(body.recipient.phone).toBe('0123456789')
    // A stored library id is sent as that template's body, as the worker would.
    expect(body.template).toContain('submitted by {{User}}')
    expect(await screen.findByText('Test SMS sent to 0123456789.')).toBeTruthy()
  })

  it('names the fallback step being tested and does not offer email test sends', async () => {
    renderDrawer({ delivery: delivery({ preset: 'whatsapp_sms_email_fallback', inherited: { preset: 'whatsapp_sms_email_fallback', source: 'default' }, source: 'default' }) })
    await userEvent.click(screen.getByRole('button', { name: 'Test notification' }))
    const group = screen.getByRole('group', { name: 'Channel to test' })
    await userEvent.click(within(group).getByRole('button', { name: 'SMS (fallback)' }))
    expect(screen.getByText(/step 2 of WhatsApp → SMS → Email/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send test SMS' })).toBeTruthy()
    await userEvent.click(within(group).getByRole('button', { name: 'Email (fallback)' }))
    expect(screen.getByText(/Email test sending isn.t available/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Send test/ })).toBeNull()
  })

  it('lists real resolved recipients for the tested channel and sends only to one of them', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, status: 'resolved', channel: 'whatsapp', notUsedWhenSending: [], recipients: [
      { address: '+60111111111', source: 'order_creator', name: 'Creator One' },
      { address: '+60122222222', source: 'manual_whatsapp' },
    ] }) })
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) })
    renderDrawer()
    await userEvent.click(screen.getByRole('button', { name: 'Test notification' }))
    await userEvent.type(screen.getByLabelText('Send to a resolved recipient'), 'ORD1')
    await userEvent.click(screen.getByRole('button', { name: 'Find recipients' }))
    const url = new URL(fetchMock.mock.calls[0][0], 'http://x')
    expect(url.searchParams.get('channel')).toBe('whatsapp')
    expect(JSON.parse(url.searchParams.get('recipientConfig')!).recipient_targets.order_creator).toBe(true)
    const list = await screen.findByRole('list', { name: 'Resolved recipients' })
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Creator One+60111111111 · Order creator',
      '+60122222222Manual WhatsApp',
    ])
    await userEvent.click(screen.getByRole('button', { name: /Send test WhatsApp to Creator One/ }))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).recipient.phone).toBe('+60111111111')
  })

  it('reports empty, not-found and failed lookups without inventing anyone', async () => {
    renderDrawer()
    await userEvent.click(screen.getByRole('button', { name: 'Test notification' }))
    const input = screen.getByLabelText('Send to a resolved recipient')
    const find = () => userEvent.click(screen.getByRole('button', { name: 'Find recipients' }))

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, status: 'empty', channel: 'whatsapp', recipients: [], notUsedWhenSending: [] }) })
    await userEvent.type(input, 'ORD1')
    await find()
    expect(await screen.findByText('No WhatsApp recipients resolve for this order.')).toBeTruthy()

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, status: 'not_found', recipients: [], message: 'No order ORD2 found in your organization.' }) })
    await userEvent.type(input, '2')
    await find()
    expect(await screen.findByText('No order ORD2 found in your organization.')).toBeTruthy()

    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, status: 'error', error: 'boom' }) })
    await userEvent.type(input, '3')
    await find()
    expect((await screen.findByRole('alert')).textContent).toBe('Lookup failed: boom')
    expect(screen.queryByRole('button', { name: /Send test WhatsApp to/ })).toBeNull()
  })

  it('does not offer a sample lookup for notifications the resolver cannot rebuild', async () => {
    renderDrawer({ type: { ...orderSubmitted, event_code: 'order_deleted', event_name: 'Order Deleted' }, setting: baseSetting({ event_code: 'order_deleted' }) })
    await userEvent.click(screen.getByRole('button', { name: 'Test notification' }))
    expect(screen.queryByRole('button', { name: 'Find recipients' })).toBeNull()
    expect(screen.getByText(/available for Order Submitted, Approved, Rejected and Closed only/)).toBeTruthy()
  })

  it('shows a server-side unsupported test result as a failure, not a send', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ success: false, status: 'unsupported', error: 'Email test sending is not available. No email was sent.' }) })
    renderDrawer({ delivery: delivery({ preset: 'sms_only', source: 'custom', eventPreset: 'sms_only', savedEventPreset: 'sms_only' }) })
    await userEvent.click(screen.getByRole('button', { name: 'Test notification' }))
    await userEvent.type(screen.getByLabelText('Send to a phone number'), '0123456789')
    await userEvent.click(screen.getByRole('button', { name: 'Send test SMS' }))
    expect((await screen.findByRole('status')).textContent).toBe('Failed: Email test sending is not available. No email was sent.')
  })

  it('saves the delivery it shows when that differs from the saved one, and says so', async () => {
    const { onSave } = renderDrawer({ delivery: delivery({ preset: 'email_only', source: 'custom', eventPreset: 'email_only', savedEventPreset: null, pageHasOtherUnsavedChanges: true }) })
    await userEvent.click(screen.getByRole('button', { name: 'Additional options' }))
    expect(screen.getByText(/Save changes will save this notification.s delivery as Custom · Email \(saved now: Inherit\)/)).toBeTruthy()
    expect(screen.getByText(/Other unsaved changes on the Notification Types page/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    expect(onSave.mock.calls[0][1]).toEqual({ eventPreset: 'email_only' })
  })

  it('marks fixed-message notifications and does not offer template test sends', async () => {
    renderDrawer({
      type: { ...orderSubmitted, event_code: 'delete_organization_verification_code', event_name: 'Delete Organization Verification Code', category: 'Delete Organization Masterdata' },
      setting: baseSetting({ event_code: 'delete_organization_verification_code', templates: {} }),
    })
    expect(screen.getByText(/The verification message is built by the deletion flow/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Test notification' }))
    expect(screen.queryByRole('button', { name: /Send test/ })).toBeNull()
  })

  it('offers exactly the variables the producer sends', async () => {
    renderDrawer({ type: { ...orderSubmitted, event_code: 'qr_batch_generated', event_name: 'QR Batch Generated' }, setting: baseSetting({ event_code: 'qr_batch_generated', templates: { whatsapp: 'Batch {{batch_id}} for {{amount}}' } }) })
    await userEvent.click(screen.getByRole('button', { name: /Edit message/ }))
    expect(screen.queryByRole('button', { name: '{{amount}}' })).toBeNull()
    expect(screen.getByRole('button', { name: '{{generated_at}}' })).toBeTruthy()
    expect(screen.getByText(/\{\{amount\}\} is not supplied for this notification/)).toBeTruthy()
  })

  it('opens the Monitor filtered to this notification in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderDrawer({ delivery: delivery({ preset: 'sms_only', source: 'custom', eventPreset: 'sms_only', savedEventPreset: 'sms_only' }) })
    await userEvent.click(screen.getByRole('button', { name: /View delivery logs/ }))
    const [url, target] = open.mock.calls[0] as [string, string]
    const params = new URL(url, 'http://x').searchParams
    expect(target).toBe('_blank')
    expect(Object.fromEntries(params)).toMatchObject({ channel: 'sms', module: 'supply_chain', type: 'order_submitted' })
    expect(params.get('from')! < params.get('to')!).toBe(true)
    open.mockRestore()
  })
})
