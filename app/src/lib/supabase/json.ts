import type { Json } from '@/types/database'

/** A JSON object as typed by the generated Supabase `Json` union. */
export type JsonObject = { [key: string]: Json | undefined }

/** True for a JSON object (not null, not an array, not a scalar). */
export const isJsonObject = (value: Json | null | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Narrows a jsonb RPC result to an object for property reads. Anything else
 * becomes `{}`, so property reads yield `undefined` exactly as optional
 * chaining on a non-object did before.
 */
export const asJsonObject = (value: Json | null | undefined): JsonObject =>
  isJsonObject(value) ? value : {}
