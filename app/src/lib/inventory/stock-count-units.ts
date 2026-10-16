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

/** Whole cases for a piece count, or null when it is blank or does not divide into whole cases. */
export function piecesToWholeCases(pieces: string, piecesPerCase: number): number | null {
  if (!/^\d+$/.test(pieces) || piecesPerCase < 1) return null
  const value = Number(pieces)
  return value % piecesPerCase === 0 ? value / piecesPerCase : null
}

/** "7,030 cases + 2 pcs" — a piece quantity restated in cases; negative values keep their sign. */
export function formatPiecesAsCases(pieces: number, piecesPerCase: number): string {
  const sign = pieces < 0 ? '-' : ''
  const abs = Math.abs(Math.trunc(pieces))
  const cases = Math.floor(abs / piecesPerCase)
  const loose = abs % piecesPerCase
  const casesText = `${cases.toLocaleString('en-US')} ${cases === 1 ? 'case' : 'cases'}`
  return `${sign}${loose > 0 ? `${casesText} + ${loose.toLocaleString('en-US')} pcs` : casesText}`
}
