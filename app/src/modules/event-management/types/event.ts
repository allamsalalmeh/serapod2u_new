/**
 * Event Management — domain types.
 *
 * These mirror the public.event_* schema created by
 * supabase/migrations/20261007_event01_create_event_tables.sql (and the
 * event02/event03 follow-ups). Dates are timestamptz (UTC storage); the
 * "Asia/Kuala_Lumpur" timezone is a display/config concern handled by the UI.
 */

export type EventStatus = 'draft' | 'active' | 'ended' | 'cancelled'
export type QrTokenKind = 'staff' | 'booth'
export type QrTokenStatus = 'active' | 'revoked' | 'expired'

export interface EventFormConfig {
  fields: {
    email?: 'optional' | 'hidden'
    cat_name?: 'optional' | 'hidden'
    cat_breed?: 'optional' | 'hidden'
    current_cat_food?: 'optional' | 'hidden'
  }
  marketing_consent_text?: string
  registration_consent_text?: string
}

export interface EventEvent {
  id: string
  organization_id: string
  brand_id: string | null
  name: string
  slug: string
  status: EventStatus
  starts_at: string
  ends_at: string
  timezone: string
  registration_opens_at: string | null
  registration_closes_at: string | null
  form_config: EventFormConfig
  created_by: string | null
  created_at: string
  updated_at: string
  brand_name?: string | null
}

export interface EventStaff {
  id: string
  event_id: string
  user_id: string
  created_at: string
  full_name?: string | null
  email?: string | null
}

export interface EventQrToken {
  id: string
  event_id: string
  staff_user_id: string | null
  token: string
  kind: QrTokenKind
  status: QrTokenStatus
  created_at: string
  created_by: string | null
  staff_name?: string | null
}

export interface EventContact {
  id: string
  event_id: string
  name: string
  phone_normalized: string
  email_normalized: string | null
  cat_name: string | null
  cat_breed: string | null
  current_cat_food: string | null
  user_id: string | null
  created_at: string
}

export interface EventRegistration {
  id: string
  event_id: string
  contact_id: string
  qr_token_id: string
  attributed_staff_user_id: string | null
  submitted_at: string
  ip: string | null
  created_at: string
  /** join */
  contact?: EventContact | null
  qr_token_kind?: QrTokenKind | null
  attributed_staff_name?: string | null
  marketing_consent?: boolean
}

export type EventRegistrationStatus =
  | 'registered'
  | 'duplicate'
  | 'invalid_token'
  | 'revoked'
  | 'expired'
  | 'invalid_event'
  | 'event_not_active'
  | 'not_open'
  | 'closed'
  | 'name_required'
  | 'phone_invalid'
