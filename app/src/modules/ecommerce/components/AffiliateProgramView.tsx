'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import SupplyChainPageHeader from '@/modules/supply-chain/components/SupplyChainPageHeader'
import {
  AFFILIATE_STATUS_LABELS,
  COMMISSION_STATUS_LABELS,
  type AffiliateCommissionStatus,
  type AffiliateProgramSettings,
  type AffiliateStatus,
} from '@/lib/affiliate/program'

type Balance = { pending: number; confirmed: number; paid: number; orders: number }
type Affiliate = {
  id: string
  code: string
  name: string
  source: 'self' | 'staff'
  status: AffiliateStatus
  isActive: boolean
  commissionMode: 'program' | 'custom'
  commissionPercent: number
  email: string
  phone: string
  hasBankAccount: boolean
  bankName: string
  bankAccountNo: string
  bankAccountName: string
  notes: string
  reviewNote: string
  appliedAt: string
  balance: Balance
}
type Commission = {
  id: string
  affiliateId: string
  orderRef: string
  channel: 'store' | 'outdoor'
  subId: string
  goods: number
  percent: number
  amount: number
  status: AffiliateCommissionStatus
  orderedAt: string
  deliveredAt: string | null
}
type Payout = {
  id: string
  affiliateId: string
  amount: number
  count: number
  bankName: string
  bankAccountNo: string
  bankAccountName: string
  reference: string
  notes: string
  paidAt: string
}
type Data = {
  canManageProgram: boolean
  canRecordPayout: boolean
  settings: AffiliateProgramSettings
  affiliates: Affiliate[]
  commissions: Commission[]
  payouts: Payout[]
  categories: Array<{ id: string; name: string }>
  products: Array<{ id: string; name: string; isVape: boolean; categoryId: string | null }>
}

type Section = 'affiliates' | 'commissions' | 'payouts' | 'settings'

const inputClass = 'text-sm border border-[var(--sera-line)] rounded-lg bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/25 text-[var(--sera-ink)]'
const buttonClass = 'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-[var(--sera-line)] rounded-lg bg-white hover:bg-[var(--sera-mist)] transition-colors disabled:opacity-50 text-[var(--sera-ink)]'
const primaryClass = 'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[var(--sera-orange,#f97316)] text-white hover:opacity-90 transition-opacity disabled:opacity-50'

