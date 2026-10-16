/** @vitest-environment jsdom */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NotificationTypesTab from './NotificationTypesTab'

const types = [
  ['Delete Organization Masterdata', 'delete_organization_verification_code', 'Delete Organization Verification Code', true],
  ['order', 'order_submitted', 'Order Submitted', true],
  ['order', 'order_rejected', 'Order Rejected', false],
  ['document', 'document_created', 'Document Created', true],
  ['inventory', 'low_stock', 'Low Stock', true],
  ['inventory', 'stock_count_posting_verification', 'Stock Count Posting Verification', true],
  ['qr', 'qr_scanned', 'QR Scanned', true],
  ['roadtour', 'roadtour_qr_delivery', 'RoadTour QR Delivery', true],
  ['user', 'user_created', 'User Created', true],
].map(([category, event_code, event_name, default_enabled]) => ({
  id: event_code,
  category,
  event_code,
  event_name,
  event_description: `${event_name} description`,
  default_enabled,
  available_channels: event_code === 'stock_count_posting_verification' ? ['email'] : ['whatsapp', 'email', 'sms'],
  is_system: false,
}))

let upsertResult: { data: any; error: any }
let settingsRows: any[] = []
const upsert = vi.fn()

function query(data: any[]) {
  const result: any = {
    select: () => result,
    order: () => result,
    eq: () => result,
    then: (resolve: (value: any) => void) => resolve({ data, error: null }),
  }
  return result
}

const supabase = {
  from: (table: string) => {
    if (table === 'notification_settings') {
      const q = query(settingsRows)
      q.upsert = (...args: any[]) => {
        upsert(...args)
        return { select: () => Promise.resolve(upsertResult) }
      }
      return q
    }
    return query(
      table === 'notification_types' ? types :
        table === 'notification_provider_configs' ? [
          { channel: 'whatsapp', is_active: true },
          { channel: 'email', is_active: true },
        ] : []
    )
  },
}

vi.mock('@/lib/hooks/useSupabaseAuth', () => ({
  useSupabaseAuth: () => ({ supabase, isReady: true }),
}))

let drawerProps: any = null
vi.mock('./NotificationFlowDrawer', () => ({ default: (props: any) => { drawerProps = props; return null } }))

const profile = {
  id: 'user-1', organization_id: 'org-1',
  organizations: { id: 'org-1', org_type_code: 'HQ' }, roles: { role_level: 1 },
}

async function renderTab() {
  render(<NotificationTypesTab userProfile={profile} />)
  await screen.findByRole('heading', { name: 'Notification Types' })
}

