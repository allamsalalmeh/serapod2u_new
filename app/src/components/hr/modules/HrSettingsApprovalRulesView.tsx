'use client'

import Link from 'next/link'
import { Info } from 'lucide-react'
import HrSettingsView from '@/components/hr/HrSettingsView'

interface HrSettingsApprovalRulesViewProps {
    organizationId: string
    canEdit: boolean
}

/**
 * Organization HR defaults (stored in the organization settings). Verified 2026-10-26: no leave, attendance or overtime
 * decision reads these values — approvals are decided by the database (direct manager with Manager Self-Service, or
 * explicit HR), attendance workdays by the attendance policy and holidays by the holiday calendar. The notice says so,
 * so nobody configures "approval rules" here expecting them to route approvals.
 */
export default function HrSettingsApprovalRulesView({ organizationId, canEdit }: HrSettingsApprovalRulesViewProps) {
    return (
        <div className="space-y-4">
            <div role="note" className="flex gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <div className="space-y-1">
                    <p><b>These defaults do not route approvals.</b> Leave is approved by the employee’s direct manager (with Manager Self-Service) or by HR with explicit leave authority; attendance corrections and overtime by HR. Grant those in People &amp; Access.</p>
                    <p>
                        Workdays, lateness and overtime caps: <Link className="underline" href="/hr/attendance/clock-in-out?tab=setup">Attendance Operations → Policy &amp; shifts</Link>.
                        {' '}Holidays: <Link className="underline" href="/hr/attendance/public-holidays">Public Holidays</Link>.
                        {' '}Reporting lines: <Link className="underline" href="/hr/people/employees">Employees</Link>.
                    </p>
                </div>
            </div>
            <HrSettingsView organizationId={organizationId} canEdit={canEdit} />
        </div>
    )
}
