'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Database, UserX, Trash2, Loader2, AlertOctagon, AlertTriangle, ShieldCheck, CheckCircle2,
  History, RefreshCw, Lock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'

// ── Types ────────────────────────────────────────────────────────

type ResetKind = 'onboarding' | 'full'

interface ResetOrganization { id: string; name: string; code: string | null; phase: string; eligible: boolean }

interface Eligibility { super_admin: boolean; reset_permission: boolean; phase: string; eligible: boolean }

interface ResetRun {
  id: string
  kind: ResetKind
  status: 'completed' | 'blocked'
  reason: string
  counts: Record<string, number>
  onboarding_reset: number
  snapshot_rows: number
  created_at: string
}

interface PlanTable { table: string; category: string; label: string; count: number | null }
interface Blocker { code: string; table?: string; message: string; count?: number }

interface Preview {
  organization: { id: string; name: string; code: string | null }
  kind: ResetKind
  onboarding: { to_reset: number; already_awaiting: number }
  delete: PlanTable[]
  delete_total: number
  not_present: Array<{ table: string; category: string; label: string }>
  keep: PlanTable[]
  blockers: Blocker[]
  warnings: Array<{ code: string; table: string; trigger: string }>
  preserved: string[]
  confirmation_phrase: string
  preview_token: string
  generated_at: string
}

const CATEGORY_LABELS: Record<string, string> = {
  attendance: 'Attendance',
  leave: 'Leave',
  payroll: 'Payroll',
  compensation: 'Compensation',
  allowances_deductions: 'Allowances & deductions',
  performance: 'Performance',
  configuration: 'HR configuration',
  employment_records: 'Employment records',
  not_in_scope: 'Other HR areas (not part of this reset)',
}

const KIND_COPY: Record<ResetKind, { title: string; summary: string; button: string }> = {
  onboarding: {
    title: 'Reset Employee Onboarding',
    summary:
      'Removes employees of the organization from the onboarded list until HR registers them again through Add Employee. '
      + 'Employment records, employee numbers, profiles and HR history are kept. This is not a resignation, termination or '
      + 'suspension: logins, access and other modules are unaffected. Employee self-service shows a pending-setup screen '
      + 'until HR completes onboarding again.',
    button: 'Review onboarding reset',
  },
  full: {
    title: 'Reset All HR Data',
    summary:
      'Resets onboarding and removes HR operational data of the organization: attendance, leave, payroll, compensation, '
      + 'allowances/deductions and performance. HR configuration (departments, positions, holidays, workweek, leave types, '
      + 'approval rules, salary setup) and employment records are kept. Blocked when Finance postings or other modules depend on the data.',
    button: 'Review full HR reset',
  },
}

const newRequestId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
    })

// ── Component ────────────────────────────────────────────────────

