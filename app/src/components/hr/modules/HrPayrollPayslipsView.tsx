'use client'

import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '@/components/ui/dialog'
import {
    Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table'
import {
    Tabs, TabsContent, TabsList, TabsTrigger
} from '@/components/ui/tabs'
import {
    Tooltip, TooltipContent, TooltipProvider, TooltipTrigger
} from '@/components/ui/tooltip'
import { useToast } from '@/components/ui/use-toast'
import { usePermissions } from '@/hooks/usePermissions'
import {
    PayrollRun, PayrollRunItem, StatutoryConfig,
    fetchPayrollRuns, createPayrollRun, calculatePayrollRun, approvePayrollRun,
    fetchPayrollRunItems, fetchStatutoryConfig, updateStatutoryConfig
} from '@/lib/api/payroll'
import {
    Calculator, CheckCircle, DollarSign, FileText, HelpCircle,
    Lock, Plus, Settings, Landmark, RotateCcw, Loader2
} from 'lucide-react'

interface HrPayrollPayslipsViewProps {
    userProfile: {
        id: string
        role_code: string
        roles: { role_level: number }
        department_id?: string | null
        organizations: { id: string }
    }
}

const statusBadge = (status: string) => {
    const map: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
        draft: { variant: 'outline', label: 'Draft' },
        calculating: { variant: 'secondary', label: 'Calculating' },
        calculated: { variant: 'secondary', label: 'Calculated' },
        approved: { variant: 'default', label: 'Approved' },
        posted: { variant: 'default', label: 'Posted' },
        cancelled: { variant: 'destructive', label: 'Cancelled' }
    }
    const item = map[status] || { variant: 'outline' as const, label: status }
    return <Badge variant={item.variant}>{item.label}</Badge>
}

const glStatusBadge = (glStatus: string | undefined) => {
    if (!glStatus || glStatus === 'NOT_POSTED') return <Badge variant="outline" className="text-xs">Not Posted</Badge>
    if (glStatus === 'POSTED') return <Badge variant="default" className="bg-green-600 text-xs">GL Posted</Badge>
    if (glStatus === 'REVERSED') return <Badge variant="destructive" className="text-xs">GL Reversed</Badge>
    return <Badge variant="outline" className="text-xs">{glStatus}</Badge>
}

