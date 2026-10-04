'use client'

import { useEffect, useMemo, useState, useRef } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '@/components/ui/dialog'
import {
    Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle
} from '@/components/ui/sheet'
import { useToast } from '@/components/ui/use-toast'
import {
    Search, Users, UserCheck, Building2, Briefcase, Pencil, Check, X,
    Plus, Copy, Loader2, Eye, Save, ChevronRight, Camera, UserPlus, AlertTriangle, ArrowLeft
} from 'lucide-react'
import { listDepartments } from '@/lib/actions/departments'
import { fetchHrPositions, updateUserHr } from '@/lib/api/hr'
import { compressAvatar } from '@/lib/utils/imageCompression'

interface HrPeopleViewProps {
    organizationId: string
    canEdit: boolean
}

interface HrUserRow {
    id: string
    full_name: string | null
    email: string
    phone: string | null
    avatar_url: string | null
    role_code: string
    role_name: string | null
    role_level: number | null
    is_active: boolean
    department_id: string | null
    manager_user_id: string | null
    manager_name: string | null
    position_id: string | null
    position_name: string | null
    employee_no: number | null
    employment_type: string | null
    /** HR registration state of the employment record in this organization. */
    onboarding_status: 'pending' | 'completed' | 'reset' | null
    hire_date: string | null
}

interface OnboardingCandidate {
    found: boolean
    user_id?: string
    full_name?: string | null
    email_masked?: string | null
    phone_masked?: string | null
    principal_type?: string
    account_status?: string
    same_organization?: boolean
    organization_name?: string | null
    has_login?: boolean
    employment?: {
        employee_no: number | null
        onboarding_status: 'pending' | 'completed' | 'reset'
        employment_status: string
        hire_date: string | null
        hire_date_confirmed: boolean
        department_id: string | null
        position_id: string | null
        manager_user_id: string | null
        employment_type: string | null
    } | null
    block_code?: string | null
    eligible?: boolean
}

interface NameSearchResult {
    user_id: string
    full_name: string | null
    email_masked: string | null
    employee_no: number | null
    onboarding_status: 'pending' | 'completed' | 'reset'
}

interface HrProfileData {
    gender?: string | null
    date_of_birth?: string | null
    nationality?: string | null
    marital_status?: string | null
    blood_type?: string | null
    religion?: string | null
    ic_number?: string | null
    passport_number?: string | null
    tax_id?: string | null
    socso_number?: string | null
    epf_number?: string | null
    eis_number?: string | null
    personal_email?: string | null
    personal_phone?: string | null
    address_line1?: string | null
    address_line2?: string | null
    city?: string | null
    state?: string | null
    postcode?: string | null
    country?: string | null
    emergency_name?: string | null
    emergency_relationship?: string | null
    emergency_phone?: string | null
    emergency_address?: string | null
    bank_name?: string | null
    bank_account_no?: string | null
    bank_holder_name?: string | null
    highest_education?: string | null
    education_institution?: string | null
    education_field?: string | null
    notes?: string | null
}

