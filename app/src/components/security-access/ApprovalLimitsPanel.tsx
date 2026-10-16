'use client'

import { permissionLabel } from '@/lib/security-access/labels'
import { EmptyState, InfoPopover } from './ui'

/**
 * Approval Limits (previously shown as "Authority Policies" under Roles &
 * Policies): approval thresholds (amount, currency, variance) evaluated against
 * the trusted document. Read-only reference panel — its data, authorization and
 * server-side gating are unchanged: without the Security audit view the
 * governance read model is unavailable and the panel explains that; nothing is
 * enforced or edited here.
 */
export default function ApprovalLimitsPanel({ governance }: { governance: any | null }) {
  const policies: any[] = governance?.authorityPolicies || []
  return <section className="rounded-xl border border-gray-200 bg-white shadow-sm">
    <div className="border-b border-gray-100 p-4">
      <div className="flex items-center gap-2"><h2 className="font-semibold text-gray-950">Approval Limits</h2>
        <InfoPopover label="About Approval Limits">
          <p>Approval limits (amount, currency, variance) evaluated against the trusted document. Permission alone is not approval authority.</p>
          <p>When no limits are configured, existing workflow approval rules remain in effect.</p>
        </InfoPopover>
      </div>
    </div>
    {!governance && <EmptyState>Approval Limits need the Security audit view.</EmptyState>}
    <div className="divide-y divide-gray-100">{policies.map((p: any) => <div key={p.id} className="px-4 py-2.5 text-sm">
      <div className="font-medium text-gray-900">{p.name}</div>
      <div className="text-xs text-gray-500">{permissionLabel(p.permission_key).label} · {p.document_type} · {p.currency || 'any currency'} {p.min_amount ?? 0}–{p.max_amount ?? '∞'}</div></div>)}</div>
    {governance && !policies.length && <EmptyState>No approval thresholds are configured. None are documented in the current workflows, so existing workflow approval rules apply unchanged.</EmptyState>}
  </section>
}