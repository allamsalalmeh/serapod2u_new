import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { isValidMalaysianPhone, normalizePhoneE164 } from '@/utils/phone'

const STORAGE_PUBLIC_PATH = '/storage/v1/object/public/'
const KNOWN_STORAGE_BUCKETS = new Set([
  'avatars',
  'documents',
  'order-excel',
  'product-images',
  'product-variants',
  'qr-codes'
])

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function normalizePhone(phone: string): string {
  return normalizePhoneE164(phone)
}

export function toTitleCaseWords(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b[\p{L}\p{N}]/gu, (char) => char.toUpperCase())
}

export function toTitleCaseAddress(value?: string | null): string {
  const normalized = String(value ?? '').trim()
  if (!normalized) return ''

  return normalized
    .toLowerCase()
    .replace(/(^|[\s,./-])(\p{L})/gu, (_, prefix: string, char: string) => `${prefix}${char.toUpperCase()}`)
}

function getConfiguredSupabaseUrl(): string | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL
  return supabaseUrl ? supabaseUrl.replace(/\/+$/, '') : null
}

function getConfiguredAnonKey(): string | null {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || null
}

function splitPathSuffix(value: string) {
  const queryIndex = value.indexOf('?')
  const hashIndex = value.indexOf('#')

  let splitIndex = -1
  if (queryIndex === -1) {
    splitIndex = hashIndex
  } else if (hashIndex === -1) {
    splitIndex = queryIndex
  } else {
    splitIndex = Math.min(queryIndex, hashIndex)
  }

  if (splitIndex === -1) {
    return { path: value, suffix: '' }
  }

  return {
    path: value.slice(0, splitIndex),
    suffix: value.slice(splitIndex)
  }
}

function appendStorageApiKey(url: string): string {
  const anonKey = getConfiguredAnonKey()
  if (!anonKey) return url

  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.has('apikey')) {
      parsed.searchParams.set('apikey', anonKey)
    }
    return parsed.toString()
  } catch {
    if (url.includes('apikey=')) return url

    const hashIndex = url.indexOf('#')
    const base = hashIndex === -1 ? url : url.slice(0, hashIndex)
    const hash = hashIndex === -1 ? '' : url.slice(hashIndex)
    const separator = base.includes('?') ? '&' : '?'
    return `${base}${separator}apikey=${encodeURIComponent(anonKey)}${hash}`
  }
}

function extractStorageParts(
  pathOrUrl: string,
  bucket?: string
): { bucket: string; objectPath: string; suffix: string } | null {
  const normalized = pathOrUrl.trim()
  if (!normalized) return null

  if (isSupabaseStorageUrl(normalized)) {
    try {
      const parsed = normalized.startsWith('http://') || normalized.startsWith('https://')
        ? new URL(normalized)
        : new URL(normalized, 'http://localhost')

      const markerIndex = parsed.pathname.indexOf(STORAGE_PUBLIC_PATH)
      if (markerIndex === -1) return null

      const rawStoragePath = parsed.pathname
        .slice(markerIndex + STORAGE_PUBLIC_PATH.length)
        .replace(/^\/+/, '')
      const [resolvedBucket, ...objectParts] = rawStoragePath.split('/')

      if (!resolvedBucket || objectParts.length === 0) return null

      return {
        bucket: resolvedBucket,
        objectPath: objectParts.join('/'),
        suffix: `${parsed.search}${parsed.hash}`
      }
    } catch {
      return null
    }
  }

  const { path: rawPath, suffix } = splitPathSuffix(normalized)
  const cleanedPath = rawPath.replace(/^\/+/, '')
  if (!cleanedPath) return null

  let resolvedBucket = bucket || process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET || 'avatars'
  let objectPath = cleanedPath

  if (bucket && cleanedPath.startsWith(`${bucket}/`)) {
    objectPath = cleanedPath.slice(bucket.length + 1)
  } else {
    const [firstSegment, ...rest] = cleanedPath.split('/')
    if (rest.length > 0 && KNOWN_STORAGE_BUCKETS.has(firstSegment)) {
      resolvedBucket = firstSegment
      objectPath = rest.join('/')
    }
  }

  return {
    bucket: resolvedBucket,
    objectPath,
    suffix
  }
}

