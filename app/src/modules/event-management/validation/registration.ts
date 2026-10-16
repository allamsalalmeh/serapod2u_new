import { z } from 'zod'
import { isValidMalaysianPhone, normalizePhoneE164 } from '@/utils/phone'

/**
 * Public registration form schema. Name and Malaysian mobile phone are
 * mandatory; email, cat name and cat breed are optional. No OTP/SMS.
 *
 * Client validation is immediate-feedback only; the authoritative validation
 * happens server-side in the atomic RPC (register_event_visitor) and, before
 * that, in the route, both reusing the same E.164 +60 normalization.
 */

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required.')
  .max(160, 'Name is too long.')

const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Mobile phone is required.')
  .refine((value) => isValidMalaysianPhone(value), {
    message: 'Enter a valid Malaysian mobile number.',
  })

const optionalShortText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal('').transform(() => undefined))

export const publicRegistrationSchema = z.object({
  token: z.string().trim().min(1, 'Missing QR token.'),
  name: nameSchema,
  phone: phoneSchema,
  email: z
    .string()
    .trim()
    .email('Enter a valid email address.')
    .max(254)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  cat_name: optionalShortText(120),
  cat_breed: optionalShortText(120),
  current_cat_food: optionalShortText(160),
  marketing_consent: z.boolean().optional(),
})

export type PublicRegistrationInput = z.infer<typeof publicRegistrationSchema>

/** Normalize a raw phone to canonical E.164 +60, or null when invalid. */
export function normalizeMalaysianMobile(phone: string | null | undefined): string | null {
  const normalized = normalizePhoneE164(String(phone ?? '').trim())
  if (!normalized) return null
  return isValidMalaysianPhone(normalized) ? normalized : null
}

export function normalizeOptionalEmail(email: string | null | undefined): string | null {
  const value = String(email ?? '').trim().toLowerCase()
  if (!value) return null
  // same shape as identity_normalize_email in the database
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(value) ? value : null
}
