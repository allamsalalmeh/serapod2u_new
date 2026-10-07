import { beforeEach, describe, expect, it, vi } from 'vitest'

// Fake service-role client that records every `.eq()` filter and matches rows
// by those filters. This proves the admin queries apply an explicit
// organization_id filter (service role bypasses RLS, so org isolation must be
// enforced in code, never left to RLS).
const state = vi.hoisted(() => ({
  rows: {} as Record<string, any[]>,
  calls: [] as Array<{ table: string; op: string; eq: Array<[string, any]> }>,
}))

function record(table: string, op: string, eq: Array<[string, any]>) {
  state.calls.push({ table, op, eq: eq.map(([f, v]) => [f, v]) })
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const eq: Array<[string, any]> = []
      const filtered = () => (state.rows[table] ?? []).filter((r) => eq.every(([f, v]) => r[f] === v))
      const one = () => filtered()[0] ?? null
      const chain: any = {
        select: () => chain,
        eq: (f: string, v: any) => { eq.push([f, v]); return chain },
        in: () => chain,
        or: () => chain,
        order: () => chain,
        then: (ok: any, fail: any) => { record(table, 'list', eq); return Promise.resolve({ data: filtered(), error: null }).then(ok, fail) },
        maybeSingle: async () => { record(table, 'maybeSingle', eq); return { data: one(), error: null } },
        single: async () => { record(table, 'single', eq); return { data: one(), error: null } },
        insert: () => chain,
        update: () => chain,
        upsert: () => chain,
        delete: async () => { record(table, 'delete', eq); return { error: null } },
      }
      return chain
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}))

import { getEvent, listEvents } from './events'
import { listStaff, createQrToken } from './staff-qr'
import { listRegistrations, getEventStats } from './registrations'

const EVENT = {
  id: 'e1',
  organization_id: 'orgA',
  brand_id: null,
  name: 'Ellbow Launch',
  slug: 'ellbow-launch',
  status: 'active',
  starts_at: '2026-01-01T00:00:00Z',
  ends_at: '2026-02-01T00:00:00Z',
  timezone: 'Asia/Kuala_Lumpur',
  registration_opens_at: null,
  registration_closes_at: null,
  form_config: {},
  created_by: null,
  created_at: '',
  updated_at: '',
  brands: null,
}

beforeEach(() => {
  state.calls.length = 0
  state.rows = {}
})

describe('admin org isolation (cross-org IDs denied, service-role org-scoped)', () => {
  it('getEvent filters by organization_id and returns null for a cross-org event', async () => {
    state.rows.event_events = [EVENT]
    expect(await getEvent('orgA', 'e1')).not.toBeNull()
    expect(await getEvent('orgB', 'e1')).toBeNull()

    const eqs = state.calls.filter((c) => c.table === 'event_events').flatMap((c) => c.eq)
    expect(eqs).toContainEqual(['organization_id', 'orgA'])
    expect(eqs).toContainEqual(['organization_id', 'orgB'])
    expect(eqs).toContainEqual(['id', 'e1'])
  })

  it('listEvents always scopes the query to the caller organization', async () => {
    state.rows.event_events = [EVENT]
    const events = await listEvents('orgA')
    expect(events).toHaveLength(1)
    const eqs = state.calls.filter((c) => c.table === 'event_events').flatMap((c) => c.eq)
    expect(eqs).toContainEqual(['organization_id', 'orgA'])
  })

  it('listStaff returns [] when the event belongs to another organization', async () => {
    state.rows.event_events = [EVENT]
    state.rows.event_staff = [{ id: 's1', event_id: 'e1', user_id: 'u1', users: { full_name: 'A' } }]
    expect(await listStaff('orgB', 'e1')).toEqual([])
  })

  it('createQrToken rejects a staff QR for an event outside the caller organization', async () => {
    state.rows.event_events = [EVENT]
    await expect(createQrToken('orgB', 'e1', 'staff', 'u1', 'creator')).rejects.toThrow('Event not found.')
  })

  it('createQrToken rejects an unassigned staff member for an owned event', async () => {
    state.rows.event_events = [EVENT]
    state.rows.event_staff = [] // staff not assigned to the event
    await expect(createQrToken('orgA', 'e1', 'staff', 'u1', 'creator')).rejects.toThrow('Staff is not assigned to this event.')
  })

  it('listRegistrations returns [] when the event is not owned', async () => {
    state.rows.event_events = [EVENT]
    expect(await listRegistrations('orgB', 'e1')).toEqual([])
  })

  it('getEventStats returns null when the event is not owned', async () => {
    state.rows.event_events = [EVENT]
    expect(await getEventStats('orgB', 'e1')).toBeNull()
  })
})
