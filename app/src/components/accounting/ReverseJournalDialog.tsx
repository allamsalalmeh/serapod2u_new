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
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (journal) {
      setError(null)
      setReason('')
      setReversalDate(financeToday())
    }
  }, [journal])

  const submit = async () => {
    if (!journal) return
    try {
      setSaving(true)
      setError(null)
      const res = await fetch(`/api/accounting/journals/${journal.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reverse', reason, reversalDate }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to reverse the journal')
        return
      }
      toast({
        title: 'Journal reversed',
        description: `Reversal ${data.reversal_number}${data.document_reopened ? '. The source document is back in Pending Postings.' : ''}`,
      })
      onReversed()
    } catch (err) {
      console.error('Error reversing journal:', err)
      setError('Failed to reverse the journal. Check your connection and try again.')
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

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
        )}

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
