'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'
import { Loader2, Plus, Trash2, Save, CheckCircle2 } from 'lucide-react'
import { financeToday } from '@/modules/finance/postingDate'
import { journalTotals } from '@/modules/finance/manualJournal'

interface AccountOption {
  id: string
  code: string
  name: string
}

interface LineDraft {
  key: number
  account_id: string
  description: string
  debit: string
  credit: string
}

export interface ManualJournalDraft {
  id: string
  journal_date: string
  description: string
  reference: string | null
  lines: Array<{ account_id: string; description: string | null; debit_amount: number; credit_amount: number }>
}

interface ManualJournalDialogProps {
  open: boolean
  draft: ManualJournalDraft | null
  onClose: () => void
  onSaved: () => void
}

let nextKey = 1
const emptyLine = (): LineDraft => ({ key: nextKey++, account_id: '', description: '', debit: '', credit: '' })

export default function ManualJournalDialog({ open, draft, onClose, onSaved }: ManualJournalDialogProps) {
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [journalDate, setJournalDate] = useState(financeToday())
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(), emptyLine()])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    if (draft) {
      setJournalDate(draft.journal_date)
      setDescription(draft.description)
      setReference(draft.reference || '')
      setLines(draft.lines.map(l => ({
        key: nextKey++,
        account_id: l.account_id,
        description: l.description || '',
        debit: Number(l.debit_amount) > 0 ? String(l.debit_amount) : '',
        credit: Number(l.credit_amount) > 0 ? String(l.credit_amount) : '',
      })))
    } else {
      setJournalDate(financeToday())
      setDescription('')
      setReference('')
      setLines([emptyLine(), emptyLine()])
    }
  }, [open, draft])

  useEffect(() => {
    if (!open || accounts.length > 0) return
    fetch('/api/accounting/accounts?pageSize=200&isActive=true')
      .then(r => (r.ok ? r.json() : { accounts: [] }))
      .then(d => setAccounts((d.accounts || []).map((a: any) => ({ id: a.id, code: a.code, name: a.name }))))
      .catch(() => setAccounts([]))
  }, [open, accounts.length])

  const totals = useMemo(() => journalTotals(lines), [lines])

  const updateLine = (key: number, patch: Partial<LineDraft>) => {
    setLines(prev => prev.map(l => {
      if (l.key !== key) return l
      const next = { ...l, ...patch }
      // A line is either a debit or a credit: typing one clears the other.
      if (patch.debit !== undefined && patch.debit !== '') next.credit = ''
      if (patch.credit !== undefined && patch.credit !== '') next.debit = ''
      return next
    }))
  }

  const save = async (andPost: boolean) => {
    try {
      setSaving(true)
      const body = {
        journalDate,
        description,
        reference,
        lines: lines
          .filter(l => l.account_id || l.debit || l.credit)
          .map(l => ({ account_id: l.account_id, description: l.description, debit: l.debit, credit: l.credit })),
      }
      const res = await fetch(draft ? `/api/accounting/journals/${draft.id}` : '/api/accounting/journals', {
        method: draft ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        toast({ title: 'Cannot save', description: data.error || 'Failed to save the journal', variant: 'destructive' })
        return
      }

      if (andPost) {
        const postRes = await fetch(`/api/accounting/journals/${data.journal_id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post' }),
        })
        const posted = await postRes.json()
        if (!postRes.ok || !posted.success) {
          toast({
            title: 'Saved as draft, not posted',
            description: posted.error || 'Failed to post the journal',
            variant: 'destructive',
          })
          onSaved()
          return
        }
        toast({ title: 'Journal posted', description: `Journal ${posted.journal_number}` })
      } else {
        toast({ title: 'Draft saved', description: 'The journal is saved as a draft' })
      }
      onSaved()
    } catch (error) {
      console.error('Error saving manual journal:', error)
      toast({ title: 'Error', description: 'Failed to save the journal', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const fmt = (n: number) => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(n)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose() }}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{draft ? 'Edit Manual Journal (Draft)' : 'New Manual Journal'}</DialogTitle>
          <DialogDescription>
            Debits must equal credits. Save as a draft to finish later, or post it now. A posted journal cannot be edited, only reversed.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="mj-date">Journal Date</Label>
            <Input id="mj-date" type="date" value={journalDate} max={financeToday()} onChange={e => setJournalDate(e.target.value)} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label htmlFor="mj-desc">Description</Label>
            <Input id="mj-desc" value={description} maxLength={200} onChange={e => setDescription(e.target.value)} placeholder="e.g. Correct overpayment to supplier" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mj-ref">Reference (optional)</Label>
            <Input id="mj-ref" value={reference} maxLength={100} onChange={e => setReference(e.target.value)} />
          </div>
        </div>

        <div className="rounded-md border mt-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead className="min-w-[240px]">Account</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-36 text-right">Debit</TableHead>
                <TableHead className="w-36 text-right">Credit</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line, idx) => (
                <TableRow key={line.key}>
                  <TableCell>{idx + 1}</TableCell>
                  <TableCell>
                    <Select value={line.account_id || 'none'} onValueChange={v => updateLine(line.key, { account_id: v === 'none' ? '' : v })}>
                      <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none"><span className="text-gray-400">-- Select account --</span></SelectItem>
                        {accounts.map(a => (
                          <SelectItem key={a.id} value={a.id}>
                            <span className="font-mono">{a.code}</span> - {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input value={line.description} maxLength={200} onChange={e => updateLine(line.key, { description: e.target.value })} />
                  </TableCell>
                  <TableCell>
                    <Input type="number" min="0" step="0.01" className="text-right" value={line.debit}
                      onChange={e => updateLine(line.key, { debit: e.target.value })} />
                  </TableCell>
                  <TableCell>
                    <Input type="number" min="0" step="0.01" className="text-right" value={line.credit}
                      onChange={e => updateLine(line.key, { credit: e.target.value })} />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" disabled={lines.length <= 2}
                      onClick={() => setLines(prev => prev.filter(l => l.key !== line.key))}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="bg-gray-50 font-medium">
                <TableCell colSpan={3} className="text-right">Total</TableCell>
                <TableCell className="text-right font-mono">{fmt(totals.debit)}</TableCell>
                <TableCell className="text-right font-mono">{fmt(totals.credit)}</TableCell>
                <TableCell></TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={() => setLines(prev => [...prev, emptyLine()])}>
            <Plus className="w-4 h-4 mr-1" /> Add line
          </Button>
          {totals.balanced ? (
            <span className="text-sm text-green-600">Balanced</span>
          ) : (
            <span className="text-sm text-red-600">
              {totals.debit === 0 && totals.credit === 0 ? 'Enter the amounts' : `Out of balance by ${fmt(Math.abs(totals.difference))}`}
            </span>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="secondary" onClick={() => save(false)} disabled={saving || !totals.balanced}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save Draft
          </Button>
          <Button onClick={() => save(true)} disabled={saving || !totals.balanced}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
            Save &amp; Post
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
