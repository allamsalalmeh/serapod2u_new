'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useToast } from '@/components/ui/use-toast'
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  ClipboardCheck,
  GitBranch,
  Info,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react'
import { listDepartments, type Department } from '@/lib/actions/departments'
import { nextPositionCode, prefixFromName } from '@/lib/hr/positions/code'
import { isBackdated, isFutureDated } from '@/lib/hr/positions/validation'
import type { LifecycleStatus } from '@/lib/hr/positions/types'

/**
 * Create Position — full-page flow for Position Management V1.1.
 *
 * Creating a position never writes live data: it creates a CREATE_POSITION
 * change request (draft), optionally submitted straight into approval. The
 * slot only appears in the position list once the request is approved and
 * activated (effective, or scheduled for a future effective date).
 */

interface HrCreatePositionViewProps {
  organizationId: string
  onCancel: () => void
  onDone: () => void
  onViewRequests: () => void
}

interface SlotOption {
  id: string
  position_code: string
  name: string
  org_tier: string | null
  lifecycle_status: string
  incumbent_name?: string | null
}

interface JobClassification { id: string; code: string; name: string }

interface ChangeRequestRow {
  id: string
  request_type: string
  status: string
  change_payload: Record<string, unknown>
}

type InitialStatus = Extract<LifecycleStatus, 'active' | 'inactive' | 'frozen'>

interface CreateForm {
  name: string
  code: string
  classificationId: string
  departmentId: string
  businessUnit: string
  orgTier: string
  parentId: string
  lifecycle: InitialStatus
  effectiveDate: string
}

interface CreatedResult {
  requestId: string
  positionCode: string
  submitted: boolean
  submitError: string | null
  form: CreateForm
}

const NONE = 'none'
const OPEN_REQUEST_STATUSES = new Set(['draft', 'pending', 'returned', 'approved', 'scheduled'])
const DEFAULT_TIERS = ['Executive', 'Senior Management', 'Management', 'Supervisory', 'Professional', 'Operational']
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]*$/

const LIFECYCLE_OPTIONS: { value: InitialStatus; label: string; hint: string }[] = [
  { value: 'active', label: 'Active', hint: 'Open for assignment once approved' },
  { value: 'inactive', label: 'Inactive', hint: 'Defined but not in use yet' },
  { value: 'frozen', label: 'Frozen', hint: 'Hiring freeze — no new assignments' },
]

const today = () => new Date().toISOString().slice(0, 10)

const emptyForm = (): CreateForm => ({
  name: '',
  code: '',
  classificationId: NONE,
  departmentId: NONE,
  businessUnit: '',
  orgTier: '',
  parentId: NONE,
  lifecycle: 'active',
  effectiveDate: today(),
})

const json = async <T,>(res: Response) => res.json() as Promise<{ success: boolean; data?: T; error?: string; position_code?: string }>

const formatDate = (value: string) => {
  if (!value) return '—'
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Build the PRIMARY parent map from either org-chart response shape (RPC nodes or fallback edges). */
const parentMapFrom = (payload: any): Map<string, string | null> => {
  const map = new Map<string, string | null>()
  const edges: any[] = Array.isArray(payload?.edges) ? payload.edges : []
  for (const e of edges) {
    if ((e.relationship_type ?? 'PRIMARY') === 'PRIMARY') map.set(e.position_id, e.parent_position_id ?? null)
  }
  const nodes: any[] = Array.isArray(payload?.nodes) ? payload.nodes : []
  for (const n of nodes) {
    if (n.parent_position_id !== undefined && (n.relationship_type ?? 'PRIMARY') === 'PRIMARY' && !map.has(n.id)) {
      map.set(n.id, n.parent_position_id ?? null)
    }
  }
  return map
}

function Field({ id, label, required, optional, hint, error, children }: {
  id?: string
  label: string
  required?: boolean
  optional?: boolean
  hint?: React.ReactNode
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-sm font-medium text-gray-800">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
        {optional && <span className="ml-1 font-normal text-gray-400">(optional)</span>}
      </Label>
      {children}
      {error ? (
        <p id={id ? `${id}-error` : undefined} className="flex items-center gap-1 text-xs text-red-600" role="alert">
          <AlertTriangle className="h-3 w-3" /> {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-gray-500">{hint}</p>
      ) : null}
    </div>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="border-b last:border-b-0">
      <div className="px-5 pt-5 sm:px-6">
        <h3 className="text-sm font-semibold text-gray-950">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-gray-500">{description}</p>}
      </div>
      <div className="space-y-5 p-5 sm:px-6">{children}</div>
    </section>
  )
}

function PreviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
      <span className="shrink-0 text-gray-500">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-gray-900">{children}</span>
    </div>
  )
}

