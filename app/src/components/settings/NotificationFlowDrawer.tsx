'use client'

import { useState, useEffect, useMemo } from 'react'
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
    SheetFooter,
} from "../ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Textarea } from "../ui/textarea"
import { RadioGroup, RadioGroupItem } from "../ui/radio-group"
import { Checkbox } from "../ui/checkbox"
import { Card, CardContent } from "../ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Badge } from "../ui/badge"
import {
    GitBranch, Users, MessageSquare, TestTube, History,
    ArrowRight, CheckCircle2, AlertCircle, Loader2, Play,
    User as UserIcon, UserCheck, Building2, MessageCircle, Mail, Copy, RefreshCw, Trash2, Info
} from 'lucide-react'
import { ScrollArea } from "../ui/scroll-area"
import { UserMultiSelect } from "./recipients/UserMultiSelect"
import { RecipientsPreviewPopover } from "./recipients/RecipientsPreviewPopover"
import { getTemplatesForEvent, Template } from "../../config/notificationTemplates"
import { parseManualPhoneInput, normalizeAndDedupeManualPhones, type ManualPhoneCountry } from "@/lib/notifications/manualPhoneNumbers"
import { normalizeAndDedupeManualEmails, parseManualEmailInput } from '@/lib/notifications/manualEmailAddresses'
import { sanitizeStockCountNotificationConfig } from '@/lib/notifications/stockCountNotificationConfig'

interface NotificationFlowDrawerProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    setting: any
    type: any
    onSave: (updates: any) => Promise<void> | void
}