export default function HrDataManagementSection() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [eligibility, setEligibility] = useState<Eligibility | null>(null)
  const [organizations, setOrganizations] = useState<ResetOrganization[]>([])
  const [organizationId, setOrganizationId] = useState<string | null>(null)
  const [history, setHistory] = useState<ResetRun[]>([])

  const [kind, setKind] = useState<ResetKind | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string>('')
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [executing, setExecuting] = useState(false)
  const [executeError, setExecuteError] = useState<string | null>(null)
  const [result, setResult] = useState<{ counts?: Record<string, number>; onboarding_reset?: number; snapshot_rows?: number; replayed?: boolean } | null>(null)

  const load = useCallback(async (orgId?: string | null) => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`/api/hr/data-management${orgId ? `?organization_id=${orgId}` : ''}`)
      const json = await res.json()
      if (!json.success) {
        setLoadError(json.error || 'Data Management is unavailable.')
        return
      }
      setEligibility(json.data.eligibility)
      setOrganizations(json.data.organizations || [])
      setOrganizationId(json.data.selected_organization_id)
      setHistory(json.data.history || [])
    } catch (err: any) {
      setLoadError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const selected = organizations.find(o => o.id === organizationId) || null

  const openPreview = async (nextKind: ResetKind) => {
    if (!organizationId) return
    setKind(nextKind)
    setPreview(null)
    setPreviewError(null)
    setExecuteError(null)
    setResult(null)
    setReason('')
    setConfirmation('')
    setPreviewLoading(true)
    try {
      const res = await fetch('/api/hr/data-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: organizationId, kind: nextKind }),
      })
      const json = await res.json()
      if (json.success) {
        setPreview(json.data)
        // One idempotency key per reviewed preview: a repeated click or retry
        // returns the recorded outcome instead of running twice.
        setRequestId(newRequestId())
      } else {
        setPreviewError(json.error || 'The preview could not be produced.')
      }
    } catch (err: any) {
      setPreviewError(err.message)
    } finally {
      setPreviewLoading(false)
    }
  }

  const closeDialog = () => {
    if (executing) return
    setKind(null)
    setPreview(null)
    setResult(null)
  }

  const canExecute = !!preview && preview.blockers.length === 0 && reason.trim().length >= 10
    && confirmation === preview.confirmation_phrase && !executing && !result

  const execute = async () => {
    if (!preview || !kind || !canExecute) return
    setExecuting(true)
    setExecuteError(null)
    try {
      const res = await fetch('/api/hr/data-management/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organization_id: preview.organization.id,
          kind,
          request_id: requestId,
          preview_token: preview.preview_token,
          reason: reason.trim(),
          confirmation,
        }),
      })
      const json = await res.json()
      if (json.success) {
        setResult(json.data)
        toast({ title: 'HR reset completed', description: `${preview.organization.name}: a restorable snapshot was kept.` })
        load(preview.organization.id)
      } else if (json.code === 'PREVIEW_STALE') {
        setExecuteError('The data changed after this preview. Refresh the preview and review it again. Nothing was changed.')
      } else if (json.code === 'BLOCKED') {
        setExecuteError('The reset is blocked by dependencies found at execution time. Nothing was changed.')
        setPreview(p => p ? { ...p, blockers: json.data?.blockers || p.blockers } : p)
        load(preview.organization.id)
      } else {
        setExecuteError(json.error || 'The reset did not run. Nothing was changed.')
      }
    } catch (err: any) {
      setExecuteError(err.message)
    } finally {
      setExecuting(false)
    }
  }

  const deleteByCategory = useMemo(() => {
    const groups = new Map<string, PlanTable[]>()
    for (const t of preview?.delete || []) {
      groups.set(t.category, [...(groups.get(t.category) || []), t])
    }
    return [...groups.entries()]
  }, [preview])

  const keepByCategory = useMemo(() => {
    const groups = new Map<string, PlanTable[]>()
    for (const t of preview?.keep || []) {
      const category = t.category.startsWith('kept_by_onboarding_reset:') ? t.category.split(':')[1] : t.category
      groups.set(category, [...(groups.get(category) || []), t])
    }
    return [...groups.entries()]
  }, [preview])

  // ── Render ──────────────────────────────────────────────────

  return (
    <Card className="border-red-200 dark:border-red-900/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-5 w-5 text-red-600" />
            Data Management
          </CardTitle>
          <Button variant="ghost" size="sm" className="gap-1" onClick={() => load(organizationId)} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        <CardDescription>
          Reset HR registration or HR operational data before HR goes live. Every reset shows a preview, keeps a restorable snapshot and is permanently recorded.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !organizations.length ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : loadError ? (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{loadError}
          </div>
        ) : organizations.length === 0 ? (
          <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3 text-sm">
            <Lock className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <div className="font-medium">Restricted</div>
              <p className="text-xs text-muted-foreground">
                HR resets require a Super Admin who also holds the “HR Data Reset Administrator” role for the organization in Security &amp; Access,
                and are only available while the organization&apos;s HR has not gone live.
              </p>
              {eligibility && (
                <div className="flex flex-wrap gap-1 pt-1">
                  <Badge variant="outline" className="text-[10px]">Super Admin: {eligibility.super_admin ? 'yes' : 'no'}</Badge>
                  <Badge variant="outline" className="text-[10px]">Reset role: {eligibility.reset_permission ? 'yes' : 'no'}</Badge>
                  <Badge variant="outline" className="text-[10px]">HR: {eligibility.phase === 'pre_go_live' ? 'not live yet' : eligibility.phase === 'live' ? 'live' : 'not configured'}</Badge>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <Label className="text-sm shrink-0">Organization</Label>
              <Select value={organizationId ?? undefined} onValueChange={v => load(v)}>
                <SelectTrigger className="w-full sm:w-[320px]"><SelectValue placeholder="Select organization" /></SelectTrigger>
                <SelectContent>
                  {organizations.map(o => (
                    <SelectItem key={o.id} value={o.id}>{o.name}{o.code ? ` (${o.code})` : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selected && (
                <Badge variant="outline" className={selected.phase === 'pre_go_live' ? 'border-blue-200 text-blue-700' : 'border-green-200 text-green-700'}>
                  {selected.phase === 'pre_go_live' ? 'HR not live yet' : 'HR is live'}
                </Badge>
              )}
            </div>

            <div className="divide-y rounded-md border">
              {(['onboarding', 'full'] as ResetKind[]).map(k => (
                <div key={k} className="flex flex-col sm:flex-row sm:items-center gap-3 p-4">
                  <div className={`flex-shrink-0 rounded-full p-2 ${k === 'full' ? 'bg-red-50 dark:bg-red-900/20' : 'bg-amber-50 dark:bg-amber-900/20'}`}>
                    {k === 'full' ? <Trash2 className="h-4 w-4 text-red-600" /> : <UserX className="h-4 w-4 text-amber-600" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{KIND_COPY[k].title}</div>
                    <p className="text-xs text-muted-foreground mt-0.5">{KIND_COPY[k].summary}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className={k === 'full' ? 'border-red-200 text-red-700 hover:bg-red-50' : ''}
                    disabled={!selected?.eligible}
                    onClick={() => openPreview(k)}
                  >
                    {KIND_COPY[k].button}
                  </Button>
                </div>
              ))}
            </div>
            {selected && !selected.eligible && (
              <p className="text-xs text-muted-foreground">Resets are unavailable because HR for this organization is live.</p>
            )}

            {history.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  <History className="h-3.5 w-3.5" /> Recent resets
                </div>
                <div className="divide-y rounded-md border text-xs">
                  {history.map(run => (
                    <div key={run.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <Badge variant="outline" className={run.status === 'completed' ? 'border-green-200 text-green-700' : 'border-red-200 text-red-700'}>
                        {run.status === 'completed' ? 'Completed' : 'Blocked'}
                      </Badge>
                      <span className="font-medium">{run.kind === 'full' ? 'All HR data' : 'Onboarding'}</span>
                      <span className="text-muted-foreground">{new Date(run.created_at).toLocaleString()}</span>
                      {run.status === 'completed' && (
                        <span className="text-muted-foreground">
                          · {run.onboarding_reset} onboarding · {Object.values(run.counts || {}).reduce((a, b) => a + Number(b || 0), 0)} records
                        </span>
                      )}
                      <span className="w-full text-muted-foreground truncate">{run.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>

      {/* ─── Preview / confirmation dialog ─── */}
      <Dialog open={!!kind} onOpenChange={open => { if (!open) closeDialog() }}>
        <DialogContent className="sm:max-w-[720px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {kind === 'full' ? <Trash2 className="h-5 w-5 text-red-600" /> : <UserX className="h-5 w-5 text-amber-600" />}
              {kind ? KIND_COPY[kind].title : ''}
            </DialogTitle>
            <DialogDescription>
              {preview ? `${preview.organization.name}${preview.organization.code ? ` (${preview.organization.code})` : ''}` : 'Preparing preview…'}
            </DialogDescription>
          </DialogHeader>

          {previewLoading && <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
          {previewError && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertOctagon className="h-4 w-4 mt-0.5 shrink-0" />{previewError}
            </div>
          )}

          {preview && !result && (
            <div className="space-y-4 text-sm">
              {/* Blockers */}
              {preview.blockers.length > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 space-y-1.5 dark:bg-red-900/20 dark:border-red-800">
                  <div className="flex items-center gap-1.5 font-medium text-red-700 dark:text-red-300">
                    <AlertOctagon className="h-4 w-4" /> Blocked — nothing can be reset until these are resolved
                  </div>
                  <ul className="list-disc pl-5 text-xs text-red-700 dark:text-red-300 space-y-0.5">
                    {preview.blockers.map((b, i) => <li key={i}>{b.message}</li>)}
                  </ul>
                </div>
              )}

              {/* Affected */}
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Will be reset</div>
                <div className="rounded-md border divide-y">
                  <div className="flex items-center justify-between px-3 py-2">
                    <span>Employee onboarding (employees return to “Awaiting onboarding”)</span>
                    <Badge variant="secondary">{preview.onboarding.to_reset}</Badge>
                  </div>
                  {deleteByCategory.map(([category, tables]) => (
                    <div key={category} className="px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{CATEGORY_LABELS[category] ?? category}</span>
                        <Badge variant="secondary">{tables.reduce((n, t) => n + Number(t.count || 0), 0)}</Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        {tables.map(t => <span key={t.table}>{t.label}: {t.count}</span>)}
                      </div>
                    </div>
                  ))}
                </div>
                {preview.onboarding.already_awaiting > 0 && (
                  <p className="text-xs text-muted-foreground">{preview.onboarding.already_awaiting} employee(s) are already awaiting onboarding and stay that way.</p>
                )}
                {preview.not_present.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Not set up in this system (nothing to reset): {preview.not_present.map(t => t.label).join(', ')}.
                  </p>
                )}
                {preview.warnings.length > 0 && (
                  <p className="flex items-start gap-1.5 text-xs text-amber-700">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    Automatic rules run when these records are removed ({[...new Set(preview.warnings.map(w => w.table))].join(', ')}). They run inside the same all-or-nothing reset.
                  </p>
                )}
              </div>

              {/* Preserved */}
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Preserved</div>
                <ul className="space-y-1 text-xs">
                  {preview.preserved.map(item => (
                    <li key={item} className="flex items-start gap-1.5"><ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-600" />{item}</li>
                  ))}
                </ul>
                <details className="rounded-md border px-3 py-2 text-xs">
                  <summary className="cursor-pointer font-medium">Kept data in this organization</summary>
                  <div className="mt-2 space-y-2">
                    {keepByCategory.map(([category, tables]) => (
                      <div key={category}>
                        <div className="font-medium">{CATEGORY_LABELS[category] ?? category}</div>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
                          {tables.map(t => <span key={t.table}>{t.label}{t.count !== null ? `: ${t.count}` : ''}</span>)}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              </div>

              {/* Confirmation */}
              {preview.blockers.length === 0 && (
                <div className="space-y-3 rounded-md border border-red-200 p-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="hr-reset-reason">Reason *</Label>
                    <Textarea id="hr-reset-reason" rows={2} value={reason} onChange={e => setReason(e.target.value)}
                      placeholder="Why is this reset needed? (at least 10 characters)" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="hr-reset-confirm">
                      Type <span className="font-mono font-semibold">{preview.confirmation_phrase}</span> to confirm
                    </Label>
                    <Input id="hr-reset-confirm" value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    A restorable snapshot of every affected record is kept before anything changes. If anything fails, nothing is changed.
                  </p>
                </div>
              )}

              {executeError && (
                <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{executeError}
                </div>
              )}
            </div>
          )}

          {result && (
            <div className="space-y-3 text-sm">
              <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 p-3 text-green-800">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">{result.replayed ? 'This reset had already been completed.' : 'Reset completed.'}</div>
                  <div className="text-xs">
                    {result.onboarding_reset ?? 0} employee(s) now await onboarding
                    {result.counts ? ` · ${Object.values(result.counts).reduce((a, b) => a + Number(b || 0), 0)} HR record(s) removed` : ''}
                    {typeof result.snapshot_rows === 'number' ? ` · ${result.snapshot_rows} record(s) in the snapshot` : ''}
                  </div>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            {result ? (
              <Button onClick={closeDialog}>Close</Button>
            ) : (
              <>
                <Button variant="outline" onClick={closeDialog} disabled={executing}>Cancel</Button>
                {kind && executeError && !executing && (
                  <Button variant="outline" onClick={() => openPreview(kind)}>
                    <RefreshCw className="h-4 w-4 mr-1" />Refresh preview
                  </Button>
                )}
                <Button variant="destructive" onClick={execute} disabled={!canExecute}>
                  {executing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Trash2 className="h-4 w-4 mr-1" />}
                  {kind === 'full' ? 'Reset all HR data' : 'Reset onboarding'}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
