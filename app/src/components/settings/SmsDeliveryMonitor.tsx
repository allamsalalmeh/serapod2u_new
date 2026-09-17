'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CheckCheck, Clock, Download, Eye, Loader2, MessageSquare, Pencil, RefreshCw, Search, Send } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import NotificationChannelSwitch from '@/components/settings/NotificationChannelSwitch'
import { toSmsE164 } from '@/lib/notifications/manualPhoneNumbers'

type MonitorStatus = 'pending' | 'sent' | 'delivered' | 'failed'

interface SmsMessage {
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
  status: MonitorStatus
  rawStatus: string
  phone: string | null
  eventCode: string | null
  providerName: string | null
  providerMessageId: string | null
  errorMessage: string | null
  errorCode: string | null
  retryCount: number
  maxRetries: number | null
  templateCode: string | null
  priority: string | null
  payload: Record<string, unknown> | null
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

function formatEvent(value: string | null) {
  if (!value) return '-'
  return value.replace(/_/g, ' ')
}

function formatOrder(row: { orderNo?: string | null; orderId?: string | null }) {
  return row.orderNo || row.orderId || ''
}

function formatSmsPhone(value: string | null | undefined) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const phone = toSmsE164(raw)
  if ('e164' in phone) return phone.e164
  return raw.startsWith('+') ? raw : /^\d+$/.test(raw) ? `+${raw}` : raw
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

function StatusPill({ status }: { status: MonitorStatus }) {
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

export default function SmsDeliveryMonitor() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [messages, setMessages] = useState<SmsMessage[]>([])
  const [kpis, setKpis] = useState({ pending: 0, sent: 0, delivered: 0, failed: 0, total: 0 })
  const [search, setSearch] = useState('')
  const [statusTab, setStatusTab] = useState<'all' | MonitorStatus>('all')
  const [eventFilter, setEventFilter] = useState('all')
  const [selected, setSelected] = useState<SmsMessage | null>(null)
  const [editing, setEditing] = useState<SmsMessage | null>(null)
  const [editPhone, setEditPhone] = useState('')
  const [editMessage, setEditMessage] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [checkPhone, setCheckPhone] = useState('')
  const [checkMessage, setCheckMessage] = useState('')
  const [sendingCheck, setSendingCheck] = useState(false)
  const [checkResult, setCheckResult] = useState<string | null>(null)
  const sendingCheckRef = useRef(false)
  const [refreshingStatus, setRefreshingStatus] = useState(false)
  const [statusRefreshInfo, setStatusRefreshInfo] = useState<string | null>(null)

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/settings/notifications/sms-activity')
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Failed to load SMS activity')
      setMessages(result.messages || [])
      setKpis(result.kpis || { pending: 0, sent: 0, delivered: 0, failed: 0, total: 0 })
    } catch (err: any) {
      setError(err.message || 'Failed to load SMS activity')
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [])

