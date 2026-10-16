'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Send, Save, AlertTriangle, Users, Calendar as CalendarIcon, Clock, Smartphone, ChevronRight, Check, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { format } from "date-fns";
import { useToast } from "@/components/ui/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AudienceFilterBuilder, AudienceFilters } from './AudienceFilterBuilder';
import { AudienceEstimator } from './AudienceEstimator';
import { SpecificUserSelector } from './SpecificUserSelector';
import { CampaignSafetyAdvisor } from './CampaignSafetyAdvisor';
import { PrelaunchAnalysisModal } from './PrelaunchAnalysisModal';
import {
    type ParsedRecipient,
    normalizeAdhocRecipientList,
    summarizeAdhocRecipients,
} from '@/lib/marketing/adhocRecipients';
import {
    validateTemplate,
    getRiskLevel,
    getRiskBadgeColor,
    getRiskBadgeLabel,
    type TemplateSafetyResult
} from '@/lib/template-safety.client';
import { NumberHealth } from '@/lib/wa-safety';
import { getDailyReportingTemplate } from '@/lib/reporting/dailyReporting';

const DAILY_REPORTING_TEMPLATE_VARIABLES = [
    'report_date',
    'today_scans',
    'yesterday_scans',
    'this_week_scans',
    'unique_customers'
];


type WizardProps = {
    onCancel: () => void;
    onComplete: () => void;
    editingCampaign?: any;
    selectedLanguage?: 'EN' | 'BM';
    onLanguageChange?: (lang: 'EN' | 'BM') => void;
};

type WinbackCategory = NonNullable<AudienceFilters['winback_category']>;
type WinbackStatus = NonNullable<AudienceFilters['winback_status']>;
type WinbackScanMode = NonNullable<AudienceFilters['winback_last_scan_mode']>;

type DailyReportingPreview = {
    message: string;
    report: {
        reportDateLabel: string;
        reportType: 'daily' | 'weekly';
        todayScans: number;
        yesterdayScans: number;
        thisWeekScans: number;
        uniqueCustomers: number;
    };
};

const DEFAULT_WINBACK_FILTERS: Pick<AudienceFilters, 'winback_category' | 'winback_status' | 'winback_last_scan_mode' | 'winback_last_scan_days' | 'winback_points_min'> = {
    winback_category: 'shop_performance',
    winback_status: 'inactive',
    winback_last_scan_mode: 'older_than_days',
    winback_last_scan_days: 30,
    winback_points_min: null,
};

const WINBACK_CATEGORY_OPTIONS: Array<{ value: WinbackCategory; label: string; description: string }> = [
    { value: 'shop_performance', label: 'Shop Performance', description: 'Target shop contacts based on shop report activity or balance.' },
    { value: 'shop_staff_performance', label: 'Shop Staff Performance', description: 'Target shop-linked user accounts from the staff performance report.' },
    { value: 'consumer_performance', label: 'Consumer Performance', description: 'Target consumer accounts that collect through the consumer lane.' },
];

const WINBACK_TEMPLATE_PRESETS: Array<{
    id: string;
    language: 'EN' | 'BM';
    category: WinbackCategory;
    status: Exclude<WinbackStatus, 'all'>;
    title: string;
    description: string;
    message: string;
}> = [
        {
            id: 'winback-shop-inactive-en',
            language: 'EN',
            category: 'shop_performance',
            status: 'inactive',
            title: 'Re-activate inactive shops',
            description: 'Invite dormant shop partners back into the program with a direct action CTA.',
            message: 'Hi {name}, we noticed your shop has been quiet lately on Serapod2u. Scan your next QR and get back into the reward flow. Reply if you need support from our team.',
        },
        {
            id: 'winback-shop-active-en',
            language: 'EN',
            category: 'shop_performance',
            status: 'active',
            title: 'Keep active shops engaged',
            description: 'Nudge active shop partners to keep scanning consistently.',
            message: 'Hi {name}, your shop is actively collecting on Serapod2u. Keep the momentum going and continue scanning your QR codes to maximise your rewards this month.',
        },
        {
            id: 'winback-staff-inactive-en',
            language: 'EN',
            category: 'shop_staff_performance',
            status: 'inactive',
            title: 'Bring staff back to scanning',
            description: 'Prompt inactive staff users to resume collection.',
            message: 'Hi {name}, your point collection activity has slowed down. Open your Serapod2u journey link and start scanning again to continue earning rewards for your shop.',
        },
        {
            id: 'winback-consumer-inactive-en',
            language: 'EN',
            category: 'consumer_performance',
            status: 'inactive',
            title: 'Reconnect inactive consumers',
            description: 'Bring consumer-lane users back with a simple reminder.',
            message: 'Hi {name}, it has been a while since your last Serapod2u scan. Your account is still ready. Scan your next QR to continue collecting points and rewards.',
        },
        {
            id: 'winback-shop-inactive-bm',
            language: 'BM',
            category: 'shop_performance',
            status: 'inactive',
            title: 'Aktifkan semula kedai tidak aktif',
            description: 'Ajak semula rakan kedai yang lama tidak membuat imbasan.',
            message: 'Hi {name}, kami perasan kedai anda sudah lama tidak aktif di Serapod2u. Buat imbasan QR seterusnya untuk terus kumpul ganjaran. Balas mesej ini jika perlukan bantuan daripada pasukan kami.',
        },
        {
            id: 'winback-shop-active-bm',
            language: 'BM',
            category: 'shop_performance',
            status: 'active',
            title: 'Kekalkan kedai aktif',
            description: 'Galakkan kedai aktif untuk terus konsisten membuat imbasan.',
            message: 'Hi {name}, kedai anda sedang aktif mengumpul ganjaran di Serapod2u. Teruskan momentum ini dengan mengimbas kod QR anda secara konsisten untuk maksimakan ganjaran bulan ini.',
        },
        {
            id: 'winback-staff-inactive-bm',
            language: 'BM',
            category: 'shop_staff_performance',
            status: 'inactive',
            title: 'Aktifkan semula staf kedai',
            description: 'Ingatkan staf kedai yang tidak aktif untuk mula imbas semula.',
            message: 'Hi {name}, aktiviti kutipan mata anda semakin perlahan. Buka semula pautan journey Serapod2u anda dan mula imbas semula untuk terus kumpul ganjaran bagi kedai anda.',
        },
        {
            id: 'winback-consumer-inactive-bm',
            language: 'BM',
            category: 'consumer_performance',
            status: 'inactive',
            title: 'Hubungi semula pengguna tidak aktif',
            description: 'Bawa semula pengguna consumer lane dengan peringatan ringkas.',
            message: 'Hi {name}, sudah lama anda tidak membuat imbasan Serapod2u. Akaun anda masih aktif. Buat imbasan QR seterusnya untuk terus kumpul mata dan ganjaran.',
        },
    ];

