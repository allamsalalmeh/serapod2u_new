"use client"

import { useCallback, useMemo, useState } from "react"
import { Loader2, Save, Send, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatPhoneDisplay } from "@/utils/phone"
import { isRecoverySentStatus } from "@/lib/wa-recovery/activity-status"
import type { RecoveryPurpose } from "@/lib/wa-recovery/templates"

/** A failed WhatsApp row that a recovery message can be sent for. */
export interface RecoveryTarget {
    id: string
    createdAt: string | null
    purpose?: string | null
    recoveryStatus: string | null
    action: Record<string, any>
}

interface RecoveryTemplate {
    key: RecoveryPurpose
    name: string
    body: string
    hint?: string
    variables?: string[]
}

type Notify = (kind: "ok" | "err", text: string) => void

const digits = (value: string) => String(value || "").replace(/\D/g, "")
const formatPhone = (value: string) => formatPhoneDisplay(value || "") || value || "-"

/** One recovery per phone and template, keeping the latest failure (unchanged rule). */
export function uniqueRecoveryTargets(targets: RecoveryTarget[], explicitTemplateKey?: RecoveryPurpose) {
    const unique = new Map<string, RecoveryTarget>()
    for (const target of targets) {
        if (!target.action?.phone) continue
        const key = `${digits(target.action.phone)}:${explicitTemplateKey || target.action.suggestedTemplateKey}`
        const existing = unique.get(key)
        if (!existing || new Date(target.createdAt || 0).getTime() > new Date(existing.createdAt || 0).getTime()) unique.set(key, target)
    }
    return Array.from(unique.values())
}

/** The fields the recovery endpoints have always received. */
function serialize(target: RecoveryTarget) {
    const a = target.action
    return {
        sourceType: a.sourceType,
        sourceRecordId: a.sourceRecordId,
        sourceKey: a.sourceKey,
        phone: a.phone,
        failedPurpose: a.failedPurpose,
        failedAt: a.failedAt,
        provider: a.provider,
        userId: a.userId,
        resolvedName: a.resolvedName,
        resolvedSource: a.resolvedSource,
    }
}

export const QUICK_RECOVERY_ACTIONS: { label: string; key: RecoveryPurpose; match: (purpose: string) => boolean }[] = [
    { label: "Notify all failed password reset", key: "password_reset_recovery", match: (p) => p.includes("password_reset") },
    { label: "Notify all failed registration", key: "registration_recovery", match: (p) => p.includes("registration") || p.includes("phone_verification") },
    { label: "Notify all failed QR claim", key: "qr_claim_recovery", match: (p) => p.includes("qr") || p.includes("claim") },
    { label: "Send system restored message", key: "recovery_notice", match: () => true },
]

/**
 * Recovery-message actions for WhatsApp. Every send is behind a confirmation
 * dialog; nothing is sent automatically.
 */
