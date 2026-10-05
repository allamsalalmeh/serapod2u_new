'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import {
  FileSpreadsheet, RefreshCw, Loader2, Upload, CheckCircle2, AlertTriangle,
  Landmark, X, Eye, History, ListOrdered,
} from 'lucide-react'

interface BankStatementsViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

interface BankAccount {
  id: string
  account_name: string
  bank_name: string
  account_number: string
  is_active: boolean
}

interface StatementImport {
  id: string
  file_name: string | null
  period_start: string | null
  period_end: string | null
  opening_balance: number | null
  closing_balance: number | null
  rows_in_file: number
  rows_inserted: number
  rows_skipped: number
  status: string
  imported_at: string
}

interface StatementLine {
  id?: string
  transaction_date: string
  description: string | null
  counterparty: string | null
  reference: string | null
  debit_amount: number | string
  credit_amount: number | string
  balance: number | string | null
}

interface PreviewSummary {
  bank_account_label: string
  account_number: string
  account_name: string | null
  period_start: string
  period_end: string
  opening_balance: string
  closing_balance: string
  total_debit: string
  total_credit: string
  lines_in_file: number
  new_lines: number
  already_imported: number
}

function formatCurrency(amount: number | string | null | undefined) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(Number(amount) || 0)
}

function formatDate(d: string | null | undefined) {
  if (!d) return '-'
  return new Date(d).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function BankStatementsView({ userProfile: _userProfile }: BankStatementsViewProps) {
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [bankAccountId, setBankAccountId] = useState('')
  const [imports, setImports] = useState<StatementImport[]>([])
  const [lines, setLines] = useState<StatementLine[]>([])
  const [totalLines, setTotalLines] = useState(0)
  const [loading, setLoading] = useState(true)
  const [listLoading, setListLoading] = useState(false)

  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [preview, setPreview] = useState<{ summary: PreviewSummary; warnings: string[]; sample: StatementLine[] } | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

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
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load statement lines')
      setImports(data.imports || [])
      setLines(data.transactions || [])
      setTotalLines(data.total || 0)
    } catch (e: any) {
      toast({ title: 'Error', description: e.message || 'Failed to load statement lines', variant: 'destructive' })
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => { loadAccounts() }, [loadAccounts])
  useEffect(() => { loadStatement(bankAccountId) }, [bankAccountId, loadStatement])

  const resetUpload = () => {
    setFile(null)
    setPreview(null)
    setErrors([])
    if (fileInput.current) fileInput.current.value = ''
  }

  const handleFile = async (selected: File | undefined) => {
    setPreview(null)
    setErrors([])
    if (!selected) { setFile(null); return }
    if (!/\.csv$/i.test(selected.name)) {
      setFile(null)
      setErrors(['Please choose the CSV file exported from the bank (Transaction Details).'])
      return
    }
    setFile({ name: selected.name, text: await selected.text() })
  }

  const send = async (mode: 'preview' | 'import') => {
    if (!bankAccountId || !file) return
    setBusy(mode)
    setErrors([])
    try {
      const res = await fetch('/api/accounting/cash/bank-statements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank_account_id: bankAccountId, file_name: file.name, csv_text: file.text, mode }),
      })
      const data = await res.json()
      if (!res.ok) {
        setPreview(null)
        setErrors(data.errors?.length ? data.errors : [data.error || 'Request failed'])
        return
      }
      if (mode === 'preview') {
        setPreview({ summary: data.summary, warnings: data.warnings || [], sample: data.sample || [] })
      } else {
        toast({
          title: 'Statement imported',
          description: `${data.summary.new_lines} new line(s) added, ${data.summary.already_imported} already imported.`,
        })
        resetUpload()
        loadStatement(bankAccountId)
      }
    } catch {
      setErrors(['Request failed. Please try again.'])
    } finally {
      setBusy(null)
    }
  }

  const statusColor = (s: string) => {
    switch (s) {
      case 'completed': return 'bg-green-100 text-green-700 border-green-200'
      case 'failed': return 'bg-red-100 text-red-700 border-red-200'
      default: return 'bg-gray-100 text-gray-700 border-gray-200'
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Upload */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileSpreadsheet className="h-5 w-5 text-blue-600" />
            Import Bank Statement
          </CardTitle>
          <CardDescription>
            Upload the statement CSV exported from Hong Leong Bank (Transaction Details). Read-only: nothing is sent to the bank.
            Importing an overlapping period only adds the lines that are not stored yet.
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
                  onChange={(e) => { setBankAccountId(e.target.value); setPreview(null); setErrors([]) }}
                  className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>{a.bank_name} - {a.account_name} ({a.account_number})</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Statement File (CSV) *</Label>
                <Input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => handleFile(e.target.files?.[0])}
                  className="h-9"
                />
              </div>
            </div>
          )}

          {errors.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 space-y-1">
              {errors.map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}

          {accounts.length > 0 && (
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

          {preview && (
            <div className="rounded-lg border p-4 space-y-4 bg-muted/10">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">Account</div>
                  <div className="font-medium">{preview.summary.account_name || preview.summary.bank_account_label}</div>
                  <div className="text-xs text-muted-foreground font-mono">{preview.summary.account_number}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Period</div>
                  <div className="font-medium">{formatDate(preview.summary.period_start)} → {formatDate(preview.summary.period_end)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Opening → Closing</div>
                  <div className="font-mono">{formatCurrency(preview.summary.opening_balance)} → {formatCurrency(preview.summary.closing_balance)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Withdrawals / Deposits</div>
                  <div className="font-mono">{formatCurrency(preview.summary.total_debit)} / {formatCurrency(preview.summary.total_credit)}</div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="outline">{preview.summary.lines_in_file} lines in file</Badge>
                <Badge className="bg-green-100 text-green-700 border-green-200">{preview.summary.new_lines} new</Badge>
                <Badge className="bg-gray-100 text-gray-700 border-gray-200">{preview.summary.already_imported} already imported</Badge>
                <span className="flex items-center gap-1 text-green-700 text-xs">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Running balance verified line by line
                </span>
              </div>

              {preview.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 space-y-1">
                  {preview.warnings.map((w, i) => (
                    <p key={i} className="flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />{w}</p>
                  ))}
                </div>
              )}

              {preview.sample.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Latest new lines (up to 20)</p>
                  <LinesTable lines={preview.sample} />
                </div>
              )}

              <Button size="sm" onClick={() => send('import')} disabled={busy !== null || preview.summary.new_lines === 0}>
                {busy === 'import' ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}
                {preview.summary.new_lines === 0 ? 'Nothing new to import' : `Import ${preview.summary.new_lines} new line(s)`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Imports history */}
      {bankAccountId && (
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <History className="h-5 w-5 text-blue-600" />
                Import History
              </CardTitle>
              <Button variant="outline" size="sm" onClick={() => loadStatement(bankAccountId)} disabled={listLoading}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${listLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {imports.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No statements imported for this account yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Imported</TableHead>
                      <TableHead>File</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Closing Balance</TableHead>
                      <TableHead className="text-right">Lines</TableHead>
                      <TableHead className="text-right">New</TableHead>
                      <TableHead className="text-right">Skipped</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {imports.map(imp => (
                      <TableRow key={imp.id}>
                        <TableCell className="text-sm">{formatDate(imp.imported_at)}</TableCell>
                        <TableCell className="text-sm max-w-[240px] truncate">{imp.file_name || '-'}</TableCell>
                        <TableCell className="text-sm">{formatDate(imp.period_start)} → {formatDate(imp.period_end)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatCurrency(imp.closing_balance)}</TableCell>
                        <TableCell className="text-right text-sm">{imp.rows_in_file}</TableCell>
                        <TableCell className="text-right text-sm text-green-700">{imp.rows_inserted}</TableCell>
                        <TableCell className="text-right text-sm text-muted-foreground">{imp.rows_skipped}</TableCell>
                        <TableCell><Badge className={`text-xs ${statusColor(imp.status)}`}>{imp.status}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Stored lines */}
      {bankAccountId && (
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ListOrdered className="h-5 w-5 text-blue-600" />
              Bank Transactions
            </CardTitle>
            <CardDescription>
              {totalLines > lines.length ? `Latest ${lines.length} of ${totalLines} lines.` : `${totalLines} line(s).`}
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
                <p className="text-sm text-muted-foreground">No bank transactions imported yet.</p>
              </div>
            ) : (
              <LinesTable lines={lines} />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function LinesTable({ lines }: { lines: StatementLine[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
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
            <TableRow key={l.id || `${l.transaction_date}-${i}`}>
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
