import { describe, expect, it } from 'vitest'
import { sanitizeExportCell, buildRegistrationsCsv, REGISTRATION_EXPORT_HEADERS } from './export'
import type { EventRegistration } from '@/modules/event-management/types/event'

describe('event-management export (formula-injection protection)', () => {
  it('prefixes spreadsheet formula triggers', () => {
    expect(sanitizeExportCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)")
    expect(sanitizeExportCell('+1234')).toBe("'+1234")
    expect(sanitizeExportCell('-1234')).toBe("'-1234")
    expect(sanitizeExportCell('@cmd')).toBe("'@cmd")
    expect(sanitizeExportCell('\t=1')).toBe("'\t=1")
  })

  it('leaves ordinary values untouched', () => {
    expect(sanitizeExportCell('Amir')).toBe('Amir')
    // A leading '+' is a spreadsheet formula trigger; prefixing preserves the
    // literal E.164 '+' instead of Excel silently dropping it as a number.
    expect(sanitizeExportCell('+60123456789')).toBe("'+60123456789")
  })

  it('null becomes empty string', () => {
    expect(sanitizeExportCell(null)).toBe('')
    expect(sanitizeExportCell(undefined)).toBe('')
  })

  it('builds a CSV with a header row and sanitised visitor fields', () => {
    const rows: EventRegistration[] = [
      {
        id: 'r1',
        event_id: 'e1',
        contact_id: 'c1',
        qr_token_id: 't1',
        attributed_staff_user_id: null,
        submitted_at: '2026-10-07T02:00:00Z',
        ip: null,
        created_at: '2026-10-07T02:00:00Z',
        contact: {
          id: 'c1', event_id: 'e1', name: '=cmd()', phone_normalized: '+60123456789',
          email_normalized: null, cat_name: null, cat_breed: null, current_cat_food: null,
          user_id: null, created_at: '2026-10-07T02:00:00Z',
        },
        qr_token_kind: 'staff',
        attributed_staff_name: null,
        marketing_consent: false,
      },
    ]
    const csv = buildRegistrationsCsv(rows)
    expect(csv.split('\r\n')[0]).toBe(REGISTRATION_EXPORT_HEADERS.join(','))
    expect(csv).toContain("'=cmd()")
  })
})
