// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import AddOrganizationView from './AddOrganizationView'
import { ORG_CREATE_MESSAGES } from '@/lib/organizations/create-org-error'

const HQ = '10000000-0000-0000-0000-0000000000aa'
const NEW_ORG = '30000000-0000-0000-0000-000000000001'

const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

// Radix Select does not run in jsdom; a native <select> keeps the form's real handlers.
vi.mock('@/components/ui/select', () => {
  const Ctx = React.createContext<{ value?: string; onValueChange?: (v: string) => void; id?: string }>({})
  return {
    Select: ({ value, onValueChange, children }: any) => <Ctx.Provider value={{ value, onValueChange }}>{children}</Ctx.Provider>,
    SelectTrigger: ({ id, className, 'aria-invalid': invalid }: any) => (
      <Ctx.Consumer>{() => <span data-trigger-id={id} data-invalid={invalid ? 'true' : undefined} className={className} />}</Ctx.Consumer>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: any) => (
      <Ctx.Consumer>
        {(ctx) => (
          <select aria-label="select" value={ctx.value ?? ''} onChange={(e) => ctx.onValueChange?.(e.target.value)}>
            <option value="" />
            {children}
          </select>
        )}
      </Ctx.Consumer>
    ),
    SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
  }
})
vi.mock('./OrganizationImport', () => ({ default: () => null }))
vi.mock('./OrgLogoUpload', () => ({ default: () => null }))
vi.mock('./ManufacturerCategoryField', () => ({ default: () => null }))

let insertResult: () => Promise<{ data: any; error: any }> | { data: any; error: any }
const inserts: Record<string, any>[] = []

/** Minimal chainable PostgREST stand-in for the tables the Add view reads. */
function builder(table: string) {
  const state = { insert: null as any, filters: {} as Record<string, unknown> }
  const query: Record<string, any> = {}
  for (const method of ['select', 'neq', 'in', 'or', 'not', 'order', 'limit', 'is', 'single', 'maybeSingle']) {
    query[method] = vi.fn(() => query)
  }
  query.eq = vi.fn((col: string, val: unknown) => ((state.filters[col] = val), query))
  query.insert = vi.fn((rows: any[]) => ((state.insert = rows), inserts.push(rows[0]), query))
  query.then = (resolve: (value: unknown) => void, reject: (e: unknown) => void) => {
    if (state.insert) return Promise.resolve(insertResult()).then(resolve, reject)
    let data: any = []
    if (table === 'organization_types') {
      data = [
        { id: 't1', type_code: 'HQ', type_name: 'Headquarters', hierarchy_level: 1, is_active: true },
        { id: 't2', type_code: 'DIST', type_name: 'Distributor', hierarchy_level: 2, is_active: true },
      ]
    } else if (table === 'organizations') {
      // Duplicate-name check filters by org_name → no match.
      if ('org_name' in state.filters) data = []
      else if (state.filters.org_type_code === 'DIST') data = [{ org_code: 'DT013' }]
      else data = [{ id: HQ, org_code: 'HQ001', org_name: 'Serapod HQ', org_type_code: 'HQ' }]
    }
    resolve({ data, error: null })
  }
  return query
}

const supabase = { from: vi.fn((table: string) => builder(table)) }
vi.mock('@/lib/hooks/useSupabaseAuth', () => ({ useSupabaseAuth: () => ({ isReady: true, supabase }) }))

const userProfile = { id: 'u1', organization_id: HQ, roles: { role_level: 10 } }

const alertText = () => screen.getAllByRole('alert').map((el) => el.textContent ?? '').join(' | ')
const invalid = (id: string) => document.getElementById(id)?.getAttribute('aria-invalid')

async function renderDistributorForm() {
  const onViewChange = vi.fn()
  render(<AddOrganizationView userProfile={userProfile} onViewChange={onViewChange} />)
  await screen.findByText('Add New Organization')
  const typeSelect = await waitFor(() => {
    const select = screen.getAllByLabelText('select').find((el) => el.querySelector('option[value="DIST"]'))
    if (!select) throw new Error('type select not ready')
    return select
  })
  fireEvent.change(typeSelect, { target: { value: 'DIST' } })
  await waitFor(() => expect((document.getElementById('org_code') as HTMLInputElement).value).toBe('DT014'))
  fireEvent.change(document.getElementById('org_name')!, { target: { value: 'North Distribution Sdn Bhd' } })
  fireEvent.change(document.getElementById('contact_phone')!, { target: { value: '+60123456789' } })
  return { onViewChange, submit: screen.getByRole('button', { name: /create organization/i }) }
}

