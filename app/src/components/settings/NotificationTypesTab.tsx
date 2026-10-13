'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import NotificationFlowDrawer, { type DrawerSaveOptions } from './NotificationFlowDrawer'
import { DEFAULT_NOTIFICATION_ADMIN_ROLE } from '@/lib/notifications/recipientRoleCodes'
import { DELETE_USER_OTP_EVENT, SYSTEM_SMS_CHECK_EVENT } from '@/lib/notifications/notificationEventCatalog'
import { ORDER_CREATOR_DEFAULT_EVENTS } from '@/lib/notifications/orderOwnerNotify'
import type { NotificationRoutingPreset } from '@/lib/notifications/routing'
import {
  PRESET_LABELS,
  deliveryLabel,
  filterCategoryTypes,
  groupByModule,
  resolveEventDelivery,
  type RoutingState,
  type StatusFilter,
} from '@/lib/notifications/notificationTypeModules'
import {
  AlertTriangle,
  BarChart3,
  Briefcase,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  HeartHandshake,
  HelpCircle,
  Info,
  Landmark,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquare,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Truck,
  XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { SeraLoadingState } from '@/components/ui/SeraLoader'

type Channel = 'whatsapp' | 'email' | 'sms'
type RoutingPreset = NotificationRoutingPreset
type RoutingSource = 'default' | 'category' | 'event'

interface NotificationType {
  id: string
  category: string
  event_code: string
  event_name: string
  event_description: string
  default_enabled: boolean
  available_channels: string[]
  is_system: boolean
}

interface RoutingMetadata {
  preset?: RoutingPreset
  source?: RoutingSource
  default_preset?: RoutingPreset
  category_preset?: RoutingPreset | null
}

interface NotificationSetting {
  id?: string
  org_id: string
  event_code: string
  enabled: boolean
  channels_enabled: string[]
  priority: 'low' | 'normal' | 'high' | 'critical'
  templates?: Record<string, string>
  recipient_config?: {
    type?: string
    roles?: string[]
    recipient_users?: string[]
    custom_emails?: string
    custom_phones?: string
    manual_whatsapp_numbers?: string[]
    manual_email_addresses?: string[]
    dynamic_target?: string
    include_consumer?: boolean
    recipient_targets?: {
      roles?: boolean
      dynamic_org?: boolean
      users?: boolean
      consumer?: boolean
      order_creator?: boolean
    }
    routing?: RoutingMetadata
  }
}

interface NotificationTypesTabProps {
  userProfile: {
    id: string
    organization_id: string
    organizations: { id: string; org_type_code: string }
    roles: { role_level: number }
  }
}

/** The editable part of the page. Recipients and templates save from the drawer. */
interface Draft extends RoutingState {
  categoryPresets: Record<string, RoutingPreset | null>
  eventPresets: Record<string, RoutingPreset | null>
  enabled: Record<string, boolean>
}

const DEFAULT_PRESET: RoutingPreset = 'whatsapp_email_fallback'
const DEFAULT_RECIPIENT_TARGETS = { roles: true, dynamic_org: false, users: false, consumer: false, order_creator: false }
const EXCLUSIVE_PRESETS: RoutingPreset[] = ['sms_only', 'email_only', 'whatsapp_only']
const CHANNELS: Channel[] = ['whatsapp', 'email', 'sms']
const CHANNEL_LABELS: Record<Channel, string> = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS' }

const PRESETS: Array<{
  id: RoutingPreset
  required: Channel[]
}> = [
  { id: 'whatsapp_only', required: ['whatsapp'] },
  { id: 'email_only', required: ['email'] },
  { id: 'sms_only', required: ['sms'] },
  { id: 'whatsapp_email_fallback', required: ['whatsapp', 'email'] },
  { id: 'whatsapp_sms_email_fallback', required: ['whatsapp', 'sms', 'email'] },
]

const FORCED_PRESET: Record<string, RoutingPreset> = {
  stock_count_posting_verification: 'email_only',
  [SYSTEM_SMS_CHECK_EVENT]: 'sms_only',
}

// Single-channel options carry a small channel icon; fallback routes are text only.
const SEGMENT_ICONS: Partial<Record<RoutingPreset, LucideIcon>> = {
  whatsapp_only: MessageCircle,
  email_only: Mail,
  sms_only: MessageSquare,
}

const MODULE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  supply_chain: Truck, customer_growth: HeartHandshake, hr_payroll: Briefcase,
  finance: Landmark, security_access: ShieldCheck, platform_settings: Settings, reporting: BarChart3,
}

