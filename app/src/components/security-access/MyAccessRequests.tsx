'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { callApi, formatDate, toIso } from './client-api'

interface Options {
  memberships: Array<{ organizationId: string; organizationName: string; heldRoleIds: string[] }>
  scopes: Array<{ id: string; organization_id: string; membership_organization_id?: string; scope_type: string; display_name: string; kind?: string; label?: string; coverage?: string }>
  roles: Array<{ id: string; name: string; description: string | null }>
}

const EMPTY = { organizationId: '', roleId: '', scopeId: '', until: '', reason: '' }
const STATUS_TONE: Record<string, string> = {
  requested: 'bg-amber-50 text-amber-800', approved: 'bg-emerald-50 text-emerald-700',
  denied: 'bg-red-50 text-red-700', cancelled: 'bg-gray-100 text-gray-600', expired: 'bg-gray-100 text-gray-600',
}

/**
 * Self-service access requests for any business member: ask for a business
 * role (optionally temporary) and follow its decision. Approval happens in
 * Security & Access → Governance; requesters can never approve their own.
 */
export default function MyAccessRequests() {
  const [options, setOptions] = useState<Options | null>(null)
  const [requests, setRequests] = useState<any[]>([])
  const [form, setForm] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const load = useCallback(async () => {
    const [opts, list] = await Promise.all([
      callApi<Options>('/api/security-access/me/request-options'),
      callApi<{ requests: any[] }>('/api/security-access/access-requests'),
    ])
    if (opts.ok && opts.data) {
      setOptions(opts.data)
      const only = opts.data.memberships.length === 1 ? opts.data.memberships[0].organizationId : ''
      setForm(f => (f.organizationId ? f : { ...f, organizationId: only }))
    }
    if (list.ok) setRequests(list.data?.requests || [])
  }, [])
  useEffect(() => { load() }, [load])

  const roleName = useMemo(() => new Map((options?.roles || []).map(r => [r.id, r.name])), [options])
  const membership = options?.memberships.find(m => m.organizationId === form.organizationId)
  const roleOptions = (options?.roles || []).filter(r => !membership?.heldRoleIds.includes(r.id))
  const scopeOptions = (options?.scopes || []).filter(s => (s.membership_organization_id ?? s.organization_id) === form.organizationId)
  const valid = Boolean(membership && roleOptions.some(r => r.id === form.roleId) && scopeOptions.some(s => s.id === form.scopeId) && form.reason.trim().length >= 10)

  // Not a business member (consumer, or not yet onboarded): nothing to request.
  if (options && options.memberships.length === 0) return null

  async function submit() {
    if (!valid) return
    setBusy(true); setMessage(null)
    const result = await callApi('/api/security-access/access-requests', { body: {
      action: 'submit', roleId: form.roleId, organizationId: form.organizationId, scopeIds: [form.scopeId],
      effectiveUntil: toIso(form.until), reason: form.reason.trim(),
    } })
    setBusy(false)
    if (!result.ok) { setMessage({ tone: 'error', text: result.error || 'Unable to submit the request' }); return }
    setMessage({ tone: 'ok', text: 'Request submitted. A Security & Access approver will decide it.' })
    setForm({ ...EMPTY, organizationId: form.organizationId })
    load()
  }

  async function cancel(id: string) {
    const result = await callApi('/api/security-access/access-requests', { body: { action: 'cancel', requestId: id } })
    setMessage(result.ok ? { tone: 'ok', text: 'Request cancelled.' } : { tone: 'error', text: result.error || 'Unable to cancel' })
    if (result.ok) load()
  }

  const field = 'mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm'
  return (
    <Card className="sera-sc-panel overflow-hidden border-[var(--sera-line)] shadow-none">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" aria-hidden />Request access</CardTitle>
        <CardDescription>Ask for a Group Policy you need for your work. An approver in Security &amp; Access decides; you cannot approve your own request.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!options ? <p className="text-sm text-gray-500">Loading…</p> : <>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm"><span className="text-gray-600">Organization</span>
              <select aria-label="Organization" className={field} value={form.organizationId} onChange={e => setForm({ ...form, organizationId: e.target.value, roleId: '', scopeId: '' })}>
                <option value="">Choose an organization</option>
                {options.memberships.map(m => <option key={m.organizationId} value={m.organizationId}>{m.organizationName}</option>)}
              </select></label>
            <label className="text-sm"><span className="text-gray-600">Group Policy</span>
              <select aria-label="Group Policy" className={field} value={form.roleId} onChange={e => setForm({ ...form, roleId: e.target.value })} disabled={!form.organizationId}>
                <option value="">{roleOptions.length ? 'Choose a policy' : 'No other policies to request'}</option>
                {roleOptions.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select></label>
            <label className="text-sm"><span className="text-gray-600">Scope</span>
              <select aria-label="Scope" className={field} value={form.scopeId} onChange={e => setForm({ ...form, scopeId: e.target.value })} disabled={!form.organizationId}>
                <option value="">Choose a scope</option>
                {scopeOptions.map(s => <option key={s.id} value={s.id}>{s.label ?? `${s.display_name} (${s.scope_type.replace(/_/g, ' ')})`}</option>)}
              </select>
              {scopeOptions.find(s => s.id === form.scopeId)?.coverage && <span role="note" className="mt-1 block text-xs text-gray-700">Coverage: {scopeOptions.find(s => s.id === form.scopeId)?.coverage}</span>}</label>
            <label className="text-sm"><span className="text-gray-600">Needed until (optional — temporary access)</span>
              <input aria-label="Needed until" type="datetime-local" className={field} value={form.until} onChange={e => setForm({ ...form, until: e.target.value })} /></label>
            <label className="text-sm md:col-span-2"><span className="text-gray-600">Reason (at least 10 characters)</span>
              <input aria-label="Reason" className={field} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="Why do you need this access?" /></label>
          </div>
          <button type="button" onClick={submit} disabled={busy || !valid}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">Submit request</button>
          {message && <div role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{message.text}</div>}
          {requests.length > 0 && <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-800">My requests</h3>
            <ul className="divide-y rounded-lg border">
              {requests.map(r => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="font-medium text-gray-900">{roleName.get(r.role_id) || 'Business role'}</div>
                  <div className="text-xs text-gray-500">Requested {formatDate(r.created_at)}{r.effective_until ? ` · until ${formatDate(r.effective_until)}` : ''}{r.decision_reason ? ` · “${r.decision_reason}”` : ''}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[r.status] || 'bg-gray-100 text-gray-600'}`}>{r.status}</span>
                  {r.status === 'requested' && <button type="button" onClick={() => cancel(r.id)} className="rounded-md border px-2 py-1 text-xs text-gray-600">Cancel</button>}
                </div>
              </li>)}
            </ul>
          </div>}
        </>}
      </CardContent>
    </Card>
  )
}
