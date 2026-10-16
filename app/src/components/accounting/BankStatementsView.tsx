'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'
import {
  FileSpreadsheet, RefreshCw, Loader2, Upload, CheckCircle2, AlertTriangle,
  Landmark, X, Eye, History, ListOrdered, Send, ShieldCheck, XCircle, Undo2, Download, Ban,
} from 'lucide-react'

/**
 * Bank statement upload with two-person approval.
 *
 *   Check file → Upload (original stored unchanged) → Submit for approval
 *   (reason required when the opening balance differs, there is a gap or no
 *   basis) → a second person Approves (lines are written) or Rejects.
 *   A completed statement can be reversed (latest one only).
 *
 * Every rule is enforced by the API and the database; the screen only hides
 * actions the user cannot take and explains why.
 */

interface BankStatementsViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

interface BankAccount {
  id: string
  account_name: string
  bank_name: string
  account_number: string
  is_active: boolean
  statement_frequency?: 'monthly' | 'daily'
}

type Status = 'uploaded' | 'pending_approval' | 'completed' | 'rejected' | 'reversed' | 'failed' | 'pending'

interface StatementImport {
  id: string
  file_name: string | null
  file_size: number | null
  period_start: string | null
  period_end: string | null
  opening_balance: number | null
  closing_balance: number | null
  total_debit: number | null
  total_credit: number | null
  rows_in_file: number
  rows_inserted: number
  expected_opening_balance: number | null
  opening_difference: number | null
  opening_basis: 'previous_statement' | 'account_opening_balance' | 'none' | null
  reason_required: boolean
  mismatch_reason: string | null
  status: Status
  imported_by: string | null
  imported_at: string
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  rejected_by?: string | null
  rejected_at: string | null
  rejection_reason: string | null
  reversed_by?: string | null
  reversed_at: string | null
  reversal_reason: string | null
}

type People = Record<string, string>

/** Name of a user on the statement; "you" for the signed-in user. */
function personName(people: People, id: string | null | undefined, currentUserId: string | null) {
  if (!id) return null
  if (id === currentUserId) return people[id] ? `${people[id]} (you)` : 'You'
  return people[id] || 'Unknown user'
}

interface StatementLine {
  id?: string
  line_no?: number
  source_row_no?: number
  transaction_date: string
  description: string | null
  counterparty: string | null
  reference: string | null
  debit_amount: number | string
  credit_amount: number | string
  balance: number | string | null
}

interface StatementEvent {
  id: string
  occurred_at: string
  event: string
  actor_id: string | null
  reason: string | null
  details: Record<string, any>
}

interface PreviewSummary {
  bank_account_label: string
  account_number: string
  account_name: string | null
  file_name: string
  period_type: 'monthly' | 'daily' | 'other'
  statement_frequency: 'monthly' | 'daily'
  period_start: string
  period_end: string
  opening_balance: string
  closing_balance: string
  total_debit: string
  total_credit: string
  debit_count: number
  credit_count: number
  lines_in_file: number
  expected_opening_balance: number | null
  opening_basis: 'previous_statement' | 'account_opening_balance' | 'none'
  opening_difference: number | null
  reason_required: boolean
}

interface Permissions { can_view_lines: boolean; can_import: boolean; can_approve: boolean }

const STATUS: Record<Status, { label: string; className: string }> = {
  uploaded: { label: 'Uploaded – not submitted', className: 'bg-blue-100 text-blue-700 border-blue-200' },
  pending_approval: { label: 'Pending approval', className: 'bg-amber-100 text-amber-800 border-amber-200' },
  completed: { label: 'Approved', className: 'bg-green-100 text-green-700 border-green-200' },
  rejected: { label: 'Rejected', className: 'bg-red-100 text-red-700 border-red-200' },
  reversed: { label: 'Reversed', className: 'bg-gray-200 text-gray-700 border-gray-300' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-700 border-red-200' },
  pending: { label: 'Pending', className: 'bg-gray-100 text-gray-700 border-gray-200' },
}

const EVENT_LABEL: Record<string, string> = {
  uploaded: 'Uploaded and validated',
  submitted: 'Submitted for approval',
  approved: 'Approved – lines imported',
  rejected: 'Rejected',
  reversed: 'Reversed – lines removed',
}

const BASIS_LABEL: Record<string, string> = {
  previous_statement: 'closing balance of the previous statement',
  account_opening_balance: 'account opening balance',
  none: 'no previous statement or opening balance date',
}

function formatCurrency(amount: number | string | null | undefined) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(Number(amount) || 0)
}