export function useWhatsAppRecovery({ notify, onChanged }: { notify: Notify; onChanged: () => void }) {
    const [confirmTarget, setConfirmTarget] = useState<RecoveryTarget | null>(null)
    const [clearTarget, setClearTarget] = useState<RecoveryTarget | null>(null)
    const [bulk, setBulk] = useState<{ label: string; targets: RecoveryTarget[]; templateKey?: RecoveryPurpose } | null>(null)
    const [custom, setCustom] = useState<{ open: boolean; single: RecoveryTarget | null; targets: RecoveryTarget[]; message: string }>({ open: false, single: null, targets: [], message: "" })
    const [busy, setBusy] = useState(false)
    const [templates, setTemplates] = useState<RecoveryTemplate[]>([])
    const [templateEditor, setTemplateEditor] = useState<{ open: boolean; key: RecoveryPurpose | null; body: string }>({ open: false, key: null, body: "" })

    const sendSingle = useCallback(async (target: RecoveryTarget, opts: { customMessage?: string; allowResend: boolean }) => {
        setBusy(true)
        try {
            const response = await fetch("/api/settings/notifications/whatsapp-recovery/send", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ mode: "single", record: serialize(target), templateKey: target.action.suggestedTemplateKey, customMessage: opts.customMessage, allowResend: opts.allowResend }),
            })
            const payload = await response.json()
            if (!response.ok) throw new Error(payload.error || "Failed to send recovery message")
            if (payload.sent > 0) notify("ok", `Recovery message sent to ${formatPhone(target.action.phone)}`)
            else if (payload.skipped > 0) notify("ok", `Skipped duplicate recovery send for ${formatPhone(target.action.phone)}`)
            else notify("err", payload.error || "No recovery message was sent")
            onChanged()
        } catch (error: any) {
            notify("err", error?.message || "Network error")
        } finally {
            setBusy(false)
        }
    }, [notify, onChanged])

    const sendBulk = useCallback(async (targets: RecoveryTarget[], opts: { templateKey?: RecoveryPurpose; customMessage?: string; allowResend: boolean }) => {
        const unique = uniqueRecoveryTargets(targets, opts.templateKey)
        if (unique.length === 0) return
        setBusy(true)
        try {
            const response = await fetch("/api/settings/notifications/whatsapp-recovery/send", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ mode: "bulk", records: unique.map(serialize), templateKey: opts.templateKey, customMessage: opts.customMessage, allowResend: opts.allowResend }),
            })
            const payload = await response.json()
            if (!response.ok) throw new Error(payload.error || "Bulk recovery send failed")
            notify("ok", `Sent: ${payload.sent} • Skipped: ${payload.skipped} • Failed: ${payload.failed}`)
            onChanged()
        } catch (error: any) {
            notify("err", error?.message || "Network error")
        } finally {
            setBusy(false)
        }
    }, [notify, onChanged])

    const clearRecord = useCallback(async (target: RecoveryTarget) => {
        setBusy(true)
        try {
            const response = await fetch("/api/settings/notifications/whatsapp-recovery/records/clear", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sourceType: target.action.sourceType, sourceRecordId: target.action.sourceRecordId }),
            })
            const payload = await response.json()
            if (!response.ok) throw new Error(payload.error || "Failed to clear WhatsApp activity")
            notify("ok", "Failed WhatsApp activity cleared")
            onChanged()
        } catch (error: any) {
            notify("err", error?.message || "Failed to clear WhatsApp activity")
        } finally {
            setBusy(false)
        }
    }, [notify, onChanged])

    const openTemplates = useCallback(async () => {
        try {
            const response = await fetch("/api/settings/notifications/whatsapp-recovery/templates")
            const payload = await response.json()
            if (!response.ok) throw new Error(payload.error || "Failed to load templates")
            const list: RecoveryTemplate[] = payload.templates || []
            setTemplates(list)
            setTemplateEditor({ open: true, key: list[0]?.key || null, body: list[0]?.body || "" })
        } catch (error: any) {
            notify("err", error?.message || "Failed to load templates")
        }
    }, [notify])

    const saveTemplate = async () => {
        if (!templateEditor.key) return
        setBusy(true)
        try {
            const response = await fetch("/api/settings/notifications/whatsapp-recovery/templates", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ key: templateEditor.key, body: templateEditor.body, isActive: true }),
            })
            const payload = await response.json()
            if (!response.ok) throw new Error(payload.error || "Failed to save template")
            notify("ok", `${payload.template?.name || "Template"} saved`)
            setTemplateEditor({ open: false, key: null, body: "" })
            onChanged()
        } catch (error: any) {
            notify("err", error?.message || "Failed to save template")
        } finally {
            setBusy(false)
        }
    }

    const bulkUnique = useMemo(() => (bulk ? uniqueRecoveryTargets(bulk.targets, bulk.templateKey) : []), [bulk])
    const bulkAlreadySent = bulkUnique.filter((target) => isRecoverySentStatus(target.recoveryStatus)).length
    const activeTemplate = templates.find((template) => template.key === templateEditor.key) || null

    const dialogs = (
        <>
            <Dialog open={!!confirmTarget} onOpenChange={(open) => !open && setConfirmTarget(null)}>
                <DialogContent className="max-w-xl">
                    <DialogHeader>
                        <DialogTitle>{confirmTarget && isRecoverySentStatus(confirmTarget.recoveryStatus) ? "Resend recovery message" : "Send recovery message"}</DialogTitle>
                        <DialogDescription>Sends a recovery/support message only. It does not retry the original notification and does not resend any OTP or password reset link.</DialogDescription>
                    </DialogHeader>
                    {confirmTarget ? (
                        <div className="space-y-3 text-sm">
                            <p><span className="text-slate-500">To:</span> <span className="font-medium">{confirmTarget.action.resolvedName}</span> · {formatPhone(confirmTarget.action.phone)} · {confirmTarget.action.resolvedSource}</p>
                            <p><span className="text-slate-500">Template:</span> {confirmTarget.action.suggestedTemplateName}</p>
                            {confirmTarget.recoveryStatus ? (
                                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">A recovery message is already logged for this failure. Sending again creates a new audit entry.</p>
                            ) : null}
                            <div className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs text-slate-700">
                                <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">Message preview</p>
                                {confirmTarget.action.suggestedMessagePreview}
                            </div>
                        </div>
                    ) : null}
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setConfirmTarget(null)}>Cancel</Button>
                        <Button
                            className="bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange)]/90"
                            disabled={!confirmTarget || busy}
                            onClick={async () => {
                                const target = confirmTarget!
                                setConfirmTarget(null)
                                await sendSingle(target, { allowResend: isRecoverySentStatus(target.recoveryStatus) })
                            }}
                        >
                            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                            {confirmTarget && isRecoverySentStatus(confirmTarget.recoveryStatus) ? "Resend" : "Send"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!clearTarget} onOpenChange={(open) => !open && !busy && setClearTarget(null)}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Clear failed WhatsApp activity?</DialogTitle>
                        <DialogDescription>Removes this failed notification from recovery monitoring. Use it only when the record no longer needs recovery.</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" disabled={busy} onClick={() => setClearTarget(null)}>Cancel</Button>
                        <Button
                            className="bg-red-600 text-white hover:bg-red-700"
                            disabled={!clearTarget || busy}
                            onClick={async () => { const target = clearTarget!; setClearTarget(null); await clearRecord(target) }}
                        >
                            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}Clear
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!bulk} onOpenChange={(open) => !open && setBulk(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{bulk?.label}</DialogTitle>
                        <DialogDescription>
                            Sends a recovery message (not a retry of the original notification) to <span className="font-semibold">{bulkUnique.length}</span> unique recipient{bulkUnique.length === 1 ? "" : "s"}.
                            {bulkAlreadySent > 0 ? <><br /><br />{bulkAlreadySent} already have a recovery message and are skipped unless you resend.</> : null}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setBulk(null)}>Cancel</Button>
                        <Button
                            variant="outline"
                            disabled={!bulk || busy || bulkUnique.length - bulkAlreadySent <= 0}
                            onClick={async () => { const action = bulk!; setBulk(null); await sendBulk(action.targets, { templateKey: action.templateKey, allowResend: false }) }}
                        >
                            Send eligible ({Math.max(0, bulkUnique.length - bulkAlreadySent)})
                        </Button>
                        <Button
                            className="bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange)]/90"
                            disabled={!bulk || busy || bulkUnique.length === 0}
                            onClick={async () => { const action = bulk!; setBulk(null); await sendBulk(action.targets, { templateKey: action.templateKey, allowResend: true }) }}
                        >
                            <Send className="mr-1.5 h-3.5 w-3.5" />{bulkAlreadySent > 0 ? `Resend all (${bulkUnique.length})` : `Send all (${bulkUnique.length})`}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={custom.open} onOpenChange={(open) => setCustom((state) => ({ ...state, open }))}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Custom recovery message</DialogTitle>
                        <DialogDescription>
                            {custom.single
                                ? <>To <span className="font-mono">{formatPhone(custom.single.action.phone)}</span> ({custom.single.action.resolvedName}).</>
                                : <>To {uniqueRecoveryTargets(custom.targets).length} unique failed recipient(s) {custom.targets.length ? "" : "(none match)"}.</>}
                            {" "}A one-off recovery message; the original notification is not retried.
                        </DialogDescription>
                    </DialogHeader>
                    <textarea
                        aria-label="Custom recovery message"
                        className="h-40 w-full rounded-md border border-slate-200 p-2 text-sm"
                        placeholder="Type your message..."
                        value={custom.message}
                        onChange={(event) => setCustom((state) => ({ ...state, message: event.target.value }))}
                    />
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setCustom((state) => ({ ...state, open: false }))}>Cancel</Button>
                        <Button
                            className="bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange)]/90"
                            disabled={!custom.message.trim() || busy || (!custom.single && custom.targets.length === 0)}
                            onClick={async () => {
                                const { single, targets, message } = custom
                                setCustom({ open: false, single: null, targets: [], message: "" })
                                if (single) await sendSingle(single, { customMessage: message.trim(), allowResend: isRecoverySentStatus(single.recoveryStatus) })
                                else await sendBulk(targets, { customMessage: message.trim(), allowResend: false })
                            }}
                        >
                            <Send className="mr-1.5 h-3.5 w-3.5" />Send
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={templateEditor.open} onOpenChange={(open) => setTemplateEditor((state) => ({ ...state, open }))}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Recovery templates</DialogTitle>
                        <DialogDescription>Organization recovery templates. Variables: {activeTemplate?.variables?.join(", ") || "greeting, date, time, app_name"}.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-3">
                        <Select value={templateEditor.key || ""} onValueChange={(value) => setTemplateEditor({ open: true, key: value as RecoveryPurpose, body: templates.find((t) => t.key === value)?.body || "" })}>
                            <SelectTrigger className="h-9" aria-label="Template"><SelectValue placeholder="Choose a template" /></SelectTrigger>
                            <SelectContent>{templates.map((template) => <SelectItem key={template.key} value={template.key}>{template.name}</SelectItem>)}</SelectContent>
                        </Select>
                        <textarea
                            aria-label="Template body"
                            className="h-52 w-full rounded-md border border-slate-200 p-3 text-sm"
                            value={templateEditor.body}
                            onChange={(event) => setTemplateEditor((state) => ({ ...state, body: event.target.value }))}
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setTemplateEditor((state) => ({ ...state, open: false }))}>Cancel</Button>
                        <Button className="bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange)]/90" disabled={busy || !templateEditor.body.trim()} onClick={saveTemplate}>
                            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}Save template
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    )

    return {
        dialogs,
        busy,
        confirm: setConfirmTarget,
        clear: setClearTarget,
        bulk: (label: string, targets: RecoveryTarget[], templateKey?: RecoveryPurpose) => setBulk({ label, targets, templateKey }),
        customForOne: (target: RecoveryTarget) => setCustom({ open: true, single: target, targets: [], message: target.action.suggestedMessagePreview || "" }),
        customForMany: (targets: RecoveryTarget[]) => setCustom({ open: true, single: null, targets, message: "" }),
        openTemplates,
    }
}
