import { describe, expect, it } from 'vitest'
import { assertLeaveRowsChanged, leaveErrorMessage, LEAVE_ERROR_MESSAGES } from './leaveErrors'

describe('leaveErrorMessage', () => {
  it('maps every database guard code to its message', () => {
    for (const [code, message] of Object.entries(LEAVE_ERROR_MESSAGES)) {
      expect(leaveErrorMessage({ message: code, code: '42501' })).toBe(message)
    }
  })

  it('reads the code from details as well as message', () => {
    expect(leaveErrorMessage({ message: 'error', details: 'hr_leave_self_approval' })).toBe(LEAVE_ERROR_MESSAGES.hr_leave_self_approval)
  })

  it('treats a row-level security refusal as not authorized', () => {
    expect(leaveErrorMessage({ message: 'new row violates row-level security policy for table "hr_leave_approvals"' })).toMatch(/not authorized/)
  })

  it('never echoes unknown database text', () => {
    expect(leaveErrorMessage({ message: 'relation "x" does not exist' })).toBe('The leave request could not be saved.')
    expect(leaveErrorMessage(undefined, 'Custom')).toBe('Custom')
  })
})

describe('assertLeaveRowsChanged', () => {
  it('refuses an update that matched no visible row', () => {
    expect(() => assertLeaveRowsChanged([])).toThrow(/not authorized/)
    expect(() => assertLeaveRowsChanged(null)).toThrow()
  })

  it('accepts an update that changed a row', () => {
    expect(() => assertLeaveRowsChanged([{ id: '1' }])).not.toThrow()
  })
})