export function CreateCampaignWizard({ onCancel, onComplete, editingCampaign, selectedLanguage: propLanguage, onLanguageChange }: WizardProps) {
    const { toast } = useToast();
    const router = useRouter();
    const searchParams = useSearchParams();
    const [step, setStep] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [testing, setTesting] = useState(false);
    const [estimatedRecipients, setEstimatedRecipients] = useState(0);
    const [acknowledgeRisk, setAcknowledgeRisk] = useState(false);
    const [showPrelaunchModal, setShowPrelaunchModal] = useState(false);
    const [dailyReportingPreview, setDailyReportingPreview] = useState<DailyReportingPreview | null>(null);
    const [loadingDailyReportingPreview, setLoadingDailyReportingPreview] = useState(false);

    const [segments, setSegments] = useState<any[]>([]);
    const [templates, setTemplates] = useState<any[]>([]);
    const [selectedCategory, setSelectedCategory] = useState<string>('All Categories');
    // Use prop language if provided, otherwise local state
    const [localLanguage, setLocalLanguage] = useState<'EN' | 'BM'>(propLanguage || 'EN');
    const selectedLanguage = propLanguage ?? localLanguage;
    const setSelectedLanguage = onLanguageChange ?? setLocalLanguage;

    // Mock number health - in real app fetch from API
    const [numberHealth] = useState<NumberHealth>({
        riskScore: 15,
        uptime24h: 98.5,
        disconnects24h: 3,
        successRate: 94.2,
        lastIssueRecency: '2h ago',
    });

    // Message safety validation
    const [messageSafety, setMessageSafety] = useState<TemplateSafetyResult | null>(null);

    const [formData, setFormData] = useState({
        name: '',
        objective: 'Promo',
        reportingType: 'daily' as 'daily' | 'weekly',
        enableReplyAction: true,

        // Audience
        audienceMode: 'filters' as 'filters' | 'segment' | 'specific_users',
        selectedSegmentId: '',
        selectedUserIds: [] as string[],
        adhocRecipients: [] as ParsedRecipient[],
        filters: {
            organization_type: 'all',
            state: 'any',
            opt_in_only: true,
            only_valid_whatsapp: true
        } as AudienceFilters,

        message: '',
        templateId: '',
        scheduleType: 'now',
        scheduledDate: undefined as Date | undefined,
        quietHours: true,

        // Manual Overrides
        overrideIncludeIds: [] as string[],
        overrideExcludeIds: [] as string[]
    });


    // Load editing campaign data if provided
    useEffect(() => {
        if (editingCampaign) {
            const audienceFilters = editingCampaign.audience_filters || {};
            setFormData({
                name: editingCampaign.name || '',
                objective: editingCampaign.objective || 'Promo',
                reportingType: editingCampaign.audience_filters?.reporting?.report_type === 'weekly' ? 'weekly' : 'daily',
                enableReplyAction: editingCampaign.audience_filters?.reporting?.enable_reply_action !== false,
                audienceMode: audienceFilters.mode || 'filters',
                selectedSegmentId: audienceFilters.segment_id || '',
                selectedUserIds: audienceFilters.user_ids || [],
                adhocRecipients: normalizeAdhocRecipientList(audienceFilters.adhoc_recipients),
                filters: audienceFilters.filters || {
                    organization_type: 'all',
                    state: 'any',
                    opt_in_only: true,
                    only_valid_whatsapp: true
                },
                message: editingCampaign.message_body || '',
                templateId: editingCampaign.template_id || '',
                scheduleType: editingCampaign.scheduled_at ? 'schedule' : 'now',
                scheduledDate: editingCampaign.scheduled_at ? new Date(editingCampaign.scheduled_at) : undefined,
                quietHours: editingCampaign.quiet_hours_enabled !== false,
                overrideIncludeIds: audienceFilters.overrides?.include_ids || [],
                overrideExcludeIds: audienceFilters.overrides?.exclude_ids || []
            });
            setEstimatedRecipients(audienceFilters.estimated_count || 0);
        }
    }, [editingCampaign]);

    useEffect(() => {
        // Fetch Segments
        console.log('Fetching segments and templates...');
        fetch('/api/wa/marketing/segments')
            .then(r => r.json())
            .then(d => setSegments(Array.isArray(d) ? d : []))
            .catch(err => console.error('Error fetching segments:', err));

        // Fetch Templates
        fetch('/api/wa/marketing/templates')
            .then(r => r.json())
            .then(d => {
                console.log('Templates fetched:', d);
                if (Array.isArray(d)) {
                    const normalized = d.map((t: any) => ({
                        ...t,
                        language: (t.language || 'EN').toString().toUpperCase()
                    }));
                    setTemplates(normalized);
                } else {
                    setTemplates([]);
                }
            })
            .catch(err => console.error('Error fetching templates:', err));

    }, []);

    // Sync selected language from chosen template (editing or manual selection)
    useEffect(() => {
        if (formData.templateId && templates.length > 0) {
            const tmpl = templates.find(t => t.id === formData.templateId);
            if (tmpl?.language) {
                setSelectedLanguage((tmpl.language || 'EN').toString().toUpperCase() as 'EN' | 'BM');
            }
        }
    }, [formData.templateId, templates]);

    // If language changes and current template doesn't match, clear template selection
    useEffect(() => {
        if (formData.templateId) {
            const tmpl = templates.find(t => t.id === formData.templateId);
            const tmplLang = (tmpl?.language || 'EN').toString().toUpperCase();
            if (tmplLang !== selectedLanguage) {
                setFormData(prev => ({ ...prev, templateId: '' }));
            }
        }
    }, [selectedLanguage, templates, formData.templateId]);

    const isDailyReportingObjective = formData.objective === 'Daily Reporting';

    // Validate message safety when it changes
    useEffect(() => {
        const messageToValidate = isDailyReportingObjective
            ? (dailyReportingPreview?.message || formData.message)
            : formData.message;

        if (messageToValidate) {
            const result = validateTemplate(messageToValidate, isDailyReportingObjective ? {
                requiresPersonalization: false,
                additionalSupportedVariables: DAILY_REPORTING_TEMPLATE_VARIABLES,
            } : undefined);
            setMessageSafety(result);
            // Reset acknowledgement if risk changes
            if (result.riskScore >= 80 || result.riskScore < 50) {
                setAcknowledgeRisk(false);
            }
        } else {
            setMessageSafety(null);
        }
    }, [dailyReportingPreview?.message, formData.message, isDailyReportingObjective]);

    useEffect(() => {
        if (!isDailyReportingObjective) {
            setDailyReportingPreview(null);
            return;
        }

        const nextTemplate = getDailyReportingTemplate(formData.enableReplyAction);
        setFormData((prev) => prev.message === nextTemplate && prev.templateId === ''
            ? prev
            : {
                ...prev,
                templateId: '',
                message: nextTemplate,
            });
    }, [isDailyReportingObjective, formData.enableReplyAction]);

    useEffect(() => {
        if (!isDailyReportingObjective) return;

        let cancelled = false;

        const loadPreview = async () => {
            setLoadingDailyReportingPreview(true);
            try {
                const referenceDate = formData.scheduleType === 'schedule' && formData.scheduledDate
                    ? formData.scheduledDate.toISOString()
                    : new Date().toISOString();

                const res = await fetch('/api/wa/marketing/reporting/preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        report_type: formData.reportingType,
                        enable_reply_action: formData.enableReplyAction,
                        referenceDate,
                    })
                });

                if (!res.ok) {
                    throw new Error('Failed to load Daily Reporting preview');
                }

                const data = await res.json();
                if (!cancelled) {
                    setDailyReportingPreview({
                        message: data.message,
                        report: data.report,
                    });
                }
            } catch (error) {
                if (!cancelled) {
                    setDailyReportingPreview(null);
                }
            } finally {
                if (!cancelled) {
                    setLoadingDailyReportingPreview(false);
                }
            }
        };

        loadPreview();

        return () => {
            cancelled = true;
        };
    }, [isDailyReportingObjective, formData.reportingType, formData.enableReplyAction, formData.scheduleType, formData.scheduledDate]);

    // Memoized count change handler
    const handleCountChange = useCallback((count: number) => {
        setEstimatedRecipients(count);
    }, []);

    const steps = [
        { num: 1, label: 'Objective' },
        { num: 2, label: 'Audience' },
        { num: 3, label: 'Message' },
        { num: 4, label: 'Review' }
    ];

    const handleNext = () => setStep(s => Math.min(s + 1, 4));
    const handleBack = () => setStep(s => Math.max(s - 1, 1));

    const handleTestSend = async () => {
        const resolvedTestMessage = isDailyReportingObjective ? (dailyReportingPreview?.message || formData.message) : formData.message;
        if (!resolvedTestMessage) {
            toast({ title: "Error", description: "Please enter a message first.", variant: "destructive" });
            return;
        }
        setTesting(true);
        try {
            const res = await fetch('/api/wa/marketing/test-send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: resolvedTestMessage,
                    test_user_id: formData.selectedUserIds?.[0],
                    objective: formData.objective,
                    reporting: isDailyReportingObjective ? {
                        report_type: formData.reportingType,
                        enable_reply_action: formData.enableReplyAction,
                        referenceDate: formData.scheduleType === 'schedule' && formData.scheduledDate
                            ? formData.scheduledDate.toISOString()
                            : new Date().toISOString(),
                    } : undefined,
                })
            });
            const data = await res.json();
            if (res.ok) {
                toast({ title: "Sent", description: data.sent_to ? `Test message sent to ${data.sent_to}` : "Test message sent" });
            } else {
                toast({ title: "Error", description: data.error, variant: "destructive" });
            }
        } catch (error) {
            toast({ title: "Error", description: "Failed to send test message", variant: "destructive" });
        } finally {
            setTesting(false);
        }
    };

    const handleLaunch = async () => {
        if (!formData.name || !formData.message) {
            toast({ title: "Error", description: "Please fill in all required fields", variant: "destructive" });
            return;
        }

        // Pre-send safety checks
        if (messageSafety) {
            // Block if risk >= 80
            if (messageSafety.riskScore >= 80) {
                toast({
                    title: "Campaign Blocked",
                    description: "Message has critical safety issues. Please fix them before launching.",
                    variant: "destructive"
                });
                return;
            }

            // Require acknowledgement if risk 50-79
            if (messageSafety.riskScore >= 50 && !acknowledgeRisk) {
                toast({
                    title: "Acknowledgement Required",
                    description: "Please acknowledge the risks before launching this campaign.",
                    variant: "destructive"
                });
                return;
            }

            // Check for blocking errors
            if (!messageSafety.isValid) {
                toast({
                    title: "Cannot Launch",
                    description: messageSafety.errors[0]?.message || "Message has validation errors.",
                    variant: "destructive"
                });
                return;
            }
        }

        // Show pre-launch analysis modal instead of launching immediately
        setShowPrelaunchModal(true);
    };

    // Called when user confirms launch in the prelaunch modal
    const handleConfirmLaunch = async (config: {
        presetId: string;
        mode: 'send_now' | 'schedule';
        scheduledAt?: string;
        split?: { enabled: boolean; batchSize: number };
    }) => {
        setShowPrelaunchModal(false);

        // Idempotency: prevent double-click
        if (submitting) return;
        setSubmitting(true);

        try {
            // Determine schedule based on config
            const isScheduled = config.mode === 'schedule' || config.scheduledAt;
            const scheduledAt = config.scheduledAt || (formData.scheduleType === 'schedule' ? formData.scheduledDate : null);

            // First, create/update the campaign with preset snapshot
            const res = await fetch('/api/wa/marketing/campaigns', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: formData.name,
                    objective: formData.objective,
                    audience_filters: {
                        mode: effectiveAudienceMode,
                        filters: formData.filters,
                        segment_id: isWinbackObjective ? null : (formData.selectedSegmentId || null),
                        user_ids: isWinbackObjective ? [] : formData.selectedUserIds.filter(Boolean),
                        adhoc_recipients: isWinbackObjective ? [] : formData.adhocRecipients,
                        reporting: isDailyReportingObjective ? {
                            report_type: formData.reportingType,
                            enable_reply_action: formData.enableReplyAction,
                        } : undefined,
                        estimated_count: estimatedRecipients,
                        overrides: {
                            include_ids: formData.overrideIncludeIds,
                            exclude_ids: formData.overrideExcludeIds
                        }
                    },
                    message_body: formData.message,
                    template_id: formData.templateId || null,
                    scheduled_at: scheduledAt,
                    quiet_hours_enabled: formData.quietHours,
                    // Include preset configuration for audit
                    safety_preset_id: config.presetId,
                    split_config: config.split,
                })
            });

            if (res.ok) {
                const campaignData = await res.json();

                // If "Send Now" mode, launch the campaign immediately
                if (config.mode === 'send_now' && campaignData?.id) {
                    // Show launching state - NOT success yet
                    toast({ title: "Launching Campaign...", description: "Preparing to send to recipients..." });

                    const launchRes = await fetch(`/api/wa/marketing/campaigns/${campaignData.id}/launch`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            preset_id: config.presetId,
                            split: config.split,
                        })
                    });

                    if (launchRes.ok) {
                        const launchData = await launchRes.json();
                        // Get preset name for toast
                        const presetNames: Record<string, string> = {
                            'system-safe-warmup': 'Safe Warm-Up',
                            'system-balanced': 'Balanced',
                            'system-high-volume': 'High Volume'
                        };
                        toast({
                            title: "Campaign Launched!",
                            description: `Sending to ${launchData.total_recipients ?? estimatedRecipients} recipients using ${presetNames[config.presetId] || config.presetId} preset`
                        });
                    } else {
                        const launchError = await launchRes.json().catch(() => ({ error: 'Unknown error' }));
                        const retryable = launchError.retryable !== false;
                        toast({
                            title: "Launch Failed",
                            description: `Campaign saved as draft. ${launchError.error || 'Internal server error'}${retryable ? ' — you can retry from the Campaigns list.' : ''}`,
                            variant: "destructive",
                            duration: 8000,
                        });
                    }
                } else {
                    toast({
                        title: "Success",
                        description: config.mode === 'schedule'
                            ? "Campaign scheduled successfully!"
                            : "Campaign created successfully!"
                    });
                }

                onComplete();
            } else {
                const data = await res.json();
                toast({ title: "Error", description: data.error, variant: "destructive" });
            }
        } catch (error) {
            toast({ title: "Error", description: "Failed to create campaign", variant: "destructive" });
        } finally {
            setSubmitting(false);
        }
    };

    const insertVariable = (variable: string) => {
        setFormData(prev => ({ ...prev, message: prev.message + variable }));
    };

    const riskLevel = estimatedRecipients > 5000 ? 'High' : estimatedRecipients > 1000 ? 'Medium' : 'Low';
    const isWinbackObjective = formData.objective === 'Winback';
    const effectiveAudienceMode = isWinbackObjective ? 'filters' : formData.audienceMode;
    const adhocSummary = summarizeAdhocRecipients(formData.adhocRecipients);

    const templatesByLanguage = templates.filter(
        (t) => (t.language || 'EN').toString().toUpperCase() === selectedLanguage
    );
    const winbackTemplateSuggestions = WINBACK_TEMPLATE_PRESETS.filter((preset) => {
        if (preset.language !== selectedLanguage) return false;
        if (formData.filters.winback_category && preset.category !== formData.filters.winback_category) return false;
        if (formData.filters.winback_status && formData.filters.winback_status !== 'all' && preset.status !== formData.filters.winback_status) return false;
        return true;
    });

    // Helper function for category badge colors
    const getCategoryBadgeColor = (category: string) => {
        if (selectedCategory === category) return '';
        const colors: Record<string, string> = {
            'Engagement': 'hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200',
            'Informational': 'hover:bg-gray-50 hover:text-gray-700',
            'Loyalty': 'hover:bg-purple-50 hover:text-purple-700 hover:border-purple-200',
            'Promotional': 'hover:bg-orange-50 hover:text-orange-700 hover:border-orange-200',
            'Reactivation': 'hover:bg-red-50 hover:text-red-700 hover:border-red-200',
            'Seasonal': 'hover:bg-green-50 hover:text-green-700 hover:border-green-200',
            'VIP': 'hover:bg-yellow-50 hover:text-yellow-700 hover:border-yellow-200',
            'General': 'hover:bg-gray-50',
        };
        return colors[category] || '';
    };

    return (
        <Card className="w-full border shadow-sm flex flex-col max-h-[calc(100vh-200px)] overflow-hidden">
            <CardHeader className="flex-shrink-0">
                <div className="flex justify-between items-center mb-8">
                    <CardTitle className="text-xl">{editingCampaign ? 'Edit Campaign' : 'Create New Campaign'}</CardTitle>
                    <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
                </div>
                {/* Stepper */}
                <div className="flex justify-between relative max-w-4xl mx-auto w-full px-4 mb-4">
                    <div className="absolute top-1/2 left-0 right-0 h-1 bg-gray-100 -z-10 -translate-y-1/2" />
                    {steps.map((s) => (
                        <div key={s.num} className="flex flex-col items-center gap-2 bg-white px-4">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-colors
                                ${step >= s.num ? 'bg-primary text-primary-foreground border-primary shadow-sm' : 'bg-white text-gray-400 border-gray-200'}`}>
                                {step > s.num ? <Check className="w-5 h-5" /> : s.num}
                            </div>
                            <span className={`text-xs font-medium uppercase tracking-wider ${step >= s.num ? 'text-gray-900' : 'text-gray-400'}`}>{s.label}</span>
                        </div>
                    ))}
                </div>
            </CardHeader>
            <CardContent className="pt-8 min-h-[400px] flex-1 overflow-y-auto">
                {/* Step 1: Objective */}
                {step === 1 && (
                    <div className="max-w-4xl mx-auto space-y-8">
                        <div className="grid md:grid-cols-2 gap-8">
                            <div className="space-y-3">
                                <Label className="text-base">Campaign Name</Label>
                                <Input
                                    className="h-12 text-lg"
                                    placeholder="e.g. End of Month Sale"
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                />
                                <p className="text-sm text-gray-500">Give your campaign a descriptive name for internal tracking.</p>
                            </div>
                            <div className="space-y-3">
                                <Label className="text-base">Objective</Label>
                                <Select
                                    value={formData.objective}
                                    onValueChange={v => setFormData(prev => ({
                                        ...prev,
                                        objective: v,
                                        audienceMode: v === 'Winback' ? 'filters' : prev.audienceMode,
                                        filters: v === 'Winback'
                                            ? {
                                                ...prev.filters,
                                                winback_category: prev.filters.winback_category || DEFAULT_WINBACK_FILTERS.winback_category,
                                                winback_status: prev.filters.winback_status || DEFAULT_WINBACK_FILTERS.winback_status,
                                                winback_last_scan_mode: prev.filters.winback_last_scan_mode || DEFAULT_WINBACK_FILTERS.winback_last_scan_mode,
                                                winback_last_scan_days: prev.filters.winback_last_scan_days ?? DEFAULT_WINBACK_FILTERS.winback_last_scan_days,
                                                winback_points_min: prev.filters.winback_points_min ?? DEFAULT_WINBACK_FILTERS.winback_points_min,
                                            }
                                            : prev.filters,
                                    }))}
                                >
                                    <SelectTrigger className="h-12"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="Promo">Marketing / Promo</SelectItem>
                                        <SelectItem value="Announcement">Announcement</SelectItem>
                                        <SelectItem value="Loyalty Reminder">Loyalty Reminder</SelectItem>
                                        <SelectItem value="Daily Reporting">Daily Reporting</SelectItem>
                                        <SelectItem value="Winback">User Winback</SelectItem>
                                    </SelectContent>
                                </Select>
                                <p className="text-sm text-gray-500">This helps categorize your campaigns in reports.</p>
                            </div>
                        </div>

                        {isDailyReportingObjective && (
                            <div className="grid md:grid-cols-2 gap-8 rounded-xl border bg-slate-50/80 p-5">
                                <div className="space-y-3">
                                    <Label className="text-base">Report Type</Label>
                                    <Select
                                        value={formData.reportingType}
                                        onValueChange={(value: 'daily' | 'weekly') => setFormData((prev) => ({
                                            ...prev,
                                            reportingType: value,
                                        }))}
                                    >
                                        <SelectTrigger className="h-12"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="daily">Daily</SelectItem>
                                            <SelectItem value="weekly">Weekly</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="text-sm text-gray-500">
                                        Weekly values always use fixed Monday 00:00:00 to Sunday 23:59:59 logic.
                                    </p>
                                </div>
                                <div className="space-y-3">
                                    <Label className="text-base">Reply Action</Label>
                                    <div className="flex items-center justify-between rounded-lg border bg-white px-4 py-3">
                                        <div>
                                            <div className="font-medium text-sm text-gray-900">Enable unique customer detail replies</div>
                                            <p className="text-sm text-gray-500">Reply 1 shows the first page and Reply 2 continues the list.</p>
                                        </div>
                                        <Switch
                                            checked={formData.enableReplyAction}
                                            onCheckedChange={(checked) => setFormData((prev) => ({
                                                ...prev,
                                                enableReplyAction: checked,
                                            }))}
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Step 2: Audience */}
                {step === 2 && (
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-6 min-h-[500px]">
                        {/* Left Column: Filters - 2/5 = 40% */}
                        <div className="md:col-span-2 space-y-4 flex flex-col h-full order-2 md:order-1">
                            <h3 className="font-medium">Define Audience</h3>

                            {isWinbackObjective ? (
                                <div className="rounded-lg border bg-amber-50/60 p-4 space-y-3">
                                    <div>
                                        <Label className="text-sm font-medium">Winback Audience Source</Label>
                                        <p className="mt-1 text-sm text-muted-foreground">
                                            User Winback targets the same report groups used in Shop Performance, Shop Staff Performance, and Consumer Performance.
                                        </p>
                                    </div>

                                    <div className="space-y-2">
                                        <Label>Report Category</Label>
                                        <Select
                                            value={formData.filters.winback_category || DEFAULT_WINBACK_FILTERS.winback_category}
                                            onValueChange={(value: WinbackCategory) => setFormData(prev => ({
                                                ...prev,
                                                audienceMode: 'filters',
                                                filters: {
                                                    ...prev.filters,
                                                    winback_category: value,
                                                }
                                            }))}
                                        >
                                            <SelectTrigger><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                {WINBACK_CATEGORY_OPTIONS.map((option) => (
                                                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <p className="text-xs text-muted-foreground">
                                            {WINBACK_CATEGORY_OPTIONS.find((option) => option.value === (formData.filters.winback_category || DEFAULT_WINBACK_FILTERS.winback_category))?.description}
                                        </p>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <div className="space-y-2">
                                            <Label>Report Status</Label>
                                            <Select
                                                value={formData.filters.winback_status || DEFAULT_WINBACK_FILTERS.winback_status}
                                                onValueChange={(value: WinbackStatus) => setFormData(prev => ({
                                                    ...prev,
                                                    audienceMode: 'filters',
                                                    filters: {
                                                        ...prev.filters,
                                                        winback_status: value,
                                                    }
                                                }))}
                                            >
                                                <SelectTrigger><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="all">All</SelectItem>
                                                    <SelectItem value="active">Active</SelectItem>
                                                    <SelectItem value="inactive">Inactive</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>Last Scan</Label>
                                            <Select
                                                value={formData.filters.winback_last_scan_mode || DEFAULT_WINBACK_FILTERS.winback_last_scan_mode}
                                                onValueChange={(value: WinbackScanMode) => setFormData(prev => ({
                                                    ...prev,
                                                    audienceMode: 'filters',
                                                    filters: {
                                                        ...prev.filters,
                                                        winback_last_scan_mode: value,
                                                        winback_last_scan_days: value === 'any' || value === 'no_scan'
                                                            ? null
                                                            : (prev.filters.winback_last_scan_days ?? DEFAULT_WINBACK_FILTERS.winback_last_scan_days),
                                                    }
                                                }))}
                                            >
                                                <SelectTrigger><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="any">Any timing</SelectItem>
                                                    <SelectItem value="within_days">Within last X days</SelectItem>
                                                    <SelectItem value="older_than_days">Older than X days</SelectItem>
                                                    <SelectItem value="no_scan">Never scanned</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    {(formData.filters.winback_last_scan_mode === 'within_days' || formData.filters.winback_last_scan_mode === 'older_than_days') && (
                                        <div className="space-y-2">
                                            <Label>Number of Days</Label>
                                            <Input
                                                type="number"
                                                min={1}
                                                value={formData.filters.winback_last_scan_days ?? DEFAULT_WINBACK_FILTERS.winback_last_scan_days}
                                                onChange={(e) => setFormData(prev => ({
                                                    ...prev,
                                                    audienceMode: 'filters',
                                                    filters: {
                                                        ...prev.filters,
                                                        winback_last_scan_days: e.target.value ? Number(e.target.value) : null,
                                                    }
                                                }))}
                                            />
                                            <p className="text-xs text-muted-foreground">
                                                Active or inactive uses the configured report rules. This filter adds a second check based on actual scan recency.
                                            </p>
                                        </div>
                                    )}

                                    <div className="space-y-2">
                                        <Label>Minimum Points</Label>
                                        <Input
                                            type="number"
                                            min={0}
                                            placeholder="Leave empty to include all balances"
                                            value={formData.filters.winback_points_min ?? ''}
                                            onChange={(e) => setFormData(prev => ({
                                                ...prev,
                                                audienceMode: 'filters',
                                                filters: {
                                                    ...prev.filters,
                                                    winback_points_min: e.target.value === '' ? null : Number(e.target.value),
                                                }
                                            }))}
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            Filters recipients to report rows with at least this many points or balance.
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    <Label>Audience Source</Label>
                                    <Tabs value={formData.audienceMode} onValueChange={(v: any) => setFormData({ ...formData, audienceMode: v })} className="w-full">
                                        <TabsList className="grid w-full grid-cols-3">
                                            <TabsTrigger value="filters">Filters</TabsTrigger>
                                            <TabsTrigger value="segment">Saved Segment</TabsTrigger>
                                            <TabsTrigger value="specific_users">Manual</TabsTrigger>
                                        </TabsList>
                                    </Tabs>
                                </div>
                            )}

                            <ScrollArea className="flex-1 pr-4">
                                {!isWinbackObjective && effectiveAudienceMode === 'filters' && (
                                    <AudienceFilterBuilder
                                        filters={formData.filters}
                                        onChange={(f: AudienceFilters) => setFormData({ ...formData, filters: f })}
                                    />
                                )}

                                {!isWinbackObjective && formData.audienceMode === 'segment' && (
                                    <div className="space-y-2 pt-2">
                                        <Label>Select Segment</Label>
                                        <Select
                                            value={formData.selectedSegmentId}
                                            onValueChange={(v) => setFormData({ ...formData, selectedSegmentId: v })}
                                        >
                                            <SelectTrigger><SelectValue placeholder="Choose a segment..." /></SelectTrigger>
                                            <SelectContent>
                                                {segments.length === 0 ? (
                                                    <SelectItem value="none" disabled>No saved segments</SelectItem>
                                                ) : (
                                                    segments.map((s: any) => (
                                                        <SelectItem key={s.id} value={s.id}>{s.name} ({s.estimated_count} users)</SelectItem>
                                                    ))
                                                )}
                                            </SelectContent>
                                        </Select>
                                        {formData.selectedSegmentId && (
                                            <p className="text-xs text-muted-foreground mt-2">
                                                {segments.find((s: any) => s.id === formData.selectedSegmentId)?.description}
                                            </p>
                                        )}
                                    </div>
                                )}

                                {!isWinbackObjective && formData.audienceMode === 'specific_users' && (
                                    <SpecificUserSelector
                                        selectedUserIds={formData.selectedUserIds}
                                        onSelect={(ids) => setFormData(prev => ({ ...prev, selectedUserIds: ids }))}
                                        adhocRecipients={formData.adhocRecipients}
                                        onAdhocRecipientsChange={(recipients) => setFormData(prev => ({ ...prev, adhocRecipients: recipients }))}
                                    />
                                )}
                            </ScrollArea>
                        </div>

                        {/* Right Column: Preview - 3/5 = 60% */}
                        <div className="md:col-span-3 h-full order-1 md:order-2">
                            <AudienceEstimator
                                mode={effectiveAudienceMode}
                                filters={formData.filters}
                                segmentId={isWinbackObjective ? '' : formData.selectedSegmentId}
                                userIds={isWinbackObjective ? [] : formData.selectedUserIds}
                                adhocRecipients={isWinbackObjective ? [] : formData.adhocRecipients}
                                onCountChange={(count) => setEstimatedRecipients(count)}
                                overrides={{
                                    include_ids: formData.overrideIncludeIds,
                                    exclude_ids: formData.overrideExcludeIds
                                }}
                                onOverrideChange={(action, id) => {
                                    if (action === 'exclude') {
                                        setFormData(prev => ({
                                            ...prev,
                                            overrideExcludeIds: [...prev.overrideExcludeIds, id],
                                            overrideIncludeIds: prev.overrideIncludeIds.filter(i => i !== id)
                                        }));
                                    } else if (action === 'include') {
                                        setFormData(prev => ({
                                            ...prev,
                                            overrideIncludeIds: [...prev.overrideIncludeIds, id],
                                            overrideExcludeIds: prev.overrideExcludeIds.filter(i => i !== id)
                                        }));
                                    }
                                }}
                            />
                        </div>
                    </div>
                )}

                {/* Step 3: Message */}
                {step === 3 && (
                    <div className="grid md:grid-cols-2 gap-8 h-[500px]">
                        <div className="flex flex-col gap-4 h-full overflow-hidden">
                            <div className="space-y-4">
                                {isDailyReportingObjective ? (
                                    <>
                                        <div className="rounded-xl border bg-slate-50/70 p-4 space-y-3">
                                            <div>
                                                <Label>Default Daily Reporting Template</Label>
                                                <p className="mt-1 text-sm text-muted-foreground">
                                                    This objective uses the fixed management reporting format and generates fresh values at send time.
                                                </p>
                                            </div>
                                            <Textarea
                                                className="min-h-[170px] resize-none font-mono text-sm bg-white"
                                                value={formData.message}
                                                readOnly
                                            />
                                        </div>

                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="rounded-lg border bg-white p-3">
                                                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Report Type</div>
                                                <div className="mt-1 text-sm font-semibold text-foreground">{formData.reportingType === 'weekly' ? 'Weekly' : 'Daily'}</div>
                                            </div>
                                            <div className="rounded-lg border bg-white p-3">
                                                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reply Action</div>
                                                <div className="mt-1 text-sm font-semibold text-foreground">{formData.enableReplyAction ? 'Enabled' : 'Disabled'}</div>
                                            </div>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        {isWinbackObjective && winbackTemplateSuggestions.length > 0 && (
                                            <div className="space-y-2">
                                                <Label>Suggested Winback Starters</Label>
                                                <div className="grid gap-2">
                                                    {winbackTemplateSuggestions.slice(0, 3).map((preset) => (
                                                        <button
                                                            key={preset.id}
                                                            type="button"
                                                            className="rounded-lg border bg-muted/30 p-3 text-left transition-colors hover:bg-muted"
                                                            onClick={() => setFormData(prev => ({
                                                                ...prev,
                                                                templateId: '',
                                                                message: preset.message,
                                                            }))}
                                                        >
                                                            <div className="flex items-center justify-between gap-3">
                                                                <span className="font-medium text-sm">{preset.title}</span>
                                                                <Badge variant="outline">{preset.status === 'active' ? 'Active' : 'Inactive'}</Badge>
                                                            </div>
                                                            <p className="mt-1 text-xs text-muted-foreground">{preset.description}</p>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        <div className="space-y-2">
                                            <Label>Template Language</Label>
                                            <Select value={selectedLanguage} onValueChange={(value: 'EN' | 'BM') => setSelectedLanguage(value)}>
                                                <SelectTrigger className="w-[140px]"><SelectValue placeholder="Language" /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="EN">EN</SelectItem>
                                                    <SelectItem value="BM">BM</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Template Category</Label>
                                            <div className="flex flex-wrap gap-2 pb-2">
                                                {['All Categories', 'Engagement', 'Informational', 'Loyalty', 'Promotional', 'Reactivation', 'Seasonal', 'VIP', 'General'].map((cat) => {
                                                    const count = cat === 'All Categories'
                                                        ? templatesByLanguage.length
                                                        : templatesByLanguage.filter(t => (t.category || 'General') === cat).length;
                                                    return (
                                                        <Badge
                                                            key={cat}
                                                            variant={selectedCategory === cat ? "default" : "outline"}
                                                            className={`cursor-pointer px-3 py-1 font-normal transition-colors ${selectedCategory === cat ? '' : 'hover:bg-muted'
                                                                } ${getCategoryBadgeColor(cat)}`}
                                                            onClick={() => {
                                                                setSelectedCategory(cat);
                                                            }}
                                                        >
                                                            {cat}
                                                            {cat !== 'All Categories' && (
                                                                <span className="ml-1 text-[10px] opacity-70">
                                                                    ({count})
                                                                </span>
                                                            )}
                                                        </Badge>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <Label>Template</Label>
                                            <Select
                                                value={formData.templateId}
                                                onValueChange={(val) => {
                                                    if (val === 'scratch') {
                                                        setFormData({
                                                            ...formData,
                                                            templateId: '',
                                                            message: ''
                                                        });
                                                    } else {
                                                        const tmpl = templates.find(t => t.id === val);
                                                        setFormData({
                                                            ...formData,
                                                            templateId: val,
                                                            message: tmpl?.body || formData.message
                                                        });
                                                    }
                                                }}
                                            >
                                                <SelectTrigger><SelectValue placeholder="Choose a template..." /></SelectTrigger>
                                                <SelectContent className="max-h-[300px]">
                                                    <SelectItem value="scratch">
                                                        <span className="flex items-center gap-2">
                                                            <span className="text-muted-foreground">✏️</span>
                                                            Start from Scratch
                                                        </span>
                                                    </SelectItem>
                                                    {selectedCategory === 'All Categories' ? (
                                                        // Group templates by category when showing all
                                                        Object.entries(
                                                            templatesByLanguage.reduce<Record<string, typeof templatesByLanguage>>((acc, t) => {
                                                                const cat = t.category || 'General';
                                                                if (!acc[cat]) acc[cat] = [];
                                                                acc[cat].push(t);
                                                                return acc;
                                                            }, {})
                                                        ).sort(([a], [b]) => a.localeCompare(b)).map(([category, categoryTemplates]) => (
                                                            <div key={category}>
                                                                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/50 sticky top-0">
                                                                    {category} ({categoryTemplates.length})
                                                                </div>
                                                                {categoryTemplates.map(t => (
                                                                    <SelectItem key={t.id} value={t.id}>
                                                                        <span className="flex items-center gap-2">
                                                                            {t.name}
                                                                            {t.is_system && <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4">System</Badge>}
                                                                        </span>
                                                                    </SelectItem>
                                                                ))}
                                                            </div>
                                                        ))
                                                    ) : (
                                                        // Show templates for selected category
                                                        templatesByLanguage
                                                            .filter(t => (t.category || 'General') === selectedCategory)
                                                            .map(t => (
                                                                <SelectItem key={t.id} value={t.id}>
                                                                    <span className="flex items-center gap-2">
                                                                        {t.name}
                                                                        {t.is_system && <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4">System</Badge>}
                                                                    </span>
                                                                </SelectItem>
                                                            ))
                                                    )}
                                                </SelectContent>
                                            </Select>
                                        </div>

                                    </>
                                )}
                            </div>
                            <div className="flex-1 flex flex-col gap-2 min-h-0">
                                <div className="flex items-center justify-between">
                                    <Label>{isDailyReportingObjective ? 'Generated Message' : 'Message Body'}</Label>
                                    {!isDailyReportingObjective && (
                                        <button
                                            type="button"
                                            className="text-xs text-blue-600 hover:underline"
                                            onClick={() => {
                                                const params = new URLSearchParams(searchParams.toString());
                                                params.set('tab', 'message-setup');
                                                router.push(`?${params.toString()}`);
                                            }}
                                        >
                                            Manage Message Setup →
                                        </button>
                                    )}
                                </div>
                                <Textarea
                                    className="flex-1 resize-none font-mono text-sm"
                                    placeholder="Type your message here..."
                                    value={isDailyReportingObjective ? (dailyReportingPreview?.message || formData.message) : formData.message}
                                    onChange={e => setFormData({ ...formData, message: e.target.value })}
                                    readOnly={isDailyReportingObjective}
                                />
                            </div>
                            {!isDailyReportingObjective && (
                                <div className="flex gap-2 flex-wrap">
                                    {['{name}', '{city}', '{points_balance}', '{short_link}'].map(v => (
                                        <Button key={v} variant="secondary" size="sm" className="h-6 px-2 text-xs" onClick={() => insertVariable(v)}>{v}</Button>
                                    ))}
                                </div>
                            )}
                            <Button variant="outline" onClick={handleTestSend} disabled={testing}>
                                {testing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
                                Send Test Message
                            </Button>
                        </div>

                        {/* Preview */}
                        <div className="bg-gray-100 rounded-xl p-4 flex justify-center items-center">
                            <div className="bg-white rounded-lg shadow-lg w-[300px] overflow-hidden border">
                                <div className="bg-[#075e54] text-white p-3 text-sm font-medium flex items-center gap-2">
                                    <div className="w-8 h-8 bg-gray-300 rounded-full"></div>
                                    Serapod2u
                                </div>
                                <div className="bg-[#e5ddd5] h-[350px] p-4 flex flex-col gap-2 overflow-y-auto bg-opacity-30">
                                    <div className="bg-white p-2 rounded-lg rounded-tl-none shadow-sm text-sm self-start max-w-[90%] whitespace-pre-wrap">
                                        {loadingDailyReportingPreview && isDailyReportingObjective ? (
                                            <span className="inline-flex items-center gap-2 text-gray-400 italic"><Loader2 className="h-4 w-4 animate-spin" /> Building report preview...</span>
                                        ) : (
                                            (isDailyReportingObjective ? dailyReportingPreview?.message : formData.message) || <span className="text-gray-400 italic">Message preview...</span>
                                        )}
                                        <div className="text-[10px] text-gray-400 text-right mt-1">{format(new Date(), 'HH:mm')}</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Step 4: Review */}
                {step === 4 && (
                    <div className="space-y-6">
                        <div className="grid md:grid-cols-2 gap-6">
                            <div className="space-y-4">
                                <div className="p-4 bg-gray-50 rounded-lg space-y-3">
                                    <h4 className="font-medium text-sm text-gray-900 border-b pb-2">Campaign Summary</h4>
                                    <div className="flex justify-between text-sm">
                                        <span className="text-gray-500">Name</span>
                                        <span className="font-medium">{formData.name}</span>
                                    </div>
                                    <div className="flex justify-between text-sm">
                                        <span className="text-gray-500">Recipients</span>
                                        <span className="font-medium">{estimatedRecipients.toLocaleString()}</span>
                                    </div>
                                    {!isWinbackObjective && effectiveAudienceMode === 'specific_users' && (
                                        <>
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-500">Existing CRM Users</span>
                                                <span className="font-medium">{formData.selectedUserIds.length}</span>
                                            </div>
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-500">Ad-hoc Imported</span>
                                                <span className="font-medium">{adhocSummary.total}</span>
                                            </div>
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-500">Ad-hoc Eligible</span>
                                                <span className="font-medium">{adhocSummary.eligible}</span>
                                            </div>
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-500">Ad-hoc Excluded</span>
                                                <span className="font-medium">{adhocSummary.excluded}</span>
                                            </div>
                                        </>
                                    )}
                                    <div className="flex justify-between text-sm">
                                        <span className="text-gray-500">Objective</span>
                                        <Badge variant="outline">{formData.objective}</Badge>
                                    </div>
                                    {isDailyReportingObjective && (
                                        <>
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-500">Report Type</span>
                                                <span className="font-medium capitalize">{formData.reportingType}</span>
                                            </div>
                                            <div className="flex justify-between text-sm">
                                                <span className="text-gray-500">Reply Action</span>
                                                <span className="font-medium">{formData.enableReplyAction ? 'Enabled' : 'Disabled'}</span>
                                            </div>
                                        </>
                                    )}
                                </div>

                                {/* Safety Advisor - Shows recommended preset and estimated runtime */}
                                {estimatedRecipients > 0 && (
                                    <CampaignSafetyAdvisor
                                        recipientCount={estimatedRecipients}
                                        health={numberHealth}
                                        compact={true}
                                    />
                                )}

                                {/* Template Safety Badge */}
                                {messageSafety && (
                                    <div className={`p-4 rounded-lg border ${messageSafety.riskScore >= 80
                                        ? 'bg-red-50 border-red-200'
                                        : messageSafety.riskScore >= 50
                                            ? 'bg-amber-50 border-amber-200'
                                            : 'bg-green-50 border-green-200'
                                        }`}>
                                        <div className="flex items-center gap-2 mb-2">
                                            {messageSafety.riskScore >= 80 ? (
                                                <ShieldX className="w-5 h-5 text-red-500" />
                                            ) : messageSafety.riskScore >= 50 ? (
                                                <ShieldAlert className="w-5 h-5 text-amber-500" />
                                            ) : (
                                                <ShieldCheck className="w-5 h-5 text-green-500" />
                                            )}
                                            <h4 className="font-medium text-sm">
                                                Message Safety: {getRiskBadgeLabel(getRiskLevel(messageSafety.riskScore))}
                                            </h4>
                                            <Badge
                                                variant="outline"
                                                className={`ml-auto ${getRiskBadgeColor(getRiskLevel(messageSafety.riskScore))}`}
                                            >
                                                Score: {messageSafety.riskScore}
                                            </Badge>
                                        </div>

                                        {messageSafety.riskScore >= 80 && (
                                            <p className="text-xs text-red-700 mb-2">
                                                ⛔ This message cannot be sent due to critical safety issues.
                                            </p>
                                        )}

                                        {messageSafety.errors.length > 0 && (
                                            <div className="space-y-1 mb-2">
                                                {messageSafety.errors.map((e, i) => (
                                                    <p key={i} className="text-xs text-red-600">❌ {e.message}</p>
                                                ))}
                                            </div>
                                        )}

                                        {messageSafety.warnings.length > 0 && messageSafety.riskScore < 80 && (
                                            <div className="space-y-1">
                                                {messageSafety.warnings.map((w, i) => (
                                                    <p key={i} className="text-xs text-amber-700">⚠️ {w.message}</p>
                                                ))}
                                            </div>
                                        )}

                                        {/* Acknowledge checkbox for medium risk */}
                                        {messageSafety.riskScore >= 50 && messageSafety.riskScore < 80 && (
                                            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-amber-200">
                                                <Checkbox
                                                    id="acknowledge-risk"
                                                    checked={acknowledgeRisk}
                                                    onCheckedChange={(checked) => setAcknowledgeRisk(checked === true)}
                                                />
                                                <label htmlFor="acknowledge-risk" className="text-xs text-amber-800 cursor-pointer">
                                                    I understand the risks and want to proceed with this campaign
                                                </label>
                                            </div>
                                        )}
                                    </div>
                                )}

                                <div className="p-4 bg-yellow-50 rounded-lg border border-yellow-100">
                                    <div className="flex items-center gap-2 mb-2">
                                        <AlertTriangle className={`w-4 h-4 ${riskLevel === 'High' ? 'text-red-500' : 'text-yellow-500'}`} />
                                        <h4 className="font-medium text-sm">Audience Size: {riskLevel}</h4>
                                    </div>
                                    <p className="text-xs text-yellow-700">
                                        {riskLevel === 'High'
                                            ? 'Large audience size. Sending may take several hours due to throttling.'
                                            : 'Standard campaign load. Expected delivery within 1 hour.'}
                                    </p>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <h4 className="font-medium">Schedule</h4>
                                <div className="flex gap-4">
                                    <Button
                                        variant={formData.scheduleType === 'now' ? 'default' : 'outline'}
                                        onClick={() => setFormData({ ...formData, scheduleType: 'now' })}
                                        className="flex-1"
                                    >
                                        <Send className="w-4 h-4 mr-2" /> Send Now
                                    </Button>
                                    <Popover>
                                        <PopoverTrigger asChild>
                                            <Button
                                                variant={formData.scheduleType === 'schedule' ? 'default' : 'outline'}
                                                onClick={() => setFormData({ ...formData, scheduleType: 'schedule' })}
                                                className="flex-1"
                                            >
                                                <CalendarIcon className="w-4 h-4 mr-2" /> Schedule
                                            </Button>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-auto p-0">
                                            <Calendar
                                                mode="single"
                                                selected={formData.scheduledDate}
                                                onSelect={(d) => setFormData({ ...formData, scheduledDate: d, scheduleType: 'schedule' })}
                                                initialFocus
                                            />
                                        </PopoverContent>
                                    </Popover>
                                </div>
                                {formData.scheduleType === 'schedule' && formData.scheduledDate && (
                                    <p className="text-sm text-center text-primary font-medium">
                                        Scheduled for {format(formData.scheduledDate, 'PPP')}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </CardContent>
            {/* Sticky bottom action bar - always visible */}
            <div className="sticky bottom-0 p-6 border-t bg-gray-50 flex justify-between rounded-b-lg shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
                <Button variant="outline" onClick={step === 1 ? onCancel : handleBack}>
                    {step === 1 ? 'Cancel' : 'Back'}
                </Button>
                {step < 4 ? (
                    <Button onClick={handleNext} size="lg" className="px-6 shadow-sm" disabled={step === 2 && estimatedRecipients < 1}>
                        Next Step <ChevronRight className="w-4 h-4 ml-2" />
                    </Button>
                ) : (
                    <Button
                        onClick={handleLaunch}
                        disabled={submitting || (messageSafety?.riskScore ?? 0) >= 80 || ((messageSafety?.riskScore ?? 0) >= 50 && !acknowledgeRisk)}
                        size="lg"
                        className="px-6 shadow-sm"
                    >
                        {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
                        {(messageSafety?.riskScore ?? 0) >= 80 ? 'Blocked' : 'Launch Campaign'}
                    </Button>
                )}
            </div>

            {/* Pre-Launch Safety Analysis Modal */}
            <PrelaunchAnalysisModal
                open={showPrelaunchModal}
                onOpenChange={setShowPrelaunchModal}
                campaignName={formData.name}
                recipientCount={estimatedRecipients}
                objective={formData.objective}
                numberHealth={numberHealth}
                messageSafety={messageSafety}
                quietHoursEnabled={formData.quietHours}
                onConfirm={handleConfirmLaunch}
                onCancel={() => setShowPrelaunchModal(false)}
            />
        </Card>
    );
}