export default function HrPeopleView({ organizationId, canEdit }: HrPeopleViewProps) {
    const { supabase, isReady } = useSupabaseAuth()
    const { toast } = useToast()

    // Prevent Radix Select hydration mismatch (useId differs between SSR & client)
    const [mounted, setMounted] = useState(false)
    useEffect(() => { setMounted(true) }, [])

    const [users, setUsers] = useState<HrUserRow[]>([])
    const [departments, setDepartments] = useState<{ id: string; dept_name: string; dept_code: string | null }[]>([])
    const [positions, setPositions] = useState<{ id: string; name: string }[]>([])
    const [loading, setLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState('')
    const [departmentFilter, setDepartmentFilter] = useState('all')
    const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set())
    const [bulkDepartment, setBulkDepartment] = useState('none')
    const [bulkPosition, setBulkPosition] = useState('none')
    const [bulkManager, setBulkManager] = useState('none')
    const [editingUserId, setEditingUserId] = useState<string | null>(null)
    const [editDept, setEditDept] = useState('')
    const [editPosition, setEditPosition] = useState('')
    const [editManager, setEditManager] = useState('')
    const [savingInline, setSavingInline] = useState(false)

    // Add Employee (HR onboarding) dialog state. One central identity per
    // person: HR finds the person (name search is a selection aid only;
    // email/phone go through the canonical resolver), reviews a minimal
    // preview, then records employment facts. Access is administered in
    // Security & Access, never here.
    const [addDialogOpen, setAddDialogOpen] = useState(false)
    const [addLoading, setAddLoading] = useState(false)
    const [statusFilter, setStatusFilter] = useState('active')
    const [onboardingView, setOnboardingView] = useState<'completed' | 'awaiting'>('completed')
    const [onboardingSupported, setOnboardingSupported] = useState(true)
    const [addStep, setAddStep] = useState<'find' | 'details' | 'done'>('find')
    const [nameQuery, setNameQuery] = useState('')
    const [nameResults, setNameResults] = useState<NameSearchResult[]>([])
    const [lookup, setLookup] = useState({ email: '', phone: '' })
    const [lookupLoading, setLookupLoading] = useState(false)
    const [lookupError, setLookupError] = useState<string | null>(null)
    const [candidate, setCandidate] = useState<OnboardingCandidate | null>(null)
    const [candidateBlock, setCandidateBlock] = useState<string | null>(null)
    const [addForm, setAddForm] = useState({
        full_name: '',
        email: '',
        phone: '',
        department_id: '',
        position_id: '',
        manager_user_id: '',
        employment_type: 'Full-time',
        hire_date: '',
    })
    const [addResult, setAddResult] = useState<{ employee_no?: number; temp_password?: string | null; outcome?: 'CREATED' | 'REUSED'; onboarding?: string } | null>(null)

    // HR Profile sheet state
    const [profileOpen, setProfileOpen] = useState(false)
    const [profileUser, setProfileUser] = useState<HrUserRow | null>(null)
    const [profileData, setProfileData] = useState<HrProfileData>({})
    const [profileLoading, setProfileLoading] = useState(false)
    const [profileSaving, setProfileSaving] = useState(false)
    const [profileTab, setProfileTab] = useState('personal')
    const [avatarUploading, setAvatarUploading] = useState(false)
    const avatarInputRef = useRef<HTMLInputElement>(null)

    const loadUsers = async () => {
        if (!isReady) return
        setLoading(true)

        const baseColumns = `
                id,
                full_name,
                email,
                phone,
                avatar_url,
                role_code,
                is_active,
                department_id,
                manager_user_id,
                position_id,
                employee_no,
                employment_type,
                roles:role_code (role_name, role_level),
                positions:position_id (name)`
        // HR lists people by their employment record's onboarding state in
        // this organization (the record exists for every internal identity).
        let { data, error } = await (supabase as any)
            .from('users')
            .select(`${baseColumns},
                hr_employees!hr_employees_user_id_fkey!inner (organization_id, onboarding_status, hire_date, hire_date_confirmed)`)
            .eq('organization_id', organizationId)
            .eq('hr_employees.organization_id', organizationId)
            .order('full_name', { ascending: true })
        const onboardingAvailable = !(error && /onboarding_status|hire_date_confirmed/.test(error.message || ''))
        if (!onboardingAvailable) {
            // Database not yet migrated: previous behaviour (everyone listed).
            ({ data, error } = await (supabase as any)
                .from('users')
                .select(baseColumns)
                .eq('organization_id', organizationId)
                .order('full_name', { ascending: true }))
        }
        setOnboardingSupported(onboardingAvailable)

        if (error) {
            toast({ title: 'Error', description: error.message, variant: 'destructive' })
            setLoading(false)
            return
        }

        const managerIds = Array.from(
            new Set((data || []).map((u: any) => u.manager_user_id).filter(Boolean))
        ) as string[]

        const managerMap = new Map<string, string | null>()
        if (managerIds.length > 0) {
            const { data: managers, error: managerError } = await (supabase as any)
                .from('users')
                .select('id, full_name')
                .in('id', managerIds)

            if (managerError) {
                toast({ title: 'Warning', description: managerError.message, variant: 'destructive' })
            } else {
                ; (managers || []).forEach((m: any) => managerMap.set(m.id, m.full_name || null))
            }
        }

        const mapped = (data || []).map((u: any) => {
            const employment = (Array.isArray(u.hr_employees) ? u.hr_employees : [u.hr_employees])
                .find((e: any) => e?.organization_id === organizationId) || null
            return {
                id: u.id,
                full_name: u.full_name,
                email: u.email,
                phone: u.phone,
                avatar_url: u.avatar_url,
                role_code: u.role_code,
                role_name: u.roles?.role_name || null,
                role_level: u.roles?.role_level ?? null,
                is_active: u.is_active,
                department_id: u.department_id,
                manager_user_id: u.manager_user_id,
                manager_name: u.manager_user_id ? managerMap.get(u.manager_user_id) || null : null,
                position_id: u.position_id,
                position_name: u.positions?.name || null,
                employee_no: u.employee_no ?? null,
                employment_type: u.employment_type || null,
                onboarding_status: onboardingAvailable ? (employment?.onboarding_status ?? null) : 'completed',
                // A login creation date is never shown as a confirmed hire date.
                hire_date: employment?.hire_date_confirmed ? employment.hire_date : null,
            } as HrUserRow
        })

        setUsers(mapped)
        setLoading(false)
    }

    const loadFilters = async () => {
        const deptResult = await listDepartments(organizationId, true)
        if (deptResult.success && deptResult.data) {
            setDepartments(deptResult.data.map(d => ({ id: d.id, dept_name: d.dept_name, dept_code: d.dept_code })))
        }

        const posResult = await fetchHrPositions(true)
        if (posResult.success && posResult.data) {
            setPositions(posResult.data.map(p => ({ id: p.id, name: p.name })))
        }
    }

    useEffect(() => {
        loadUsers()
        loadFilters()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReady, organizationId])

    const filteredUsers = useMemo(() => {
        const query = searchQuery.trim().toLowerCase()
        return users.filter(u => {
            const onboarded = u.onboarding_status === 'completed'
            if (onboardingView === 'completed' ? !onboarded : onboarded) return false
            if (departmentFilter !== 'all' && u.department_id !== departmentFilter) return false
            // Status filter
            if (statusFilter === 'active' && !u.is_active) return false
            if (statusFilter === 'inactive' && u.is_active) return false
            if (!query) return true
            return (
                (u.full_name || '').toLowerCase().includes(query) ||
                u.email.toLowerCase().includes(query) ||
                (u.position_name || '').toLowerCase().includes(query)
            )
        })
    }, [users, searchQuery, departmentFilter, statusFilter, onboardingView])

    const awaitingCount = useMemo(() => users.filter(u => u.onboarding_status !== 'completed').length, [users])
    const onboardedUsers = useMemo(() => users.filter(u => u.onboarding_status === 'completed'), [users])

    const departmentById = useMemo(() => {
        const map = new Map<string, { id: string; dept_name: string; dept_code: string | null }>()
        departments.forEach(d => map.set(d.id, d))
        return map
    }, [departments])

    const getDepartmentLabel = (departmentId: string | null) => {
        if (!departmentId) return 'No dept'
        const dept = departmentById.get(departmentId)
        if (!dept) return 'No dept'
        return `${dept.dept_code ? `${dept.dept_code} - ` : ''}${dept.dept_name}`
    }

    const toggleSelectAll = (checked: boolean) => {
        if (!checked) {
            setSelectedUsers(new Set())
            return
        }
        setSelectedUsers(new Set(filteredUsers.map(u => u.id)))
    }

    const toggleSelectUser = (userId: string, checked: boolean) => {
        const next = new Set(selectedUsers)
        if (checked) next.add(userId)
        else next.delete(userId)
        setSelectedUsers(next)
    }

    const applyBulkUpdate = async () => {
        if (!canEdit || selectedUsers.size === 0) return

        const updates = Array.from(selectedUsers).map(userId =>
            updateUserHr(userId, {
                department_id: bulkDepartment === 'none' ? undefined : bulkDepartment === 'clear' ? null : bulkDepartment,
                position_id: bulkPosition === 'none' ? undefined : bulkPosition === 'clear' ? null : bulkPosition,
                manager_user_id: bulkManager === 'none' ? undefined : bulkManager === 'clear' ? null : bulkManager
            })
        )

        const results = await Promise.all(updates)
        const failed = results.find(r => !r.success)

        if (failed) {
            toast({ title: 'Error', description: failed.error || 'Failed to update users', variant: 'destructive' })
        } else {
            toast({ title: 'Updated', description: 'Users updated.' })
            setSelectedUsers(new Set())
            setBulkDepartment('none')
            setBulkPosition('none')
            setBulkManager('none')
            loadUsers()
        }
    }

    const startInlineEdit = (user: HrUserRow) => {
        setEditingUserId(user.id)
        setEditDept(user.department_id || '')
        setEditPosition(user.position_id || '')
        setEditManager(user.manager_user_id || '')
    }

    const cancelInlineEdit = () => {
        setEditingUserId(null)
    }

    const saveInlineEdit = async (userId: string) => {
        setSavingInline(true)
        const user = users.find(u => u.id === userId)
        if (!user) return
        const updates: Record<string, string | null | undefined> = {}
        if (editDept !== (user.department_id || '')) updates.department_id = editDept || null
        if (editPosition !== (user.position_id || '')) updates.position_id = editPosition || null
        if (editManager !== (user.manager_user_id || '')) updates.manager_user_id = editManager || null

        if (Object.keys(updates).length === 0) {
            setEditingUserId(null)
            setSavingInline(false)
            return
        }

        const result = await updateUserHr(userId, updates)
        if (result.success) {
            toast({ title: 'Updated', description: `${user.full_name || 'User'} updated.` })
            setEditingUserId(null)
            loadUsers()
        } else {
            toast({ title: 'Error', description: result.error || 'Failed to update', variant: 'destructive' })
        }
        setSavingInline(false)
    }

    const emptyAddForm = () => ({
        full_name: '', email: '', phone: '',
        department_id: '', position_id: '', manager_user_id: '',
        employment_type: 'Full-time', hire_date: '',
    })

    const resetAddForm = () => {
        setAddForm(emptyAddForm())
        setAddResult(null)
        setAddStep('find')
        setNameQuery('')
        setNameResults([])
        setLookup({ email: '', phone: '' })
        setLookupError(null)
        setCandidate(null)
        setCandidateBlock(null)
    }

    // Name search helps HR pick a person of this organization; it never
    // decides identity on its own.
    const searchByName = async (q: string) => {
        setNameQuery(q)
        if (q.trim().length < 2) { setNameResults([]); return }
        try {
            const res = await fetch(`/api/hr/employees/candidates?q=${encodeURIComponent(q.trim())}`)
            const json = await res.json()
            setNameResults(json.success ? json.data : [])
        } catch {
            setNameResults([])
        }
    }

    const applyCandidate = (data: { outcome: string; candidate?: OnboardingCandidate; block_message?: string | null }) => {
        if (data.outcome === 'NEW_PERSON') {
            setCandidate(null)
            setCandidateBlock(null)
            setAddForm(p => ({ ...emptyAddForm(), email: lookup.email.trim().toLowerCase(), phone: lookup.phone.trim(), full_name: p.full_name }))
        } else if (data.candidate) {
            const employment = data.candidate.employment
            setCandidate(data.candidate)
            setCandidateBlock(data.block_message ?? null)
            // HR facts already on the employment record are the starting point.
            setAddForm({
                ...emptyAddForm(),
                department_id: employment?.department_id || '',
                position_id: employment?.position_id || '',
                manager_user_id: employment?.manager_user_id || '',
                employment_type: employment?.employment_type || 'Full-time',
                hire_date: employment?.hire_date_confirmed ? (employment.hire_date || '') : '',
            })
        }
        setAddStep('details')
    }

    const lookupCandidate = async (body: { user_id?: string; email?: string; phone?: string }) => {
        setLookupLoading(true)
        setLookupError(null)
        try {
            const res = await fetch('/api/hr/employees/candidates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const json = await res.json()
            if (json.success) applyCandidate(json.data)
            else setLookupError(json.error || 'Lookup failed.')
        } catch (err: any) {
            setLookupError(err.message)
        }
        setLookupLoading(false)
    }

    const startOnboardingFor = (user: HrUserRow) => {
        resetAddForm()
        setAddDialogOpen(true)
        lookupCandidate({ user_id: user.id })
    }

    const handleAddEmployee = async () => {
        if (addLoading) return
        const isNew = !candidate
        if (isNew && (!addForm.full_name.trim() || !addForm.email.trim())) {
            toast({ title: 'Validation', description: 'Full name and email are required.', variant: 'destructive' })
            return
        }
        if (!addForm.hire_date) {
            toast({ title: 'Validation', description: 'Enter the actual hire date.', variant: 'destructive' })
            return
        }
        setAddLoading(true)
        try {
            const res = await fetch('/api/hr/employees', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...(isNew
                        ? { full_name: addForm.full_name.trim(), email: addForm.email.trim().toLowerCase(), phone: addForm.phone.trim() || null }
                        : { user_id: candidate!.user_id }),
                    department_id: addForm.department_id || null,
                    position_id: addForm.position_id || null,
                    manager_user_id: addForm.manager_user_id || null,
                    employment_type: addForm.employment_type,
                    hire_date: addForm.hire_date,
                }),
            })
            const json = await res.json()
            if (json.success) {
                const reused = json.data?.outcome === 'REUSED'
                const name = candidate?.full_name || addForm.full_name
                toast({
                    title: json.data?.onboarding === 'ALREADY_ONBOARDED' ? 'Already onboarded' : 'Employee onboarded',
                    description: `${name} ${reused ? 'keeps their existing account.' : 'has a new account.'}`,
                })
                setAddResult({
                    employee_no: json.data?.employee_no,
                    temp_password: json.data?.temp_password,
                    outcome: json.data?.outcome,
                    onboarding: json.data?.onboarding,
                })
                setAddStep('done')
                loadUsers()
            } else {
                toast({ title: 'Not onboarded', description: json.error || 'Failed to onboard employee.', variant: 'destructive' })
                if (json.data?.temp_password) {
                    setAddResult({ temp_password: json.data.temp_password, outcome: 'CREATED' })
                    setAddStep('done')
                    loadUsers()
                }
            }
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        }
        setAddLoading(false)
    }

    // Open HR profile sheet
    const openProfile = async (user: HrUserRow) => {
        setProfileUser(user)
        setProfileOpen(true)
        setProfileLoading(true)
        setProfileTab('personal')
        try {
            const res = await fetch(`/api/hr/employees/profile?user_id=${user.id}`)
            const json = await res.json()
            if (json.success && json.data?.profile) {
                setProfileData(json.data.profile)
            } else {
                setProfileData({})
            }
        } catch {
            setProfileData({})
        }
        setProfileLoading(false)
    }

    const saveProfile = async () => {
        if (!profileUser) return
        setProfileSaving(true)
        try {
            const res = await fetch('/api/hr/employees/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: profileUser.id, ...profileData }),
            })
            const json = await res.json()
            if (json.success) {
                toast({ title: 'Profile saved' })
            } else {
                toast({ title: 'Error', description: json.error, variant: 'destructive' })
            }
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        }
        setProfileSaving(false)
    }

    const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file || !profileUser) return
        setAvatarUploading(true)
        try {
            const compressed = await compressAvatar(file)
            const fileName = `${Date.now()}.jpg`
            const filePath = `${profileUser.id}/${fileName}`

            // Delete old avatar if exists
            if (profileUser.avatar_url) {
                const oldPath = profileUser.avatar_url.split('/').pop()?.split('?')[0]
                if (oldPath) {
                    await (supabase as any).storage.from('avatars').remove([`${profileUser.id}/${oldPath}`])
                }
            }

            const { error: uploadError } = await (supabase as any).storage
                .from('avatars')
                .upload(filePath, compressed.file, { contentType: compressed.file.type, cacheControl: '3600', upsert: true })

            if (uploadError) throw uploadError

            const { data } = (supabase as any).storage.from('avatars').getPublicUrl(filePath)
            const newUrl = data.publicUrl

            // Update user.avatar_url in users table
            await (supabase as any).from('users').update({ avatar_url: newUrl }).eq('id', profileUser.id)

            // Update local state
            setProfileUser(prev => prev ? { ...prev, avatar_url: newUrl } : prev)
            setUsers(prev => prev.map(u => u.id === profileUser.id ? { ...u, avatar_url: newUrl } : u))

            toast({ title: 'Avatar updated', description: 'Profile photo changed successfully.' })
        } catch (err: any) {
            toast({ title: 'Upload failed', description: err.message, variant: 'destructive' })
        }
        setAvatarUploading(false)
        if (avatarInputRef.current) avatarInputRef.current.value = ''
    }

    const updateProfileField = (key: keyof HrProfileData, value: string | null) => {
        setProfileData(prev => ({ ...prev, [key]: value }))
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <CardTitle className="text-base font-semibold">People</CardTitle>
                        <CardDescription className="text-xs">Employees and reporting lines • {filteredUsers.length} of {users.length}</CardDescription>
                    </div>
                    {canEdit && (
                        <Button size="sm" className="w-full sm:w-auto shrink-0" onClick={() => { resetAddForm(); setAddDialogOpen(true) }}>
                            <Plus className="h-4 w-4 mr-1" /> Add Employee
                        </Button>
                    )}
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                {onboardingSupported && (
                    <div className="flex flex-wrap items-center gap-1">
                        {([
                            { id: 'completed', label: 'Onboarded', count: onboardedUsers.length },
                            { id: 'awaiting', label: 'Awaiting onboarding', count: awaitingCount },
                        ] as const).map(tab => (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => { setOnboardingView(tab.id); setSelectedUsers(new Set()) }}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${onboardingView === tab.id
                                    ? 'bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800'
                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
                            >
                                {tab.label}
                                <Badge variant="outline" className="text-[10px] px-1.5 py-0">{tab.count}</Badge>
                            </button>
                        ))}
                    </div>
                )}
                {onboardingSupported && onboardingView === 'awaiting' && (
                    <p className="text-xs text-muted-foreground">
                        These people have a login and an employment record but HR has not registered them yet (or their registration was reset).
                        Their existing HR history is kept. Employee self-service shows a pending-setup screen until onboarding is completed.
                    </p>
                )}
                <div className="flex flex-col sm:flex-row gap-3">
                    <div className="relative flex-1 min-w-0">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                        <Input
                            placeholder="Search employees..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-10"
                        />
                    </div>
                    {mounted && (
                        <>
                            <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
                                <SelectTrigger className="w-full sm:w-[220px]">
                                    <SelectValue placeholder="Filter by department" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Departments</SelectItem>
                                    {departments.map(dept => (
                                        <SelectItem key={dept.id} value={dept.id}>
                                            {dept.dept_code ? `${dept.dept_code} - ` : ''}{dept.dept_name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Select value={statusFilter} onValueChange={setStatusFilter}>
                                <SelectTrigger className="w-full sm:w-[160px]">
                                    <SelectValue placeholder="Status" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All Status</SelectItem>
                                    <SelectItem value="active">Active</SelectItem>
                                    <SelectItem value="inactive">Inactive / Left</SelectItem>
                                </SelectContent>
                            </Select>
                        </>
                    )}
                </div>

                {selectedUsers.size > 0 && (
                    <div className="flex flex-col lg:flex-row lg:items-center gap-3 p-3 border rounded-md bg-blue-50">
                        <div className="text-sm font-medium text-blue-900">
                            {selectedUsers.size} selected
                        </div>
                        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-end gap-3 w-full">
                            <div className="space-y-1 w-full sm:w-auto">
                                <label className="text-xs font-medium text-blue-800">Department</label>
                                <Select value={bulkDepartment} onValueChange={setBulkDepartment}>
                                    <SelectTrigger className="w-full sm:w-[200px]">
                                        <SelectValue placeholder="No change" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="none">No change</SelectItem>
                                        <SelectItem value="clear">Clear department</SelectItem>
                                        {departments.map(dept => (
                                            <SelectItem key={dept.id} value={dept.id}>
                                                {dept.dept_code ? `${dept.dept_code} - ` : ''}{dept.dept_name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1 w-full sm:w-auto">
                                <label className="text-xs font-medium text-blue-800">Position</label>
                                <Select value={bulkPosition} onValueChange={setBulkPosition}>
                                    <SelectTrigger className="w-full sm:w-[200px]">
                                        <SelectValue placeholder="No change" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="none">No change</SelectItem>
                                        <SelectItem value="clear">Clear position</SelectItem>
                                        {positions.map(position => (
                                            <SelectItem key={position.id} value={position.id}>
                                                {position.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-1 w-full sm:w-auto">
                                <label className="text-xs font-medium text-blue-800">Reports To</label>
                                <Select value={bulkManager} onValueChange={setBulkManager}>
                                    <SelectTrigger className="w-full sm:w-[200px]">
                                        <SelectValue placeholder="No change" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="none">No change</SelectItem>
                                        <SelectItem value="clear">Set as top leader</SelectItem>
                                        {users.map(user => (
                                            <SelectItem key={user.id} value={user.id}>
                                                {user.full_name || user.email}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <Button onClick={applyBulkUpdate} disabled={!canEdit}>
                                Apply
                            </Button>
                        </div>
                    </div>
                )}

                {loading ? (
                    <div className="py-8 text-center text-gray-500">Loading employees...</div>
                ) : (
                    <div className="rounded-md border overflow-auto">
                        <div className="grid grid-cols-[40px_1fr_1fr_1fr_1fr_100px_90px_80px_40px] gap-2 px-4 py-2 bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wide min-w-[1100px]">
                            <div>
                                <Checkbox
                                    checked={selectedUsers.size > 0 && selectedUsers.size === filteredUsers.length}
                                    onCheckedChange={(checked) => toggleSelectAll(checked as boolean)}
                                />
                            </div>
                            <div>Name</div>
                            <div>Department</div>
                            <div>Position</div>
                            <div>Reports To</div>
                            <div>Type</div>
                            <div>Role</div>
                            <div>Status</div>
                            <div></div>
                        </div>
                        {filteredUsers.length === 0 ? (
                            <div className="px-4 py-8 text-center text-sm text-gray-500">
                                {onboardingView === 'awaiting'
                                    ? 'Nobody is awaiting onboarding.'
                                    : users.length === 0 || onboardedUsers.length === 0 ? 'No onboarded employees yet. Click "+ Add Employee" to register someone.' : 'No employees match your filters.'}
                            </div>
                        ) : filteredUsers.map(user => {
                            const isEditing = editingUserId === user.id
                            return (
                            <div key={user.id} className="grid grid-cols-[40px_1fr_1fr_1fr_1fr_100px_90px_80px_40px] gap-2 px-4 py-3 border-t items-center min-w-[1100px] hover:bg-muted/30 transition-colors">
                                <div>
                                    <Checkbox
                                        checked={selectedUsers.has(user.id)}
                                        onCheckedChange={(checked) => toggleSelectUser(user.id, checked as boolean)}
                                    />
                                </div>
                                <div className="flex items-center gap-3 cursor-pointer group" onClick={() => openProfile(user)}>
                                    <Avatar className="h-8 w-8">
                                        <AvatarImage src={user.avatar_url || undefined} alt={user.full_name || 'User'} />
                                        <AvatarFallback className="text-xs">{(user.full_name || user.email).split(' ').map(n => n[0]).join('').slice(0, 2)}</AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium truncate group-hover:text-blue-600 transition-colors">{user.full_name || 'Unknown'}</div>
                                        {user.employee_no && (
                                            <div className="text-[10px] text-muted-foreground font-mono">EMP-{String(user.employee_no).padStart(4, '0')}</div>
                                        )}
                                        <div className="text-xs text-gray-400 truncate">{user.email}</div>
                                    </div>
                                    <ChevronRight className="h-3 w-3 text-gray-300 group-hover:text-blue-400 opacity-0 group-hover:opacity-100 transition-all" />
                                </div>
                                <div className="text-sm text-gray-600">
                                    {isEditing ? (
                                        <Select value={editDept || 'none'} onValueChange={(v) => setEditDept(v === 'none' ? '' : v)}>
                                            <SelectTrigger className="h-8 text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">No dept</SelectItem>
                                                {departments.map(d => (
                                                    <SelectItem key={d.id} value={d.id}>
                                                        {d.dept_code ? `${d.dept_code} - ` : ''}{d.dept_name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    ) : (
                                        <div className="flex items-center gap-1">
                                            <Building2 className="h-3 w-3 shrink-0 text-gray-400" />
                                            <span className="truncate text-xs">{getDepartmentLabel(user.department_id)}</span>
                                        </div>
                                    )}
                                </div>
                                <div className="text-sm text-gray-600">
                                    {isEditing ? (
                                        <Select value={editPosition || 'none'} onValueChange={(v) => setEditPosition(v === 'none' ? '' : v)}>
                                            <SelectTrigger className="h-8 text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">No position</SelectItem>
                                                {positions.map(p => (
                                                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    ) : (
                                        <div className="flex items-center gap-1">
                                            <Briefcase className="h-3 w-3 shrink-0 text-gray-400" />
                                            <span className="truncate text-xs">{user.position_name || 'No position'}</span>
                                        </div>
                                    )}
                                </div>
                                <div className="text-sm text-gray-600">
                                    {isEditing ? (
                                        <Select value={editManager || 'none'} onValueChange={(v) => setEditManager(v === 'none' ? '' : v)}>
                                            <SelectTrigger className="h-8 text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">Top leader</SelectItem>
                                                {users.filter(u => u.id !== user.id).map(u => (
                                                    <SelectItem key={u.id} value={u.id}>{u.full_name || u.email}</SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    ) : (
                                        <div className="flex items-center gap-1">
                                            <UserCheck className="h-3 w-3 shrink-0 text-gray-400" />
                                            <span className="truncate text-xs">{user.manager_name || 'Top leader'}</span>
                                        </div>
                                    )}
                                </div>
                                <div className="text-xs text-gray-500">
                                    {user.employment_type || 'Full-time'}
                                </div>
                                <div className="text-xs text-gray-500">{user.role_name || user.role_code}</div>
                                <div>
                                    {user.onboarding_status && user.onboarding_status !== 'completed' ? (
                                        <Badge variant="outline" className="text-[10px] border-amber-200 text-amber-700">
                                            {user.onboarding_status === 'reset' ? 'Reset' : 'Pending'}
                                        </Badge>
                                    ) : (
                                        <Badge variant={user.is_active ? 'default' : 'secondary'} className="text-[10px]">
                                            {user.is_active ? 'Active' : 'Disabled'}
                                        </Badge>
                                    )}
                                </div>
                                <div>
                                    {canEdit && user.onboarding_status && user.onboarding_status !== 'completed' && !isEditing ? (
                                        <Button variant="ghost" size="icon" className="h-7 w-7" title="Complete HR onboarding" onClick={() => startOnboardingFor(user)}>
                                            <UserPlus className="h-3.5 w-3.5 text-blue-600" />
                                        </Button>
                                    ) : canEdit && (
                                        isEditing ? (
                                            <div className="flex gap-0.5">
                                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => saveInlineEdit(user.id)} disabled={savingInline}>
                                                    <Check className="h-3.5 w-3.5 text-green-600" />
                                                </Button>
                                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={cancelInlineEdit}>
                                                    <X className="h-3.5 w-3.5 text-gray-400" />
                                                </Button>
                                            </div>
                                        ) : (
                                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startInlineEdit(user)}>
                                                <Pencil className="h-3.5 w-3.5 text-gray-400" />
                                            </Button>
                                        )
                                    )}
                                </div>
                            </div>
                            )
                        })}
                    </div>
                )}
            </CardContent>

            {/* ─── Add Employee Dialog (HR onboarding over one central identity) ──── */}
            <Dialog open={addDialogOpen} onOpenChange={(open) => { setAddDialogOpen(open); if (!open) resetAddForm() }}>
                <DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>{addStep === 'done' ? 'Done' : 'Add Employee'}</DialogTitle>
                        <DialogDescription>
                            {addStep === 'find' && 'Find the person first. Existing accounts are reused (same login, user ID and employee number); no duplicate is created.'}
                            {addStep === 'details' && (candidate ? 'Confirm the person and record their employment details.' : 'No account exists for these details. A new account with employee self-service access will be created.')}
                            {addStep === 'done' && (addResult?.outcome === 'REUSED' ? 'The existing account was kept and HR onboarding is complete.' : 'The employee was created and onboarded.')}
                        </DialogDescription>
                    </DialogHeader>

                    {addStep === 'find' && (
                        <div className="space-y-5">
                            <div className="space-y-2">
                                <Label>Search this organization by name</Label>
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                                    <Input className="pl-10" value={nameQuery} onChange={e => searchByName(e.target.value)} placeholder="Type at least 2 letters" />
                                </div>
                                {nameResults.length > 0 && (
                                    <div className="rounded-md border divide-y max-h-56 overflow-y-auto">
                                        {nameResults.map(r => (
                                            <button key={r.user_id} type="button" disabled={lookupLoading}
                                                className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/50"
                                                onClick={() => lookupCandidate({ user_id: r.user_id })}>
                                                <div className="min-w-0">
                                                    <div className="text-sm font-medium truncate">{r.full_name || 'Unnamed'}</div>
                                                    <div className="text-xs text-muted-foreground truncate">{r.email_masked}{r.employee_no ? ` · EMP-${String(r.employee_no).padStart(4, '0')}` : ''}</div>
                                                </div>
                                                <Badge variant="outline" className="text-[10px] shrink-0">
                                                    {r.onboarding_status === 'completed' ? 'Onboarded' : r.onboarding_status === 'reset' ? 'Reset' : 'Pending'}
                                                </Badge>
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <p className="text-xs text-muted-foreground">Names only help you pick someone; they are never used to match an account.</p>
                            </div>
                            <div className="space-y-2">
                                <Label>Or look up by work email or phone</Label>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <Input type="email" value={lookup.email} onChange={e => setLookup(p => ({ ...p, email: e.target.value }))} placeholder="ahmad@company.com" />
                                    <Input value={lookup.phone} onChange={e => setLookup(p => ({ ...p, phone: e.target.value }))} placeholder="+60123456789" />
                                </div>
                                <Button variant="outline" size="sm" disabled={lookupLoading || (!lookup.email.trim() && !lookup.phone.trim())}
                                    onClick={() => lookupCandidate({ email: lookup.email.trim() || undefined, phone: lookup.phone.trim() || undefined })}>
                                    {lookupLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Search className="h-4 w-4 mr-1" />}
                                    Look up
                                </Button>
                            </div>
                            {lookupError && (
                                <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{lookupError}
                                </div>
                            )}
                        </div>
                    )}

                    {addStep === 'details' && (
                        <div className="space-y-4">
                            {candidate ? (
                                <div className="rounded-lg border p-3 space-y-1">
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="text-sm font-medium">{candidate.full_name || 'Unnamed'}</div>
                                        {candidate.employment?.employee_no && (
                                            <span className="text-xs font-mono text-muted-foreground">EMP-{String(candidate.employment.employee_no).padStart(4, '0')}</span>
                                        )}
                                    </div>
                                    <div className="text-xs text-muted-foreground">{[candidate.email_masked, candidate.phone_masked].filter(Boolean).join(' · ')}</div>
                                    <div className="flex flex-wrap gap-1 pt-1">
                                        <Badge variant="outline" className="text-[10px]">{candidate.has_login ? 'Has login' : 'No login'}</Badge>
                                        {candidate.employment && (
                                            <Badge variant="outline" className="text-[10px]">
                                                HR: {candidate.employment.onboarding_status === 'completed' ? 'onboarded' : candidate.employment.onboarding_status === 'reset' ? 'reset' : 'awaiting onboarding'}
                                            </Badge>
                                        )}
                                    </div>
                                    {candidateBlock && (
                                        <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />{candidateBlock}
                                        </div>
                                    )}
                                    {!candidateBlock && candidate.employment?.onboarding_status === 'completed' && (
                                        <div className="mt-2 text-xs text-green-700">Already onboarded. Submitting again changes nothing.</div>
                                    )}
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div className="space-y-2 sm:col-span-2">
                                        <Label>Full Name *</Label>
                                        <Input value={addForm.full_name} onChange={e => setAddForm(p => ({ ...p, full_name: e.target.value }))} placeholder="e.g. Ahmad bin Ismail" />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Work Email *</Label>
                                        <Input type="email" value={addForm.email} onChange={e => setAddForm(p => ({ ...p, email: e.target.value }))} />
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Phone</Label>
                                        <Input value={addForm.phone} onChange={e => setAddForm(p => ({ ...p, phone: e.target.value }))} placeholder="+60123456789" />
                                    </div>
                                </div>
                            )}

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>Department</Label>
                                    <Select value={addForm.department_id || 'none'} onValueChange={v => setAddForm(p => ({ ...p, department_id: v === 'none' ? '' : v }))}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="none">No department</SelectItem>
                                            {departments.map(d => (
                                                <SelectItem key={d.id} value={d.id}>{d.dept_code ? `${d.dept_code} - ` : ''}{d.dept_name}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label>Position</Label>
                                    <Select value={addForm.position_id || 'none'} onValueChange={v => setAddForm(p => ({ ...p, position_id: v === 'none' ? '' : v }))}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="none">No position</SelectItem>
                                            {positions.map(p => (
                                                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label>Reports To</Label>
                                    <Select value={addForm.manager_user_id || 'none'} onValueChange={v => setAddForm(p => ({ ...p, manager_user_id: v === 'none' ? '' : v }))}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="none">Top leader</SelectItem>
                                            {users.filter(u => u.id !== candidate?.user_id).map(u => (
                                                <SelectItem key={u.id} value={u.id}>{u.full_name || u.email}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label>Employment Type</Label>
                                    <Select value={addForm.employment_type} onValueChange={v => setAddForm(p => ({ ...p, employment_type: v }))}>
                                        <SelectTrigger><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="Full-time">Full-time</SelectItem>
                                            <SelectItem value="Part-time">Part-time</SelectItem>
                                            <SelectItem value="Contract">Contract</SelectItem>
                                            <SelectItem value="Intern">Intern</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label>Actual Hire Date *</Label>
                                    <Input type="date" value={addForm.hire_date} onChange={e => setAddForm(p => ({ ...p, hire_date: e.target.value }))} />
                                    <p className="text-[11px] text-muted-foreground">The date employment started — not the date the login was created.</p>
                                </div>
                            </div>
                            <p className="text-xs text-muted-foreground">HR onboarding records employment facts only. It does not change the person&apos;s login, credentials or access; access is managed in Security &amp; Access.</p>
                            <DialogFooter className="gap-2 sm:gap-0">
                                <Button variant="outline" onClick={() => { setAddStep('find'); setCandidate(null); setCandidateBlock(null) }}>
                                    <ArrowLeft className="h-4 w-4 mr-1" />Back
                                </Button>
                                <Button onClick={handleAddEmployee}
                                    disabled={addLoading || !!candidateBlock || !addForm.hire_date || (!candidate && (!addForm.full_name.trim() || !addForm.email.trim()))}>
                                    {addLoading ? <><Loader2 className="h-4 w-4 animate-spin mr-1" />Saving...</> : <><UserPlus className="h-4 w-4 mr-1" />{candidate ? 'Complete Onboarding' : 'Create & Onboard'}</>}
                                </Button>
                            </DialogFooter>
                        </div>
                    )}

                    {addStep === 'done' && addResult && (
                        <div className="space-y-4">
                            <div className="rounded-lg border p-4 bg-green-50 space-y-2">
                                <div className="text-sm font-medium text-green-800">
                                    {addResult.onboarding === 'ALREADY_ONBOARDED' ? 'This person was already onboarded — nothing changed.'
                                        : addResult.outcome === 'REUSED' ? 'Existing account kept — no duplicate created.' : 'Employee created and onboarded.'}
                                </div>
                                {addResult.employee_no && (
                                    <div className="text-sm text-green-700">Employee No: <span className="font-mono font-medium">EMP-{String(addResult.employee_no).padStart(4, '0')}</span></div>
                                )}
                                <div className="text-xs text-green-700">Access beyond employee self-service is granted in Security &amp; Access.</div>
                            </div>
                            {addResult.temp_password && (
                                <div className="rounded-lg border p-4 bg-yellow-50 space-y-2">
                                    <div className="text-sm font-medium text-yellow-800">Login Credentials</div>
                                    <div className="text-sm text-yellow-700">
                                        <div>Email: <span className="font-mono">{addForm.email}</span></div>
                                        <div className="flex items-center gap-2">
                                            Temporary password: <span className="font-mono font-medium">{addResult.temp_password}</span>
                                            <Button variant="ghost" size="sm" className="h-6 px-1"
                                                onClick={() => { navigator.clipboard.writeText(addResult.temp_password!); toast({ title: 'Copied' }) }}>
                                                <Copy className="h-3 w-3" />
                                            </Button>
                                        </div>
                                    </div>
                                    <div className="text-xs text-yellow-600">Save these credentials. The password cannot be retrieved later.</div>
                                </div>
                            )}
                            <DialogFooter>
                                <Button onClick={() => { setAddDialogOpen(false); resetAddForm() }}>Done</Button>
                                <Button variant="outline" onClick={resetAddForm}>Add Another</Button>
                            </DialogFooter>
                        </div>
                    )}
                </DialogContent>
            </Dialog>

            {/* ─── HR Profile Sheet (slide-out) ────────────────────── */}
            <Sheet open={profileOpen} onOpenChange={setProfileOpen}>
                <SheetContent className="sm:max-w-[520px] overflow-y-auto">
                    <SheetHeader>
                        <SheetTitle className="flex items-center gap-3">
                            {profileUser && (
                                <>
                                    <div className="relative group">
                                        <Avatar className="h-10 w-10">
                                            <AvatarImage src={profileUser.avatar_url || undefined} />
                                            <AvatarFallback>{(profileUser.full_name || 'U').slice(0, 2).toUpperCase()}</AvatarFallback>
                                        </Avatar>
                                        {canEdit && (
                                            <button
                                                type="button"
                                                onClick={() => avatarInputRef.current?.click()}
                                                disabled={avatarUploading}
                                                className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                            >
                                                {avatarUploading ? (
                                                    <Loader2 className="h-4 w-4 text-white animate-spin" />
                                                ) : (
                                                    <Camera className="h-4 w-4 text-white" />
                                                )}
                                            </button>
                                        )}
                                        <input
                                            ref={avatarInputRef}
                                            type="file"
                                            accept="image/*"
                                            className="hidden"
                                            onChange={handleAvatarUpload}
                                        />
                                    </div>
                                    <div>
                                        <div>{profileUser.full_name || 'Unknown'}</div>
                                        <div className="text-xs text-gray-500 font-normal">
                                            {profileUser.employee_no ? `EMP-${String(profileUser.employee_no).padStart(4, '0')}` : 'No EMP#'}
                                            {' • '}{profileUser.email}
                                        </div>
                                    </div>
                                </>
                            )}
                        </SheetTitle>
                        <SheetDescription>
                            HR profile details. {canEdit ? 'Changes are saved when you click Save.' : 'View only.'}
                        </SheetDescription>
                    </SheetHeader>

                    {profileLoading ? (
                        <div className="py-12 text-center text-gray-500"><Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />Loading profile...</div>
                    ) : (
                        <div className="mt-4 space-y-4">
                            <Tabs value={profileTab} onValueChange={setProfileTab}>
                                <TabsList className="grid w-full grid-cols-4">
                                    <TabsTrigger value="personal" className="text-xs">Personal</TabsTrigger>
                                    <TabsTrigger value="identity" className="text-xs">ID &amp; Tax</TabsTrigger>
                                    <TabsTrigger value="emergency" className="text-xs">Emergency</TabsTrigger>
                                    <TabsTrigger value="bank" className="text-xs">Bank</TabsTrigger>
                                </TabsList>

                                {/* Personal */}
                                <TabsContent value="personal" className="space-y-3 mt-3">
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <Label className="text-xs">Gender</Label>
                                            <Select value={profileData.gender || 'none'} onValueChange={v => updateProfileField('gender', v === 'none' ? null : v)} disabled={!canEdit}>
                                                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="none">Not set</SelectItem>
                                                    <SelectItem value="male">Male</SelectItem>
                                                    <SelectItem value="female">Female</SelectItem>
                                                    <SelectItem value="other">Other</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">Date of Birth</Label>
                                            <Input type="date" className="h-9" value={profileData.date_of_birth || ''} onChange={e => updateProfileField('date_of_birth', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <Label className="text-xs">Marital Status</Label>
                                            <Select value={profileData.marital_status || 'none'} onValueChange={v => updateProfileField('marital_status', v === 'none' ? null : v)} disabled={!canEdit}>
                                                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="none">Not set</SelectItem>
                                                    <SelectItem value="single">Single</SelectItem>
                                                    <SelectItem value="married">Married</SelectItem>
                                                    <SelectItem value="divorced">Divorced</SelectItem>
                                                    <SelectItem value="widowed">Widowed</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">Nationality</Label>
                                            <Input className="h-9" value={profileData.nationality || ''} onChange={e => updateProfileField('nationality', e.target.value || null)} placeholder="e.g. Malaysian" disabled={!canEdit} />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <Label className="text-xs">Religion</Label>
                                            <Input className="h-9" value={profileData.religion || ''} onChange={e => updateProfileField('religion', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">Blood Type</Label>
                                            <Select value={profileData.blood_type || 'none'} onValueChange={v => updateProfileField('blood_type', v === 'none' ? null : v)} disabled={!canEdit}>
                                                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="none">Not set</SelectItem>
                                                    {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map(bt => (
                                                        <SelectItem key={bt} value={bt}>{bt}</SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <Label className="text-xs">Personal Email</Label>
                                            <Input className="h-9" type="email" value={profileData.personal_email || ''} onChange={e => updateProfileField('personal_email', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">Personal Phone</Label>
                                            <Input className="h-9" value={profileData.personal_phone || ''} onChange={e => updateProfileField('personal_phone', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs">Highest Education</Label>
                                        <Select value={profileData.highest_education || 'none'} onValueChange={v => updateProfileField('highest_education', v === 'none' ? null : v)} disabled={!canEdit}>
                                            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">Not set</SelectItem>
                                                <SelectItem value="primary">Primary</SelectItem>
                                                <SelectItem value="secondary">Secondary / SPM</SelectItem>
                                                <SelectItem value="diploma">Diploma</SelectItem>
                                                <SelectItem value="degree">Degree</SelectItem>
                                                <SelectItem value="masters">Masters</SelectItem>
                                                <SelectItem value="phd">PhD</SelectItem>
                                                <SelectItem value="professional">Professional Cert</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <Label className="text-xs">Institution</Label>
                                            <Input className="h-9" value={profileData.education_institution || ''} onChange={e => updateProfileField('education_institution', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">Field of Study</Label>
                                            <Input className="h-9" value={profileData.education_field || ''} onChange={e => updateProfileField('education_field', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs">Address</Label>
                                        <Input className="h-9 mb-1" value={profileData.address_line1 || ''} onChange={e => updateProfileField('address_line1', e.target.value || null)} placeholder="Line 1" disabled={!canEdit} />
                                        <Input className="h-9" value={profileData.address_line2 || ''} onChange={e => updateProfileField('address_line2', e.target.value || null)} placeholder="Line 2" disabled={!canEdit} />
                                    </div>
                                    <div className="grid grid-cols-3 gap-3">
                                        <div className="space-y-1">
                                            <Label className="text-xs">City</Label>
                                            <Input className="h-9" value={profileData.city || ''} onChange={e => updateProfileField('city', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">State</Label>
                                            <Input className="h-9" value={profileData.state || ''} onChange={e => updateProfileField('state', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">Postcode</Label>
                                            <Input className="h-9" value={profileData.postcode || ''} onChange={e => updateProfileField('postcode', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                    </div>
                                </TabsContent>

                                {/* Identity & Tax */}
                                <TabsContent value="identity" className="space-y-3 mt-3">
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <Label className="text-xs">IC Number (NRIC)</Label>
                                            <Input className="h-9" value={profileData.ic_number || ''} onChange={e => updateProfileField('ic_number', e.target.value || null)} placeholder="e.g. 900101-01-1234" disabled={!canEdit} />
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">Passport Number</Label>
                                            <Input className="h-9" value={profileData.passport_number || ''} onChange={e => updateProfileField('passport_number', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <Label className="text-xs">Tax ID (LHDN)</Label>
                                            <Input className="h-9" value={profileData.tax_id || ''} onChange={e => updateProfileField('tax_id', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">SOCSO (PERKESO)</Label>
                                            <Input className="h-9" value={profileData.socso_number || ''} onChange={e => updateProfileField('socso_number', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <Label className="text-xs">EPF (KWSP)</Label>
                                            <Input className="h-9" value={profileData.epf_number || ''} onChange={e => updateProfileField('epf_number', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">EIS Number</Label>
                                            <Input className="h-9" value={profileData.eis_number || ''} onChange={e => updateProfileField('eis_number', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                    </div>
                                </TabsContent>

                                {/* Emergency Contact */}
                                <TabsContent value="emergency" className="space-y-3 mt-3">
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="space-y-1">
                                            <Label className="text-xs">Contact Name</Label>
                                            <Input className="h-9" value={profileData.emergency_name || ''} onChange={e => updateProfileField('emergency_name', e.target.value || null)} disabled={!canEdit} />
                                        </div>
                                        <div className="space-y-1">
                                            <Label className="text-xs">Relationship</Label>
                                            <Input className="h-9" value={profileData.emergency_relationship || ''} onChange={e => updateProfileField('emergency_relationship', e.target.value || null)} placeholder="e.g. Spouse, Parent" disabled={!canEdit} />
                                        </div>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs">Emergency Phone</Label>
                                        <Input className="h-9" value={profileData.emergency_phone || ''} onChange={e => updateProfileField('emergency_phone', e.target.value || null)} disabled={!canEdit} />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs">Emergency Address</Label>
                                        <Textarea value={profileData.emergency_address || ''} onChange={e => updateProfileField('emergency_address', e.target.value || null)} rows={2} disabled={!canEdit} />
                                    </div>
                                </TabsContent>

                                {/* Bank Details */}
                                <TabsContent value="bank" className="space-y-3 mt-3">
                                    <div className="text-xs text-gray-500 mb-2">Used for payroll. Overrides the bank info from User Management if set.</div>
                                    <div className="space-y-1">
                                        <Label className="text-xs">Bank Name</Label>
                                        <Input className="h-9" value={profileData.bank_name || ''} onChange={e => updateProfileField('bank_name', e.target.value || null)} placeholder="e.g. Maybank, CIMB" disabled={!canEdit} />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs">Account Number</Label>
                                        <Input className="h-9" value={profileData.bank_account_no || ''} onChange={e => updateProfileField('bank_account_no', e.target.value || null)} disabled={!canEdit} />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs">Account Holder Name</Label>
                                        <Input className="h-9" value={profileData.bank_holder_name || ''} onChange={e => updateProfileField('bank_holder_name', e.target.value || null)} disabled={!canEdit} />
                                    </div>
                                </TabsContent>
                            </Tabs>

                            {/* Notes */}
                            <div className="space-y-1 pt-2 border-t">
                                <Label className="text-xs">HR Notes</Label>
                                <Textarea value={profileData.notes || ''} onChange={e => updateProfileField('notes', e.target.value || null)} rows={2} placeholder="Internal notes..." disabled={!canEdit} />
                            </div>

                            {canEdit && (
                                <div className="flex justify-end pt-2">
                                    <Button onClick={saveProfile} disabled={profileSaving}>
                                        {profileSaving ? <><Loader2 className="h-4 w-4 animate-spin mr-1" />Saving...</> : <><Save className="h-4 w-4 mr-1" />Save Profile</>}
                                    </Button>
                                </div>
                            )}
                        </div>
                    )}
                </SheetContent>
            </Sheet>
        </Card>
    )
}
