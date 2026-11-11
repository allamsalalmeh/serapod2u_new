'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import {
  FileCheck2, RefreshCw, Loader2, Plus, ArrowLeft, Wand2, Link2, Unlink, Send,
  CheckCircle2, Undo2, XCircle, Scale, Landmark, BookOpen, AlertTriangle, FilePlus2,
} from 'lucide-react'

interface BankReconciliationViewProps {
  userProfile: { id: string; organizations: { id: string }; roles: { role_level: number } }
}

interface BankAccount { id: string; account_name: string; bank_name: string | null; gl_account_id: string | null; is_active: boolean }

interface ReconListItem {
  id: string
  bank_account_id: string
  bank_account: BankAccount | null
  period_start: string
  period_end: string
  start_date: string | null
  statement_balance: number
  book_balance: number
  status: 'draft' | 'in_progress' | 'submitted' | 'completed' | 'void'
  created_by_name: string | null
  submitted_by_name: string | null
  approved_by_name: string | null
  is_mine: boolean
  notes: string | null
}

interface Summary {
  statement_balance: number
  book_balance: number
  deposits_in_transit: number
  outstanding_payments: number
  bank_receipts_not_in_books: number
  bank_payments_not_in_books: number
  adjusted_bank_balance: number
  adjusted_book_balance: number
  difference: number
  bank_lines: number
  book_lines: number
  bank_unmatched: number
  book_unmatched: number
  statement_covered_to: string | null
  statement_covers_period: boolean
  can_submit: boolean
}

interface Line {
  side: 'BANK' | 'BOOK'
  id: string
  date: string
  money_in: number
  money_out: number
  description: string | null
  reference: string | null
  journal_number: string | null
  journal_type: string | null
  journal_status: string | null
  match_group: string | null
  match_type: 'AUTO' | 'MANUAL' | null
}

interface Detail {
  reconciliation: ReconListItem & { account_name: string; bank_name: string | null; gl_account_id: string; created_by: string; submitted_by: string | null }
  summary: Summary
  lines: Line[]
}

