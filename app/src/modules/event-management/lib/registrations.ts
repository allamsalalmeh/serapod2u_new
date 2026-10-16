import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { EventRegistration, EventRegistrationStatus } from '@/modules/event-management/types/event'
import { normalizeMalaysianMobile } from '@/modules/event-management/validation/registration'
import { getEvent } from '@/modules/event-management/lib/events'

/**
 * Public + admin registration access (server-side, org-scoped).
 *
 * Public submission goes through the single atomic RPC
 * `register_event_visitor` (service-role only). The public endpoint is the
 * only caller; anonymous visitors never read visitor lists. Admin reads are
 * org-scoped via the event ownership check (the event must belong to the
 * caller's organization), and assembled from flat queries keyed by event_id so
 * no PostgREST relationship naming is relied upon.
 */

export interface RegistrationResult {
  confirmed: boolean
  status: EventRegistrationStatus
  message?: string
}

export interface PublicRegisterInput {
  token: string
  name: string
  phone: string
  email?: string | null
  cat_name?: string | null
  cat_breed?: string | null
  current_cat_food?: string | null
  marketing_consent?: boolean
  ip?: string | null
}

export async function registerVisitor(input: PublicRegisterInput): Promise<RegistrationResult> {
  const phone = normalizeMalaysianMobile(input.phone)
  if (!phone) {
    return { confirmed: false, status: 'phone_invalid', message: 'A valid Malaysian mobile number is required.' }
  }
  const name = input.name.trim()
  if (!name) {
    return { confirmed: false, status: 'name_required', message: 'Name is required.' }
  }

  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('register_event_visitor', {
    p_token: input.token,
    p_name: name,
    p_phone: input.phone, // raw phone; the RPC re-normalizes/validates authoritatively
    p_email: input.email ?? null,
    p_cat_name: input.cat_name ?? null,
    p_cat_breed: input.cat_breed ?? null,
    p_current_cat_food: input.current_cat_food ?? null,
    p_marketing_consent: input.marketing_consent === true,
    p_ip: input.ip ?? null,
  })

  if (error) {
    return { confirmed: false, status: 'invalid_token', message: 'Registration failed.' }
  }

  const result = data ?? {}
  const status: EventRegistrationStatus = result.status ?? 'invalid_token'
  return {
    confirmed: result.confirmed === true || result.valid === true,
    status,
    message: result.message,
  }
}

interface RawRegistration {
  id: string
  event_id: string
  contact_id: string
  qr_token_id: string
  attributed_staff_user_id: string | null
  submitted_at: string
  ip: string | null
  created_at: string
}

export async function listRegistrations(orgId: string, eventId: string, query?: string): Promise<EventRegistration[]> {
  const event = await getEvent(orgId, eventId)
  if (!event) return []

  const admin = createAdminClient() as any

  let regQuery = admin
    .from('event_registrations')
    .select('id, event_id, contact_id, qr_token_id, attributed_staff_user_id, submitted_at, ip, created_at')
    .eq('event_id', eventId)

  // Optional search scoped to this event's contacts.
  if (query) {
    const { data: contacts } = await admin
      .from('event_contacts')
      .select('id')
      .eq('event_id', eventId)
      .or(`name.ilike.%${query}%,phone_normalized.ilike.%${query}%,email_normalized.ilike.%${query}%`)
    const ids = (contacts ?? []).map((c: any) => c.id)
    if (ids.length === 0) return []
    regQuery = regQuery.in('contact_id', ids)
  }

  const { data: regs, error } = await regQuery.order('submitted_at', { ascending: false })
  if (error) throw new Error(error.message)
  const registrations = (regs ?? []) as RawRegistration[]

  // Assemble joined data in JS (no PostgREST relationship-name dependency).
  const contactIds = [...new Set(registrations.map((r) => r.contact_id))]
  const staffIds = [...new Set(registrations.map((r) => r.attributed_staff_user_id).filter(Boolean))] as string[]
  const tokenIds = [...new Set(registrations.map((r) => r.qr_token_id))]

  const contactsRes: any = await admin.from('event_contacts').select('id, name, phone_normalized, email_normalized, cat_name, cat_breed, current_cat_food, created_at').in('id', contactIds)
  const tokensRes: any = await admin.from('event_qr_tokens').select('id, kind').in('id', tokenIds)
  const staffRes: any = staffIds.length ? await admin.from('users').select('id, full_name').in('id', staffIds) : { data: [] }
  const consentsRes: any = await admin.from('event_consents').select('registration_id, granted').in('registration_id', registrations.map((r) => r.id)).eq('kind', 'marketing')

  const contactById: Map<string, any> = new Map((contactsRes.data ?? []).map((c: any) => [c.id, c]))
  const tokenById: Map<string, any> = new Map((tokensRes.data ?? []).map((t: any) => [t.id, t]))
  const staffById: Map<string, any> = new Map((staffRes.data ?? []).map((u: any) => [u.id, u]))
  const consentByReg: Map<string, boolean> = new Map((consentsRes.data ?? []).map((c: any) => [c.registration_id, c.granted === true]))

  return registrations.map((r) => {
    const contact = contactById.get(r.contact_id)
    const token = tokenById.get(r.qr_token_id)
    return {
      ...r,
      contact: contact
        ? {
            id: contact.id,
            event_id: eventId,
            name: contact.name,
            phone_normalized: contact.phone_normalized,
            email_normalized: contact.email_normalized ?? null,
            cat_name: contact.cat_name ?? null,
            cat_breed: contact.cat_breed ?? null,
            current_cat_food: contact.current_cat_food ?? null,
            user_id: null,
            created_at: contact.created_at,
          }
        : null,
      qr_token_kind: token?.kind ?? null,
      attributed_staff_name: r.attributed_staff_user_id ? (staffById.get(r.attributed_staff_user_id)?.full_name ?? null) : null,
      marketing_consent: consentByReg.get(r.id) ?? false,
    } as EventRegistration
  })
}

export interface EventStats {
  total: number
  booth: number
  staff: number
  staffComparison: Array<{ staff_user_id: string; full_name: string | null; count: number }>
}

export async function getEventStats(orgId: string, eventId: string): Promise<EventStats | null> {
  const event = await getEvent(orgId, eventId)
  if (!event) return null

  const admin = createAdminClient() as any
  const { data: regs, error } = await admin
    .from('event_registrations')
    .select('id, attributed_staff_user_id')
    .eq('event_id', eventId)

  if (error) throw new Error(error.message)
  const registrations = (regs ?? []) as Array<{ id: string; attributed_staff_user_id: string | null }>

  const staffCounts = new Map<string, number>()
  let booth = 0
  for (const r of registrations) {
    if (r.attributed_staff_user_id == null) {
      booth += 1
    } else {
      staffCounts.set(r.attributed_staff_user_id, (staffCounts.get(r.attributed_staff_user_id) ?? 0) + 1)
    }
  }

  const staffIds = [...staffCounts.keys()]
  const { data: staffRows } = staffIds.length
    ? await admin.from('users').select('id, full_name').in('id', staffIds)
    : { data: [] }
  const staffNameById: Map<string, string> = new Map((staffRows ?? []).map((u: any) => [u.id, u.full_name]))

  const staffComparison = staffIds
    .map((id) => ({ staff_user_id: id, full_name: staffNameById.get(id) ?? null, count: staffCounts.get(id) ?? 0 }))
    .sort((a, b) => b.count - a.count)

  return {
    total: registrations.length,
    booth,
    staff: registrations.length - booth,
    staffComparison,
  }
}

