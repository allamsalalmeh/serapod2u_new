'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '@/components/ui/dialog'
import { AlertTriangle, Check, Loader2, ShieldCheck, Trash2 } from 'lucide-react'

export type PermanentDeleteEntry = 'user_management' | 'hr'

interface Blocker { code: string; category?: string; table?: string; column?: string; count?: number; message?: string }
interface Preview {
    target: {
        user_id: string; full_name: string | null; email: string | null; phone: string | null
        organization_name: string | null; employee_no: number | null; has_identity: boolean; has_login: boolean
    }
    employment: Array<{ employment_id: string; employee_no: number | null; onboarding_status: 'pending' | 'completed' | 'reset' }>
    cleanup: Array<{ table: string; count: number; label?: string }>
    retained: Array<{ table: string; label?: string }>
    blockers: Blocker[]
    confirmation_phrase: string
    preview_token: string
    allowed: boolean
}

export interface PermanentDeleteDialogProps {
    /** Person to delete; null closes the dialog. */
    target: { id: string; name: string } | null
    entry: PermanentDeleteEntry
    onClose: () => void
    /** Called after a verified deletion; refresh lists, totals and caches here. */
    onDeleted: (result: { userId: string; name: string }) => void | Promise<void>
    /** Optional softer alternative offered when deletion is blocked (User Management: archive). */
    onArchiveInstead?: (target: { id: string; name: string }) => void
    notify?: (message: { title: string; description: string; variant?: 'destructive' }) => void
}

const ONBOARDING_LABEL: Record<string, string> = { pending: 'Awaiting onboarding', reset: 'Registration reset', completed: 'Onboarded' }
const newRequestId = () => globalThis.crypto?.randomUUID?.() ?? ''

/**
 * Permanent identity deletion (shared by User Management and HR → Employees).
 * Server preview → reason + confirmation + typed phrase → server re-check and
 * deletion in one database transaction (/api/identity/permanent-delete). The
 * request id is kept while the preview is unchanged, so a retry after a lost
 * response is answered with the recorded outcome instead of acting twice.
 */
