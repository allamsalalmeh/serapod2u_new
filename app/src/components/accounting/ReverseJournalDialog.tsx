'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'
import { Loader2, Undo2 } from 'lucide-react'
import { financeToday } from '@/modules/finance/postingDate'

interface ReverseJournalDialogProps {
  journal: { id: string; journal_number: string; journal_date: string } | null
  onClose: () => void
  onReversed: () => void
}

export default function ReverseJournalDialog({ journal, onClose, onReversed }: ReverseJournalDialogProps) {
  const [reason, setReason] = useState('')
  const [reversalDate, setReversalDate] = useState(financeToday())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (journal) {
      setReason('')
      setReversalDate(financeToday())
    }
  }, [journal])

  const submit = async () => {
    if (!journal) return
    try {
      setSaving(true)
      const res = await fetch(`/api/accounting/journals/${journal.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reverse', reason, reversalDate }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        toast({ title: 'Cannot reverse', description: data.error || 'Failed to reverse the journal', variant: 'destructive' })
        return
      }
      toast({
        title: 'Journal reversed',
        description: `Reversal ${data.reversal_number}${data.document_reopened ? '. The source document is back in Pending Postings.' : ''}`,
      })
      onReversed()
    } catch (error) {
      console.error('Error reversing journal:', error)
      toast({ title: 'Error', description: 'Failed to reverse the journal', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={!!journal} onOpenChange={(o) => { if (!o && !saving) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Reverse Journal {journal?.journal_number}</DialogTitle>
          <DialogDescription>
            A new journal with the debits and credits swapped is posted on the reversal date. The original stays in the ledger,
            marked as reversed. If it came from a document or a payment, that document returns to Pending Postings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="rv-date">Reversal Date</Label>
            <Input id="rv-date" type="date" value={reversalDate} min={journal?.journal_date?.slice(0, 10)} max={financeToday()}
              onChange={e => setReversalDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rv-reason">Reason</Label>
            <Textarea id="rv-reason" value={reason} maxLength={300} rows={3} onChange={e => setReason(e.target.value)}
              placeholder="Why is this journal being reversed?" />
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={saving || !reason.trim()}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Undo2 className="w-4 h-4 mr-2" />}
            Reverse Journal
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
