'use client'

import { useRouter } from 'next/navigation'
import { ArrowRight, AlertCircle, Construction } from 'lucide-react'
import { financeNavGroups, type FinanceNavGroup } from '@/modules/finance/financeNav'
import FinanceHeroBanner from './FinanceHeroBanner'
import SetupReadinessBanner from '@/components/shared/SetupReadinessBanner'
import ModuleLandingCard from '@/components/layout/ModuleLandingCard'
import { financeLandingAccents, landingAccents, pickLandingAccent } from '@/lib/landing-accents'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface FinanceLandingViewProps {
    userName?: string | null
    bannerImageUrl?: string | null
}

const cardDescriptions: Record<string, { description: string; status: 'live' | 'coming-soon' | 'placeholder' }> = {
    'finance-gl': { description: 'Manage journal entries, review pending postings, and maintain your Chart of Accounts.', status: 'live' },
    'finance-ar': { description: 'Track customer invoices, receipts, and aging analysis. Malaysia SST/e-Invoice ready.', status: 'live' },
    'finance-ap': { description: 'Manage supplier bills, payment vouchers, and AP aging. Integrates with Purchase Orders.', status: 'live' },
    'finance-cash': { description: 'Bank account register, bank statement import, reconciliation workflows, and cash flow monitoring.', status: 'live' },
    'finance-reports': { description: 'Trial Balance, Profit & Loss, Balance Sheet, GL Detail, and Cash Flow Statement.', status: 'live' },
    'finance-settings': { description: 'Default posting accounts, currency, fiscal year periods, posting rules, and permissions.', status: 'live' },
}

const defaultIconAccent = landingAccents.emerald

function StatusBadge({ status }: { status: 'live' | 'coming-soon' | 'placeholder' }) {
    if (status === 'live') return null
    if (status === 'coming-soon') {
        return (
            <Badge variant="outline" className="text-amber-700 border-amber-200 text-[10px] px-1.5 py-0">
                <Construction className="h-2.5 w-2.5 mr-0.5" />
                Coming Soon
            </Badge>
        )
    }
    return (
        <Badge variant="outline" className="text-slate-500 border-slate-200 text-[10px] px-1.5 py-0">
            <AlertCircle className="h-2.5 w-2.5 mr-0.5" />
            Placeholder
        </Badge>
    )
}

export default function FinanceLandingView({ userName, bannerImageUrl }: FinanceLandingViewProps) {
    const router = useRouter()

    return (
        <div className="sera-module-landing">
            <FinanceHeroBanner userName={userName ?? null} bannerImageUrl={bannerImageUrl} />

            <SetupReadinessBanner
                auditEndpoint="/api/finance/config/audit"
                settingsHref="/dashboard?view=finance/settings/configuration"
                moduleName="Finance"
                accentColor="emerald"
            />

            <div className="sera-module-landing__grid">
                {financeNavGroups.map((group: FinanceNavGroup) => {
                    const Icon = group.icon
                    const meta = cardDescriptions[group.id]
                    const accent = pickLandingAccent(financeLandingAccents, group.id, defaultIconAccent)

                    return (
                        <ModuleLandingCard
                            key={group.id}
                            icon={Icon}
                            accent={accent}
                            title={group.label}
                            description={meta?.description}
                            titleExtra={meta ? <StatusBadge status={meta.status} /> : null}
                        >
                            <ul className="m-0 p-0 list-none">
                                {group.children.map((child) => {
                                    const ChildIcon = child.icon
                                    const isComingSoon = meta && meta.status !== 'live'

                                    return (
                                        <li key={child.id}>
                                            <button
                                                type="button"
                                                onClick={() => router.push(child.href)}
                                                disabled={isComingSoon}
                                                className={cn(
                                                    'sera-module-landing__link group',
                                                    isComingSoon && 'opacity-45 cursor-not-allowed'
                                                )}
                                            >
                                                <ChildIcon className={cn('h-4 w-4 shrink-0', accent.icon)} strokeWidth={1.75} />
                                                <span className="flex-1 text-left">{child.label}</span>
                                                {!isComingSoon && (
                                                    <ArrowRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity text-[var(--sera-orange)]" />
                                                )}
                                            </button>
                                        </li>
                                    )
                                })}
                            </ul>
                        </ModuleLandingCard>
                    )
                })}
            </div>

            <div className="rounded-xl border border-amber-200/80 bg-amber-50/50 p-5 space-y-3">
                <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-amber-600" />
                    <h3 className="font-semibold text-sm text-amber-900">Suggested Enhancements (Malaysia Context)</h3>
                </div>
                <ul className="text-xs text-amber-800 space-y-1.5 list-disc list-inside">
                    <li><strong>Bank Reconciliation Workflow</strong> — Import bank statements (CSV/OFX), auto-match transactions, manual matching, and reconciliation reports.</li>
                    <li><strong>Period Lock / Close Controls</strong> — Prevent posting to closed periods, year-end closing wizard with retained earnings journal.</li>
                    <li><strong>Audit Trail Reports</strong> — Journal modification history, user activity log per period.</li>
                    <li><strong>SST / e-Invoice Readiness</strong> — Tax code configuration, LHDN MyInvois integration hooks (placeholder screens for future phase).</li>
                    <li><strong>Multi-Currency Support</strong> — Exchange rate table, unrealised gain/loss revaluation.</li>
                    <li><strong>Budgeting</strong> — Budget vs actual by account and period, variance reporting.</li>
                </ul>
            </div>
        </div>
    )
}
