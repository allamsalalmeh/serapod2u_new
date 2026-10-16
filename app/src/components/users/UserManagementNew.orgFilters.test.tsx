// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import UserManagementNew from './UserManagementNew'

const mocks = vi.hoisted(() => ({ orgResult: null as any }))

const ORGS = [
  { id: 'hq', org_name: 'Serapod HQ', org_code: 'HQ01', org_type_code: 'HQ', branch: null },
  { id: 'mfg', org_name: 'Alpha Manufacturing', org_code: 'MFG01', org_type_code: 'MFG', branch: null },
  { id: 'shop1', org_name: 'Kedai Maju', org_code: 'SH01', org_type_code: 'SHOP', branch: 'Ipoh' },
  { id: 'shop2', org_name: 'Kedai Maju', org_code: 'SH02', org_type_code: 'SHOP', branch: 'Klang' },
]
const USERS = [
  { id: 'u1', full_name: 'Hana HQ', email: 'hana@x.test', organization_id: 'hq' },
  { id: 'u2', full_name: 'Mika Maker', email: 'mika@x.test', organization_id: 'mfg' },
  { id: 'u3', full_name: 'Sam Shop', email: 'sam@x.test', organization_id: 'shop1' },
  { id: 'u4', full_name: 'Siti Shop', email: 'siti@x.test', organization_id: 'shop2' },
  { id: 'u5', full_name: 'Cara Consumer', email: 'cara@x.test', organization_id: null },
].map((u) => ({ ...u, role_code: 'USER', is_active: true, is_verified: true, created_at: '2026-01-01T00:00:00Z', roles: { role_level: 50 } }))

// Chainable, awaitable stand-in for the PostgREST builder: every call returns the builder; awaiting resolves the table's rows.
function builder(table: string) {
  const result = () => {
    if (table === 'organizations') return mocks.orgResult ?? { data: ORGS, error: null }
    if (table === 'users') return { data: USERS, error: null, count: USERS.length }
    return { data: [], error: null }
  }
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject)
      return () => b
    },
  })
  return b
}

vi.mock('@/lib/actions', () => ({ createUserWithAuth: vi.fn(), updateUserWithAuth: vi.fn() }))
vi.mock('@/lib/hooks/useSupabaseAuth', () => {
  const supabase = { from: (table: string) => builder(table) }
  return { useSupabaseAuth: () => ({ isReady: true, supabase }) }
})
vi.mock('@/hooks/useSaCapability', () => ({ useSaCapability: () => false }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('./UserDialogNew', () => ({ default: () => null }))

const profile = { id: 'viewer', role_code: 'HQ_ADMIN', organization_id: 'hq', roles: { role_level: 10 } }

beforeEach(() => {
  mocks.orgResult = null
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const typeSelect = () => screen.getByLabelText('Filter by Organization Type') as HTMLSelectElement
const orgSelect = () => screen.getByLabelText('Filter by Organization') as HTMLSelectElement
const orgLabels = () => Array.from(orgSelect().options).map((o) => o.textContent)
const visibleNames = () => ['Hana HQ', 'Mika Maker', 'Sam Shop', 'Siti Shop', 'Cara Consumer'].filter((n) => screen.queryAllByText(n).length > 0)

async function renderLoaded() {
  render(<UserManagementNew userProfile={profile as any} />)
  await waitFor(() => expect(orgLabels()).toContain('Alpha Manufacturing'))
  await waitFor(() => expect(visibleNames().length).toBe(5))
}

it('Manufacturer offers manufacturers only and the table shows only their users', async () => {
  await renderLoaded()
  fireEvent.change(typeSelect(), { target: { value: 'MFG' } })
  expect(orgLabels()).toEqual(['All Organizations', 'Alpha Manufacturing'])
  expect(visibleNames()).toEqual(['Mika Maker'])
})

it('Shop offers both same-named shops separately, keyed by id, and filters combined', async () => {
  await renderLoaded()
  fireEvent.change(typeSelect(), { target: { value: 'SHOP' } })
  expect(orgLabels()).toEqual(['All Organizations', 'Kedai Maju (Ipoh · SH01)', 'Kedai Maju (Klang · SH02)'])
  expect(visibleNames()).toEqual(['Sam Shop', 'Siti Shop'])
  fireEvent.change(orgSelect(), { target: { value: 'shop2' } })
  expect(visibleNames()).toEqual(['Siti Shop'])
})

it('keeps a still-valid organization and clears an invalid one when the type changes', async () => {
  await renderLoaded()
  fireEvent.change(orgSelect(), { target: { value: 'shop1' } })
  fireEvent.change(typeSelect(), { target: { value: 'SHOP' } })
  expect(orgSelect().value).toBe('shop1')
  expect(visibleNames()).toEqual(['Sam Shop'])
  fireEvent.change(typeSelect(), { target: { value: 'MFG' } })
  expect(orgSelect().value).toBe('')
  expect(visibleNames()).toEqual(['Mika Maker'])
})

it('HQ, End User and All Types follow the catalogue and data model', async () => {
  await renderLoaded()
  fireEvent.change(typeSelect(), { target: { value: 'HQ' } })
  expect(orgLabels()).toEqual(['All Organizations', 'Serapod HQ'])
  expect(visibleNames()).toEqual(['Hana HQ'])
  fireEvent.change(typeSelect(), { target: { value: 'END_USER' } })
  expect(orgLabels()).toEqual(['All Organizations', 'No organizations of this type'])
  expect(visibleNames()).toEqual(['Cara Consumer'])
  fireEvent.change(typeSelect(), { target: { value: '' } })
  expect(orgLabels()).toHaveLength(1 + ORGS.length)
  expect(visibleNames().length).toBe(5)
})

it('shows a failure state instead of unrelated organizations when the catalogue cannot load', async () => {
  mocks.orgResult = { data: null, error: { message: 'boom' } }
  render(<UserManagementNew userProfile={profile as any} />)
  await waitFor(() => expect(orgLabels()).toEqual(['All Organizations', 'Could not load organizations']))
  const failed = within(orgSelect()).getByText('Could not load organizations') as HTMLOptionElement
  expect(failed.disabled).toBe(true)
})
