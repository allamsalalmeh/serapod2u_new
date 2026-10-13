'use client'

import { useState, useEffect, useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Plus,
  Edit,
  Users,
  UserPlus,
  Loader2,
  Building2,
  UserCheck,
  ToggleLeft,
  ToggleRight,
  AlertTriangle,
  Search,
  UserX,
  ArrowRight,
  Network,
  ArrowLeft,
  X,
  FileText,
  Sparkles,
  CheckCircle2
} from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import UserDialogNew from '@/components/users/UserDialogNew'
import { createUserWithAuth, updateUserWithAuth } from '@/lib/actions'
import { compressAvatar, formatFileSize } from '@/lib/utils/imageCompression'
import type { User, Organization } from '@/types/user'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import {
  listDepartments,
  createDepartment,
  updateDepartment,
  setDepartmentActive,
  getUsersForOrgPicker,
  getDepartmentMembers,
  getOrgUsersForDepartmentManagement,
  getRolesForDepartmentManagement,
  bulkAssignUsersToDepartment,
  bulkMoveUsersToDepartment,
  bulkRemoveUsersFromDepartment,
  updateUserManager,
  createUserForDepartment,
  type Department,
  type DepartmentMember,
  type RoleOption,
  type CreateDepartmentPayload,
  type UpdateDepartmentPayload
} from '@/lib/actions/departments'
import DepartmentDetailDrawer from './DepartmentDetailDrawer'

interface DepartmentsTabProps {
  organizationId: string
  canEdit: boolean
  onNavigateToOrgChart?: () => void
}

interface OrgUser {
  id: string
  full_name: string | null
  email: string
}

type DepartmentCreateStep = 'list' | 'create' | 'success'
type DepartmentCreateStatus = 'active' | 'disabled' | 'draft'

interface DepartmentCreateForm {
  dept_code: string
  dept_name: string
  manager_user_id: string
  sort_order: string
  parent_department_id: string
  status: DepartmentCreateStatus
  notes: string
}

const emptyDepartmentCreateForm = (): DepartmentCreateForm => ({
  dept_code: '',
  dept_name: '',
  manager_user_id: '',
  sort_order: '',
  parent_department_id: '',
  status: 'active',
  notes: ''
})

const suggestDepartmentCode = (name: string) => {
  const cleaned = name.trim().replace(/&/g, ' and ').replace(/[^a-zA-Z0-9\s]/g, ' ')
  const words = cleaned.split(/\s+/).filter(Boolean)
  if (!words.length) return ''

  const normalized = words.map(word => word.toLowerCase())
  if (normalized.includes('human') && normalized.includes('resources')) return 'HR'
  if (normalized.includes('information') && normalized.includes('technology')) return 'IT'
  if (normalized.includes('finance') && normalized.includes('accounting')) return 'FIN'
  if (normalized.includes('operations')) return 'OPS'
  if (normalized.includes('warehouse')) return 'WH'
  if (normalized.includes('sales')) return 'SALES'

  if (words.length === 1) return words[0].slice(0, 4).toUpperCase()
  return words.map(word => word[0]).join('').slice(0, 5).toUpperCase()
}

