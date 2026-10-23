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
import { AlertTriangle, Archive, Loader2, ShieldCheck } from 'lucide-react'

export type ArchiveEntry = 'user_management' | 'hr'
/** archive = Archive & Revoke Access (optionally releasing identifiers); release = release identifiers of an archived account. */
export type ArchiveMode = 'archive' | 'release'

interface Notice { code: string; count?: number; message?: string }
interface Preview {
    target: { user_id: string; full_name: string | null; email: string | null; phone: string | null; organization_name: string | null; employee_no: number | null }
    employment: Array<{ employee_no: number | null; onboarding_status: string; status: string }>
    archived: boolean
    identifiers_released: boolean
    releasable: boolean
    blockers: Notice[]
    warnings: Notice[]
    confirmation_phrase: string
    preview_token: string
    archive_allowed: boolean
    release_allowed: boolean
}

export interface ArchiveIdentityDialogProps {
    target: { id: string; name: string } | null
    entry: ArchiveEntry
    mode?: ArchiveMode
    onClose: () => void
    /** Called after the database confirmed the change; refresh lists and totals here. */
    onDone: (result: { userId: string; name: string; released: boolean }) => void | Promise<void>
    notify?: (message: { title: string; description: string; variant?: 'destructive' }) => void
}

const newRequestId = () => globalThis.crypto?.randomUUID?.() ?? ''

/**
 * Archive & Revoke Access (shared by User Management and HR → Employees).
 * Not a deletion: the person's UUID, name, employee number and every historical
 * record stay; login, sessions and access end; they leave the active lists.
 * Server preview → reason + typed phrase + confirmation → server re-check in one
 * database transaction (/api/identity/archive).
 */
