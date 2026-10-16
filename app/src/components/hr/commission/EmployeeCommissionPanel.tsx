'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { AlertTriangle, Check, Clock, Loader2, Percent, Plus, ShieldCheck, X } from 'lucide-react'
import { commissionApi, useCommissionAccess } from '@/lib/hr/commission/use-commission-access'
import { formatRate, formatRM } from '@/lib/hr/commission/report'

interface Rule { id: string; business_unit_id: string; rate_percent: string; effective_from: string; effective_to: string | null; change_reason: string; requested_by: string | null; approved_by: string | null; approved_at: string; ended_by: string | null; end_reason: string | null }
interface RuleRequest { id: string; kind: 'set_rate' | 'end_rule'; business_unit_id: string | null; rate_percent: string | null; effective_from: string | null; effective_to: string | null; target_rule_id: string | null; reason: string; status: string; requested_by: string; requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null }
interface BusinessUnit { id: string; code: string; name: string; is_active: boolean }

const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

function ruleState(rule: Rule): { label: string; tone: string } {
  const t = today()
  if (rule.effective_from > t) return { label: 'Scheduled', tone: 'bg-sky-50 text-sky-700' }
  if (rule.effective_to && rule.effective_to < t) return { label: 'Ended', tone: 'bg-gray-100 text-gray-600' }
  return { label: 'Active', tone: 'bg-emerald-50 text-emerald-700' }
}

/**
 * HR → Employees → employee profile → Sales Commission. Rates are effective-dated per Business Unit and only take
 * effect once another person approves them; eligibility changes need a reason. Everything is re-checked server-side.
 */
