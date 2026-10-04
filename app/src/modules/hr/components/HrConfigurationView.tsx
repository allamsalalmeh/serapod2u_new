'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Wrench, Upload, Image as ImageIcon, Trash2, Save, Loader2,
  CheckCircle2, AlertTriangle, XCircle, ArrowRight, Zap,
  Building, Clock, Calendar, Wallet, Shield, RefreshCw,
  AlertOctagon, Info, ChevronDown, ChevronUp, Bot,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/use-toast'
import { getStorageUrl } from '@/lib/utils'
import { cn } from '@/lib/utils'
import AiProviderSettingsCard from './AiProviderSettingsCard'
import HrDataManagementSection from './HrDataManagementSection'

// ── Types ────────────────────────────────────────────────────────

interface HrConfigurationViewProps {
  organizationId: string
  canEdit: boolean
  onNavigate?: (viewId: string) => void
}

interface HrConfig {
  banner_image_url: string | null
  updated_at: string | null
}

type AuditStatus = 'configured' | 'partial' | 'missing'

interface AuditCheck {
  key: string
  label: string
  status: AuditStatus
  detail: string
  link?: string
  linkLabel?: string
  autoSetupKey?: string
  count?: number
}

interface AuditSection {
  section: string
  icon: string
  checks: AuditCheck[]
}

interface AuditData {
  sections: AuditSection[]
  summary: { total: number; configured: number; partial: number; missing: number }
}

const SECTION_ICONS: Record<string, React.ElementType> = {
  building: Building,
  clock: Clock,
  calendar: Calendar,
  wallet: Wallet,
  shield: Shield,
}

