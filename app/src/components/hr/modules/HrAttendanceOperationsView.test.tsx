// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'

// Wave 3 HR operations: import preview → explicit commit; decisions need a reason where the database requires one;
// success only for a stored result.
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

import HrAttendanceOperationsView from './HrAttendanceOperationsView'

let posts: { url: string; body: any }[] = []
const previewBatch = {
  batch: { id: '00000000-0000-0000-0000-0000000000b1', file_name: 'att.xlsx', status: 'previewed', row_count: 2, valid_count: 1, error_count: 1, duplicate_count: 0, conflict_count: 0, imported_count: 0, created_at: new Date().toISOString() },
  rows: [
    { row_no: 2, outcome: 'valid', messages: [], employee_no: 1001, employee_name: 'Aina', work_date: '2026-10-12', clock_in_at: '2026-10-12T01:00:00Z', clock_out_at: '2026-10-12T10:00:00Z', raw: {} },
    { row_no: 3, outcome: 'error', messages: ['No onboarded employee with this employee number in this company.'], employee_no: null, employee_name: null, work_date: null, clock_in_at: null, clock_out_at: null, raw: { employee_no: '9999', work_date: '2026-10-12', clock_in: '09:00', clock_out: '18:00' } },
  ],
}
const otRow = { id: '00000000-0000-0000-0000-0000000000d1', employee_name: 'Aina', employee_no: 1001, request_date: '2026-10-12', ot_minutes: 60, approved_minutes: null, status: 'submitted', request_kind: 'post', reason: 'Month end', day_type: 'normal', exceeds_policy_cap: false, exceeds_recorded_time: true, approver_name: null, approver_comment: null, decided_authority: null, can_decide: true, entry: null }

beforeEach(() => {
  toast.mockReset(); posts = []
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body); posts.push({ url: u, body })
      if (body.action === 'preview') return new Response(JSON.stringify({ success: true, data: previewBatch }))
      if (body.action === 'commit') return new Response(JSON.stringify({ success: true, data: { status: 'committed', imported: 1, conflicts_at_commit: 0 } }))
      if (body.action === 'reject') return new Response(JSON.stringify({ success: true, data: { status: 'rejected' } }))
      return new Response(JSON.stringify({ success: false, error: 'Refused', code: 'X' }), { status: 400 })
    }
    if (u.startsWith('/api/hr/attendance/overtime/requests')) return new Response(JSON.stringify({ success: true, data: [otRow] }))
    if (u.startsWith('/api/hr/attendance/import?batch_id')) return new Response(JSON.stringify({ success: true, data: { ...previewBatch, batch: { ...previewBatch.batch, status: 'committed', imported_count: 1 } } }))
    return new Response(JSON.stringify({ success: true, data: [] }))
  }) as any
})
afterEach(cleanup)

const openTab = async (name: RegExp) => {
  const tab = await screen.findByRole('tab', { name })
  fireEvent.mouseDown(tab); fireEvent.click(tab)
}

async function workbookFile(): Promise<File> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Attendance')
  ws.addRow(['Employee No', 'Work Date', 'Clock In', 'Clock Out', 'Break Minutes'])
  ws.addRow(['1001', '12/10/2026', '9:00', '18:00', 60])
  ws.addRow(['9999', '2026-10-12', '09:00', '18:00', ''])
  const buf = await wb.xlsx.writeBuffer()
  const file = new File([buf], 'att.xlsx')
  ;(file as any).arrayBuffer = async () => buf
  return file
}

describe('HrAttendanceOperationsView (Wave 3)', () => {
  it('Excel import: preview sends normalised rows + file hash, shows per-row outcome, commit confirms the valid count', async () => {
    render(<HrAttendanceOperationsView />)
    await openTab(/Excel import/)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [await workbookFile()] } })
    await waitFor(() => expect(posts.find((p) => p.body.action === 'preview')).toBeTruthy(), { timeout: 5000 })
    const preview = posts.find((p) => p.body.action === 'preview')!
    expect(preview.url).toBe('/api/hr/attendance/import')
    expect(preview.body.file_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(preview.body.rows[0]).toMatchObject({ row_no: 2, employee_no: '1001', work_date: '2026-10-12', clock_in: '09:00', clock_out: '18:00', break_minutes: '60' })
    expect(await screen.findByText(/No onboarded employee/)).toBeTruthy()
    fireEvent.click(screen.getByText('Import 1 row(s)'))
    await waitFor(() => expect(posts.find((p) => p.body.action === 'commit')?.body).toMatchObject({ batch_id: previewBatch.batch.id, expected_valid: 1 }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: '1 row(s) imported' })))
  })

  it('overtime rejection requires a reason before it is sent', async () => {
    render(<HrAttendanceOperationsView />)
    await openTab(/Overtime/)
    expect(await screen.findByText('More than recorded time')).toBeTruthy()
    fireEvent.click(screen.getByText('Reject'))
    const confirm = await screen.findByRole('button', { name: 'Reject' , hidden: false })
    const dialogButtons = screen.getAllByRole('button', { name: 'Reject' })
    const dialogConfirm = dialogButtons[dialogButtons.length - 1] as HTMLButtonElement
    expect(dialogConfirm.disabled).toBe(true)
    fireEvent.change(screen.getAllByRole('textbox').slice(-1)[0], { target: { value: 'Covered by shift swap' } })
    expect(dialogConfirm.disabled).toBe(false)
    fireEvent.click(dialogConfirm)
    await waitFor(() => expect(posts.find((p) => p.body.action === 'reject')?.body).toMatchObject({ id: otRow.id, comment: 'Covered by shift swap' }))
    void confirm
  })
})
