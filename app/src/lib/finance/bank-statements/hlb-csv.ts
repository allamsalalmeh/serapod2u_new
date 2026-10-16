/**
 * Hong Leong Bank "Transaction Details" CSV (HLB Connect / ConnectFirst export).
 *
 * Layout: a metadata block ("Account Number / Currency :", "Statement Period :",
 * "Prior Day Balance :", ...), then a header row starting with
 * "Transaction Date", then one row per transaction, newest first.
 *
 * The export has no unique bank reference per line, so a line is identified by
 * date + debit + credit + running balance, plus an occurrence number for the
 * rare case where the balance returns to the same value on the same day.
 * Exports always cover whole days, so the same day yields the same keys in
 * every file and overlapping imports only add the missing lines.
 */

export const HLB_CSV_FORMAT = 'HLB_CSV'

export interface BankStatementLine {
  transactionDate: string
  description: string
  chequeNo: string | null
  counterparty: string | null
  reference: string | null
  paymentDetails: string | null
  debitCents: number
  creditCents: number
  balanceCents: number
  branchCode: string | null
  daySequence: number
  dedupeKey: string
  /** 1-based line number of this transaction in the original file. */
  sourceRowNo: number
}

export interface BankStatementMeta {
  accountNumber: string | null
  currency: string | null
  accountName: string | null
  periodStart: string | null
  periodEnd: string | null
  openingBalanceCents: number | null
}

export interface ParsedBankStatement {
  format: typeof HLB_CSV_FORMAT
  meta: BankStatementMeta
  lines: BankStatementLine[]
  closingBalanceCents: number | null
  totalDebitCents: number
  totalCreditCents: number
  errors: string[]
  warnings: string[]
}

const COLUMNS = {
  date: 'transaction date',
  description: 'remarks',
  chequeNo: 'cheque no.',
  counterparty: 'sender / receiver name',
  reference: 'receipient reference',
  paymentDetails: 'other payment details',
  debit: 'payment amount',
  credit: 'credit amount',
  balance: 'balance',
  branchCode: 'branch code',
} as const

const REQUIRED_COLUMNS: (keyof typeof COLUMNS)[] = ['date', 'debit', 'credit', 'balance']

export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

/** "1,234.50" → 123450. Empty → 0. Invalid → null. */
export function parseAmountCents(value: string | undefined): number | null {
  const text = String(value ?? '').replace(/,/g, '').trim()
  if (text === '') return 0
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.replace('-', '').split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return text.startsWith('-') ? -cents : cents
}

/** "31/07/2026" → "2026-07-31". Invalid → null. */
export function parseDmyDate(value: string | undefined): string | null {
  const m = String(value ?? '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  const [, dd, mm, yyyy] = m
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)))
  if (date.getUTCFullYear() !== Number(yyyy) || date.getUTCMonth() !== Number(mm) - 1 || date.getUTCDate() !== Number(dd)) return null
  return `${yyyy}-${mm}-${dd}`
}

export function normalizeAccountNumber(value: string | null | undefined): string {
  return String(value ?? '').replace(/\D/g, '')
}

