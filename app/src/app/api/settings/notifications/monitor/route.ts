import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { isAdminUser } from '@/app/api/settings/whatsapp/_utils'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { canViewSmsMonitor } from '@/lib/notifications/smsMonitorAccess'
import { canViewEmailMonitor } from '@/lib/notifications/emailMonitorAccess'
import { emailProviderBlockedByUiTest } from '@/lib/notifications/emailProviderReady'
import { isFailedStatus } from '@/lib/wa-recovery/activity-status'
import { moduleName } from '@/lib/notifications/notificationTypeModules'
import { canViewMonitor, loadMonitorViewer, resolveMonitorScope, type MonitorScope } from '@/lib/notifications/monitorScope'
import {
    MONITOR_SOURCE_LIMIT,
    emailToMonitorRecord,
    loadEmailMessages,
    loadSmsMessages,
    loadWhatsAppRecords,
    smsToMonitorRecord,
    whatsAppToMonitorRecord,
} from '@/lib/notifications/monitor/channelLoaders'
import {
    CHANNEL_CAPABILITY_NOTES,
    CHANNEL_STATUSES,
    MONITOR_TIMEZONE,
    UNMAPPED_MODULE_ID,
    UNMAPPED_MODULE_LABEL,
    allMatchingRows,
    classifyEvent,
    annotateRecords,
    applyMonitorQuery,
    dateRangeBounds,
    monitorCsv,
    parseMonitorFilters,
    type MonitorRecord,
    type TypeCatalogEntry,
} from '@/lib/notifications/monitor/monitorCore'

export const dynamic = 'force-dynamic'

/**
 * GET /api/settings/notifications/monitor
 *
 * One Notification Monitor query for any channel. Filters (search, module,
 * notification type, date range, status, provider) apply to every row in the
 * date range before pagination; counts use the same filters except status.
 *
 * Access is the channel's existing rule: WhatsApp = notification admins,
 * SMS / Email = platform.settings.manage plus the delivery-monitor check.
 *
 * ?format=csv exports every matching row (no pagination).
 */
export async function GET(request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const filters = parseMonitorFilters(request.nextUrl.searchParams)
        if (filters.channel === 'whatsapp') {
            if (!await isAdminUser(supabase as any, user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        } else {
            const saDenied = await guardUserOperation(user.id, 'platform.settings.manage')
            if (saDenied) return saDenied
            const allowed = filters.channel === 'sms' ? await canViewSmsMonitor(supabase, user.id) : await canViewEmailMonitor(supabase, user.id)
            if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const admin = createAdminClient() as any
        const { data: profile } = await admin.from('users').select('organization_id').eq('id', user.id).single()
        const orgId: string | null = profile?.organization_id || null
        // SMS / Email: HQ staff oversee every organization; everyone else sees only their own.
        let scope: MonitorScope = { kind: 'orgs', orgIds: [] }
        if (filters.channel !== 'whatsapp') {
            const viewer = await loadMonitorViewer(admin, user.id)
            if (!viewer || !canViewMonitor(viewer)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
            scope = resolveMonitorScope(viewer)
        }
        const window = { ...dateRangeBounds(filters.from, filters.to), limit: MONITOR_SOURCE_LIMIT }

        let records: MonitorRecord[]
        let truncated: boolean
        if (filters.channel === 'whatsapp') {
            const loaded = await loadWhatsAppRecords(admin, orgId, window)
            records = loaded.records.map(whatsAppToMonitorRecord)
            truncated = loaded.truncated
        } else if (filters.channel === 'sms') {
            const loaded = await loadSmsMessages(admin, scope, window)
            records = loaded.messages.map(smsToMonitorRecord)
            truncated = loaded.truncated
        } else {
            const loaded = await loadEmailMessages(admin, scope, window)
            records = loaded.messages.map(emailToMonitorRecord)
            truncated = loaded.truncated
        }

        const [{ data: types }, { data: providerRows }] = await Promise.all([
            admin.from('notification_types').select('event_code, event_name, category'),
            orgId
                ? admin.from('notification_provider_configs').select('provider_name, is_active, last_test_status, last_test_at, last_test_error').eq('org_id', orgId).eq('channel', filters.channel)
                : Promise.resolve({ data: [] }),
        ])
        const catalog = new Map<string, TypeCatalogEntry>((types || []).map((type: TypeCatalogEntry) => [type.event_code, type]))
        const annotated = annotateRecords(records, catalog)

        if (request.nextUrl.searchParams.get('format') === 'csv') {
            const csv = monitorCsv(allMatchingRows(annotated, filters))
            const note = truncated ? `# Partial: more than ${MONITOR_SOURCE_LIMIT} rows per source in this range; narrow the date range for a complete export.\n` : ''
            return new NextResponse(note + csv, {
                headers: {
                    'content-type': 'text/csv; charset=utf-8',
                    'content-disposition': `attachment; filename="notification-monitor_${filters.channel}_${filters.from}_${filters.to}.csv"`,
                },
            })
        }

        // Recovery targets: every failed row with a phone that matches the
        // filters (not just the visible page), for the existing bulk/quick
        // recovery actions. Same eligibility as before: raw failed + phone.
        if (filters.channel === 'whatsapp' && request.nextUrl.searchParams.get('targets') === 'failed') {
            const targets = allMatchingRows(annotated, { ...filters, status: 'failed' })
                .filter((row) => isFailedStatus(row.rawStatus) && row.action?.phone)
                .map((row) => ({ id: row.id, createdAt: row.createdAt, purpose: row.purpose, recoveryStatus: row.recovery?.status || null, action: row.action }))
            return NextResponse.json({ success: true, targets, truncated })
        }

        const result = applyMonitorQuery(annotated, filters)
        const activeProvider = (providerRows || []).find((row: any) => row.is_active) || null
        return NextResponse.json({
            success: true,
            ...result,
            range: { from: filters.from, to: filters.to, timezone: MONITOR_TIMEZONE },
            truncated,
            sourceLimit: MONITOR_SOURCE_LIMIT,
            statuses: CHANNEL_STATUSES[filters.channel],
            capabilityNote: CHANNEL_CAPABILITY_NOTES[filters.channel],
            // Labels for a deep-linked module/type even when no row in range has it.
            selected: {
                module: filters.module === 'all' ? null : { value: filters.module, label: filters.module === UNMAPPED_MODULE_ID ? UNMAPPED_MODULE_LABEL : moduleName(filters.module) },
                type: filters.type === 'all' ? null : { value: filters.type, ...classifyEvent(filters.type, filters.type, catalog) },
            },
            provider: {
                configured: (providerRows || []).length > 0,
                active: Boolean(activeProvider),
                name: activeProvider?.provider_name || null,
                lastTestStatus: activeProvider?.last_test_status || null,
                lastTestAt: activeProvider?.last_test_at || null,
                lastTestError: activeProvider?.last_test_error || null,
                blockedReason: filters.channel === 'email' && activeProvider ? emailProviderBlockedByUiTest(activeProvider) || null : null,
            },
        })
    } catch (error: any) {
        console.error('[notification-monitor]', error)
        return NextResponse.json({ error: error?.message || 'Failed to load notification activity' }, { status: 500 })
    }
}