const STATUS_CONFIG: Record<AuditStatus, { icon: React.ElementType; color: string; bg: string; label: string }> = {
  configured: { icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50 dark:bg-green-900/20', label: 'Configured' },
  partial: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-900/20', label: 'Partial' },
  missing: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-50 dark:bg-red-900/20', label: 'Missing' },
}

// ── Guided Setup explanations ────────────────────────────────────

const GUIDED_EXPLANATIONS: Record<string, { why: string; impact: string }> = {
  timezone: {
    why: 'Timezone determines how attendance clock-in/out times are recorded and calculated.',
    impact: 'Without timezone, attendance may record wrong times and payroll proration will be inaccurate.',
  },
  workweek: {
    why: 'Workweek template defines which days are working days for attendance and leave calculation.',
    impact: 'Leave entitlement calculation, attendance tracking, and payroll prorations will be wrong.',
  },
  holidays: {
    why: 'Public holiday calendar is mandatory for leave, attendance, and payroll proration.',
    impact: 'Employees may be marked absent on public holidays. Payroll proration will overcharge.',
  },
  attendance_policy: {
    why: 'Attendance policy defines grace periods, shift requirements, and overtime rules.',
    impact: 'Clock-in/out tracking, late detection, and overtime calculation will not function.',
  },
  shifts: {
    why: 'Shifts define working hours for employees (only required if shift-based).',
    impact: 'If shifts are required but not configured, employees cannot clock in.',
  },
  overtime: {
    why: 'Overtime rules define how extra hours are calculated and compensated.',
    impact: 'Disabled = no OT tracking. This is acceptable if your company does not pay overtime.',
  },
  timesheet_config: {
    why: 'Timesheet periods define the cycle for attendance reports and approvals.',
    impact: 'Using default weekly periods — may not match your payroll cycle.',
  },
  leave_types: {
    why: 'Leave types (Annual, Sick, Unpaid, etc.) are required before employees can apply for leave.',
    impact: 'The entire Leave Management module is blocked without at least one leave type.',
  },
  approval_chains: {
    why: 'Approval chains define who approves leave requests (Manager → HR flow).',
    impact: 'Leave requests will have no approvers and cannot be processed.',
  },
  delegation_rules: {
    why: 'Delegation rules handle approval when the primary approver is absent.',
    impact: 'If an approver is on leave, requests will be stuck waiting indefinitely.',
  },
  carry_forward: {
    why: 'Carry-forward rules define whether unused leave days roll over to the next year.',
    impact: 'Without carry-forward, all unused leave is forfeited at year-end by default.',
  },
  salary_bands: {
    why: 'Salary bands define pay grades and ranges used in payroll processing.',
    impact: 'Payroll cannot run without salary structure — no payslips can be generated.',
  },
  allowance_types: {
    why: 'Allowance types define additional pay components (transport, meal, housing, etc.).',
    impact: 'No allowances will appear on payslips. You can add these later.',
  },
  deduction_types: {
    why: 'Deduction types define statutory and voluntary deductions (EPF, SOCSO, PCB, etc.).',
    impact: 'No deductions will be calculated. Critical for Malaysia employment law compliance.',
  },
  gl_mappings: {
    why: 'GL mappings connect payroll components to General Ledger accounts for proper accounting.',
    impact: 'Payroll expenses will not be posted to the finance module — GL will be incomplete.',
  },
  clearing_bank: {
    why: 'Clearing and bank accounts are required for payroll payment processing.',
    impact: 'Payroll payments cannot be disbursed without a configured bank account.',
  },
  access_groups: {
    why: 'Access groups control who can view and manage different HR functions.',
    impact: 'Without access groups, HR permissions default to organization-level roles only.',
  },
  hr_notifications: {
    why: 'Notification rules alert managers and HR when leave requests, payroll runs, etc. occur.',
    impact: 'No one will be notified of pending approvals or important HR events.',
  },
  employees_exist: {
    why: 'At least one employee record is needed to use attendance, leave, and payroll.',
    impact: 'All HR operational modules require employee records to function.',
  },
}

// ── Component ────────────────────────────────────────────────────

export default function HrConfigurationView({ organizationId, canEdit, onNavigate }: HrConfigurationViewProps) {
  const supabase = createClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const searchParams = useSearchParams()
  const isGuided = searchParams?.get('guided') === 'true'

  // Banner state
  const [config, setConfig] = useState<HrConfig>({ banner_image_url: null, updated_at: null })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Audit state
  const [audit, setAudit] = useState<AuditData | null>(null)
  const [auditLoading, setAuditLoading] = useState(true)
  const [autoSetupLoading, setAutoSetupLoading] = useState<string | null>(null)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())

  // Active tab state (must be declared before any early return)
  const [activeTab, setActiveTab] = useState<string>('')

  // ── Load banner config ──────────────────────────────────────

  useEffect(() => {
    async function loadConfig() {
      try {
        const { data, error: fetchError } = await supabase
          .from('organizations')
          .select('settings')
          .eq('id', organizationId)
          .single()

        if (fetchError) throw fetchError

        let settings: Record<string, any> = {}
        if (typeof data?.settings === 'string') {
          try { settings = JSON.parse(data.settings) } catch { settings = {} }
        } else if (typeof data?.settings === 'object' && data?.settings !== null) {
          settings = data.settings as Record<string, any>
        }

        const hrConfig = settings?.hr_config || {}
        setConfig({
          banner_image_url: hrConfig.banner_image_url || null,
          updated_at: hrConfig.updated_at || null,
        })

        if (hrConfig.banner_image_url) {
          setPreviewUrl(
            hrConfig.banner_image_url.startsWith('http')
              ? hrConfig.banner_image_url
              : getStorageUrl(hrConfig.banner_image_url)
          )
        }
      } catch (err) {
        console.error('Failed to load HR config:', err)
      } finally {
        setLoading(false)
      }
    }

    loadConfig()
  }, [organizationId, supabase])

  // ── Load audit ──────────────────────────────────────────────

  const loadAudit = useCallback(async () => {
    try {
      setAuditLoading(true)
      const res = await fetch('/api/hr/config/audit')
      if (!res.ok) throw new Error('Failed to load audit')
      const data = await res.json()
      setAudit(data)
      // In guided mode, auto-expand sections that need attention
      if (isGuided) {
        const needsAttention = new Set(
          (data.sections || [])
            .filter((s: AuditSection) => s.checks.some((c: AuditCheck) => c.status !== 'configured'))
            .map((s: AuditSection) => s.section)
        )
        setExpandedSections(needsAttention)
      }
    } catch (err) {
      console.error('Audit load error:', err)
    } finally {
      setAuditLoading(false)
    }
  }, [isGuided])

  useEffect(() => { loadAudit() }, [loadAudit])

  // Set default tab once audit loads
  useEffect(() => {
    if (audit?.sections.length && !activeTab) {
      setActiveTab(audit.sections[0].section)
    }
  }, [audit, activeTab])

  // ── Auto-setup handler ──────────────────────────────────────

  const handleAutoSetup = async (actionKey: string) => {
    try {
      setAutoSetupLoading(actionKey)
      const res = await fetch('/api/hr/config/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: actionKey }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      toast({ title: 'Auto Setup', description: data.message })
      loadAudit()
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' })
    } finally {
      setAutoSetupLoading(null)
    }
  }

  // ── Navigate handler ────────────────────────────────────────

  const router = useRouter()

  const handleNav = (viewId: string) => {
    // Always use router.push for proper page navigation
    const url = viewId.startsWith('/') ? viewId : '/' + viewId
    router.push(url)
  }

  // ── Upload/banner handlers ──────────────────────────────────

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) { setError('Please upload an image file'); return }
    if (file.size > 5 * 1024 * 1024) { setError('Image must be less than 5MB'); return }

    setUploading(true)
    setError(null)
    try {
      const ext = file.name.split('.').pop() || 'jpg'
      const filePath = `hr-banners/${organizationId}/banner-${Date.now()}.${ext}`
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { contentType: file.type, upsert: true })
      if (uploadError) throw uploadError
      setConfig(prev => ({ ...prev, banner_image_url: filePath }))
      setPreviewUrl(getStorageUrl(filePath))
    } catch (err: any) {
      setError(err.message || 'Failed to upload')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleRemoveBanner = () => {
    setConfig(prev => ({ ...prev, banner_image_url: null }))
    setPreviewUrl(null)
  }

  const handleSaveBanner = async () => {
    setSaving(true)
    setError(null)
    try {
      const { data: orgData, error: readErr } = await supabase
        .from('organizations')
        .select('settings')
        .eq('id', organizationId)
        .single()
      if (readErr) throw readErr

      let settings: Record<string, any> = {}
      if (typeof orgData?.settings === 'string') {
        try { settings = JSON.parse(orgData.settings) } catch { settings = {} }
      } else if (typeof orgData?.settings === 'object' && orgData?.settings !== null) {
        settings = { ...(orgData.settings as Record<string, any>) }
      }

      settings.hr_config = {
        ...(settings.hr_config || {}),
        banner_image_url: config.banner_image_url,
        updated_at: new Date().toISOString(),
      }

      const { error: updateErr } = await supabase
        .from('organizations')
        .update({ settings })
        .eq('id', organizationId)
      if (updateErr) throw updateErr

      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  // ── Render ──────────────────────────────────────────────────

  if (loading && auditLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const pct = audit ? Math.round((audit.summary.configured / audit.summary.total) * 100) : 0

  // Build tab definitions from audit sections + extra tabs (AI Settings, Banner Image)
  const TAB_ICONS: Record<string, React.ElementType> = {
    'Company Defaults': Building,
    'Attendance Setup': Clock,
    'Leave Setup': Calendar,
    'Payroll Setup': Wallet,
    'Security & Notifications': Shield,
    'AI Settings': Bot,
    'Banner Image': ImageIcon,
  }

  const allTabs = [
    ...(audit?.sections.map(s => s.section) || []),
    'AI Settings',
    'Banner Image',
  ]

  // Helper to get section status badge for tab
  const getTabStatus = (tabName: string) => {
    if (tabName === 'AI Settings' || tabName === 'Banner Image') return null
    const section = audit?.sections.find(s => s.section === tabName)
    if (!section) return null
    const configured = section.checks.filter(c => c.status === 'configured').length
    const total = section.checks.length
    return { configured, total }
  }

  return (
    <div className="space-y-6">
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Wrench className="h-5 w-5 text-blue-600" />
            HR Configuration
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isGuided
              ? 'Guided setup — follow each section to configure your HR module.'
              : 'Control center — audit all HR settings and fix gaps from one place.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadAudit} disabled={auditLoading} className="gap-1">
          <RefreshCw className={`h-4 w-4 ${auditLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* ─── Summary Card (Configuration Readiness) ─── */}
      {audit && (
        <Card>
          <CardContent className="py-5">
            <div className="flex items-center gap-6 flex-wrap">
              {/* Progress ring */}
              <div className="relative h-16 w-16 flex-shrink-0">
                <svg className="h-16 w-16 -rotate-90" viewBox="0 0 36 36">
                  <path
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="text-muted/20"
                  />
                  <path
                    d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeDasharray={`${pct}, 100`}
                    className={pct >= 80 ? 'text-green-500' : pct >= 50 ? 'text-amber-500' : 'text-red-500'}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-sm font-bold">
                  {pct}%
                </span>
              </div>

              <div className="flex-1 min-w-0">
                <h2 className="text-base font-semibold">Configuration Readiness</h2>
                <p className="text-sm text-muted-foreground">
                  {audit.summary.configured} of {audit.summary.total} checks passed
                </p>
              </div>

              <div className="flex gap-4 text-sm">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span className="font-medium">{audit.summary.configured}</span>
                  <span className="text-muted-foreground">OK</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  <span className="font-medium">{audit.summary.partial}</span>
                  <span className="text-muted-foreground">Partial</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <XCircle className="h-4 w-4 text-red-500" />
                  <span className="font-medium">{audit.summary.missing}</span>
                  <span className="text-muted-foreground">Missing</span>
                </span>
              </div>
            </div>

            {/* ─── Tab Navigation ─── */}
            <div className="mt-5 border-t pt-4">
              <div className="flex flex-wrap gap-1">
                {allTabs.map((tabName) => {
                  const isActive = activeTab === tabName
                  const TabIcon = TAB_ICONS[tabName] || Wrench
                  const status = getTabStatus(tabName)

                  return (
                    <button
                      key={tabName}
                      onClick={() => setActiveTab(tabName)}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all',
                        isActive
                          ? 'bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800 shadow-sm'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      )}
                    >
                      <TabIcon className="h-4 w-4 flex-shrink-0" />
                      <span className="whitespace-nowrap">{tabName}</span>
                      {status && (
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[10px] px-1.5 py-0 ml-1',
                            status.configured === status.total
                              ? 'border-green-200 text-green-700 dark:text-green-400'
                              : 'border-amber-200 text-amber-700 dark:text-amber-400'
                          )}
                        >
                          {status.configured}/{status.total}
                        </Badge>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Quick Setup All (guided mode) — shown above tabs content ─── */}
      {isGuided && canEdit && audit && pct < 100 && (
        <Card className="border-blue-200 dark:border-blue-800">
          <CardContent className="py-5">
            <div className="flex items-center gap-4">
              <Zap className="h-8 w-8 text-blue-500" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold">Quick Setup — Apply HR Defaults</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Automatically configure workweek, holidays, leave types, approval chains, and notifications
                  with safe Malaysian defaults. You can customize everything later.
                </p>
              </div>
              <Button
                size="sm"
                className="gap-1"
                disabled={!!autoSetupLoading}
                onClick={async () => {
                  const actions = ['default_workweek', 'default_holidays_my', 'default_leave_types', 'default_approval_chain', 'default_hr_notifications', 'default_access_groups']
                  for (const action of actions) {
                    try {
                      setAutoSetupLoading(action)
                      const res = await fetch('/api/hr/config/audit', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action }),
                      })
                      const data = await res.json()
                      if (!res.ok) {
                        toast({ title: `Setup: ${action}`, description: data.error || 'Failed', variant: 'destructive' })
                        break
                      }
                    } catch (err: any) {
                      toast({ title: 'Error', description: err.message, variant: 'destructive' })
                      break
                    }
                  }
                  setAutoSetupLoading(null)
                  toast({ title: 'Quick Setup Complete', description: 'Default HR configuration applied. Review and customize as needed.' })
                  loadAudit()
                }}
              >
                {autoSetupLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4" />
                )}
                Apply All Defaults
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Tab Content ─── */}
      {/* Audit section tabs */}
      {audit?.sections.map((section, sectionIndex) => {
        if (activeTab !== section.section) return null
        const SectionIcon = SECTION_ICONS[section.icon] || Wrench
        const sectionConfigured = section.checks.filter(c => c.status === 'configured').length
        const sectionTotal = section.checks.length

        return (
          <Card key={section.section}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <SectionIcon className="h-5 w-5 text-blue-600" />
                  {isGuided && (
                    <span className="text-xs font-normal text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Step {sectionIndex + 1}
                    </span>
                  )}
                  {section.section}
                </CardTitle>
                <Badge
                  variant="outline"
                  className={
                    sectionConfigured === sectionTotal
                      ? 'border-green-200 text-green-700 dark:text-green-400'
                      : 'border-amber-200 text-amber-700 dark:text-amber-400'
                  }
                >
                  {sectionConfigured}/{sectionTotal}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="divide-y">
                {section.checks.map((check) => {
                  const cfg = STATUS_CONFIG[check.status]
                  const StatusIcon = cfg.icon
                  const explanation = isGuided ? GUIDED_EXPLANATIONS[check.key] : null

                  return (
                    <div key={check.key} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-center gap-3">
                        <div className={`flex-shrink-0 rounded-full p-1.5 ${cfg.bg}`}>
                          <StatusIcon className={`h-4 w-4 ${cfg.color}`} />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{check.label}</span>
                            {typeof check.count === 'number' && check.count > 0 && (
                              <Badge variant="secondary" className="text-xs px-1.5 py-0">
                                {check.count}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">{check.detail}</p>
                        </div>

                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {canEdit && check.autoSetupKey && check.status !== 'configured' && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs gap-1 h-7"
                              disabled={autoSetupLoading === check.autoSetupKey}
                              onClick={() => handleAutoSetup(check.autoSetupKey!)}
                            >
                              {autoSetupLoading === check.autoSetupKey ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Zap className="h-3 w-3" />
                              )}
                              Auto Setup
                            </Button>
                          )}
                          {check.link && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-xs gap-1 h-7"
                              onClick={() => handleNav(check.link!)}
                            >
                              {check.status === 'configured' ? 'View' : 'Fix Now'}
                              <ArrowRight className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Guided mode explanation */}
                      {isGuided && explanation && check.status !== 'configured' && (
                        <div className="ml-10 mt-2 p-2 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 text-xs space-y-1">
                          <div className="flex items-start gap-1.5">
                            <Info className="h-3 w-3 text-blue-500 mt-0.5 flex-shrink-0" />
                            <div>
                              <span className="font-medium text-blue-700 dark:text-blue-300">Why: </span>
                              <span className="text-blue-600 dark:text-blue-400">{explanation.why}</span>
                            </div>
                          </div>
                          <div className="flex items-start gap-1.5">
                            <AlertTriangle className="h-3 w-3 text-amber-500 mt-0.5 flex-shrink-0" />
                            <div>
                              <span className="font-medium text-amber-700 dark:text-amber-300">If skipped: </span>
                              <span className="text-amber-600 dark:text-amber-400">{explanation.impact}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        )
      })}

      {/* ─── AI Assistant Settings Tab ─── */}
      {activeTab === 'AI Settings' && (
        <AiProviderSettingsCard organizationId={organizationId} canEdit={canEdit} />
      )}

      {/* ─── Banner Image Tab ─── */}
      {activeTab === 'Banner Image' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ImageIcon className="h-5 w-5 text-purple-600" />
              Banner Image
            </CardTitle>
            <CardDescription>
              Upload a banner for the HR landing page. Recommended 1200x300px, max 5MB.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {previewUrl ? (
              <div className="relative rounded-lg overflow-hidden border border-border" style={{ height: 180 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt="Banner Preview" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-gradient-to-r from-black/40 via-black/20 to-transparent" />
                <div className="absolute bottom-3 left-4 text-white text-sm font-medium">Banner Preview</div>
                {canEdit && (
                  <button
                    onClick={handleRemoveBanner}
                    className="absolute top-3 right-3 p-1.5 rounded-md bg-red-500/80 text-white hover:bg-red-600 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center h-32 rounded-lg border-2 border-dashed border-border bg-muted/30">
                <div className="text-center">
                  <ImageIcon className="h-8 w-8 text-muted-foreground/50 mx-auto mb-1" />
                  <p className="text-xs text-muted-foreground">No banner set — default gradient used</p>
                </div>
              </div>
            )}

            {canEdit && (
              <div className="flex items-center gap-3">
                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading} className="gap-2">
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {uploading ? 'Uploading…' : 'Upload Image'}
                </Button>
                <Button size="sm" onClick={handleSaveBanner} disabled={saving} className="gap-2">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <CheckCircle2 className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                  {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Banner'}
                </Button>
              </div>
            )}

            {error && (
              <div className="p-3 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Data Management (pre-go-live resets; authorized on the server) ─── */}
      <HrDataManagementSection />
    </div>
  )
}
