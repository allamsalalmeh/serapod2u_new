'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '@/components/ui/dialog'
import {
    Tooltip, TooltipContent, TooltipProvider, TooltipTrigger
} from '@/components/ui/tooltip'
import { useToast } from '@/components/ui/use-toast'
import { usePermissions } from '@/hooks/usePermissions'
import {
    AttendanceEntry, AttendancePolicy, AttendanceShift,
    clockAttendance, createAttendanceShift, createCorrectionRequest,
    deleteAttendanceShift, fetchAttendanceEntries, fetchAttendancePolicy,
    fetchAttendanceShifts, updateAttendancePolicy, updateAttendanceShift
} from '@/lib/api/attendance'
import {
    AlertTriangle, CalendarClock, Clock3, HelpCircle,
    Pencil, Plus, Timer, Trash2
} from 'lucide-react'
import OvertimeRulesCard from './OvertimeRulesCard'
import HrAttendanceOperationsView, { OPERATIONS_TABS, type OperationsTab } from './HrAttendanceOperationsView'

/** Top-level sections of the HR attendance workspace. `?tab=` may name a section or one of the operations tabs. */
export type AttendanceSection = 'operations' | 'setup' | 'my'
export function resolveAttendanceTab(tab: string | null | undefined): { section: AttendanceSection; operations: OperationsTab } {
    if (tab === 'setup' || tab === 'my') return { section: tab, operations: 'board' }
    if (tab && (OPERATIONS_TABS as readonly string[]).includes(tab)) return { section: 'operations', operations: tab as OperationsTab }
    return { section: 'operations', operations: 'board' }
}

interface HrAttendanceClockViewProps {
    userProfile: {
        id: string
        role_code: string
        roles: { role_level: number }
        department_id?: string | null
        organizations: { id: string }
    }
}

const DEFAULT_POLICY: AttendancePolicy = {
    id: '', organization_id: '',
    workdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
    grace_minutes: 10, timezone: 'Asia/Kuala_Lumpur', require_shift: false,
    allow_clock_out_without_clock_in: false, max_open_entry_hours: 16,
    late_after_minutes: 15, early_leave_before_minutes: 15,
    overtime_policy_json: { enabled: false, autoApprove: false, maxDailyMinutes: 120, rate: 1.5 }
}

const flagBadge = (flag: string) => {
    const map: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
        ontime: { label: 'On Time', variant: 'default' },
        late: { label: 'Late', variant: 'destructive' },
        early_leave: { label: 'Early Leave', variant: 'destructive' },
        late_and_early: { label: 'Late + Early', variant: 'destructive' },
        absent: { label: 'Absent', variant: 'outline' }
    }
    const item = map[flag] || { label: flag, variant: 'secondary' as const }
    return <Badge variant={item.variant}>{item.label}</Badge>
}