const STATUS: Record<ReconListItem['status'], { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-gray-50 text-gray-600 border-gray-200' },
  in_progress: { label: 'In progress', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  submitted: { label: 'Awaiting approval', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  completed: { label: 'Completed', className: 'bg-green-100 text-green-700 border-green-200' },
  void: { label: 'Void', className: 'bg-red-50 text-red-600 border-red-200' },
}

const money = (n: number | string | null | undefined) =>
  new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(Number(n) || 0)
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-MY', { year: 'numeric', month: 'short', day: 'numeric' }) : '-'
const net = (l: Line) => Math.round((Number(l.money_in) - Number(l.money_out)) * 100) / 100
const today = () => new Date().toISOString().split('T')[0]

async function call(method: 'GET' | 'POST' | 'PATCH', body?: unknown, query = '') {
  const res = await fetch(`/api/accounting/cash/reconciliation${query}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Request failed')
  return data
}

export default function BankReconciliationView({ userProfile: _userProfile }: BankReconciliationViewProps) {
  const [list, setList] = useState<ReconListItem[]>([])
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)

  const [newAccount, setNewAccount] = useState('')
  const [newEnd, setNewEnd] = useState(today())
  const [newStart, setNewStart] = useState('')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    try {
      setLoading(true)
      const data = await call('GET')
      setList(data.reconciliations || [])
      setAccounts((data.bankAccounts || []).filter((b: BankAccount) => b.is_active && b.gl_account_id))
    } catch (e: any) {
      toast({ title: 'Error', description: e.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadList() }, [loadList])

  const firstForAccount = useMemo(
    () => !!newAccount && !list.some((r) => r.bank_account_id === newAccount && r.status === 'completed' && r.start_date),
    [newAccount, list],
  )

  const start = async () => {
    setStartError(null)
    try {
      setStarting(true)
      const data = await call('POST', { bank_account_id: newAccount, period_end: newEnd, start_date: firstForAccount ? newStart : null })
      await loadList()
      setOpenId(data.reconciliation_id)
    } catch (e: any) {
      setStartError(e.message)
    } finally {
      setStarting(false)
    }
  }

  if (openId) {
    return <ReconciliationDetail id={openId} onBack={() => { setOpenId(null); loadList() }} />
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Plus className="h-5 w-5 text-sky-600" /> New reconciliation
          </CardTitle>
          <CardDescription>
            Matches the approved bank statement with the journals on the bank&apos;s GL account. Import and approve the
            statement in Bank Statements first. The first reconciliation of an account starts on the date you choose
            (normally the go-live date); later ones continue from the last completed period.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div className="space-y-1.5">
              <Label className="text-xs">Bank account</Label>
              <Select value={newAccount} onValueChange={(v) => { setNewAccount(v); setStartError(null) }}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {accounts.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.account_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {firstForAccount && (
              <div className="space-y-1.5">
                <Label className="text-xs">Reconcile from</Label>
                <Input type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} className="h-9" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Period end</Label>
              <Input type="date" value={newEnd} max={today()} onChange={(e) => setNewEnd(e.target.value)} className="h-9" />
            </div>
            <Button onClick={start} disabled={!newAccount || !newEnd || (firstForAccount && !newStart) || starting} className="h-9">
              {starting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
              Start
            </Button>
          </div>
          {startError && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {startError}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <FileCheck2 className="h-5 w-5 text-sky-600" /> Reconciliations
            </CardTitle>
            <Button variant="outline" size="sm" onClick={loadList} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-sky-500" /></div>
          ) : list.length === 0 ? (
            <p className="text-sm text-muted-foreground py-10 text-center">No reconciliations yet.</p>
          ) : (
            <div className="rounded-lg border overflow-x-auto">
              <Table className="min-w-[900px]">
                <TableHeader>
                  <TableRow className="bg-muted/30">
                    <TableHead>Bank account</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Bank balance</TableHead>
                    <TableHead className="text-right">Book balance</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Prepared by</TableHead>
                    <TableHead>Approved by</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((r) => (
                    <TableRow key={r.id} className={r.status === 'void' ? 'opacity-60' : ''}>
                      <TableCell className="text-sm font-medium">{r.bank_account?.account_name || '-'}</TableCell>
                      <TableCell className="text-sm whitespace-nowrap">{fmtDate(r.period_start)} – {fmtDate(r.period_end)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{money(r.statement_balance)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{money(r.book_balance)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${STATUS[r.status]?.className || ''}`}>{STATUS[r.status]?.label || r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">{r.submitted_by_name || r.created_by_name || '-'}</TableCell>
                      <TableCell className="text-sm">{r.approved_by_name || '-'}</TableCell>
                      <TableCell className="text-right">
                        {r.start_date ? (
                          <Button variant="outline" size="sm" onClick={() => setOpenId(r.id)}>Open</Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">Old screen</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ReconciliationDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [reasonFor, setReasonFor] = useState<'return' | 'void' | null>(null)
  const [reason, setReason] = useState('')
  const [adjustLine, setAdjustLine] = useState<Line | null>(null)
  const [adjustAccount, setAdjustAccount] = useState('')
  const [adjustText, setAdjustText] = useState('')
  const [glAccounts, setGlAccounts] = useState<{ id: string; code: string; name: string }[]>([])

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const data = await call('GET', undefined, `?id=${id}`)
      setDetail(data)
      setSelected(new Set())
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const act = async (body: Record<string, unknown>, done?: (data: any) => string | null) => {
    setError(null)
    setNotice(null)
    try {
      setBusy(true)
      const data = await call('PATCH', { id, ...body })
      const msg = done ? done(data) : null
      if (msg) setNotice(msg)
      await load()
      return true
    } catch (e: any) {
      setError(e.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const openAdjust = (line: Line) => {
    setAdjustLine(line)
    setAdjustText(line.description ? line.description.slice(0, 120) : '')
    setAdjustAccount('')
    if (glAccounts.length === 0) {
      fetch('/api/accounting/accounts?pageSize=200&isActive=true')
        .then((r) => (r.ok ? r.json() : { accounts: [] }))
        .then((d) => setGlAccounts((d.accounts || []).map((a: any) => ({ id: a.id, code: a.code, name: a.name }))))
        .catch(() => {})
    }
  }

  if (loading && !detail) {
    return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-sky-500" /></div>
  }
  if (!detail) {
    return (
      <div className="space-y-3">
        <Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4 mr-1.5" /> Back</Button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    )
  }

  const r = detail.reconciliation
  const s = detail.summary
  const editable = r.status === 'draft' || r.status === 'in_progress'
  const visible = detail.lines.filter((l) => showAll || !l.match_group)
  const bank = visible.filter((l) => l.side === 'BANK')
  const book = visible.filter((l) => l.side === 'BOOK')
  const selBank = detail.lines.filter((l) => l.side === 'BANK' && selected.has(l.id))
  const selBook = detail.lines.filter((l) => l.side === 'BOOK' && selected.has(l.id))
  const selBankNet = Math.round(selBank.reduce((t, l) => t + net(l), 0) * 100) / 100
  const selBookNet = Math.round(selBook.reduce((t, l) => t + net(l), 0) * 100) / 100
  const canMatch = selBank.length + selBook.length >= 2 && selBankNet === selBookNet

  const toggle = (lineId: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(lineId)) next.delete(lineId)
      else next.add(lineId)
      return next
    })

  const lineTable = (rows: Line[], side: 'BANK' | 'BOOK') => (
    <div className="rounded-lg border overflow-x-auto max-h-[520px] overflow-y-auto">
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow className="bg-muted/30">
            <TableHead className="w-8" />
            <TableHead>Date</TableHead>
            <TableHead>{side === 'BANK' ? 'Description' : 'Journal'}</TableHead>
            <TableHead className="text-right">In</TableHead>
            <TableHead className="text-right">Out</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-6">Nothing to show</TableCell></TableRow>
          ) : rows.map((l) => (
            <TableRow key={l.id} className={l.match_group ? 'bg-green-50/40' : selected.has(l.id) ? 'bg-sky-50' : ''}>
              <TableCell className="py-1.5">
                {!l.match_group && editable && (
                  <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} className="h-4 w-4" />
                )}
              </TableCell>
              <TableCell className="py-1.5 text-xs whitespace-nowrap">{fmtDate(l.date)}</TableCell>
              <TableCell className="py-1.5 text-xs max-w-[260px]">
                {side === 'BOOK' && (
                  <div className="font-mono">
                    {l.journal_number}
                    {l.journal_status === 'REVERSED' && <span className="ml-1 text-orange-600">(reversed)</span>}
                  </div>
                )}
                <div className="truncate text-muted-foreground" title={l.description || ''}>{l.description || '-'}</div>
                {l.reference && <div className="truncate text-[11px] text-muted-foreground">Ref: {l.reference}</div>}
              </TableCell>
              <TableCell className="py-1.5 text-right font-mono text-xs text-green-700">{Number(l.money_in) > 0 ? money(l.money_in) : ''}</TableCell>
              <TableCell className="py-1.5 text-right font-mono text-xs text-red-700">{Number(l.money_out) > 0 ? money(l.money_out) : ''}</TableCell>
              <TableCell className="py-1.5 text-right whitespace-nowrap">
                {l.match_group ? (
                  <div className="flex items-center justify-end gap-1">
                    <Badge variant="outline" className="text-[10px] text-green-700 border-green-200">{l.match_type === 'AUTO' ? 'Auto' : 'Matched'}</Badge>
                    {editable && (
                      <Button variant="ghost" size="sm" className="h-6 px-1.5" title="Unmatch"
                        onClick={() => act({ action: 'unmatch', matchGroup: l.match_group })} disabled={busy}>
                        <Unlink className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ) : side === 'BANK' && editable ? (
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" title="Record this bank movement with a journal"
                    onClick={() => openAdjust(l)}>
                    <FilePlus2 className="h-3.5 w-3.5 mr-1" /> Record
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4 mr-1.5" /> Back</Button>
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Scale className="h-5 w-5 text-sky-600" /> {r.account_name}
              <Badge variant="outline" className={`text-xs ${STATUS[r.status]?.className || ''}`}>{STATUS[r.status]?.label}</Badge>
            </h2>
            <p className="text-xs text-muted-foreground">
              Period {fmtDate(r.period_start)} – {fmtDate(r.period_end)} · matching since {fmtDate(r.start_date)}
              {s.statement_covered_to && <> · statement to {fmtDate(s.statement_covered_to)}</>}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading || busy}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          {editable && (
            <>
              <Button variant="outline" size="sm" disabled={busy}
                onClick={() => act({ action: 'auto_match' }, (d) => `Matched ${d.matched_pairs} bank line(s) and ${d.matched_reversals} journal/reversal pair(s).`)}>
                <Wand2 className="h-4 w-4 mr-1.5" /> Auto match
              </Button>
              <Button size="sm" disabled={busy || !s.can_submit}
                title={s.can_submit ? undefined : 'Every bank line must be matched and the adjusted balances must agree'}
                onClick={() => act({ action: 'submit' }, () => 'Submitted. Another user must approve it.')}>
                <Send className="h-4 w-4 mr-1.5" /> Submit
              </Button>
            </>
          )}
          {r.status === 'submitted' && (
            <>
              <Button size="sm" disabled={busy} onClick={() => act({ action: 'approve' }, () => 'Reconciliation approved.')}>
                <CheckCircle2 className="h-4 w-4 mr-1.5" /> Approve
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setReasonFor('return'); setReason('') }}>
                <Undo2 className="h-4 w-4 mr-1.5" /> Return
              </Button>
            </>
          )}
          {r.status !== 'void' && (
            <Button variant="outline" size="sm" disabled={busy} className="text-red-600" onClick={() => { setReasonFor('void'); setReason('') }}>
              <XCircle className="h-4 w-4 mr-1.5" /> Void
            </Button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {notice && <div className="rounded-md border border-green-200 bg-green-50 p-2.5 text-sm text-green-700">{notice}</div>}

      {reasonFor && (
        <div className="rounded-lg border p-3 space-y-2 bg-muted/20">
          <Label className="text-xs">{reasonFor === 'void' ? 'Reason for voiding (all matches are released)' : 'Reason for returning it to the preparer'}</Label>
          <div className="flex gap-2">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} className="h-9" maxLength={300} />
            <Button size="sm" disabled={!reason.trim() || busy}
              onClick={async () => { if (await act({ action: reasonFor, reason })) setReasonFor(null) }}>
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReasonFor(null)}>Cancel</Button>
          </div>
        </div>
      )}

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 font-medium mb-1"><Landmark className="h-4 w-4" /> Bank</div>
              <Row label="Balance per bank statement" value={s.statement_balance} />
              <Row label="+ Deposits in transit (in books, not yet in bank)" value={s.deposits_in_transit} muted />
              <Row label="− Outstanding payments (in books, not yet in bank)" value={s.outstanding_payments} muted />
              <Row label="Adjusted bank balance" value={s.adjusted_bank_balance} strong />
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 font-medium mb-1"><BookOpen className="h-4 w-4" /> Books</div>
              <Row label="Balance per books" value={s.book_balance} />
              <Row label="+ Bank receipts not in books" value={s.bank_receipts_not_in_books} muted />
              <Row label="− Bank payments not in books" value={s.bank_payments_not_in_books} muted />
              <Row label="Adjusted book balance" value={s.adjusted_book_balance} strong />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm border-t pt-3">
            <span>Difference: <b className={Number(s.difference) === 0 ? 'text-green-700' : 'text-red-600'}>{money(s.difference)}</b></span>
            <span>Bank lines not matched: <b className={s.bank_unmatched === 0 ? 'text-green-700' : 'text-red-600'}>{s.bank_unmatched}</b> of {s.bank_lines}</span>
            <span>Book lines not matched: <b>{s.book_unmatched}</b> of {s.book_lines}</span>
            {!s.statement_covers_period && <span className="text-red-600">The approved statement does not reach the period end.</span>}
          </div>
        </CardContent>
      </Card>

      {adjustLine && (
        <div className="rounded-lg border p-3 space-y-2 bg-amber-50/40">
          <p className="text-sm">
            Record <b>{money(Math.abs(net(adjustLine)))}</b> {net(adjustLine) < 0 ? 'paid out' : 'received'} on {fmtDate(adjustLine.date)} with a
            journal. It is saved as a draft: another user posts it from GL Journals, then run Auto match.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <Select value={adjustAccount} onValueChange={setAdjustAccount}>
              <SelectTrigger className="h-9"><SelectValue placeholder={net(adjustLine) < 0 ? 'Expense account (e.g. bank charges)' : 'Income account (e.g. interest)'} /></SelectTrigger>
              <SelectContent>
                {glAccounts.filter((g) => g.id !== r.gl_account_id).map((g) => (
                  <SelectItem key={g.id} value={g.id}>{g.code} – {g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input value={adjustText} onChange={(e) => setAdjustText(e.target.value)} placeholder="Description" className="h-9 md:col-span-1" />
            <div className="flex gap-2">
              <Button size="sm" disabled={!adjustAccount || !adjustText.trim() || busy}
                onClick={async () => {
                  const ok = await act(
                    { action: 'adjust', statementLineId: adjustLine.id, accountId: adjustAccount, description: adjustText },
                    () => 'Draft journal created. Another user posts it from General Ledger → GL Journals; then run Auto match.',
                  )
                  if (ok) setAdjustLine(null)
                }}>
                Create draft journal
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdjustLine(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {editable && (selBank.length + selBook.length > 0) && (
        <div className="sticky top-2 z-20 flex flex-wrap items-center gap-4 rounded-lg border bg-background p-3 shadow-sm text-sm">
          <span>Bank selected: <b className="font-mono">{money(selBankNet)}</b></span>
          <span>Books selected: <b className="font-mono">{money(selBookNet)}</b></span>
          <span className={canMatch ? 'text-green-700' : 'text-red-600'}>
            {canMatch ? 'They agree' : `Difference ${money(selBankNet - selBookNet)}`}
          </span>
          <Button size="sm" disabled={!canMatch || busy}
            onClick={() => act({ action: 'match', statementIds: selBank.map((l) => l.id), journalLineIds: selBook.map((l) => l.id) })}>
            <Link2 className="h-4 w-4 mr-1.5" /> Match selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      <div className="flex items-center gap-2 text-sm">
        <input id="show-all" type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="h-4 w-4" />
        <label htmlFor="show-all">Show matched lines too</label>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><Landmark className="h-4 w-4" /> Bank statement</CardTitle>
            <CardDescription className="text-xs">Approved statement lines from the matching start date to the period end.</CardDescription>
          </CardHeader>
          <CardContent>{lineTable(bank, 'BANK')}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2"><BookOpen className="h-4 w-4" /> Books</CardTitle>
            <CardDescription className="text-xs">Posted journal lines on the bank&apos;s GL account.</CardDescription>
          </CardHeader>
          <CardContent>{lineTable(book, 'BOOK')}</CardContent>
        </Card>
      </div>

      {r.notes && <p className="text-xs text-muted-foreground whitespace-pre-line">{r.notes}</p>}
    </div>
  )
}

function Row({ label, value, strong, muted }: { label: string; value: number; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? 'border-t pt-1 font-semibold' : ''} ${muted ? 'text-muted-foreground' : ''}`}>
      <span>{label}</span>
      <span className="font-mono">{money(value)}</span>
    </div>
  )
}
