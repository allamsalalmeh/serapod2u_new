import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { EventEvent, EventFormConfig, EventStatus } from '@/modules/event-management/types/event'

export const DEFAULT_FORM_CONFIG: EventFormConfig = {
  fields: {
    email: 'optional',
    cat_name: 'optional',
    cat_breed: 'optional',
    current_cat_food: 'optional',
  },
  marketing_consent_text: 'I agree to receive marketing updates from this brand.',
  registration_consent_text: 'By submitting, you agree to register for this event.',
}

export const EVENT_STATUSES: EventStatus[] = ['draft', 'active', 'ended', 'cancelled']

export function slugifyEventName(value: string): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'event'
}

/** Effective registration window: overrides fall back to starts_at/ends_at (never "always open"). */
export function eventRegistrationWindow(event: EventEvent): { opensAt: string; closesAt: string } {
  return {
    opensAt: event.registration_opens_at ?? event.starts_at,
    closesAt: event.registration_closes_at ?? event.ends_at,
  }
}

const EVENT_SELECT = `
  id, organization_id, brand_id, name, slug, status,
  starts_at, ends_at, timezone, registration_opens_at, registration_closes_at,
  form_config, created_by, created_at, updated_at,
  brands:brand_id(brand_name)
`

function shapeEvent(row: any): EventEvent {
  const brandName = Array.isArray(row.brands) ? row.brands[0]?.brand_name : row.brands?.brand_name
  return {
    ...row,
    form_config: (row.form_config ?? {}) as EventFormConfig,
    brand_name: brandName ?? null,
  } as EventEvent
}

export async function listEvents(orgId: string): Promise<EventEvent[]> {
  const admin = createAdminClient() as any
  const { data, error } = await admin
    .from('event_events')
    .select(EVENT_SELECT)
    .eq('organization_id', orgId)
    .order('starts_at', { ascending: false })

  if (error) throw new Error(error.message)
  return (data ?? []).map(shapeEvent)
}

export async function getEvent(orgId: string, eventId: string): Promise<EventEvent | null> {
  const admin = createAdminClient() as any
  const { data, error } = await admin
    .from('event_events')
    .select(EVENT_SELECT)
    .eq('id', eventId)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data ? shapeEvent(data) : null
}

export async function createEvent(
  orgId: string,
  createdBy: string,
  input: {
    name: string
    brand_id?: string | null
    status?: EventStatus
    starts_at: string
    ends_at: string
    timezone?: string
    registration_opens_at?: string | null
    registration_closes_at?: string | null
    form_config?: EventFormConfig
  },
): Promise<EventEvent> {
  const admin = createAdminClient() as any
  const { data, error } = await admin
    .from('event_events')
    .insert({
      organization_id: orgId,
      created_by: createdBy,
      name: input.name.trim(),
      slug: slugifyEventName(input.name),
      brand_id: input.brand_id ?? null,
      status: input.status ?? 'draft',
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      timezone: input.timezone ?? 'Asia/Kuala_Lumpur',
      registration_opens_at: input.registration_opens_at ?? null,
      registration_closes_at: input.registration_closes_at ?? null,
      form_config: input.form_config ?? DEFAULT_FORM_CONFIG,
    })
    .select(EVENT_SELECT)
    .single()

  if (error) throw new Error(error.message)
  return shapeEvent(data)
}

export async function updateEvent(
  orgId: string,
  eventId: string,
  patch: Partial<{
    name: string
    brand_id: string | null
    status: EventStatus
    starts_at: string
    ends_at: string
    timezone: string
    registration_opens_at: string | null
    registration_closes_at: string | null
    form_config: EventFormConfig
  }>,
): Promise<EventEvent | null> {
  const admin = createAdminClient() as any

  // Ownership check: only the caller's org may update the event.
  const owned = await admin
    .from('event_events')
    .select('id')
    .eq('id', eventId)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!owned.data) return null

  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.name !== undefined) {
    payload.name = patch.name.trim()
    payload.slug = slugifyEventName(patch.name)
  }
  if (patch.brand_id !== undefined) payload.brand_id = patch.brand_id
  if (patch.status !== undefined) payload.status = patch.status
  if (patch.starts_at !== undefined) payload.starts_at = patch.starts_at
  if (patch.ends_at !== undefined) payload.ends_at = patch.ends_at
  if (patch.timezone !== undefined) payload.timezone = patch.timezone
  if (patch.registration_opens_at !== undefined) payload.registration_opens_at = patch.registration_opens_at
  if (patch.registration_closes_at !== undefined) payload.registration_closes_at = patch.registration_closes_at
  if (patch.form_config !== undefined) payload.form_config = patch.form_config

  const { data, error } = await admin
    .from('event_events')
    .update(payload)
    .eq('id', eventId)
    .eq('organization_id', orgId)
    .select(EVENT_SELECT)
    .single()

  if (error) throw new Error(error.message)
  return data ? shapeEvent(data) : null
}
