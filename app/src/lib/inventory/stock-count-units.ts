/**
 * Stock Count quantities are always stored in pieces. An operator may count
 * whole cases instead; the entry is converted to pieces before it reaches the
 * count row, so variance, costing, posting and Excel never see cases.
 */
export type CountEntryUnit = 'pcs' | 'case'

export const isWholeNumberEntry = (value: string): boolean => value === '' || /^\d+$/.test(value)

/** Pieces for `cases` × `perCase`, or null until both are whole numbers and a case holds at least one piece. */
export function casesToPieces(cases: string, perCase: string): number | null {
  if (!/^\d+$/.test(cases) || !/^\d+$/.test(perCase)) return null
  const piecesPerCase = Number(perCase)
  if (piecesPerCase < 1) return null
  const pieces = Number(cases) * piecesPerCase
  return Number.isSafeInteger(pieces) ? pieces : null
}