export default function HrAttendanceClockView({ userProfile }: HrAttendanceClockViewProps) {
    const { hasPermission } = usePermissions(userProfile.roles.role_level, userProfile.role_code, userProfile.department_id)
    const canManage = userProfile.roles.role_level <= 20 || hasPermission('manage_org_chart') || hasPermission('edit_org_settings')
    const { toast } = useToast()
    const searchParams = useSearchParams()
    const initial = resolveAttendanceTab(searchParams?.get('tab'))
    const [section, setSection] = useState<AttendanceSection>(initial.section)
    useEffect(() => { setSection(resolveAttendanceTab(searchParams?.get('tab')).section) }, [searchParams])

    const [policy, setPolicy] = useState<AttendancePolicy>(DEFAULT_POLICY)
    const [shifts, setShifts] = useState<AttendanceShift[]>([])
    const [entries, setEntries] = useState<AttendanceEntry[]>([])
    const [loading, setLoading] = useState(true)
    const [actionLoading, setActionLoading] = useState(false)
    const [selectedShift, setSelectedShift] = useState<string>('none')

    const [shiftDialogOpen, setShiftDialogOpen] = useState(false)
    const [shiftForm, setShiftForm] = useState({ name: '', start_time: '09:00', end_time: '18:00', break_minutes: 60, grace_override_minutes: '', allow_cross_midnight: false })
    const [shiftTemplateDialogOpen, setShiftTemplateDialogOpen] = useState(false)

    const [correctionDialogOpen, setCorrectionDialogOpen] = useState(false)
    const [correctionEntry, setCorrectionEntry] = useState<AttendanceEntry | null>(null)
    const [correctionForm, setCorrectionForm] = useState({ reason: '', corrected_clock_in: '', corrected_clock_out: '' })

    const loadData = async () => {
        setLoading(true)
        const [p, s, e] = await Promise.all([fetchAttendancePolicy(), fetchAttendanceShifts(), fetchAttendanceEntries({})])
        if (p.success && p.data) setPolicy(p.data)
        if (s.success && s.data) setShifts(s.data)
        if (e.success && e.data) setEntries(e.data)
        setLoading(false)
    }

    useEffect(() => { loadData() }, []) // eslint-disable-line react-hooks/exhaustive-deps

    const openEntry = useMemo(() => entries.find(e => !e.clock_out_at) || null, [entries])
    const recentEntries = useMemo(() => entries.slice(0, 5), [entries])

    const currentStatus = useMemo(() => {
        if (!openEntry) return { text: 'Off duty', sub: 'Ready to clock in', color: 'text-gray-600' }
        const flag = openEntry.attendance_flag || 'ontime'
        if (flag === 'late') return { text: 'On duty (Late)', sub: `Since ${new Date(openEntry.clock_in_at).toLocaleTimeString()}`, color: 'text-yellow-600' }
        if (openEntry.overtime_minutes > 0) return { text: 'Overtime', sub: `OT: ${openEntry.overtime_minutes}m`, color: 'text-blue-600' }
        return { text: 'On duty', sub: `Since ${new Date(openEntry.clock_in_at).toLocaleTimeString()}`, color: 'text-green-600' }
    }, [openEntry])

    const exceptions = useMemo(() => {
        const issues: string[] = []
        if (openEntry) {
            const openHours = (Date.now() - new Date(openEntry.clock_in_at).getTime()) / 3600000
            if (openHours > (policy.max_open_entry_hours || 16)) issues.push(`Open entry for ${Math.round(openHours)}h — possible forgotten clock-out`)
        }
        return issues
    }, [openEntry, policy.max_open_entry_hours])

    const handleClock = async (action: 'clock_in' | 'clock_out') => {
        setActionLoading(true)
        const result = await clockAttendance(action, selectedShift === 'none' ? null : selectedShift)
        if (result.success) { toast({ title: action === 'clock_in' ? 'Clocked in' : 'Clocked out', description: 'Recorded with the server time.' }); loadData() }
        else toast({ title: 'Not recorded', description: result.error || 'The attendance could not be recorded.', variant: 'destructive' })
        setActionLoading(false)
    }

    const handleForgotClockOut = () => {
        if (!openEntry) return
        setCorrectionEntry(openEntry)
        setCorrectionForm({ reason: 'Forgot to clock out', corrected_clock_in: '', corrected_clock_out: '' })
        setCorrectionDialogOpen(true)
    }

    const handleSubmitCorrection = async () => {
        if (!correctionEntry) return
        setActionLoading(true)
        const result = await createCorrectionRequest({
            entry_id: correctionEntry.id, reason: correctionForm.reason,
            corrected_clock_in: correctionForm.corrected_clock_in || null,
            corrected_clock_out: correctionForm.corrected_clock_out || null
        })
        if (result.success) { toast({ title: 'Correction requested', description: 'Another authorized person (HR) reviews it; your original record is kept.' }); setCorrectionDialogOpen(false); loadData() }
        else toast({ title: 'Correction not submitted', description: result.error || 'The correction could not be submitted.', variant: 'destructive' })
        setActionLoading(false)
    }

    const handleSavePolicy = async () => {
        setActionLoading(true)
        const result = await updateAttendancePolicy({
            workdays: policy.workdays, grace_minutes: policy.grace_minutes, timezone: policy.timezone,
            require_shift: policy.require_shift, allow_clock_out_without_clock_in: policy.allow_clock_out_without_clock_in,
            max_open_entry_hours: policy.max_open_entry_hours, late_after_minutes: policy.late_after_minutes,
            early_leave_before_minutes: policy.early_leave_before_minutes, overtime_policy_json: policy.overtime_policy_json
        } as any)
        if (result.success && result.data) { setPolicy(result.data); toast({ title: 'Policy updated' }) }
        else toast({ title: 'Error', description: result.error || 'Failed', variant: 'destructive' })
        setActionLoading(false)
    }

    const handleAddShift = async () => {
        if (!shiftForm.name.trim()) { toast({ title: 'Validation', description: 'Shift name is required', variant: 'destructive' }); return }
        setActionLoading(true)
        const result = await createAttendanceShift({
            name: shiftForm.name, start_time: shiftForm.start_time, end_time: shiftForm.end_time,
            break_minutes: shiftForm.break_minutes, grace_override_minutes: shiftForm.grace_override_minutes ? Number(shiftForm.grace_override_minutes) : null,
            allow_cross_midnight: shiftForm.allow_cross_midnight
        } as any)
        if (result.success) { toast({ title: 'Shift added' }); setShiftDialogOpen(false); setShiftForm({ name: '', start_time: '09:00', end_time: '18:00', break_minutes: 60, grace_override_minutes: '', allow_cross_midnight: false }); loadData() }
        else toast({ title: 'Error', description: result.error || 'Failed', variant: 'destructive' })
        setActionLoading(false)
    }

    const handleToggleShift = async (shift: AttendanceShift) => {
        setActionLoading(true)
        const result = await updateAttendanceShift(shift.id, { is_active: !shift.is_active })
        if (result.success) loadData(); else toast({ title: 'Error', description: result.error || 'Failed', variant: 'destructive' })
        setActionLoading(false)
    }

    const handleDeleteShift = async (shift: AttendanceShift) => {
        setActionLoading(true)
        const result = await deleteAttendanceShift(shift.id)
        if (result.success) { toast({ title: 'Deleted' }); loadData() }
        else toast({ title: 'Error', description: result.error || 'Failed', variant: 'destructive' })
        setActionLoading(false)
    }

    // ─── Shift Templates (common Malaysian patterns) ──────────────
    const SHIFT_TEMPLATES = [
        { name: 'Morning Shift', start_time: '08:00', end_time: '17:00', break_minutes: 60, allow_cross_midnight: false, desc: '8 AM – 5 PM (standard office)' },
        { name: 'Office 9-6', start_time: '09:00', end_time: '18:00', break_minutes: 60, allow_cross_midnight: false, desc: '9 AM – 6 PM (common KL hours)' },
        { name: 'Afternoon Shift', start_time: '14:00', end_time: '22:00', break_minutes: 60, allow_cross_midnight: false, desc: '2 PM – 10 PM' },
        { name: 'Night Shift', start_time: '22:00', end_time: '06:00', break_minutes: 60, allow_cross_midnight: true, desc: '10 PM – 6 AM (cross midnight)' },
        { name: 'Retail / Mall', start_time: '10:00', end_time: '22:00', break_minutes: 90, allow_cross_midnight: false, desc: '10 AM – 10 PM (12h retail)' },
        { name: 'Half Day (AM)', start_time: '08:00', end_time: '13:00', break_minutes: 0, allow_cross_midnight: false, desc: '8 AM – 1 PM (no break)' },
        { name: 'Factory 3-Shift (A)', start_time: '06:00', end_time: '14:00', break_minutes: 30, allow_cross_midnight: false, desc: '6 AM – 2 PM (manufacturing)' },
        { name: 'Factory 3-Shift (B)', start_time: '14:00', end_time: '22:00', break_minutes: 30, allow_cross_midnight: false, desc: '2 PM – 10 PM (manufacturing)' },
        { name: 'Factory 3-Shift (C)', start_time: '22:00', end_time: '06:00', break_minutes: 30, allow_cross_midnight: true, desc: '10 PM – 6 AM (manufacturing)' },
        { name: 'Flexi Hours', start_time: '07:00', end_time: '19:00', break_minutes: 60, allow_cross_midnight: false, desc: '7 AM – 7 PM (flexible 8h within)' },
    ]

    const handleLoadShiftTemplate = async (tpl: typeof SHIFT_TEMPLATES[0]) => {
        setActionLoading(true)
        const result = await createAttendanceShift({
            name: tpl.name, start_time: tpl.start_time, end_time: tpl.end_time,
            break_minutes: tpl.break_minutes, grace_override_minutes: null,
            allow_cross_midnight: tpl.allow_cross_midnight
        } as any)
        if (result.success) { toast({ title: `Shift "${tpl.name}" added` }); loadData() }
        else toast({ title: 'Error', description: result.error || 'Failed', variant: 'destructive' })
        setActionLoading(false)
    }

    return (
        <TooltipProvider>
            <div className="space-y-6">
                <div>
                    <h1 className="text-lg font-semibold tracking-tight">Attendance Operations</h1>
                    <p className="text-sm text-muted-foreground mt-1">
                        Review and correct attendance, import records and decide overtime. Employees clock in and out from{' '}
                        <Link href="/hr/mobile/attendance" className="underline underline-offset-2">My Attendance</Link>.
                    </p>
                </div>
                <Tabs value={section} onValueChange={(v) => setSection(v as AttendanceSection)}>
                    <TabsList className="flex flex-wrap h-auto">
                        <TabsTrigger value="operations">Operations</TabsTrigger>
                        <TabsTrigger value="setup">Policy &amp; shifts</TabsTrigger>
                        <TabsTrigger value="my">My clock-in</TabsTrigger>
                    </TabsList>

                {/* Wave 3: HR operations (daily board, exceptions, corrections, manual entry, Excel import, overtime,
                    report). The page is gated by hr.attendance.manage; every action is decided again by the database. */}
                <TabsContent value="operations" className="space-y-6">
                    <HrAttendanceOperationsView initialTab={initial.operations} />
                </TabsContent>

                <TabsContent value="my" className="space-y-6">
                {exceptions.length > 0 && (
                    <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 flex items-start gap-3">
                        <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
                        <div>
                            <div className="font-medium text-yellow-800">Attention Required</div>
                            {exceptions.map((e, i) => <div key={i} className="text-sm text-yellow-700">{e}</div>)}
                            <Button size="sm" variant="outline" className="mt-2" onClick={handleForgotClockOut}>
                                <Pencil className="h-3 w-3 mr-1" /> I forgot to clock out
                            </Button>
                        </div>
                    </div>
                )}

                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between">
                            <div><CardTitle className="text-lg">Clock In / Out</CardTitle><CardDescription>Track daily attendance and shifts.</CardDescription></div>
                            <Badge variant={openEntry ? 'default' : 'secondary'}>{openEntry ? 'Clocked In' : 'Clocked Out'}</Badge>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {loading ? <div className="py-8 text-center text-gray-500">Loading attendance status...</div> : (
                            <>
                                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                                    <div className="rounded-lg border p-4">
                                        <div className="flex items-center gap-2 text-sm text-gray-600"><Clock3 className="h-4 w-4" />Current Status</div>
                                        <div className={`mt-2 text-2xl font-semibold ${currentStatus.color}`}>{currentStatus.text}</div>
                                        <div className="text-xs text-gray-500">{currentStatus.sub}</div>
                                    </div>
                                    <div className="rounded-lg border p-4">
                                        <div className="flex items-center gap-2 text-sm text-gray-600"><Timer className="h-4 w-4" />Workdays</div>
                                        <div className="mt-2 text-sm font-medium">{policy.workdays.join(', ')}</div>
                                        <div className="text-xs text-gray-500">Grace: {policy.grace_minutes} mins</div>
                                    </div>
                                    <div className="rounded-lg border p-4">
                                        <div className="flex items-center gap-2 text-sm text-gray-600"><CalendarClock className="h-4 w-4" />Shift</div>
                                        <Select value={selectedShift} onValueChange={setSelectedShift}>
                                            <SelectTrigger className="mt-2"><SelectValue placeholder="Select shift" /></SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">No shift</SelectItem>
                                                {shifts.filter(s => s.is_active).map(shift => (
                                                    <SelectItem key={shift.id} value={shift.id}>{shift.name} ({shift.start_time} - {shift.end_time})</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                                <div className="flex flex-wrap gap-3">
                                    <Button onClick={() => handleClock('clock_in')} disabled={actionLoading || !!openEntry || (policy.require_shift && selectedShift === 'none')}>Clock In</Button>
                                    <Button variant="outline" onClick={() => handleClock('clock_out')} disabled={actionLoading || !openEntry}>Clock Out</Button>
                                    {openEntry && <Button variant="ghost" size="sm" onClick={handleForgotClockOut}><Pencil className="h-4 w-4 mr-1" />Request Correction</Button>}
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>

                    <Card>
                        <CardHeader><CardTitle className="text-base">My recent activity</CardTitle><CardDescription>Your last 5 clock events. Corrections and overtime: My Attendance.</CardDescription></CardHeader>
                        <CardContent className="space-y-3">
                            {recentEntries.length === 0 ? <div className="text-sm text-gray-500">No activity yet.</div> : recentEntries.map(entry => (
                                <div key={entry.id} className="flex items-center justify-between rounded-lg border p-3">
                                    <div>
                                        <div className="text-sm font-medium">{new Date(entry.clock_in_at).toLocaleDateString()} • {new Date(entry.clock_in_at).toLocaleTimeString()}</div>
                                        <div className="text-xs text-gray-500">
                                            {entry.clock_out_at ? `Out ${new Date(entry.clock_out_at).toLocaleTimeString()} • ${entry.worked_minutes || 0}m` : 'In progress'}
                                            {entry.overtime_minutes > 0 && ` • OT ${entry.overtime_minutes}m`}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {flagBadge(entry.attendance_flag || 'ontime')}
                                        {entry.status === 'adjusted' && <Badge variant="outline">Adjusted</Badge>}
                                        {!entry.clock_out_at && (
                                            <Button variant="ghost" size="sm" onClick={() => { setCorrectionEntry(entry); setCorrectionForm({ reason: '', corrected_clock_in: '', corrected_clock_out: '' }); setCorrectionDialogOpen(true) }}>
                                                <Pencil className="h-3 w-3" />
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="setup" className="space-y-6">
                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <div><CardTitle className="text-base">Attendance Policy</CardTitle><CardDescription>Workdays, grace period, and shift requirement.</CardDescription></div>
                                    <Tooltip><TooltipTrigger asChild><HelpCircle className="h-4 w-4 text-gray-400" /></TooltipTrigger>
                                        <TooltipContent className="max-w-xs"><p className="text-xs">Grace period: minutes after shift start before marking late. Late after: threshold for late flag. Early leave: threshold before shift end.</p></TooltipContent>
                                    </Tooltip>
                                </div>
                                {canManage && <Button variant="outline" size="sm" onClick={handleSavePolicy} disabled={actionLoading}>Save Policy</Button>}
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>Workdays</Label>
                                <div className="flex flex-wrap gap-2">
                                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => (
                                        <label key={day} className="flex items-center gap-2 text-sm">
                                            <input type="checkbox" checked={policy.workdays.includes(day)} disabled={!canManage}
                                                onChange={(e) => { const n = new Set(policy.workdays); e.target.checked ? n.add(day) : n.delete(day); setPolicy(p => ({ ...p, workdays: Array.from(n) })) }} />{day}
                                        </label>
                                    ))}
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2"><Label>Grace minutes</Label><Input type="number" value={policy.grace_minutes} onChange={e => setPolicy(p => ({ ...p, grace_minutes: Number(e.target.value) }))} disabled={!canManage} /></div>
                                <div className="space-y-2"><Label>Timezone</Label><Input value={policy.timezone} onChange={e => setPolicy(p => ({ ...p, timezone: e.target.value }))} disabled={!canManage} /></div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <div className="flex items-center gap-1"><Label>Late after (min)</Label><Tooltip><TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-gray-400" /></TooltipTrigger><TooltipContent><p className="text-xs">Minutes after shift start + grace to mark late.</p></TooltipContent></Tooltip></div>
                                    <Input type="number" value={policy.late_after_minutes} onChange={e => setPolicy(p => ({ ...p, late_after_minutes: Number(e.target.value) }))} disabled={!canManage} />
                                </div>
                                <div className="space-y-2">
                                    <div className="flex items-center gap-1"><Label>Early leave (min)</Label><Tooltip><TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-gray-400" /></TooltipTrigger><TooltipContent><p className="text-xs">Minutes before shift end to mark early leave.</p></TooltipContent></Tooltip></div>
                                    <Input type="number" value={policy.early_leave_before_minutes} onChange={e => setPolicy(p => ({ ...p, early_leave_before_minutes: Number(e.target.value) }))} disabled={!canManage} />
                                </div>
                            </div>
                            <div className="flex items-center gap-2"><Switch checked={policy.require_shift} onCheckedChange={c => setPolicy(p => ({ ...p, require_shift: c }))} disabled={!canManage} /><span className="text-sm text-gray-600">Require shift selection</span></div>
                            <div className="flex items-center gap-2">
                                <Switch checked={policy.overtime_policy_json?.enabled || false} onCheckedChange={c => setPolicy(p => ({ ...p, overtime_policy_json: { ...p.overtime_policy_json, enabled: c } }))} disabled={!canManage} />
                                <span className="text-sm text-gray-600">Enable overtime tracking</span>
                                <Tooltip><TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-gray-400" /></TooltipTrigger><TooltipContent><p className="text-xs">Track hours beyond shift end as overtime.</p></TooltipContent></Tooltip>
                            </div>
                        </CardContent>
                    </Card>

                {/* Overtime Rules – always visible for configuration access */}
                <OvertimeRulesCard canManage={canManage} />

                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between">
                            <div><CardTitle className="text-base">Shifts</CardTitle><CardDescription>Optional shift templates for clock-in.</CardDescription></div>
                            {canManage && (
                                <div className="flex items-center gap-2">
                                    <Button variant="outline" size="sm" onClick={() => setShiftTemplateDialogOpen(true)}>Load Template</Button>
                                    <Button size="sm" onClick={() => setShiftDialogOpen(true)}><Plus className="h-4 w-4 mr-1" />Add Shift</Button>
                                </div>
                            )}
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {shifts.length === 0 ? (
                            <div className="text-sm text-gray-500 py-4 text-center">
                                <p>No shifts configured.</p>
                                <p className="text-xs mt-1 text-gray-400">Setup: Create policy → Add shifts → Staff can start clocking in.</p>
                            </div>
                        ) : shifts.map(shift => (
                            <div key={shift.id} className="flex items-center justify-between rounded-lg border p-3">
                                <div>
                                    <div className="font-medium text-sm">{shift.name}</div>
                                    <div className="text-xs text-gray-500">
                                        {shift.start_time} - {shift.end_time} • Break {shift.break_minutes}min
                                        {shift.allow_cross_midnight && ' • Night shift'}
                                        {shift.expected_work_minutes && ` • ${Math.round(shift.expected_work_minutes / 60)}h expected`}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Badge variant={shift.is_active ? 'default' : 'secondary'}>{shift.is_active ? 'Active' : 'Inactive'}</Badge>
                                    {canManage && <>
                                        <Button variant="ghost" size="sm" onClick={() => handleToggleShift(shift)}>{shift.is_active ? 'Disable' : 'Enable'}</Button>
                                        <Button variant="ghost" size="sm" onClick={() => handleDeleteShift(shift)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                                    </>}
                                </div>
                            </div>
                        ))}
                    </CardContent>
                </Card>
                </TabsContent>
                </Tabs>

                <Dialog open={shiftDialogOpen} onOpenChange={setShiftDialogOpen}>
                    <DialogContent className="sm:max-w-[500px]">
                        <DialogHeader><DialogTitle>Create Shift</DialogTitle><DialogDescription>Define shift hours and break minutes.</DialogDescription></DialogHeader>
                        <div className="space-y-3">
                            <div className="space-y-2"><Label>Name</Label><Input value={shiftForm.name} onChange={e => setShiftForm(p => ({ ...p, name: e.target.value }))} /></div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2"><Label>Start time</Label><Input type="time" value={shiftForm.start_time} onChange={e => setShiftForm(p => ({ ...p, start_time: e.target.value }))} /></div>
                                <div className="space-y-2"><Label>End time</Label><Input type="time" value={shiftForm.end_time} onChange={e => setShiftForm(p => ({ ...p, end_time: e.target.value }))} /></div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2"><Label>Break minutes</Label><Input type="number" value={shiftForm.break_minutes} onChange={e => setShiftForm(p => ({ ...p, break_minutes: Number(e.target.value) }))} /></div>
                                <div className="space-y-2"><Label>Grace override (min)</Label><Input type="number" placeholder="Policy default" value={shiftForm.grace_override_minutes} onChange={e => setShiftForm(p => ({ ...p, grace_override_minutes: e.target.value }))} /></div>
                            </div>
                            <div className="flex items-center gap-2"><Switch checked={shiftForm.allow_cross_midnight} onCheckedChange={c => setShiftForm(p => ({ ...p, allow_cross_midnight: c }))} /><span className="text-sm text-gray-600">Allow cross-midnight (night shift)</span></div>
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setShiftDialogOpen(false)}>Cancel</Button>
                            <Button onClick={handleAddShift} disabled={actionLoading}>{actionLoading ? 'Saving...' : 'Create Shift'}</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                <Dialog open={correctionDialogOpen} onOpenChange={setCorrectionDialogOpen}>
                    <DialogContent className="sm:max-w-[520px]">
                        <DialogHeader><DialogTitle>Request Attendance Correction</DialogTitle><DialogDescription>Submit a correction for your own entry. Another authorized person (HR) reviews it; you can never approve your own.</DialogDescription></DialogHeader>
                        {correctionEntry && (
                            <div className="space-y-4">
                                <div className="rounded-lg border p-3 bg-gray-50">
                                    <div className="text-sm font-medium">Original Entry</div>
                                    <div className="text-xs text-gray-500 mt-1">In: {new Date(correctionEntry.clock_in_at).toLocaleString()}{correctionEntry.clock_out_at && ` • Out: ${new Date(correctionEntry.clock_out_at).toLocaleString()}`}</div>
                                </div>
                                <div className="space-y-2"><Label>Reason *</Label><Textarea value={correctionForm.reason} onChange={e => setCorrectionForm(p => ({ ...p, reason: e.target.value }))} placeholder="e.g. Forgot to clock out, actual departure was 6:00 PM" /></div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2"><Label>Corrected clock-in</Label><Input type="datetime-local" value={correctionForm.corrected_clock_in} onChange={e => setCorrectionForm(p => ({ ...p, corrected_clock_in: e.target.value }))} /></div>
                                    <div className="space-y-2"><Label>Corrected clock-out</Label><Input type="datetime-local" value={correctionForm.corrected_clock_out} onChange={e => setCorrectionForm(p => ({ ...p, corrected_clock_out: e.target.value }))} /></div>
                                </div>
                            </div>
                        )}
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setCorrectionDialogOpen(false)}>Cancel</Button>
                            <Button onClick={handleSubmitCorrection} disabled={actionLoading || !correctionForm.reason.trim()}>{actionLoading ? 'Submitting...' : 'Submit Correction'}</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                {/* ─── Shift Template Dialog ──────────────────────── */}
                <Dialog open={shiftTemplateDialogOpen} onOpenChange={setShiftTemplateDialogOpen}>
                    <DialogContent className="sm:max-w-[600px] max-h-[80vh] overflow-y-auto">
                        <DialogHeader>
                            <DialogTitle>Shift Templates</DialogTitle>
                            <DialogDescription>Select common shift patterns used in Malaysian businesses. Click to add.</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-2">
                            {SHIFT_TEMPLATES.map((tpl, i) => {
                                const alreadyExists = shifts.some(s => s.name === tpl.name)
                                return (
                                    <div key={i} className={`flex items-center justify-between rounded-lg border p-3 ${alreadyExists ? 'bg-gray-50 opacity-60' : 'hover:bg-blue-50 cursor-pointer'}`}>
                                        <div>
                                            <div className="font-medium text-sm">{tpl.name}</div>
                                            <div className="text-xs text-gray-500">{tpl.desc} • Break: {tpl.break_minutes}min</div>
                                        </div>
                                        {alreadyExists ? (
                                            <Badge variant="secondary" className="text-[10px]">Added</Badge>
                                        ) : (
                                            <Button size="sm" variant="outline" disabled={actionLoading}
                                                onClick={() => handleLoadShiftTemplate(tpl)}>
                                                <Plus className="h-3 w-3 mr-1" />Add
                                            </Button>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setShiftTemplateDialogOpen(false)}>Done</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </TooltipProvider>
    )
}