function rm(value: number) {
  return `RM ${(Number(value) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function day(iso: string | null) {
  const at = Date.parse(String(iso || ''))
  return Number.isFinite(at) ? new Date(at).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
}

function Table({ head, rows, empty }: { head: { label: string; right?: boolean }[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <div className="sera-sc-panel p-8 text-center text-sm text-[var(--sera-muted)]">{empty}</div>
  return (
    <div className="bg-card border border-border rounded-xl overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-accent/30">
            {head.map((h) => (
              <th key={h.label} className={`${h.right ? 'text-right' : 'text-left'} px-4 py-3 font-medium text-muted-foreground whitespace-nowrap`}>{h.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((cells, i) => (
            <tr key={i} className="hover:bg-accent/20 align-top">
              {cells.map((c, j) => (
                <td key={j} className={`px-4 py-2.5 ${head[j]?.right ? 'text-right tabular-nums whitespace-nowrap' : ''}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatusBadge({ status }: { status: AffiliateStatus }) {
  const tone: Record<AffiliateStatus, string> = {
    pending: 'bg-amber-50 text-amber-800 border-amber-200',
    approved: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    rejected: 'bg-gray-50 text-gray-600 border-gray-200',
    suspended: 'bg-red-50 text-red-700 border-red-200',
  }
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${tone[status]}`}>{AFFILIATE_STATUS_LABELS[status]}</span>
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="sera-sc-panel p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--sera-ink)]">{title}</h2>
        {hint ? <p className="mt-0.5 text-xs text-[var(--sera-muted)]">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--sera-ink)]">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-[var(--sera-muted)]">{hint}</span> : null}
    </label>
  )
}

type SettingsForm = {
  enabled: boolean
  joinMode: 'open' | 'approval'
  commissionPercent: string
  attributionDays: string
  confirmAfterDays: string
  minPayoutAmount: string
  excludeVape: boolean
  excludedCategoryIds: string[]
  excludedProductIds: string[]
  terms: string
}

function formFromSettings(s: AffiliateProgramSettings): SettingsForm {
  return {
    enabled: s.enabled,
    joinMode: s.joinMode,
    commissionPercent: s.commissionPercent == null ? '' : String(s.commissionPercent),
    attributionDays: String(s.attributionDays),
    confirmAfterDays: String(s.confirmAfterDays),
    minPayoutAmount: String(s.minPayoutAmount),
    excludeVape: s.excludeVape,
    excludedCategoryIds: s.excludedCategoryIds,
    excludedProductIds: s.excludedProductIds,
    terms: s.terms,
  }
}

function toggle(list: string[], id: string, on: boolean) {
  return on ? [...new Set([...list, id])] : list.filter((x) => x !== id)
}

export default function AffiliateProgramView() {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('affiliates')
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [editing, setEditing] = useState<{ id: string; mode: 'program' | 'custom'; percent: string; notes: string } | null>(null)
  const [payRef, setPayRef] = useState<Record<string, string>>({})
  const [statusFilter, setStatusFilter] = useState<'all' | AffiliateCommissionStatus>('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/affiliates', { cache: 'no-store' })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json) throw new Error(json?.error || 'Could not load affiliates.')
      setData(json)
      setForm(formFromSettings(json.settings))
    } catch (err: any) {
      setError(err.message || 'Could not load affiliates.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const post = async (payload: Record<string, unknown>, done: string) => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/admin/affiliates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || 'Could not save.')
      setResult(done)
      await load()
      return true
    } catch (err: any) {
      setError(err.message || 'Could not save.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const affiliateName = useMemo(() => {
    const names = new Map((data?.affiliates || []).map((a) => [a.id, `${a.name} (${a.code})`]))
    return (id: string) => names.get(id) || '—'
  }, [data])

  const settings = data?.settings
  const programRate = settings?.commissionPercent
  const pendingCount = (data?.affiliates || []).filter((a) => a.status === 'pending').length
  const toPay = (data?.affiliates || []).filter((a) => a.balance.confirmed > 0)
  const commissions = (data?.commissions || []).filter((c) => statusFilter === 'all' || c.status === statusFilter)
  const categoryName = (id: string | null) => data?.categories.find((c) => c.id === id)?.name || ''

  const rateLabel = (a: Affiliate) =>
    a.commissionMode === 'program' ? `Program${programRate != null ? ` (${programRate}%)` : ' (not set)'}` : `Own ${a.commissionPercent}%`

  return (
    <div className="sera-sc-page sera-page-enter w-full max-w-6xl mx-auto">
      <SupplyChainPageHeader
        eyebrow="Customer & Growth"
        title="Affiliates"
        description="People who share Serapod links and earn commission on paid orders"
        actions={
          <button onClick={load} disabled={loading} className={buttonClass}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        }
      />

      {error && (
        <div className="bg-destructive/10 border border-destructive/20 text-destructive rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="underline text-xs shrink-0">Dismiss</button>
        </div>
      )}
      {result && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3">
          <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />{result}</span>
          <button onClick={() => setResult(null)} className="underline text-xs shrink-0">Dismiss</button>
        </div>
      )}

      {settings && !settings.enabled ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          The program is off: shoppers cannot join and links earn no commission.
          {data?.canManageProgram ? <>{' '}Turn it on in{' '}<button onClick={() => setSection('settings')} className="font-medium underline">Settings</button>.</> : null}
        </div>
      ) : null}

      <div role="tablist" aria-label="Affiliate sections" className="flex gap-1 border-b border-[var(--sera-line)] overflow-x-auto overflow-y-hidden">
        {([
          ['affiliates', `Affiliates${pendingCount ? ` (${pendingCount} waiting)` : ''}`],
          ['commissions', 'Commissions'],
          ['payouts', `Payouts${toPay.length ? ` (${toPay.length} to pay)` : ''}`],
          ['settings', 'Settings'],
        ] as const).filter(([value]) => value !== 'settings' || data?.canManageProgram !== false).map(([value, text]) => (
          <button
            key={value}
            role="tab"
            aria-selected={section === value}
            onClick={() => setSection(value)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${section === value
              ? 'border-[var(--sera-orange,#f97316)] text-[var(--sera-ink)]'
              : 'border-transparent text-[var(--sera-muted)] hover:text-[var(--sera-ink)]'}`}
          >
            {text}
          </button>
        ))}
      </div>

      {!data ? (
        loading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : null
      ) : null}

      {data && section === 'affiliates' && (
        <div className="space-y-3">
          <p className="text-xs text-[var(--sera-muted)]">Live hosts are managed in Outdoor › Sales tools and are not listed here.</p>
          <Table
            head={[
              { label: 'Affiliate' },
              { label: 'Contact' },
              { label: 'Status' },
              { label: 'Commission' },
              { label: 'Pending', right: true },
              { label: 'Confirmed', right: true },
              { label: 'Paid', right: true },
              { label: '' },
            ]}
            empty="No affiliates yet."
            rows={[...data.affiliates]
              .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'))
              .map((a) => [
                <div key="n">
                  <div className="font-medium text-[var(--sera-ink)]">{a.name}</div>
                  <div className="text-xs text-[var(--sera-muted)]">{a.code} · joined {day(a.appliedAt)}{a.source === 'staff' ? ' · added by staff' : ''}</div>
                  {a.notes ? <div className="text-xs text-[var(--sera-muted)]">{a.notes}</div> : null}
                  {data.canManageProgram && editing?.id === a.id ? (
                    <div className="mt-2 space-y-2 rounded-lg border border-[var(--sera-line)] bg-[var(--sera-mist)]/40 p-3">
                      <div className="flex flex-wrap gap-3 text-xs">
                        <label className="flex items-center gap-1.5">
                          <input type="radio" checked={editing.mode === 'program'} onChange={() => setEditing({ ...editing, mode: 'program' })} />
                          Program rate
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input type="radio" checked={editing.mode === 'custom'} onChange={() => setEditing({ ...editing, mode: 'custom' })} />
                          Own rate
                        </label>
                        {editing.mode === 'custom' ? (
                          <input className={`${inputClass} w-24`} inputMode="decimal" value={editing.percent}
                            onChange={(e) => setEditing({ ...editing, percent: e.target.value })} placeholder="%" />
                        ) : null}
                      </div>
                      <input className={`${inputClass} w-full`} value={editing.notes} maxLength={500} placeholder="Notes (staff only)"
                        onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
                      <div className="flex gap-2">
                        <button className={primaryClass} disabled={busy}
                          onClick={async () => {
                            if (await post({ action: 'save_affiliate', id: a.id, commissionMode: editing.mode, commissionPercent: editing.percent, notes: editing.notes }, 'Affiliate saved.')) setEditing(null)
                          }}>Save</button>
                        <button className={buttonClass} onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : null}
                </div>,
                <div key="c" className="text-xs">
                  <div>{a.email || '—'}</div>
                  <div className="text-[var(--sera-muted)]">{a.phone || ''}</div>
                </div>,
                <div key="s"><StatusBadge status={a.status} />{a.reviewNote ? <div className="mt-1 text-xs text-[var(--sera-muted)]">{a.reviewNote}</div> : null}</div>,
                <span key="r" className="whitespace-nowrap text-xs">{rateLabel(a)}</span>,
                rm(a.balance.pending),
                rm(a.balance.confirmed),
                rm(a.balance.paid),
                data.canManageProgram ? <div key="a" className="flex flex-wrap justify-end gap-1.5">
                  {a.status === 'pending' ? (
                    <>
                      <button className={primaryClass} disabled={busy} onClick={() => post({ action: 'review', id: a.id, decision: 'approve' }, `${a.name} approved.`)}>Approve</button>
                      <button className={buttonClass} disabled={busy}
                        onClick={() => {
                          const note = window.prompt('Reason shown to the applicant (optional)') ?? null
                          if (note !== null) void post({ action: 'review', id: a.id, decision: 'reject', note }, `${a.name} not approved.`)
                        }}>Reject</button>
                    </>
                  ) : null}
                  {a.status === 'approved' ? (
                    <button className={buttonClass} disabled={busy}
                      onClick={() => {
                        const note = window.prompt(`Suspend ${a.name}? Their link stops earning. Reason (optional):`) ?? null
                        if (note !== null) void post({ action: 'review', id: a.id, decision: 'suspend', note }, `${a.name} suspended.`)
                      }}>Suspend</button>
                  ) : null}
                  {a.status === 'suspended' || a.status === 'rejected' ? (
                    <button className={buttonClass} disabled={busy} onClick={() => post({ action: 'review', id: a.id, decision: 'reactivate' }, `${a.name} is active again.`)}>Make active</button>
                  ) : null}
                  <button className={buttonClass} onClick={() => setEditing({ id: a.id, mode: a.commissionMode, percent: String(a.commissionPercent), notes: a.notes })}>Edit</button>
                </div> : null,
              ])}
          />
        </div>
      )}

      {data && section === 'commissions' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select className={inputClass} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)}>
              <option value="all">All statuses</option>
              {(['pending', 'confirmed', 'paid', 'cancelled'] as const).map((s) => (
                <option key={s} value={s}>{COMMISSION_STATUS_LABELS[s]}</option>
              ))}
            </select>
            <span className="text-xs text-[var(--sera-muted)]">
              Pending until {settings?.confirmAfterDays ?? 7} days after delivery (longer while a return request is open). Cancelled or refunded orders are cancelled.
            </span>
          </div>
          <Table
            head={[
              { label: 'Ordered' },
              { label: 'Order' },
              { label: 'Affiliate' },
              { label: 'Post' },
              { label: 'Products', right: true },
              { label: 'Rate', right: true },
              { label: 'Commission', right: true },
              { label: 'Status' },
            ]}
            empty="No commission yet."
            rows={commissions.map((c) => [
              day(c.orderedAt),
              <span key="o" className="whitespace-nowrap">{c.orderRef} <span className="text-xs text-[var(--sera-muted)]">{c.channel === 'outdoor' ? 'Outdoor' : 'Store'}</span></span>,
              affiliateName(c.affiliateId),
              c.subId || '—',
              rm(c.goods),
              `${c.percent}%`,
              rm(c.amount),
              <span key="s" className="whitespace-nowrap">{COMMISSION_STATUS_LABELS[c.status]}{c.status === 'pending' && c.deliveredAt ? ` · delivered ${day(c.deliveredAt)}` : ''}</span>,
            ])}
          />
        </div>
      )}

      {data && section === 'payouts' && (
        <div className="space-y-5">
          <Panel title="To pay" hint={`Confirmed commission, paid by bank transfer.${settings && settings.minPayoutAmount > 0 ? ` Minimum ${rm(settings.minPayoutAmount)}.` : ''} Record the transfer after you send it.`}>
            {!data.canRecordPayout ? (
              <p className="text-sm text-[var(--sera-muted)]">A Finance Payment Approver must view bank details and record affiliate transfers.</p>
            ) : toPay.length === 0 ? (
              <p className="text-sm text-[var(--sera-muted)]">Nothing confirmed to pay.</p>
            ) : (
              <div className="divide-y divide-[var(--sera-line)]">
                {toPay.map((a) => {
                  const belowMin = settings ? a.balance.confirmed < settings.minPayoutAmount : false
                  return (
                    <div key={a.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-sm">
                        <div className="font-medium text-[var(--sera-ink)]">{a.name} <span className="text-xs text-[var(--sera-muted)]">{a.code}</span></div>
                        <div className="text-xs text-[var(--sera-muted)]">
                          {a.hasBankAccount ? `${a.bankName} · ${a.bankAccountNo} · ${a.bankAccountName}` : 'No bank account saved'}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold tabular-nums">{rm(a.balance.confirmed)}</span>
                        <input className={`${inputClass} w-44`} placeholder="Transfer reference" maxLength={120}
                          value={payRef[a.id] || ''} onChange={(e) => setPayRef({ ...payRef, [a.id]: e.target.value })} />
                        <button className={primaryClass} disabled={busy || belowMin || !a.hasBankAccount || !(payRef[a.id] || '').trim()}
                          onClick={async () => {
                            if (!window.confirm(`Record a transfer of ${rm(a.balance.confirmed)} to ${a.name}?`)) return
                            if (await post({
                              action: 'record_payout',
                              affiliateId: a.id,
                              reference: payRef[a.id],
                              expectedAmount: a.balance.confirmed,
                              expectedBankName: a.bankName,
                              expectedBankAccountNo: a.bankAccountNo,
                              expectedBankAccountName: a.bankAccountName,
                            }, `Transfer to ${a.name} recorded.`)) {
                              setPayRef({ ...payRef, [a.id]: '' })
                            }
                          }}>Record transfer</button>
                        {belowMin ? <span className="text-xs text-[var(--sera-muted)]">Below minimum</span> : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Panel>
          {data.canRecordPayout ? <Table
            head={[{ label: 'Paid' }, { label: 'Affiliate' }, { label: 'Bank' }, { label: 'Reference' }, { label: 'Orders', right: true }, { label: 'Amount', right: true }]}
            empty="No transfers recorded yet."
            rows={data.payouts.map((p) => [
              day(p.paidAt),
              affiliateName(p.affiliateId),
              <span key="b" className="text-xs">{p.bankName} · {p.bankAccountNo} · {p.bankAccountName}</span>,
              p.reference,
              String(p.count),
              rm(p.amount),
            ])}
          /> : null}
        </div>
      )}

      {data && data.canManageProgram && form && section === 'settings' && (
        <div className="space-y-5">
          <Panel title="Program">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              Program is on (shoppers can join and links earn commission)
            </label>
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-[var(--sera-ink)]">Who can join</span>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={form.joinMode === 'open'} onChange={() => setForm({ ...form, joinMode: 'open' })} />
                Anyone with a store account (link works straight away)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={form.joinMode === 'approval'} onChange={() => setForm({ ...form, joinMode: 'approval' })} />
                Anyone can apply; staff approve each one
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Commission %" hint="Of the products' price, delivery not included.">
                <input className={`${inputClass} w-full`} inputMode="decimal" value={form.commissionPercent} placeholder="Not set"
                  onChange={(e) => setForm({ ...form, commissionPercent: e.target.value })} />
              </Field>
              <Field label="Link works for (days)" hint="Order must be paid within this many days of the click.">
                <input className={`${inputClass} w-full`} inputMode="numeric" value={form.attributionDays}
                  onChange={(e) => setForm({ ...form, attributionDays: e.target.value })} />
              </Field>
              <Field label="Confirm after delivery (days)" hint="Return window before commission can be paid.">
                <input className={`${inputClass} w-full`} inputMode="numeric" min={7} max={180} value={form.confirmAfterDays}
                  onChange={(e) => setForm({ ...form, confirmAfterDays: e.target.value })} />
              </Field>
              <Field label="Minimum payout (RM)">
                <input className={`${inputClass} w-full`} inputMode="decimal" value={form.minPayoutAmount}
                  onChange={(e) => setForm({ ...form, minPayoutAmount: e.target.value })} />
              </Field>
            </div>
            <p className="text-xs text-[var(--sera-muted)]">A new rate applies to new orders only; earlier orders keep the rate they were placed with.</p>
          </Panel>

          <Panel title="Products that earn commission" hint="Ticked items are left out of the program. Live host links are not affected.">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={form.excludeVape} onChange={(e) => setForm({ ...form, excludeVape: e.target.checked })} />
              Leave out vape products (products marked as vape in Master Data)
            </label>
            <div>
              <span className="text-xs font-medium text-[var(--sera-ink)]">Leave out categories</span>
              <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
                {data.categories.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4" checked={form.excludedCategoryIds.includes(c.id)}
                      onChange={(e) => setForm({ ...form, excludedCategoryIds: toggle(form.excludedCategoryIds, c.id, e.target.checked) })} />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <span className="text-xs font-medium text-[var(--sera-ink)]">Leave out products</span>
              <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                {data.products.map((p) => {
                  const byRule = (form.excludeVape && p.isVape) || (p.categoryId ? form.excludedCategoryIds.includes(p.categoryId) : false)
                  return (
                    <label key={p.id} className={`flex items-center gap-2 text-sm ${byRule ? 'text-[var(--sera-muted)]' : ''}`}>
                      <input type="checkbox" className="h-4 w-4" disabled={byRule} checked={byRule || form.excludedProductIds.includes(p.id)}
                        onChange={(e) => setForm({ ...form, excludedProductIds: toggle(form.excludedProductIds, p.id, e.target.checked) })} />
                      <span>{p.name}{categoryName(p.categoryId) ? <span className="text-xs text-[var(--sera-muted)]"> · {categoryName(p.categoryId)}</span> : null}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          </Panel>

          <Panel title="Terms" hint="Shown to shoppers before they join. They must accept them.">
            <textarea className={`${inputClass} min-h-[140px] w-full`} maxLength={4000} value={form.terms}
              onChange={(e) => setForm({ ...form, terms: e.target.value })} />
          </Panel>

          <div className="flex gap-2">
            <button className={primaryClass} disabled={busy} onClick={() => post({ action: 'save_settings', ...form }, 'Settings saved.')}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save settings
            </button>
            <button className={buttonClass} disabled={busy} onClick={() => settings && setForm(formFromSettings(settings))}>Undo changes</button>
          </div>
        </div>
      )}
    </div>
  )
}
