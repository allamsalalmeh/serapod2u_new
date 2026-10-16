/**
 * Auto-generation of a unique business Position Code.
 *
 * Position Code is a business identifier (e.g. WH-OP-001), NOT the internal id.
 * The generator produces a short prefix from the name/job classification and a
 * sequence suffix; the API ensures uniqueness by checking existing codes.
 */

/** Build the alphabetic prefix from a name (initials of up to 4 words). */
export function prefixFromName(name: string): string {
  const words = name
    .trim()
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

  if (words.length === 0) return 'POS'
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  const initials = words.map((w) => w[0]).join('').toUpperCase()
  return initials.length >= 2 ? initials.slice(0, 4) : words.join('').slice(0, 3).toUpperCase()
}

/** Zero-pad a sequence number to a fixed width (default 3). */
export function sequenceSuffix(seq: number, width = 3): string {
  return String(Math.max(0, seq)).padStart(width, '0')
}

/**
 * Generate the next free position code for a given base prefix.
 * Returns e.g. `WH-OP-003` for base `WH-OP` when 1 and 2 are taken.
 */
export function nextPositionCode(
  base: string,
  existingCodes: readonly string[],
  width = 3,
): string {
  const normalized = base.trim().toUpperCase().replace(/\s+/g, '-')
  const taken = new Set(existingCodes.map((c) => c.toUpperCase()))

  // If the base itself is free, use it without a suffix.
  if (normalized && !taken.has(normalized)) return normalized

  let seq = 1
  while (true) {
    const candidate = `${normalized}-${sequenceSuffix(seq, width)}`
    if (!taken.has(candidate)) return candidate
    seq++
    if (seq > 9999) return `${normalized}-${Date.now()}` // pragmatic escape hatch
  }
}
