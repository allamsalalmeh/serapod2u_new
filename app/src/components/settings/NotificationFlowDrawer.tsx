'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from "../ui/sheet"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"
import { Checkbox } from "../ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Badge } from "../ui/badge"
import {
    AlertCircle, AlertTriangle, ArrowRight, Building2, CheckCircle2, ChevronDown, ChevronRight, History, Info,
    Loader2, Mail, MessageCircle, MessageSquare, Pencil, RefreshCw, Send, Shield, Trash2, User as UserIcon,
    UserCheck, Users, Zap,
} from 'lucide-react'
import { UserMultiSelect } from "./recipients/UserMultiSelect"
import { getTemplatesForEvent } from "../../config/notificationTemplates"
import { parseManualPhoneInput, normalizeAndDedupeManualPhones } from "@/lib/notifications/manualPhoneNumbers"
import { normalizeAndDedupeManualEmails, parseManualEmailInput } from '@/lib/notifications/manualEmailAddresses'
import { sanitizeStockCountNotificationConfig } from '@/lib/notifications/stockCountNotificationConfig'
import { PRESET_LABELS, categoryModule, type DeliverySource } from '@/lib/notifications/notificationTypeModules'
import { appDate, shiftDate } from '@/lib/notifications/monitor/monitorCore'
import type { NotificationRoutingPreset } from '@/lib/notifications/routing'
import { RESOLVABLE_ORDER_EVENTS, type RecipientSource } from '@/lib/notifications/configuredRecipients'
import {
    PRESET_CHANNELS,
    buildNotificationSampleData,
    FIXED_MESSAGE_EVENTS,
    notificationVariableContract,
    renderPreviewSegments,
    unknownPlaceholders,
    type NotificationChannel,
} from '@/lib/notifications/notificationMessagePreview'

/** Delivery as the Notification Types page currently shows it for this notification. */
export interface DrawerDelivery {
    /** Effective preset (page draft). */
    preset: NotificationRoutingPreset
    source: DeliverySource
    /** What this notification inherits when it has no own setting. */
    inherited: { preset: NotificationRoutingPreset; source: DeliverySource }
    /** The notification's own setting as the page currently shows it (null = inherit). */
    eventPreset: NotificationRoutingPreset | null
    /** The notification's own setting as last saved (null = inherit). */
    savedEventPreset: NotificationRoutingPreset | null
    /** Delivery is fixed for this notification and cannot be changed. */
    forced: boolean
    presetAvailable: Record<NotificationRoutingPreset, boolean>
    /** The page has unsaved edits other than this notification's own delivery. */
    pageHasOtherUnsavedChanges?: boolean
}

export interface DrawerSaveOptions {
    /** Present only when this notification's own delivery differs from what is saved. */
    eventPreset?: NotificationRoutingPreset | null
}

interface NotificationFlowDrawerProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    setting: any
    type: any
    delivery: DrawerDelivery
    onSave: (updates: any, options?: DrawerSaveOptions) => Promise<void> | void
}

type SourceKey = 'order_creator' | 'consumer' | 'dynamic_org' | 'roles' | 'users' | 'manual_whatsapp' | 'manual_email'

const CHANNEL_LABELS: Record<NotificationChannel, string> = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' }
const CHANNEL_ICONS: Record<NotificationChannel, typeof Mail> = { whatsapp: MessageCircle, sms: MessageSquare, email: Mail }
const SOURCE_LABELS: Record<DeliverySource, string> = { default: 'Default', category: 'Category', custom: 'Custom', fixed: 'Fixed' }

const DYNAMIC_TARGET_LABELS: Record<string, string> = {
    manufacturer: 'Manufacturer',
    distributor: 'Distributor',
    warehouse: 'Warehouse',
    org_contact: 'Organization contact',
}

const ROLE_OPTIONS: { code: string; label: string }[] = [
    { code: 'SUPER', label: 'Super Admin' },
    { code: 'HQ_ADMIN', label: 'Admin' },
    { code: 'DIST_ADMIN', label: 'Distributor' },
    { code: 'WH_MANAGER', label: 'Warehouse Mgr' },
    { code: 'USER', label: 'User (Staff)' },
]
const roleLabel = (code: string) => ROLE_OPTIONS.find((role) => role.code === code)?.label || code

const SOURCES: { key: SourceKey; label: string; description: string; icon: typeof Mail }[] = [
    { key: 'order_creator', label: 'Order creator', description: 'The user who created the order', icon: UserCheck },
    { key: 'consumer', label: 'Consumer', description: 'The consumer related to the event', icon: UserIcon },
    { key: 'dynamic_org', label: 'Related organization', description: 'Contacts of the organization linked to the event', icon: Building2 },
    { key: 'roles', label: 'Roles', description: 'Users in your organization with these roles', icon: Shield },
    { key: 'users', label: 'Specific users', description: 'Selected internal users', icon: Users },
    { key: 'manual_whatsapp', label: 'WhatsApp numbers', description: 'External numbers, used for WhatsApp delivery', icon: MessageCircle },
    { key: 'manual_email', label: 'Email addresses', description: 'External addresses, used for Email delivery', icon: Mail },
]

const SELECT_CLASS = 'h-9 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 outline-none focus-visible:border-[var(--sera-orange)] focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/25'

// Defensive: the resolver no longer invents people, but never offer one as a target.
const isPlaceholderRecipient = (recipient: any) => String(recipient?.userId || recipient?.user_id || '').startsWith('mock-')
const RECIPIENT_SOURCE_LABELS: Record<RecipientSource, string> = {
    order_creator: 'Order creator',
    users: 'Specific user',
    roles: 'Role',
    saved_list: 'Saved list',
    manual_email: 'Manual email',
    consumer: 'Consumer',
    manual_whatsapp: 'Manual WhatsApp',
    event_address: 'Queued by the event',
}
type ResolveOutcome =
    | { status: 'resolved' | 'empty'; channel: NotificationChannel; recipients: { address: string; source: RecipientSource; name?: string | null; userId?: string | null }[]; notUsedWhenSending: string[] }
    | { status: 'not_found' | 'unsupported'; message: string }
const splitList = (value: unknown) => String(value || '').split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean)