export default function PermanentDeleteDialog({ target, entry, onClose, onDeleted, onArchiveInstead, notify }: PermanentDeleteDialogProps) {
    const [preview, setPreview] = useState<Preview | null>(null)
    const [loading, setLoading] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [reason, setReason] = useState('')
    const [confirmed, setConfirmed] = useState(false)
    const [typed, setTyped] = useState('')
    const [requestId, setRequestId] = useState('')

    const loadPreview = async (userId: string) => {
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`/api/identity/permanent-delete?entry=${entry}&user_id=${encodeURIComponent(userId)}`, { cache: 'no-store' })
            const json = await res.json()
            if (!res.ok || !json.success) {
                setPreview(null)
                setError(json.error || 'The eligibility check failed.')
            } else {
                setPreview(json.data as Preview)
            }
        } catch (err: any) {
            setPreview(null)
            setError(err?.message || 'The eligibility check failed.')
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        if (!target) return
        setPreview(null)
        setReason('')
        setConfirmed(false)
        setTyped('')
        setRequestId(newRequestId())
        loadPreview(target.id)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target?.id, entry])

    const close = () => { if (!submitting) onClose() }

    const phrase = preview?.confirmation_phrase ?? ''
    const phraseMatches = !!phrase && typed.trim().toLowerCase() === phrase.trim().toLowerCase()
    const canSubmit = !!preview?.allowed && !loading && !submitting && confirmed && reason.trim().length >= 10 && phraseMatches && !!requestId

    const submit = async () => {
        if (!target || !preview || !canSubmit) return
        setSubmitting(true)
        setError(null)
        try {
            const res = await fetch('/api/identity/permanent-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user_id: target.id, entry, request_id: requestId, preview_token: preview.preview_token,
                    reason: reason.trim(), confirmation: typed.trim(),
                }),
            })
            const json = await res.json().catch(() => ({}))
            if (res.ok && json.success && json.data?.status === 'completed' && json.data?.authVerified === true) {
                notify?.({ title: 'Deleted permanently', description: `${preview.target.full_name || target.name} was removed from User Management, HR and sign-in.` })
                await onDeleted({ userId: target.id, name: preview.target.full_name || target.name })
                onClose()
                return
            }
            if (json.code === 'BLOCKED' || json.code === 'PREVIEW_STALE') {
                // The server re-checked and refused: show the current state with a fresh request.
                setRequestId(newRequestId())
                setConfirmed(false)
                await loadPreview(target.id)
            }
            setError(json.error || 'Nothing was deleted.')
            notify?.({ title: 'Not deleted', description: json.error || 'Nothing was deleted.', variant: 'destructive' })
        } catch (err: any) {
            setError('The result could not be confirmed. Submit again to check — repeating the same request is safe.')
        } finally {
            setSubmitting(false)
        }
    }

    const employment = preview?.employment?.[0]
    return (
        <Dialog open={!!target} onOpenChange={(open) => { if (!open) close() }}>
            <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-red-700">
                        <Trash2 className="h-4 w-4" /> {entry === 'hr' ? 'Delete Employee Permanently' : 'Delete User Permanently'}
                    </DialogTitle>
                    <DialogDescription>
                        Removes the person&apos;s login, user account{entry === 'hr' ? ', HR employment record' : ' and any HR employment record'} in one step.
                        This cannot be undone.
                    </DialogDescription>
                </DialogHeader>

                <div className="rounded-lg border px-3 py-2 text-sm">
                    <div className="font-medium">{preview?.target.full_name || target?.name || 'Unknown'}</div>
                    {preview && (
                        <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
                            <div>{[preview.target.email, preview.target.phone].filter(Boolean).join(' · ') || 'No email or phone'}</div>
                            <div>{preview.target.organization_name || 'No organization'}</div>
                            {employment && (
                                <div className="font-mono">Employee no. {employment.employee_no ?? '—'} · {ONBOARDING_LABEL[employment.onboarding_status] ?? employment.onboarding_status}</div>
                            )}
                            {!preview.target.has_identity && <div className="text-amber-700">Only a leftover login exists (no user account).</div>}
                        </div>
                    )}
                </div>

                {loading ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Checking eligibility…
                    </div>
                ) : !preview ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                        {error || 'The eligibility check failed.'}
                    </div>
                ) : (
                    <div className="space-y-3">
                        {preview.allowed ? (
                            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                                <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" /> Eligible — irreversible</div>
                                <p className="mt-1 text-xs">
                                    The person disappears from User Management, HR Employees and Awaiting onboarding, and can no longer sign in.
                                    {entry === 'user_management' && employment && ' This person has an HR employment record; it is deleted too.'}
                                </p>
                            </div>
                        ) : (
                            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" /> Permanent deletion is not available</div>
                                <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
                                    {preview.blockers.map((b, i) => <li key={`${b.code}-${b.table ?? ''}-${i}`}>{b.message || b.code}</li>)}
                                </ul>
                                {onArchiveInstead && target && (
                                    <Button variant="outline" size="sm" className="mt-2" onClick={() => onArchiveInstead(target)}>
                                        Archive &amp; Revoke Access instead (history kept)
                                    </Button>
                                )}
                            </div>
                        )}

                        <div className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
                            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground"><ShieldCheck className="h-3.5 w-3.5" /> What happens</div>
                            <ul className="list-disc space-y-0.5 pl-5">
                                <li>Deleted: login{preview.target.has_identity ? ', user account' : ''}{preview.cleanup.map(c => `, ${c.label ?? c.table} (${c.count})`).join('')}</li>
                                <li>Kept: {preview.retained.length > 0 ? `${preview.retained.map(r => r.table).join(', ')} (audit logs) and ` : ''}a permanent deletion record with who, why and what was removed</li>
                                <li>Never deleted or re-assigned: Supply Chain, Finance, payroll and other people&apos;s records</li>
                            </ul>
                        </div>

                        {preview.allowed && (
                            <>
                                <div className="space-y-1.5">
                                    <Label htmlFor="permanent-delete-reason" className="text-xs">Reason (required)</Label>
                                    <Textarea id="permanent-delete-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
                                        placeholder="e.g. Duplicate test account created before go-live" />
                                    {reason.trim().length > 0 && reason.trim().length < 10 && (
                                        <p className="text-[11px] text-red-600">Enter at least 10 characters.</p>
                                    )}
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="permanent-delete-phrase" className="text-xs">
                                        Type <span className="font-mono font-semibold text-foreground">{phrase}</span> to confirm
                                    </Label>
                                    <Input id="permanent-delete-phrase" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
                                </div>
                                <label className="flex items-start gap-2 text-xs">
                                    <Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)} className="mt-0.5" />
                                    <span>I understand that {preview.target.full_name || 'this person'} will be deleted permanently and this cannot be undone.</span>
                                </label>
                            </>
                        )}

                        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={close} disabled={submitting}>Cancel</Button>
                    <Button variant="destructive" onClick={submit} disabled={!canSubmit}>
                        {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
                        Delete permanently
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