const departmentStatusLabel = (status: DepartmentCreateStatus) => {
  if (status === 'disabled') return 'Disabled'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

export default function DepartmentsTab({ organizationId, canEdit, onNavigateToOrgChart }: DepartmentsTabProps) {
  const { isReady, supabase, userProfile } = useSupabaseAuth() as ReturnType<typeof useSupabaseAuth> & {
    userProfile?: { id: string; role_code: string } | null
  }
  const [currentOrg, setCurrentOrg] = useState<Organization | null>(null)
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [showDisabled, setShowDisabled] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [createStep, setCreateStep] = useState<DepartmentCreateStep>('list')
  const [createForm, setCreateForm] = useState<DepartmentCreateForm>(() => emptyDepartmentCreateForm())
  const [createdDepartment, setCreatedDepartment] = useState<Department | null>(null)
  const [createdSummary, setCreatedSummary] = useState<DepartmentCreateForm | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingDept, setEditingDept] = useState<Department | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([])
  const [confirmDisable, setConfirmDisable] = useState<{ dept: Department; userCount: number } | null>(null)
  const [membersOpen, setMembersOpen] = useState(false)
  const [selectedDepartment, setSelectedDepartment] = useState<Department | null>(null)
  const [members, setMembers] = useState<DepartmentMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [orgMembers, setOrgMembers] = useState<DepartmentMember[]>([])
  const [roles, setRoles] = useState<RoleOption[]>([])
  const [bulkSearch, setBulkSearch] = useState('')
  const [bulkRoleFilter, setBulkRoleFilter] = useState('all')
  const [bulkDeptFilter, setBulkDeptFilter] = useState('all')
  const [selectedBulkUsers, setSelectedBulkUsers] = useState<Set<string>>(new Set())
  const [bulkAction, setBulkAction] = useState<{ type: 'assign' | 'move' | 'remove'; count: number } | null>(null)
  const [createUserOpen, setCreateUserOpen] = useState(false)
  const [creatingUser, setCreatingUser] = useState(false)
  
  // Department Detail Drawer state
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false)
  const [detailDepartmentId, setDetailDepartmentId] = useState<string | null>(null)

  // Form state
  const [formData, setFormData] = useState({
    dept_code: '',
    dept_name: '',
    manager_user_id: '',
    sort_order: '',
    parent_department_id: ''
  })

  const { toast } = useToast()

  useEffect(() => {
    loadDepartments()
    loadUsers()
    loadRoles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, showDisabled])

  useEffect(() => {
    if (organizationId && isReady && supabase) {
      const fetchOrg = async () => {
        const { data } = await supabase.from('organizations').select('*').eq('id', organizationId).single()
        if (data) setCurrentOrg(data)
      }
      fetchOrg()
    }
  }, [organizationId, isReady, supabase])

  const loadDepartments = async () => {
    setLoading(true)
    const result = await listDepartments(organizationId, showDisabled)
    if (result.success && result.data) {
      setDepartments(result.data)
    } else {
      toast({
        title: 'Error',
        description: result.error || 'Failed to load departments',
        variant: 'destructive'
      })
    }
    setLoading(false)
  }

  const loadUsers = async () => {
    const result = await getUsersForOrgPicker(organizationId)
    if (result.success && result.data) {
      setOrgUsers(result.data)
    }
  }

  const loadRoles = async () => {
    const result = await getRolesForDepartmentManagement()
    if (result.success && result.data) {
      setRoles(result.data)
    }
  }

  const loadMembers = async (dept: Department) => {
    setMembersLoading(true)
    const [membersResult, orgUsersResult] = await Promise.all([
      getDepartmentMembers(dept.id),
      getOrgUsersForDepartmentManagement(organizationId)
    ])

    if (membersResult.success && membersResult.data) {
      setMembers(membersResult.data)
    } else {
      toast({
        title: 'Error',
        description: membersResult.error || 'Failed to load members',
        variant: 'destructive'
      })
    }

    if (orgUsersResult.success && orgUsersResult.data) {
      setOrgMembers(orgUsersResult.data)
    }

    setMembersLoading(false)
  }

  const handleOpenMembers = async (dept: Department) => {
    setSelectedDepartment(dept)
    setMembersOpen(true)
    setSelectedBulkUsers(new Set())
    await loadMembers(dept)
  }

  const refreshMembers = async () => {
    if (selectedDepartment) {
      await loadMembers(selectedDepartment)
    }
    await loadDepartments()
  }

  const handleOpenDialog = (dept?: Department) => {
    if (dept) {
      setEditingDept(dept)
      setFormData({
        dept_code: dept.dept_code || '',
        dept_name: dept.dept_name,
        manager_user_id: dept.manager_user_id || '',
        sort_order: dept.sort_order?.toString() || '',
        parent_department_id: (dept as any).parent_department_id || ''
      })
    } else {
      setEditingDept(null)
      setFormData({
        dept_code: '',
        dept_name: '',
        manager_user_id: '',
        sort_order: '',
        parent_department_id: ''
      })
    }
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!formData.dept_name.trim()) {
      toast({
        title: 'Validation Error',
        description: 'Department name is required',
        variant: 'destructive'
      })
      return
    }

    setIsSaving(true)

    try {
      if (editingDept) {
        // Update existing
        const payload: UpdateDepartmentPayload = {
          dept_code: formData.dept_code || null,
          dept_name: formData.dept_name,
          manager_user_id: formData.manager_user_id || null,
          sort_order: formData.sort_order ? parseInt(formData.sort_order) : null,
          parent_department_id: formData.parent_department_id || null
        }

        const result = await updateDepartment(editingDept.id, payload)

        if (result.success) {
          toast({
            title: 'Success',
            description: 'Department updated successfully'
          })
          setDialogOpen(false)
          loadDepartments()
        } else {
          toast({
            title: 'Error',
            description: result.error || 'Failed to update department',
            variant: 'destructive'
          })
        }
      } else {
        // Create new
        const payload: CreateDepartmentPayload = {
          dept_code: formData.dept_code || null,
          dept_name: formData.dept_name,
          manager_user_id: formData.manager_user_id || null,
          sort_order: formData.sort_order ? parseInt(formData.sort_order) : null,
          parent_department_id: formData.parent_department_id || null
        }

        const result = await createDepartment(organizationId, payload)

        if (result.success) {
          toast({
            title: 'Success',
            description: 'Department created successfully'
          })
          setDialogOpen(false)
          loadDepartments()
        } else {
          toast({
            title: 'Error',
            description: result.error || 'Failed to create department',
            variant: 'destructive'
          })
        }
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: 'An unexpected error occurred',
        variant: 'destructive'
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleToggleActive = async (dept: Department) => {
    if (dept.is_active) {
      // Check for users before disabling
      if (dept.user_count && dept.user_count > 0) {
        setConfirmDisable({ dept, userCount: dept.user_count })
        return
      }
    }

    await toggleDepartmentStatus(dept)
  }

  const toggleDepartmentStatus = async (dept: Department) => {
    const result = await setDepartmentActive(dept.id, !dept.is_active)

    if (result.success) {
      toast({
        title: 'Success',
        description: `Department ${dept.is_active ? 'disabled' : 'enabled'} successfully`
      })
      loadDepartments()
    } else {
      toast({
        title: 'Error',
        description: result.error || 'Failed to update department status',
        variant: 'destructive'
      })
    }
  }

  const departmentMap = useMemo(() => {
    return departments.reduce((acc, dept) => {
      acc[dept.id] = dept
      return acc
    }, {} as Record<string, Department>)
  }, [departments])

  const activeDepartments = useMemo(() => departments.filter(d => d.is_active), [departments])

  const selectedCreateManager = useMemo(() => (
    orgUsers.find(user => user.id === createForm.manager_user_id) || null
  ), [orgUsers, createForm.manager_user_id])

  const selectedCreateParent = useMemo(() => (
    departments.find(dept => dept.id === createForm.parent_department_id) || null
  ), [departments, createForm.parent_department_id])

  const createDeptErrors = useMemo(() => {
    const code = createForm.dept_code.trim().toUpperCase()
    const name = createForm.dept_name.trim()
    const duplicateCode = code
      ? departments.some(dept => (dept.dept_code || '').toUpperCase() === code)
      : false
    const duplicateName = name
      ? departments.some(dept => dept.dept_name.trim().toLowerCase() === name.toLowerCase())
      : false
    const sortOrderInvalid = createForm.sort_order.trim() !== '' && Number.isNaN(Number(createForm.sort_order))

    return {
      dept_name: !name
        ? 'Department name is required.'
        : duplicateName
          ? 'A department with this name already exists.'
          : '',
      dept_code: duplicateCode ? 'A department with this code already exists.' : '',
      sort_order: sortOrderInvalid ? 'Sort order must be a number.' : ''
    }
  }, [createForm.dept_code, createForm.dept_name, createForm.sort_order, departments])

  const canCreateDepartment = !createDeptErrors.dept_name && !createDeptErrors.dept_code && !createDeptErrors.sort_order

  const updateCreateForm = (updates: Partial<DepartmentCreateForm>) => {
    setCreateForm(prev => ({ ...prev, ...updates }))
  }

  const resetCreateFlow = () => {
    setCreateForm(emptyDepartmentCreateForm())
    setCreatedDepartment(null)
    setCreatedSummary(null)
  }

  const handleOpenCreate = () => {
    resetCreateFlow()
    setCreateStep('create')
  }

  const handleCreateNameChange = (deptName: string) => {
    setCreateForm(prev => ({
      ...prev,
      dept_name: deptName,
      dept_code: prev.dept_code ? prev.dept_code : suggestDepartmentCode(deptName)
    }))
  }

  const handleSuggestCode = () => {
    updateCreateForm({ dept_code: suggestDepartmentCode(createForm.dept_name) })
  }

  const handleCancelCreate = () => {
    resetCreateFlow()
    setCreateStep('list')
  }

  const handleCreateAnother = () => {
    resetCreateFlow()
    setCreateStep('create')
  }

  const handleGoToDepartments = () => {
    resetCreateFlow()
    setCreateStep('list')
    loadDepartments()
  }

  const handleViewDepartment = () => {
    if (createdDepartment) {
      setSearchQuery(createdDepartment.dept_code || createdDepartment.dept_name)
    }
    handleGoToDepartments()
  }

  const handleCreateDepartment = async (statusOverride?: DepartmentCreateStatus) => {
    const nextStatus = statusOverride || createForm.status
    if (!canCreateDepartment) {
      toast({
        title: 'Validation Error',
        description: createDeptErrors.dept_name || createDeptErrors.dept_code || createDeptErrors.sort_order,
        variant: 'destructive'
      })
      return
    }

    const summary = { ...createForm, status: nextStatus }
    const payload: CreateDepartmentPayload = {
      dept_code: createForm.dept_code.trim() ? createForm.dept_code.trim().toUpperCase() : null,
      dept_name: createForm.dept_name.trim(),
      manager_user_id: createForm.manager_user_id || null,
      sort_order: createForm.sort_order.trim() ? Number(createForm.sort_order) : null,
      parent_department_id: createForm.parent_department_id || null,
      is_active: nextStatus === 'active'
    }

    setIsSaving(true)
    try {
      const result = await createDepartment(organizationId, payload)

      if (result.success && result.data) {
        setCreatedDepartment(result.data)
        setCreatedSummary(summary)
        setCreateStep('success')
        loadDepartments()
      } else {
        toast({
          title: 'Error',
          description: result.error || 'Failed to create department',
          variant: 'destructive'
        })
      }
    } finally {
      setIsSaving(false)
    }
  }

  const filteredBulkUsers = useMemo(() => {
    const search = bulkSearch.toLowerCase()
    return orgMembers.filter(user => {
      const matchesSearch =
        user.full_name?.toLowerCase().includes(search) ||
        user.email.toLowerCase().includes(search) ||
        (user.phone || '').toLowerCase().includes(search)

      const matchesRole = bulkRoleFilter === 'all' || user.role_code === bulkRoleFilter

      const matchesDept =
        bulkDeptFilter === 'all' ||
        (bulkDeptFilter === 'none'
          ? !user.department_id
          : user.department_id === bulkDeptFilter)

      return matchesSearch && matchesRole && matchesDept
    })
  }, [bulkSearch, bulkRoleFilter, bulkDeptFilter, orgMembers])

  const toggleBulkSelection = (userId: string) => {
    setSelectedBulkUsers(prev => {
      const next = new Set(prev)
      if (next.has(userId)) {
        next.delete(userId)
      } else {
        next.add(userId)
      }
      return next
    })
  }

  const setAllBulkSelection = (checked: boolean) => {
    if (checked) {
      setSelectedBulkUsers(new Set(filteredBulkUsers.map(u => u.id)))
    } else {
      setSelectedBulkUsers(new Set())
    }
  }

  const handleBulkAction = (type: 'assign' | 'move' | 'remove') => {
    if (!selectedDepartment) return
    const count = selectedBulkUsers.size
    if (count === 0) {
      toast({
        title: 'No users selected',
        description: 'Select at least one user to continue.',
        variant: 'destructive'
      })
      return
    }
    setBulkAction({ type, count })
  }

  const confirmBulkAction = async () => {
    if (!selectedDepartment || !bulkAction) return

    const ids = Array.from(selectedBulkUsers)
    let result: { success: boolean; error?: string } = { success: false }

    if (bulkAction.type === 'assign') {
      result = await bulkAssignUsersToDepartment(selectedDepartment.id, ids)
    }

    if (bulkAction.type === 'move') {
      result = await bulkMoveUsersToDepartment(null, selectedDepartment.id, ids)
    }

    if (bulkAction.type === 'remove') {
      result = await bulkRemoveUsersFromDepartment(selectedDepartment.id, ids)
    }

    if (result.success) {
      toast({
        title: 'Success',
        description: 'Bulk update completed.'
      })
      setSelectedBulkUsers(new Set())
      await refreshMembers()
    } else {
      toast({
        title: 'Error',
        description: result.error || 'Bulk update failed',
        variant: 'destructive'
      })
    }

    setBulkAction(null)
  }

  const handleRemoveMember = async (userId: string) => {
    if (!selectedDepartment) return
    const result = await bulkRemoveUsersFromDepartment(selectedDepartment.id, [userId])
    if (result.success) {
      toast({ title: 'Removed', description: 'User removed from department.' })
      await refreshMembers()
    } else {
      toast({ title: 'Error', description: result.error || 'Failed to remove user', variant: 'destructive' })
    }
  }

  const handleMoveMember = async (userId: string, targetDeptId: string) => {
    if (!selectedDepartment) return
    const result = await bulkMoveUsersToDepartment(selectedDepartment.id, targetDeptId, [userId])
    if (result.success) {
      toast({ title: 'Moved', description: 'User moved to new department.' })
      await refreshMembers()
    } else {
      toast({ title: 'Error', description: result.error || 'Failed to move user', variant: 'destructive' })
    }
  }

  const handleManagerUpdate = async (userId: string, managerId: string | null) => {
    const result = await updateUserManager(userId, managerId)
    if (result.success) {
      toast({ title: 'Updated', description: 'Manager updated.' })
      await refreshMembers()
    } else {
      toast({ title: 'Error', description: result.error || 'Failed to update manager', variant: 'destructive' })
    }
  }

  const handleSaveUser = async (
    userData: Partial<User> & { password?: string },
    avatarFile?: File | null
  ) => {
    if (!selectedDepartment) return

    try {
      setCreatingUser(true)

      // 1. Create User
      if (!userData.email || !userData.full_name || !userData.password) {
        throw new Error("Email, Name, and Password are required")
      }

      const result = await createUserWithAuth({
        email: userData.email,
        password: userData.password,
        full_name: userData.full_name,
        organization_id: organizationId,
        phone: userData.phone || undefined,
      })

      if (!result.success || !result.user_id) {
        throw new Error(!result.success ? result.error : "Failed to create user")
      }

      const userId = result.user_id

      // 2. Handle Avatar
      let avatarUrl = null
      if (avatarFile) {
        try {
          const compressionResult = await compressAvatar(avatarFile)
          const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`
          const filePath = `${userId}/${fileName}`

          const { error: uploadError } = await supabase.storage
            .from("avatars")
            .upload(filePath, compressionResult.file, {
              contentType: compressionResult.file.type,
              cacheControl: "3600",
              upsert: true,
            })

          if (!uploadError) {
            const { data: urlData } = supabase.storage.from("avatars").getPublicUrl(filePath)
            avatarUrl = urlData.publicUrl
          }
        } catch (e) {
          console.error("Avatar upload error", e)
        }
      }

      // 3. Update User with Dept, Manager & Avatar
      const updatePayload: any = {
        department_id: selectedDepartment.id,
        manager_user_id: userData.manager_user_id || undefined,
      }

      if (avatarUrl) {
        updatePayload.avatar_url = avatarUrl
      }

      // We user updateUserWithAuth to ensure permissions and proper logging if available
      // Or simply update via supabase if we trust the context (DepartmentsTab is usually admin)
      // updateUserWithAuth requires caller context.
      if (userProfile) {
        await updateUserWithAuth(userId, updatePayload, {
          id: userProfile.id,
          role_code: userProfile.role_code
        })
      } else {
        // Fallback if no profile?? Should not happen if authenticated.
        // Direct update via supabase as fallback (RLS permitting)
        await supabase.from('users').update(updatePayload).eq('id', userId)
      }

      toast({
        title: 'User created',
        description: 'User created successfully.',
      })
      setCreateUserOpen(false)
      await refreshMembers()
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to create user',
        variant: 'destructive'
      })
    } finally {
      setCreatingUser(false)
    }
  }

  // Filter departments by search
  const filteredDepartments = departments.filter(d => {
    const search = searchQuery.toLowerCase()
    return (
      d.dept_name.toLowerCase().includes(search) ||
      (d.dept_code && d.dept_code.toLowerCase().includes(search)) ||
      (d.manager?.full_name && d.manager.full_name.toLowerCase().includes(search))
    )
  })

  if (createStep === 'create') {
    const previewCode = createForm.dept_code.trim().toUpperCase() || 'DEPT'
    const previewName = createForm.dept_name.trim() || 'New Department'
    const previewManager = selectedCreateManager?.full_name || selectedCreateManager?.email || 'Not assigned'
    const previewParent = selectedCreateParent?.dept_name || 'Root level'
    const previewSortOrder = createForm.sort_order.trim() || '—'

    return (
      <div className="space-y-5">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>HR</span>
          <ArrowRight className="h-3 w-3" />
          <span>People</span>
          <ArrowRight className="h-3 w-3" />
          <span>Departments</span>
          <ArrowRight className="h-3 w-3" />
          <span className="font-medium text-gray-800">Create Department</span>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
          <div className="rounded-lg border bg-white shadow-sm">
            <div className="flex flex-col gap-4 border-b p-5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-4">
                <Button variant="outline" size="icon" className="h-11 w-11 shrink-0" onClick={handleCancelCreate}>
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight text-gray-950">Create Department</h2>
                  <p className="text-sm text-gray-500">Set up a department for your organization structure.</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => handleCreateDepartment('draft')}
                  disabled={isSaving || !canCreateDepartment}
                >
                  <FileText className="mr-2 h-4 w-4" />
                  {isSaving ? 'Saving...' : 'Save as Draft'}
                </Button>
                <Button variant="outline" size="icon" onClick={handleCancelCreate}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-4 p-5">
              <section className="rounded-lg border p-5">
                <div className="mb-5 flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">
                    1
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-gray-950">Basic Information</h3>
                    <p className="text-sm text-gray-500">Enter the essential details for this department.</p>
                  </div>
                </div>

                <div className="grid gap-5 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="create-dept-name">Department Name <span className="text-red-500">*</span></Label>
                    <Input
                      id="create-dept-name"
                      value={createForm.dept_name}
                      onChange={(event) => handleCreateNameChange(event.target.value)}
                      placeholder="e.g., Operations"
                      className={createDeptErrors.dept_name ? 'border-red-300 focus-visible:ring-red-200' : ''}
                    />
                    <p className="text-xs text-gray-500">The full name of the department</p>
                    {createDeptErrors.dept_name && <p className="text-xs text-red-600">{createDeptErrors.dept_name}</p>}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="create-dept-code">Department Code <span className="text-gray-400">(optional)</span></Label>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        id="create-dept-code"
                        value={createForm.dept_code}
                        onChange={(event) => updateCreateForm({ dept_code: event.target.value.toUpperCase() })}
                        placeholder="e.g., OPS"
                        maxLength={20}
                        className={createDeptErrors.dept_code ? 'border-red-300 focus-visible:ring-red-200' : ''}
                      />
                      <Button type="button" variant="outline" onClick={handleSuggestCode} disabled={!createForm.dept_name.trim()}>
                        <Sparkles className="mr-2 h-4 w-4" />
                        Auto-suggest
                      </Button>
                    </div>
                    <p className="text-xs text-gray-500">Short code for stable references</p>
                    {createDeptErrors.dept_code && <p className="text-xs text-red-600">{createDeptErrors.dept_code}</p>}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="create-sort-order">Sort Order <span className="text-gray-400">(optional)</span></Label>
                    <Input
                      id="create-sort-order"
                      inputMode="numeric"
                      value={createForm.sort_order}
                      onChange={(event) => updateCreateForm({ sort_order: event.target.value.replace(/[^\d]/g, '') })}
                      placeholder="e.g., 20"
                      className={createDeptErrors.sort_order ? 'border-red-300 focus-visible:ring-red-200' : ''}
                    />
                    <p className="text-xs text-gray-500">Determines display order in lists</p>
                    {createDeptErrors.sort_order && <p className="text-xs text-red-600">{createDeptErrors.sort_order}</p>}
                  </div>

                  <div className="space-y-2">
                    <Label>Status</Label>
                    <Select value={createForm.status} onValueChange={(value) => updateCreateForm({ status: value as DepartmentCreateStatus })}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="draft">Draft</SelectItem>
                        <SelectItem value="disabled">Disabled</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-gray-500">Set whether this department is active or inactive</p>
                  </div>
                </div>
              </section>

              <section className="rounded-lg border p-5">
                <div className="mb-5 flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">
                    2
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-gray-950">Organization Structure</h3>
                    <p className="text-sm text-gray-500">Define the reporting structure for this department.</p>
                  </div>
                </div>

                <div className="grid gap-5 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Department Manager <span className="text-gray-400">(optional)</span></Label>
                    <Select
                      value={createForm.manager_user_id || 'none'}
                      onValueChange={(value) => updateCreateForm({ manager_user_id: value === 'none' ? '' : value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a manager" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No manager</SelectItem>
                        {orgUsers.map(user => (
                          <SelectItem key={user.id} value={user.id}>
                            {user.full_name || user.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-gray-500">The manager will be used as fallback approver for users in this department</p>
                  </div>

                  <div className="space-y-2">
                    <Label>Parent Department <span className="text-gray-400">(optional)</span></Label>
                    <Select
                      value={createForm.parent_department_id || 'none'}
                      onValueChange={(value) => updateCreateForm({ parent_department_id: value === 'none' ? '' : value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select parent department" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No parent (root level)</SelectItem>
                        {activeDepartments.map(dept => (
                          <SelectItem key={dept.id} value={dept.id}>
                            {dept.dept_code ? `${dept.dept_code} - ` : ''}{dept.dept_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-gray-500">Set a parent to create department hierarchy in the org chart</p>
                  </div>
                </div>
              </section>

              <section className="rounded-lg border p-5">
                <div className="mb-5 flex items-start gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700">
                    3
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-gray-950">Additional Details</h3>
                    <p className="text-sm text-gray-500">Add any extra information to help your team.</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Description / Notes <span className="text-gray-400">(optional)</span></Label>
                  <Textarea
                    value={createForm.notes}
                    onChange={(event) => updateCreateForm({ notes: event.target.value.slice(0, 500) })}
                    placeholder="e.g., This department is responsible for day-to-day operational activities..."
                    className="min-h-[100px] resize-none"
                  />
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>Provide additional context or notes about this department</span>
                    <span>{createForm.notes.length}/500</span>
                  </div>
                </div>
              </section>

              <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={handleCancelCreate} disabled={isSaving}>
                  Cancel
                </Button>
                <Button onClick={() => handleCreateDepartment()} disabled={isSaving || !canCreateDepartment}>
                  {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Building2 className="mr-2 h-4 w-4" />}
                  {isSaving ? 'Creating...' : 'Create Department'}
                </Button>
              </div>
            </div>
          </div>

          <aside className="rounded-lg border bg-white shadow-sm">
            <div className="flex items-center justify-between border-b p-5">
              <h3 className="text-base font-semibold text-gray-950">Department Preview</h3>
              <Badge className="bg-emerald-50 text-emerald-700 hover:bg-emerald-50">Live Preview</Badge>
            </div>
            <div className="space-y-6 p-5">
              <div className="flex flex-col items-center text-center">
                <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
                  <Building2 className="h-10 w-10" />
                </div>
                <p className="text-xs uppercase tracking-wide text-gray-500">Department Code</p>
                <p className="mt-1 font-mono text-lg font-semibold text-gray-950">{previewCode}</p>
                <p className="mt-4 text-xs uppercase tracking-wide text-gray-500">Department Name</p>
                <p className="mt-1 text-xl font-semibold text-gray-950">{previewName}</p>
                <Badge className={`mt-4 ${createForm.status === 'active' ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-50' : 'bg-gray-100 text-gray-700 hover:bg-gray-100'}`}>
                  {departmentStatusLabel(createForm.status)}
                </Badge>
              </div>

              <div className="divide-y rounded-md border">
                <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="text-gray-500">Manager</span>
                  <span className="text-right font-medium text-gray-900">{previewManager}</span>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="text-gray-500">Parent Department</span>
                  <span className="text-right font-medium text-gray-900">{previewParent}</span>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="text-gray-500">Sort Order</span>
                  <span className="font-medium text-gray-900">{previewSortOrder}</span>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="text-gray-500">Status</span>
                  <span className="font-medium text-gray-900">{departmentStatusLabel(createForm.status)}</span>
                </div>
              </div>

              <div className="rounded-lg border bg-gray-50 p-4">
                <h4 className="mb-4 text-sm font-semibold text-gray-950">Hierarchy Preview</h4>
                <div className="flex flex-col items-center text-sm">
                  <div className="rounded-md border border-blue-200 bg-blue-50 px-6 py-2 text-center font-medium text-blue-800">
                    <div>{previewParent}</div>
                    {selectedCreateParent?.dept_code && <div className="text-xs font-normal">{selectedCreateParent.dept_code}</div>}
                  </div>
                  <div className="h-8 w-px bg-indigo-300" />
                  <div className="rounded-md border border-indigo-300 bg-indigo-50 px-6 py-2 text-center font-semibold text-indigo-800">
                    <div>{previewName}</div>
                    <div className="text-xs font-normal">{previewCode}</div>
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
                <div className="mb-1 font-semibold">About this preview</div>
                <p className="text-xs leading-5">This is how the department will appear in your organization structure.</p>
              </div>
            </div>
          </aside>
        </div>
      </div>
    )
  }

  if (createStep === 'success' && createdSummary) {
    const manager = orgUsers.find(user => user.id === createdSummary.manager_user_id)
    const parent = departments.find(dept => dept.id === createdSummary.parent_department_id)

    return (
      <div className="rounded-lg border bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
          <CheckCircle2 className="h-10 w-10" />
        </div>
        <h2 className="text-2xl font-semibold text-gray-950">Department Created Successfully!</h2>
        <p className="mt-2 text-sm text-gray-500">{createdSummary.dept_name} has been added to your organization.</p>

        <div className="mx-auto mt-7 grid max-w-5xl overflow-hidden rounded-lg border text-left md:grid-cols-6">
          <div className="border-b p-4 md:border-b-0 md:border-r">
            <p className="text-xs text-gray-500">Department Code</p>
            <p className="mt-2 font-mono font-semibold text-gray-950">{createdSummary.dept_code || '—'}</p>
          </div>
          <div className="border-b p-4 md:border-b-0 md:border-r">
            <p className="text-xs text-gray-500">Department Name</p>
            <p className="mt-2 font-semibold text-gray-950">{createdSummary.dept_name}</p>
          </div>
          <div className="border-b p-4 md:border-b-0 md:border-r">
            <p className="text-xs text-gray-500">Manager</p>
            <p className="mt-2 font-semibold text-gray-950">{manager?.full_name || manager?.email || 'Not assigned'}</p>
          </div>
          <div className="border-b p-4 md:border-b-0 md:border-r">
            <p className="text-xs text-gray-500">Parent</p>
            <p className="mt-2 font-semibold text-gray-950">{parent?.dept_name || 'Root level'}</p>
          </div>
          <div className="border-b p-4 md:border-b-0 md:border-r">
            <p className="text-xs text-gray-500">Sort Order</p>
            <p className="mt-2 font-semibold text-gray-950">{createdSummary.sort_order || '—'}</p>
          </div>
          <div className="p-4">
            <p className="text-xs text-gray-500">Status</p>
            <Badge className={`mt-2 ${createdSummary.status === 'active' ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-50' : 'bg-gray-100 text-gray-700 hover:bg-gray-100'}`}>
              {departmentStatusLabel(createdSummary.status)}
            </Badge>
          </div>
        </div>

        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button variant="outline" onClick={handleViewDepartment}>
            View Department
          </Button>
          <Button variant="outline" onClick={handleCreateAnother}>
            Create Another
          </Button>
          <Button onClick={handleGoToDepartments}>
            Go to Departments
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-blue-600" />
                Departments
              </CardTitle>
              <CardDescription>
                Manage organizational departments for your organization
              </CardDescription>
            </div>
            {canEdit && (
              <Button onClick={handleOpenCreate} className="sm:self-end">
                <Plus className="h-4 w-4 mr-2" />
                Add Department
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {/* Filters */}
          <div className="flex flex-col sm:flex-row gap-4 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search departments..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="show-disabled"
                checked={showDisabled}
                onCheckedChange={setShowDisabled}
              />
              <Label htmlFor="show-disabled" className="text-sm text-gray-600">
                Show disabled
              </Label>
            </div>
          </div>

          {/* Table */}
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : filteredDepartments.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              {searchQuery ? 'No departments match your search' : 'No departments found'}
            </div>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[100px]">Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Manager</TableHead>
                    <TableHead className="text-center w-[90px]">Users</TableHead>
                    <TableHead className="text-center w-[80px]">Order</TableHead>
                    <TableHead className="text-center w-[80px]">Status</TableHead>
                    {canEdit && <TableHead className="w-[180px]">Actions</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredDepartments.map((dept) => (
                    <TableRow key={dept.id} className={!dept.is_active ? 'opacity-50 bg-gray-50' : ''}>
                      <TableCell className="font-mono text-sm">
                        {dept.dept_code || '-'}
                      </TableCell>
                      <TableCell>
                        <button
                          className="font-medium text-blue-600 hover:text-blue-800 hover:underline text-left"
                          onClick={() => {
                            setDetailDepartmentId(dept.id)
                            setDetailDrawerOpen(true)
                          }}
                        >
                          {dept.dept_name}
                        </button>
                      </TableCell>
                      <TableCell>
                        {dept.manager ? (
                          <div className="flex items-center gap-2">
                            <UserCheck className="h-4 w-4 text-green-600" />
                            <span>{dept.manager.full_name || dept.manager.email}</span>
                          </div>
                        ) : (
                          <span className="text-gray-400">Not assigned</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="px-2"
                          onClick={() => canEdit && handleOpenMembers(dept)}
                          disabled={!canEdit}
                        >
                          <Badge variant="secondary" className="font-mono">
                            {dept.user_count || 0}
                          </Badge>
                        </Button>
                      </TableCell>
                      <TableCell className="text-center font-mono text-sm">
                        {dept.sort_order ?? '-'}
                      </TableCell>
                      <TableCell className="text-center">
                        {dept.is_active ? (
                          <Badge variant="default" className="bg-green-100 text-green-800">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-gray-100 text-gray-600">
                            Disabled
                          </Badge>
                        )}
                      </TableCell>
                      {canEdit && (
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleOpenMembers(dept)}
                              title="Manage members"
                            >
                              <Users className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleOpenDialog(dept)}
                              title="Edit"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleToggleActive(dept)}
                              title={dept.is_active ? 'Disable' : 'Enable'}
                            >
                              {dept.is_active ? (
                                <ToggleRight className="h-4 w-4 text-green-600" />
                              ) : (
                                <ToggleLeft className="h-4 w-4 text-gray-400" />
                              )}
                            </Button>
                            {onNavigateToOrgChart && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onNavigateToOrgChart()}
                                title="View in Org Chart"
                              >
                                <Network className="h-4 w-4 text-blue-500" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {editingDept ? 'Edit Department' : 'Create Department'}
            </DialogTitle>
            <DialogDescription>
              {editingDept
                ? 'Update department details below'
                : 'Fill in the details for the new department'
              }
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dept_code">
                  Department Code
                  <span className="text-gray-400 text-xs ml-1">(optional)</span>
                </Label>
                <Input
                  id="dept_code"
                  value={formData.dept_code}
                  onChange={(e) => setFormData({ ...formData, dept_code: e.target.value.toUpperCase() })}
                  placeholder="e.g., HR, IT, FIN"
                  maxLength={20}
                />
                <p className="text-xs text-gray-500">
                  Short code for stable references (like SAP key)
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="sort_order">
                  Sort Order
                  <span className="text-gray-400 text-xs ml-1">(optional)</span>
                </Label>
                <Input
                  id="sort_order"
                  type="number"
                  value={formData.sort_order}
                  onChange={(e) => setFormData({ ...formData, sort_order: e.target.value })}
                  placeholder="e.g., 10, 20, 30"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dept_name">
                Department Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="dept_name"
                value={formData.dept_name}
                onChange={(e) => setFormData({ ...formData, dept_name: e.target.value })}
                placeholder="e.g., Human Resources"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="manager">
                Department Manager
                <span className="text-gray-400 text-xs ml-1">(optional)</span>
              </Label>
              <Select
                value={formData.manager_user_id}
                onValueChange={(value) => setFormData({ ...formData, manager_user_id: value === 'none' ? '' : value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a manager" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No manager</SelectItem>
                  {orgUsers.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-gray-400" />
                        <span>{user.full_name || user.email}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">
                The manager will be used as fallback approver for users in this department
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="parent_department">
                Parent Department
                <span className="text-gray-400 text-xs ml-1">(optional - for org chart hierarchy)</span>
              </Label>
              <Select
                value={formData.parent_department_id}
                onValueChange={(value) => setFormData({ ...formData, parent_department_id: value === 'none' ? '' : value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select parent department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No parent (root level)</SelectItem>
                  {departments
                    .filter(d => d.is_active && d.id !== editingDept?.id)
                    .map((dept) => (
                      <SelectItem key={dept.id} value={dept.id}>
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-gray-400" />
                          <span>{dept.dept_code ? `${dept.dept_code} - ` : ''}{dept.dept_name}</span>
                        </div>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">
                Set a parent to create department hierarchy in the org chart
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingDept ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Department Members Modal */}
      <Dialog open={membersOpen} onOpenChange={setMembersOpen}>
        <DialogContent className="sm:max-w-[1100px]">
          <DialogHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <DialogTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-blue-600" />
                  Department Members
                </DialogTitle>
                {selectedDepartment && (
                  <DialogDescription>
                    {selectedDepartment.dept_code ? `${selectedDepartment.dept_code} - ` : ''}{selectedDepartment.dept_name}
                    {' • '}
                    {selectedDepartment.is_active ? 'Active' : 'Disabled'}
                  </DialogDescription>
                )}
              </div>
              {canEdit && (
                <Button onClick={() => setCreateUserOpen(true)} size="sm">
                  <UserPlus className="h-4 w-4 mr-2" />
                  Create User
                </Button>
              )}
            </div>
          </DialogHeader>

          <Tabs defaultValue="members" className="w-full">
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="bulk">Bulk Assign</TabsTrigger>
            </TabsList>

            <TabsContent value="members">
              {membersLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                </div>
              ) : members.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No members assigned to this department.
                </div>
              ) : (
                <div className="rounded-md border overflow-auto max-h-[50vh]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Reports To</TableHead>
                        <TableHead>Status</TableHead>
                        {canEdit && <TableHead className="text-right">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {members.map(member => (
                        <TableRow key={member.id}>
                          <TableCell className="font-medium">
                            {member.full_name || '-'}
                          </TableCell>
                          <TableCell>{member.email}</TableCell>
                          <TableCell>{member.phone || '-'}</TableCell>
                          <TableCell>
                            <div className="flex flex-col">
                              <span>{member.role_name || member.role_code}</span>
                              {member.role_level !== null && member.role_level !== undefined && (
                                <span className="text-xs text-gray-500">Level {member.role_level}</span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            {canEdit ? (
                              <Select
                                value={member.manager_user_id || 'none'}
                                onValueChange={(value) =>
                                  handleManagerUpdate(member.id, value === 'none' ? null : value)
                                }
                              >
                                <SelectTrigger className="h-8">
                                  <SelectValue placeholder="No manager" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">No Manager</SelectItem>
                                  {orgMembers
                                    .filter(u => u.id !== member.id)
                                    .map(u => (
                                      <SelectItem key={u.id} value={u.id}>
                                        {u.full_name || u.email}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                            ) : member.manager ? (
                              <span>{member.manager.full_name || member.manager.email}</span>
                            ) : (
                              <span className="text-gray-400">Not assigned</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {member.is_active ? (
                              <Badge variant="default" className="bg-green-100 text-green-800">
                                Active
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="bg-gray-100 text-gray-600">
                                Disabled
                              </Badge>
                            )}
                          </TableCell>
                          {canEdit && (
                            <TableCell className="text-right">
                              <div className="flex justify-end gap-2">
                                <Select onValueChange={(value) => handleMoveMember(member.id, value)}>
                                  <SelectTrigger className="h-8 w-[150px]">
                                    <SelectValue placeholder="Move to..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {activeDepartments
                                      .filter(d => d.id !== selectedDepartment?.id)
                                      .map(d => (
                                        <SelectItem key={d.id} value={d.id}>
                                          {d.dept_code ? `${d.dept_code} - ` : ''}{d.dept_name}
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => handleRemoveMember(member.id)}
                                  title="Remove from department"
                                >
                                  <UserX className="h-4 w-4 text-red-500" />
                                </Button>
                              </div>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>

            <TabsContent value="bulk">
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                      placeholder="Search name, email, phone"
                      value={bulkSearch}
                      onChange={(e) => setBulkSearch(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  <Select value={bulkRoleFilter} onValueChange={setBulkRoleFilter}>
                    <SelectTrigger>
                      <SelectValue placeholder="Filter by role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Roles</SelectItem>
                      {roles.map(role => (
                        <SelectItem key={role.role_code} value={role.role_code}>
                          {role.role_name} (Level {role.role_level})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={bulkDeptFilter} onValueChange={setBulkDeptFilter}>
                    <SelectTrigger>
                      <SelectValue placeholder="Filter by department" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Departments</SelectItem>
                      <SelectItem value="none">No Department</SelectItem>
                      {departments.map(dept => (
                        <SelectItem key={dept.id} value={dept.id}>
                          {dept.dept_code ? `${dept.dept_code} - ` : ''}{dept.dept_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="rounded-md border overflow-auto max-h-[50vh]">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[40px]">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={selectedBulkUsers.size > 0 && selectedBulkUsers.size === filteredBulkUsers.length}
                            onChange={(e) => setAllBulkSelection(e.target.checked)}
                          />
                        </TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Email</TableHead>
                        <TableHead>Role</TableHead>
                        <TableHead>Department</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredBulkUsers.map(user => (
                        <TableRow key={user.id}>
                          <TableCell>
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={selectedBulkUsers.has(user.id)}
                              onChange={() => toggleBulkSelection(user.id)}
                            />
                          </TableCell>
                          <TableCell className="font-medium">{user.full_name || '-'}</TableCell>
                          <TableCell>{user.email}</TableCell>
                          <TableCell>{user.role_name || user.role_code}</TableCell>
                          <TableCell>
                            {user.department_id && departmentMap[user.department_id]
                              ? `${departmentMap[user.department_id].dept_code ? `${departmentMap[user.department_id].dept_code} - ` : ''}${departmentMap[user.department_id].dept_name}`
                              : 'No Department'}
                          </TableCell>
                          <TableCell>
                            {user.is_active ? (
                              <Badge variant="default" className="bg-green-100 text-green-800">Active</Badge>
                            ) : (
                              <Badge variant="secondary" className="bg-gray-100 text-gray-600">Disabled</Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                      {filteredBulkUsers.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-gray-500 py-6">
                            No users match your filters.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-gray-500">
                    Selected: {selectedBulkUsers.size} user(s)
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => handleBulkAction('assign')}>
                      Assign to {selectedDepartment?.dept_name || 'Department'}
                    </Button>
                    <Button variant="outline" onClick={() => handleBulkAction('move')}>
                      Move to {selectedDepartment?.dept_name || 'Department'}
                    </Button>
                    <Button variant="ghost" onClick={() => handleBulkAction('remove')}>
                      Remove from {selectedDepartment?.dept_name || 'Department'}
                    </Button>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Create User Dialog - rendered outside of the members modal to avoid z-index issues */}
      <UserDialogNew
        user={null}
        roles={roles as any[]}
        organizations={currentOrg ? [currentOrg] : []}
        open={createUserOpen}
        isSaving={creatingUser}
        currentUserRoleLevel={(userProfile as any)?.roles?.role_level || 100}
        lockOrganization={true}
        defaultValues={{
          organization_id: organizationId,
          department_id: selectedDepartment?.id
        }}
        onOpenChange={setCreateUserOpen}
        onSave={handleSaveUser}
      />

      {/* Bulk confirm dialog - higher z-index to appear above other dialogs */}
      <AlertDialog open={!!bulkAction} onOpenChange={() => setBulkAction(null)}>
        <AlertDialogContent className="z-[110]">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ArrowRight className="h-5 w-5 text-blue-600" />
              Confirm bulk update
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkAction && selectedDepartment && (
                <span>
                  {bulkAction.type === 'assign' && `Assign ${bulkAction.count} user(s) to ${selectedDepartment.dept_name}.`}
                  {bulkAction.type === 'move' && `Move ${bulkAction.count} user(s) to ${selectedDepartment.dept_name}.`}
                  {bulkAction.type === 'remove' && `Remove ${bulkAction.count} user(s) from ${selectedDepartment.dept_name}.`}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmBulkAction} className="bg-blue-600 hover:bg-blue-700">
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm Disable Dialog */}
      <AlertDialog open={!!confirmDisable} onOpenChange={() => setConfirmDisable(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Department Has Active Users
            </AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{confirmDisable?.dept.dept_name}</strong> currently has{' '}
              <strong>{confirmDisable?.userCount}</strong> active user(s) assigned.
              <br /><br />
              Please reassign these users to another department before disabling.
              This is to ensure all users maintain proper department assignments.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDisable?.dept) {
                  toggleDepartmentStatus(confirmDisable.dept)
                }
                setConfirmDisable(null)
              }}
              className="bg-amber-600 hover:bg-amber-700"
            >
              Disable Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Department Detail Drawer */}
      <DepartmentDetailDrawer
        departmentId={detailDepartmentId}
        organizationId={organizationId}
        open={detailDrawerOpen}
        onClose={() => {
          setDetailDrawerOpen(false)
          setDetailDepartmentId(null)
        }}
        canEdit={canEdit}
        onNavigateToChart={onNavigateToOrgChart}
        onRefresh={loadDepartments}
      />
    </div>
  )
}