describe('AddOrganizationView submit failures', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    toast.mockReset()
    inserts.length = 0
    supabase.from.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows a friendly permission toast for the staging RLS denial, keeps input, and does not console.error', async () => {
    insertResult = () => ({
      data: null,
      error: { code: '42501', details: null, hint: null, message: 'new row violates row-level security policy for table "organizations"' },
    })
    const { onViewChange, submit } = await renderDistributorForm()

    fireEvent.click(submit)

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      title: 'Permission denied',
      description: ORG_CREATE_MESSAGES.permission,
      variant: 'destructive',
    }))
    expect(alertText()).toMatch(ORG_CREATE_MESSAGES.permission)
    expect(document.body.textContent).not.toContain('{}')
    expect(document.body.textContent).not.toContain('row-level security')
    // Form state is preserved, the button is usable again and nothing navigated.
    expect((document.getElementById('org_name') as HTMLInputElement).value).toBe('North Distribution Sdn Bhd')
    expect((document.getElementById('contact_phone') as HTMLInputElement).value).toBe('+60123456789')
    expect((submit as HTMLButtonElement).disabled).toBe(false)
    expect(onViewChange).not.toHaveBeenCalled()
    // Expected business failures do not go through console.error (Next dev overlay).
    expect(consoleError).not.toHaveBeenCalled()
    expect(inserts[0]).toMatchObject({ org_type_code: 'DIST', org_code: 'DT014', parent_org_id: HQ })
  })

  it('submits once when Create is clicked repeatedly', async () => {
    let release!: () => void
    insertResult = () => new Promise((resolve) => {
      release = () => resolve({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } })
    })
    const { submit } = await renderDistributorForm()

    fireEvent.click(submit)
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => expect(inserts).toHaveLength(1))
    await act(async () => release())
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1))
    expect(inserts).toHaveLength(1)
  })

  it('highlights the code and regenerates it on a duplicate org code', async () => {
    insertResult = () => ({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "organizations_org_code_key"', details: 'Key (org_code)=(DT014) already exists.' },
    })
    const { submit } = await renderDistributorForm()
    const before = supabase.from.mock.calls.length

    fireEvent.click(submit)

    await waitFor(() => expect(alertText()).toMatch(ORG_CREATE_MESSAGES.duplicate_code))
    expect(invalid('org_code')).toBe('true')
    // A fresh code lookup ran and the explanation stayed visible.
    await waitFor(() => expect(supabase.from.mock.calls.length).toBeGreaterThan(before + 1))
    expect(alertText()).toMatch(ORG_CREATE_MESSAGES.duplicate_code)
  })

  it('shows the connection message for a network failure', async () => {
    insertResult = () => ({ data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' } })
    const { submit } = await renderDistributorForm()
    fireEvent.click(submit)
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: ORG_CREATE_MESSAGES.network })))
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('shows a generic message with a reference for an unexpected server error and logs safe diagnostics', async () => {
    insertResult = () => ({ data: null, error: { code: 'XX000', message: 'internal error', details: 'Key (contact_phone)=(+60123456789)' } })
    const { submit } = await renderDistributorForm()
    fireEvent.click(submit)
    await waitFor(() => expect(alertText()).toMatch(/Unable to create the organization\. Please try again or contact support\. \(Reference: ORG-/))
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('+60123456789')
  })

  it('highlights the field for a client-side validation failure without calling the database', async () => {
    const { submit } = await renderDistributorForm()
    fireEvent.change(document.getElementById('org_name')!, { target: { value: '' } })
    fireEvent.click(submit)
    await waitFor(() => expect(invalid('org_name')).toBe('true'))
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Please check the form', variant: 'destructive' }))
    expect(inserts).toHaveLength(0)
    // Editing the highlighted field clears the error.
    fireEvent.change(document.getElementById('org_name')!, { target: { value: 'North' } })
    expect(invalid('org_name')).toBeNull()
  })

  it('creates a valid distributor, shows a success toast and navigates back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    insertResult = () => ({ data: [{ id: NEW_ORG }], error: null })
    const { onViewChange, submit } = await renderDistributorForm()
    fireEvent.click(submit)
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Organization created', description: 'North Distribution Sdn Bhd was created.' }))
    await act(async () => { vi.advanceTimersByTime(1100) })
    expect(onViewChange).toHaveBeenCalledWith('organizations')
    expect(inserts).toHaveLength(1)
    vi.useRealTimers()
  })
})
