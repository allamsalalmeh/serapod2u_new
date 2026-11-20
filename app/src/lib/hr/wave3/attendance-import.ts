/**
 * HR Wave 3 — Excel bulk attendance import: template and browser-side reading (isomorphic, pure).
 *
 * The browser only turns the spreadsheet into plain rows (ISO date, 24-hour times) and a SHA-256 of the file. The
 * DATABASE validates every row again (canonical employee mapping, formats, duplicates, conflicts with recorded
 * attendance, employment dates) in a preview, and imports only after an explicit commit (hr_attendance_import_*).
 * Values that cannot be normalised are passed through unchanged, so the database reports them per row.
 */
import type ExcelJS from 'exceljs'

export const IMPORT_MAX_ROWS = 5000
export const IMPORT_SHEET_NAME = 'Attendance'

export const IMPORT_COLUMNS = [
  { key: 'employee_no', header: 'Employee No', width: 14, note: 'HR employee number (People → Employees). Either this or the e-mail is required.' },
  { key: 'email', header: 'Employee Email', width: 30, note: 'Login e-mail. If both are given they must belong to the same person.' },
  { key: 'work_date', header: 'Work Date', width: 14, note: 'Date the shift starts: YYYY-MM-DD or DD/MM/YYYY (or an Excel date).' },
  { key: 'clock_in', header: 'Clock In', width: 10, note: '24-hour time HH:MM (company time zone).' },
  { key: 'clock_out', header: 'Clock Out', width: 10, note: '24-hour time HH:MM. Earlier than Clock In = next day (night shift).' },
  { key: 'break_minutes', header: 'Break Minutes', width: 14, note: 'Optional, 0–600. Deducted from worked time.' },
  { key: 'shift', header: 'Shift', width: 18, note: 'Optional shift name exactly as set up in Attendance → Shifts.' },
  { key: 'note', header: 'Note', width: 30, note: 'Optional, up to 500 characters.' },
] as const

export type ImportKey = (typeof IMPORT_COLUMNS)[number]['key']
export type ImportRow = { row_no: number } & Partial<Record<ImportKey, string>>

const ALIASES: Record<string, ImportKey> = {
  'employee no': 'employee_no', 'employee number': 'employee_no', 'emp no': 'employee_no', 'staff no': 'employee_no',
  'employee email': 'email', email: 'email', 'e-mail': 'email',
  'work date': 'work_date', date: 'work_date',
  'clock in': 'clock_in', 'time in': 'clock_in', in: 'clock_in',
  'clock out': 'clock_out', 'time out': 'clock_out', out: 'clock_out',
  'break minutes': 'break_minutes', break: 'break_minutes', 'break (min)': 'break_minutes',
  shift: 'shift', note: 'note', notes: 'note', remarks: 'note',
}

const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase()
const pad = (n: number) => String(n).padStart(2, '0')

/** Text of an ExcelJS cell value (rich text, formula results, hyperlinks). Dates are returned as Date. */
export function cellValue(value: unknown): unknown {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    if ('result' in v) return cellValue(v.result)
    if ('text' in v && typeof v.text === 'string') return v.text
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((p: any) => p?.text ?? '').join('')
    if ('hyperlink' in v && typeof v.hyperlink === 'string') return String(v.text ?? v.hyperlink).replace(/^mailto:/i, '')
  }
  return value
}

/** Excel date / serial / text → YYYY-MM-DD; anything else is returned as trimmed text (the database will refuse it). */
export function normalizeDate(raw: unknown): string {
  const v = cellValue(raw)
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {                     // Excel serial date (1954…2119)
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000)
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  }
  const s = String(v ?? '').trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(s)                           // DD/MM/YYYY (Malaysian convention)
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`
  return s
}

/** Excel time / fraction / text ("9:00", "09:00:00", "6:30 PM") → HH:MM (24-hour); else trimmed text. */
export function normalizeTime(raw: unknown): string {
  const v = cellValue(raw)
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`
  if (typeof v === 'number' && v >= 0 && v < 1) {
    const total = Math.round(v * 24 * 60)
    return `${pad(Math.floor(total / 60) % 24)}:${pad(total % 60)}`
  }
  const s = String(v ?? '').trim()
  let m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s)
  if (m && +m[1] <= 23 && +m[2] <= 59) return `${pad(+m[1])}:${m[2]}`
  m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i.exec(s)
  if (m && +m[1] >= 1 && +m[1] <= 12 && +(m[2] ?? 0) <= 59) {
    const h = (+m[1] % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)
    return `${pad(h)}:${m[2] ?? '00'}`
  }
  return s
}

