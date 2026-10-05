import { describe, expect, it } from 'vitest'
import { normalizeAccountNumber, parseAmountCents, parseDmyDate, parseHlbStatementCsv } from './hlb-csv'

const HEADER = 'Transaction Date,Remarks,Cheque No.,Sender / Receiver Name,Receipient Reference,Other Payment Details,Payment Amount,Credit Amount,Balance,Branch Code'

function csv(rows: string[], { period = '01/03/2026-31/03/2026', opening = '"1,000.00"' } = {}) {
  return [
    'Transaction Details,,,,,,,,,',
    ',,,,,,,,,',
    'Report Generated On :,01/04/2026 10:00,,,,,,,,',
    'Account Number / Currency :,11122233344 MYR,,,,,,,,',
    'Account Name :,TEST COMPANY SDN. BHD.,,,,,,,,',
    `Statement Period :,${period},,,,,,,,`,
    'Branch Name :,"TEST BRANCH, PENANG",,,,,,,,',
    `Prior Day Balance :,${opening},,,,,,,,`,
    ',,,,,,,,,',
    HEADER,
    ...rows,
  ].join('\r\n')
}

// Newest first, as exported by the bank. Opening 1,000.00.
const MARCH = [
  '31/03/2026,Profit,,,,,0,1.50,201.50,100',
  '15/03/2026,Instant Transfer,,CUSTOMER B,INV-2,,0,100,200.00,100',
  '15/03/2026,CIB Instant Transfer,,SUPPLIER A,PO-1,,100,0,100.00,100',
  '15/03/2026,Instant Transfer,,CUSTOMER A,INV-1,,0,100,200.00,100',
  '02/03/2026,Remittance Cable Charge,,SUPPLIER A,PO-1,OUR,"1,000.00",0,100.00,100',
  '01/03/2026,Instant Transfer,,CUSTOMER C,Paid,,0,100,"1,100.00",100',
]

describe('HLB statement CSV parser', () => {
  it('parses amounts, dates and account numbers strictly', () => {
    expect(parseAmountCents('"1,234.50"'.replace(/"/g, ''))).toBe(123450)
    expect(parseAmountCents('15')).toBe(1500)
    expect(parseAmountCents('')).toBe(0)
    expect(parseAmountCents('1.22E+15')).toBeNull()
    expect(parseDmyDate('31/07/2026')).toBe('2026-07-31')
    expect(parseDmyDate('31/02/2026')).toBeNull()
    expect(normalizeAccountNumber('1112-223 3344')).toBe('11122233344')
  })

  it('reads the header block and returns lines oldest first with a verified balance chain', () => {
    const parsed = parseHlbStatementCsv(csv(MARCH))
    expect(parsed.errors).toEqual([])
    expect(parsed.meta).toEqual({
      accountNumber: '11122233344', currency: 'MYR', accountName: 'TEST COMPANY SDN. BHD.',
      periodStart: '2026-03-01', periodEnd: '2026-03-31', openingBalanceCents: 100000,
    })
    expect(parsed.lines.map(l => l.transactionDate)).toEqual(['2026-03-01', '2026-03-02', '2026-03-15', '2026-03-15', '2026-03-15', '2026-03-31'])
    expect(parsed.lines[0]).toMatchObject({ counterparty: 'CUSTOMER C', creditCents: 10000, balanceCents: 110000, daySequence: 1 })
    expect(parsed.closingBalanceCents).toBe(20150)
    expect(parsed.totalDebitCents).toBe(110000)
    expect(parsed.totalCreditCents).toBe(30150)
  })

  it('gives same-day lines that return to the same balance distinct keys', () => {
    const keys = parseHlbStatementCsv(csv(MARCH)).lines.map(l => l.dedupeKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain('2026-03-15|0|10000|20000|1')
    expect(keys).toContain('2026-03-15|0|10000|20000|2')
  })

  it('produces identical keys for the shared days of overlapping exports (delta)', () => {
    const full = parseHlbStatementCsv(csv(MARCH))
    const firstHalf = parseHlbStatementCsv(csv(MARCH.slice(1), { period: '01/03/2026-15/03/2026' }))
    const secondHalf = parseHlbStatementCsv(csv(MARCH.slice(0, 4), { period: '10/03/2026-31/03/2026', opening: '100.00' }))
    expect(firstHalf.errors).toEqual([])
    expect(secondHalf.errors).toEqual([])
    const fullKeys = new Set(full.lines.map(l => l.dedupeKey))
    const union = new Set([...firstHalf.lines, ...secondHalf.lines].map(l => l.dedupeKey))
    expect(union).toEqual(fullKeys)
    const overlap = firstHalf.lines.filter(l => secondHalf.lines.some(s => s.dedupeKey === l.dedupeKey))
    expect(overlap.map(l => l.transactionDate)).toEqual(['2026-03-15', '2026-03-15', '2026-03-15'])
  })

  it('rejects a file whose running balance does not add up', () => {
    const broken = [...MARCH]
    broken.splice(4, 1)
    const parsed = parseHlbStatementCsv(csv(broken))
    expect(parsed.lines).toEqual([])
    expect(parsed.errors[0]).toMatch(/does not follow from the previous balance/)
  })

  it('rejects files that are not HLB transaction exports or have bad rows', () => {
    expect(parseHlbStatementCsv('a,b,c\n1,2,3').errors[0]).toMatch(/not a Hong Leong Bank/)
    const badDate = parseHlbStatementCsv(csv(['2026-03-31,Profit,,,,,0,1.50,"1,001.50",100']))
    expect(badDate.errors[0]).toMatch(/invalid transaction date/)
    const outside = parseHlbStatementCsv(csv(['01/04/2026,Profit,,,,,0,1.50,"1,001.50",100']))
    expect(outside.errors[0]).toMatch(/outside the statement period/)
  })

  it('warns when Excel turned references into scientific notation', () => {
    const parsed = parseHlbStatementCsv(csv(['31/03/2026,FPX B2B1,,TAX OFFICE,1.22509E+15,,281,0,719.00,100']))
    expect(parsed.errors).toEqual([])
    expect(parsed.warnings[0]).toMatch(/scientific notation/)
  })
})