const moduleButton = (name: string) => within(screen.getByRole('region', { name })).getAllByRole('button')[0]
const categoryButton = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label.replace(/[&]/g, '\\$&')}, \\d+ of \\d+ enabled$`) })
async function openModule(name: string) { await userEvent.click(moduleButton(name)) }
async function openCategory(moduleName: string, label: string) {
  await openModule(moduleName)
  await userEvent.click(categoryButton(label))
}

beforeEach(() => {
  upsert.mockReset()
  upsertResult = { data: [{ id: 'x' }], error: null }
  settingsRows = []
  drawerProps = null
})
afterEach(cleanup)

describe('NotificationTypesTab', () => {
  it('starts with only the three module headers, collapsed, with real counts', async () => {
    await renderTab()
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Supply Chain', 'Customer & Growth', 'Platform & Settings'])
    for (const name of ['Supply Chain', 'Customer & Growth', 'Platform & Settings']) {
      expect(moduleButton(name).getAttribute('aria-expanded')).toBe('false')
    }
    expect(moduleButton('Supply Chain').textContent).toContain('3 categories · 4/5 enabled')
    expect(screen.queryByText('Order Status')).toBeNull()
    expect(screen.queryByText('RoadTour')).toBeNull()
  })

  it('groups every category under its S&A module, with real counts and provider state', async () => {
    await renderTab()
    expect(screen.getByText('Manage notifications by module.')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Expand all/ }))
    const supply = screen.getByRole('region', { name: 'Supply Chain' })
    expect(within(supply).getByText('Order Status')).toBeTruthy()
    expect(within(supply).getByText('Inventory & Stock')).toBeTruthy()
    expect(within(supply).getByText(/3 categories · 4\/5 enabled/)).toBeTruthy()
    const growth = screen.getByRole('region', { name: 'Customer & Growth' })
    expect(within(growth).getByText('QR & Consumer')).toBeTruthy()
    expect(within(growth).getByText('RoadTour')).toBeTruthy()
    const platform = screen.getByRole('region', { name: 'Platform & Settings' })
    expect(within(platform).getByText('Delete Organization Masterdata')).toBeTruthy()
    expect(within(platform).getByText('User Account')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Finance' })).toBeNull()
    expect(screen.queryByText('Delivery Summary')).toBeNull()
    expect(screen.getByText(/SMS · Not configured/)).toBeTruthy()
    expect(screen.getByText(/WhatsApp · Active/)).toBeTruthy()
  })

  it('shows the five delivery options as one radio group in the original order', async () => {
    await renderTab()
    const group = screen.getByRole('radiogroup', { name: 'Default delivery' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('value'))).toEqual(['whatsapp_only', 'email_only', 'sms_only', 'whatsapp_email_fallback', 'whatsapp_sms_email_fallback'])
    expect(radios.map((r) => r.textContent?.replace(' (provider not configured)', ''))).toEqual(['WhatsApp', 'Email', 'SMS', 'WhatsApp → Email', 'WhatsApp → SMS → Email'])
    // Nothing saved yet → the existing default route is selected.
    expect(within(group).getByRole('radio', { checked: true }).getAttribute('value')).toBe('whatsapp_email_fallback')
    // SMS has no active provider in this fixture, so SMS routes stay unavailable.
    expect((radios[2] as HTMLButtonElement).disabled).toBe(true)
    expect((radios[4] as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Applies only to categories and notifications that follow the default.')).toBeTruthy()
    expect(screen.queryByText(/Recommended/)).toBeNull()
  })

  it('loads the saved default instead of assuming one', async () => {
    settingsRows = [{
      id: 's1', org_id: 'org-1', event_code: 'user_created', enabled: true, channels_enabled: ['email'], priority: 'normal',
      recipient_config: { routing: { preset: 'email_only', source: 'default', default_preset: 'email_only', category_preset: null } },
    }]
    await renderTab()
    const group = screen.getByRole('radiogroup', { name: 'Default delivery' })
    expect(within(group).getByRole('radio', { checked: true }).getAttribute('value')).toBe('email_only')
  })

  it('opens the help by keyboard and supports arrow-key selection', async () => {
    await renderTab()
    screen.getByRole('button', { name: 'About default delivery' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText(/Arrows indicate fallback: the next channel is tried only if the previous channel fails\./)).toBeTruthy()
    await userEvent.keyboard('{Escape}')

    const group = screen.getByRole('radiogroup', { name: 'Default delivery' })
    within(group).getByRole('radio', { name: 'WhatsApp' }).focus()
    // Radix moves focus on a timer; hold the key until it lands (a real key-up comes later too).
    await userEvent.keyboard('{ArrowRight>}')
    await waitFor(() => expect(within(group).getByRole('radio', { checked: true }).getAttribute('value')).toBe('email_only'))
    await userEvent.keyboard('{/ArrowRight}')
    expect(document.activeElement?.getAttribute('value')).toBe('email_only')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })

  it('saves only the default and keeps overrides and disabled notifications', async () => {
    await renderTab()
    await openModule('Platform & Settings')
    await userEvent.selectOptions(screen.getByLabelText('User Account routing'), 'whatsapp_only')
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Default delivery' })).getByRole('radio', { name: 'Email' }))
    await userEvent.click(screen.getByRole('button', { name: /Save Changes/ }))
    const rows = upsert.mock.calls[0][0]
    for (const row of rows) expect(row.recipient_config.routing.default_preset).toBe('email_only')
    const userRow = rows.find((row: any) => row.event_code === 'user_created')
    expect(userRow.recipient_config.routing).toMatchObject({ preset: 'whatsapp_only', source: 'category', category_preset: 'whatsapp_only' })
    const inherited = rows.find((row: any) => row.event_code === 'order_submitted')
    expect(inherited.recipient_config.routing).toMatchObject({ preset: 'email_only', source: 'default' })
    expect(inherited.channels_enabled).toEqual(['email'])
    const fixed = rows.find((row: any) => row.event_code === 'stock_count_posting_verification')
    expect(fixed.recipient_config.routing).toMatchObject({ preset: 'email_only', source: 'event' })
    const disabled = rows.find((row: any) => row.event_code === 'order_rejected')
    expect(disabled.enabled).toBe(false)
    expect(disabled.channels_enabled).toEqual([])
  })

  it('labels inherited and custom delivery', async () => {
    await renderTab()
    await openModule('Supply Chain')
    const category = screen.getByLabelText('Order Status routing') as HTMLSelectElement
    expect(category.selectedOptions[0].textContent).toBe('Default · WhatsApp → Email')
    await userEvent.selectOptions(category, 'email_only')
    await userEvent.click(categoryButton('Order Status'))
    const event = screen.getByLabelText('Order Submitted routing') as HTMLSelectElement
    expect(event.selectedOptions[0].textContent).toBe('Category · Email')
    await userEvent.selectOptions(event, 'whatsapp_only')
    expect(event.selectedOptions[0].textContent).toBe('Custom · WhatsApp')
    // Changing the category again keeps the explicit notification override.
    await userEvent.selectOptions(category, 'default')
    expect(event.value).toBe('whatsapp_only')
  })

  it('shows Stock Count verification under Inventory & Stock as fixed email-only', async () => {
    await renderTab()
    await openCategory('Supply Chain', 'Inventory & Stock')
    const routing = screen.getByLabelText('Stock Count Posting Verification routing') as HTMLSelectElement
    expect(routing.value).toBe('email_only')
    expect(routing.disabled).toBe(true)
  })

  it('search reveals matches and clearing it restores the manual expansion', async () => {
    await renderTab()
    await openModule('Supply Chain')
    await userEvent.type(screen.getByLabelText('Search notifications'), 'verification code')
    expect(moduleButton('Platform & Settings').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Delete Organization Verification Code')).toBeTruthy()
    expect(screen.queryByText('Order Status')).toBeNull()
    await userEvent.clear(screen.getByLabelText('Search notifications'))
    expect(screen.queryByText('Delete Organization Verification Code')).toBeNull()
    expect(moduleButton('Platform & Settings').getAttribute('aria-expanded')).toBe('false')
    expect(moduleButton('Supply Chain').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Order Status')).toBeTruthy()
    expect(categoryButton('Order Status').getAttribute('aria-expanded')).toBe('false')
  })

  it('expands module → category → notification, and Expand/Collapse all covers both levels', async () => {
    await renderTab()
    await openModule('Customer & Growth')
    expect(screen.getByText('RoadTour')).toBeTruthy()
    expect(screen.queryByText('RoadTour QR Delivery')).toBeNull()
    await userEvent.click(categoryButton('RoadTour'))
    expect(screen.getByText('RoadTour QR Delivery')).toBeTruthy()
    await openModule('Supply Chain')
    expect(moduleButton('Customer & Growth').getAttribute('aria-expanded')).toBe('true')

    await userEvent.click(screen.getByRole('button', { name: /Expand all/ }))
    expect(screen.getByText('Order Submitted')).toBeTruthy()
    expect(screen.getByText('User Created')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Collapse all/ }))
    for (const name of ['Supply Chain', 'Customer & Growth', 'Platform & Settings']) {
      expect(moduleButton(name).getAttribute('aria-expanded')).toBe('false')
    }
    expect(screen.queryByText('Order Status')).toBeNull()
  })

  it('collapsing a module keeps unsaved edits and does not save', async () => {
    await renderTab()
    await openCategory('Platform & Settings', 'User Account')
    await userEvent.selectOptions(screen.getByLabelText('User Account routing'), 'email_only')
    await userEvent.click(screen.getByLabelText('Enable User Created'))
    await openModule('Platform & Settings')
    expect(screen.queryByLabelText('User Account routing')).toBeNull()
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    await openModule('Platform & Settings')
    expect((screen.getByLabelText('User Account routing') as HTMLSelectElement).value).toBe('email_only')
    expect(screen.getByLabelText('Enable User Created').getAttribute('aria-checked')).toBe('false')
    expect(upsert).not.toHaveBeenCalled()
  })

  it('filters by status per notification and offers a reset on empty results', async () => {
    await renderTab()
    await userEvent.selectOptions(screen.getByLabelText('Filter by status'), 'disabled')
    await userEvent.click(screen.getByRole('button', { name: /Expand all/ }))
    expect(screen.getByText('Order Status')).toBeTruthy()
    expect(screen.queryByText('User Account')).toBeNull()
    await userEvent.type(screen.getByLabelText('Search notifications'), 'nothing-matches-this')
    expect(screen.getByText('No notifications match these filters.')).toBeTruthy()
    await userEvent.click(screen.getAllByRole('button', { name: 'Reset filters' })[0])
    expect(screen.getAllByRole('region')).toHaveLength(3)
  })

  it('saves only after a change, and discard restores the saved state', async () => {
    await renderTab()
    await openModule('Platform & Settings')
    const save = screen.getByRole('button', { name: /Save Changes/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const category = screen.getByLabelText('User Account routing') as HTMLSelectElement
    await userEvent.selectOptions(category, 'email_only')
    expect(save.disabled).toBe(false)
    await userEvent.click(screen.getByRole('button', { name: /Discard/ }))
    expect(category.value).toBe('default')
    expect(save.disabled).toBe(true)

    await userEvent.selectOptions(category, 'email_only')
    await userEvent.click(save)
    expect(upsert).toHaveBeenCalledTimes(1)
    const rows = upsert.mock.calls[0][0]
    expect(rows).toHaveLength(types.length)
    const userRow = rows.find((row: any) => row.event_code === 'user_created')
    expect(userRow.channels_enabled).toEqual(['email'])
    expect(userRow.recipient_config.routing).toMatchObject({ preset: 'email_only', source: 'category', category_preset: 'email_only' })
    expect(await screen.findByText('Changes saved.')).toBeTruthy()
  })

  it('keeps edits and shows an error when saving fails', async () => {
    upsertResult = { data: null, error: { message: 'permission denied' } }
    await renderTab()
    await openModule('Platform & Settings')
    const category = screen.getByLabelText('User Account routing') as HTMLSelectElement
    await userEvent.selectOptions(category, 'email_only')
    await userEvent.click(screen.getByRole('button', { name: /Save Changes/ }))
    expect(await screen.findByText(/Changes were not saved: permission denied/)).toBeTruthy()
    expect(category.value).toBe('email_only')
    expect((screen.getByRole('button', { name: /Save Changes/ }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('saves a delivery change made in Configure as that notification\'s own setting', async () => {
    await renderTab()
    await openCategory('Supply Chain', 'Order Status')
    const configure = within(screen.getByText('Order Submitted').closest('li')!).getByRole('button', { name: /Configure/ })
    await userEvent.click(configure)
    expect(drawerProps.delivery).toMatchObject({ preset: 'whatsapp_email_fallback', source: 'default', eventPreset: null, forced: false })

    // Custom matching the inherited value stays custom.
    await drawerProps.onSave(drawerProps.setting, { eventPreset: 'whatsapp_email_fallback' })
    const record = upsert.mock.calls[0][0]
    expect(record.event_code).toBe('order_submitted')
    expect(record.recipient_config.routing).toMatchObject({ preset: 'whatsapp_email_fallback', source: 'event' })
    const event = screen.getByLabelText('Order Submitted routing') as HTMLSelectElement
    await waitFor(() => expect(event.value).toBe('whatsapp_email_fallback'))

    // Changing the default afterwards leaves the custom delivery alone.
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Default delivery' })).getByRole('radio', { name: 'Email' }))
    expect(event.value).toBe('whatsapp_email_fallback')
    expect((screen.getByLabelText('Order Rejected routing') as HTMLSelectElement).disabled).toBe(true)
  })

  it('a drawer save without delivery options publishes only the saved routing', async () => {
    await renderTab()
    await openCategory('Supply Chain', 'Order Status')
    await userEvent.selectOptions(screen.getByLabelText('Order Submitted routing'), 'email_only')
    await userEvent.click(within(screen.getByText('Order Submitted').closest('li')!).getByRole('button', { name: /Configure/ }))
    expect(drawerProps.delivery).toMatchObject({ preset: 'email_only', source: 'custom', eventPreset: 'email_only', savedEventPreset: null, pageHasOtherUnsavedChanges: false })
    await drawerProps.onSave(drawerProps.setting)
    expect(upsert.mock.calls[0][0].recipient_config.routing).toMatchObject({ preset: 'whatsapp_email_fallback', source: 'default' })
    // The unsaved page edit is still there for the page's own Save.
    expect((screen.getByLabelText('Order Submitted routing') as HTMLSelectElement).value).toBe('email_only')
  })
  it('flags other unsaved page edits separately from this notification\'s own delivery', async () => {
    await renderTab()
    await openCategory('Supply Chain', 'Order Status')
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Default delivery' })).getByRole('radio', { name: 'Email' }))
    await userEvent.click(within(screen.getByText('Order Submitted').closest('li')!).getByRole('button', { name: /Configure/ }))
    expect(drawerProps.delivery).toMatchObject({ inherited: { preset: 'email_only', source: 'default' }, savedEventPreset: null, pageHasOtherUnsavedChanges: true })
    await drawerProps.onSave(drawerProps.setting)
    // The page default stays unsaved and is still shown as pending.
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect(upsert.mock.calls[0][0].recipient_config.routing).toMatchObject({ default_preset: 'whatsapp_email_fallback' })
  })
})
