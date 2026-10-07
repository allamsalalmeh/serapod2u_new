import type { EventRegistration } from '@/modules/event-management/types/event'

/**
 * CSV/Excel export with spreadsheet formula-injection protection.
 *
 * Any cell whose trimmed value begins with a formula trigger character
 * (`=`, `+`, `-`, `@`, tab, CR) is prefixed with a single quote so it cannot
 * be evaluated as a formula when the export is opened in a spreadsheet
 * application (OWASP CSV injection mitigation). This applies to ALL
 * visitor-supplied fields, never just the obvious ones.
 */

const FORMULA_TRIGGERS = /^[=+\-@\t\r]/

export function sanitizeExportCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  // Prefix formula triggers; also strip any leading zero-width/control chars.
  const safe = text.replace(/^[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/, '')
  return FORMULA_TRIGGERS.test(safe) ? `'${safe}` : safe
}

export const REGISTRATION_EXPORT_HEADERS = [
  'Name',
  'Phone',
  'Email',
  'Cat Name',
  'Cat Breed',
  'Current Cat Food',
  'Source',
  'Attributed Staff',
  'Marketing Consent',
  'Submitted At (Asia/Kuala_Lumpur)',
] as const

function registrationRow(r: EventRegistration, timeZone = 'Asia/Kuala_Lumpur'): string[] {
  const submitted = new Date(r.submitted_at)
  const submittedLocal = isNaN(submitted.getTime())
    ? ''
    : new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'short', timeStyle: 'medium' }).format(submitted)

  return [
    sanitizeExportCell(r.contact?.name),
    sanitizeExportCell(r.contact?.phone_normalized),
    sanitizeExportCell(r.contact?.email_normalized),
    sanitizeExportCell(r.contact?.cat_name),
    sanitizeExportCell(r.contact?.cat_breed),
    sanitizeExportCell(r.contact?.current_cat_food),
    sanitizeExportCell(r.qr_token_kind === 'booth' ? 'Booth' : 'Staff'),
    sanitizeExportCell(r.attributed_staff_name),
    r.marketing_consent ? 'Yes' : 'No',
    submittedLocal,
  ]
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function buildRegistrationsCsv(registrations: EventRegistration[]): string {
  const lines = [REGISTRATION_EXPORT_HEADERS.map(escapeCsvField).join(',')]
  for (const r of registrations) {
    lines.push(registrationRow(r).map(escapeCsvField).join(','))
  }
  return lines.join('\r\n')
}

/** ExcelJS workbook builder (server-only; exceljs is a server dependency). */
export async function buildRegistrationsExcel(registrations: EventRegistration[]): Promise<Buffer> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Serapod2U'
  const sheet = workbook.addWorksheet('Registrations')
  sheet.addRow([...REGISTRATION_EXPORT_HEADERS])
  for (const r of registrations) {
    // Each cell is written as a string; formula triggers are already sanitised.
    sheet.addRow(registrationRow(r).map((v) => String(v)))
  }
  sheet.getRow(1).font = { bold: true }
  sheet.columns.forEach((col) => {
    col.width = 24
  })
  return Buffer.from(await workbook.xlsx.writeBuffer())
}