function formatDate(d: string | null | undefined) {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDateTime(d: string | null | undefined) {
  if (!d) return '-'
  return new Date(d).toLocaleString('en-MY', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function readJson(res: Response) {
  return res.json().catch(() => ({}))
}

export default function BankStatementsView({ userProfile: _userProfile }: BankStatementsViewProps) {
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [bankAccountId, setBankAccountId] = useState('')
  const [imports, setImports] = useState<StatementImport[]>([])
  const [lines, setLines] = useState<StatementLine[]>([])
  const [totalLines, setTotalLines] = useState(0)
  const [permissions, setPermissions] = useState<Permissions>({ can_view_lines: false, can_import: false, can_approve: false })
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [people, setPeople] = useState<People>({})
  const [loading, setLoading] = useState(true)
  const [listLoading, setListLoading] = useState(false)

  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<{ summary: PreviewSummary; warnings: string[]; blocking: string[]; canUpload: boolean; sample: StatementLine[] } | null>(null)
  const [uploaded, setUploaded] = useState<{ importId: string; summary: PreviewSummary } | null>(null)
  const [submitReason, setSubmitReason] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState<'preview' | 'upload' | 'submit' | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const [detailId, setDetailId] = useState<string | null>(null)

  const loadAccounts = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch('/api/accounting/cash/bank-accounts')
      if (res.ok) {
        const data = await res.json()
        const active = (data.accounts || []).filter((a: BankAccount) => a.is_active)
        setAccounts(active)
        setBankAccountId(prev => prev || active[0]?.id || '')
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to load bank accounts', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [])

  const loadStatement = useCallback(async (accountId: string) => {
    if (!accountId) { setImports([]); setLines([]); setTotalLines(0); return }
    try {
      setListLoading(true)
      const res = await fetch(`/api/accounting/cash/bank-statements?bank_account_id=${encodeURIComponent(accountId)}&limit=200`)
      const data = await readJson(res)
      if (!res.ok) throw new Error(data.error || 'Failed to load statements')
      setImports(data.imports || [])
      setLines(data.transactions || [])
      setTotalLines(data.total || 0)
      setPermissions(data.permissions || { can_view_lines: false, can_import: false, can_approve: false })
      setCurrentUserId(data.user_id || null)
      setPeople(data.people || {})
    } catch (e: any) {
      toast({ title: 'Error', description: e.message || 'Failed to load statements', variant: 'destructive' })
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => { loadAccounts() }, [loadAccounts])
  useEffect(() => { loadStatement(bankAccountId) }, [bankAccountId, loadStatement])

  const resetUpload = () => {
    setFile(null)
    setPreview(null)
    setUploaded(null)
    setSubmitReason('')
    setErrors([])
    if (fileInput.current) fileInput.current.value = ''
  }

  const handleFile = (selected: File | undefined) => {
    setPreview(null)
    setUploaded(null)
    setErrors([])
    if (!selected) { setFile(null); return }
    if (!/\.csv$/i.test(selected.name)) {
      setFile(null)
      setErrors(['Please choose the CSV file exported from the bank (Transaction Details).'])
      return
    }
    setFile(selected)
  }

  const send = async (mode: 'preview' | 'upload') => {
    if (!bankAccountId || !file) return
    setBusy(mode)
    setErrors([])
    try {
      const body = new FormData()
      body.set('bank_account_id', bankAccountId)
      body.set('mode', mode)
      body.set('file', file, file.name) // sent unchanged; the server stores this exact file
      const res = await fetch('/api/accounting/cash/bank-statements', { method: 'POST', body })
      const data = await readJson(res)
      if (!res.ok) {
        setErrors(data.errors?.length ? data.errors : data.blocking?.length ? data.blocking : [data.error || 'Request failed'])
        return
      }
      if (mode === 'preview') {
        setPreview({ summary: data.summary, warnings: data.warnings || [], blocking: data.blocking || [], canUpload: Boolean(data.can_upload), sample: data.sample || [] })
      } else {
        setUploaded({ importId: data.import_id, summary: { ...preview!.summary, ...data.summary } })
        toast({ title: 'Statement uploaded', description: 'The original file is stored. Submit it for approval to continue.' })
        loadStatement(bankAccountId)
      }
    } catch {
      setErrors(['Request failed. Please try again.'])
    } finally {
      setBusy(null)
    }
  }

  const submitUploaded = async () => {
    if (!uploaded) return
    setBusy('submit')
    setErrors([])
    try {
      const res = await fetch(`/api/accounting/cash/bank-statements/${uploaded.importId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit', reason: submitReason }),
      })
      const data = await readJson(res)
      if (!res.ok) { setErrors([data.error || 'Request failed']); return }
      toast({ title: 'Submitted for approval', description: 'Another authorised person must approve the statement before its lines are imported.' })
      resetUpload()
      loadStatement(bankAccountId)
    } catch {
      setErrors(['Request failed. Please try again.'])
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    )
  }

  const pendingCount = imports.filter(i => i.status === 'pending_approval').length

  return (
    <div className="space-y-6">
      {/* Upload */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileSpreadsheet className="h-5 w-5 text-blue-600" />
            Upload Bank Statement
          </CardTitle>
          <CardDescription>
            Upload the statement CSV exported from Hong Leong Bank (Transaction Details): a whole month for monthly accounts, or one or more days within a month for daily accounts. The original file is kept unchanged.
            Lines are imported only after a second person approves. Read-only: nothing is sent to the bank.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {accounts.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Add the bank account first in Cash &amp; Banking → Bank Accounts (with the same account number as the statement).
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Bank Account *</Label>
                <select
                  value={bankAccountId}
                  onChange={(e) => { setBankAccountId(e.target.value); resetUpload() }}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>{a.bank_name} - {a.account_name} ({a.account_number}) · {a.statement_frequency === 'daily' ? 'Daily' : 'Monthly'}</option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  {accounts.find(a => a.id === bankAccountId)?.statement_frequency === 'daily'
                    ? 'Daily account: upload one or more days within the same month.'
                    : 'Monthly account: upload one whole calendar month.'}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Statement File (CSV) *</Label>
                <Input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                  className="h-9"
                  disabled={!permissions.can_import || uploaded !== null}
                />
              </div>
            </div>
          )}

          {accounts.length > 0 && !permissions.can_import && !listLoading && (
            <p className="text-xs text-muted-foreground">You can view statements but not upload them (permission: Upload bank statements).</p>
          )}

          {errors.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 space-y-1">
              {errors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}

          {accounts.length > 0 && permissions.can_import && !uploaded && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => send('preview')} disabled={!file || !bankAccountId || busy !== null}>
                {busy === 'preview' ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Eye className="h-4 w-4 mr-1.5" />}
                Check File
              </Button>
              {(file || preview) && (
                <Button size="sm" variant="ghost" onClick={resetUpload} disabled={busy !== null}>
                  <X className="h-4 w-4 mr-1.5" />
                  Clear
                </Button>
              )}
            </div>
          )}

          {preview && !uploaded && (
            <div className="rounded-lg border p-4 space-y-4 bg-muted/10">
              <SummaryGrid summary={preview.summary} />
              <OpeningCheck
                opening={preview.summary.opening_balance}
                expected={preview.summary.expected_opening_balance}
                difference={preview.summary.opening_difference}
                basis={preview.summary.opening_basis}
              />

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline">{preview.summary.lines_in_file} lines</Badge>
                <Badge variant="outline">{preview.summary.debit_count} withdrawals · {preview.summary.credit_count} deposits</Badge>
                <span className="flex items-center gap-1 text-green-700 text-xs">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Running balance verified line by line
                </span>
              </div>

              {preview.blocking.length > 0 && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 space-y-1">
                  {preview.blocking.map((w, i) => (
                    <p key={i} className="flex gap-2"><Ban className="h-4 w-4 shrink-0 mt-0.5" />{w}</p>
                  ))}
                </div>
              )}
              {preview.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 space-y-1">
                  {preview.warnings.map((w, i) => (
                    <p key={i} className="flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />{w}</p>
                  ))}
                </div>
              )}

              {preview.sample.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Latest lines (up to 20)</p>
                  <LinesTable lines={preview.sample} />
                </div>
              )}

              <Button size="sm" onClick={() => send('upload')} disabled={busy !== null || !preview.canUpload}>
                {busy === 'upload' ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}
                Upload statement
              </Button>
            </div>
          )}

          {uploaded && (
            <div className="rounded-lg border border-blue-200 bg-blue-50/40 p-4 space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium text-blue-800">
                <CheckCircle2 className="h-4 w-4" />
                Uploaded: {uploaded.summary.file_name} ({formatDate(uploaded.summary.period_start)} → {formatDate(uploaded.summary.period_end)})
              </p>
              <SubmitReason
                required={uploaded.summary.reason_required}
                value={submitReason}
                onChange={setSubmitReason}
              />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={submitUploaded} disabled={busy !== null || (uploaded.summary.reason_required && submitReason.trim().length < 10)}>
                  {busy === 'submit' ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
                  Submit for approval
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setDetailId(uploaded.importId); resetUpload() }} disabled={busy !== null}>
                  Later
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Statements */}
      {bankAccountId && (
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <History className="h-5 w-5 text-blue-600" />
                  Statements
                  {pendingCount > 0 && <Badge className={STATUS.pending_approval.className}>{pendingCount} pending approval</Badge>}
                </CardTitle>
              </div>
              <Button variant="outline" size="sm" onClick={() => loadStatement(bankAccountId)} disabled={listLoading}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${listLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {imports.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No statements for this account yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Period</TableHead>
                      <TableHead>File</TableHead>
                      <TableHead className="text-right">Opening</TableHead>
                      <TableHead className="text-right">Closing</TableHead>
                      <TableHead className="text-right">Lines</TableHead>
                      <TableHead>Uploaded</TableHead>
                      <TableHead>Approved by</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {imports.map(imp => (
                      <TableRow key={imp.id} className="cursor-pointer" onClick={() => setDetailId(imp.id)}>
                        <TableCell className="text-sm whitespace-nowrap">{formatDate(imp.period_start)} → {formatDate(imp.period_end)}</TableCell>
                        <TableCell className="text-sm max-w-[220px] truncate">{imp.file_name || '-'}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatCurrency(imp.opening_balance)}
                          {imp.opening_difference !== null && Number(imp.opening_difference) !== 0 && (
                            <div className="text-[11px] text-amber-700 font-sans">diff {formatCurrency(imp.opening_difference)}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(imp.closing_balance)}</TableCell>
                        <TableCell className="text-right text-sm">
                          {imp.rows_in_file}
                          {imp.status === 'completed' && <span className="text-green-700"> ✓</span>}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {formatDate(imp.imported_at)}
                          <div className="text-[11px] text-muted-foreground">{personName(people, imp.imported_by, currentUserId) ?? '-'}</div>
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {imp.approved_by ? (
                            <>
                              {personName(people, imp.approved_by, currentUserId)}
                              {imp.approved_at && <div className="text-[11px] text-muted-foreground">{formatDate(imp.approved_at)}</div>}
                            </>
                          ) : imp.status === 'rejected' && imp.rejected_by ? (
                            <span className="text-red-700">Rejected by {personName(people, imp.rejected_by, currentUserId)}</span>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell><Badge className={`text-xs ${STATUS[imp.status]?.className ?? STATUS.pending.className}`}>{STATUS[imp.status]?.label ?? imp.status}</Badge></TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setDetailId(imp.id) }}>
                            <Eye className="h-4 w-4 mr-1" /> Open
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Approved lines */}
      {bankAccountId && permissions.can_view_lines && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ListOrdered className="h-5 w-5 text-blue-600" />
              Bank Transactions
            </CardTitle>
            <CardDescription>
              Approved statements only. {totalLines > lines.length ? `Latest ${lines.length} of ${totalLines} lines.` : `${totalLines} line(s).`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {listLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
              </div>
            ) : lines.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10">
                <Landmark className="h-10 w-10 text-muted-foreground/40 mb-2" />
                <p className="text-sm text-muted-foreground">No approved bank transactions yet.</p>
              </div>
            ) : (
              <LinesTable lines={lines} />
            )}
          </CardContent>
        </Card>
      )}

      <StatementDetail
        id={detailId}
        currentUserId={currentUserId}
        people={people}
        onClose={() => setDetailId(null)}
        onChanged={() => loadStatement(bankAccountId)}
      />
    </div>
  )
}

function SummaryGrid({ summary }: { summary: PreviewSummary }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
      <div>
        <div className="text-xs text-muted-foreground">Account</div>
        <div className="font-medium">{summary.account_name || summary.bank_account_label}</div>
        <div className="text-xs text-muted-foreground font-mono">{summary.account_number}</div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Period</div>
        <div className="font-medium">{formatDate(summary.period_start)} → {formatDate(summary.period_end)}</div>
        <div className="text-xs text-muted-foreground">
          {summary.period_type === 'monthly' ? 'Full month' : summary.period_type === 'daily' ? 'Day(s) within a month' : 'Spans months'}
          {' · '}{summary.statement_frequency === 'daily' ? 'daily account' : 'monthly account'}
        </div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Opening → Closing</div>
        <div className="font-mono">{formatCurrency(summary.opening_balance)} → {formatCurrency(summary.closing_balance)}</div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Withdrawals / Deposits</div>
        <div className="font-mono">{formatCurrency(summary.total_debit)} / {formatCurrency(summary.total_credit)}</div>
      </div>
    </div>
  )
}

function OpeningCheck({ opening, expected, difference, basis }: {
  opening: number | string | null
  expected: number | string | null
  difference: number | string | null
  basis: string | null
}) {
  if (!basis || basis === 'none' || expected === null) {
    return (
      <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
        No previous statement and no account opening balance date to compare the opening balance {formatCurrency(opening)} with.
      </div>
    )
  }
  const matches = Number(difference) === 0
  return (
    <div className={`flex gap-2 rounded-lg border p-3 text-sm ${matches ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
      {matches ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" /> : <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />}
      <span>
        Opening balance {formatCurrency(opening)} {matches ? 'matches' : 'does not match'} the {BASIS_LABEL[basis] ?? basis} ({formatCurrency(expected)})
        {!matches && <> — difference <span className="font-mono font-medium">{formatCurrency(difference)}</span></>}.
      </span>
    </div>
  )
}

function SubmitReason({ required, value, onChange }: { required: boolean; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium">
        {required ? 'Reason (required: opening balance difference, gap or no basis) *' : 'Note (optional)'}
      </Label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={1000}
        placeholder={required ? 'Explain why the opening balance differs, e.g. bank charge posted after month end…' : 'Optional note for the approver'}
      />
      {required && value.trim().length > 0 && value.trim().length < 10 && (
        <p className="text-[11px] text-red-600">At least 10 characters.</p>
      )}
    </div>
  )
}

type DetailAction = 'submit' | 'approve' | 'reject' | 'reverse'

function StatementDetail({ id, currentUserId, people, onClose, onChanged }: {
  id: string | null
  currentUserId: string | null
  people: People
  onClose: () => void
  onChanged: () => void
}) {
  const [data, setData] = useState<{ statement: StatementImport & { warnings: string[]; has_original_file: boolean }; lines: StatementLine[]; events: StatementEvent[]; permissions: { can_import: boolean; can_approve: boolean } } | null>(null)
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<DetailAction | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (statementId: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/accounting/cash/bank-statements/${statementId}`)
      const body = await readJson(res)
      if (!res.ok) throw new Error(body.error || 'Failed to load the statement')
      setData(body)
    } catch (e: any) {
      setError(e.message || 'Failed to load the statement')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setData(null); setAction(null); setReason(''); setError(null)
    if (id) load(id)
  }, [id, load])

  const run = async () => {
    if (!id || !action) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/accounting/cash/bank-statements/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, reason }),
      })
      const body = await readJson(res)
      if (!res.ok) { setError(body.error || 'Request failed'); return }
      const done: Record<DetailAction, string> = {
        submit: 'Submitted for approval',
        approve: `Approved – ${body.rows_inserted ?? ''} line(s) imported`,
        reject: 'Statement rejected',
        reverse: `Statement reversed – ${body.rows_removed ?? ''} line(s) removed`,
      }
      toast({ title: done[action] })
      setAction(null)
      setReason('')
      onChanged()
      load(id)
    } catch {
      setError('Request failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const s = data?.statement
  const perms = data?.permissions
  const isMaker = Boolean(s && currentUserId && (s.imported_by === currentUserId || s.submitted_by === currentUserId))
  const minReason = action === 'reject' ? 5 : action === 'submit' ? (s?.reason_required ? 10 : 0) : 10
  const needsReason = action === 'reject' || action === 'reverse' || (action === 'submit' && Boolean(s?.reason_required))

  return (
    <Dialog open={id !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Bank statement
            {s && <Badge className={`text-xs ${STATUS[s.status]?.className ?? ''}`}>{STATUS[s.status]?.label ?? s.status}</Badge>}
          </DialogTitle>
          <DialogDescription>
            {s ? `${s.file_name || 'Statement'} · ${formatDate(s.period_start)} → ${formatDate(s.period_end)}` : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        {s && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span><span className="text-muted-foreground">Uploaded by</span> {personName(people, s.imported_by, currentUserId) ?? '-'} <span className="text-xs text-muted-foreground">{formatDateTime(s.imported_at)}</span></span>
            {s.submitted_by && <span><span className="text-muted-foreground">Submitted by</span> {personName(people, s.submitted_by, currentUserId)} {s.submitted_at && <span className="text-xs text-muted-foreground">{formatDateTime(s.submitted_at)}</span>}</span>}
            {s.approved_by && <span><span className="text-muted-foreground">Approved by</span> <span className="font-medium text-green-700">{personName(people, s.approved_by, currentUserId)}</span> {s.approved_at && <span className="text-xs text-muted-foreground">{formatDateTime(s.approved_at)}</span>}</span>}
            {s.rejected_by && <span><span className="text-muted-foreground">Rejected by</span> <span className="text-red-700">{personName(people, s.rejected_by, currentUserId)}</span> {s.rejected_at && <span className="text-xs text-muted-foreground">{formatDateTime(s.rejected_at)}</span>}</span>}
            {s.reversed_by && <span><span className="text-muted-foreground">Reversed by</span> {personName(people, s.reversed_by, currentUserId)} {s.reversed_at && <span className="text-xs text-muted-foreground">{formatDateTime(s.reversed_at)}</span>}</span>}
          </div>
        )}

        {loading && !data ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>
        ) : s && perms ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Opening → Closing</div>
                <div className="font-mono">{formatCurrency(s.opening_balance)} → {formatCurrency(s.closing_balance)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Withdrawals / Deposits</div>
                <div className="font-mono">{formatCurrency(s.total_debit)} / {formatCurrency(s.total_credit)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Lines</div>
                <div>{s.rows_in_file} in file{s.status === 'completed' ? ` · ${s.rows_inserted} imported` : ''}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Original file</div>
                {s.has_original_file ? (
                  <a className="inline-flex items-center gap-1 text-blue-600 hover:underline" href={`/api/accounting/cash/bank-statements/${s.id}/file`}>
                    <Download className="h-3.5 w-3.5" /> Download
                  </a>
                ) : <span className="text-muted-foreground">Not stored (imported before approval workflow)</span>}
              </div>
            </div>

            {s.opening_basis && (
              <OpeningCheck opening={s.opening_balance} expected={s.expected_opening_balance} difference={s.opening_difference} basis={s.opening_basis} />
            )}
            {s.mismatch_reason && (
              <div className="rounded-lg border p-3 text-sm"><span className="text-xs text-muted-foreground block">Reason given by the submitter</span>{s.mismatch_reason}</div>
            )}
            {s.rejection_reason && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><span className="text-xs block">Rejection reason</span>{s.rejection_reason}</div>
            )}
            {s.reversal_reason && (
              <div className="rounded-lg border p-3 text-sm"><span className="text-xs text-muted-foreground block">Reversal reason</span>{s.reversal_reason}</div>
            )}
            {s.warnings?.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 space-y-1">
                {s.warnings.map((w, i) => <p key={i} className="flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />{w}</p>)}
              </div>
            )}

            {/* Actions */}
            <div className="rounded-lg border p-3 space-y-3">
              {s.status === 'pending_approval' && isMaker && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="h-4 w-4" /> You uploaded or submitted this statement, so another person must approve it.
                </p>
              )}
              {action === null ? (
                <div className="flex flex-wrap gap-2">
                  {s.status === 'uploaded' && perms.can_import && (
                    <Button size="sm" onClick={() => setAction('submit')}><Send className="h-4 w-4 mr-1.5" />Submit for approval</Button>
                  )}
                  {s.status === 'pending_approval' && perms.can_approve && !isMaker && (
                    <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={() => setAction('approve')}><CheckCircle2 className="h-4 w-4 mr-1.5" />Approve</Button>
                  )}
                  {s.status === 'pending_approval' && perms.can_approve && isMaker && (
                    // Allowed only with a temporary exception granted by a Super Admin (SoD mitigation); otherwise the server refuses.
                    <Button size="sm" variant="outline" onClick={() => setAction('approve')}><CheckCircle2 className="h-4 w-4 mr-1.5" />Approve (needs a granted exception)</Button>
                  )}
                  {(s.status === 'uploaded' || s.status === 'pending_approval') && (perms.can_approve || (isMaker && perms.can_import)) && (
                    <Button size="sm" variant="outline" className="text-red-700" onClick={() => setAction('reject')}>
                      <XCircle className="h-4 w-4 mr-1.5" />{isMaker && !perms.can_approve ? 'Withdraw' : 'Reject'}
                    </Button>
                  )}
                  {s.status === 'completed' && perms.can_approve && s.has_original_file && (
                    <Button size="sm" variant="outline" onClick={() => setAction('reverse')}><Undo2 className="h-4 w-4 mr-1.5" />Reverse</Button>
                  )}
                  {!['uploaded', 'pending_approval', 'completed'].includes(s.status) && (
                    <p className="text-xs text-muted-foreground">No further actions for this statement.</p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    {action === 'submit' && 'Submit this statement for approval'}
                    {action === 'approve' && `Approve and import ${s.rows_in_file} line(s) into Bank Transactions?`}
                    {action === 'reject' && 'Reject this statement (the stored file and history are kept)'}
                    {action === 'reverse' && 'Reverse this approved statement: its lines are removed from Bank Transactions (the file and history are kept)'}
                  </p>
                  {action === 'submit' ? (
                    <SubmitReason required={Boolean(s.reason_required)} value={reason} onChange={setReason} />
                  ) : needsReason ? (
                    <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000}
                      placeholder={`Reason (at least ${minReason} characters)`} />
                  ) : null}
                  <div className="flex gap-2">
                    <Button size="sm" onClick={run} disabled={busy || (needsReason && reason.trim().length < minReason)}
                      className={action === 'approve' ? 'bg-green-600 hover:bg-green-700' : action === 'reject' || action === 'reverse' ? 'bg-red-600 hover:bg-red-700' : ''}>
                      {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                      Confirm {action === 'submit' ? 'submission' : action === 'approve' ? 'approval' : action === 'reject' ? 'rejection' : 'reversal'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => { setAction(null); setReason(''); setError(null) }} disabled={busy}>Cancel</Button>
                  </div>
                </div>
              )}
              {error && <p className="text-sm text-red-700">{error}</p>}
            </div>

            {/* History */}
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">History</p>
              <ol className="space-y-1 text-sm">
                {data!.events.map(ev => (
                  <li key={ev.id} className="flex flex-wrap gap-x-2">
                    <span className="text-muted-foreground whitespace-nowrap">{formatDateTime(ev.occurred_at)}</span>
                    <span className="font-medium">{EVENT_LABEL[ev.event] ?? ev.event}</span>
                    {ev.actor_id && <span className="text-muted-foreground">by {personName(people, ev.actor_id, currentUserId)}</span>}
                    {ev.reason && <span className="text-muted-foreground">— {ev.reason}</span>}
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                Lines in the file ({s.rows_in_file}){data!.lines.length < s.rows_in_file ? ` – first ${data!.lines.length}` : ''}
              </p>
              <LinesTable lines={data!.lines} showRow />
            </div>
          </div>
        ) : error ? (
          <p className="text-sm text-red-700">{error}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function LinesTable({ lines, showRow = false }: { lines: StatementLine[]; showRow?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {showRow && <TableHead className="text-right">Row</TableHead>}
            <TableHead>Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Sender / Receiver</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead className="text-right">Withdrawal</TableHead>
            <TableHead className="text-right">Deposit</TableHead>
            <TableHead className="text-right">Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l, i) => (
            <TableRow key={l.id || `${l.line_no ?? ''}-${l.transaction_date}-${i}`}>
              {showRow && <TableCell className="text-right text-xs text-muted-foreground">{l.source_row_no ?? ''}</TableCell>}
              <TableCell className="text-sm whitespace-nowrap">{formatDate(l.transaction_date)}</TableCell>
              <TableCell className="text-sm">{l.description || '-'}</TableCell>
              <TableCell className="text-sm max-w-[220px] truncate">{l.counterparty || '-'}</TableCell>
              <TableCell className="text-sm max-w-[200px] truncate">{l.reference || '-'}</TableCell>
              <TableCell className="text-right font-mono text-sm text-red-600">{Number(l.debit_amount) ? formatCurrency(l.debit_amount) : ''}</TableCell>
              <TableCell className="text-right font-mono text-sm text-green-700">{Number(l.credit_amount) ? formatCurrency(l.credit_amount) : ''}</TableCell>
              <TableCell className="text-right font-mono text-sm">{formatCurrency(l.balance)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