export default function ArchiveIdentityDialog({ target, entry, mode = 'archive', onClose, onDone, notify }: ArchiveIdentityDialogProps) {
    const [preview, setPreview] = useState<Preview | null>(null)
    const [loading, setLoading] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [reason, setReason] = useState('')
    const [confirmed, setConfirmed] = useState(false)
    const [typed, setTyped] = useState('')
    const [release, setRelease] = useState(false)
    const [employmentEnd, setEmploymentEnd] = useState<'resigned' | 'terminated'>('resigned')
    const [requestId, setRequestId] = useState('')

    const loadPreview = async (userId: string) => {
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`/api/identity/archive?entry=${entry}&user_id=${encodeURIComponent(userId)}`, { cache: 'no-store' })
            const json = await res.json()
            if (!res.ok || !json.success) { setPreview(null); setError(json.error || 'The eligibility check failed.') }
            else setPreview(json.data as Preview)
        } catch (err: any) {
            setPreview(null)
            setError(err?.message || 'The eligibility check failed.')
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        if (!target) return
        setPreview(null); setReason(''); setConfirmed(false); setTyped(''); setRelease(false); setEmploymentEnd('resigned')
        setRequestId(newRequestId())
        loadPreview(target.id)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target?.id, entry, mode])

    const close = () => { if (!submitting) onClose() }
    const allowed = !!preview && (mode === 'archive' ? preview.archive_allowed : preview.release_allowed)
    const phrase = preview?.confirmation_phrase ?? ''
    const phraseOk = mode === 'release' || (!!phrase && typed.trim().toLowerCase() === phrase.trim().toLowerCase())
    const canSubmit = allowed && !loading && !submitting && confirmed && reason.trim().length >= 10 && phraseOk && !!requestId
    const hasEmployment = (preview?.employment?.length ?? 0) > 0

    const submit = async () => {
        if (!target || !preview || !canSubmit) return
        setSubmitting(true)
        setError(null)
        try {
            const body = mode === 'archive'
                ? { action: 'archive', user_id: target.id, entry, request_id: requestId, preview_token: preview.preview_token,
                    reason: reason.trim(), confirmation: typed.trim(), release_identifiers: release, employment_end: employmentEnd }
                : { action: 'release', user_id: target.id, entry, request_id: requestId, reason: reason.trim() }
            const res = await fetch('/api/identity/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            const json = await res.json().catch(() => ({}))
            if (res.ok && json.success && json.data?.status === 'completed') {
                const name = preview.target.full_name || target.name
                const released = mode === 'release' || json.data.released === true
                notify?.({
                    title: mode === 'archive' ? 'Archived — access revoked' : 'Email and phone released',
                    description: mode === 'archive'
                        ? `${name} can no longer sign in and has left the active lists. History is kept${released ? '; their email and phone can now be used by a new person' : ''}.`
                        : `${name}'s email and phone can now be registered by a new person. Their history stays with their archived account.`,
                })
                await onDone({ userId: target.id, name, released })
                onClose()
                return
            }
            if (json.code === 'BLOCKED' || json.code === 'PREVIEW_STALE') {
                setRequestId(newRequestId())
                setConfirmed(false)
                await loadPreview(target.id)
            }
            setError(json.error || 'Nothing was changed.')
            notify?.({ title: 'Not changed', description: json.error || 'Nothing was changed.', variant: 'destructive' })
        } catch {
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
                    <DialogTitle className="flex items-center gap-2">
                        <Archive className="h-4 w-4" /> {mode === 'archive' ? 'Archive & Revoke Access' : 'Release Email & Phone'}
                    </DialogTitle>
                    <DialogDescription>
                        {mode === 'archive'
                            ? 'This is not a deletion. The person and their history are kept under their original ID; their sign-in and access end and they leave the active lists.'
                            : 'Frees this archived person\'s email and phone so a different person can register them. Their history stays with the archived account.'}
                    </DialogDescription>
                </DialogHeader>

                <div className="rounded-lg border px-3 py-2 text-sm">
                    <div className="font-medium">{preview?.target.full_name || target?.name || 'Unknown'}</div>
                    {preview && (
                        <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
                            <div>{[preview.target.email, preview.target.phone].filter(Boolean).join(' · ') || (preview.identifiers_released ? 'Email and phone released' : 'No email or phone')}</div>
                            <div>{preview.target.organization_name || 'No organization'}</div>
                            {employment && <div className="font-mono">Employee no. {employment.employee_no ?? '—'} · employment {employment.status}</div>}
                            <div className="font-mono text-[10px]">ID {preview.target.user_id}</div>
                        </div>
                    )}
                </div>

                {loading ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking…</div>
                ) : !preview ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error || 'The eligibility check failed.'}</div>
                ) : (
                    <div className="space-y-3">
                        {!allowed ? (
                            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-4 w-4" /> Not available</div>
                                <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">
                                    {preview.blockers.map((b, i) => <li key={`${b.code}-${i}`}>{b.message || b.code}</li>)}
                                    {preview.blockers.length === 0 && mode === 'archive' && preview.archived && <li>This account is already archived.</li>}
                                    {preview.blockers.length === 0 && mode === 'release' && <li>{preview.identifiers_released ? 'Already released.' : 'Nothing to release.'}</li>}
                                </ul>
                            </div>
                        ) : (
                            <div className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
                                <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground"><ShieldCheck className="h-3.5 w-3.5" /> What happens</div>
                                {mode === 'archive' ? (
                                    <ul className="list-disc space-y-0.5 pl-5">
                                        <li>Sign-in is blocked; active sessions, refresh tokens and password-reset codes end immediately.</li>
                                        <li>All Security &amp; Access assignments, memberships and delegations end (kept as history).</li>
                                        <li>Removed from active User Management and HR lists (incl. Awaiting onboarding); visible under Archived / Former.</li>
                                        <li>Kept unchanged: original ID, name, employee number and every order, stock, document, finance, HR and audit record.</li>
                                        {preview.warnings.map((w, i) => <li key={`${w.code}-${i}`}>{w.message || w.code}</li>)}
                                    </ul>
                                ) : (
                                    <ul className="list-disc space-y-0.5 pl-5">
                                        <li>The email and phone are removed from this archived account and stored in a restricted record.</li>
                                        <li>A different person can then register them and receives a new account (new ID) with no access or history from this one.</li>
                                        <li>If this same person returns, reactivating the archived account restores them (if nobody else took them).</li>
                                    </ul>
                                )}
                            </div>
                        )}

                        {allowed && (
                            <>
                                {mode === 'archive' && hasEmployment && (
                                    <div className="space-y-1.5">
                                        <Label className="text-xs">Employment ends as</Label>
                                        <div className="flex gap-4 text-xs">
                                            {(['resigned', 'terminated'] as const).map(v => (
                                                <label key={v} className="flex items-center gap-1.5">
                                                    <input type="radio" name="employment-end" value={v} checked={employmentEnd === v} onChange={() => setEmploymentEnd(v)} />
                                                    {v === 'resigned' ? 'Resigned' : 'Terminated'}
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {mode === 'archive' && preview.releasable && (
                                    <label className="flex items-start gap-2 text-xs">
                                        <Checkbox checked={release} onCheckedChange={(c) => setRelease(c === true)} className="mt-0.5" aria-label="Release email and phone for reuse" />
                                        <span>Also release the email and phone so a different person can use them (can also be done later from Archived).</span>
                                    </label>
                                )}
                                <div className="space-y-1.5">
                                    <Label htmlFor="archive-reason" className="text-xs">Reason (required)</Label>
                                    <Textarea id="archive-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Resigned effective 31 Oct 2026" />
                                    {reason.trim().length > 0 && reason.trim().length < 10 && <p className="text-[11px] text-red-600">Enter at least 10 characters.</p>}
                                </div>
                                {mode === 'archive' && (
                                    <div className="space-y-1.5">
                                        <Label htmlFor="archive-phrase" className="text-xs">Type <span className="font-mono font-semibold text-foreground">{phrase}</span> to confirm</Label>
                                        <Input id="archive-phrase" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
                                    </div>
                                )}
                                <label className="flex items-start gap-2 text-xs">
                                    <Checkbox checked={confirmed} onCheckedChange={(c) => setConfirmed(c === true)} className="mt-0.5" />
                                    <span>{mode === 'archive'
                                        ? `I confirm that ${preview.target.full_name || 'this person'} should lose all access and be archived.`
                                        : `I confirm that ${preview.target.full_name || 'this person'}'s email and phone should be released for reuse.`}</span>
                                </label>
                            </>
                        )}
                        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}
                    </div>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={close} disabled={submitting}>Cancel</Button>
                    <Button onClick={submit} disabled={!canSubmit}>
                        {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Archive className="h-4 w-4 mr-1" />}
                        {mode === 'archive' ? 'Archive & revoke access' : 'Release email & phone'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