const SELECT_CLASS = 'h-9 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 outline-none focus-visible:border-[var(--sera-orange)] focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/25 disabled:cursor-not-allowed disabled:border-slate-100 disabled:bg-slate-50 disabled:text-slate-400'

function defaultRecipientTargets(eventCode?: string) {
  if (eventCode && ORDER_CREATOR_DEFAULT_EVENTS.has(eventCode)) {
    return { roles: false, dynamic_org: false, users: false, consumer: false, order_creator: true }
  }
  return { ...DEFAULT_RECIPIENT_TARGETS }
}

function normalizeRecipientConfig(
  recipientConfig: NotificationSetting['recipient_config'] | null | undefined,
  fallbackRoles: string[] = [DEFAULT_NOTIFICATION_ADMIN_ROLE],
  eventCode?: string,
): NonNullable<NotificationSetting['recipient_config']> {
  const raw = recipientConfig && typeof recipientConfig === 'object' ? recipientConfig : {}
  const roles = Array.isArray(raw.roles) && raw.roles.length ? raw.roles : fallbackRoles
  const hasSources = Boolean(
    raw.recipient_targets || raw.manual_whatsapp_numbers?.length || raw.recipient_users?.length ||
    String(raw.custom_emails || '').trim() || String(raw.custom_phones || '').trim() || raw.dynamic_target
  )
  const fallbackTargets = hasSources
    ? { roles: false, dynamic_org: false, users: false, consumer: false, order_creator: false }
    : defaultRecipientTargets(eventCode)
  const recipient_targets = {
    ...fallbackTargets,
    ...(raw.recipient_targets || {}),
  }
  if (eventCode && ORDER_CREATOR_DEFAULT_EVENTS.has(eventCode) && raw.recipient_targets?.order_creator === undefined) {
    recipient_targets.order_creator = true
  }
  return {
    type: raw.type || 'roles',
    include_consumer: raw.include_consumer ?? true,
    ...raw,
    roles,
    recipient_targets,
  }
}

function presetFromChannels(channels: string[]): RoutingPreset {
  if (channels.includes('whatsapp') && channels.includes('email')) return 'whatsapp_email_fallback'
  if (channels.includes('email')) return 'email_only'
  if (channels.includes('sms')) return 'sms_only'
  return 'whatsapp_only'
}

function channelsForPreset(preset: RoutingPreset): string[] {
  // Fallback presets queue WhatsApp first. Later channels are attempted after failure (worker or sync OTP router).
  if (preset === 'email_only') return ['email']
  if (preset === 'sms_only') return ['sms']
  return ['whatsapp']
}

const sameMap = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if ((a[key] ?? null) !== (b[key] ?? null)) return false
  return true
}

const draftChanged = (a: Draft, b: Draft) => a.defaultPreset !== b.defaultPreset
  || !sameMap(a.categoryPresets, b.categoryPresets)
  || !sameMap(a.eventPresets, b.eventPresets)
  || !sameMap(a.enabled, b.enabled)

