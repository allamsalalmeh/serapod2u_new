// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import TechnicalAccessPanel from './TechnicalAccessPanel'

afterEach(cleanup)

const svc = (id: string, name: string, kind: string, team: string | null, extra: any = {}) => ({
  id, name, identity_kind: kind, owner_team: team, status: 'active', credential_type: 'shared_secret', credential_reference: 'CRON_SECRET',
  credential_configured: true, last_used_at: null, purpose: `${name} purpose`, scope_description: `${name} scope`, ...extra,
})
const governance = { serviceIdentities: [
  svc('1', 'QR generation worker', 'queue_worker', 'Supply Chain'),
  svc('2', 'Serapp hold expiry', 'cron_worker', 'Supply Chain', { status: 'disabled' }),
  svc('3', 'WhatsApp agent', 'agent', 'Customer & Growth', { credential_configured: false, credential_reference: 'AGENT_KEY' }),
  svc('4', 'Application server', 'application_server', 'Platform', { last_used_at: '2026-09-30T03:30:00Z' }),
  svc('5', 'Shopify webhook', 'webhook', 'E-Commerce', { credential_type: 'none', credential_reference: null, credential_configured: null }),
  svc('6', 'Mystery job', 'cron_worker', null, { credential_reference: null, credential_configured: null }),
] }

describe('Technical Access → Service identities', () => {
  it('groups by module, collapsed, with credential and lifecycle summaries', () => {
    render(<TechnicalAccessPanel governance={governance} />)
    const groups = screen.getAllByRole('button', { name: /service(s)?, expand$/ }).map(b => b.getAttribute('aria-label'))
    // Shared taxonomy: E-Commerce is an area of Customer & Growth; Platform is Platform & Settings.
    expect(groups).toEqual([
      'Supply Chain, 2 services, expand', 'Customer & Growth, 2 services, expand',
      'Platform & Settings, 1 service, expand', 'Other / Unmapped, 1 service, expand',
    ])
    expect(screen.queryByText('QR generation worker')).toBeNull()
    expect(screen.getByText('2 configured here')).toBeTruthy()
    expect(screen.getByText('1 active · 1 disabled')).toBeTruthy()
    expect(screen.getByText('1 not configured here · 1 no credential')).toBeTruthy()
    expect(screen.getByText('1 managed elsewhere')).toBeTruthy()
  })

  it('expands several groups, shows service columns and existing details', async () => {
    render(<TechnicalAccessPanel governance={governance} />)
    await userEvent.click(screen.getByRole('button', { name: /^Supply Chain, 2 services/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Platform & Settings, 1 service/ }))
    expect(screen.getByText('QR generation worker')).toBeTruthy()
    expect(screen.getAllByText('Queue Worker').length).toBe(2)
    expect(screen.getAllByText('No usage recorded').length).toBe(2)
    expect(screen.getByText(new Date('2026-09-30T03:30:00Z').toLocaleString())).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^Application server, expand/ }))
    expect(screen.getByText('Application server purpose')).toBeTruthy()
    expect(screen.getByText('CRON_SECRET')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByText('QR generation worker')).toBeNull()
  })

  it('combines search, type and credential filters, auto-opens matches and restores on clear', async () => {
    render(<TechnicalAccessPanel governance={governance} />)
    await userEvent.click(screen.getByRole('button', { name: /^Platform & Settings, 1 service/ }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Search service identities' }), 'supply')
    expect(screen.getByText('QR generation worker')).toBeTruthy()
    expect(screen.getByText(/Showing 2 of 6 services/)).toBeTruthy()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Service type' }), 'cron_worker')
    expect(screen.queryByText('QR generation worker')).toBeNull()
    expect(screen.getByText('Serapp hold expiry')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^Credential not configured here\s*1$/ }))
    expect(screen.getByText(/No services match/)).toBeTruthy()
    await userEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0])
    expect(screen.getByText('Application server')).toBeTruthy()
    expect(screen.queryByText('QR generation worker')).toBeNull()
  })

  it('shows the area as a tag and keeps unknown teams visible', async () => {
    render(<TechnicalAccessPanel governance={governance} />)
    await userEvent.click(screen.getByRole('button', { name: /^Customer & Growth,/ }))
    expect(screen.getByText('E-Commerce')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^Other \/ Unmapped,/ }))
    expect(screen.getByText('Mystery job')).toBeTruthy()
  })

  it('shows loading and error states', () => {
    const { rerender } = render(<TechnicalAccessPanel governance={null} />)
    expect(screen.getByText(/Loading technical access/)).toBeTruthy()
    rerender(<TechnicalAccessPanel governance={null} error="Forbidden" />)
    expect(screen.getByRole('alert').textContent).toContain('Forbidden')
  })
})