/** Same normalisation the drawer has always applied when it opens. */
function initialLocalSetting(setting: any, type: any) {
    const existingConfig = setting?.recipient_config || {}
    const isOrderOwnerEvent = ['order_rejected', 'order_approved', 'order_closed'].includes(type.event_code)
    const targets = { roles: false, dynamic_org: false, users: false, consumer: false, order_creator: false }
    if (existingConfig.type === 'roles') targets.roles = true
    if (existingConfig.type === 'dynamic') targets.dynamic_org = true
    if (existingConfig.type === 'users') targets.users = true
    if (existingConfig.include_consumer) targets.consumer = true
    if (existingConfig.recipient_targets) Object.assign(targets, existingConfig.recipient_targets)
    if (isOrderOwnerEvent && existingConfig.recipient_targets?.order_creator === undefined) targets.order_creator = true

    const storedTemplates = setting?.templates || {}
    const verificationPreset = type.event_code === 'stock_count_posting_verification'
        ? getTemplatesForEvent(type.event_code, 'email')[0]
        : null
    return {
        ...setting,
        enabled: setting?.enabled ?? false,
        recipient_config: {
            roles: [],
            recipient_users: [],
            dynamic_target: null,
            ...existingConfig,
            recipient_targets: targets,
        },
        channels_enabled: setting?.channels_enabled || [],
        templates: verificationPreset && !storedTemplates.email
            ? { ...storedTemplates, email: verificationPreset.body }
            : storedTemplates,
    }
}

export default function NotificationFlowDrawer(props: NotificationFlowDrawerProps) {
    if (!props.setting || !props.type) return null
    return <DrawerBody {...props} />
}