export default function HrPayrollPayslipsView({ userProfile }: HrPayrollPayslipsViewProps) {
    const { hasPermission } = usePermissions(userProfile.roles.role_level, userProfile.role_code, userProfile.department_id)
    const canManage = userProfile.roles.role_level <= 20 || hasPermission('manage_org_chart')
    const { toast } = useToast()

    const [runs, setRuns] = useState<PayrollRun[]>([])
    const [selectedRun, setSelectedRun] = useState<PayrollRun | null>(null)
    const [runItems, setRunItems] = useState<PayrollRunItem[]>([])
    const [statutory, setStatutory] = useState<StatutoryConfig | null>(null)
    const [loading, setLoading] = useState(true)
    const [actionLoading, setActionLoading] = useState(false)

    const [createDialogOpen, setCreateDialogOpen] = useState(false)
    const [createForm, setCreateForm] = useState({ period_start: '', period_end: '', name: '', notes: '' })

    const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
    const [settingsForm, setSettingsForm] = useState({
        epf_employee_rate: 11, epf_employer_rate: 13,
        socso_employee_rate: 0.5, socso_employer_rate: 1.75,
        eis_employee_rate: 0.2, eis_employer_rate: 0.2,
        pcb_enabled: true
    })

    const loadRuns = async () => {
        setLoading(true)
        const [r, sc] = await Promise.all([fetchPayrollRuns(), fetchStatutoryConfig()])
        if (r.success && r.data) setRuns(r.data)
        if (sc.success && sc.data) {
            setStatutory(sc.data)
            setSettingsForm({
                epf_employee_rate: sc.data.epf_employee_rate || 11,
                epf_employer_rate: sc.data.epf_employer_rate || 13,
                socso_employee_rate: sc.data.socso_employee_rate || 0.5,
                socso_employer_rate: sc.data.socso_employer_rate || 1.75,
                eis_employee_rate: sc.data.eis_employee_rate || 0.2,
                eis_employer_rate: sc.data.eis_employer_rate || 0.2,
                pcb_enabled: sc.data.pcb_enabled !== false
            })
        }
        setLoading(false)
    }

    const loadRunItems = async (runId: string) => {
        const result = await fetchPayrollRunItems(runId)
        if (result.success && result.data) setRunItems(result.data)
    }

    useEffect(() => { loadRuns() }, []) // eslint-disable-line react-hooks/exhaustive-deps

    const handleSelectRun = (run: PayrollRun) => {
        setSelectedRun(run)
        loadRunItems(run.id)
    }

    const setMonthlyPeriod = () => {
        const now = new Date()
        const y = now.getFullYear(); const m = now.getMonth()
        const start = `${y}-${String(m + 1).padStart(2, '0')}-01`
        const end = new Date(y, m + 1, 0).toISOString().split('T')[0]
        const name = `${now.toLocaleString('default', { month: 'long' })} ${y}`
        setCreateForm({ period_start: start, period_end: end, name, notes: '' })
    }

    const handleCreate = async () => {
        if (!createForm.period_start || !createForm.period_end || !createForm.name.trim()) {
            toast({ title: 'Validation', description: 'Period and name are required.', variant: 'destructive' }); return
        }
        setActionLoading(true)
        const result = await createPayrollRun({
            name: createForm.name, period_start: createForm.period_start,
            period_end: createForm.period_end, notes: createForm.notes || undefined
        })
        if (result.success) { toast({ title: 'Payroll run created' }); setCreateDialogOpen(false); loadRuns() }
        else toast({ title: 'Error', description: result.error || 'Failed', variant: 'destructive' })
        setActionLoading(false)
    }

    const handleCalculate = async (run: PayrollRun) => {
        setActionLoading(true)
        const result = await calculatePayrollRun(run.id)
        if (result.success) { toast({ title: 'Payroll calculated', description: 'Review items before approving.' }); loadRuns(); if (selectedRun?.id === run.id) loadRunItems(run.id) }
        else toast({ title: 'Error', description: result.error || 'Failed', variant: 'destructive' })
        setActionLoading(false)
    }

    const handleApprove = async (run: PayrollRun) => {
        if (!confirm('Approve this payroll run? This will lock it for posting.')) return
        setActionLoading(true)
        const result = await approvePayrollRun(run.id)
        if (result.success) { toast({ title: 'Payroll approved and locked' }); loadRuns() }
        else toast({ title: 'Error', description: result.error || 'Failed', variant: 'destructive' })
        setActionLoading(false)
    }

    const [glPostingRunId, setGlPostingRunId] = useState<string | null>(null)

    const handlePostToGL = async (run: PayrollRun) => {
        if (!confirm('Post this payroll run to the General Ledger? This will create journal entries in Finance.')) return
        setGlPostingRunId(run.id)
        try {
            const res = await fetch('/api/hr/payroll/post-to-gl', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payroll_run_id: run.id }),
            })
            const data = await res.json()
            if (data.success) {
                toast({
                    title: 'Posted to GL',
                    description: `Journal ${data.journal_number} created. Total: RM ${data.total_debit?.toLocaleString()}`,
                })
                loadRuns()
            } else {
                toast({ title: 'GL Posting Failed', description: data.error || 'Unknown error', variant: 'destructive' })
            }
        } catch (e) {
            toast({ title: 'Error', description: 'Failed to post to GL', variant: 'destructive' })
        } finally {
            setGlPostingRunId(null)
        }
    }

    const handleReverseGL = async (run: PayrollRun) => {
        const reason = prompt('Reason for reversing GL posting (e.g., payroll rerun):')
        if (!reason) return
        setGlPostingRunId(run.id)
        try {
            const res = await fetch(`/api/hr/payroll/post-to-gl?payroll_run_id=${run.id}&reason=${encodeURIComponent(reason)}`, {
                method: 'DELETE',
            })
            const data = await res.json()
            if (data.success) {
                toast({ title: 'GL Posting Reversed', description: data.message })
                loadRuns()
            } else {
                toast({ title: 'Reversal Failed', description: data.error || 'Unknown error', variant: 'destructive' })
            }
        } catch (e) {
            toast({ title: 'Error', description: 'Failed to reverse GL posting', variant: 'destructive' })
        } finally {
            setGlPostingRunId(null)
        }
    }

    const handleSaveSettings = async () => {
        setActionLoading(true)
        const result = await updateStatutoryConfig(settingsForm)
        if (result.success) { toast({ title: 'Statutory settings saved' }); setSettingsDialogOpen(false); loadRuns() }
        else toast({ title: 'Error', description: result.error || 'Failed', variant: 'destructive' })
        setActionLoading(false)
    }

    const runTotals = useMemo(() => {
        if (!runItems.length) return null
        return {
            basicTotal: runItems.reduce((s, i) => s + (i.basic_salary || 0), 0),
            otTotal: runItems.reduce((s, i) => s + (i.overtime_amount || 0), 0),
            allowTotal: runItems.reduce((s, i) => s + (i.allowances_amount || 0), 0),
            epfEmpTotal: runItems.reduce((s, i) => s + (i.epf_employee || 0), 0),
            epfErTotal: runItems.reduce((s, i) => s + (i.epf_employer || 0), 0),
            socsoEmpTotal: runItems.reduce((s, i) => s + (i.socso_employee || 0), 0),
            eisEmpTotal: runItems.reduce((s, i) => s + (i.eis_employee || 0), 0),
            pcbTotal: runItems.reduce((s, i) => s + (i.pcb_amount || 0), 0),
            grossTotal: runItems.reduce((s, i) => s + Number(i.gross_amount || 0), 0),
            netTotal: runItems.reduce((s, i) => s + Number(i.net_amount || 0), 0),
            count: runItems.length
        }
    }, [runItems])

    return (
        <TooltipProvider>
            <div className="space-y-6">
                <div className="flex items-center justify-between">
                    <div><h3 className="text-lg font-semibold">Payroll Runs & Payslips</h3><p className="text-sm text-gray-500">Create, calculate, and approve payroll runs.</p></div>
                    <div className="flex items-center gap-2">
                        {canManage && (
                            <>
                                <Button variant="outline" size="sm" onClick={() => setSettingsDialogOpen(true)}>
                                    <Settings className="h-4 w-4 mr-1" />Statutory Settings
                                </Button>
                                <Button size="sm" onClick={() => { setMonthlyPeriod(); setCreateDialogOpen(true) }}>
                                    <Plus className="h-4 w-4 mr-1" />New Run
                                </Button>
                            </>
                        )}
                    </div>
                </div>

                {statutory && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="rounded-lg border p-3"><div className="text-xs text-gray-500">EPF (Employee)</div><div className="text-lg font-semibold">{statutory.epf_employee_rate || 11}%</div></div>
                        <div className="rounded-lg border p-3"><div className="text-xs text-gray-500">SOCSO (Employee)</div><div className="text-lg font-semibold">{statutory.socso_employee_rate || 0.5}%</div></div>
                        <div className="rounded-lg border p-3"><div className="text-xs text-gray-500">EIS (Employee)</div><div className="text-lg font-semibold">{statutory.eis_employee_rate || 0.2}%</div></div>
                        <div className="rounded-lg border p-3"><div className="text-xs text-gray-500">PCB</div><div className="text-lg font-semibold">{statutory.pcb_enabled !== false ? 'Enabled' : 'Disabled'}</div></div>
                    </div>
                )}

                <Tabs defaultValue="runs">
                    <TabsList>
                        <TabsTrigger value="runs"><FileText className="h-4 w-4 mr-1" />Payroll Runs</TabsTrigger>
                        <TabsTrigger value="details" disabled={!selectedRun}><DollarSign className="h-4 w-4 mr-1" />Run Details</TabsTrigger>
                    </TabsList>

                    <TabsContent value="runs">
                        <Card>
                            <CardContent className="pt-6">
                                {loading ? <div className="text-center py-8 text-gray-500">Loading...</div> : runs.length === 0 ? (
                                    <div className="text-center py-12 text-gray-400">
                                        <Calculator className="h-10 w-10 mx-auto mb-3 text-gray-300" />
                                        <p>No payroll runs yet.</p>
                                        <p className="text-xs mt-1">Create a run → Calculate → Review → Approve → Post.</p>
                                    </div>
                                ) : (
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Period</TableHead>
                                                <TableHead>Name</TableHead>
                                                <TableHead>Status</TableHead>
                                                <TableHead>GL Status</TableHead>
                                                <TableHead>Employees</TableHead>
                                                <TableHead>Net Total</TableHead>
                                                <TableHead className="text-right">Actions</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {runs.map(run => (
                                                <TableRow key={run.id} className={selectedRun?.id === run.id ? 'bg-blue-50' : ''}>
                                                    <TableCell className="text-sm">{new Date(run.period_start).toLocaleDateString()} – {new Date(run.period_end).toLocaleDateString()}</TableCell>
                                                    <TableCell className="font-medium">{run.name}</TableCell>
                                                    <TableCell>{statusBadge(run.status)}{run.is_locked && <Lock className="h-3 w-3 inline ml-1 text-gray-400" />}</TableCell>
                                                    <TableCell>{glStatusBadge((run as any).gl_status)}</TableCell>
                                                    <TableCell className="text-sm">{run.employee_count || '—'}</TableCell>
                                                    <TableCell className="text-sm font-medium">{run.total_net ? `RM ${run.total_net.toLocaleString()}` : '—'}</TableCell>
                                                    <TableCell className="text-right">
                                                        <div className="flex items-center justify-end gap-1">
                                                            <Button variant="ghost" size="sm" onClick={() => handleSelectRun(run)}>View</Button>
                                                            {canManage && run.status === 'draft' && <Button size="sm" variant="outline" onClick={() => handleCalculate(run)} disabled={actionLoading}><Calculator className="h-4 w-4 mr-1" />Calculate</Button>}
                                                            {canManage && run.status === 'calculated' && <Button size="sm" onClick={() => handleApprove(run)} disabled={actionLoading}><CheckCircle className="h-4 w-4 mr-1" />Approve</Button>}
                                                            {canManage && run.status === 'approved' && (run as any).gl_status !== 'POSTED' && (
                                                                <Button size="sm" variant="default" className="bg-green-600 hover:bg-green-700" onClick={() => handlePostToGL(run)} disabled={glPostingRunId === run.id}>
                                                                    {glPostingRunId === run.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Landmark className="h-4 w-4 mr-1" />}
                                                                    Post to GL
                                                                </Button>
                                                            )}
                                                            {canManage && (run as any).gl_status === 'POSTED' && (
                                                                <Button size="sm" variant="outline" className="text-red-600 border-red-200" onClick={() => handleReverseGL(run)} disabled={glPostingRunId === run.id}>
                                                                    {glPostingRunId === run.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
                                                                    Reverse
                                                                </Button>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                )}
                            </CardContent>
                        </Card>
                    </TabsContent>

                    <TabsContent value="details">
                        {selectedRun && (
                            <div className="space-y-4">
                                <Card>
                                    <CardHeader>
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <CardTitle className="text-base">{selectedRun.name}</CardTitle>
                                                <CardDescription>{new Date(selectedRun.period_start).toLocaleDateString()} – {new Date(selectedRun.period_end).toLocaleDateString()}</CardDescription>
                                            </div>
                                            {statusBadge(selectedRun.status)}
                                        </div>
                                    </CardHeader>
                                </Card>

                                {runTotals && (
                                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                                        <div className="rounded-lg border p-3"><div className="text-xs text-gray-500">Employees</div><div className="text-lg font-semibold">{runTotals.count}</div></div>
                                        <div className="rounded-lg border p-3"><div className="text-xs text-gray-500">Basic Total</div><div className="text-lg font-semibold">RM {runTotals.basicTotal.toLocaleString()}</div></div>
                                        <div className="rounded-lg border p-3"><div className="text-xs text-gray-500">Gross Total</div><div className="text-lg font-semibold">RM {runTotals.grossTotal.toLocaleString()}</div></div>
                                        <div className="rounded-lg border p-3"><div className="text-xs text-gray-500">EPF + SOCSO + EIS</div><div className="text-lg font-semibold">RM {(runTotals.epfEmpTotal + runTotals.socsoEmpTotal + runTotals.eisEmpTotal).toLocaleString()}</div></div>
                                        <div className="rounded-lg border p-3 bg-green-50"><div className="text-xs text-green-600">Net Total</div><div className="text-lg font-semibold text-green-700">RM {runTotals.netTotal.toLocaleString()}</div></div>
                                    </div>
                                )}

                                <Card>
                                    <CardContent className="pt-6">
                                        {runItems.length === 0 ? <div className="text-center py-8 text-gray-500">No items. Calculate the run first.</div> : (
                                            <div className="overflow-x-auto">
                                                <Table>
                                                    <TableHeader>
                                                        <TableRow>
                                                            <TableHead>Employee</TableHead>
                                                            <TableHead>Basic</TableHead>
                                                            <TableHead>OT</TableHead>
                                                            <TableHead>Allowances</TableHead>
                                                            <TableHead>Gross</TableHead>
                                                            <TableHead>EPF</TableHead>
                                                            <TableHead>SOCSO</TableHead>
                                                            <TableHead>EIS</TableHead>
                                                            <TableHead>PCB</TableHead>
                                                            <TableHead className="font-semibold">Net</TableHead>
                                                        </TableRow>
                                                    </TableHeader>
                                                    <TableBody>
                                                        {runItems.map(item => (
                                                            <TableRow key={item.id}>
                                                                <TableCell className="text-sm">{item.employee_user_id.slice(0, 8)}...</TableCell>
                                                                <TableCell className="text-sm">{(item.basic_salary || 0).toLocaleString()}</TableCell>
                                                                <TableCell className="text-sm">{(item.overtime_amount || 0).toLocaleString()}</TableCell>
                                                                <TableCell className="text-sm">{(item.allowances_amount || 0).toLocaleString()}</TableCell>
                                                                <TableCell className="text-sm font-medium">{Number(item.gross_amount || 0).toLocaleString()}</TableCell>
                                                                <TableCell className="text-sm text-red-600">-{(item.epf_employee || 0).toLocaleString()}</TableCell>
                                                                <TableCell className="text-sm text-red-600">-{(item.socso_employee || 0).toLocaleString()}</TableCell>
                                                                <TableCell className="text-sm text-red-600">-{(item.eis_employee || 0).toLocaleString()}</TableCell>
                                                                <TableCell className="text-sm text-red-600">-{(item.pcb_amount || 0).toLocaleString()}</TableCell>
                                                                <TableCell className="text-sm font-semibold text-green-700">{Number(item.net_amount || 0).toLocaleString()}</TableCell>
                                                            </TableRow>
                                                        ))}
                                                    </TableBody>
                                                </Table>
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            </div>
                        )}
                    </TabsContent>
                </Tabs>

                {/* Create Payroll Run Dialog */}
                <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                    <DialogContent className="sm:max-w-[500px]">
                        <DialogHeader><DialogTitle>Create Payroll Run</DialogTitle><DialogDescription>Define the payroll period. Employees with active compensation will be included.</DialogDescription></DialogHeader>
                        <div className="space-y-4">
                            <div className="space-y-2"><Label>Run Name *</Label><Input placeholder="e.g. June 2025" value={createForm.name} onChange={e => setCreateForm(p => ({ ...p, name: e.target.value }))} /></div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2"><Label>Period Start *</Label><Input type="date" value={createForm.period_start} onChange={e => setCreateForm(p => ({ ...p, period_start: e.target.value }))} /></div>
                                <div className="space-y-2"><Label>Period End *</Label><Input type="date" value={createForm.period_end} onChange={e => setCreateForm(p => ({ ...p, period_end: e.target.value }))} /></div>
                            </div>
                            <div className="space-y-2"><Label>Notes</Label><Textarea value={createForm.notes} onChange={e => setCreateForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional notes..." /></div>
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
                            <Button onClick={handleCreate} disabled={actionLoading}>{actionLoading ? 'Creating...' : 'Create'}</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                {/* Statutory Settings Dialog */}
                <Dialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
                    <DialogContent className="sm:max-w-[560px]">
                        <DialogHeader>
                            <DialogTitle>Statutory Settings (Malaysia)</DialogTitle>
                            <DialogDescription>Configure EPF, SOCSO, EIS, and PCB rates for payroll computation.</DialogDescription>
                        </DialogHeader>
                        <div className="space-y-5">
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    EPF (KWSP)
                                    <Tooltip><TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-gray-400" /></TooltipTrigger>
                                        <TooltipContent className="max-w-xs"><p className="text-xs">Default: Employee 11%, Employer 13%. Below 60 years old. Employer rate is 12% for salary &gt; RM5,000.</p></TooltipContent>
                                    </Tooltip>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-1"><Label className="text-xs">Employee Rate (%)</Label><Input type="number" step="0.5" value={settingsForm.epf_employee_rate} onChange={e => setSettingsForm(p => ({ ...p, epf_employee_rate: Number(e.target.value) }))} /></div>
                                    <div className="space-y-1"><Label className="text-xs">Employer Rate (%)</Label><Input type="number" step="0.5" value={settingsForm.epf_employer_rate} onChange={e => setSettingsForm(p => ({ ...p, epf_employer_rate: Number(e.target.value) }))} /></div>
                                </div>
                            </div>
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    SOCSO (PERKESO)
                                    <Tooltip><TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-gray-400" /></TooltipTrigger>
                                        <TooltipContent className="max-w-xs"><p className="text-xs">Employment Injury Scheme + Invalidity Pension Scheme. Rate depends on salary bracket.</p></TooltipContent>
                                    </Tooltip>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-1"><Label className="text-xs">Employee Rate (%)</Label><Input type="number" step="0.1" value={settingsForm.socso_employee_rate} onChange={e => setSettingsForm(p => ({ ...p, socso_employee_rate: Number(e.target.value) }))} /></div>
                                    <div className="space-y-1"><Label className="text-xs">Employer Rate (%)</Label><Input type="number" step="0.1" value={settingsForm.socso_employer_rate} onChange={e => setSettingsForm(p => ({ ...p, socso_employer_rate: Number(e.target.value) }))} /></div>
                                </div>
                            </div>
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-sm font-medium">EIS (SIP)</div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-1"><Label className="text-xs">Employee Rate (%)</Label><Input type="number" step="0.1" value={settingsForm.eis_employee_rate} onChange={e => setSettingsForm(p => ({ ...p, eis_employee_rate: Number(e.target.value) }))} /></div>
                                    <div className="space-y-1"><Label className="text-xs">Employer Rate (%)</Label><Input type="number" step="0.1" value={settingsForm.eis_employer_rate} onChange={e => setSettingsForm(p => ({ ...p, eis_employer_rate: Number(e.target.value) }))} /></div>
                                </div>
                            </div>
                            <div className="space-y-3">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    PCB (Monthly Tax Deduction)
                                    <Tooltip><TooltipTrigger asChild><HelpCircle className="h-3 w-3 text-gray-400" /></TooltipTrigger>
                                        <TooltipContent className="max-w-xs"><p className="text-xs">Schedule-based monthly tax deduction. Enable to auto-compute PCB based on salary bracket.</p></TooltipContent>
                                    </Tooltip>
                                </div>
                                <div className="flex items-center gap-2">
                                    <input type="checkbox" checked={settingsForm.pcb_enabled} onChange={e => setSettingsForm(p => ({ ...p, pcb_enabled: e.target.checked }))} />
                                    <span className="text-sm text-gray-600">Enable PCB computation</span>
                                </div>
                            </div>
                        </div>
                        <DialogFooter>
                            <Button variant="outline" onClick={() => setSettingsDialogOpen(false)}>Cancel</Button>
                            <Button onClick={handleSaveSettings} disabled={actionLoading}>{actionLoading ? 'Saving...' : 'Save Settings'}</Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </div>
        </TooltipProvider>
    )
}