export default function NotificationTypesTab({ userProfile }: NotificationTypesTabProps) {
  const { supabase, isReady } = useSupabaseAuth()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [notificationTypes, setNotificationTypes] = useState<NotificationType[]>([])
  const [settings, setSettings] = useState<Map<string, NotificationSetting>>(new Map())
  const [providerStatus, setProviderStatus] = useState<Record<Channel, boolean>>({ whatsapp: false, email: false, sms: false })
  const [saved, setSaved] = useState<Draft | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saveStatus, setSaveStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [editingSetting, setEditingSetting] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [moduleFilter, setModuleFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  // Normal expansion is the user's own and starts fully collapsed on every
  // visit (never persisted). While searching, matching modules and categories
  // open automatically and the `searchCollapsed*` maps only record what the
  // user closes, so clearing the search restores the manual state.
  const [expandedModules, setExpandedModules] = useState<Record<string, boolean>>({})
  const [searchCollapsedModules, setSearchCollapsedModules] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [searchCollapsed, setSearchCollapsed] = useState<Record<string, boolean>>({})

  const dirty = Boolean(draft && saved && draftChanged(draft, saved))

  const loadNotificationTypes = useCallback(async ({ silent = false } = {}) => {
    if (!isReady) return null
    try {
      if (!silent) setLoading(true)
      setLoadError(null)
      const [{ data: types, error: typesError }, { data: existingSettings, error: settingsError }, { data: providers, error: providerError }] = await Promise.all([
        supabase.from('notification_types').select('*').order('category').order('sort_order', { ascending: true, nullsFirst: false }).order('event_name'),
        supabase.from('notification_settings').select('*').eq('org_id', userProfile.organizations.id),
        supabase.from('notification_provider_configs').select('channel,is_active').eq('org_id', userProfile.organizations.id),
      ])
      if (typesError) throw typesError
      if (settingsError) throw settingsError
      if (providerError) throw providerError

      const loadedTypes = (types || []) as NotificationType[]
      const settingsMap = new Map<string, NotificationSetting>()
      loadedTypes.forEach((type) => {
        settingsMap.set(type.event_code, {
          org_id: userProfile.organizations.id,
          event_code: type.event_code,
          enabled: type.default_enabled,
          channels_enabled: type.default_enabled ? channelsForPreset(DEFAULT_PRESET) : [],
          priority: type.event_code === DELETE_USER_OTP_EVENT ? 'critical' : 'normal',
          templates: {},
          recipient_config: normalizeRecipientConfig(
            type.event_code === DELETE_USER_OTP_EVENT
              ? { dynamic_target: 'org_contact', recipient_targets: { roles: false, dynamic_org: true, users: false, consumer: false, order_creator: false } }
              : undefined,
            undefined,
            type.event_code,
          ),
        })
      })

      let loadedDefault = DEFAULT_PRESET
      const loadedCategories: Record<string, RoutingPreset | null> = {}
      const loadedEvents: Record<string, RoutingPreset | null> = {}
      ;(existingSettings || []).forEach((row: any) => {
        const matchingType = loadedTypes.find((type) => type.event_code === row.event_code)
        if (!matchingType) return
        const recipientConfig = normalizeRecipientConfig(row.recipient_config, row.recipient_roles?.length ? row.recipient_roles : undefined, row.event_code)
        const routing = recipientConfig.routing
        const legacyPreset = presetFromChannels(row.channels_enabled || [])
        if (routing?.default_preset) loadedDefault = routing.default_preset
        if (routing?.category_preset !== undefined && loadedCategories[matchingType.category] === undefined) {
          loadedCategories[matchingType.category] = routing.category_preset
        }
        loadedEvents[row.event_code] = routing?.source === 'event' ? (routing.preset || legacyPreset) : routing ? null : legacyPreset
        settingsMap.set(row.event_code, {
          id: row.id,
          org_id: row.org_id,
          event_code: row.event_code,
          enabled: Boolean(row.enabled),
          channels_enabled: row.channels_enabled || [],
          priority: row.priority || 'normal',
          templates: row.templates || {},
          recipient_config: recipientConfig,
        })
      })

      // A leftover catalog 3-step on User Deletion OTP must not hide Security & OTP SMS Only.
      if (loadedEvents[DELETE_USER_OTP_EVENT] === 'whatsapp_sms_email_fallback') {
        const securityPreset = loadedCategories.security
        if (
          (securityPreset && EXCLUSIVE_PRESETS.includes(securityPreset))
          || (!securityPreset && EXCLUSIVE_PRESETS.includes(loadedDefault))
        ) {
          loadedEvents[DELETE_USER_OTP_EVENT] = null
        }
      }

      const enabled: Record<string, boolean> = {}
      settingsMap.forEach((setting, code) => { enabled[code] = setting.enabled })
      const loaded: Draft = { defaultPreset: loadedDefault, categoryPresets: loadedCategories, eventPresets: loadedEvents, enabled }

      setNotificationTypes(loadedTypes)
      setSettings(settingsMap)
      setSaved(loaded)
      setProviderStatus({
        whatsapp: Boolean(providers?.some((p: any) => p.channel === 'whatsapp' && p.is_active)),
        email: Boolean(providers?.some((p: any) => p.channel === 'email' && p.is_active)),
        sms: Boolean(providers?.some((p: any) => p.channel === 'sms' && p.is_active)),
      })
      return loaded
    } catch (error: any) {
      console.error('Error loading notification routing:', error)
      setLoadError(error?.message || 'Unable to load notification settings.')
      return null
    } finally {
      if (!silent) setLoading(false)
    }
  }, [isReady, supabase, userProfile.organizations.id])

  useEffect(() => {
    if (!isReady) return
    void loadNotificationTypes().then((loaded) => { if (loaded) setDraft(loaded) })
  }, [isReady, loadNotificationTypes])

  // Warn before a reload / tab close / in-app link drops unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const message = 'You have unsaved notification changes. Leave without saving?'
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = message }
    const guardClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest('a[href], [data-nav-href]')
      if (!target || target.closest('[data-notification-types-root]')) return
      if (!window.confirm(message)) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', guardClick, true)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      document.removeEventListener('click', guardClick, true)
    }
  }, [dirty])

  const sections = useMemo(() => groupByModule(notificationTypes), [notificationTypes])

  const presetAvailable = (preset: RoutingPreset) => PRESETS.find((item) => item.id === preset)!.required.every((channel) => providerStatus[channel])
  const isEnabled = (type: NotificationType) => type.event_code === DELETE_USER_OTP_EVENT || Boolean(draft?.enabled[type.event_code])

  const buildSettingRecord = (setting: NotificationSetting, state: Draft) => {
    const type = notificationTypes.find((item) => item.event_code === setting.event_code)!
    const { preset, source } = resolveEventDelivery(type, state, FORCED_PRESET)
    const routingSource: RoutingSource = source === 'fixed' || source === 'custom' ? 'event' : source
    const categoryPreset = state.categoryPresets[type.category] || null
    const enabled = setting.event_code === DELETE_USER_OTP_EVENT ? true : Boolean(state.enabled[setting.event_code])
    const recipientConfig = normalizeRecipientConfig(setting.recipient_config, undefined, setting.event_code)
    return {
      id: setting.id || crypto.randomUUID(),
      org_id: setting.org_id,
      event_code: setting.event_code,
      enabled,
      channels_enabled: enabled ? channelsForPreset(preset) : [],
      priority: setting.priority,
      recipient_roles: recipientConfig.roles || null,
      recipient_users: null,
      recipient_custom: recipientConfig.custom_emails ? [recipientConfig.custom_emails] : null,
      template_code: null,
      templates: setting.templates,
      recipient_config: {
        ...recipientConfig,
        routing: { preset, source: routingSource, default_preset: state.defaultPreset, category_preset: categoryPreset },
      },
      retry_enabled: true,
      max_retries: 3,
    }
  }

  const handleSave = async () => {
    if (!isReady || !draft || savingRef.current || !dirty) return
    savingRef.current = true
    setSaving(true)
    setSaveStatus(null)
    try {
      // One upsert for every row: each row carries the default/category
      // preset, so a partial write would leave routing inconsistent. A single
      // statement either applies all rows or none.
      const records = Array.from(settings.values()).map((setting) => buildSettingRecord(setting, draft))
      const { data, error } = await (supabase as any).from('notification_settings').upsert(records, { onConflict: 'org_id,event_code' }).select('id')
      if (error) throw error
      if (!data?.length) throw new Error('Nothing was saved. Check that your account can manage notification settings (HQ Admin).')
      const reloaded = await loadNotificationTypes({ silent: true })
      if (reloaded) setDraft(reloaded)
      else setSaved(draft)
      setSaveStatus({ kind: 'success', message: 'Changes saved.' })
      setTimeout(() => setSaveStatus((current) => (current?.kind === 'success' ? null : current)), 3000)
    } catch (error: any) {
      console.error('Error saving notification routing:', error)
      setSaveStatus({ kind: 'error', message: `Changes were not saved: ${error?.message || 'unknown error'}. Your edits are kept — try again.` })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    if (saved) setDraft(saved)
    setSaveStatus(null)
  }

  // The drawer saves recipients/templates for one notification immediately.
  // It writes that row with the last *saved* routing so unsaved page edits are
  // neither published early nor lost. A delivery change made in the drawer
  // (inherit ↔ custom) is the one routing value it may publish, for its own row.
  const saveSingleSetting = async (updated: NotificationSetting, options?: DrawerSaveOptions) => {
    if (!saved) return
    const changesDelivery = options !== undefined && 'eventPreset' in options
    const eventPreset = options?.eventPreset ?? null
    const state = changesDelivery ? { ...saved, eventPresets: { ...saved.eventPresets, [updated.event_code]: eventPreset } } : saved
    const { error } = await (supabase as any).from('notification_settings').upsert(buildSettingRecord(updated, state), { onConflict: 'org_id,event_code' })
    if (error) throw new Error(error.message)
    await loadNotificationTypes({ silent: true })
    // Mirror it into the page draft so the row shows it and a later page save keeps it.
    if (changesDelivery) updateDraft((current) => ({ ...current, eventPresets: { ...current.eventPresets, [updated.event_code]: eventPreset } }))
  }

  const updateDraft = (patch: (current: Draft) => Draft) => setDraft((current) => (current ? patch(current) : current))

  const searching = query.trim().length > 0
  const filtersActive = searching || moduleFilter !== 'all' || statusFilter !== 'all'
  const visibleSections = useMemo(() => sections
    .filter((section) => moduleFilter === 'all' || section.id === moduleFilter)
    .map((section) => ({
      ...section,
      categories: section.categories
        .map((category) => ({ ...category, visibleTypes: filterCategoryTypes(category, query, statusFilter, isEnabled) }))
        .filter((category) => !filtersActive || category.visibleTypes.length > 0),
    }))
    .filter((section) => section.categories.length > 0),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [sections, moduleFilter, query, statusFilter, draft, filtersActive])

  useEffect(() => { setSearchCollapsed({}); setSearchCollapsedModules({}) }, [query])

  const isExpanded = (category: string) => (searching ? !searchCollapsed[category] : Boolean(expanded[category]))
  const toggleCategory = (category: string) => {
    if (searching) setSearchCollapsed((current) => ({ ...current, [category]: !current[category] }))
    else setExpanded((current) => ({ ...current, [category]: !current[category] }))
  }
  const isModuleOpen = (moduleId: string) => (searching ? !searchCollapsedModules[moduleId] : Boolean(expandedModules[moduleId]))
  const toggleModule = (moduleId: string) => {
    if (searching) setSearchCollapsedModules((current) => ({ ...current, [moduleId]: !current[moduleId] }))
    else setExpandedModules((current) => ({ ...current, [moduleId]: !current[moduleId] }))
  }
  const visibleModules = visibleSections.map((section) => section.id)
  const visibleCategories = visibleSections.flatMap((section) => section.categories.map((category) => category.category))
  const allExpanded = visibleModules.length > 0 && visibleModules.every(isModuleOpen) && visibleCategories.every(isExpanded)
  // Expand all / Collapse all act on both levels.
  const setAllExpanded = (open: boolean) => {
    if (searching) {
      setSearchCollapsedModules(Object.fromEntries(visibleModules.map((id) => [id, !open])))
      setSearchCollapsed(Object.fromEntries(visibleCategories.map((category) => [category, !open])))
    } else {
      setExpandedModules((current) => ({ ...current, ...Object.fromEntries(visibleModules.map((id) => [id, open])) }))
      setExpanded((current) => ({ ...current, ...Object.fromEntries(visibleCategories.map((category) => [category, open])) }))
    }
  }
  const resetFilters = () => { setQuery(''); setModuleFilter('all'); setStatusFilter('all') }

  if (loading) {
    return <SeraLoadingState variant="section" minHeight="420px" label="Loading notification routing" className="rounded-2xl border bg-white" />
  }

  if (!draft || !saved) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-8 text-center text-sm text-red-800">
        <XCircle className="h-6 w-6" />
        <p>{loadError || 'Unable to load notification settings.'}</p>
        <Button variant="outline" size="sm" onClick={() => void loadNotificationTypes().then((loaded) => { if (loaded) setDraft(loaded) })}>Retry</Button>
      </div>
    )
  }

  const totalEnabled = notificationTypes.filter(isEnabled).length

  const presetOptions = (current: RoutingPreset | null) => PRESETS.map((preset) => {
    const available = presetAvailable(preset.id)
    return (
      <option key={preset.id} value={preset.id} disabled={!available && current !== preset.id}>
        Custom · {PRESET_LABELS[preset.id]}{available ? '' : ' (unavailable)'}
      </option>
    )
  })

  return (
    <div data-notification-types-root className="space-y-4 pb-24">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-950">Notification Types</h1>
          <p className="mt-0.5 text-sm text-slate-500">Manage notifications by module.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Channel availability">
          {CHANNELS.map((channel) => (
            <span
              key={channel}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${providerStatus[channel] ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}
            >
              {channel === 'whatsapp' ? <MessageCircle className="h-3.5 w-3.5" /> : channel === 'email' ? <Mail className="h-3.5 w-3.5" /> : <MessageSquare className="h-3.5 w-3.5" />}
              {CHANNEL_LABELS[channel]} · {providerStatus[channel] ? 'Active' : 'Not configured'}
            </span>
          ))}
        </div>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-1.5">
          <h2 id="default-delivery-label" className="text-sm font-semibold text-slate-900">Default delivery</h2>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="About default delivery"
                className="rounded-full p-0.5 text-slate-400 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40"
              >
                <Info className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 text-sm leading-relaxed text-slate-600">
              Categories follow the global default unless they have their own setting. Notifications follow their category unless they have their own setting. Custom settings stay unchanged when the default changes. Arrows indicate fallback: the next channel is tried only if the previous channel fails.
            </PopoverContent>
          </Popover>
        </div>
        <p id="default-delivery-help" className="mt-0.5 text-sm text-slate-500">Applies only to categories and notifications that follow the default.</p>
        <RadioGroupPrimitive.Root
          aria-labelledby="default-delivery-label"
          aria-describedby="default-delivery-help"
          value={draft.defaultPreset}
          onValueChange={(value) => updateDraft((current) => ({ ...current, defaultPreset: value as RoutingPreset }))}
          orientation="horizontal"
          className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 lg:flex"
        >
          {PRESETS.map((preset) => {
            const available = presetAvailable(preset.id)
            const selected = draft.defaultPreset === preset.id
            const SegmentIcon = SEGMENT_ICONS[preset.id]
            return (
              <RadioGroupPrimitive.Item
                key={preset.id}
                value={preset.id}
                disabled={!available && !selected}
                title={available ? undefined : 'Provider not configured'}
                className={`relative flex min-h-11 items-center justify-center gap-1.5 px-3 py-2 text-center text-sm font-medium transition-colors last:col-span-2 lg:flex-auto lg:last:col-span-1 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--sera-orange)] disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ${selected ? 'z-[1] bg-orange-50 text-[var(--sera-orange)] shadow-[inset_0_0_0_1px_var(--sera-orange)]' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
              >
                {selected && <Check aria-hidden className="h-3.5 w-3.5 shrink-0" />}
                {SegmentIcon && <SegmentIcon aria-hidden className="h-3.5 w-3.5 shrink-0" />}
                <span>{PRESET_LABELS[preset.id]}</span>
                {!available && <span className="sr-only"> (provider not configured)</span>}
              </RadioGroupPrimitive.Item>
            )
          })}
        </RadioGroupPrimitive.Root>
      </section>

      <section className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search categories and notifications"
            aria-label="Search notifications"
            className="h-9 pl-8"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
          <select aria-label="Filter by module" value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)} className={`${SELECT_CLASS} sm:w-48`}>
            <option value="all">All modules</option>
            {sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}
          </select>
          <select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} className={`${SELECT_CLASS} sm:w-36`}>
            <option value="all">All statuses</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
          <Button type="button" variant="outline" size="sm" className="col-span-2 h-9 gap-1.5 sm:col-span-1" onClick={() => setAllExpanded(!allExpanded)} disabled={!visibleModules.length}>
            {allExpanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </Button>
        </div>
      </section>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{totalEnabled}/{notificationTypes.length} notifications enabled</span>
        {filtersActive && (
          <span>
            Showing {visibleSections.reduce((sum, section) => sum + section.categories.reduce((n, category) => n + category.visibleTypes.length, 0), 0)} matching ·{' '}
            <button type="button" onClick={resetFilters} className="font-medium text-[var(--sera-orange)] hover:underline">Reset filters</button>
          </span>
        )}
      </div>

      {visibleSections.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center">
          <Search className="h-5 w-5 text-slate-400" />
          <p className="text-sm font-medium text-slate-700">No notifications match these filters.</p>
          <Button type="button" variant="outline" size="sm" onClick={resetFilters}>Reset filters</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleSections.map((section) => {
            const ModuleIcon = MODULE_ICONS[section.id] || HelpCircle
            const moduleTypes = section.categories.flatMap((category) => category.types)
            const moduleOpen = isModuleOpen(section.id)
            const modulePanelId = `notification-module-${section.id}`
            return (
              <section key={section.id} aria-label={section.name} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <h2 className="text-sm">
                  <button
                    type="button"
                    aria-expanded={moduleOpen}
                    aria-controls={modulePanelId}
                    onClick={() => toggleModule(section.id)}
                    className={`flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 bg-slate-50 px-4 py-2.5 text-left hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--sera-orange)]/30 ${moduleOpen ? 'border-b border-slate-200' : ''}`}
                  >
                    {moduleOpen ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-500" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />}
                    <ModuleIcon className="h-4 w-4 shrink-0 text-[var(--sera-orange)]" />
                    <span className="font-semibold text-slate-900">{section.name}</span>
                    <span className="ml-auto text-xs font-normal text-slate-500">
                      {section.categories.length} {section.categories.length === 1 ? 'category' : 'categories'} · {moduleTypes.filter(isEnabled).length}/{moduleTypes.length} enabled
                    </span>
                  </button>
                </h2>
                {moduleOpen && <div id={modulePanelId} className="divide-y divide-slate-100">
                  {section.categories.map((category) => {
                    const open = isExpanded(category.category)
                    const categoryPreset = draft.categoryPresets[category.category] || null
                    const panelId = `notification-category-${category.category.replace(/\W+/g, '-')}`
                    return (
                      <Fragment key={category.category}>
                        <div className="grid grid-cols-1 items-center gap-x-2 gap-y-2 py-2.5 pl-6 pr-4 sm:grid-cols-[minmax(0,1fr)_240px]">
                          <button
                            type="button"
                            aria-label={`${category.label}, ${category.types.filter(isEnabled).length} of ${category.types.length} enabled`}
                            aria-expanded={open}
                            aria-controls={panelId}
                            onClick={() => toggleCategory(category.category)}
                            className="flex min-w-0 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/30"
                          >
                            {open ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
                            <span className="min-w-0 break-words text-sm font-medium text-slate-900">{category.label}</span>
                            <span className="shrink-0 text-xs text-slate-500">{category.types.filter(isEnabled).length}/{category.types.length}</span>
                          </button>
                          <select
                            aria-label={`${category.label} routing`}
                            value={categoryPreset || 'default'}
                            onChange={(event) => {
                              const value = event.target.value === 'default' ? null : event.target.value as RoutingPreset
                              updateDraft((current) => ({ ...current, categoryPresets: { ...current.categoryPresets, [category.category]: value } }))
                            }}
                            className={`${SELECT_CLASS} ${categoryPreset ? 'border-[var(--sera-orange)]/40' : ''}`}
                          >
                            <option value="default">{deliveryLabel('default', draft.defaultPreset)}</option>
                            {presetOptions(categoryPreset)}
                          </select>
                        </div>
                        {open && (
                          <ul id={panelId} className="divide-y divide-slate-100 border-t border-slate-100 bg-slate-50/50">
                            {category.visibleTypes.map((type) => {
                              const lockedOn = type.event_code === DELETE_USER_OTP_EVENT
                              const enabled = isEnabled(type)
                              const forced = FORCED_PRESET[type.event_code]
                              const eventPreset = draft.eventPresets[type.event_code] || null
                              const inherited = resolveEventDelivery(type, { ...draft, eventPresets: {} }, {})
                              return (
                                <li key={type.event_code} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-2.5 pl-10 pr-4 sm:grid-cols-[minmax(0,1fr)_240px_auto_auto] ${enabled ? '' : 'text-slate-500'}`}>
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                      <span className={`break-words text-sm ${enabled ? 'text-slate-900' : 'text-slate-500'}`}>{type.event_name}</span>
                                      {type.is_system && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">System</Badge>}
                                      {lockedOn && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">Always on</Badge>}
                                    </div>
                                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{type.event_description}</p>
                                    {lockedOn && <p className="mt-0.5 text-[11px] text-slate-500">Recipient is the organization contact. Custom templates in Configure are used when sending.</p>}
                                  </div>
                                  <div className="col-start-2 row-start-1 flex items-center sm:col-start-3">
                                    <Switch
                                      checked={enabled}
                                      onCheckedChange={(checked) => updateDraft((current) => ({ ...current, enabled: { ...current.enabled, [type.event_code]: checked } }))}
                                      disabled={lockedOn}
                                      aria-label={`Enable ${type.event_name}`}
                                    />
                                  </div>
                                  <select
                                    aria-label={`${type.event_name} routing`}
                                    disabled={(!enabled && !lockedOn) || Boolean(forced)}
                                    value={forced || eventPreset || 'inherit'}
                                    onChange={(event) => {
                                      const value = event.target.value === 'inherit' ? null : event.target.value as RoutingPreset
                                      updateDraft((current) => ({ ...current, eventPresets: { ...current.eventPresets, [type.event_code]: value } }))
                                    }}
                                    className={`${SELECT_CLASS} col-span-2 sm:col-span-1 sm:col-start-2 sm:row-start-1 ${eventPreset && !forced ? 'border-[var(--sera-orange)]/40' : ''}`}
                                  >
                                    {forced
                                      ? <option value={forced}>{deliveryLabel('fixed', forced)}</option>
                                      : <>
                                        <option value="inherit">{deliveryLabel(inherited.source, inherited.preset)}</option>
                                        {presetOptions(eventPreset)}
                                      </>}
                                  </select>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    disabled={!enabled && !lockedOn}
                                    onClick={() => setEditingSetting(type.event_code)}
                                    className="col-span-2 h-8 justify-self-start gap-1 px-2 text-[var(--sera-orange)] hover:text-[var(--sera-orange)] sm:col-span-1 sm:col-start-4 sm:row-start-1"
                                  >
                                    <Settings className="h-3.5 w-3.5" /> Configure
                                  </Button>
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </Fragment>
                    )
                  })}
                </div>}
              </section>
            )
          })}
        </div>
      )}

      <div className="sticky bottom-0 z-30 -mx-1 flex flex-col gap-2 rounded-lg border border-slate-200 bg-white/95 px-4 py-2.5 shadow-sm backdrop-blur sm:flex-row sm:items-center">
        <div role="status" aria-live="polite" className="min-w-0 flex-1 text-sm">
          {saving ? (
            <span className="inline-flex items-center gap-1.5 text-slate-600"><Loader2 className="h-4 w-4 animate-spin" /> Saving changes…</span>
          ) : saveStatus?.kind === 'error' ? (
            <span className="inline-flex items-start gap-1.5 text-red-700"><XCircle className="mt-0.5 h-4 w-4 shrink-0" />{saveStatus.message}</span>
          ) : saveStatus?.kind === 'success' && !dirty ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="h-4 w-4" />{saveStatus.message}</span>
          ) : dirty ? (
            <span className="inline-flex items-center gap-1.5 text-amber-700"><AlertTriangle className="h-4 w-4" /> Unsaved changes</span>
          ) : (
            <span className="text-slate-500">All changes saved</span>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleDiscard} disabled={!dirty || saving} className="gap-1.5">
            <RotateCcw className="h-4 w-4" /> Discard
          </Button>
          <Button type="button" size="sm" onClick={handleSave} disabled={!dirty || saving} className="gap-1.5 bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange)]/90">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving…' : 'Save Changes'}
          </Button>
        </div>
      </div>

      {editingSetting && (() => {
        const setting = settings.get(editingSetting)
        const type = notificationTypes.find((item) => item.event_code === editingSetting)
        if (!setting || !type) return null
        const { preset, source } = resolveEventDelivery(type, draft, FORCED_PRESET)
        const inherited = resolveEventDelivery(type, { ...draft, eventPresets: {} }, {})
        const delivery = {
          preset,
          source,
          inherited,
          eventPreset: draft.eventPresets[type.event_code] || null,
          savedEventPreset: saved.eventPresets[type.event_code] || null,
          forced: Boolean(FORCED_PRESET[type.event_code]),
          presetAvailable: Object.fromEntries(PRESETS.map((item) => [item.id, presetAvailable(item.id)])) as Record<RoutingPreset, boolean>,
          // This row's own delivery is saved by the drawer; anything else stays with the page.
          pageHasOtherUnsavedChanges: draftChanged({ ...draft, eventPresets: { ...draft.eventPresets, [type.event_code]: saved.eventPresets[type.event_code] ?? null } }, saved),
        }
        return <NotificationFlowDrawer open onOpenChange={(open) => !open && setEditingSetting(null)} setting={{ ...setting, enabled: isEnabled(type), channels_enabled: channelsForPreset(preset) }} type={type} delivery={delivery} onSave={saveSingleSetting} />
      })()}

    </div>
  )
}