function DrawerBody({ open, onOpenChange, setting, type, delivery, onSave }: NotificationFlowDrawerProps) {
    const eventCode: string = type.event_code
    const verificationOnly = eventCode === 'stock_count_posting_verification'
    const isOrderEvent = String(type.category || '') === 'order' || eventCode.startsWith('order_')

    // The drawer mounts fresh each time it opens, so the draft is initialised
    // once. Re-renders of the page must not reset edits in progress.
    const [localSetting, setLocalSetting] = useState(() => initialLocalSetting(setting, type))
    const initialConfig = setting?.recipient_config || {}
    const [manualRawInput, setManualRawInput] = useState<string>(() => (Array.isArray(initialConfig.manual_whatsapp_numbers) ? initialConfig.manual_whatsapp_numbers : []).join('\n'))
    const [manualEmailRawInput, setManualEmailRawInput] = useState<string>(() => (Array.isArray(initialConfig.manual_email_addresses) ? initialConfig.manual_email_addresses : []).join('\n'))
    const [manualWhatsappOn, setManualWhatsappOn] = useState(() => manualRawInput.trim().length > 0)
    const [manualEmailOn, setManualEmailOn] = useState(() => manualEmailRawInput.trim().length > 0)
    const [selectedUserDetails, setSelectedUserDetails] = useState<{ id: string; full_name: string; phone?: string }[]>([])

    // Delivery: 'inherit' or the notification's own preset.
    // The drawer edits only this notification's own delivery (inherit or a
    // custom preset). It starts from what the page row shows; whatever it shows
    // when you click Save changes is what gets saved for this notification.
    const [deliveryChoice, setDeliveryChoice] = useState<NotificationRoutingPreset | 'inherit'>(delivery.eventPreset || 'inherit')
    const chosenEventPreset = deliveryChoice === 'inherit' ? null : deliveryChoice
    const deliveryDiffersFromSaved = !delivery.forced && chosenEventPreset !== delivery.savedEventPreset

    // Disclosure state only — never holds draft data.
    const [editingRecipients, setEditingRecipients] = useState(false)
    const [editingMessage, setEditingMessage] = useState(false)
    const [optionsOpen, setOptionsOpen] = useState(false)
    const [testOpen, setTestOpen] = useState(false)

    const [saveError, setSaveError] = useState<string | null>(null)
    const [savingChanges, setSavingChanges] = useState(false)

    const manualParse = useMemo(() => parseManualPhoneInput(manualRawInput), [manualRawInput])
    const manualEmailParse = useMemo(() => parseManualEmailInput(manualEmailRawInput), [manualEmailRawInput])

    const updateRecipientConfig = (updates: any) => {
        setLocalSetting((prev: any) => ({ ...prev, recipient_config: { ...prev.recipient_config, ...updates } }))
    }
    const updateTemplate = (channel: string, text: string) => {
        setLocalSetting((prev: any) => ({ ...prev, templates: { ...prev.templates, [channel]: text } }))
    }

    // Keep valid normalized manual entries mirrored into recipient_config.
    useEffect(() => {
        const normalized = manualParse.valid.map((v) => v.normalized)
        const current: string[] = localSetting?.recipient_config?.manual_whatsapp_numbers || []
        const same = current.length === normalized.length && current.every((v, i) => v === normalized[i])
        if (!same) updateRecipientConfig({ manual_whatsapp_numbers: normalized })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manualParse])
    useEffect(() => {
        const normalized = manualEmailParse.valid.map((value) => value.normalized)
        const current: string[] = localSetting?.recipient_config?.manual_email_addresses || []
        const same = current.length === normalized.length && current.every((value, index) => value === normalized[index])
        if (!same) updateRecipientConfig({ manual_email_addresses: normalized })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manualEmailParse])

    // ---- Recipients -------------------------------------------------------
    const config = localSetting.recipient_config || {}
    const targets = config.recipient_targets || {}
    const setTarget = (key: string, value: boolean, extra: Record<string, unknown> = {}) =>
        updateRecipientConfig({ recipient_targets: { ...targets, [key]: value }, ...extra })

    const sourceVisible = (key: SourceKey) => {
        if (verificationOnly) return key === 'users' || key === 'manual_email'
        if (key === 'order_creator') return isOrderEvent
        if (key === 'manual_email') return Boolean(type.available_channels?.includes('email'))
        return true
    }
    const sourceOn = (key: SourceKey) => {
        if (key === 'manual_whatsapp') return manualWhatsappOn || manualRawInput.trim().length > 0
        if (key === 'manual_email') return manualEmailOn || manualEmailRawInput.trim().length > 0
        return Boolean(targets[key])
    }
    const toggleSource = (key: SourceKey, on: boolean) => {
        if (key === 'manual_whatsapp') {
            setManualWhatsappOn(on)
            if (!on) setManualRawInput('')
            return
        }
        if (key === 'manual_email') {
            setManualEmailOn(on)
            if (!on) setManualEmailRawInput('')
            return
        }
        setTarget(key, on, key === 'consumer' ? { include_consumer: on } : {})
    }
    const clearAllRecipients = () => {
        updateRecipientConfig({
            recipient_targets: { roles: false, dynamic_org: false, users: false, consumer: false, order_creator: false },
            include_consumer: false,
            manual_whatsapp_numbers: [],
            manual_email_addresses: [],
        })
        setManualRawInput('')
        setManualEmailRawInput('')
        setManualWhatsappOn(false)
        setManualEmailOn(false)
    }

    const legacyPhones = splitList(config.custom_phones)
    const legacyEmails = splitList(config.custom_emails)
    const recipientChips: { key: string; label: string; warn?: string }[] = []
    if (sourceVisible('order_creator') && targets.order_creator) recipientChips.push({ key: 'order_creator', label: 'Order creator' })
    if (sourceVisible('consumer') && targets.consumer) recipientChips.push({ key: 'consumer', label: 'Consumer' })
    if (sourceVisible('dynamic_org') && targets.dynamic_org) {
        const target = config.dynamic_target ? DYNAMIC_TARGET_LABELS[config.dynamic_target] || config.dynamic_target : null
        recipientChips.push({ key: 'dynamic_org', label: target ? `Related organization · ${target}` : 'Related organization', warn: target ? undefined : 'No organization role selected' })
    }
    if (sourceVisible('roles') && targets.roles) {
        const roles: string[] = Array.isArray(config.roles) ? config.roles : []
        const label = roles.length === 0 ? 'Roles' : roles.length <= 2 ? `Roles · ${roles.map(roleLabel).join(', ')}` : `Roles · ${roles.length}`
        recipientChips.push({ key: 'roles', label, warn: roles.length ? undefined : 'No roles selected' })
    }
    if (sourceVisible('users') && targets.users) {
        const count = (config.recipient_users || []).length
        recipientChips.push({ key: 'users', label: `Specific users · ${count}`, warn: count ? undefined : 'No users selected' })
    }
    if (sourceVisible('manual_whatsapp') && manualParse.valid.length > 0) recipientChips.push({ key: 'manual_whatsapp', label: `WhatsApp numbers · ${manualParse.valid.length}` })
    if (sourceVisible('manual_email') && manualEmailParse.valid.length > 0) recipientChips.push({ key: 'manual_email', label: `Email addresses · ${manualEmailParse.valid.length}` })
    if (!verificationOnly && legacyPhones.length) recipientChips.push({ key: 'legacy_phones', label: `Saved phone list · ${legacyPhones.length}` })
    if (!verificationOnly && legacyEmails.length) recipientChips.push({ key: 'legacy_emails', label: `Saved email list · ${legacyEmails.length}` })
    const hasRecipientErrors = manualParse.invalid.length > 0 || manualEmailParse.invalid.length > 0

    // ---- Delivery ---------------------------------------------------------
    const effective = delivery.forced
        ? { preset: delivery.preset, source: 'fixed' as DeliverySource }
        : deliveryChoice === 'inherit'
            ? delivery.inherited
            : { preset: deliveryChoice, source: 'custom' as DeliverySource }
    const deliveryChannels = PRESET_CHANNELS[effective.preset]
    const deliveryText = deliveryChannels.map((channel) => CHANNEL_LABELS[channel]).join(' → ')
    const deliverySourceText = effective.source === 'custom'
        ? 'Custom for this notification'
        : effective.source === 'fixed'
            ? 'Fixed for this notification'
            : `Inherited from ${SOURCE_LABELS[effective.source].toLowerCase()}`

    // ---- Message ----------------------------------------------------------
    const [messageChannel, setMessageChannel] = useState<NotificationChannel>(deliveryChannels[0])
    const activeChannel: NotificationChannel = deliveryChannels.includes(messageChannel) ? messageChannel : deliveryChannels[0]
    const templateText = (channel: NotificationChannel) => String(localSetting.templates?.[channel] || '')
    const libraryFor = (channel: NotificationChannel) => getTemplatesForEvent(eventCode, channel)
    // SMS rows may store a library template id; the worker sends that template's body.
    const effectiveBody = (channel: NotificationChannel) => {
        const saved = templateText(channel)
        const byId = channel === 'sms' ? libraryFor(channel).find((template) => template.id === saved.trim()) : undefined
        return byId?.body || saved
    }
    const currentLibrary = libraryFor(activeChannel)
    const currentTemplate = templateText(activeChannel)
    const matchedLibraryTemplate = currentLibrary.find((template) => template.body === currentTemplate || template.id === currentTemplate.trim())
    const { variables, verified: variablesVerified } = useMemo(() => notificationVariableContract(type), [type])
    const fixedMessage = FIXED_MESSAGE_EVENTS[eventCode]
    const sampleData = useMemo(() => buildNotificationSampleData(type), [type])
    const previewBody = effectiveBody(activeChannel)
    const previewSegments = renderPreviewSegments(previewBody, sampleData, variables)
    const unknownVars = unknownPlaceholders(previewBody, variables)
    const otherSavedTemplates = (Object.keys(localSetting.templates || {}) as NotificationChannel[])
        .filter((channel) => channel in CHANNEL_LABELS && !deliveryChannels.includes(channel) && templateText(channel).trim())
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const insertVariable = (name: string) => {
        const token = `{{${name}}}`
        const element = textareaRef.current
        const value = currentTemplate
        const start = element?.selectionStart ?? value.length
        const end = element?.selectionEnd ?? value.length
        updateTemplate(activeChannel, value.slice(0, start) + token + value.slice(end))
        requestAnimationFrame(() => {
            element?.focus()
            element?.setSelectionRange(start + token.length, start + token.length)
        })
    }

    // ---- Test -------------------------------------------------------------
    const [testChannel, setTestChannel] = useState<NotificationChannel>(deliveryChannels[0])
    const activeTestChannel: NotificationChannel = deliveryChannels.includes(testChannel) ? testChannel : deliveryChannels[0]
    const testStep = deliveryChannels.indexOf(activeTestChannel)
    const [quickTestPhone, setQuickTestPhone] = useState('')
    const [sampleId, setSampleId] = useState('')
    const [resolving, setResolving] = useState(false)
    const [resolveOutcome, setResolveOutcome] = useState<ResolveOutcome | null>(null)
    const [resolveError, setResolveError] = useState<string | null>(null)
    const [testSending, setTestSending] = useState(false)
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
    const resolvedRecipients = resolveOutcome && 'recipients' in resolveOutcome && resolveOutcome.channel === activeTestChannel
        ? resolveOutcome.recipients.filter((recipient) => !isPlaceholderRecipient(recipient))
        : null
    const resolvedTarget = resolvedRecipients?.[0] || null
    const canResolve = (RESOLVABLE_ORDER_EVENTS as readonly string[]).includes(eventCode)

    const handleResolve = async () => {
        if (!sampleId.trim()) return
        setResolving(true)
        setResolveError(null)
        try {
            const params = new URLSearchParams({
                eventCode,
                sampleId: sampleId.trim(),
                channel: activeTestChannel,
                recipientConfig: JSON.stringify(localSetting.recipient_config),
            })
            const res = await fetch(`/api/notifications/resolve?${params}`)
            const data = await res.json()
            if (!res.ok || !data.success) throw new Error(data.error || 'Lookup failed')
            if (data.status === 'resolved' || data.status === 'empty') {
                setResolveOutcome({ status: data.status, channel: data.channel || activeTestChannel, recipients: data.recipients || [], notUsedWhenSending: data.notUsedWhenSending || [] })
            } else if (data.status === 'not_found' || data.status === 'unsupported') {
                setResolveOutcome({ status: data.status, message: data.message || '' })
            } else {
                throw new Error('Unexpected lookup response')
            }
        } catch (error: any) {
            setResolveOutcome(null)
            setResolveError(error?.message || 'Lookup failed')
        } finally {
            setResolving(false)
        }
    }

    const handleTestSend = async (recipient: { phone: string; full_name: string }) => {
        setTestSending(true)
        setTestResult(null)
        const channelLabel = CHANNEL_LABELS[activeTestChannel]
        try {
            const res = await fetch('/api/notifications/test-send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    eventCode,
                    channel: activeTestChannel,
                    recipient: { email: '', ...recipient },
                    template: effectiveBody(activeTestChannel),
                    sampleData: buildNotificationSampleData(type, sampleId.trim()),
                }),
            })
            const data = await res.json()
            setTestResult(data.success
                ? { success: true, message: `Test ${channelLabel} sent to ${recipient.phone}.` }
                : { success: false, message: data.status === 'unsupported' ? data.error || `${channelLabel} test sending is not available.` : data.error || 'Unknown error' })
        } catch (error) {
            console.error(error)
            setTestResult({ success: false, message: 'Failed to send' })
        } finally {
            setTestSending(false)
        }
    }

    // ---- Delivery logs: the Monitor, filtered to this notification ---------
    const openDeliveryLogs = () => {
        const to = appDate()
        const params = new URLSearchParams({
            channel: deliveryChannels[0],
            module: categoryModule(String(type.category || '')),
            type: eventCode,
            from: shiftDate(to, -29),
            to,
        })
        // New tab: the drawer keeps its unsaved draft.
        window.open(`/notifications/whatsapp-activity-recovery?${params}`, '_blank', 'noopener')
    }

    // ---- Save -------------------------------------------------------------
    const handleSave = async () => {
        if (manualParse.invalid.length > 0) {
            setSaveError(`There are ${manualParse.invalid.length} invalid WhatsApp number(s). Fix or remove them before saving.`)
            setEditingRecipients(true)
            return
        }
        if (manualEmailParse.invalid.length > 0) {
            setSaveError(`There are ${manualEmailParse.invalid.length} invalid email address(es). Fix or remove them before saving.`)
            setEditingRecipients(true)
            return
        }
        setSaveError(null)
        const cleanManual = normalizeAndDedupeManualPhones(manualParse.valid.map((v) => v.normalized))
        const cleanEmails = normalizeAndDedupeManualEmails(manualEmailParse.valid.map((value) => value.normalized))
        const baseRecipientConfig = {
            ...localSetting.recipient_config,
            manual_whatsapp_numbers: cleanManual,
            manual_email_addresses: cleanEmails,
        }
        const finalSetting = {
            ...localSetting,
            channels_enabled: verificationOnly ? ['email'] : localSetting.channels_enabled,
            recipient_config: verificationOnly
                ? sanitizeStockCountNotificationConfig(baseRecipientConfig, cleanEmails)
                : baseRecipientConfig,
        }
        try {
            setSavingChanges(true)
            await onSave(finalSetting, deliveryDiffersFromSaved ? { eventPreset: chosenEventPreset } : undefined)
            onOpenChange(false)
        } catch (error: any) {
            setSaveError(error?.message || 'Failed to save notification changes.')
        } finally {
            setSavingChanges(false)
        }
    }

    const visibleSources = SOURCES.filter((source) => sourceVisible(source.key))
    const extraRoles: string[] = (Array.isArray(config.roles) ? config.roles : []).filter((code: string) => !ROLE_OPTIONS.some((role) => role.code === code))

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
                {/* Header */}
                <div className="border-b border-slate-200 px-5 pb-4 pt-5 pr-12">
                    <SheetHeader className="space-y-1 text-left">
                        <SheetTitle className="text-lg font-semibold text-slate-950">{type.event_name}</SheetTitle>
                        <SheetDescription className="text-sm text-slate-500">{type.event_description}</SheetDescription>
                    </SheetHeader>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span
                            title="Turn this notification on or off from the Notification Types list."
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${localSetting.enabled ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-500'}`}
                        >
                            <span className={`h-1.5 w-1.5 rounded-full ${localSetting.enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} aria-hidden />
                            {localSetting.enabled ? 'Active' : 'Off'}
                        </span>
                        {type.is_system && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">System</Badge>}
                    </div>
                    {/* Summary: Event → Recipients → Delivery */}
                    <div aria-label="Summary" className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                        <span className="inline-flex items-center gap-1"><Zap className="h-3.5 w-3.5 text-[var(--sera-orange)]" aria-hidden /><span className="sr-only">Event:</span>{type.event_name}</span>
                        <ArrowRight className="h-3 w-3 text-slate-400" aria-hidden />
                        <span className="inline-flex items-center gap-1">
                            <Users className="h-3.5 w-3.5 text-slate-400" aria-hidden /><span className="sr-only">Recipients:</span>
                            {recipientChips.length === 0 ? 'No recipient sources' : recipientChips.map((chip) => chip.label).join(', ')}
                        </span>
                        <ArrowRight className="h-3 w-3 text-slate-400" aria-hidden />
                        <span className="inline-flex items-center gap-1"><Send className="h-3.5 w-3.5 text-slate-400" aria-hidden /><span className="sr-only">Delivery:</span>{deliveryText}</span>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
                    {/* Recipients */}
                    <section aria-labelledby="drawer-recipients-title" className="rounded-lg border border-slate-200 bg-white">
                        <div className="flex items-center justify-between gap-2 px-4 pt-3">
                            <h3 id="drawer-recipients-title" className="text-sm font-semibold text-slate-900">Recipients</h3>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-expanded={editingRecipients}
                                aria-controls="drawer-recipients-editor"
                                onClick={() => setEditingRecipients((value) => !value)}
                                className="h-7 gap-1 px-2 text-[var(--sera-orange)] hover:text-[var(--sera-orange)]"
                            >
                                {editingRecipients ? 'Done' : <><Pencil className="h-3.5 w-3.5" /> Edit recipients</>}
                            </Button>
                        </div>
                        <div className="px-4 pb-3 pt-2">
                            {recipientChips.length > 0 ? (
                                <ul className="flex flex-wrap gap-1.5" aria-label="Selected recipients">
                                    {recipientChips.map((chip) => (
                                        <li key={chip.key} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${chip.warn ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                                            {chip.warn && <AlertTriangle className="h-3 w-3" aria-hidden />}
                                            {chip.label}
                                            {chip.warn && <span className="text-amber-700">— {chip.warn}</span>}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="flex items-start gap-1.5 text-xs text-slate-600">
                                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
                                    No recipient sources selected. Nothing is added from this list; the notification only reaches an address the triggering event provides itself, if any.
                                </p>
                            )}
                            {hasRecipientErrors && !editingRecipients && (
                                <p className="mt-2 text-xs text-red-700">Some manual entries are invalid. Edit recipients to fix them.</p>
                            )}
                        </div>

                        {editingRecipients && (
                            <div id="drawer-recipients-editor" className="border-t border-slate-100 px-4 py-3">
                                <ul className="divide-y divide-slate-100">
                                    {visibleSources.map((source) => {
                                        const on = sourceOn(source.key)
                                        const Icon = source.icon
                                        const id = `recipient-source-${source.key}`
                                        return (
                                            <li key={source.key} className="py-2">
                                                <div className="flex items-start gap-2.5">
                                                    <Checkbox id={id} checked={on} onCheckedChange={(checked) => toggleSource(source.key, !!checked)} className="mt-0.5" />
                                                    <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                                                        <span className="flex items-center gap-1.5 text-sm font-medium text-slate-800"><Icon className="h-3.5 w-3.5 text-slate-400" aria-hidden />{source.label}</span>
                                                        <span className="block text-xs text-slate-500">{source.description}</span>
                                                    </label>
                                                </div>

                                                {on && source.key === 'dynamic_org' && (
                                                    <div className="ml-6 mt-2 max-w-xs space-y-1">
                                                        <Label htmlFor="dynamic-target" className="text-xs text-slate-600">Organization role</Label>
                                                        <Select value={config.dynamic_target || ''} onValueChange={(value) => updateRecipientConfig({ dynamic_target: value })}>
                                                            <SelectTrigger id="dynamic-target" className="h-8 text-sm"><SelectValue placeholder="Select target..." /></SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value="manufacturer">Manufacturer (Product Owner)</SelectItem>
                                                                <SelectItem value="distributor">Distributor (Seller)</SelectItem>
                                                                <SelectItem value="warehouse">Warehouse</SelectItem>
                                                                {config.dynamic_target && !['manufacturer', 'distributor', 'warehouse'].includes(config.dynamic_target) && (
                                                                    <SelectItem value={config.dynamic_target}>{DYNAMIC_TARGET_LABELS[config.dynamic_target] || config.dynamic_target}</SelectItem>
                                                                )}
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                )}

                                                {on && source.key === 'roles' && (
                                                    <fieldset className="ml-6 mt-2">
                                                        <legend className="sr-only">Roles</legend>
                                                        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                                                            {[...ROLE_OPTIONS, ...extraRoles.map((code) => ({ code, label: code }))].map(({ code, label }) => (
                                                                <label key={code} className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-700">
                                                                    <Checkbox
                                                                        checked={Boolean(config.roles?.includes(code))}
                                                                        onCheckedChange={(checked) => {
                                                                            const current: string[] = config.roles || []
                                                                            updateRecipientConfig({ roles: checked ? [...current, code] : current.filter((role) => role !== code) })
                                                                        }}
                                                                    />
                                                                    {label}
                                                                </label>
                                                            ))}
                                                        </div>
                                                    </fieldset>
                                                )}

                                                {on && source.key === 'users' && (
                                                    <div className="ml-6 mt-2 space-y-2">
                                                        <UserMultiSelect
                                                            selectedUserIds={config.recipient_users || []}
                                                            onSelectionChange={(ids) => updateRecipientConfig({ recipient_users: ids })}
                                                            onUsersLoaded={(users) => setSelectedUserDetails(users)}
                                                        />
                                                        {selectedUserDetails.length > 0 && (
                                                            <ul className="max-h-36 space-y-1 overflow-y-auto rounded border border-slate-100 bg-slate-50/60 p-2">
                                                                {selectedUserDetails.map((user) => (
                                                                    <li key={user.id} className="flex items-center justify-between text-xs">
                                                                        <span className="font-medium text-slate-700">{user.full_name}</span>
                                                                        {user.phone ? <span className="text-slate-500">{user.phone}</span> : <span className="italic text-amber-600">no phone</span>}
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        )}
                                                    </div>
                                                )}

                                                {on && source.key === 'manual_whatsapp' && (
                                                    <div className="ml-6 mt-2 space-y-2">
                                                        <Textarea
                                                            aria-label="WhatsApp numbers"
                                                            placeholder="60123456789, 8613812345678 (comma, space or new line separated)"
                                                            className="min-h-[72px] font-mono text-xs"
                                                            value={manualRawInput}
                                                            onChange={(event) => setManualRawInput(event.target.value)}
                                                        />
                                                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                                                            <span>{manualParse.valid.length} valid · {manualParse.invalid.length} invalid · {manualParse.duplicatesRemoved} duplicate removed · {manualParse.totalEntered}/500. Malaysian 0XX gets 60.</span>
                                                            <span className="flex gap-1">
                                                                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setManualRawInput([...manualParse.valid.map((v) => v.normalized), ...manualParse.invalid.map((i) => i.original)].join('\n'))}>
                                                                    <RefreshCw className="mr-1 h-3 w-3" /> Normalize
                                                                </Button>
                                                                <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setManualRawInput('')}>
                                                                    <Trash2 className="mr-1 h-3 w-3" /> Clear
                                                                </Button>
                                                            </span>
                                                        </div>
                                                        {manualParse.invalid.length > 0 && (
                                                            <ul className="max-h-28 divide-y divide-red-100 overflow-y-auto rounded border border-red-200 bg-red-50/50 text-xs">
                                                                {manualParse.invalid.map((entry, index) => (
                                                                    <li key={`${entry.original}-${index}`} className="flex items-center justify-between gap-2 px-2 py-1">
                                                                        <span><span className="font-mono">{entry.original}</span> <span className="text-red-600">{entry.reason}</span></span>
                                                                        <button
                                                                            type="button"
                                                                            className="text-[11px] text-red-600 underline hover:text-red-800"
                                                                            onClick={() => {
                                                                                const tokens = manualRawInput.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)
                                                                                const at = tokens.findIndex((t) => t === entry.original)
                                                                                if (at >= 0) tokens.splice(at, 1)
                                                                                setManualRawInput(tokens.join('\n'))
                                                                            }}
                                                                        >
                                                                            Remove
                                                                        </button>
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        )}
                                                        {!deliveryChannels.includes('whatsapp') && manualParse.valid.length > 0 && (
                                                            <p className="text-[11px] text-amber-700">Current delivery doesn&apos;t include WhatsApp, so these numbers aren&apos;t used.</p>
                                                        )}
                                                    </div>
                                                )}

                                                {on && source.key === 'manual_email' && (
                                                    <div className="ml-6 mt-2 space-y-2">
                                                        <Textarea
                                                            aria-label="Email addresses"
                                                            placeholder={'approver@example.com\nmanager@example.com'}
                                                            className="min-h-[72px] font-mono text-xs"
                                                            value={manualEmailRawInput}
                                                            onChange={(event) => setManualEmailRawInput(event.target.value)}
                                                        />
                                                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                                                            <span>{manualEmailParse.valid.length} valid · {manualEmailParse.invalid.length} invalid · {manualEmailParse.duplicatesRemoved} duplicate removed</span>
                                                            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setManualEmailRawInput('')}>
                                                                <Trash2 className="mr-1 h-3 w-3" /> Clear
                                                            </Button>
                                                        </div>
                                                        {manualEmailParse.invalid.length > 0 && (
                                                            <ul className="max-h-28 divide-y divide-red-100 overflow-y-auto rounded border border-red-200 bg-red-50/50 text-xs">
                                                                {manualEmailParse.invalid.map((entry, index) => (
                                                                    <li key={`${entry.original}-${index}`} className="flex justify-between gap-2 px-2 py-1">
                                                                        <span className="font-mono text-red-700">{entry.original}</span><span className="text-red-500">{entry.reason}</span>
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        )}
                                                        {!deliveryChannels.includes('email') && manualEmailParse.valid.length > 0 && (
                                                            <p className="text-[11px] text-amber-700">Current delivery doesn&apos;t include Email, so these addresses aren&apos;t used.</p>
                                                        )}
                                                    </div>
                                                )}
                                            </li>
                                        )
                                    })}
                                </ul>
                                {(legacyPhones.length > 0 || legacyEmails.length > 0) && !verificationOnly && (
                                    <p className="mt-2 text-[11px] text-slate-500">Saved phone/email lists from an earlier setup are kept and still used when sending.</p>
                                )}
                                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2">
                                    <p className="flex items-center gap-1 text-[11px] text-slate-500"><Info className="h-3 w-3" aria-hidden /> Selected sources are combined; duplicates are removed before sending.</p>
                                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs text-slate-600" onClick={clearAllRecipients}>Clear all</Button>
                                </div>
                            </div>
                        )}
                    </section>

                    {/* Message */}
                    <section aria-labelledby="drawer-message-title" className="rounded-lg border border-slate-200 bg-white">
                        <div className="flex items-center justify-between gap-2 px-4 pt-3">
                            <h3 id="drawer-message-title" className="text-sm font-semibold text-slate-900">Message</h3>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-expanded={editingMessage}
                                aria-controls="drawer-message-editor"
                                onClick={() => setEditingMessage((value) => !value)}
                                className="h-7 gap-1 px-2 text-[var(--sera-orange)] hover:text-[var(--sera-orange)]"
                            >
                                {editingMessage ? 'Done' : <><Pencil className="h-3.5 w-3.5" /> Edit message</>}
                            </Button>
                        </div>
                        <div className="space-y-3 px-4 pb-4 pt-2">
                            {fixedMessage && (
                                <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                                    <span>{fixedMessage} Saved templates below are kept but not used when sending.</span>
                                </p>
                            )}
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                                <span className="text-slate-500">Delivery</span>
                                <span className="font-medium text-slate-800">{deliveryText}</span>
                                <span className={`rounded-full border px-2 py-0.5 text-[11px] ${effective.source === 'custom' ? 'border-[var(--sera-orange)]/30 bg-orange-50 text-[var(--sera-orange)]' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
                                    {deliverySourceText}
                                </span>
                                {deliveryChannels.length > 1 && <span className="text-slate-400">Later channels are tried only if the previous one fails.</span>}
                            </div>

                            {deliveryChannels.length > 1 && (
                                <div role="group" aria-label="Message channel" className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
                                    {deliveryChannels.map((channel) => {
                                        const Icon = CHANNEL_ICONS[channel]
                                        const selected = channel === activeChannel
                                        return (
                                            <button
                                                key={channel}
                                                type="button"
                                                aria-pressed={selected}
                                                onClick={() => setMessageChannel(channel)}
                                                className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40 ${selected ? 'bg-white text-[var(--sera-orange)] shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                                            >
                                                <Icon className="h-3.5 w-3.5" aria-hidden />
                                                {CHANNEL_LABELS[channel]}
                                                <span className={`h-1.5 w-1.5 rounded-full ${templateText(channel).trim() ? 'bg-emerald-500' : 'bg-slate-300'}`} aria-label={templateText(channel).trim() ? 'custom message set' : 'no custom message'} />
                                            </button>
                                        )
                                    })}
                                </div>
                            )}

                            <div className="space-y-1">
                                <Label htmlFor="template-library" className="text-xs text-slate-600">Template Library · {CHANNEL_LABELS[activeChannel]}</Label>
                                <Select
                                    value={matchedLibraryTemplate?.id || ''}
                                    onValueChange={(value) => {
                                        const selected = currentLibrary.find((template) => template.id === value)
                                        if (selected) updateTemplate(activeChannel, selected.body)
                                    }}
                                >
                                    <SelectTrigger id="template-library" className="h-9 text-sm"><SelectValue placeholder={currentTemplate.trim() ? 'Custom message' : 'Choose a template...'} /></SelectTrigger>
                                    <SelectContent>
                                        {currentLibrary.length > 0 ? currentLibrary.map((template) => (
                                            <SelectItem key={template.id} value={template.id}>
                                                <div className="flex flex-col">
                                                    <span>{template.name}</span>
                                                    {template.description && <span className="text-xs text-gray-400">{template.description}</span>}
                                                </div>
                                            </SelectItem>
                                        )) : <div className="p-2 text-center text-xs text-gray-500">No preset templates</div>}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div>
                                <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                                    <span>Preview · sample data</span>
                                    {unknownVars.length === 0 && previewSegments.some((segment) => segment.kind === 'unresolved') && <span>Highlighted placeholders have no sample value</span>}
                                </div>
                                {previewBody.trim() ? (
                                    <div data-testid="message-preview" className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50/60 p-3 text-sm text-slate-800">
                                        {activeChannel === 'email' && (
                                            <div className="mb-2 border-b border-slate-200 pb-2 text-xs text-slate-500">
                                                Subject: {matchedLibraryTemplate?.subject
                                                    ? renderPreviewSegments(matchedLibraryTemplate.subject, sampleData, variables).map((segment) => segment.text).join('')
                                                    : 'set by the system'}
                                            </div>
                                        )}
                                        {previewSegments.map((segment, index) => segment.kind === 'unresolved'
                                            ? <mark key={index} className="rounded bg-amber-100 px-0.5 font-mono text-[0.85em] text-amber-900" title="No value for this placeholder — it is sent as typed">{segment.text}</mark>
                                            : <span key={index}>{segment.text}</span>)}
                                    </div>
                                ) : (
                                    <p className="rounded-md border border-dashed border-slate-200 p-3 text-xs text-slate-500">
                                        No custom {CHANNEL_LABELS[activeChannel]} message. The system&apos;s built-in message for this notification is sent.
                                    </p>
                                )}
                                {unknownVars.length > 0 && (
                                    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-800">
                                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                                        <span>{unknownVars.map((name) => `{{${name}}}`).join(', ')} {unknownVars.length === 1 ? 'is' : 'are'} {variablesVerified ? 'not supplied for this notification' : 'not in this notification\'s documented variables'} and will be sent as typed if no value arrives. Placeholders are case-sensitive.</span>
                                    </p>
                                )}
                                {otherSavedTemplates.length > 0 && (
                                    <p className="mt-1.5 text-[11px] text-slate-500">
                                        Saved {otherSavedTemplates.map((channel) => CHANNEL_LABELS[channel]).join(', ')} message kept; not used by the current delivery.
                                    </p>
                                )}
                            </div>

                            {editingMessage && (
                                <div id="drawer-message-editor" className="space-y-2 border-t border-slate-100 pt-3">
                                    <Label htmlFor="message-content" className="text-xs text-slate-600">{CHANNEL_LABELS[activeChannel]} message</Label>
                                    <Textarea
                                        id="message-content"
                                        ref={textareaRef}
                                        placeholder={`Enter ${CHANNEL_LABELS[activeChannel]} message content...`}
                                        className="min-h-[140px] font-mono text-sm"
                                        value={currentTemplate}
                                        onChange={(event) => updateTemplate(activeChannel, event.target.value)}
                                    />
                                    <div>
                                        <p className="mb-1 text-[11px] text-slate-500">
                                            {variables.length === 0 ? 'No variables are supplied for this notification.' : 'Variables — click to insert'}
                                            {variables.length > 0 && !variablesVerified && ' (no sender for this notification was found in the app, so these are unconfirmed)'}
                                        </p>
                                        <div className="flex flex-wrap gap-1">
                                            {variables.map((name) => (
                                                <button
                                                    key={name}
                                                    type="button"
                                                    onClick={() => insertVariable(name)}
                                                    className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-600 hover:border-[var(--sera-orange)]/40 hover:text-[var(--sera-orange)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40"
                                                >
                                                    {`{{${name}}}`}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>

                    {/* Additional options */}
                    <Disclosure id="drawer-additional-options" title="Additional options" open={optionsOpen} onToggle={() => setOptionsOpen((value) => !value)}>
                        <div className="space-y-1.5">
                            <Label htmlFor="drawer-delivery" className="text-xs text-slate-600">Delivery for {type.event_name}</Label>
                            {delivery.forced ? (
                                <p id="drawer-delivery" className="text-sm text-slate-700">Fixed · {PRESET_LABELS[delivery.preset]} — this notification always uses this delivery.</p>
                            ) : (
                                <select
                                    id="drawer-delivery"
                                    value={deliveryChoice}
                                    onChange={(event) => setDeliveryChoice(event.target.value as NotificationRoutingPreset | 'inherit')}
                                    className={`${SELECT_CLASS} sm:max-w-sm ${deliveryChoice !== 'inherit' ? 'border-[var(--sera-orange)]/40' : ''}`}
                                >
                                    <option value="inherit">Inherit · {SOURCE_LABELS[delivery.inherited.source]} · {PRESET_LABELS[delivery.inherited.preset]}</option>
                                    {(Object.keys(PRESET_LABELS) as NotificationRoutingPreset[]).map((preset) => {
                                        const available = delivery.presetAvailable[preset]
                                        return (
                                            <option key={preset} value={preset} disabled={!available && deliveryChoice !== preset}>
                                                Custom · {PRESET_LABELS[preset]}{available ? '' : ' (unavailable)'}
                                            </option>
                                        )
                                    })}
                                </select>
                            )}
                            {!delivery.forced && (
                                <p className="text-[11px] text-slate-500">
                                    Inherit follows the {delivery.inherited.source === 'category' ? 'category' : 'default'} delivery and changes with it. A custom delivery stays as chosen when the category or default changes, even if it matches them.
                                </p>
                            )}
                            {deliveryDiffersFromSaved && (
                                <p className="text-[11px] text-[var(--sera-orange)]">
                                    Save changes will save this notification&apos;s delivery as {deliveryChoice === 'inherit' ? 'Inherit' : `Custom · ${PRESET_LABELS[deliveryChoice]}`} (saved now: {delivery.savedEventPreset ? `Custom · ${PRESET_LABELS[delivery.savedEventPreset]}` : 'Inherit'}).
                                </p>
                            )}
                            {delivery.pageHasOtherUnsavedChanges && (
                                <p className="text-[11px] text-amber-700">Other unsaved changes on the Notification Types page (default, categories or other notifications) are not saved here; inherited delivery above reflects them. Use the page&apos;s Save Changes for those.</p>
                            )}
                        </div>
                    </Disclosure>

                    {/* Test notification */}
                    <Disclosure id="drawer-test" title="Test notification" open={testOpen} onToggle={() => setTestOpen((value) => !value)}>
                        <div className="space-y-3">
                            {deliveryChannels.length > 1 && (
                                <div role="group" aria-label="Channel to test" className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
                                    {deliveryChannels.map((channel, index) => (
                                        <button
                                            key={channel}
                                            type="button"
                                            aria-pressed={channel === activeTestChannel}
                                            onClick={() => { setTestChannel(channel); setTestResult(null) }}
                                            className={`rounded px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40 ${channel === activeTestChannel ? 'bg-white text-[var(--sera-orange)] shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                                        >
                                            {CHANNEL_LABELS[channel]}{index > 0 ? ' (fallback)' : ''}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <p className="text-xs text-slate-600">
                                Testing <span className="font-medium text-slate-800">{CHANNEL_LABELS[activeTestChannel]}</span>
                                {deliveryChannels.length > 1 ? ` — step ${testStep + 1} of ${deliveryText}` : ''}.
                                {' '}Uses the current draft {CHANNEL_LABELS[activeTestChannel]} message (unsaved edits included) with sample data. Nothing is saved.
                            </p>

                            {fixedMessage ? (
                                <p className="flex items-start gap-1.5 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
                                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                                    Test sends here use the saved message templates, which this notification doesn&apos;t use. {fixedMessage}
                                </p>
                            ) : activeTestChannel === 'email' ? (
                                <p className="flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                                    Email test sending isn&apos;t available. No email test can be sent from here, and none is recorded as delivered.
                                </p>
                            ) : (
                                <>
                                    <div className="space-y-1">
                                        <Label htmlFor="test-phone" className="text-xs text-slate-600">Send to a phone number</Label>
                                        <div className="flex gap-2">
                                            <Input id="test-phone" placeholder="e.g. 0192277233" value={quickTestPhone} onChange={(event) => setQuickTestPhone(event.target.value)} className="h-9 flex-1" />
                                            <Button
                                                type="button"
                                                size="sm"
                                                className="h-9 gap-1.5 bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange)]/90"
                                                disabled={testSending || !quickTestPhone.trim()}
                                                onClick={() => handleTestSend({ phone: quickTestPhone.trim(), full_name: 'Test Recipient' })}
                                            >
                                                {testSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                                                Send test {CHANNEL_LABELS[activeTestChannel]}
                                            </Button>
                                        </div>
                                        <p className="text-[11px] text-slate-500">With or without country code; Malaysian numbers get 60 automatically.</p>
                                    </div>

                                    <div className="space-y-1 border-t border-slate-100 pt-3">
                                        <Label htmlFor="test-sample" className="text-xs text-slate-600">Send to a resolved recipient</Label>
                                        {canResolve ? (
                                            <>
                                                <div className="flex gap-2">
                                                    <Input id="test-sample" placeholder="Order number, e.g. ORD26000049" value={sampleId} onChange={(event) => { setSampleId(event.target.value); setResolveOutcome(null) }} className="h-9 flex-1" />
                                                    <Button type="button" variant="outline" size="sm" className="h-9" onClick={handleResolve} disabled={resolving || !sampleId.trim()}>
                                                        {resolving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Find recipients'}
                                                    </Button>
                                                </div>
                                                <p className="text-[11px] text-slate-500">Needs a real order in your organization. Looks up who would receive its {CHANNEL_LABELS[activeTestChannel]} message with your current draft recipients, using the same rules as sending.</p>
                                                {resolveError && <p role="alert" className="text-xs text-red-700">Lookup failed: {resolveError}</p>}
                                                {resolveOutcome && !('recipients' in resolveOutcome) && <p className="text-xs text-slate-600">{resolveOutcome.message}</p>}
                                                {resolveOutcome && 'recipients' in resolveOutcome && resolveOutcome.notUsedWhenSending.includes('dynamic_org') && (
                                                    <p className="text-[11px] text-amber-700">Related organization is selected but no sender uses it, so it adds nobody.</p>
                                                )}
                                                {resolvedRecipients && (resolvedRecipients.length === 0 ? (
                                                    <p className="text-xs text-slate-600">No {CHANNEL_LABELS[activeTestChannel]} recipients resolve for this order.</p>
                                                ) : (
                                                    <div className="space-y-2">
                                                        <ul aria-label="Resolved recipients" className="max-h-36 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200 text-xs">
                                                            {resolvedRecipients.map((recipient) => (
                                                                <li key={recipient.address} className="flex items-center justify-between gap-2 px-2 py-1.5">
                                                                    <span className="font-medium text-slate-700">{recipient.name || recipient.address}</span>
                                                                    <span className="text-slate-500">{recipient.name ? `${recipient.address} · ` : ''}{RECIPIENT_SOURCE_LABELS[recipient.source] || recipient.source}</span>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                        {resolvedTarget && (
                                                            <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={testSending} onClick={() => handleTestSend({ phone: resolvedTarget.address, full_name: resolvedTarget.name || 'Test Recipient' })}>
                                                                {testSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                                                                Send test {CHANNEL_LABELS[activeTestChannel]} to {resolvedTarget.name || resolvedTarget.address} ({resolvedTarget.address})
                                                            </Button>
                                                        )}
                                                    </div>
                                                ))}
                                            </>
                                        ) : (
                                            <p id="test-sample" className="text-[11px] text-slate-500">Recipient lookup from a sample record is available for Order Submitted, Approved, Rejected and Closed only.</p>
                                        )}
                                    </div>
                                </>
                            )}

                            {testResult && (
                                <p role="status" className={`rounded-md border p-2 text-xs ${testResult.success ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
                                    {testResult.success ? testResult.message : `Failed: ${testResult.message}`}
                                </p>
                            )}
                        </div>
                    </Disclosure>

                    {/* Delivery logs */}
                    <div>
                        <button
                            type="button"
                            onClick={openDeliveryLogs}
                            className="inline-flex items-center gap-1 rounded text-xs font-medium text-[var(--sera-orange)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40"
                        >
                            <History className="h-3.5 w-3.5" aria-hidden /> View delivery logs
                            <span className="sr-only"> (opens the Notification Monitor in a new tab)</span>
                        </button>
                        <p className="mt-0.5 text-[11px] text-slate-500">Opens the Notification Monitor for {CHANNEL_LABELS[deliveryChannels[0]]}, filtered to this notification, last 30 days.</p>
                    </div>
                </div>

                {/* Footer */}
                <div className="border-t border-slate-200 bg-white px-5 py-3">
                    {saveError && (
                        <p role="alert" className="mb-2 flex items-center gap-1.5 text-xs text-red-700">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />{saveError}
                        </p>
                    )}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
                        <Button type="button" size="sm" onClick={handleSave} disabled={savingChanges} className="gap-1.5 bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange)]/90">
                            {savingChanges ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                            {savingChanges ? 'Saving…' : 'Save changes'}
                        </Button>
                    </div>
                </div>
            </SheetContent>
        </Sheet>
    )
}

function Disclosure({ id, title, open, onToggle, children }: { id: string; title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
    return (
        <section className="rounded-lg border border-slate-200 bg-white">
            <h3 className="text-sm">
                <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={id}
                    onClick={onToggle}
                    className="flex w-full items-center gap-1.5 rounded-lg px-4 py-2.5 text-left font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--sera-orange)]/30"
                >
                    {open ? <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden /> : <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden />}
                    {title}
                </button>
            </h3>
            {open && <div id={id} className="border-t border-slate-100 px-4 py-3">{children}</div>}
        </section>
    )
}