export function isSupabaseStorageUrl(url: string | null | undefined): boolean {
  const normalized = String(url ?? '').trim()
  if (!normalized) return false

  if (normalized.includes(STORAGE_PUBLIC_PATH)) return true
  return normalized.startsWith('storage/v1/object/public/')
}

export function extractStoragePath(pathOrUrl: string | null | undefined): string | null {
  const normalized = String(pathOrUrl ?? '').trim()
  if (!normalized) return null

  if ((normalized.startsWith('http://') || normalized.startsWith('https://')) && !isSupabaseStorageUrl(normalized)) {
    return null
  }

  const storageParts = extractStorageParts(normalized)
  return storageParts?.objectPath ?? null
}

export function getStorageUrl(pathOrUrl: string | null | undefined, bucket?: string) {
  const normalized = String(pathOrUrl ?? '').trim()
  if (!normalized) return ''

  // In-browser previews of a freshly selected file are already renderable and
  // are not storage objects - never rewrite them into a storage URL.
  if (normalized.startsWith('data:') || normalized.startsWith('blob:')) {
    return normalized
  }

  if (normalized.startsWith('/') && !normalized.startsWith(STORAGE_PUBLIC_PATH)) {
    return normalized
  }

  if ((normalized.startsWith('http://') || normalized.startsWith('https://')) && !isSupabaseStorageUrl(normalized)) {
    return normalized
  }

  const storageParts = extractStorageParts(normalized, bucket)
  const supabaseUrl = getConfiguredSupabaseUrl()

  if (!storageParts || !supabaseUrl) {
    return normalized
  }

  const publicUrl = new URL(
    `${STORAGE_PUBLIC_PATH}${storageParts.bucket}/${storageParts.objectPath.replace(/^\/+/, '')}`,
    `${supabaseUrl}/`
  )

  if (storageParts.suffix) {
    const suffixUrl = new URL(`http://localhost/${storageParts.suffix.startsWith('?') ? storageParts.suffix : `?${storageParts.suffix}`}`)
    suffixUrl.searchParams.forEach((value, key) => {
      if (key !== 'apikey') {
        publicUrl.searchParams.append(key, value)
      }
    })
    if (suffixUrl.hash) {
      publicUrl.hash = suffixUrl.hash
    }
  }

  return appendStorageApiKey(publicUrl.toString())
}

/**
 * Display URL for a stored `users.avatar_url`. Every upload writes a new
 * timestamped object, so the stored URL already changes whenever the picture
 * does; it must not be cache-busted per render or per profile edit, which
 * would refetch the image and flash the initials fallback.
 */
export function getAvatarSrc(avatarUrl: string | null | undefined): string | undefined {
  if (!avatarUrl) return undefined
  return getStorageUrl(avatarUrl, 'avatars') || avatarUrl
}

/**
 * Self-hosted Kong gateways require an `apikey` on every storage request,
 * including signed URLs (which only carry a `token` param). Use this for
 * signed URLs from `createSignedUrl()` before handing them to an <img>.
 */
export function withStorageApiKey(url: string): string {
  return appendStorageApiKey(url)
}

export type PhoneValidationResult = {
  isValid: boolean;
  formatted?: string;
  error?: string;
}

export function validatePhoneNumber(phone: string): PhoneValidationResult {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return { isValid: false, error: 'Phone number is required' };
  }
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    return { isValid: false, error: 'Invalid phone number format' };
  }
  return { isValid: true, formatted: normalized };
}

export function validateMalaysianMobileNumber(phone: string): PhoneValidationResult {
  const raw = String(phone || '').trim();
  if (!raw) {
    return { isValid: false, error: 'Contact phone is required.' };
  }

  const normalized = normalizePhone(phone);
  if (!normalized) {
    return { isValid: false, error: 'Please enter a valid Malaysia mobile number.' };
  }
  if (!isValidMalaysianPhone(normalized)) {
    return { isValid: false, error: 'Please enter a valid Malaysia mobile number.' };
  }
  return { isValid: true, formatted: normalized };
}