  // Explicit, on-demand "ask the gateway now" action. Separate from load() on purpose:
  // this is the only action that talks to the local SMS gateway, and it's guarded by a
  // client-side abort timeout so a dead gateway can never freeze this button -- the server
  // side has its own bounded budget too (see refresh-status/route.ts), this is just a
  // second, independent safety net.
  const refreshGatewayStatus = async () => {
    if (refreshingStatus) return
    setRefreshingStatus(true)
    setStatusRefreshInfo(null)
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch('/api/settings/notifications/sms-activity/refresh-status', {
        method: 'POST',
        signal: controller.signal,
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Failed to check gateway status')
      const { checked = 0, updated = 0, timedOut = false } = result
      setStatusRefreshInfo(
        timedOut
          ? `Gateway is slow to respond: checked ${checked}, updated ${updated} before timing out. Remaining messages will update on the next automatic check.`
          : `Checked ${checked} message(s), updated ${updated}.`,
      )
    } catch (err: any) {
      setStatusRefreshInfo(
        err?.name === 'AbortError'
          ? 'Gateway did not respond in time. Nothing on this page was blocked -- try again in a moment.'
          : (err.message || 'Failed to check gateway status'),
      )
    } finally {
      clearTimeout(abortTimer)
      setRefreshingStatus(false)
      void load({ silent: true })
    }
  }

  const sendCheckSms = async () => {
    const to = checkPhone.trim()
    const message = checkMessage.trim()
    if (!to) {
      setCheckResult('Enter a phone number first')
      return
    }
    if (!message) {
      setCheckResult('Enter the SMS message first')
      return
    }
    if (sendingCheckRef.current) return
    sendingCheckRef.current = true
    setSendingCheck(true)
    setCheckResult(null)
    try {
      const response = await fetch('/api/notifications/sms-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, message }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'SMS check failed')
      setCheckResult(`Sent to ${result.to}. Event: ${result.event_code}`)
      await load()
    } catch (err: any) {
      setCheckResult(err.message || 'SMS check failed')
    } finally {
      sendingCheckRef.current = false
      setSendingCheck(false)
    }
  }

  const openEdit = (row: SmsMessage) => {
    setSelected(null)
    setEditing(row)
    setEditPhone(formatSmsPhone(row.phone) || row.phone || '')
    setEditMessage(row.messageBody || '')
    setEditError(null)
  }

  const saveEdit = async (send: boolean) => {
    if (!editing) return
    const phone = editPhone.trim()
    const message = editMessage.trim()
    if (!phone) {
      setEditError('Enter a phone number')
      return
    }
    if (send && !message) {
      setEditError('Enter the SMS message text to send')
      return
    }
    setSavingEdit(true)
    setEditError(null)
    try {
      const response = await fetch('/api/settings/notifications/sms-activity', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editing.id,
          source: editing.source,
          outboxId: editing.outboxId,
          eventCode: editing.eventCode,
          phone,
          message,
          send,
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Failed to save SMS')
      setEditing(null)
      await load()
    } catch (err: any) {
      setEditError(err.message || 'Failed to save SMS')
    } finally {
      setSavingEdit(false)
    }
  }

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch('/api/notifications/sms-check')
        const result = await response.json().catch(() => ({}))
        if (!response.ok || cancelled) return
        const message = String(result.message || '').trim()
        if (message) setCheckMessage(message)
      } catch {
        /* Server still resolves the saved Notification Types template on send. */
      }
    })()
    return () => { cancelled = true }
  }, [])

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
        row.phone,
        formatSmsPhone(row.phone),
        row.orgName,
        row.orderNo,
        row.orderId,
        row.eventCode,
        row.providerName,
        row.providerMessageId,
        row.errorMessage,
        row.rawStatus,
        row.messageBody,
      ].some((value) => String(value || '').toLowerCase().includes(query))
    })
  }, [messages, search, statusTab, eventFilter])

  const exportCsv = () => {
    const header = ['Time', 'Phone', 'Organization', 'Order', 'Event', 'Status', 'Provider', 'Message ID', 'Error', 'Retries']
    const rows = filtered.map((row) => [
      formatTime(row.createdAt),
      formatSmsPhone(row.phone) || row.phone || '',
      row.orgName || '',
      formatOrder(row),
      row.eventCode || '',
      row.status,
      row.providerName || '',
      row.providerMessageId || '',
      row.errorMessage || '',
      String(row.retryCount),
    ])
    const csv = [header, ...rows].map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `sms-delivery-${new Date().toISOString().slice(0, 10)}.csv`
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
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
            <MessageSquare className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Notification Monitor</h1>
            <p className="mt-0.5 max-w-2xl text-sm text-slate-500">
              Track every SMS sent through the Local Malaysian gateway. A successful send is Sent until the gateway reports Delivered or Failed.
            </p>
            <div className="mt-3">
              <NotificationChannelSwitch active="sms" />
            </div>
          </div>
        </div>
          <div className="flex flex-col items-stretch gap-2 sm:items-end">
            <form
              className="flex flex-col items-stretch gap-2 sm:items-end"
              onSubmit={(event) => {
                event.preventDefault()
                void sendCheckSms()
              }}
            >
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Phone e.g. 0123456789"
                  value={checkPhone}
                  onChange={(event) => setCheckPhone(event.target.value)}
                  className="h-9 w-[190px]"
                />
                <Button type="submit" size="sm" disabled={sendingCheck}>
                  {sendingCheck ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                  Send check SMS
                </Button>
              </div>
              <Textarea
                placeholder="SMS check message"
                value={checkMessage}
                onChange={(event) => setCheckMessage(event.target.value)}
                className="min-h-[72px] w-full sm:w-[420px] text-sm"
              />
            </form>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void refreshGatewayStatus()}
              disabled={refreshingStatus}
              title="Ask the local SMS gateway for the latest delivery status of open messages"
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshingStatus ? 'animate-spin' : ''}`} />
              Check gateway status
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export
            </Button>
          </div>
          {checkResult ? <p className="max-w-md text-right text-xs text-slate-600">{checkResult}</p> : null}
          {statusRefreshInfo ? <p className="max-w-md text-right text-xs text-slate-600">{statusRefreshInfo}</p> : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <KpiCard tone="amber" icon={<Clock className="h-4 w-4" />} label="Pending" value={kpis.pending} hint="Queued or retrying" />
        <KpiCard tone="green" icon={<Send className="h-4 w-4" />} label="Sent" value={kpis.sent} hint="Accepted, waiting on delivery" />
        <KpiCard tone="blue" icon={<CheckCheck className="h-4 w-4" />} label="Delivered" value={kpis.delivered} hint="Final success" />
        <KpiCard tone="red" icon={<AlertCircle className="h-4 w-4" />} label="Failed" value={kpis.failed} hint="Final failure" />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Search phone, order, event, message ID, or error..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 pl-8"
            />
          </div>
          <Select value={eventFilter} onValueChange={setEventFilter}>
            <SelectTrigger className="h-9 w-[190px]"><SelectValue placeholder="All events" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {eventOptions.map((code) => (
                <SelectItem key={code} value={code}>{formatEvent(code)}</SelectItem>
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
            <Loader2 className="h-4 w-4 animate-spin" />Loading SMS messages...
          </div>
        ) : error ? (
          <div className="py-8 text-center text-sm text-red-600">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="py-10 text-center text-slate-400">
            <MessageSquare className="mx-auto mb-2 h-8 w-8 text-slate-300" />
            <p className="text-sm">No SMS messages in this view</p>
            <p className="mt-0.5 text-xs">Use Send check SMS above, then click Refresh. Sent means the gateway accepted it. Delivered and Failed are final.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left">
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Time</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Phone</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Organization</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Order</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Event</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Status</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Provider</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Message ID</th>
                  <th className="px-2 py-2 text-xs font-medium text-slate-500">Error</th>
                  <th className="px-2 py-2 text-right text-xs font-medium text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((row) => (
                  <tr key={`${row.source}-${row.id}`} className="hover:bg-slate-50/60">
                    <td className="px-2 py-2.5 align-top text-xs text-slate-600">{formatTime(row.createdAt)}</td>
                    <td className="px-2 py-2.5 align-top font-mono text-xs text-slate-800">{formatSmsPhone(row.phone) || row.phone || '-'}</td>
                    <td className="px-2 py-2.5 align-top text-xs text-slate-600">{row.orgName || '-'}</td>
                    <td className="px-2 py-2.5 align-top">
                      {formatOrder(row) ? (
                        <div className="font-mono text-xs text-slate-800" title={row.orderId || undefined}>{formatOrder(row)}</div>
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 align-top text-xs capitalize text-slate-600">{formatEvent(row.eventCode)}</td>
                    <td className="px-2 py-2.5 align-top">
                      <StatusPill status={row.status} />
                      {row.rawStatus && row.rawStatus !== row.status ? (
                        <div className="mt-0.5 text-[10px] text-slate-400">{row.rawStatus}</div>
                      ) : null}
                    </td>
                    <td className="px-2 py-2.5 align-top text-xs text-slate-500">{row.providerName || '-'}</td>
                    <td className="px-2 py-2.5 align-top font-mono text-[11px] text-slate-500">{row.providerMessageId || '-'}</td>
                    <td className="px-2 py-2.5 align-top">
                      {row.errorMessage ? (
                        <div className="max-w-[220px] truncate text-[11px] text-red-600" title={row.errorMessage}>{row.errorMessage}</div>
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-right align-top">
                      <div className="inline-flex items-center gap-0.5">
                        <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit" onClick={() => openEdit(row)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" title="Details" onClick={() => setSelected(row)}>
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      </div>
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
            <DialogTitle>SMS message details</DialogTitle>
            <DialogDescription>Full delivery record for this SMS.</DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <StatusPill status={selected.status} />
                <Badge variant="secondary">{selected.providerName || 'local_my'}</Badge>
              </div>
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 px-3">
                <DetailRow label="Phone" value={formatSmsPhone(selected.phone) || selected.phone} />
                <DetailRow label="Organization" value={selected.orgName} />
                <DetailRow label="Order" value={formatOrder(selected) || '-'} />
                {selected.orderId && selected.orderNo ? <DetailRow label="Order ID" value={selected.orderId} /> : null}
                <DetailRow label="Message" value={selected.messageBody} />
                <DetailRow label="Event" value={formatEvent(selected.eventCode)} />
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
                <DetailRow label="Error code" value={selected.errorCode} />
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
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Gateway response</p>
                  <pre className="max-h-48 overflow-auto rounded-md bg-slate-50 p-3 text-[11px] text-slate-700">{JSON.stringify(selected.providerResponse, null, 2)}</pre>
                </div>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => openEdit(selected)}>
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit this SMS
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open && !savingEdit) setEditing(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit SMS</DialogTitle>
            <DialogDescription>
              Change the phone number and message for this row. Save keeps the record. Save & send sends it now through the Local Malaysian gateway.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <StatusPill status={editing.status} />
                <span className="text-xs capitalize text-slate-500">{formatEvent(editing.eventCode)}</span>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sms-edit-phone">Phone</Label>
                <Input
                  id="sms-edit-phone"
                  value={editPhone}
                  onChange={(event) => setEditPhone(event.target.value)}
                  placeholder="0123456789 or +60123456789"
                  disabled={savingEdit}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sms-edit-message">Message</Label>
                <Textarea
                  id="sms-edit-message"
                  value={editMessage}
                  onChange={(event) => setEditMessage(event.target.value)}
                  placeholder={editing.messageBody ? '' : 'Original body was not stored. Enter the text to send.'}
                  rows={6}
                  disabled={savingEdit}
                />
              </div>
              {editError ? <p className="text-sm text-red-600">{editError}</p> : null}
              <DialogFooter>
                <Button variant="outline" onClick={() => setEditing(null)} disabled={savingEdit}>
                  Cancel
                </Button>
                <Button variant="secondary" onClick={() => saveEdit(false)} disabled={savingEdit}>
                  {savingEdit ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                  Save
                </Button>
                <Button onClick={() => saveEdit(true)} disabled={savingEdit}>
                  {savingEdit ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                  Save & send
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
