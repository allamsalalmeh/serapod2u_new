'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCheck, Clock, Download, Eye, Loader2, Mail, RefreshCw, Search, Send } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import NotificationChannelSwitch from '@/components/settings/NotificationChannelSwitch'
import { formatNotificationAction, type EmailMonitorStatus } from '@/lib/notifications/emailActivity'

interface EmailMessage {
  id: string
  source: 'log' | 'outbox'
  outboxId: string | null
  orgId: string | null
  orgName: string | null
  createdAt: string | null
  queuedAt: string | null
  sentAt: string | null
  deliveredAt: string | null
  failedAt: string | null
  status: EmailMonitorStatus
  rawStatus: string
  receiver: string | null
  eventCode: string | null
  providerName: string | null
  providerMessageId: string | null
  errorMessage: string | null
  retryCount: number
  maxRetries: number | null
  templateCode: string | null
  priority: string | null
  payload: Record<string, unknown> | null
  subject: string | null
  messageBody: string | null
  providerResponse: unknown
  statusDetails: string | null
  orderId: string | null
  orderNo: string | null
}

function formatTime(value: string | null) {
  if (!value) return '-'
  const dt = new Date(value)
  if (Number.isNaN(dt.getTime())) return '-'
  return dt.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

function formatOrder(row: { orderNo?: string | null; orderId?: string | null }) {
  return row.orderNo || row.orderId || ''
}

function KpiCard({
  tone,
  icon,
  label,
  value,
  hint,
}: {
  tone: 'amber' | 'blue' | 'green' | 'red'
  icon: React.ReactNode
  label: string
  value: number
  hint?: string
}) {
  const map = {
    amber: 'bg-amber-50 text-amber-600 border-amber-100',
    blue: 'bg-blue-50 text-blue-600 border-blue-100',
    green: 'bg-emerald-50 text-emerald-600 border-emerald-100',
    red: 'bg-red-50 text-red-600 border-red-100',
  } as const

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <span className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border ${map[tone]}`}>{icon}</span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-slate-500">{label}</p>
          <p className="mt-0.5 text-2xl font-bold leading-tight text-slate-900 tabular-nums">{value}</p>
          {hint ? <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p> : null}
        </div>
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: EmailMonitorStatus }) {
  const tone = status === 'delivered'
    ? 'bg-blue-100 text-blue-800'
    : status === 'failed'
      ? 'bg-red-100 text-red-800'
      : status === 'sent'
        ? 'bg-emerald-100 text-emerald-800'
        : 'bg-amber-100 text-amber-800'
  const label = status === 'delivered' ? 'Delivered' : status === 'failed' ? 'Failed' : status === 'sent' ? 'Sent' : 'Pending'
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{label}</span>
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-1.5 text-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="break-all text-slate-800">{value || '-'}</div>
    </div>
  )
}

export default function EmailDeliveryMonitor() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<EmailMessage[]>([])
  const [kpis, setKpis] = useState({ pending: 0, sent: 0, delivered: 0, failed: 0, total: 0 })
  const [search, setSearch] = useState('')
  const [statusTab, setStatusTab] = useState<'all' | EmailMonitorStatus>('all')
  const [eventFilter, setEventFilter] = useState('all')
  const [selected, setSelected] = useState<EmailMessage | null>(null)

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/settings/notifications/email-activity')
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Failed to load email activity')
      setMessages(result.messages || [])
      setKpis(result.kpis || { pending: 0, sent: 0, delivered: 0, failed: 0, total: 0 })
    } catch (err: any) {
      setError(err.message || 'Failed to load email activity')
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const hasOpen = messages.some((row) => row.status === 'sent' || row.status === 'pending')
    if (!hasOpen) return
    const timer = window.setInterval(() => {
      void load({ silent: true })
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [messages, load])

  const eventOptions = useMemo(() => {
    const codes = Array.from(new Set(messages.map((row) => row.eventCode).filter(Boolean))) as string[]
    return codes.sort()
  }, [messages])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return messages.filter((row) => {
      if (statusTab !== 'all' && row.status !== statusTab) return false
      if (eventFilter !== 'all' && row.eventCode !== eventFilter) return false
      if (!query) return true
      return [
        row.receiver,
        row.orgName,
        row.orderNo,
        row.orderId,
        row.eventCode,
        formatNotificationAction(row.eventCode),
        row.subject,
        row.providerName,
        row.providerMessageId,
        row.errorMessage,
        row.rawStatus,
        row.messageBody,
      ].some((value) => String(value || '').toLowerCase().includes(query))
    })
  }, [messages, search, statusTab, eventFilter])

  const exportCsv = () => {
    const header = ['Date', 'Receiver', 'Organization', 'Action', 'Order', 'Status', 'Subject', 'Provider', 'Error']
    const rows = filtered.map((row) => [
      formatTime(row.createdAt),
      row.receiver || '',
      row.orgName || '',
      formatNotificationAction(row.eventCode),
      formatOrder(row),
      row.status,
      row.subject || '',
      row.providerName || '',
      row.errorMessage || '',
    ])
    const csv = [header, ...rows].map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `email-delivery-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const tabCounts = {
    all: messages.length,
    pending: kpis.pending,
    sent: kpis.sent,
    delivered: kpis.delivered,
    failed: kpis.failed,
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
            <Mail className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Notification Monitor</h1>
            <p className="mt-0.5 max-w-2xl text-sm text-slate-500">
              Track every email generated and sent by the system: the action that created it, the receiver, status, and date.
            </p>
            <div className="mt-3">
              <NotificationChannelSwitch active="email" />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <KpiCard tone="amber" icon={<Clock className="h-4 w-4" />} label="Pending" value={kpis.pending} hint="Queued or retrying" />
        <KpiCard tone="green" icon={<Send className="h-4 w-4" />} label="Sent" value={kpis.sent} hint="Accepted by the email provider" />
        <KpiCard tone="blue" icon={<CheckCheck className="h-4 w-4" />} label="Delivered" value={kpis.delivered} hint="If the provider reports delivery" />
        <KpiCard tone="red" icon={<AlertCircle className="h-4 w-4" />} label="Failed" value={kpis.failed} hint="Final failure" />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search receiver, action, order, or error..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 pl-8"
            />
          </div>
          <Select value={eventFilter} onValueChange={setEventFilter}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="All actions" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {eventOptions.map((code) => (
                <SelectItem key={code} value={code}>{formatNotificationAction(code)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            className="h-9 text-slate-600"
            onClick={() => {
              setSearch('')
              setEventFilter('all')
              setStatusTab('all')
            }}
          >
            Clear
          </Button>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 pb-2">
          {([
            ['all', 'All', tabCounts.all, 'text-slate-700'],
            ['pending', 'Pending', tabCounts.pending, 'text-amber-600'],
            ['sent', 'Sent', tabCounts.sent, 'text-emerald-600'],
            ['delivered', 'Delivered', tabCounts.delivered, 'text-blue-600'],
            ['failed', 'Failed', tabCounts.failed, 'text-red-600'],
          ] as const).map(([key, label, count, color]) => (
            <button
              key={key}
              onClick={() => setStatusTab(key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${statusTab === key ? 'bg-slate-900 text-white' : `bg-slate-50 ${color} hover:bg-slate-100`}`}
            >
              {label} <span className="ml-1 opacity-80">({count})</span>
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />Loading emails...
          </div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-red-600">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-slate-400">
            <Mail className="mx-auto mb-2 h-8 w-8 text-slate-300" />
            <p className="text-sm">No emails in this view</p>
            <p className="mt-0.5 text-xs">Emails appear here when the system queues or sends them (including WhatsApp → SMS → Email fallback).</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left">
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Date</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Receiver</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Organization</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Action</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Order</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Status</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Error</th>
                  <th className="px-2 py-2 text-right text-xs font-medium text-slate-500">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((row) => (
                  <tr key={`${row.source}-${row.id}`} className="hover:bg-slate-50/60">
                    <td className="px-2 py-2.5 align-top text-xs text-slate-600">{formatTime(row.createdAt)}</td>
                    <td className="px-2 py-2.5 align-top font-mono text-xs text-slate-800">{row.receiver || '-'}</td>
                    <td className="px-2 py-2.5 align-top text-xs text-slate-600">{row.orgName || '-'}</td>
                    <td className="px-2 py-2.5 align-top">
                      <div className="text-xs capitalize text-slate-700">{formatNotificationAction(row.eventCode)}</div>
                      {row.subject ? <div className="mt-0.5 max-w-[280px] truncate text-[11px] text-slate-400" title={row.subject}>{row.subject}</div> : null}
                    </td>
                    <td className="px-2 py-2.5 align-top">
                      {formatOrder(row) ? (
                        <div className="font-mono text-xs text-slate-800" title={row.orderId || undefined}>{formatOrder(row)}</div>
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 align-top">
                      <StatusPill status={row.status} />
                      {row.rawStatus && row.rawStatus !== row.status ? (
                        <div className="mt-0.5 text-[10px] text-slate-400">{row.rawStatus}</div>
                      ) : null}
                    </td>
                    <td className="px-2 py-2.5 align-top">
                      {row.errorMessage ? (
                        <div className="max-w-[220px] truncate text-[11px] text-red-600" title={row.errorMessage}>{row.errorMessage}</div>
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right align-top">
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="Details" onClick={() => setSelected(row)}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null) }}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Email details</DialogTitle>
            <DialogDescription>Full delivery record for this system email.</DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <StatusPill status={selected.status} />
                <Badge variant="secondary">{selected.providerName || 'email'}</Badge>
              </div>
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 px-3">
                <DetailRow label="Receiver" value={selected.receiver} />
                <DetailRow label="Organization" value={selected.orgName} />
                <DetailRow label="Action" value={formatNotificationAction(selected.eventCode)} />
                <DetailRow label="Event code" value={selected.eventCode} />
                <DetailRow label="Subject" value={selected.subject} />
                <DetailRow label="Order" value={formatOrder(selected) || '-'} />
                {selected.orderId && selected.orderNo ? <DetailRow label="Order ID" value={selected.orderId} /> : null}
                <DetailRow label="Body" value={selected.messageBody} />
                <DetailRow label="Raw status" value={selected.rawStatus} />
                <DetailRow label="Created" value={formatTime(selected.createdAt)} />
                <DetailRow label="Queued" value={formatTime(selected.queuedAt)} />
                <DetailRow label="Sent" value={formatTime(selected.sentAt)} />
                <DetailRow label="Delivered" value={formatTime(selected.deliveredAt)} />
                <DetailRow label="Failed" value={formatTime(selected.failedAt)} />
                <DetailRow label="Message ID" value={selected.providerMessageId} />
                <DetailRow label="Retries" value={`${selected.retryCount}${selected.maxRetries != null ? ` / ${selected.maxRetries}` : ''}`} />
                <DetailRow label="Priority" value={selected.priority} />
                <DetailRow label="Template" value={selected.templateCode} />
                <DetailRow label="Error" value={selected.errorMessage} />
                <DetailRow label="Outbox ID" value={selected.outboxId} />
              </div>
              {selected.payload ? (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Payload</p>
                  <pre className="max-h-48 overflow-auto rounded-md bg-slate-50 p-3 text-[11px] text-slate-700">{JSON.stringify(selected.payload, null, 2)}</pre>
                </div>
              ) : null}
              {selected.providerResponse ? (
                <div>
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Provider response</p>
                  <pre className="max-h-48 overflow-auto rounded-md bg-slate-50 p-3 text-[11px] text-slate-700">{JSON.stringify(selected.providerResponse, null, 2)}</pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