export default function EmployeeCommissionPanel({ userId, employeeName }: { userId: string; employeeName: string }) {
  const { toast } = useToast()
  const { can, loaded } = useCommissionAccess()
  const canView = can('hr.commission.view')
  const canManage = can('hr.commission.manage')
  const canApprove = can('hr.commission.approve')
  const [data, setData] = useState<any>(null)
  const [units, setUnits] = useState<BusinessUnit[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ businessUnitId: '', ratePercent: '', effectiveFrom: today(), effectiveTo: '', reason: '' })
  const [eligibilityReason, setEligibilityReason] = useState('')
  const [pendingEligible, setPendingEligible] = useState<boolean | null>(null)
  const [endFor, setEndFor] = useState<{ ruleId: string; effectiveTo: string; reason: string } | null>(null)
  const [decision, setDecision] = useState<{ id: string; note: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [emp, ref] = await Promise.all([
        commissionApi(`/api/hr/commission/employees/${userId}`),
        commissionApi('/api/hr/commission/reference'),
      ])
      setData(emp)
      setUnits(ref.businessUnits ?? [])
    } catch (e: any) {
      toast({ title: 'Sales commission unavailable', description: e.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [userId, toast])

  useEffect(() => { if (loaded && canView) load(); else if (loaded) setLoading(false) }, [loaded, canView, load])

  const buName = useMemo(() => new Map(units.map((u) => [u.id, u.name])), [units])
  const name = (id: string | null | undefined) => (id ? data?.names?.[id] ?? 'Unknown user' : '—')

  const act = async (body: Record<string, unknown>, success: string) => {
    setBusy(true)
    try {
      await commissionApi(`/api/hr/commission/employees/${userId}`, { method: 'POST', json: body })
      toast({ title: success })
      await load()
      return true
    } catch (e: any) {
      toast({ title: 'Not saved', description: e.message, variant: 'destructive' })
      return false
    } finally {
      setBusy(false)
    }
  }
  const decide = async (id: string, approve: boolean, note: string) => {
    setBusy(true)
    try {
      await commissionApi('/api/hr/commission/requests', { method: 'POST', json: { kind: 'rate', id, approve, note } })
      toast({ title: approve ? 'Rate change approved' : 'Rate change rejected' })
      setDecision(null)
      await load()
    } catch (e: any) {
      toast({ title: 'Not saved', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  if (!loaded || loading) return <div className="py-10 text-center text-sm text-gray-500"><Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />Loading sales commission…</div>
  if (!canView) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-gray-500">
        <ShieldCheck className="mx-auto mb-2 h-5 w-5" />Sales commission is visible only to people granted commission access.
      </div>
    )
  }
  if (!data?.employee) {
    return <div className="rounded-lg border border-dashed p-6 text-center text-sm text-gray-500">{employeeName} has no HR employee record in this company.</div>
  }

  const onboarded = data.employee.onboardingStatus === 'completed'
  const eligible: boolean = data.profile?.is_eligible === true
  const rules: Rule[] = data.rules ?? []
  const requests: RuleRequest[] = data.requests ?? []
  const pending = requests.filter((r) => r.status === 'pending')
  const history = requests.filter((r) => r.status !== 'pending')
  const activeUnits = units.filter((u) => u.is_active)

  return (
    <div className="space-y-5">
      {!onboarded && (
        <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />Complete HR onboarding before setting up commission.
        </div>
      )}

      {/* Eligibility */}
      <section className="rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Commission eligible</p>
            <p className="text-xs text-gray-500">
              {data.profile ? `Last changed by ${name(data.profile.updated_by)} on ${new Date(data.profile.updated_at).toLocaleDateString('en-MY')}` : 'Not set up'}
            </p>
          </div>
          <Switch
            checked={pendingEligible ?? eligible}
            disabled={!canManage || !onboarded || busy}
            onCheckedChange={(v) => { setPendingEligible(v === eligible ? null : v); setEligibilityReason('') }}
            aria-label="Commission eligible"
          />
        </div>
        {pendingEligible !== null && (
          <div className="mt-3 space-y-2">
            <Label className="text-xs">Change reason</Label>
            <Input className="h-9" value={eligibilityReason} onChange={(e) => setEligibilityReason(e.target.value)} placeholder="e.g. Joined the sales team" />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPendingEligible(null)}>Cancel</Button>
              <Button size="sm" disabled={busy || eligibilityReason.trim().length < 5}
                onClick={async () => { if (await act({ action: 'eligibility', isEligible: pendingEligible, reason: eligibilityReason }, 'Eligibility updated')) setPendingEligible(null) }}>
                Save
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Rates */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Commission rates by Business Unit</p>
          {!eligible && rules.length > 0 && <Badge variant="secondary" className="bg-amber-50 text-amber-700">Not eligible — rates not applied</Badge>}
        </div>
        {rules.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-xs text-gray-500">No approved rates.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {rules.map((rule) => {
              const state = ruleState(rule)
              return (
                <div key={rule.id} className="space-y-1 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{buName.get(rule.business_unit_id) ?? 'Business Unit'}</span>
                      <span className="font-mono text-sm">{formatRate(Number(rule.rate_percent))}</span>
                      <Badge variant="secondary" className={`border-0 ${state.tone}`}>{state.label}</Badge>
                    </div>
                    {canManage && state.label !== 'Ended' && !rule.effective_to && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEndFor({ ruleId: rule.id, effectiveTo: today(), reason: '' })}>End rate…</Button>
                    )}
                  </div>
                  <p className="text-gray-500">{rule.effective_from} → {rule.effective_to ?? 'until changed'} · {rule.change_reason}</p>
                  <p className="text-gray-400">Requested by {name(rule.requested_by)} · approved by {name(rule.approved_by)}{rule.ended_by ? ` · ended by ${name(rule.ended_by)}` : ''}{rule.end_reason ? ` (${rule.end_reason})` : ''}</p>
                  {endFor?.ruleId === rule.id && (
                    <div className="mt-2 grid gap-2 rounded-md bg-gray-50 p-2 sm:grid-cols-[150px_1fr_auto]">
                      <Input type="date" className="h-8" value={endFor.effectiveTo} onChange={(e) => setEndFor({ ...endFor, effectiveTo: e.target.value })} />
                      <Input className="h-8" placeholder="Reason" value={endFor.reason} onChange={(e) => setEndFor({ ...endFor, reason: e.target.value })} />
                      <div className="flex gap-1">
                        <Button size="sm" className="h-8" disabled={busy || endFor.reason.trim().length < 5}
                          onClick={async () => { if (await act({ action: 'request_end', ...endFor }, 'End of rate submitted for approval')) setEndFor(null) }}>Submit</Button>
                        <Button size="sm" variant="ghost" className="h-8" onClick={() => setEndFor(null)}><X className="h-3.5 w-3.5" /></Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* New rate */}
      {canManage && onboarded && (
        <section className="space-y-3 rounded-lg border p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium"><Plus className="h-4 w-4" />Request a rate change</p>
          {activeUnits.length === 0 ? (
            <p className="text-xs text-gray-500">Create Business Units first (HR → Payroll → Commission Settings).</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">Business Unit</Label>
                  <Select value={form.businessUnitId} onValueChange={(v) => setForm({ ...form, businessUnitId: v })}>
                    <SelectTrigger className="h-9"><SelectValue placeholder="Choose" /></SelectTrigger>
                    <SelectContent>{activeUnits.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Commission rate (%)</Label>
                  <div className="relative">
                    <Input className="h-9 pr-8 font-mono" inputMode="decimal" placeholder="0.120" value={form.ratePercent}
                      onChange={(e) => setForm({ ...form, ratePercent: e.target.value.replace(/[^0-9.]/g, '') })} />
                    <Percent className="absolute right-2.5 top-2.5 h-4 w-4 text-gray-400" />
                  </div>
                  <p className="text-[10px] text-gray-500">Up to 5 decimals, e.g. 0.010, 0.120, 0.22780.</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Effective from</Label>
                  <Input type="date" className="h-9" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Effective to (optional)</Label>
                  <Input type="date" className="h-9" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Change reason</Label>
                <Textarea rows={2} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Annual review 2027" />
              </div>
              <p className="text-[11px] text-gray-500">A current open-ended rate for the same Business Unit ends the day before the new rate starts. The change takes effect only after a different authorised person approves it.</p>
              <div className="flex justify-end">
                <Button size="sm" disabled={busy || !form.businessUnitId || !/^\d{1,3}(\.\d{1,5})?$/.test(form.ratePercent) || form.reason.trim().length < 5}
                  onClick={async () => {
                    if (await act({ action: 'request_rate', ...form, effectiveTo: form.effectiveTo || null }, 'Rate change submitted for approval')) {
                      setForm({ businessUnitId: '', ratePercent: '', effectiveFrom: today(), effectiveTo: '', reason: '' })
                    }
                  }}>
                  {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}Submit for approval
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {/* Pending */}
      {pending.length > 0 && (
        <section className="space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-medium"><Clock className="h-4 w-4" />Awaiting approval</p>
          <div className="divide-y rounded-lg border border-amber-200">
            {pending.map((r) => {
              // The database refuses the requester and the employee concerned; hide the control for them too.
              const mine = r.requested_by === data.selfUserId || userId === data.selfUserId
              return (
                <div key={r.id} className="space-y-1 p-3 text-xs">
                  <p className="text-sm">
                    {r.kind === 'set_rate'
                      ? <>{buName.get(r.business_unit_id ?? '') ?? 'Business Unit'} <span className="font-mono">{formatRate(Number(r.rate_percent))}</span> from {r.effective_from}{r.effective_to ? ` to ${r.effective_to}` : ''}</>
                      : <>End rate on {r.effective_to}</>}
                  </p>
                  <p className="text-gray-500">{r.reason} · requested by {name(r.requested_by)} on {new Date(r.requested_at).toLocaleDateString('en-MY')}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {canApprove && !mine && (
                      decision?.id === r.id ? (
                        <div className="flex w-full flex-wrap items-center gap-2">
                          <Input className="h-8 flex-1" placeholder="Note (required to reject)" value={decision.note} onChange={(e) => setDecision({ id: r.id, note: e.target.value })} />
                          <Button size="sm" className="h-8" disabled={busy} onClick={() => decide(r.id, true, decision.note)}><Check className="mr-1 h-3.5 w-3.5" />Approve</Button>
                          <Button size="sm" variant="outline" className="h-8" disabled={busy || decision.note.trim().length < 5} onClick={() => decide(r.id, false, decision.note)}>Reject</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setDecision({ id: r.id, note: '' })}>Review…</Button>
                      )
                    )}
                    {canManage && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => act({ action: 'cancel_request', requestId: r.id }, 'Request cancelled')}>Cancel request</Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* History */}
      {history.length > 0 && (
        <section className="space-y-2">
          <p className="text-sm font-medium">Rate change history</p>
          <div className="divide-y rounded-lg border text-xs">
            {history.map((r) => (
              <div key={r.id} className="flex flex-wrap items-start justify-between gap-2 p-3">
                <div>
                  <p>{r.kind === 'set_rate' ? `${buName.get(r.business_unit_id ?? '') ?? 'Business Unit'} ${formatRate(Number(r.rate_percent))} from ${r.effective_from}` : `End rate on ${r.effective_to}`}</p>
                  <p className="text-gray-500">{r.reason} · by {name(r.requested_by)}{r.decided_by ? ` · decided by ${name(r.decided_by)}` : ''}{r.decision_note ? ` — ${r.decision_note}` : ''}</p>
                </div>
                <Badge variant="secondary" className={`border-0 ${r.status === 'approved' ? 'bg-emerald-50 text-emerald-700' : r.status === 'rejected' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'}`}>{r.status}</Badge>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent commission */}
      {(data.recentItems ?? []).length > 0 && (
        <section className="space-y-2">
          <p className="text-sm font-medium">Recent commission</p>
          <div className="divide-y rounded-lg border text-xs">
            {data.recentItems.map((i: any, idx: number) => (
              <div key={idx} className="flex justify-between gap-2 p-2.5">
                <span>{i.hr_commission_cycles?.label ?? i.cycle_id} · {i.business_unit_name} · {formatRate(Number(i.rate_percent))}</span>
                <span className="font-medium">{formatRM(Number(i.commission_amount))}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