export default function HrCreatePositionView({ organizationId, onCancel, onDone, onViewRequests }: HrCreatePositionViewProps) {
  const { toast } = useToast()
  const [form, setForm] = useState<CreateForm>(emptyForm)
  const [codeTouched, setCodeTouched] = useState(false)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [attempted, setAttempted] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(true)
  const [reportsToOpen, setReportsToOpen] = useState(false)
  const [saving, setSaving] = useState<null | 'draft' | 'submit'>(null)
  const [created, setCreated] = useState<CreatedResult | null>(null)

  const [loading, setLoading] = useState(true)
  const [slots, setSlots] = useState<SlotOption[]>([])
  const [classifications, setClassifications] = useState<JobClassification[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [openRequests, setOpenRequests] = useState<ChangeRequestRow[]>([])
  const [parentMap, setParentMap] = useState<Map<string, string | null>>(new Map())

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const [slotsRes, jcRes, reqRes, chartRes, deptRes] = await Promise.all([
          fetch('/api/hr/position-slots?limit=2000').then(json<SlotOption[]>),
          fetch('/api/hr/job-classifications').then(json<JobClassification[]>),
          fetch('/api/hr/position-change-requests').then(json<ChangeRequestRow[]>),
          fetch('/api/hr/position-slots/org-chart').then((r) => r.json()).catch(() => null),
          listDepartments(organizationId).catch(() => ({ success: false as const, data: [] as Department[] })),
        ])
        if (cancelled) return
        if (slotsRes.success) setSlots(slotsRes.data ?? [])
        if (jcRes.success) setClassifications(jcRes.data ?? [])
        if (reqRes.success) setOpenRequests((reqRes.data ?? []).filter((r) => OPEN_REQUEST_STATUSES.has(r.status)))
        if (chartRes?.success) setParentMap(parentMapFrom(chartRes))
        if (deptRes.success) setDepartments(deptRes.data ?? [])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [organizationId])

  // Codes already taken by live slots or by open CREATE_POSITION requests.
  const takenCodes = useMemo(() => {
    const codes = slots.map((s) => s.position_code.toUpperCase())
    for (const r of openRequests) {
      if (r.request_type === 'CREATE_POSITION' && r.change_payload?.position_code) {
        codes.push(String(r.change_payload.position_code).toUpperCase())
      }
    }
    return codes
  }, [slots, openRequests])

  const suggestCode = (name: string) => (name.trim() ? nextPositionCode(prefixFromName(name), takenCodes) : '')

  // Keep the auto-generated code in sync with the name until the user edits it.
  useEffect(() => {
    if (!codeTouched) setForm((prev) => ({ ...prev, code: suggestCode(prev.name) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takenCodes, codeTouched])

  const update = (patch: Partial<CreateForm>) => setForm((prev) => ({ ...prev, ...patch }))
  const touch = (key: keyof CreateForm) => setTouched((prev) => ({ ...prev, [key]: true }))

  const handleNameChange = (name: string) => {
    setForm((prev) => ({ ...prev, name, code: codeTouched ? prev.code : suggestCode(name) }))
  }

  const handleRegenerate = () => {
    setCodeTouched(false)
    update({ code: suggestCode(form.name) })
  }

  const parentOptions = useMemo(
    () => slots.filter((s) => s.lifecycle_status !== 'closed').sort((a, b) => a.name.localeCompare(b.name)),
    [slots],
  )
  const selectedParent = useMemo(() => slots.find((s) => s.id === form.parentId) ?? null, [slots, form.parentId])
  const selectedClassification = classifications.find((c) => c.id === form.classificationId) ?? null
  const selectedDepartment = departments.find((d) => d.id === form.departmentId) ?? null

  const tierSuggestions = useMemo(() => {
    const fromData = slots.map((s) => s.org_tier).filter((t): t is string => !!t && t !== 'Unassigned')
    return [...new Set([...fromData, ...DEFAULT_TIERS])]
  }, [slots])

  const errors = useMemo(() => {
    const code = form.code.trim().toUpperCase()
    return {
      name: !form.name.trim()
        ? 'Position name is required.'
        : form.name.trim().length > 120 ? 'Keep the name under 120 characters.' : '',
      code: !code
        ? ''
        : !CODE_PATTERN.test(code)
          ? 'Use uppercase letters, numbers and hyphens only.'
          : code.length > 30
            ? 'Keep the code to 30 characters or fewer.'
            : takenCodes.includes(code)
              ? 'This code is already used by a position or an open request.'
              : '',
      effectiveDate: !form.effectiveDate ? 'Effective date is required.' : '',
    }
  }, [form.name, form.code, form.effectiveDate, takenCodes])

  const showError = (key: keyof typeof errors) => (attempted || touched[key] ? errors[key] : '')
  const isValid = !errors.name && !errors.code && !errors.effectiveDate

  const backdated = !!form.effectiveDate && isBackdated(form.effectiveDate)
  const futureDated = !!form.effectiveDate && isFutureDated(form.effectiveDate)

  // Ancestor chain of the selected parent (root first), for the org-chart preview.
  const ancestry = useMemo(() => {
    if (!selectedParent) return [] as SlotOption[]
    const byId = new Map(slots.map((s) => [s.id, s]))
    const chain: SlotOption[] = []
    const seen = new Set<string>()
    let current: string | null = selectedParent.id
    while (current && !seen.has(current)) {
      seen.add(current)
      const slot = byId.get(current)
      if (!slot) break
      chain.unshift(slot)
      current = parentMap.get(current) ?? null
    }
    return chain
  }, [selectedParent, slots, parentMap])

  const visibleAncestry = ancestry.length > 3 ? ancestry.slice(-3) : ancestry
  const hiddenAncestors = ancestry.length - visibleAncestry.length

  const handleCreate = async (mode: 'draft' | 'submit') => {
    setAttempted(true)
    if (!isValid) {
      toast({ title: 'Check the highlighted fields', description: errors.name || errors.code || errors.effectiveDate, variant: 'destructive' })
      return
    }
    setSaving(mode)
    try {
      const res = await fetch('/api/hr/position-slots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          position_code: form.code.trim().toUpperCase() || undefined,
          job_classification_id: form.classificationId === NONE ? null : form.classificationId,
          department_id: form.departmentId === NONE ? null : form.departmentId,
          business_unit: form.businessUnit.trim() || null,
          org_tier: form.orgTier.trim() || undefined,
          lifecycle_status: form.lifecycle,
          parent_position_id: form.parentId === NONE ? null : form.parentId,
          effective_date: form.effectiveDate || null,
        }),
      }).then(json<{ id: string }>)

      if (!res.success || !res.data) {
        toast({ title: 'Could not create position request', description: res.error || 'Please try again.', variant: 'destructive' })
        return
      }

      let submitted = false
      let submitError: string | null = null
      if (mode === 'submit') {
        const sub = await fetch(`/api/hr/position-change-requests/${res.data.id}/submit`, { method: 'POST' }).then(json)
        submitted = sub.success
        submitError = sub.success ? null : sub.error || 'Submission failed'
      }

      setCreated({
        requestId: res.data.id,
        positionCode: res.position_code ?? form.code,
        submitted,
        submitError,
        form: { ...form },
      })
    } finally {
      setSaving(null)
    }
  }

  const resetForAnother = () => {
    setCreated(null)
    setForm(emptyForm())
    setCodeTouched(false)
    setTouched({})
    setAttempted(false)
    // Refresh taken codes so the next suggestion skips the one just requested.
    setOpenRequests((prev) => created
      ? [...prev, { id: created.requestId, request_type: 'CREATE_POSITION', status: created.submitted ? 'pending' : 'draft', change_payload: { position_code: created.positionCode } }]
      : prev)
  }

  // ── Success state ─────────────────────────────────────────────────────────
  if (created) {
    const f = created.form
    const parentName = slots.find((s) => s.id === f.parentId)?.name
    return (
      <div className="rounded-xl border bg-white p-6 text-center shadow-sm sm:p-10">
        <div className={`mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full ${created.submitted ? 'bg-emerald-50 text-emerald-600' : 'bg-indigo-50 text-indigo-600'}`}>
          {created.submitted ? <CheckCircle2 className="h-8 w-8" /> : <ClipboardCheck className="h-8 w-8" />}
        </div>
        <h2 className="text-2xl font-semibold text-gray-950">
          {created.submitted ? 'Submitted for Approval' : 'Draft Request Saved'}
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-gray-500">
          {created.submitted
            ? `${f.name} will be added to the organization structure once the change request is approved.`
            : `${f.name} is saved as a draft change request. Submit it from Change Requests when you are ready.`}
        </p>
        {created.submitError && (
          <div className="mx-auto mt-4 flex max-w-xl items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>The draft was saved but could not be submitted: {created.submitError}. You can submit it from Change Requests.</span>
          </div>
        )}

        <dl className="mx-auto mt-8 grid max-w-4xl overflow-hidden rounded-lg border text-left sm:grid-cols-2 lg:grid-cols-5">
          {[
            ['Position Code', <span key="c" className="font-mono">{created.positionCode}</span>],
            ['Job Classification', classifications.find((c) => c.id === f.classificationId)?.name ?? '—'],
            ['Reports To', parentName ?? 'Top-level position'],
            ['Effective Date', formatDate(f.effectiveDate)],
            ['Request Status', <Badge key="s" className={created.submitted ? 'bg-blue-100 text-blue-700 hover:bg-blue-100' : 'bg-gray-100 text-gray-700 hover:bg-gray-100'}>{created.submitted ? 'Pending Approval' : 'Draft'}</Badge>],
          ].map(([label, value], i) => (
            <div key={String(label)} className={`border-b p-4 lg:border-b-0 ${i < 4 ? 'lg:border-r' : ''} ${i % 2 === 0 ? 'sm:border-r lg:border-r' : ''}`}>
              <dt className="text-xs text-gray-500">{label}</dt>
              <dd className="mt-1.5 font-semibold text-gray-950">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button variant="outline" onClick={onViewRequests}>View Change Requests</Button>
          <Button variant="outline" onClick={resetForAnother}>Create Another</Button>
          <Button onClick={onDone}>Back to Positions</Button>
        </div>
      </div>
    )
  }

  // ── Create form ───────────────────────────────────────────────────────────
  const previewName = form.name.trim() || 'New Position'
  const previewCode = form.code.trim().toUpperCase() || 'AUTO'
  const lifecycleMeta = LIFECYCLE_OPTIONS.find((o) => o.value === form.lifecycle)!

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col gap-4 rounded-xl border bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <Button variant="outline" size="icon" className="h-10 w-10 shrink-0" onClick={onCancel} aria-label="Back to positions">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 sm:flex">
            <Briefcase className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-gray-950">Create Position</h2>
            <p className="text-sm text-gray-500">Define a role within your organization structure.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void handleCreate('draft')} disabled={!!saving || loading}>
            {saving === 'draft' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save as Draft
          </Button>
          <Button variant="ghost" size="icon" onClick={onCancel} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,0.7fr)]">
        {/* Form */}
        <form
          className="rounded-xl border bg-white shadow-sm"
          onSubmit={(e) => { e.preventDefault(); void handleCreate('submit') }}
          noValidate
        >
          <Section title="Basic Information" description="How the position is identified across HR.">
            <Field id="position-name" label="Position Name" required error={showError('name')}>
              <Input
                id="position-name"
                autoFocus
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                onBlur={() => touch('name')}
                placeholder="e.g. Warehouse Supervisor"
                aria-invalid={!!showError('name')}
                aria-describedby={showError('name') ? 'position-name-error' : undefined}
                className={showError('name') ? 'border-red-300 focus-visible:ring-red-200' : ''}
              />
            </Field>

            <Field
              id="position-code"
              label="Position Code"
              error={showError('code')}
              hint={codeTouched ? 'Custom code. Leave blank to auto-generate.' : 'Auto-generated from the position name — edit to set your own.'}
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="position-code"
                  value={form.code}
                  onChange={(e) => { setCodeTouched(true); update({ code: e.target.value.toUpperCase().replace(/\s+/g, '-') }) }}
                  onBlur={() => touch('code')}
                  placeholder="e.g. WS"
                  aria-invalid={!!showError('code')}
                  aria-describedby={showError('code') ? 'position-code-error' : undefined}
                  className={`font-mono ${showError('code') ? 'border-red-300 focus-visible:ring-red-200' : ''}`}
                />
                <Button type="button" variant="outline" onClick={handleRegenerate} disabled={!form.name.trim()}>
                  <RefreshCw className="mr-2 h-4 w-4" /> Regenerate
                </Button>
              </div>
            </Field>

            <Field label="Job Classification" hint="The reusable job definition this slot is an instance of.">
              <Select value={form.classificationId} onValueChange={(v) => update({ classificationId: v })}>
                <SelectTrigger aria-label="Job Classification"><SelectValue placeholder="Select job classification" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not classified</SelectItem>
                  {classifications.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name} <span className="text-gray-400">· {c.code}</span></SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </Section>

          <Section title="Organization & Reporting" description="Where the position sits in your structure.">
            <div className="grid gap-5 md:grid-cols-2">
              <Field label="Department" optional>
                <Select value={form.departmentId} onValueChange={(v) => update({ departmentId: v })}>
                  <SelectTrigger aria-label="Department"><SelectValue placeholder="Select department" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No department</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.dept_name}{d.dept_code ? ` · ${d.dept_code}` : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field id="org-tier" label="Organizational Tier" optional hint="Business rank only — does not grant system access.">
                <Input
                  id="org-tier"
                  list="org-tier-options"
                  value={form.orgTier}
                  onChange={(e) => update({ orgTier: e.target.value })}
                  placeholder="e.g. Management"
                />
                <datalist id="org-tier-options">
                  {tierSuggestions.map((t) => <option key={t} value={t} />)}
                </datalist>
              </Field>
            </div>

            <Field
              label="Primary Reports To"
              hint={selectedParent ? `Solid-line manager position: ${selectedParent.position_code}.` : 'Leave empty to create a top-level position (multiple roots are supported).'}
            >
              <Popover open={reportsToOpen} onOpenChange={setReportsToOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={reportsToOpen}
                    aria-label="Primary Reports To"
                    className="w-full justify-between font-normal"
                    disabled={loading}
                  >
                    <span className={`truncate ${selectedParent ? 'text-gray-900' : 'text-gray-500'}`}>
                      {selectedParent ? `${selectedParent.name} · ${selectedParent.position_code}` : 'None — top-level position'}
                    </span>
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search positions..." />
                    <CommandList>
                      <CommandEmpty>No positions found.</CommandEmpty>
                      <CommandGroup>
                        <CommandItem value="__none__ top-level" onSelect={() => { update({ parentId: NONE }); setReportsToOpen(false) }}>
                          <Check className={`mr-2 h-4 w-4 ${form.parentId === NONE ? 'opacity-100' : 'opacity-0'}`} />
                          None — top-level position
                        </CommandItem>
                        {parentOptions.map((s) => (
                          <CommandItem
                            key={s.id}
                            value={`${s.name} ${s.position_code} ${s.id}`}
                            onSelect={() => { update({ parentId: s.id }); setReportsToOpen(false) }}
                          >
                            <Check className={`mr-2 h-4 w-4 ${form.parentId === s.id ? 'opacity-100' : 'opacity-0'}`} />
                            <div className="min-w-0 flex-1">
                              <div className="truncate">{s.name}</div>
                              <div className="truncate text-xs text-gray-500">
                                <span className="font-mono">{s.position_code}</span>
                                {s.incumbent_name ? ` · ${s.incumbent_name}` : ' · Vacant'}
                              </div>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </Field>
          </Section>

          <section className="border-b">
            <button
              type="button"
              className="flex w-full items-center justify-between px-5 py-4 text-left sm:px-6"
              onClick={() => setAdvancedOpen((o) => !o)}
              aria-expanded={advancedOpen}
              aria-controls="advanced-settings"
            >
              <span>
                <span className="block text-sm font-semibold text-gray-950">Advanced Settings</span>
                <span className="block text-xs text-gray-500">Effective date, initial status and business unit.</span>
              </span>
              {advancedOpen ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
            </button>
            {advancedOpen && (
              <div id="advanced-settings" className="space-y-5 border-t p-5 sm:px-6">
                <div className="grid gap-5 md:grid-cols-2">
                  <Field
                    id="effective-date"
                    label="Effective Date"
                    required
                    error={showError('effectiveDate')}
                    hint={futureDated ? 'Future-dated: the position will be scheduled after approval.' : 'The position goes live as soon as it is approved.'}
                  >
                    <Input
                      id="effective-date"
                      type="date"
                      value={form.effectiveDate}
                      onChange={(e) => update({ effectiveDate: e.target.value })}
                      onBlur={() => touch('effectiveDate')}
                      aria-invalid={!!showError('effectiveDate')}
                    />
                  </Field>
                  <Field id="business-unit" label="Business Unit" optional>
                    <Input
                      id="business-unit"
                      value={form.businessUnit}
                      onChange={(e) => update({ businessUnit: e.target.value })}
                      placeholder="e.g. Northern Region"
                    />
                  </Field>
                </div>
                {backdated && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>This is a backdated change. Approvers will see the original effective date of {formatDate(form.effectiveDate)}.</span>
                  </div>
                )}

                <div className="space-y-2">
                  <Label id="initial-status-label" className="text-sm font-medium text-gray-800">Initial Status</Label>
                  <div role="radiogroup" aria-labelledby="initial-status-label" className="grid gap-2 sm:grid-cols-3">
                    {LIFECYCLE_OPTIONS.map((o) => {
                      const selected = form.lifecycle === o.value
                      return (
                        <button
                          key={o.value}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => update({ lifecycle: o.value })}
                          className={`rounded-lg border px-3 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 ${selected ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50'}`}
                        >
                          <span className={`flex items-center gap-2 text-sm font-medium ${selected ? 'text-indigo-700' : 'text-gray-700'}`}>
                            <span className={`h-2 w-2 rounded-full ${selected ? 'bg-indigo-600' : 'bg-gray-300'}`} />
                            {o.label}
                          </span>
                          <span className="mt-0.5 block text-xs text-gray-500">{o.hint}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}
          </section>

          <div className="flex items-start gap-2 bg-indigo-50/60 px-5 py-3 text-xs text-indigo-800 sm:px-6">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Creating a position raises a <strong>Create Position</strong> change request. Nothing changes in the live
              structure until it is approved by someone other than you.
            </span>
          </div>

          <div className="flex flex-col-reverse gap-2 p-5 sm:flex-row sm:justify-end sm:px-6">
            <Button type="button" variant="ghost" onClick={onCancel} disabled={!!saving}>Cancel</Button>
            <Button type="button" variant="outline" onClick={() => void handleCreate('draft')} disabled={!!saving || loading}>
              {saving === 'draft' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save as Draft
            </Button>
            <Button type="submit" disabled={!!saving || loading}>
              {saving === 'submit' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Submit for Approval
            </Button>
          </div>
        </form>

        {/* Preview */}
        <aside className="xl:sticky xl:top-4 xl:self-start" aria-label="Position preview">
          <div className="rounded-xl border bg-white shadow-sm">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h3 className="text-sm font-semibold text-gray-950">Position Preview</h3>
              <Badge className="bg-indigo-50 text-indigo-700 hover:bg-indigo-50">Live Preview</Badge>
            </div>
            <div className="space-y-5 p-5">
              <div className="flex flex-col items-center text-center">
                <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
                  <Briefcase className="h-6 w-6" />
                </div>
                <p className="font-mono text-xs font-semibold tracking-wide text-gray-500">{previewCode}</p>
                <h3 className="mt-0.5 break-words text-lg font-semibold text-gray-950">{previewName}</h3>
                {selectedClassification && <p className="text-sm text-gray-500">{selectedClassification.name}</p>}
              </div>

              <div className="divide-y rounded-lg border">
                <PreviewRow label="Classification">{selectedClassification?.code ?? '—'}</PreviewRow>
                <PreviewRow label="Department">{selectedDepartment?.dept_name ?? '—'}</PreviewRow>
                <PreviewRow label="Tier">{form.orgTier.trim() || 'Unassigned'}</PreviewRow>
                <PreviewRow label="Reports To">{selectedParent?.name ?? 'Top-level'}</PreviewRow>
                <PreviewRow label="Status">
                  <Badge className={form.lifecycle === 'active' ? 'bg-green-100 text-green-700 hover:bg-green-100' : form.lifecycle === 'frozen' ? 'bg-amber-100 text-amber-700 hover:bg-amber-100' : 'bg-gray-100 text-gray-600 hover:bg-gray-100'}>
                    {lifecycleMeta.label}
                  </Badge>
                </PreviewRow>
                <PreviewRow label="Effective">{formatDate(form.effectiveDate)}</PreviewRow>
              </div>

              <div className="rounded-lg border bg-gray-50 p-4">
                <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-gray-950">
                  <GitBranch className="h-4 w-4 text-gray-500" /> Org Chart Preview
                </p>
                <div className="flex flex-col items-center text-sm">
                  {hiddenAncestors > 0 && (
                    <>
                      <div className="text-xs text-gray-400">+{hiddenAncestors} more above</div>
                      <div className="h-4 w-px bg-gray-300" />
                    </>
                  )}
                  {visibleAncestry.map((s) => (
                    <div key={s.id} className="flex flex-col items-center">
                      <div className="max-w-[240px] truncate rounded-md border bg-white px-4 py-1.5 text-gray-700 shadow-sm">{s.name}</div>
                      <div className="h-5 w-px bg-gray-300" />
                    </div>
                  ))}
                  <div className="max-w-[240px] truncate rounded-md border-2 border-indigo-300 bg-white px-4 py-1.5 font-semibold text-indigo-700 shadow-sm">
                    {previewName}
                  </div>
                </div>
                <p className="mt-3 text-center text-xs text-gray-500">
                  {selectedParent ? `Placed under ${selectedParent.name}.` : 'Placed as a new top-level position.'}
                </p>
              </div>

              <div className="rounded-lg border p-4">
                <p className="mb-3 text-sm font-semibold text-gray-950">Approval Path</p>
                <ol className="space-y-3 text-sm">
                  {[
                    ['Draft change request', 'Created when you save or submit.'],
                    ['Pending approval', 'Routed to HR approvers. You cannot approve your own request.'],
                    futureDated
                      ? ['Scheduled', `Activates on ${formatDate(form.effectiveDate)}.`]
                      : ['Effective', 'Position goes live when approved.'],
                  ].map(([title, desc], i) => (
                    <li key={title} className="flex gap-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-700">{i + 1}</span>
                      <span>
                        <span className="block font-medium text-gray-900">{title}</span>
                        <span className="block text-xs text-gray-500">{desc}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