export default function NotificationFlowDrawer({
    open,
    onOpenChange,
    setting,
    type,
    onSave
}: NotificationFlowDrawerProps) {
    if (!setting || !type) return null

    const [activeTab, setActiveTab] = useState('flow')
    // Local state for edits
    const [localSetting, setLocalSetting] = useState(setting)

    // Preview State
    const [sampleId, setSampleId] = useState('')
    const [resolving, setResolving] = useState(false)
    const [resolvedRecipients, setResolvedRecipients] = useState<any[]>([])

    // Test Send State
    const [testSending, setTestSending] = useState(false)
    const [testResult, setTestResult] = useState<any>(null)

    // Selected user detail cache (from UserMultiSelect)
    const [selectedUserDetails, setSelectedUserDetails] = useState<{ id: string; full_name: string; phone?: string }[]>([])

    // Logs
    const [logs, setLogs] = useState<any[]>([])
    const [loadingLogs, setLoadingLogs] = useState(false)

    // Manual WhatsApp Numbers (raw textarea input + active recipient source focus)
    const [manualRawInput, setManualRawInput] = useState<string>('')
    const [manualEmailRawInput, setManualEmailRawInput] = useState<string>('')
    const [activeSource, setActiveSource] = useState<'order_creator' | 'consumer' | 'dynamic_org' | 'users' | 'manual_whatsapp' | 'manual_email' | 'roles'>('consumer')
    const [saveError, setSaveError] = useState<string | null>(null)
    const [savingChanges, setSavingChanges] = useState(false)

    useEffect(() => {
        // Init & Migration Logic
        const existingConfig = setting?.recipient_config || {}

        const isOrderOwnerEvent = ['order_rejected', 'order_approved', 'order_closed'].includes(type.event_code)

        // 1. Establish default targets (all false)
        const targets = {
            roles: false,
            dynamic_org: false,
            users: false,
            consumer: false,
            order_creator: false,
        }

        // 2. Migrate old 'type' or 'recipient_mode' to new targets
        if (existingConfig.type === 'roles') targets.roles = true
        if (existingConfig.type === 'dynamic') targets.dynamic_org = true
        if (existingConfig.type === 'users') targets.users = true
        if (existingConfig.include_consumer) targets.consumer = true

        // 3. If we already have stored new structure, use it
        if (existingConfig.recipient_targets) {
            Object.assign(targets, existingConfig.recipient_targets)
        }
        if (isOrderOwnerEvent && existingConfig.recipient_targets?.order_creator === undefined) {
            targets.order_creator = true
        }

        const storedTemplates = setting?.templates || {}
        const verificationPreset = type.event_code === 'stock_count_posting_verification'
            ? getTemplatesForEvent(type.event_code, 'email')[0]
            : null
        const safeSetting = {
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
                : storedTemplates
        }
        setLocalSetting(safeSetting)
        setResolvedRecipients([])
        setSampleId('')
        setTestResult(null)

        // Hydrate manual whatsapp numbers from saved config
        const existingManual: string[] = Array.isArray(existingConfig.manual_whatsapp_numbers)
            ? existingConfig.manual_whatsapp_numbers
            : []
        setManualRawInput(existingManual.join('\n'))
        const existingEmails: string[] = Array.isArray(existingConfig.manual_email_addresses) ? existingConfig.manual_email_addresses : []
        setManualEmailRawInput(existingEmails.join('\n'))
        setSaveError(null)

        // Pick first enabled source as active for the right-side panel
        if (type.event_code === 'stock_count_posting_verification' && targets.users) setActiveSource('users')
        else if (type.event_code === 'stock_count_posting_verification') setActiveSource('manual_email')
        else if (targets.order_creator) setActiveSource('order_creator')
        else if (targets.consumer) setActiveSource('consumer')
        else if (targets.dynamic_org) setActiveSource('dynamic_org')
        else if (targets.users) setActiveSource('users')
        else if (existingManual.length > 0) setActiveSource('manual_whatsapp')
        else setActiveSource(isOrderOwnerEvent ? 'order_creator' : 'consumer')
    }, [setting, open])

    // Live parse manual whatsapp numbers for the right-side panel
    const manualParse = useMemo(() => parseManualPhoneInput(manualRawInput), [manualRawInput])
    const manualEmailParse = useMemo(() => parseManualEmailInput(manualEmailRawInput), [manualEmailRawInput])
    const manualEnabled = manualParse.valid.length > 0 || manualRawInput.trim().length > 0

    // Sync valid normalized numbers into recipient_config whenever they change
    useEffect(() => {
        const normalized = manualParse.valid.map((v) => v.normalized)
        const current: string[] = localSetting?.recipient_config?.manual_whatsapp_numbers || []
        // Only update when set changed (avoid loop)
        const same = current.length === normalized.length && current.every((v, i) => v === normalized[i])
        if (!same) {
            updateRecipientConfig({ manual_whatsapp_numbers: normalized })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manualParse])

    useEffect(() => {
        const normalized = manualEmailParse.valid.map((value) => value.normalized)
        const current: string[] = localSetting?.recipient_config?.manual_email_addresses || []
        const same = current.length === normalized.length && current.every((value, index) => value === normalized[index])
        if (!same) updateRecipientConfig({ manual_email_addresses: normalized })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [manualEmailParse])

    useEffect(() => {
        if (activeTab === 'logs' && open) {
            fetchLogs()
        }
    }, [activeTab, open])

    const fetchLogs = async () => {
        setLoadingLogs(true)
        try {
            const res = await fetch(`/api/notifications/logs?eventCode=${type.event_code}`)
            const data = await res.json()
            if (data.success) {
                setLogs(data.logs)
            }
        } catch (error) {
            console.error(error)
        } finally {
            setLoadingLogs(false)
        }
    }

    const updateRecipientConfig = (updates: any) => {
        setLocalSetting((prev: any) => ({
            ...prev,
            recipient_config: { ...prev.recipient_config, ...updates }
        }))
    }

    const updateTemplate = (channel: string, text: string) => {
        setLocalSetting((prev: any) => ({
            ...prev,
            templates: { ...prev.templates, [channel]: text }
        }))
    }

    const handleResolve = async () => {
        if (!sampleId) return
        setResolving(true)
        try {
            const params = new URLSearchParams({
                eventCode: type.event_code,
                sampleId: sampleId,
                recipientConfig: JSON.stringify(localSetting.recipient_config)
            })
            const res = await fetch(`/api/notifications/resolve?${params}`)
            const data = await res.json()
            if (data.success) {
                setResolvedRecipients(data.recipients)
            }
        } catch (error) {
            console.error(error)
        } finally {
            setResolving(false)
        }
    }

    // Quick test phone number
    const [quickTestPhone, setQuickTestPhone] = useState('')

    const handleTestSend = async (directPhone?: string) => {
        const phone = directPhone || resolvedRecipients[0]?.phone || quickTestPhone
        if (!phone) return

        setTestSending(true)
        setTestResult(null)
        try {
            const channel = localSetting.channels_enabled[0] || 'whatsapp'
            const currentTemplate = localSetting.templates?.[channel] || ''

            // Build rich sample data for template rendering
            const sampleData: any = {
                // Order variables
                order_no: sampleId || 'ORD26000049',
                order_date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                status: 'Approved',
                amount: '1,400.00',
                customer_name: 'Serapod Technology Sdn Bhd',
                customer_phone: '+60147519216',
                delivery_address: 'No4, Tingkat1, Lorong Perniagaan Alma Jaya 11, Taman Alma Jaya',
                approved_by: 'Admin',
                approved_at: new Date().toLocaleDateString('en-GB'),
                closed_at: new Date().toLocaleDateString('en-GB'),
                action: 'Cancelled',
                reason: 'N/A',
                order_url: typeof window !== 'undefined' ? `${window.location.origin}/supply-chain` : 'https://app.serapod2u.com/supply-chain',
                item_list: '• Cellera Hero – Deluxe Cellera Cartridge [Keladi Cheese] × 100 units (1 case) — RM 1,400.00',
                total_cases: '1',
                total_items: '1',
                buyer_org: 'Serapod Technology Sdn Bhd',
                seller_org: 'Shenzen VapeHome Technologies',
                // Order Deleted variables
                deleted_by: 'Super Admin',
                deleted_at: new Date().toLocaleString('en-GB'),
                // Manufacturer Scan Complete variables
                batch_id: 'BATCH-2024-00012',
                total_master_codes: '50',
                total_unique_codes: '5,000',
                production_completed_at: new Date().toLocaleString('en-GB'),
                completed_by: 'Manufacturing Operator',
                balance_document_no: 'PR26000012',
                // QR Batch Generated variables
                generated_at: new Date().toLocaleString('en-GB'),
                // Warehouse Received variables
                total_received: '5,000',
                warehouse_name: 'Main Warehouse KL',
                received_at: new Date().toLocaleString('en-GB'),
                // Document Workflow variables
                doc_no: 'PO26000015',
                doc_date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                doc_type: 'Purchase Order',
                doc_status: 'Pending Acknowledgement',
                buyer_name: 'Serapod Technology Sdn Bhd',
                seller_name: 'Shenzen VapeHome Technologies',
                deposit_amount: '420.00',
                balance_amount: '980.00',
                invoice_no: 'INV26000015',
                payment_no: 'PAY26000015',
                receipt_no: 'REC26000015',
                acknowledged_by: 'Factory Manager',
                acknowledged_at: new Date().toLocaleString('en-GB'),
                document_url: typeof window !== 'undefined' ? `${window.location.origin}/supply-chain` : 'https://app.serapod2u.com/supply-chain',
                // Inventory variables
                product_name: 'Cellera Hero',
                variant_name: 'Deluxe Cartridge [Keladi Cheese]',
                sku: 'CLR-DLX-KC-001',
                available_qty: '15',
                reorder_point: '20',
                reorder_qty: '100',
                quantity_received: '500',
                total_on_hand: '515',
                inventory_url: typeof window !== 'undefined' ? `${window.location.origin}/inventory` : 'https://app.serapod.com/inventory',
                // QR / Consumer variables
                qr_code: 'QR-ABC-12345',
                scan_location: 'Kuala Lumpur, MY',
                scanned_at: new Date().toLocaleString('en-GB'),
                consumer_name: 'Ahmad bin Ali',
                consumer_phone: '+60123456789',
                points_earned: '50',
                total_points: '350',
                entry_number: 'LD-2024-00042',
                entry_status: 'Confirmed',
                reward_name: 'Free Starter Kit',
                points_used: '200',
                remaining_points: '150',
                // User variables
                user_name: 'Jane Smith',
                user_email: 'jane@example.com',
                user_role: 'Admin',
                created_at: new Date().toLocaleDateString('en-GB'),
                activated_at: new Date().toLocaleDateString('en-GB'),
                deactivated_at: new Date().toLocaleDateString('en-GB'),
                changed_at: new Date().toLocaleString('en-GB'),
                requested_at: new Date().toLocaleString('en-GB'),
                ip_address: '203.0.113.42',
                login_location: 'Unknown Location',
                login_time: new Date().toLocaleString('en-GB'),
                // Generic
                event_name: type.event_name || 'Order Submitted',
                reference_id: sampleId || 'ORD26000049',
            }

            const target = resolvedRecipients[0] || {
                phone,
                full_name: 'Test Recipient',
                email: ''
            }
            // Override phone with the direct one if provided
            if (directPhone) target.phone = directPhone

            const res = await fetch('/api/notifications/test-send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    eventCode: type.event_code,
                    channel,
                    recipient: target,
                    template: currentTemplate,
                    sampleData
                })
            })
            const data = await res.json()
            setTestResult(data)
            if (data.success) fetchLogs()
        } catch (error) {
            console.error(error)
            setTestResult({ success: false, error: 'Failed to send' })
        } finally {
            setTestSending(false)
        }
    }

    const handleSave = async () => {
        // Block save when manual whatsapp numbers section has invalid entries
        if (manualParse.invalid.length > 0) {
            setSaveError(`There are ${manualParse.invalid.length} invalid WhatsApp number(s). Fix or remove them before saving.`)
            setActiveTab('recipients')
            setActiveSource('manual_whatsapp')
            return
        }
        if (manualEmailParse.invalid.length > 0) {
            setSaveError(`There are ${manualEmailParse.invalid.length} invalid email address(es). Fix or remove them before saving.`)
            setActiveTab('recipients')
            setActiveSource('manual_email')
            return
        }
        setSaveError(null)
        // Persist normalized & deduped manual numbers
        const cleanManual = normalizeAndDedupeManualPhones(manualParse.valid.map((v) => v.normalized))
        const cleanEmails = normalizeAndDedupeManualEmails(manualEmailParse.valid.map((value) => value.normalized))
        const verificationOnly = type.event_code === 'stock_count_posting_verification'
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
            await onSave(finalSetting)
            onOpenChange(false)
        } catch (error: any) {
            setSaveError(error?.message || 'Failed to save notification changes.')
        } finally {
            setSavingChanges(false)
        }
    }

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-[95vw] sm:max-w-4xl overflow-y-auto sm:p-0">
                <div className="flex flex-col h-full">
                    {/* Header */}
                    <div className="p-6 border-b bg-gray-50/50">
                        <SheetHeader>
                            <SheetTitle className="text-xl flex items-center gap-2">
                                {type.event_name}
                            </SheetTitle>
                            <SheetDescription>
                                {type.event_description}
                            </SheetDescription>
                        </SheetHeader>

                        <div className="flex items-center gap-2 mt-4">
                            {localSetting.enabled ? (
                                <Badge className="bg-green-600">Active</Badge>
                            ) : (
                                <Badge variant="secondary">Disabled</Badge>
                            )}
                            <span className="text-xs text-gray-500 mx-2">|</span>
                            <div className="flex gap-1">
                                {type.available_channels.map((c: string) => (
                                    <Badge key={c} variant={localSetting.channels_enabled.includes(c) ? 'default' : 'outline'} className="capitalize">
                                        {c}
                                    </Badge>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Tabs */}
                    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
                        <div className="px-6 pt-4 border-b">
                            <TabsList className="w-full justify-start h-auto p-0 bg-transparent gap-6">
                                <TabsTrigger value="flow" className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600 px-4 py-2 gap-2">
                                    <GitBranch className="w-4 h-4" /> Flow
                                </TabsTrigger>
                                <TabsTrigger value="recipients" className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600 px-4 py-2 gap-2">
                                    <Users className="w-4 h-4" /> Recipients
                                </TabsTrigger>
                                <TabsTrigger value="templates" className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600 px-4 py-2 gap-2">
                                    <MessageSquare className="w-4 h-4" /> Templates
                                </TabsTrigger>
                                <TabsTrigger value="test" className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600 px-4 py-2 gap-2">
                                    <TestTube className="w-4 h-4" /> Test & Logs
                                </TabsTrigger>
                            </TabsList>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6">
                            {/* Flow Visualization */}
                            <TabsContent value="flow" className="mt-0 space-y-8">
                                <div className="relative">
                                    <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-gray-200" />

                                    <div className="relative flex gap-4 items-start mb-8">
                                        <div className="w-8 h-8 rounded-full bg-blue-100 border-2 border-blue-500 flex items-center justify-center shrink-0 z-10">
                                            <Play className="w-4 h-4 text-[var(--sera-orange)]" />
                                        </div>
                                        <div>
                                            <h4 className="font-semibold text-[var(--sera-ink)]">Trigger Event</h4>
                                            <p className="text-sm text-gray-500">{type.event_name} occurs in system</p>
                                        </div>
                                    </div>

                                    <div className="relative flex gap-4 items-start mb-8">
                                        <div className="w-8 h-8 rounded-full bg-purple-100 border-2 border-purple-500 flex items-center justify-center shrink-0 z-10">
                                            <Users className="w-4 h-4 text-purple-600" />
                                        </div>
                                        <div>
                                            <h4 className="font-semibold text-[var(--sera-ink)]">Resolve Recipients</h4>
                                            <div className="text-sm text-gray-500 flex flex-col gap-1">
                                                {localSetting.recipient_config?.recipient_targets?.order_creator && <span>• Order creator</span>}
                                                {localSetting.recipient_config?.recipient_targets?.consumer && <span>• Consumer</span>}
                                                {localSetting.recipient_config?.recipient_targets?.roles && <span>• Roles: {(localSetting.recipient_config?.roles || []).join(', ')}</span>}
                                                {localSetting.recipient_config?.recipient_targets?.dynamic_org && <span>• Dynamic: {localSetting.recipient_config?.dynamic_target}</span>}
                                                {localSetting.recipient_config?.recipient_targets?.users && <span>• Specific Users ({localSetting.recipient_config?.recipient_users?.length || 0})</span>}

                                                {(!localSetting.recipient_config?.recipient_targets?.order_creator &&
                                                    !localSetting.recipient_config?.recipient_targets?.roles &&
                                                    !localSetting.recipient_config?.recipient_targets?.dynamic_org &&
                                                    !localSetting.recipient_config?.recipient_targets?.users &&
                                                    !localSetting.recipient_config?.recipient_targets?.consumer) && (
                                                        <span>-</span>
                                                    )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="relative flex gap-4 items-start mb-8">
                                        <div className="w-8 h-8 rounded-full bg-orange-100 border-2 border-orange-500 flex items-center justify-center shrink-0 z-10">
                                            <GitBranch className="w-4 h-4 text-orange-600" />
                                        </div>
                                        <div>
                                            <h4 className="font-semibold text-[var(--sera-ink)]">Routing & Templates</h4>
                                            <div className="flex gap-2 mt-1">
                                                {localSetting.channels_enabled.map((c: string) => (
                                                    <Badge key={c} variant="outline" className="text-xs bg-white">
                                                        {c} ({localSetting.templates?.[c] ? 'Template set' : 'No template'})
                                                    </Badge>
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="relative flex gap-4 items-start">
                                        <div className="w-8 h-8 rounded-full bg-green-100 border-2 border-green-500 flex items-center justify-center shrink-0 z-10">
                                            <CheckCircle2 className="w-4 h-4 text-green-600" />
                                        </div>
                                        <div>
                                            <h4 className="font-semibold text-[var(--sera-ink)]">Delivery</h4>
                                            <p className="text-sm text-gray-500">Sent via configured providers (Baileys/Twilio/etc)</p>
                                        </div>
                                    </div>
                                </div>
                            </TabsContent>

                            {/* Recipients Configuration — Redesigned (two-column with Manual WhatsApp source) */}
                            <TabsContent value="recipients" className="mt-0 space-y-6">

                                {(() => null)()}

                                {/* Header banner: source count + clear all */}
                                <div className="bg-[var(--sera-orange)]/[0.06]/50 p-4 rounded-lg border border-blue-100 flex justify-between items-start">
                                    <div>
                                        <h4 className="text-xs font-semibold uppercase tracking-wide text-blue-900">Recipients Summary</h4>
                                        <p className="text-xs text-[var(--sera-orange-deep)]/80 mt-0.5">
                                            {(() => {
                                                const t = localSetting.recipient_config?.recipient_targets || {}
                                                const enabledSources = [t.order_creator && 'Order creator', t.consumer && 'Consumer', t.dynamic_org && 'Related Organization', t.users && 'Specific Users', (manualParse.valid.length > 0) && 'Manual WhatsApp', (manualEmailParse.valid.length > 0) && 'Manual Email'].filter(Boolean) as string[]
                                                if (enabledSources.length === 0) return 'No recipients selected'
                                                return enabledSources.join(' • ')
                                            })()}
                                        </p>
                                    </div>
                                    {(localSetting.recipient_config?.recipient_targets?.order_creator ||
                                        localSetting.recipient_config?.recipient_targets?.consumer ||
                                        localSetting.recipient_config?.recipient_targets?.roles ||
                                        localSetting.recipient_config?.recipient_targets?.dynamic_org ||
                                        localSetting.recipient_config?.recipient_targets?.users ||
                                        manualParse.valid.length > 0 || manualEmailParse.valid.length > 0) && (
                                            <Button variant="ghost" size="sm" className="h-6 text-xs text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)]" onClick={() => {
                                                updateRecipientConfig({
                                                    recipient_targets: { roles: false, dynamic_org: false, users: false, consumer: false, order_creator: false },
                                                    include_consumer: false,
                                                    manual_whatsapp_numbers: [],
                                                    manual_email_addresses: [],
                                                })
                                                setManualRawInput('')
                                                setManualEmailRawInput('')
                                            }}>
                                                Clear All
                                            </Button>
                                        )}
                                </div>

                                {saveError && (
                                    <div className="bg-red-50 text-red-800 text-xs p-3 rounded border border-red-200 flex items-center gap-2">
                                        <AlertCircle className="w-3 h-3" />
                                        <span>{saveError}</span>
                                    </div>
                                )}

                                {/* Two-column layout */}
                                <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
                                    {/* LEFT: Recipient source cards */}
                                    <div className="space-y-3">
                                        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Recipient Sources</div>
                                        <div className="text-[11px] text-gray-400 -mt-2">Choose one or more sources</div>

                                        {([
                                            {
                                                key: 'order_creator',
                                                icon: <UserCheck className="w-4 h-4 text-sky-600" />,
                                                title: 'Order creator',
                                                subtitle: 'Send to the user who created the order',
                                                enabled: !!localSetting.recipient_config?.recipient_targets?.order_creator,
                                                onToggle: (c: boolean) => updateRecipientConfig({
                                                    recipient_targets: { ...localSetting.recipient_config.recipient_targets, order_creator: c },
                                                }),
                                            },
                                            {
                                                key: 'consumer',
                                                icon: <UserIcon className="w-4 h-4 text-[var(--sera-orange)]" />,
                                                title: 'Consumer',
                                                subtitle: 'Send to relevant Consumer',
                                                enabled: !!localSetting.recipient_config?.recipient_targets?.consumer,
                                                onToggle: (c: boolean) => updateRecipientConfig({
                                                    recipient_targets: { ...localSetting.recipient_config.recipient_targets, consumer: c },
                                                    include_consumer: c,
                                                }),
                                            },
                                            {
                                                key: 'dynamic_org',
                                                icon: <Building2 className="w-4 h-4 text-purple-600" />,
                                                title: 'Related Organization',
                                                subtitle: 'Dynamic (Related Organization)',
                                                enabled: !!localSetting.recipient_config?.recipient_targets?.dynamic_org,
                                                onToggle: (c: boolean) => updateRecipientConfig({
                                                    recipient_targets: { ...localSetting.recipient_config.recipient_targets, dynamic_org: c },
                                                }),
                                            },
                                            {
                                                key: 'users',
                                                icon: <Users className="w-4 h-4 text-emerald-600" />,
                                                title: 'Specific Users',
                                                subtitle: 'Send to specific internal users',
                                                enabled: !!localSetting.recipient_config?.recipient_targets?.users,
                                                onToggle: (c: boolean) => updateRecipientConfig({
                                                    recipient_targets: { ...localSetting.recipient_config.recipient_targets, users: c },
                                                }),
                                            },
                                            {
                                                key: 'manual_whatsapp',
                                                icon: <MessageCircle className="w-4 h-4 text-green-600" />,
                                                title: 'Manual WhatsApp Numbers',
                                                subtitle: 'Add external WhatsApp numbers manually',
                                                enabled: manualParse.valid.length > 0 || manualRawInput.trim().length > 0,
                                                onToggle: (c: boolean) => {
                                                    if (!c) {
                                                        setManualRawInput('')
                                                        updateRecipientConfig({ manual_whatsapp_numbers: [] })
                                                    } else {
                                                        setActiveSource('manual_whatsapp')
                                                    }
                                                },
                                            },
                                            {
                                                key: 'manual_email',
                                                icon: <Mail className="w-4 h-4 text-violet-600" />,
                                                title: 'Manual Email Addresses',
                                                subtitle: 'Add authorized email recipients manually',
                                                enabled: manualEmailParse.valid.length > 0 || manualEmailRawInput.trim().length > 0,
                                                onToggle: (c: boolean) => {
                                                    if (!c) {
                                                        setManualEmailRawInput('')
                                                        updateRecipientConfig({ manual_email_addresses: [] })
                                                    } else setActiveSource('manual_email')
                                                },
                                            },
                                        ] as const).filter((src) => {
                                            if (type.event_code === 'stock_count_posting_verification') return src.key === 'users' || src.key === 'manual_email'
                                            if (src.key === 'order_creator') return String(type.category || '') === 'order' || String(type.event_code || '').startsWith('order_')
                                            if (src.key === 'manual_email') return type.available_channels?.includes('email')
                                            return true
                                        }).map((src) => {
                                            const isActive = activeSource === src.key
                                            return (
                                                <button
                                                    key={src.key}
                                                    type="button"
                                                    onClick={() => setActiveSource(src.key as any)}
                                                    className={`w-full text-left rounded-lg border p-3 transition-all ${isActive ? 'border-blue-500 bg-[var(--sera-orange)]/[0.06]/40 shadow-sm' : 'border-gray-200 hover:border-gray-300 bg-white'}`}
                                                >
                                                    <div className="flex items-start gap-3">
                                                        <div className="w-8 h-8 rounded-md bg-gray-50 flex items-center justify-center shrink-0">
                                                            {src.icon}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <span className="text-sm font-medium text-[var(--sera-ink)]">{src.title}</span>
                                                                {src.key === 'users' ? (
                                                                    <span
                                                                        role="button"
                                                                        tabIndex={0}
                                                                        onClick={(e) => { e.stopPropagation(); src.onToggle(!src.enabled); setActiveSource('users') }}
                                                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); src.onToggle(!src.enabled); setActiveSource('users') } }}
                                                                        className={`text-[11px] px-2 py-0.5 rounded border ${src.enabled ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-white border-[var(--sera-orange)]/30 text-[var(--sera-orange)] hover:bg-[var(--sera-orange)]/[0.06]'}`}
                                                                    >
                                                                        {src.enabled ? 'Selected' : 'Select'}
                                                                    </span>
                                                                ) : (
                                                                    <Checkbox
                                                                        checked={src.enabled}
                                                                        onClick={(e: any) => e.stopPropagation()}
                                                                        onCheckedChange={(c) => src.onToggle(!!c)}
                                                                    />
                                                                )}
                                                            </div>
                                                            <p className="text-xs text-gray-500 mt-0.5 truncate">{src.subtitle}</p>
                                                            {src.enabled && (
                                                                <CheckCircle2 className="w-3 h-3 text-emerald-500 mt-1 inline-block" />
                                                            )}
                                                        </div>
                                                    </div>
                                                </button>
                                            )
                                        })}

                                        <div className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded-md p-2 mt-2 flex items-start gap-1.5">
                                            <Info className="w-3 h-3 mt-0.5 shrink-0" />
                                            <span>All selected sources will be combined. Duplicates will be removed before sending.</span>
                                        </div>
                                    </div>

                                    {/* RIGHT: Active source configuration */}
                                    <div className="rounded-lg border border-gray-200 bg-white p-4 min-h-[380px]">
                                        {activeSource === 'order_creator' && (
                                            <div className="space-y-4">
                                                <div className="flex items-center gap-2">
                                                    <UserCheck className="w-4 h-4 text-sky-600" />
                                                    <h4 className="text-sm font-semibold text-[var(--sera-ink)]">Order creator</h4>
                                                </div>
                                                <p className="text-xs text-gray-500">
                                                    Send the notification to the user who created the order: their phone for WhatsApp/SMS and their email for Email.
                                                </p>
                                                <label className="flex items-center gap-2 cursor-pointer bg-gray-50 p-3 rounded border border-transparent hover:border-gray-200 transition-colors">
                                                    <Checkbox
                                                        checked={!!localSetting.recipient_config?.recipient_targets?.order_creator}
                                                        onCheckedChange={(c) => updateRecipientConfig({
                                                            recipient_targets: {
                                                                ...localSetting.recipient_config.recipient_targets,
                                                                order_creator: c,
                                                            },
                                                        })}
                                                    />
                                                    <span className="text-sm font-medium">Send to the order creator only from this source</span>
                                                </label>
                                                <div className="text-[11px] text-sky-800 bg-sky-50 border border-sky-100 rounded-md p-2 flex items-start gap-1.5">
                                                    <Info className="w-3 h-3 mt-0.5 shrink-0" />
                                                    <span>Delivery uses this screen: Order creator, roles, and other sources are combined and duplicates are removed. For Order Rejected the default is Order creator only.</span>
                                                </div>
                                            </div>
                                        )}

                                        {activeSource === 'consumer' && (
                                            <div className="space-y-4">
                                                <div className="flex items-center gap-2">
                                                    <UserIcon className="w-4 h-4 text-[var(--sera-orange)]" />
                                                    <h4 className="text-sm font-semibold text-[var(--sera-ink)]">Consumer</h4>
                                                </div>
                                                <p className="text-xs text-gray-500">Send the notification to the consumer related to the triggering event (e.g. the consumer that placed the order or scanned a QR).</p>
                                                <label className="flex items-center gap-2 cursor-pointer bg-gray-50 p-3 rounded border border-transparent hover:border-gray-200 transition-colors">
                                                    <Checkbox
                                                        checked={!!localSetting.recipient_config?.recipient_targets?.consumer}
                                                        onCheckedChange={(c) => updateRecipientConfig({
                                                            recipient_targets: {
                                                                ...localSetting.recipient_config.recipient_targets,
                                                                consumer: c
                                                            },
                                                            include_consumer: c
                                                        })}
                                                    />
                                                    <span className="text-sm font-medium">Send to relevant Consumer</span>
                                                </label>
                                            </div>
                                        )}

                                        {activeSource === 'dynamic_org' && (
                                            <div className="space-y-4">
                                                <div className="flex items-center gap-2">
                                                    <Building2 className="w-4 h-4 text-purple-600" />
                                                    <h4 className="text-sm font-semibold text-[var(--sera-ink)]">Related Organization</h4>
                                                </div>
                                                <p className="text-xs text-gray-500">Resolve recipients dynamically based on the organization associated with the triggering event (manufacturer, distributor, warehouse).</p>
                                                <label className="flex items-center gap-2 cursor-pointer bg-gray-50 p-3 rounded border border-transparent hover:border-gray-200 transition-colors">
                                                    <Checkbox
                                                        checked={!!localSetting.recipient_config?.recipient_targets?.dynamic_org}
                                                        onCheckedChange={(c) => updateRecipientConfig({
                                                            recipient_targets: { ...localSetting.recipient_config.recipient_targets, dynamic_org: c }
                                                        })}
                                                    />
                                                    <span className="text-sm font-medium">Enable Related Organization recipients</span>
                                                </label>
                                                {localSetting.recipient_config?.recipient_targets?.dynamic_org && (
                                                    <div className="space-y-2">
                                                        <Label className="text-xs">Target organization role</Label>
                                                        <Select
                                                            value={localSetting.recipient_config?.dynamic_target || ''}
                                                            onValueChange={(val) => updateRecipientConfig({ dynamic_target: val })}
                                                        >
                                                            <SelectTrigger>
                                                                <SelectValue placeholder="Select target..." />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value="manufacturer">Manufacturer (Product Owner)</SelectItem>
                                                                <SelectItem value="distributor">Distributor (Seller)</SelectItem>
                                                                <SelectItem value="warehouse">Warehouse</SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    </div>
                                                )}

                                                {/* Optional: roles control kept available here */}
                                                <div className="pt-3 border-t space-y-2">
                                                    <label className="flex items-center gap-2 font-medium text-xs cursor-pointer text-gray-700">
                                                        <Checkbox
                                                            checked={!!localSetting.recipient_config?.recipient_targets?.roles}
                                                            onCheckedChange={(c) => updateRecipientConfig({
                                                                recipient_targets: { ...localSetting.recipient_config.recipient_targets, roles: c }
                                                            })}
                                                        />
                                                        Also send to specific roles (within related org)
                                                    </label>
                                                    {localSetting.recipient_config?.recipient_targets?.roles && (
                                                        <div className="ml-6 grid grid-cols-2 gap-2 p-3 bg-gray-50 rounded text-sm">
                                                            {([
                                                                { code: 'SUPER', label: 'Super Admin' },
                                                                { code: 'HQ_ADMIN', label: 'Admin' },
                                                                { code: 'DIST_ADMIN', label: 'Distributor' },
                                                                { code: 'WH_MANAGER', label: 'Warehouse Mgr' },
                                                                { code: 'USER', label: 'User (Staff)' },
                                                            ] as { code: string, label: string }[]).map(({ code, label }) => (
                                                                <label key={code} className="flex items-center gap-2 cursor-pointer">
                                                                    <Checkbox
                                                                        checked={!!localSetting.recipient_config?.roles?.includes(code)}
                                                                        onCheckedChange={(c) => {
                                                                            const currentRoles = localSetting.recipient_config?.roles || []
                                                                            const newRoles = c
                                                                                ? [...currentRoles, code]
                                                                                : currentRoles.filter((r: string) => r !== code)
                                                                            updateRecipientConfig({ roles: newRoles })
                                                                        }}
                                                                    />
                                                                    <span>{label}</span>
                                                                </label>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {activeSource === 'users' && (
                                            <div className="space-y-4">
                                                <div className="flex items-center gap-2">
                                                    <Users className="w-4 h-4 text-emerald-600" />
                                                    <h4 className="text-sm font-semibold text-[var(--sera-ink)]">Specific Users</h4>
                                                </div>
                                                <p className="text-xs text-gray-500">Send to a curated list of internal users.</p>
                                                <label className="flex items-center gap-2 cursor-pointer bg-gray-50 p-3 rounded border border-transparent hover:border-gray-200 transition-colors">
                                                    <Checkbox
                                                        checked={!!localSetting.recipient_config?.recipient_targets?.users}
                                                        onCheckedChange={(c) => updateRecipientConfig({
                                                            recipient_targets: { ...localSetting.recipient_config.recipient_targets, users: c }
                                                        })}
                                                    />
                                                    <span className="text-sm font-medium">Enable Specific Users</span>
                                                </label>
                                                {localSetting.recipient_config?.recipient_targets?.users && (
                                                    <div className="space-y-2">
                                                        <Label className="text-xs text-gray-500">Search and select users to receive this notification</Label>
                                                        <UserMultiSelect
                                                            selectedUserIds={localSetting.recipient_config?.recipient_users || []}
                                                            onSelectionChange={(ids) => updateRecipientConfig({ recipient_users: ids })}
                                                            onUsersLoaded={(users) => setSelectedUserDetails(users)}
                                                        />
                                                        {selectedUserDetails.length > 0 && (
                                                            <div className="mt-2 space-y-1 max-h-48 overflow-y-auto border rounded p-2 bg-gray-50/40">
                                                                {selectedUserDetails.map(u => (
                                                                    <div key={u.id} className="text-xs flex items-center justify-between">
                                                                        <span className="font-medium">{u.full_name}</span>
                                                                        {u.phone ? (
                                                                            <span className="text-gray-500">{u.phone}</span>
                                                                        ) : (
                                                                            <span className="text-amber-600 italic">no phone</span>
                                                                        )}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {activeSource === 'manual_whatsapp' && (
                                            <div className="space-y-4">
                                                <div className="flex items-center gap-2">
                                                    <MessageCircle className="w-4 h-4 text-green-600" />
                                                    <h4 className="text-sm font-semibold text-[var(--sera-ink)]">Manual WhatsApp Numbers</h4>
                                                </div>
                                                <p className="text-xs text-gray-500">
                                                    Enter WhatsApp numbers in international format.<br />
                                                    Example: <code className="bg-gray-100 px-1 rounded">60123456789, 8613812345678</code>
                                                </p>

                                                <div className="space-y-2">
                                                    <Textarea
                                                        placeholder="Type or paste numbers here (comma, space or new line separated)"
                                                        className="min-h-[100px] font-mono text-xs"
                                                        value={manualRawInput}
                                                        onChange={(e) => setManualRawInput(e.target.value)}
                                                    />
                                                    <div className="flex justify-between items-center text-[11px] text-gray-500">
                                                        <span>Malaysia 0XX → auto-prefixed with 60. Plus signs are stripped.</span>
                                                        <span>{manualParse.totalEntered}/500</span>
                                                    </div>
                                                </div>

                                                <div className="flex gap-2">
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => {
                                                            // Re-normalize: replace input with canonical valid + raw invalid lines
                                                            const validLines = manualParse.valid.map((v) => v.normalized)
                                                            const invalidLines = manualParse.invalid.map((i) => i.original)
                                                            setManualRawInput([...validLines, ...invalidLines].join('\n'))
                                                        }}
                                                    >
                                                        <RefreshCw className="w-3 h-3 mr-1" />
                                                        Normalize & Validate
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => setManualRawInput('')}
                                                    >
                                                        <Trash2 className="w-3 h-3 mr-1" />
                                                        Clear All
                                                    </Button>
                                                </div>

                                                {/* Valid numbers */}
                                                {manualParse.valid.length > 0 && (
                                                    <div className="border border-emerald-200 rounded-md overflow-hidden">
                                                        <div className="bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 flex items-center justify-between">
                                                            <span className="flex items-center gap-1.5"><CheckCircle2 className="w-3 h-3" /> Valid Numbers ({manualParse.valid.length})</span>
                                                        </div>
                                                        <div className="divide-y max-h-[180px] overflow-y-auto">
                                                            {manualParse.valid.map((v, i) => (
                                                                <div key={i} className="px-3 py-1.5 text-xs flex items-center justify-between hover:bg-gray-50">
                                                                    <div className="flex items-center gap-2">
                                                                        <span className="font-mono">{v.normalized}</span>
                                                                        <Badge variant="outline" className="text-[10px]">{v.country}</Badge>
                                                                    </div>
                                                                    <button
                                                                        type="button"
                                                                        title="Copy"
                                                                        onClick={() => { try { navigator.clipboard?.writeText(v.normalized) } catch { } }}
                                                                        className="text-gray-400 hover:text-gray-700"
                                                                    >
                                                                        <Copy className="w-3 h-3" />
                                                                    </button>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Invalid numbers */}
                                                {manualParse.invalid.length > 0 && (
                                                    <div className="border border-red-200 rounded-md overflow-hidden">
                                                        <div className="bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 flex items-center justify-between">
                                                            <span className="flex items-center gap-1.5"><AlertCircle className="w-3 h-3" /> Invalid Numbers ({manualParse.invalid.length})</span>
                                                        </div>
                                                        <div className="divide-y max-h-[140px] overflow-y-auto">
                                                            {manualParse.invalid.map((iv, i) => (
                                                                <div key={i} className="px-3 py-1.5 text-xs flex items-center justify-between hover:bg-gray-50">
                                                                    <div className="flex items-center gap-2">
                                                                        <span className="font-mono">{iv.original}</span>
                                                                        <span className="text-red-600">{iv.reason}</span>
                                                                    </div>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => {
                                                                            // Remove this exact original from the textarea
                                                                            const tokens = manualRawInput.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)
                                                                            const idx = tokens.findIndex((t) => t === iv.original)
                                                                            if (idx >= 0) tokens.splice(idx, 1)
                                                                            setManualRawInput(tokens.join('\n'))
                                                                        }}
                                                                        className="text-red-500 hover:text-red-700 text-[11px] underline"
                                                                    >
                                                                        Remove
                                                                    </button>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Summary */}
                                                {(manualParse.totalEntered > 0) && (
                                                    <div className="bg-gray-50 border border-gray-200 rounded-md p-3 flex items-center justify-between text-xs">
                                                        <div className="space-y-0.5">
                                                            <div className="font-semibold">{manualParse.valid.length} Valid manual numbers</div>
                                                            <div className="text-gray-500">
                                                                {manualParse.invalid.length} invalid · {manualParse.duplicatesRemoved} duplicate removed
                                                            </div>
                                                        </div>
                                                        <div className="text-right text-gray-500">
                                                            These numbers will be included<br />in the final recipient list.
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {activeSource === 'manual_email' && (
                                            <div className="space-y-4">
                                                <div className="flex items-center gap-2"><Mail className="w-4 h-4 text-violet-600" /><h4 className="text-sm font-semibold text-[var(--sera-ink)]">Manual Email Addresses</h4></div>
                                                <p className="text-xs text-gray-500">Enter email addresses separated by commas, semicolons, spaces, or new lines. Addresses are normalized and deduplicated case-insensitively.</p>
                                                <Textarea placeholder="approver@example.com\nmanager@example.com" className="min-h-[110px] font-mono text-xs" value={manualEmailRawInput} onChange={(event) => setManualEmailRawInput(event.target.value)} />
                                                <div className="flex justify-between text-[11px] text-gray-500"><span>{manualEmailParse.valid.length} valid · {manualEmailParse.invalid.length} invalid · {manualEmailParse.duplicatesRemoved} duplicate removed</span><Button type="button" variant="ghost" size="sm" onClick={() => setManualEmailRawInput('')}><Trash2 className="mr-1 h-3 w-3" />Clear All</Button></div>
                                                {manualEmailParse.valid.length > 0 && <div className="overflow-hidden rounded-md border border-emerald-200"><div className="bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">Valid Emails ({manualEmailParse.valid.length})</div><div className="max-h-36 divide-y overflow-y-auto">{manualEmailParse.valid.map((entry) => <div key={entry.normalized} className="px-3 py-2 font-mono text-xs">{entry.normalized}</div>)}</div></div>}
                                                {manualEmailParse.invalid.length > 0 && <div className="overflow-hidden rounded-md border border-red-200"><div className="bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">Invalid Entries ({manualEmailParse.invalid.length})</div><div className="max-h-32 divide-y overflow-y-auto">{manualEmailParse.invalid.map((entry, index) => <div key={`${entry.original}-${index}`} className="flex justify-between px-3 py-2 text-xs"><span className="font-mono text-red-700">{entry.original}</span><span className="text-red-500">{entry.reason}</span></div>)}</div></div>}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Final Recipient Preview */}
                                {(() => {
                                    const t = localSetting.recipient_config?.recipient_targets || {}
                                    const usersCount = t.users ? (localSetting.recipient_config?.recipient_users?.length || 0) : 0
                                    const manualCount = manualParse.valid.length
                                    const manualEmailCount = manualEmailParse.valid.length
                                    const creatorsCount = t.order_creator ? 1 : 0
                                    const consumersCount = t.consumer ? 1 : 0 // estimated (resolved at runtime)
                                    const orgsCount = t.dynamic_org ? 1 : 0 // estimated
                                    const totalUnique = creatorsCount + usersCount + manualCount + manualEmailCount + consumersCount + orgsCount
                                    return (
                                        <div className="border-t pt-4">
                                            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Final Recipient Preview</div>
                                            <p className="text-[11px] text-gray-400 mb-3">Estimated unique recipients (real counts resolved per-event at send time)</p>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                                {[
                                                    { label: 'Order creator', value: creatorsCount, icon: <UserCheck className="w-3 h-3" />, accent: 'text-sky-600' },
                                                    { label: 'Consumers', value: consumersCount, icon: <UserIcon className="w-3 h-3" />, accent: 'text-[var(--sera-orange)]' },
                                                    { label: 'Organizations', value: orgsCount, icon: <Building2 className="w-3 h-3" />, accent: 'text-purple-600' },
                                                    { label: 'Users', value: usersCount, icon: <Users className="w-3 h-3" />, accent: 'text-emerald-600' },
                                                    { label: 'Manual WhatsApp', value: manualCount, icon: <MessageCircle className="w-3 h-3" />, accent: 'text-green-600' },
                                                    { label: 'Manual Email', value: manualEmailCount, icon: <Mail className="w-3 h-3" />, accent: 'text-violet-600' },
                                                    { label: 'Total Unique Recipients', value: totalUnique, icon: <CheckCircle2 className="w-3 h-3" />, accent: 'text-indigo-700', highlight: true },
                                                ].map((c) => (
                                                    <div key={c.label} className={`rounded-md border p-2.5 ${c.highlight ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-gray-200'}`}>
                                                        <div className={`flex items-center gap-1 text-[10px] uppercase tracking-wide ${c.accent}`}>
                                                            {c.icon}<span>{c.label}</span>
                                                        </div>
                                                        <div className="text-lg font-bold text-[var(--sera-ink)] mt-1">{c.value}</div>
                                                    </div>
                                                ))}
                                            </div>
                                            {localSetting.channels_enabled?.includes('whatsapp') && (
                                                <p className="text-xs text-gray-500 mt-3">
                                                    {totalUnique} recipient{totalUnique === 1 ? '' : 's'} will receive this WhatsApp notification.
                                                </p>
                                            )}
                                        </div>
                                    )
                                })()}

                                {/* Preview Resolution (kept) */}
                                <div className="space-y-3 pt-2 border-t">
                                    <h4 className="font-semibold text-sm">Preview Resolution</h4>
                                    <div className="flex gap-2">
                                        <Input
                                            placeholder="Enter Sample ID (e.g. Order No)"
                                            value={sampleId}
                                            onChange={(e) => setSampleId(e.target.value)}
                                        />
                                        <Button
                                            variant="outline"
                                            onClick={handleResolve}
                                            disabled={resolving || !sampleId}
                                        >
                                            {resolving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Resolve'}
                                        </Button>
                                    </div>

                                    {resolvedRecipients.length > 0 && (
                                        <div className="space-y-3">
                                            <div className="flex gap-4 text-xs font-medium text-[var(--sera-muted)] bg-gray-100/50 p-2 rounded">
                                                <span>Total: {resolvedRecipients.length}</span>
                                                <span>Consumer: {resolvedRecipients.filter(r => r.type === 'Consumer').length}</span>
                                                <span>Staff: {resolvedRecipients.filter(r => r.type !== 'Consumer').length}</span>
                                            </div>
                                            {resolvedRecipients.some(r => !r.phone && localSetting.channels_enabled.includes('whatsapp')) && (
                                                <div className="bg-amber-50 text-amber-800 text-xs p-2 rounded border border-amber-200 flex items-center gap-2">
                                                    <AlertCircle className="w-3 h-3" />
                                                    <span>{resolvedRecipients.filter(r => !r.phone).length} recipients missing phone (WhatsApp/SMS unavailable)</span>
                                                </div>
                                            )}
                                            <div className="border rounded-md divide-y max-h-[200px] overflow-y-auto">
                                                {resolvedRecipients.map((r, i) => (
                                                    <div key={i} className="p-2 text-sm flex justify-between items-center bg-gray-50 hover:bg-gray-100">
                                                        <div>
                                                            <div className="font-medium flex items-center gap-2">
                                                                {r.full_name}
                                                                <span className="flex gap-1 ml-1 opacity-70">
                                                                    {r.phone && <CheckCircle2 className="w-3 h-3 text-green-600" aria-label="Phone OK" />}
                                                                    {r.email && <CheckCircle2 className="w-3 h-3 text-[var(--sera-orange)]" aria-label="Email OK" />}
                                                                </span>
                                                            </div>
                                                            <div className="text-gray-500 text-xs flex gap-2">
                                                                <span>{r.email || '-'}</span>
                                                                <span className="border-l pl-2">{r.phone || '-'}</span>
                                                            </div>
                                                        </div>
                                                        <Badge variant="outline" className="text-xs opacity-75">{r.type}</Badge>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </TabsContent>

                            {/* Templates Editor */}
                            <TabsContent value="templates" className="mt-0 space-y-6">
                                <Tabs defaultValue={localSetting.channels_enabled[0] || 'whatsapp'}>
                                    <TabsList className="w-full justify-start gap-2 h-auto p-1 bg-gray-100">
                                        {type.available_channels.map((c: string) => (
                                            <TabsTrigger key={c} value={c} className="capitalize">{c}</TabsTrigger>
                                        ))}
                                    </TabsList>

                                    {type.available_channels.map((channel: string) => {
                                        const templatesForChannel = getTemplatesForEvent(type.event_code, channel);
                                        const currentTemplate = localSetting.templates?.[channel] || '';

                                        // Simple local mock resolution
                                        const resolvePreview = (tpl: string) => {
                                            const vars: any = {
                                                // Order variables
                                                order_no: sampleId || 'ORD26000048',
                                                order_date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                                                status: 'Approved',
                                                amount: '2,800.00',
                                                customer_name: 'Serapod Technology Sdn Bhd',
                                                customer_phone: '+60147519216',
                                                delivery_address: 'No4, Tingkat1, Lorong Perniagaan Alma Jaya 11, Taman Alma Jaya',
                                                approved_by: 'Admin User',
                                                approved_at: new Date().toLocaleDateString('en-GB'),
                                                closed_at: new Date().toLocaleDateString('en-GB'),
                                                action: 'Cancelled',
                                                reason: 'Out of stock',
                                                order_url: `${typeof window !== 'undefined' ? window.location.origin : 'https://app.serapod2u.com'}/supply-chain`,
                                                item_list: '• Cellera Hero – Deluxe Cellera Cartridge [Keladi Cheese] × 100 units (1 case) — RM 1,400.00\n• Super Pod V2 – Classic Mint × 200 units (2 cases) — RM 1,400.00',
                                                total_cases: '3',
                                                total_items: '2',
                                                buyer_org: 'Serapod Technology Sdn Bhd',
                                                seller_org: 'Shenzen VapeHome Technologies',
                                                // Order Deleted variables
                                                deleted_by: 'Super Admin',
                                                deleted_at: new Date().toLocaleString('en-GB'),
                                                // Manufacturer Scan Complete variables
                                                batch_id: 'BATCH-2024-00012',
                                                total_master_codes: '50',
                                                total_unique_codes: '5,000',
                                                production_completed_at: new Date().toLocaleString('en-GB'),
                                                completed_by: 'Manufacturing Operator',
                                                balance_document_no: 'PR26000012',
                                                // QR Batch Generated variables
                                                generated_at: new Date().toLocaleString('en-GB'),
                                                // Warehouse Received variables
                                                total_received: '5,000',
                                                warehouse_name: 'Main Warehouse KL',
                                                received_at: new Date().toLocaleString('en-GB'),
                                                // Document Workflow variables
                                                doc_no: 'PO26000015',
                                                doc_date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                                                doc_type: 'Purchase Order',
                                                doc_status: 'Pending Acknowledgement',
                                                buyer_name: 'Serapod Technology Sdn Bhd',
                                                seller_name: 'Shenzen VapeHome Technologies',
                                                deposit_amount: '840.00',
                                                balance_amount: '1,960.00',
                                                invoice_no: 'INV26000015',
                                                payment_no: 'PAY26000015',
                                                receipt_no: 'REC26000015',
                                                acknowledged_by: 'Factory Manager',
                                                acknowledged_at: new Date().toLocaleString('en-GB'),
                                                document_url: `${typeof window !== 'undefined' ? window.location.origin : 'https://app.serapod2u.com'}/supply-chain`,
                                                // Inventory variables
                                                product_name: 'Cellera Hero',
                                                variant_name: 'Deluxe Cartridge [Keladi Cheese]',
                                                sku: 'CLR-DLX-KC-001',
                                                available_qty: '15',
                                                reorder_point: '20',
                                                reorder_qty: '100',
                                                quantity_received: '500',
                                                total_on_hand: '515',
                                                inventory_url: `${typeof window !== 'undefined' ? window.location.origin : 'https://app.serapod.com'}/inventory`,
                                                // Stock Count verification variables (safe fixture only)
                                                verification_code: '12345678',
                                                target_user_name: 'Allam Salameh',
                                                requester_email: 'admin@serapod2u.com',
                                                otp_expiry_minutes: '5',
                                                total_variants_counted: '4',
                                                variance_items: '4',
                                                net_quantity_adjustment: '-5,595',
                                                estimated_adjustment_value: 'RM -77,361.21',
                                                organization_name: 'Serapod2U',
                                                count_date: '14 Jul 2026',
                                                count_type: 'Full Count',
                                                reference_name: '—',
                                                requested_by: 'Admin User',
                                                stock_count_requested_at: '15 Jul 2026, 10:30 AM (Asia/Kuala_Lumpur)',
                                                posting_note: 'Scheduled warehouse reconciliation',
                                                // QR / Consumer variables
                                                qr_code: 'QR-ABC-12345',
                                                scan_location: 'Kuala Lumpur, MY',
                                                scanned_at: new Date().toLocaleString('en-GB'),
                                                consumer_name: 'Ahmad bin Ali',
                                                consumer_phone: '+60123456789',
                                                points_earned: '50',
                                                total_points: '350',
                                                entry_number: 'LD-2024-00042',
                                                entry_status: 'Confirmed',
                                                reward_name: 'Free Starter Kit',
                                                points_used: '200',
                                                remaining_points: '150',
                                                // User variables
                                                user_name: 'Jane Smith',
                                                user_email: 'jane@example.com',
                                                user_role: 'Admin',
                                                created_at: new Date().toLocaleDateString('en-GB'),
                                                activated_at: new Date().toLocaleDateString('en-GB'),
                                                deactivated_at: new Date().toLocaleDateString('en-GB'),
                                                changed_at: new Date().toLocaleString('en-GB'),
                                                requested_at: new Date().toLocaleString('en-GB'),
                                                ip_address: '203.0.113.42',
                                                login_location: 'Unknown Location',
                                                login_time: new Date().toLocaleString('en-GB'),
                                                // Generic
                                                event_name: type.event_name || 'Order Submitted',
                                                reference_id: sampleId || 'ORD26000048'
                                            }
                                            let res = tpl || ''
                                            Object.keys(vars).forEach(k => {
                                                res = res.replace(new RegExp(`{{${k}}}`, 'g'), vars[k])
                                            })
                                            return res
                                        }

                                        return (
                                            <TabsContent key={channel} value={channel} className="space-y-4 pt-4">
                                                {!localSetting.channels_enabled.includes(channel) && (
                                                    <div className="p-3 bg-amber-50 text-amber-800 text-xs border border-amber-200">
                                                        Channel disabled
                                                    </div>
                                                )}

                                                {/* Template Library */}
                                                <div className="space-y-2">
                                                    <Label>Template Library</Label>
                                                    <Select value={templatesForChannel.find(template => template.body === currentTemplate)?.id || ''} onValueChange={(val) => {
                                                        const selected = templatesForChannel.find(t => t.id === val);
                                                        if (selected) updateTemplate(channel, selected.body);
                                                    }}>
                                                        <SelectTrigger>
                                                            <SelectValue placeholder="Choose a template..." />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {templatesForChannel.length > 0 ? (
                                                                templatesForChannel.map(t => (
                                                                    <SelectItem key={t.id} value={t.id}>
                                                                        <div className="flex flex-col">
                                                                            <span>{t.name}</span>
                                                                            {t.description && <span className="text-xs text-gray-400">{t.description}</span>}
                                                                        </div>
                                                                    </SelectItem>
                                                                ))
                                                            ) : (
                                                                <div className="p-2 text-xs text-gray-500 text-center">No preset templates</div>
                                                            )}
                                                        </SelectContent>
                                                    </Select>
                                                </div>

                                                <div className="space-y-2">
                                                    <Label>Message Content</Label>
                                                    <Textarea
                                                        placeholder={`Enter ${channel} message content...`}
                                                        className="min-h-[150px] font-mono text-sm"
                                                        value={currentTemplate}
                                                        onChange={(e) => updateTemplate(channel, e.target.value)}
                                                    />
                                                    <div className="text-xs text-gray-500">
                                                        Variables: {(() => {
                                                            const code = type.event_code;
                                                            const cat = type.category;
                                                            if (code === 'order_submitted')
                                                                return '{{order_no}}, {{order_date}}, {{customer_name}}, {{customer_phone}}, {{delivery_address}}, {{amount}}, {{item_list}}, {{total_cases}}, {{total_items}}, {{order_url}}';
                                                            if (code === 'order_approved')
                                                                return '{{order_no}}, {{order_date}}, {{customer_name}}, {{customer_phone}}, {{delivery_address}}, {{amount}}, {{item_list}}, {{total_cases}}, {{total_items}}, {{approved_by}}, {{approved_at}}, {{order_url}}';
                                                            if (code === 'order_closed')
                                                                return '{{order_no}}, {{order_date}}, {{customer_name}}, {{amount}}, {{item_list}}, {{total_cases}}, {{total_items}}, {{closed_at}}, {{order_url}}';
                                                            if (code === 'order_rejected')
                                                                return '{{order_no}}, {{order_date}}, {{customer_name}}, {{amount}}, {{status}}, {{action}}, {{reason}}, {{order_url}}';
                                                            if (code === 'order_deleted')
                                                                return '{{order_no}}, {{status}}, {{customer_name}}, {{deleted_by}}, {{deleted_at}}, {{order_url}}';
                                                            if (code === 'manufacturer_scan_complete')
                                                                return '{{order_no}}, {{batch_id}}, {{total_master_codes}}, {{total_unique_codes}}, {{production_completed_at}}, {{completed_by}}, {{customer_name}}, {{balance_document_no}}, {{order_url}}';
                                                            if (code === 'password_reset_otp' || code === 'registration_otp')
                                                                return '{{verification_code}}, {{otp_expiry_minutes}}';
                                                            if (code === 'stock_count_posting_verification')
                                                                return '{{verification_code}}, {{warehouse_name}}, {{organization_name}}, {{count_date}}, {{count_type}}, {{reference_name}}, {{requested_by}}, {{stock_count_requested_at}}, {{total_variants_counted}}, {{variance_items}}, {{net_quantity_adjustment}}, {{estimated_adjustment_value}}, {{posting_note}}';
                                                            if (cat === 'document')
                                                                return '{{doc_no}}, {{order_no}}, {{doc_date}}, {{amount}}, {{deposit_amount}}, {{balance_amount}}, {{buyer_name}}, {{seller_name}}, {{invoice_no}}, {{payment_no}}, {{receipt_no}}, {{acknowledged_by}}, {{acknowledged_at}}, {{document_url}}';
                                                            if (cat === 'inventory')
                                                                return '{{product_name}}, {{variant_name}}, {{sku}}, {{warehouse_name}}, {{available_qty}}, {{reorder_point}}, {{reorder_qty}}, {{quantity_received}}, {{total_on_hand}}, {{inventory_url}}';
                                                            if (cat === 'qr')
                                                                return '{{product_name}}, {{variant_name}}, {{qr_code}}, {{scan_location}}, {{scanned_at}}, {{consumer_name}}, {{consumer_phone}}, {{points_earned}}, {{total_points}}, {{entry_number}}, {{entry_status}}, {{reward_name}}, {{points_used}}, {{remaining_points}}';
                                                            if (cat === 'user')
                                                                return '{{user_name}}, {{user_email}}, {{user_role}}, {{created_at}}, {{activated_at}}, {{deactivated_at}}, {{changed_at}}, {{requested_at}}, {{ip_address}}, {{login_location}}, {{login_time}}';
                                                            return '{{order_no}}, {{status}}, {{customer_name}}, {{amount}}, {{approved_by}}, {{reason}}, {{order_url}}';
                                                        })()}
                                                    </div>
                                                </div>

                                                {/* Example Output */}
                                                <Card className="bg-gray-50/50">
                                                    <CardContent className="pt-4 pb-4">
                                                        <Label className="text-xs text-gray-500 uppercase mb-2 block">Example Output</Label>
                                                        {channel === 'email' ? (
                                                            <div className="space-y-2 text-sm bg-white p-3 border rounded">
                                                                <div className="border-b pb-2 mb-2 font-medium">Subject: {resolvePreview(templatesForChannel.find(template => template.body === currentTemplate)?.subject || 'Notification Subject')}</div>
                                                                <pre className="whitespace-pre-wrap font-sans text-gray-700">
                                                                    {resolvePreview(currentTemplate)}
                                                                </pre>
                                                            </div>
                                                        ) : (
                                                            <div className="bg-white p-3 border rounded-lg text-sm whitespace-pre-wrap relative">
                                                                <div className="absolute -left-1 top-3 w-0 h-0 border-t-[6px] border-t-transparent border-r-[8px] border-r-white border-b-[6px] border-b-transparent"></div>
                                                                {resolvePreview(currentTemplate) || <span className="text-gray-400 italic">No content</span>}
                                                            </div>
                                                        )}
                                                    </CardContent>
                                                </Card>
                                            </TabsContent>
                                        )
                                    })}
                                </Tabs>
                            </TabsContent>

                            {/* Test & Logs */}
                            <TabsContent value="test" className="mt-0 space-y-6">
                                <Card>
                                    <CardContent className="pt-6 space-y-4">
                                        <h4 className="font-medium text-sm">Send Test Message</h4>
                                        <div className="text-sm text-gray-500">
                                            Send the current template as a WhatsApp message to verify delivery.
                                        </div>

                                        {/* Quick Test - Direct Phone */}
                                        <div className="space-y-2">
                                            <Label className="text-xs font-medium text-gray-700">Quick Test — Send to Phone Number</Label>
                                            <div className="flex gap-2">
                                                <Input
                                                    placeholder="e.g. 0192277233"
                                                    value={quickTestPhone}
                                                    onChange={(e) => setQuickTestPhone(e.target.value)}
                                                    className="flex-1"
                                                />
                                                <Button
                                                    onClick={() => handleTestSend(quickTestPhone)}
                                                    disabled={testSending || !quickTestPhone.trim()}
                                                    size="sm"
                                                >
                                                    {testSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                                                    <span className="ml-1">Send</span>
                                                </Button>
                                            </div>
                                            <p className="text-xs text-gray-400">Enter phone number with or without country code (60 will be auto-prefixed)</p>
                                        </div>

                                        <div className="relative flex items-center gap-2 py-1">
                                            <div className="flex-1 border-t border-gray-200" />
                                            <span className="text-xs text-gray-400">or use resolved recipients</span>
                                            <div className="flex-1 border-t border-gray-200" />
                                        </div>

                                        {/* Resolved Recipient Test */}
                                        {resolvedRecipients.length === 0 ? (
                                            <div className="p-3 bg-gray-50 text-gray-500 text-sm border border-gray-200 rounded">
                                                No resolved recipients yet. Use "Quick Test" above, or go to Recipients tab → enter a Sample ID → click Resolve.
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                <div className="p-3 bg-[var(--sera-orange)]/[0.06] text-[var(--sera-orange-deep)] text-sm border border-[var(--sera-orange)]/20 rounded flex justify-between items-center">
                                                    <span>To: {resolvedRecipients[0].full_name} ({resolvedRecipients[0].phone || resolvedRecipients[0].email})</span>
                                                    <Badge variant="outline">Resolved</Badge>
                                                </div>
                                                <Button
                                                    className="w-full"
                                                    variant="outline"
                                                    onClick={() => handleTestSend()}
                                                    disabled={testSending}
                                                >
                                                    {testSending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <TestTube className="w-4 h-4 mr-2" />}
                                                    Send to Resolved Recipient
                                                </Button>
                                            </div>
                                        )}

                                        {testResult && (
                                            <div className={`p-3 rounded text-sm ${testResult.success ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'}`}>
                                                {testResult.success
                                                    ? '✅ Test message sent successfully! Check your WhatsApp.'
                                                    : `❌ Failed: ${testResult.error || 'Unknown error'}`}
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>

                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <h4 className="font-semibold text-sm">Recent Deliveries</h4>
                                        <Button variant="ghost" size="sm" onClick={fetchLogs}>
                                            <History className="w-3 h-3 mr-1" /> Refresh
                                        </Button>
                                    </div>

                                    <div className="border rounded-md divide-y text-sm">
                                        {logs.map((log) => (
                                            <div key={log.id} className="p-3 flex justify-between items-start hover:bg-gray-50">
                                                <div className="space-y-1">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-medium">{log.recipient}</span>
                                                        <Badge variant="outline" className="text-[10px] capitalize">{log.channel}</Badge>
                                                    </div>
                                                    <div className="text-xs text-gray-500">
                                                        {new Date(log.created_at).toLocaleString()}
                                                    </div>
                                                </div>
                                                <Badge className={
                                                    log.status === 'sent' || log.status === 'delivered' ? 'bg-green-600' :
                                                        log.status === 'failed' ? 'bg-red-600' : 'bg-gray-600'
                                                }>
                                                    {log.status}
                                                </Badge>
                                            </div>
                                        ))}
                                        {!loadingLogs && logs.length === 0 && (
                                            <div className="p-4 text-center text-gray-400">No logs found</div>
                                        )}
                                    </div>
                                </div>
                            </TabsContent>
                        </div>
                    </Tabs>

                    {/* Footer Actions */}
                    <div className="p-6 border-t bg-white mt-auto">
                        <div className="flex justify-end gap-3">
                            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                            <Button onClick={handleSave} disabled={savingChanges}>
                                {savingChanges ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                <span className={savingChanges ? 'ml-2' : ''}>{savingChanges ? 'Saving...' : 'Save Changes'}</span>
                            </Button>
                        </div>
                    </div>
                </div>
            </SheetContent>
        </Sheet>
    )
}