export interface ParsedSheet {
  rows: ImportRow[]
  missingColumns: string[]
  skippedBlank: number
}

/** Header row + data rows (any 2-D array of cell values) → import rows. Blank rows are skipped. */
export function rowsFromMatrix(matrix: unknown[][]): ParsedSheet {
  const headerIndex = matrix.findIndex((r) => r.some((c) => String(cellValue(c) ?? '').trim() !== ''))
  if (headerIndex < 0) return { rows: [], missingColumns: ['Employee No or Employee Email', 'Work Date', 'Clock In', 'Clock Out'], skippedBlank: 0 }
  const header = matrix[headerIndex].map((c) => ALIASES[norm(String(cellValue(c) ?? ''))])
  const has = (k: ImportKey) => header.includes(k)
  const missingColumns = [
    ...(!has('employee_no') && !has('email') ? ['Employee No or Employee Email'] : []),
    ...(['work_date', 'clock_in', 'clock_out'] as ImportKey[]).filter((k) => !has(k)).map((k) => IMPORT_COLUMNS.find((c) => c.key === k)!.header),
  ]
  const rows: ImportRow[] = []
  let skippedBlank = 0
  for (let i = headerIndex + 1; i < matrix.length; i++) {
    const cells = matrix[i] ?? []
    if (!cells.some((c) => String(cellValue(c) ?? '').trim() !== '')) { skippedBlank++; continue }
    const row: ImportRow = { row_no: i + 1 }
    header.forEach((key, col) => {
      if (!key) return
      const raw = cells[col]
      const value = key === 'work_date' ? normalizeDate(raw)
        : key === 'clock_in' || key === 'clock_out' ? normalizeTime(raw)
          : key === 'employee_no' ? String(cellValue(raw) ?? '').trim().replace(/\.0+$/, '')
            : String(cellValue(raw) ?? '').trim()
      if (value !== '') row[key] = key === 'note' ? value.slice(0, 500) : value
    })
    rows.push(row)
  }
  return { rows, missingColumns, skippedBlank }
}

/** First worksheet named "Attendance" (else the first sheet) → matrix (1-based Excel rows become array rows). */
export function worksheetMatrix(workbook: ExcelJS.Workbook): unknown[][] {
  const ws = workbook.getWorksheet(IMPORT_SHEET_NAME) ?? workbook.worksheets[0]
  if (!ws) return []
  const matrix: unknown[][] = []
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const values = Array.isArray(row.values) ? (row.values as unknown[]).slice(1) : []
    matrix[rowNumber - 1] = values
  })
  for (let i = 0; i < matrix.length; i++) if (!matrix[i]) matrix[i] = []
  return matrix
}

/** Downloadable template: the data sheet (headers only) and an instructions sheet. */
export function buildImportTemplate(workbook: ExcelJS.Workbook, opts: { timezone?: string; shiftNames?: string[] } = {}): void {
  const ws = workbook.addWorksheet(IMPORT_SHEET_NAME)
  ws.columns = IMPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }))
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  // text format keeps "09:00" and "2026-10-12" exactly as typed
  for (const key of ['employee_no', 'work_date', 'clock_in', 'clock_out'] as const) ws.getColumn(key).numFmt = '@'
  const help = workbook.addWorksheet('Instructions')
  help.columns = [{ header: 'Column', key: 'c', width: 18 }, { header: 'How to fill it', key: 'h', width: 90 }]
  help.getRow(1).font = { bold: true }
  for (const c of IMPORT_COLUMNS) help.addRow({ c: c.header, h: c.note })
  help.addRow({})
  help.addRow({ c: 'Time zone', h: `Times are local company time (${opts.timezone ?? 'Asia/Kuala_Lumpur'}).` })
  help.addRow({ c: 'One row', h: 'One row = one attendance period of one employee. Several periods on one day = several rows.' })
  help.addRow({ c: 'Checks', h: 'Upload → preview: every row is validated (employee, formats, duplicates, overlaps with attendance already recorded). Nothing is saved until you confirm. The same file can be imported once per company; recorded attendance is never overwritten.' })
  help.addRow({ c: 'Example', h: 'Employee No 1001 · Work Date 2026-10-12 · Clock In 09:00 · Clock Out 18:00 · Break Minutes 60' })
  if (opts.shiftNames?.length) help.addRow({ c: 'Shifts', h: opts.shiftNames.join(', ') })
}

/** SHA-256 (hex) of the uploaded file — the database refuses to commit the same file twice. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const OUTCOME_LABELS: Record<string, string> = {
  valid: 'Ready', error: 'Error', duplicate: 'Duplicate (skipped)', conflict: 'Conflict (skipped)', imported: 'Imported',
}
