import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatMinutes, W3_ERROR_CODES, w3Error } from './messages'
import { normalizeDate, normalizeTime, rowsFromMatrix, sha256Hex } from './attendance-import'

const repo = path.resolve(__dirname, '../../../../..')
const migrations = ['20261222100000_hr_hybrid_attendance_overtime.sql', '20261223100000_hr_leave_ledger.sql']
  .map((f) => fs.readFileSync(path.join(repo, 'supabase/migrations', f), 'utf8')).join('\n')

describe('Wave 3 messages', () => {
  it('every error code the migrations raise has a caller-safe message', () => {
    const raised = new Set([...migrations.matchAll(/raise exception '([a-z0-9_]+)'/g)].map((m) => m[1]))
    const missing = [...raised].filter((c) => !W3_ERROR_CODES.includes(c))
    expect(missing).toEqual([])
  })
  it('maps codes, keeps balance numbers, detects a missing migration and never leaks raw errors', () => {
    expect(w3Error({ message: 'hr_attendance_maker_checker' })).toMatchObject({ status: 403, code: 'MAKER_CHECKER' })
    expect(w3Error({ message: 'hr_leave_insufficient_balance', details: '3 day(s) requested in 2027, 1 available' }).message).toMatch(/1 available/)
    expect(w3Error({ message: 'Could not find the function public.hr_overtime_submit' }).status).toBe(503)
    expect(w3Error({ message: 'duplicate key value violates unique constraint "secret_internal"' })).toMatchObject({ status: 500, message: 'The request could not be completed.' })
  })
  it('formats minutes', () => {
    expect(formatMinutes(450)).toBe('7h 30m')
    expect(formatMinutes(null)).toBe('—')
  })
})

describe('Excel import reading', () => {
  it('dates: ISO, DD/MM/YYYY (Malaysian), Excel serial and Date cells; ambiguous text passed through', () => {
    expect(normalizeDate('2026-10-1')).toBe('2026-10-01')
    expect(normalizeDate('12/10/2026')).toBe('2026-10-12')
    expect(normalizeDate(46307)).toBe('2026-10-12')
    expect(normalizeDate(new Date(Date.UTC(2026, 9, 12)))).toBe('2026-10-12')
    expect(normalizeDate('10-12-26')).toBe('10-12-26')
  })
  it('times: HH:MM, H:MM, seconds, AM/PM, Excel fraction and time cells', () => {
    expect(normalizeTime('9:05')).toBe('09:05')
    expect(normalizeTime('18:00:00')).toBe('18:00')
    expect(normalizeTime('6:30 PM')).toBe('18:30')
    expect(normalizeTime('12 am')).toBe('00:00')
    expect(normalizeTime(0.375)).toBe('09:00')
    expect(normalizeTime(new Date(Date.UTC(1899, 11, 30, 17, 45)))).toBe('17:45')
    expect(normalizeTime('25:00')).toBe('25:00')
  })
  it('header mapping, blank rows skipped, row numbers kept, missing columns reported', () => {
    const parsed = rowsFromMatrix([
      ['Employee No', 'Work Date', 'Clock In', 'Clock Out', 'Break Minutes', 'Note'],
      [1001, '12/10/2026', '9:00', '18:00', 60, 'site A'],
      [],
      ['1002.0', new Date(Date.UTC(2026, 9, 13)), 0.375, 0.75, '', ''],
    ])
    expect(parsed.missingColumns).toEqual([])
    expect(parsed.skippedBlank).toBe(1)
    expect(parsed.rows).toEqual([
      { row_no: 2, employee_no: '1001', work_date: '2026-10-12', clock_in: '09:00', clock_out: '18:00', break_minutes: '60', note: 'site A' },
      { row_no: 4, employee_no: '1002', work_date: '2026-10-13', clock_in: '09:00', clock_out: '18:00' },
    ])
    expect(rowsFromMatrix([['Name', 'Date']]).missingColumns).toEqual(['Employee No or Employee Email', 'Clock In', 'Clock Out'])
  })
  it('file hash (duplicate-file protection)', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
