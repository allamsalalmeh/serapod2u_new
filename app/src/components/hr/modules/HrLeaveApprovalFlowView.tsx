'use client'

import { CalendarClock } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

/**
 * HR → Leave → Approval Flow.
 *
 * B2B: the previous screen showed demonstration data from an in-memory mock repository, not the organization's real
 * approval rules, so it is removed from navigation and this direct URL shows an explicit "not available yet" state.
 * Leave is decided today by the direct manager (Manager Self-Service) or explicitly authorized HR, enforced in the
 * database (B2A). Configurable approval chains and delegation arrive with the leave backend (B6).
 */
export default function HrLeaveApprovalFlowView() {
    return (
        <div className="p-6 max-w-2xl">
            <Card>
                <CardContent className="py-10 flex flex-col items-center text-center gap-3">
                    <CalendarClock className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
                    <h1 className="text-lg font-semibold text-foreground">Leave approval flow is not available yet</h1>
                    <p className="text-sm text-muted-foreground">
                        Leave requests are decided by the employee&apos;s direct manager (Manager Self-Service) or by
                        authorized HR. Configurable approval chains and delegation will be added with the leave
                        management upgrade.
                    </p>
                </CardContent>
            </Card>
        </div>
    )
}
