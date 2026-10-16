"use client"

import type { ReactNode } from "react"
import { Pencil, Send, Trash2 } from "lucide-react"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { STATUS_LABELS, STATUS_MEANINGS, type AnnotatedRecord } from "@/lib/notifications/monitor/monitorCore"
import { isFailedStatus } from "@/lib/wa-recovery/activity-status"
import { formatMonitorTime, StatusBadge } from "./monitorUi"

function Row({ label, children }: { label: string; children: ReactNode }) {
    if (children === null || children === undefined || children === "") return null
    return (
        <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 py-1.5 text-sm">
            <dt className="text-xs font-medium text-slate-500">{label}</dt>
            <dd className="min-w-0 break-words text-slate-800">{children}</dd>
        </div>
    )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="border-t border-slate-100 pt-3">
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
            {children}
        </section>
    )
}

export function MonitorDetailsSheet({
    record,
    onClose,
    onRecover,
    onCustomRecover,
    onClear,
    onEditSms,
}: {
    record: AnnotatedRecord | null
    onClose: () => void
    onRecover: (record: AnnotatedRecord) => void
    onCustomRecover: (record: AnnotatedRecord) => void
    onClear: (record: AnnotatedRecord) => void
    onEditSms: (record: AnnotatedRecord) => void
}) {
    const recoverable = Boolean(record && record.channel === "whatsapp" && isFailedStatus(record.rawStatus) && record.action?.phone)
    return (
        <Sheet open={!!record} onOpenChange={(open) => !open && onClose()}>
            <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
                {record ? (
                    <>
                        <div className="border-b border-slate-200 px-5 pb-3 pt-5 pr-12">
                            <SheetHeader className="space-y-1 text-left">
                                <SheetTitle className="text-base">{record.notificationName}</SheetTitle>
                                <SheetDescription>{record.moduleName} · {record.channel === "whatsapp" ? "WhatsApp" : record.channel === "sms" ? "SMS" : "Email"}{record.kind === "recovery" ? " · Recovery message" : ""}</SheetDescription>
                            </SheetHeader>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                                <StatusBadge status={record.status} />
                                <span>{STATUS_MEANINGS[record.status]}</span>
                            </div>
                        </div>
                        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
                            <dl>
                                <Row label="Recipient">{record.recipientName ? <>{record.recipientName} · {record.recipient}</> : record.recipient || "—"}</Row>
                                <Row label="Contact source">{record.recipientSource}</Row>
                                <Row label="Organization">{record.organizationName}</Row>
                                <Row label="Reference">{record.reference ? `${record.reference.label}${record.reference.id && record.reference.id !== record.reference.label ? ` (${record.reference.id})` : ""}` : null}</Row>
                                <Row label="Notification key"><span className="font-mono text-xs">{record.eventCode || record.purpose || "—"}</span></Row>
                            </dl>
                            <Block title="Delivery">
                                <dl>
                                    <Row label="Provider">{record.provider}</Row>
                                    <Row label="Message ID"><span className="font-mono text-xs">{record.providerMessageId}</span></Row>
                                    <Row label="Provider status">{record.rawStatus && record.rawStatus !== record.status ? `${record.rawStatus} (shown as ${STATUS_LABELS[record.status]})` : record.rawStatus}</Row>
                                    <Row label="Created">{formatMonitorTime(record.createdAt)}</Row>
                                    <Row label="Queued">{record.queuedAt ? formatMonitorTime(record.queuedAt) : null}</Row>
                                    <Row label="Sent">{record.sentAt ? formatMonitorTime(record.sentAt) : null}</Row>
                                    <Row label="Delivered">{record.deliveredAt ? formatMonitorTime(record.deliveredAt) : null}</Row>
                                    <Row label="Failed">{record.failedAt ? formatMonitorTime(record.failedAt) : null}</Row>
                                    <Row label="Attempts">{record.retryCount != null ? `${record.retryCount} retr${record.retryCount === 1 ? "y" : "ies"}${record.maxRetries != null ? ` of ${record.maxRetries}` : ""}` : null}</Row>
                                </dl>
                            </Block>
                            {record.errorMessage ? (
                                <Block title="Error">
                                    <p className="whitespace-pre-wrap break-words rounded-md border border-red-100 bg-red-50 p-2 text-xs text-red-800">{record.errorMessage}</p>
                                </Block>
                            ) : null}
                            {record.subject || record.message ? (
                                <Block title="Message">
                                    {record.subject ? <p className="mb-1 text-xs text-slate-500">Subject: {record.subject}</p> : null}
                                    {record.message
                                        ? <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-slate-50 p-2 text-xs text-slate-700">{record.message}</p>
                                        : <p className="text-xs text-slate-500">The message body was not stored.</p>}
                                </Block>
                            ) : null}
                            {record.channel === "whatsapp" && record.kind === "original" ? (
                                <Block title="Recovery history">
                                    {record.recovery ? (
                                        <dl>
                                            <Row label="Status">{record.recovery.status.replace(/_/g, " ")}</Row>
                                            <Row label="Logged">{formatMonitorTime(record.recovery.at)}</Row>
                                            <Row label="Template">{record.recovery.template}</Row>
                                            <Row label="Error">{record.recovery.error}</Row>
                                        </dl>
                                    ) : <p className="text-xs text-slate-500">No recovery message logged for this notification.</p>}
                                    <p className="mt-1 text-[11px] text-slate-500">A recovery message is a separate message; it does not change this notification&apos;s delivery status.</p>
                                </Block>
                            ) : null}
                            {record.statusDetails ? (
                                <Block title="Provider response">
                                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-slate-50 p-2 text-[11px] text-slate-600">{record.statusDetails}</pre>
                                </Block>
                            ) : null}
                        </div>
                        {recoverable || record.channel === "sms" ? (
                            <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 px-5 py-3">
                                {recoverable ? (
                                    <>
                                        <Button variant="ghost" size="sm" className="text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => onClear(record)}>
                                            <Trash2 className="mr-1.5 h-3.5 w-3.5" />Clear from monitoring
                                        </Button>
                                        <Button variant="outline" size="sm" onClick={() => onCustomRecover(record)}>Custom recovery…</Button>
                                        <Button size="sm" className="bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange)]/90" onClick={() => onRecover(record)}>
                                            <Send className="mr-1.5 h-3.5 w-3.5" />{record.recovery ? "Resend recovery message" : "Send recovery message"}
                                        </Button>
                                    </>
                                ) : null}
                                {record.channel === "sms" ? (
                                    <Button size="sm" variant="outline" onClick={() => onEditSms(record)}>
                                        <Pencil className="mr-1.5 h-3.5 w-3.5" />{record.status === "failed" ? "Retry original (edit & resend)" : "Edit / resend"}
                                    </Button>
                                ) : null}
                            </div>
                        ) : null}
                    </>
                ) : null}
            </SheetContent>
        </Sheet>
    )
}