export function centsToAmount(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

const blankToNull = (v: string | undefined) => {
  const t = String(v ?? '').trim()
  return t === '' ? null : t
}

export function parseHlbStatementCsv(text: string): ParsedBankStatement {
  const errors: string[] = []
  const warnings: string[] = []
  const meta: BankStatementMeta = {
    accountNumber: null, currency: null, accountName: null,
    periodStart: null, periodEnd: null, openingBalanceCents: null,
  }
  const result = (lines: BankStatementLine[] = []): ParsedBankStatement => ({
    format: HLB_CSV_FORMAT,
    meta,
    lines,
    closingBalanceCents: lines.length ? lines[lines.length - 1].balanceCents : null,
    totalDebitCents: lines.reduce((s, l) => s + l.debitCents, 0),
    totalCreditCents: lines.reduce((s, l) => s + l.creditCents, 0),
    errors,
    warnings,
  })

  const rows = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).map(parseCsvLine)
  const headerIndex = rows.findIndex(r => r[0]?.trim().toLowerCase() === COLUMNS.date)
  if (headerIndex < 0) {
    errors.push('This is not a Hong Leong Bank "Transaction Details" CSV (no "Transaction Date" header).')
    return result()
  }

  for (const row of rows.slice(0, headerIndex)) {
    const label = row[0]?.trim().replace(/\s*:\s*$/, '').toLowerCase()
    const value = row[1]?.trim() ?? ''
    if (label === 'account number / currency') {
      const m = value.match(/^([\d\s-]+?)\s*([A-Z]{3})?$/)
      meta.accountNumber = m ? normalizeAccountNumber(m[1]) : normalizeAccountNumber(value)
      meta.currency = m?.[2] ?? null
    } else if (label === 'account name') {
      meta.accountName = value || null
    } else if (label === 'statement period') {
      const [start, end] = value.split('-').map(s => parseDmyDate(s))
      meta.periodStart = start ?? null
      meta.periodEnd = end ?? null
    } else if (label === 'prior day balance') {
      meta.openingBalanceCents = parseAmountCents(value)
    }
  }
  if (!meta.accountNumber) errors.push('Account number is missing from the file header.')
  if (!meta.periodStart || !meta.periodEnd) errors.push('Statement period is missing or invalid in the file header.')
  if (meta.openingBalanceCents === null) errors.push('Prior day balance is missing or invalid in the file header.')

  const header = rows[headerIndex].map(h => h.trim().toLowerCase())
  const col = {} as Record<keyof typeof COLUMNS, number>
  for (const [key, name] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) col[key] = header.indexOf(name)
  const missing = REQUIRED_COLUMNS.filter(k => col[k] < 0).map(k => COLUMNS[k])
  if (missing.length) {
    errors.push(`Missing column(s): ${missing.join(', ')}.`)
    return result()
  }

  type Raw = Omit<BankStatementLine, 'daySequence' | 'dedupeKey' | 'sourceRowNo'> & { row: number }
  const raw: Raw[] = []
  let mangledReferences = 0
  rows.slice(headerIndex + 1).forEach((r, i) => {
    if (!r.some(v => v.trim() !== '')) return
    const rowNo = headerIndex + 2 + i
    const date = parseDmyDate(r[col.date])
    const debit = parseAmountCents(r[col.debit])
    const credit = parseAmountCents(r[col.credit])
    const balance = parseAmountCents(r[col.balance])
    if (!date) { errors.push(`Row ${rowNo}: invalid transaction date.`); return }
    if (debit === null || credit === null || balance === null || debit < 0 || credit < 0) { errors.push(`Row ${rowNo}: invalid amount.`); return }
    if (String(r[col.balance] ?? '').trim() === '') { errors.push(`Row ${rowNo}: balance is empty.`); return }
    const pick = (k: keyof typeof COLUMNS) => (col[k] >= 0 ? blankToNull(r[col[k]]) : null)
    const reference = pick('reference')
    if (reference && /^\d(\.\d+)?E\+\d+$/i.test(reference)) mangledReferences++
    raw.push({
      row: rowNo,
      transactionDate: date,
      description: pick('description') ?? '',
      chequeNo: pick('chequeNo'),
      counterparty: pick('counterparty'),
      reference,
      paymentDetails: pick('paymentDetails'),
      debitCents: debit,
      creditCents: credit,
      balanceCents: balance,
      branchCode: pick('branchCode'),
    })
  })
  if (errors.length) return result()
  if (!raw.length) {
    errors.push('The file has no transactions.')
    return result()
  }
  if (mangledReferences) {
    warnings.push(`${mangledReferences} reference(s) look like Excel scientific notation (e.g. 1.22E+15). Amounts are not affected; export the CSV again without saving it in Excel to keep the full references.`)
  }

  // HLB lists newest first; use chronological order.
  const first = raw[0].transactionDate
  const last = raw[raw.length - 1].transactionDate
  const chronological = first > last ? [...raw].reverse() : raw

  let running = meta.openingBalanceCents ?? 0
  for (const line of chronological) {
    running = running - line.debitCents + line.creditCents
    if (running !== line.balanceCents) {
      errors.push(`Row ${line.row}: balance ${centsToAmount(line.balanceCents)} does not follow from the previous balance (expected ${centsToAmount(running)}). The file is incomplete or was edited.`)
      return result()
    }
  }

  for (const line of chronological) {
    if ((meta.periodStart && line.transactionDate < meta.periodStart) || (meta.periodEnd && line.transactionDate > meta.periodEnd)) {
      errors.push(`Row ${line.row}: date ${line.transactionDate} is outside the statement period.`)
      return result()
    }
  }

  const daySeq = new Map<string, number>()
  const occurrences = new Map<string, number>()
  const lines: BankStatementLine[] = chronological.map(({ row, ...line }) => {
    const seq = (daySeq.get(line.transactionDate) ?? 0) + 1
    daySeq.set(line.transactionDate, seq)
    const base = `${line.transactionDate}|${line.debitCents}|${line.creditCents}|${line.balanceCents}`
    const n = (occurrences.get(base) ?? 0) + 1
    occurrences.set(base, n)
    return { ...line, daySequence: seq, dedupeKey: `${base}|${n}`, sourceRowNo: row }
  })
  return result(lines)
}

export type StatementFrequency = 'monthly' | 'daily'
export type StatementPeriodType = 'monthly' | 'daily' | 'other'

const ymd = (v: string | null | undefined) => String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)

/**
 * Describes a statement period: a whole calendar month, a day or several
 * consecutive days within one month ('daily'), or anything else.
 */
export function statementPeriodType(start: string | null | undefined, end: string | null | undefined): StatementPeriodType {
  const s = ymd(start)
  const e = ymd(end)
  if (!s || !e || s[1] !== e[1] || s[2] !== e[2] || String(start) > String(end)) return 'other'
  const lastDay = new Date(Date.UTC(Number(s[1]), Number(s[2]), 0)).getUTCDate()
  return Number(s[3]) === 1 && Number(e[3]) === lastDay ? 'monthly' : 'daily'
}

/**
 * Period rule of the bank account's statement frequency (the database
 * function bank_statement_period_error applies the same rule):
 *   monthly  one whole calendar month
 *   daily    one or more consecutive days within one month, not in the future
 * Returns null when the period is accepted, otherwise a message.
 */
export function statementPeriodError(
  frequency: StatementFrequency,
  start: string | null | undefined,
  end: string | null | undefined,
  today: string,
): string | null {
  if (!ymd(start) || !ymd(end) || String(start) > String(end)) return 'The statement period is invalid.'
  const type = statementPeriodType(start, end)
  if (frequency === 'monthly') {
    return type === 'monthly' ? null
      : `This account takes monthly statements: the file must cover a whole calendar month (it covers ${start} to ${end}).`
  }
  if (type === 'other') return `A daily statement must stay within one calendar month (this file covers ${start} to ${end}).`
  if (String(end) > today) return `The statement period ends in the future (${end}).`
  return null
}
