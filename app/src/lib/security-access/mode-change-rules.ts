/**
 * Reason / note rule for migration-mode changes — one definition for the Migration Modes screen, the API routes and
 * (mirrored) the database (sa_mode_reason_required in 20261019110000_sa_mode_change_note_and_keep_retired.sql).
 *
 *   An ACTUAL change back to Legacy enforced or Monitoring / Shadow needs a reason of at least 10 characters.
 *   A change to New Access Active or Legacy Retired takes an optional note. Without one, the database records a
 *   generated description of the transition, so every audit row still explains what happened.
 */
export const REASON_REQUIRED_TARGETS: readonly string[] = ['LEGACY_ENFORCED', 'SHADOW']
export const MODE_REASON_MIN = 10
export const MODE_NOTE_MAX = 500

export function reasonRequiredFor(from: string | null | undefined, to: string): boolean {
  return REASON_REQUIRED_TARGETS.includes(to) && from !== to
}

export const REASON_REQUIRED_TEXT = `Moving back to Legacy enforced or Monitoring / Shadow needs a reason of at least ${MODE_REASON_MIN} characters.`

export type NoteCheck = { ok: true; note: string | null } | { ok: false; code: 'reason_required' | 'note_too_long'; error: string }

/** Normalises the free text (blank → no note) and applies the rule for this transition. */
export function checkModeNote(reasonRequired: boolean, raw: string | null | undefined): NoteCheck {
  const note = String(raw ?? '').trim()
  if (note.length > MODE_NOTE_MAX) return { ok: false, code: 'note_too_long', error: `The note can be at most ${MODE_NOTE_MAX} characters.` }
  if (reasonRequired && note.length < MODE_REASON_MIN) return { ok: false, code: 'reason_required', error: REASON_REQUIRED_TEXT }
  return { ok: true, note: note.length ? note : null }
}
