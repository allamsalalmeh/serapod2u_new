'use client'

import AccessProfileSelector, { type AccessMode, type ProfileChoice, type SelectableProfile, type SelectableScope } from './AccessProfileSelector'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getOrgTypeName } from '@/lib/utils/orgHierarchy'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Banknote,
  Briefcase,
  Building2,
  Camera,
  Check,
  CheckCircle2,
  CreditCard,
  Crown,
  Eye,
  EyeOff,
  Factory,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Search,
  Shield,
  Store,
  Upload,
  User as UserIcon,
  UserPlus,
  Users,
  X,
  Zap,
} from 'lucide-react'
import { User, Role, Organization } from '@/types/user'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { normalizePhone, validatePhoneNumber, type PhoneValidationResult } from '@/lib/utils'
import { ReferencePicker, type ReferenceUser } from '@/components/ui/reference-picker'
import { ShopPicker, type ShopResult } from '@/components/ui/shop-picker'
import UserPasswordResetSection from './UserPasswordResetSection'
import { listInitialAccessRoles } from '@/lib/actions'

interface Bank {
  id: string
  short_name: string
  min_account_length: number
  max_account_length: number
  is_numeric_only: boolean
}

interface Department {
  id: string
  dept_code: string | null
  dept_name: string
  is_active: boolean
}

interface OrgUser {
  id: string
  full_name: string | null
  email: string
}

interface PositionOption {
  id: string
  name: string
  is_active: boolean
}

type WizardStep = 'basic' | 'access' | 'business' | 'banking' | 'review'
export type OrganizationType = 'HQ' | 'MFG' | 'DIST' | 'SHOP'

type WizardUser = Partial<User> & {
  password?: string
  confirmPassword?: string
  bank_id?: string
  bank_account_number?: string
  bank_account_holder_name?: string
  department_id?: string
  manager_user_id?: string
  position_id?: string
  employment_type?: string
  join_date?: string
  employment_status?: string
  shop_name?: string
  address?: string
  referral_phone?: string
  notes?: string
}

export function ReferenceCheckbox({
  checked,
  disabled = false,
  onCheckedChange,
}: {
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id="can-be-reference"
        checked={checked}
        onCheckedChange={value => onCheckedChange(value === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <div className="space-y-1">
        <Label htmlFor="can-be-reference" className="cursor-pointer text-sm font-semibold text-[var(--sera-ink)]">
          Reference
        </Label>
        <p className="text-xs text-[var(--sera-muted)]">Allow this user to be selected as a Reference in RoadTour campaigns.</p>
      </div>
    </div>
  )
}

interface UserDialogNewProps {
  user: User | null
  roles: Role[]
  organizations: Organization[]
  open: boolean
  isSaving?: boolean
  currentUserRoleLevel?: number
  lockOrganization?: boolean
  defaultValues?: {
    organization_id?: string
    department_id?: string
    role_code?: string
  }
  onOpenChange: (open: boolean) => void
  onSave: (userData: Partial<User>, avatarFile?: File | null, resetPassword?: { password: string }) => void | Promise<void>
}

const STEP_LABELS: Record<WizardStep, string> = {
  basic: 'Basic Info',
  access: 'Role & Access',
  business: 'Business',
  banking: 'Banking',
  review: 'Review',
}

export const USER_ORGANIZATION_TYPES: Array<{ value: OrganizationType; label: string; icon: typeof Building2 }> = [
  { value: 'HQ', label: 'HQ', icon: Building2 },
  { value: 'MFG', label: 'Manufacturer', icon: Factory },
  { value: 'DIST', label: 'Distributor', icon: Store },
  { value: 'SHOP', label: 'Shop', icon: Store },
]

const ROLE_ICONS: Record<number, typeof Crown> = {
  10: Crown,
  20: Zap,
  30: Briefcase,
  40: UserIcon,
  50: Users,
}

const desiredRoleLabel = (role: Role) => {
  const labels: Record<number, string> = {
    10: 'HQ Admin',
    20: 'Power User',
    30: 'Manager',
    40: 'User',
    50: 'Guest',
  }
  return labels[role.role_level] || role.role_name
}

export const orgMatchesType = (org: Organization, type: OrganizationType) => {
  const code = (org.org_type_code || '').toUpperCase()
  if (type === 'HQ') return code === 'HQ' || code.includes('HQ') || code.includes('HEAD')
  if (type === 'MFG') return code === 'MFG' || code === 'MANU' || code.includes('MANUFACTUR')
  if (type === 'DIST') return code === 'DIST' || code.includes('DISTRIBUTOR')
  return code === 'SHOP' || code.includes('SHOP')
}

export const organizationIdForType = (organizations: Organization[], organizationId: string | undefined, type: OrganizationType) => {
  const currentOrg = organizations.find(org => org.id === organizationId)
  return currentOrg && orgMatchesType(currentOrg, type) ? organizationId || '' : ''
}

export const filterOrganizationsForType = (organizations: Organization[], type: OrganizationType, searchValue = '') => {
  const search = searchValue.trim().toLowerCase()
  return organizations.filter((org) => {
    if (!orgMatchesType(org, type)) return false
    return !search || org.org_name.toLowerCase().includes(search) || org.org_code.toLowerCase().includes(search)
  })
}

const getDisplayName = (value: { call_name?: string | null; full_name?: string | null; email?: string | null }) => {
  return value.call_name?.trim() || value.full_name?.trim() || value.email?.trim() || 'New User'
}

const normalizeBankAccountNumber = (value: string | null | undefined) => {
  return (value || '').replace(/[^\d]/g, '')
}

const getBankLengthText = (bank: Bank) => {
  const min = Number(bank.min_account_length || 0)
  const max = Number(bank.max_account_length || min)
  if (!min && !max) return 'the required number of'
  return min === max ? `${min}` : `${min}-${max}`
}

const isAccountLengthForBank = (bank: Bank, length: number) => {
  const min = Number(bank.min_account_length || 0)
  const max = Number(bank.max_account_length || min)
  if (!min && !max) return true
  if (min && length < min) return false
  if (max && length > max) return false
  return true
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value))

const compressImage = (file: File, cropPosition = { x: 50, y: 50 }): Promise<File> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(file)
    reader.onload = (event) => {
      const img = new Image()
      img.src = event.target?.result as string
      img.onload = () => {
        const canvas = document.createElement('canvas')
        const outputSize = 200
        const sourceSize = Math.min(img.width, img.height)
        const sourceX = (img.width - sourceSize) * (clampPercent(cropPosition.x) / 100)
        const sourceY = (img.height - sourceSize) * (clampPercent(cropPosition.y) / 100)

        canvas.width = outputSize
        canvas.height = outputSize
        canvas.getContext('2d')?.drawImage(img, sourceX, sourceY, sourceSize, sourceSize, 0, 0, outputSize, outputSize)
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Canvas to Blob conversion failed'))
            return
          }
          resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), {
            type: 'image/jpeg',
            lastModified: Date.now(),
          }))
        }, 'image/jpeg', 0.6)
      }
      img.onerror = () => reject(new Error('Image loading failed'))
    }
    reader.onerror = () => reject(new Error('File reading failed'))
  })
}

export default function UserDialogNew({
  user,
  roles,
  organizations,
  open,
  isSaving = false,
  currentUserRoleLevel = 100,
  lockOrganization = false,
  defaultValues,
  onOpenChange,
  onSave,
}: UserDialogNewProps) {
  const { supabase } = useSupabaseAuth()
  const [banks, setBanks] = useState<Bank[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([])
  const [positions, setPositions] = useState<PositionOption[]>([])
  const [currentStep, setCurrentStep] = useState<WizardStep>('basic')
  const [organizationType, setOrganizationType] = useState<OrganizationType>('HQ')
  const [formData, setFormData] = useState<WizardUser>({})
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [sourceAvatarFile, setSourceAvatarFile] = useState<File | null>(null)
  const [avatarCropPosition, setAvatarCropPosition] = useState({ x: 50, y: 50 })
  const [emailCheckStatus, setEmailCheckStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle')
  const [phoneCheckStatus, setPhoneCheckStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle')
  const [phoneValidation, setPhoneValidation] = useState<PhoneValidationResult | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [organizationSearch, setOrganizationSearch] = useState('')
  const [localSaving, setLocalSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const emailCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const phoneCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const avatarObjectUrlRef = useRef<string | null>(null)
  const avatarDragRef = useRef<{ startX: number; startY: number; cropX: number; cropY: number; moved: boolean } | null>(null)
  const avatarSuppressClickRef = useRef(false)

  const saving = isSaving || localSaving
  const availableRoles = useMemo(() => {
    return roles
      .filter(role => role.role_level >= currentUserRoleLevel)
      .filter(role => [10, 20, 30, 40, 50].includes(role.role_level))
      .sort((a, b) => a.role_level - b.role_level)
  }, [currentUserRoleLevel, roles])

  const selectedRole = roles.find(r => r.role_code === formData.role_code)
  const selectedRoleLevel = selectedRole?.role_level
  const selectedOrg = organizations.find(o => o.id === formData.organization_id)
  const selectedOrgIsShop = selectedOrg?.org_type_code?.toUpperCase() === 'SHOP'
  const selectedDepartment = departments.find(dept => dept.id === formData.department_id)
  const selectedPosition = positions.find(position => position.id === formData.position_id)
  const selectedManager = orgUsers.find(orgUser => orgUser.id === formData.manager_user_id)
  const isGuest = selectedRoleLevel === 50
  // Optional initial Security & Access business role (create mode only; the
  // list is empty unless the administrator may assign roles in that org).
  const [initialRoles, setInitialRoles] = useState<Array<{ id: string; name: string; description: string | null }>>([])
  // canAssign: the administrator may grant business roles in this org.
  // legacyReadOnly: legacy role codes no longer grant access here, so a new
  // user without a business role can use only employee self-service.
  const [accessInfo, setAccessInfo] = useState<{ canAssign: boolean; legacyReadOnly: boolean } | null>(null)
  // Access Profiles offered for the chosen organization (applicable, non-administrative) and the scopes
  // that may be chosen for each. Falls back to the plain role list before the profile migration.
  const [initialProfiles, setInitialProfiles] = useState<SelectableProfile[]>([])
  const [initialScopes, setInitialScopes] = useState<SelectableScope[]>([])
  const [accessOrg, setAccessOrg] = useState<{ name: string | null; typeCode: string | null } | null>(null)
  useEffect(() => {
    if (user || !open || isGuest || !formData.organization_id) { setInitialRoles([]); setInitialProfiles([]); setInitialScopes([]); setAccessOrg(null); setAccessInfo(null); return }
    let cancelled = false
    listInitialAccessRoles(formData.organization_id).then(r => {
      if (cancelled) return
      setInitialRoles(r.roles || [])
      setInitialProfiles(((r as any).profiles as SelectableProfile[] | undefined) ?? (r.roles || []))
      setInitialScopes(((r as any).scopes as SelectableScope[] | undefined) ?? [])
      setAccessOrg((r as any).organization ?? null)
      setAccessInfo({ canAssign: Boolean((r as any).canAssign), legacyReadOnly: Boolean((r as any).legacyReadOnly) })
      // A change of organization invalidates profile/scope choices made for another one.
      setFormData(prev => ((prev as any).initial_profiles?.length ? ({ ...prev, initial_profiles: [] } as any) : prev))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [user, open, isGuest, formData.organization_id])
  // Business access must be an explicit choice when it can be granted here.
  const accessChoiceRequired = !user && !isGuest && Boolean(accessInfo?.canAssign) && initialRoles.length > 0
  const showBusinessStep = organizationType === 'SHOP' || selectedOrgIsShop
  const showHrFields = Boolean(
    formData.organization_id &&
    selectedOrg &&
    [1, 10, 20, 30, 40].includes(selectedRoleLevel || 0)
  )
  // Identity onboarding (create) does not collect banking: payee details
  // belong to an employee/vendor/beneficiary domain. Existing banking data is
  // still shown and editable on an existing user.
  const showBankingStep = Boolean(user)
  const steps = useMemo<WizardStep[]>(() => {
    return ['basic', 'access', ...(showBusinessStep ? ['business' as WizardStep] : []), ...(showBankingStep ? ['banking' as WizardStep] : []), 'review']
  }, [showBusinessStep, showBankingStep])
  const filteredOrganizations = filterOrganizationsForType(organizations, organizationType, organizationSearch)

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const initial: WizardUser = user
      ? {
        ...user,
        password: '',
        confirmPassword: '',
        department_id: (user as any).department_id || '',
        manager_user_id: (user as any).manager_user_id || '',
        position_id: (user as any).position_id || '',
        employment_type: (user as any).employment_type || '',
        join_date: (user as any).join_date || '',
        employment_status: (user as any).employment_status || 'active',
        shop_name: (user as any).shop_name || '',
        address: (user as any).address || '',
        referral_phone: (user as any).referral_phone || '',
        bank_id: (user as any).bank_id || '',
        bank_account_number: (user as any).bank_account_number || '',
        bank_account_holder_name: (user as any).bank_account_holder_name || '',
        can_be_reference: user.can_be_reference ?? false,
      }
      : {
        email: '',
        full_name: '',
        call_name: '',
        phone: '',
        password: '',
        confirmPassword: '',
        role_code: defaultValues?.role_code || '',
        organization_id: defaultValues?.organization_id || '',
        is_active: true,
        avatar_url: null,
        bank_id: '',
        bank_account_number: '',
        bank_account_holder_name: '',
        department_id: defaultValues?.department_id || '',
        manager_user_id: '',
        position_id: '',
        employment_type: '',
        join_date: '',
        employment_status: 'active',
        shop_name: '',
        address: '',
        referral_phone: '',
        notes: '',
        can_be_reference: false,
      }
    const initialOrg = organizations.find(org => org.id === initial.organization_id)
    const initialOrgType = initialOrg?.org_type_code?.toUpperCase()
    setOrganizationType(
      initialOrgType === 'MFG' || initialOrgType === 'MANU' || initialOrgType?.includes('MANUFACTUR')
        ? 'MFG'
        : initialOrgType?.includes('SHOP')
          ? 'SHOP'
          : initialOrgType?.includes('DIST')
            ? 'DIST'
            : 'HQ',
    )
    setFormData(initial)
    setCurrentStep('basic')
    setAvatarPreview(user?.avatar_url ? user.avatar_url.split('?')[0] : null)
    setAvatarFile(null)
    setSourceAvatarFile(null)
    setAvatarCropPosition({ x: 50, y: 50 })
    setErrors({})
    setSubmitError(null)
    setSuccess(false)
    setEmailCheckStatus('idle')
    setPhoneCheckStatus('idle')
    setPhoneValidation(null)
    setShowPassword(false)
    setShowConfirmPassword(false)
    setOrganizationSearch('')
  }, [defaultValues?.department_id, defaultValues?.organization_id, defaultValues?.role_code, open, organizations, user])

  useEffect(() => {
    if (!open) return
    supabase.from('msia_banks').select('*').eq('is_active', true).order('short_name').then(({ data }) => {
      if (data) setBanks(data)
    })
  }, [open, supabase])

  useEffect(() => {
    const orgId = formData.organization_id
    if (!open || !orgId) {
      setDepartments([])
      setOrgUsers([])
      setPositions([])
      return
    }
    const loadOrgDetails = async () => {
      const [{ data: deptData }, { data: userData }, { data: positionData }] = await Promise.all([
        supabase.from('departments').select('id, dept_code, dept_name, is_active').eq('organization_id', orgId).eq('is_active', true).order('sort_order', { ascending: true }).order('dept_name', { ascending: true }),
        supabase.from('users').select('id, full_name, email').eq('organization_id', orgId).eq('is_active', true).order('full_name', { ascending: true }),
        supabase.from('hr_positions').select('id, name, is_active').eq('organization_id', orgId).order('level', { ascending: true, nullsFirst: false }).order('name', { ascending: true }),
      ])
      setDepartments(deptData || [])
      setOrgUsers(user?.id ? (userData || []).filter((u: any) => u.id !== user.id) : (userData || []))
      setPositions(positionData || [])
    }
    void loadOrgDetails()
  }, [formData.organization_id, open, supabase, user?.id])

  useEffect(() => {
    if (!steps.includes(currentStep)) {
      setCurrentStep(steps[steps.length - 1])
    }
  }, [currentStep, steps])

  useEffect(() => {
    return () => {
      if (emailCheckTimeoutRef.current) clearTimeout(emailCheckTimeoutRef.current)
      if (phoneCheckTimeoutRef.current) clearTimeout(phoneCheckTimeoutRef.current)
      if (avatarObjectUrlRef.current) URL.revokeObjectURL(avatarObjectUrlRef.current)
    }
  }, [])

  const checkEmailAvailability = async (email: string) => {
    if (!email || !email.includes('@') || !!user) {
      setEmailCheckStatus('idle')
      return
    }
    setEmailCheckStatus('checking')
    const { data, error } = await supabase.from('users').select('id, email').ilike('email', email.trim()).limit(1)
    if (error) {
      setEmailCheckStatus('idle')
      return
    }
    setEmailCheckStatus(data && data.length > 0 ? 'taken' : 'available')
    if (data && data.length > 0) {
      setErrors(prev => ({ ...prev, email: 'This email address is already registered. Please use a different email.' }))
    }
  }

  const checkPhoneAvailability = async (phone: string) => {
    const validation = validatePhoneNumber(phone)
    setPhoneValidation(validation)
    if (!phone.trim()) {
      setPhoneCheckStatus('idle')
      setErrors(prev => {
        const next = { ...prev }
        delete next.phone
        return next
      })
      return
    }
    if (!validation.isValid) {
      setPhoneCheckStatus('invalid')
      setErrors(prev => ({ ...prev, phone: validation.error || 'Invalid phone number format' }))
      return
    }
    const normalizedPhone = normalizePhone(phone)
    if (user?.phone && normalizePhone(user.phone) === normalizedPhone) {
      setPhoneCheckStatus('idle')
      return
    }
    setPhoneCheckStatus('checking')
    const { data: exists, error } = await supabase.rpc('check_phone_exists', {
      p_phone: normalizedPhone,
      p_exclude_user_id: user?.id || undefined,
    })
    if (error) {
      setPhoneCheckStatus('idle')
      return
    }
    setPhoneCheckStatus(exists ? 'taken' : 'available')
    if (exists) {
      setErrors(prev => ({ ...prev, phone: 'This phone number is already registered to another user.' }))
    }
  }

  const getInitials = (name: string | null | undefined) => {
    if (!name) return 'NU'
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  }

  const clearFieldError = (field: string) => {
    setErrors(prev => {
      if (!prev[field]) return prev
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  const handleInputChange = (field: string, value: any) => {
    let newValue = value
    if ((field === 'full_name' || field === 'call_name') && typeof value === 'string' && value.endsWith(' ') && value.length > 1) {
      const words = value.split(' ')
      const lastWordIndex = words.length - 2
      if (words[lastWordIndex]) {
        words[lastWordIndex] = words[lastWordIndex].charAt(0).toUpperCase() + words[lastWordIndex].slice(1).toLowerCase()
        newValue = words.join(' ')
      }
    }
    if (field === 'bank_account_number' && typeof value === 'string') {
      newValue = normalizeBankAccountNumber(value)
    }
    setFormData(prev => ({ ...prev, [field]: newValue }))
    clearFieldError(field)
    setSubmitError(null)
    if (field === 'email' && !user) {
      setEmailCheckStatus('idle')
      if (emailCheckTimeoutRef.current) clearTimeout(emailCheckTimeoutRef.current)
      emailCheckTimeoutRef.current = setTimeout(() => checkEmailAvailability(newValue), 500)
    }
    if (field === 'phone') {
      setPhoneCheckStatus('idle')
      if (phoneCheckTimeoutRef.current) clearTimeout(phoneCheckTimeoutRef.current)
      phoneCheckTimeoutRef.current = setTimeout(() => checkPhoneAvailability(newValue), 500)
    }
  }

  const selectRole = (role: Role) => {
    setFormData(prev => ({
      ...prev,
      role_code: role.role_code,
      organization_id: role.role_level === 50 ? '' : prev.organization_id,
    }))
    if (role.role_level === 10) setOrganizationType('HQ')
    clearFieldError('role_code')
    clearFieldError('organization_id')
  }

  const selectOrganizationType = (type: OrganizationType) => {
    setOrganizationType(type)
    setOrganizationSearch('')
    setFormData(prev => {
      return {
        ...prev,
        organization_id: organizationIdForType(organizations, prev.organization_id, type),
        department_id: '',
        manager_user_id: '',
        position_id: '',
      }
    })
    clearFieldError('organization_id')
  }

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setErrors(prev => ({ ...prev, avatar: 'Please select an image file' }))
      return
    }
    if (file.type === 'image/avif') {
      setErrors(prev => ({ ...prev, avatar: 'AVIF format is not supported. Please use JPG, PNG, GIF, or WebP instead.' }))
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setErrors(prev => ({ ...prev, avatar: 'Image must be less than 5MB' }))
      return
    }

    if (avatarObjectUrlRef.current) {
      URL.revokeObjectURL(avatarObjectUrlRef.current)
    }

    const previewUrl = URL.createObjectURL(file)
    avatarObjectUrlRef.current = previewUrl
    setAvatarPreview(previewUrl)
    setSourceAvatarFile(file)
    setAvatarCropPosition({ x: 50, y: 50 })
    clearFieldError('avatar')

    try {
      const finalFile = await compressImage(file, { x: 50, y: 50 })
      setAvatarFile(finalFile)
    } catch {
      setErrors(prev => ({ ...prev, avatar: 'Failed to process image. Please try a smaller file.' }))
    }
  }

  const resetAvatarUpload = () => {
    if (avatarObjectUrlRef.current) {
      URL.revokeObjectURL(avatarObjectUrlRef.current)
      avatarObjectUrlRef.current = null
    }
    setAvatarFile(null)
    setSourceAvatarFile(null)
    setAvatarPreview(user?.avatar_url?.split('?')[0] || null)
    setAvatarCropPosition({ x: 50, y: 50 })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleAvatarMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!avatarPreview) return
    event.preventDefault()
    avatarDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      cropX: avatarCropPosition.x,
      cropY: avatarCropPosition.y,
      moved: false,
    }
  }

  const handleAvatarMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const drag = avatarDragRef.current
    if (!drag) return
    const rect = event.currentTarget.getBoundingClientRect()
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      drag.moved = true
    }
    setAvatarCropPosition({
      x: clampPercent(drag.cropX - (dx / rect.width) * 100),
      y: clampPercent(drag.cropY - (dy / rect.height) * 100),
    })
  }

  const handleAvatarMouseUp = async () => {
    const drag = avatarDragRef.current
    avatarDragRef.current = null
    avatarSuppressClickRef.current = Boolean(drag?.moved)
    if (!drag?.moved || !sourceAvatarFile) return

    try {
      const finalFile = await compressImage(sourceAvatarFile, avatarCropPosition)
      setAvatarFile(finalFile)
      clearFieldError('avatar')
    } catch {
      setErrors(prev => ({ ...prev, avatar: 'Failed to process image crop. Please try again.' }))
    }
  }

  const validateBasic = () => {
    const next: Record<string, string> = {}
    if (!formData.full_name?.trim()) next.full_name = 'Full name is required'
    if (!formData.email?.trim()) next.email = 'Email is required'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) next.email = 'Invalid email format'
    else if (emailCheckStatus === 'taken') next.email = 'This email address is already registered. Please use a different email.'
    if (!formData.phone?.trim()) next.phone = 'Phone number is required'
    else {
      const validation = validatePhoneNumber(formData.phone)
      if (!validation.isValid) next.phone = validation.error || 'Invalid phone number format'
      else if (phoneCheckStatus === 'taken') next.phone = 'This phone number is already registered to another user.'
    }
    if (!user && !formData.password) next.password = 'Password is required'
    else if (!user && formData.password && formData.password.length < 6) next.password = 'Password must be at least 6 characters'
    if (!user && !formData.confirmPassword) next.confirmPassword = 'Please confirm your password'
    else if (!user && formData.password !== formData.confirmPassword) next.confirmPassword = 'Passwords do not match'
    return next
  }

  const validateAccess = () => {
    const next: Record<string, string> = {}
    if (!formData.role_code) next.role_code = 'Legacy level is required'
    if (accessChoiceRequired) {
      const choice = (formData as any).initial_role_id
      if (!choice) next.initial_role_id = 'Choose the business access for this person (or employee self-service only)'
      else if (choice === 'profiles') {
        const picked: ProfileChoice[] = (formData as any).initial_profiles || []
        if (picked.length === 0 || picked.some(p => !p.roleId)) next.initial_profiles = 'Choose an Access Profile in every row (or remove the empty row).'
        else if (picked.some(p => !p.scopeId)) next.initial_profiles = 'Each Access Profile needs its own scope.'
        else if (new Set(picked.map(p => p.roleId)).size !== picked.length) next.initial_profiles = 'Each Access Profile can be assigned once.'
        if (((formData as any).initial_access_reason || '').trim().length < 5) next.initial_access_reason = 'A reason is required (at least 5 characters)'
      } else if (choice !== 'self' && ((formData as any).initial_access_reason || '').trim().length < 5) next.initial_access_reason = 'A reason is required (at least 5 characters)'
    }
    if (!isGuest && !formData.organization_id) {
      next.organization_id = `${organizationType === 'HQ' ? 'HQ' : getOrgTypeName(organizationType)} organization is required`
    }
    return next
  }

  const validateBanking = () => {
    const next: Record<string, string> = {}
    if (formData.bank_id && formData.bank_account_number) {
      const selectedBank = banks.find(bank => bank.id === formData.bank_id)
      if (selectedBank) {
        const rawAccountNumber = formData.bank_account_number
        const accountNumber = normalizeBankAccountNumber(rawAccountNumber)
        const selectedBankName = selectedBank.short_name || 'selected bank'

        if (selectedBank.is_numeric_only && rawAccountNumber.trim() && !accountNumber) {
          next.bank_account_number = `${selectedBankName} account numbers should contain digits only. Remove letters or symbols and try again.`
        } else if (accountNumber && !isAccountLengthForBank(selectedBank, accountNumber.length)) {
          const likelyBanks = banks
            .filter(bank => bank.id !== selectedBank.id && isAccountLengthForBank(bank, accountNumber.length))
            .map(bank => bank.short_name)
            .filter(Boolean)
            .slice(0, 2)

          if (likelyBanks.length > 0) {
            next.bank_account_number = `This account number does not match ${selectedBankName}. It looks closer to ${likelyBanks.join(' or ')}. Please check the selected bank or enter a valid ${selectedBankName} account number.`
          } else {
            next.bank_account_number = `Please enter a valid ${selectedBankName} account number (${getBankLengthText(selectedBank)} digits).`
          }
        }
      }
    }
    return next
  }

  const validateStep = (step: WizardStep) => {
    const next = {
      ...(step === 'basic' ? validateBasic() : {}),
      ...(step === 'access' ? validateAccess() : {}),
      ...(step === 'banking' ? validateBanking() : {}),
    }
    setErrors(prev => ({ ...prev, ...next }))
    return Object.keys(next).length === 0
  }

  const validateAll = () => {
    const next = { ...validateBasic(), ...validateAccess(), ...(showBankingStep ? validateBanking() : {}) }
    setErrors(next)
    if (Object.keys(next).length > 0) {
      const first = Object.keys(next)[0]
      if (['full_name', 'email', 'phone', 'password', 'confirmPassword'].includes(first)) setCurrentStep('basic')
      else if (['role_code', 'organization_id', 'initial_role_id', 'initial_profiles', 'initial_access_reason'].includes(first)) setCurrentStep('access')
      else setCurrentStep('banking')
      return false
    }
    return true
  }

  const goNext = () => {
    if (!validateStep(currentStep)) return
    const index = steps.indexOf(currentStep)
    setCurrentStep(steps[Math.min(index + 1, steps.length - 1)])
  }

  const goBack = () => {
    const index = steps.indexOf(currentStep)
    setCurrentStep(steps[Math.max(index - 1, 0)])
  }

  const handleSubmit = async () => {
    if (!validateAll()) return
    setSubmitError(null)
    setLocalSaving(true)
    try {
      const sanitizedFormData = {
        ...formData,
        bank_account_number: formData.bank_account_number
          ? normalizeBankAccountNumber(formData.bank_account_number)
          : formData.bank_account_number,
      }
      const { confirmPassword, notes, ...dataToSave } = sanitizedFormData
      const finalAvatarFile = sourceAvatarFile
        ? await compressImage(sourceAvatarFile, avatarCropPosition)
        : avatarFile
      await onSave(dataToSave as Partial<User>, finalAvatarFile)
      if (!user) {
        setSuccess(true)
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to save user')
    } finally {
      setLocalSaving(false)
    }
  }

  const handleClose = () => {
    onOpenChange(false)
    resetAvatarUpload()
    setErrors({})
    setSubmitError(null)
  }

  const handleAddAnother = () => {
    setSuccess(false)
    setCurrentStep('basic')
    setFormData({
      email: '',
      full_name: '',
      call_name: '',
      phone: '',
      password: '',
      confirmPassword: '',
      role_code: defaultValues?.role_code || '',
      organization_id: defaultValues?.organization_id || '',
      is_active: true,
      avatar_url: null,
      bank_id: '',
      bank_account_number: '',
      bank_account_holder_name: '',
      shop_name: '',
      address: '',
      referral_phone: '',
      notes: '',
      employment_status: 'active',
      can_be_reference: false,
    })
    setAvatarFile(null)
    setAvatarPreview(null)
    setErrors({})
    setSubmitError(null)
  }

  if (!open) return null

  const renderFieldError = (field: string) => errors[field] ? <p className="text-xs text-red-500">{errors[field]}</p> : null
  const inputClass = (field: string, extra = '') => `h-11 rounded-lg border-[var(--sera-line)] text-sm ${errors[field] ? 'border-red-500 focus-visible:ring-red-200' : ''} ${extra}`

  const sectionHeader = (icon: React.ReactNode, title: string, description: string) => (
    <div className="flex items-start gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--sera-orange)]/[0.06] text-[var(--sera-orange)]">
        {icon}
      </div>
      <div>
        <h3 className="text-base font-semibold text-gray-950">{title}</h3>
        <p className="text-sm text-[var(--sera-muted)]">{description}</p>
      </div>
    </div>
  )

  const summaryValue = (value?: string | null) => value?.trim() || '-'

  const renderBasicStep = () => (
    <div className="sera-sc-page space-y-6">
      {sectionHeader(<UserIcon className="h-5 w-5" />, 'Basic Information', "Enter the user's basic details to get started.")}
      <div className="grid gap-6 lg:grid-cols-[120px_1fr]">
        <div className="flex flex-col items-center gap-3">
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (avatarSuppressClickRef.current) {
                avatarSuppressClickRef.current = false
                return
              }
              if (!avatarPreview) fileInputRef.current?.click()
            }}
            onKeyDown={(event) => {
              if ((event.key === 'Enter' || event.key === ' ') && !avatarPreview) {
                event.preventDefault()
                fileInputRef.current?.click()
              }
            }}
            onMouseDown={handleAvatarMouseDown}
            onMouseMove={handleAvatarMouseMove}
            onMouseUp={handleAvatarMouseUp}
            onMouseLeave={handleAvatarMouseUp}
            className={`group flex h-28 w-28 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-[var(--sera-orange)] to-[var(--sera-orange-deep)] text-white shadow-sm ring-4 ring-[var(--sera-orange)]/10 ${saving ? 'pointer-events-none opacity-70' : avatarPreview ? 'cursor-move' : 'cursor-pointer'}`}
            title={avatarPreview ? 'Drag to reposition image' : 'Upload photo'}
          >
            {avatarPreview ? (
              <img
                src={avatarPreview}
                alt="Avatar preview"
                draggable={false}
                className="h-full w-full select-none object-cover"
                style={{ objectPosition: `${avatarCropPosition.x}% ${avatarCropPosition.y}%` }}
              />
            ) : (
              <div className="relative flex h-full w-full items-center justify-center bg-gray-200 text-2xl font-medium text-[var(--sera-ink)]/80">
                {getInitials(formData.full_name)}
                <span className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-[var(--sera-orange)] text-white shadow-sm">
                  <Camera className="h-4 w-4" />
                </span>
              </div>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/jpg,image/png,image/gif,image/webp" onChange={handleAvatarChange} className="hidden" />
          <Button type="button" variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} disabled={saving} className="h-8 text-[var(--sera-orange)]">
            <Upload className="mr-1.5 h-4 w-4" />
            Upload Photo
          </Button>
          <p className="text-center text-xs text-[var(--sera-muted)]/70">JPG, PNG (Max 2MB)</p>
          {avatarPreview ? (
            <p className="text-center text-xs text-[var(--sera-muted)]/70">Drag image to reposition</p>
          ) : null}
          {avatarFile || avatarPreview ? (
            <Button type="button" variant="ghost" size="sm" onClick={resetAvatarUpload} disabled={saving} className="h-7 text-xs text-red-500">
              Remove
            </Button>
          ) : null}
          {renderFieldError('avatar')}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Full Name <span className="text-red-500">*</span></Label>
            <Input value={formData.full_name || ''} onChange={e => handleInputChange('full_name', e.target.value)} disabled={saving} placeholder="Enter full name" className={inputClass('full_name')} />
            {renderFieldError('full_name')}
          </div>
          <div className="space-y-2">
            <Label>Call Name <span className="font-normal text-[var(--sera-muted)]/70">(Optional)</span></Label>
            <Input value={formData.call_name || ''} onChange={e => handleInputChange('call_name', e.target.value)} disabled={saving} placeholder="Short name / preferred name" className={inputClass('call_name')} />
          </div>
          <div className="space-y-2">
            <Label>Email <span className="text-red-500">*</span></Label>
            <div className="relative">
              <Mail className="absolute left-3 top-3.5 h-4 w-4 text-[var(--sera-muted)]/70" />
              <Input type="email" value={formData.email || ''} onChange={e => handleInputChange('email', e.target.value)} disabled={saving || !!user} placeholder="Enter email address" className={inputClass('email', 'pl-9')} />
              {emailCheckStatus === 'checking' ? <Loader2 className="absolute right-3 top-3.5 h-4 w-4 animate-spin text-[var(--sera-muted)]/70" /> : null}
              {emailCheckStatus === 'available' ? <CheckCircle2 className="absolute right-3 top-3.5 h-4 w-4 text-green-500" /> : null}
            </div>
            {renderFieldError('email')}
          </div>
          <div className="space-y-2">
            <Label>Phone Number <span className="text-red-500">*</span></Label>
            <div className="relative">
              <Phone className="absolute left-3 top-3.5 h-4 w-4 text-[var(--sera-muted)]/70" />
              <Input value={formData.phone || ''} onChange={e => handleInputChange('phone', e.target.value)} disabled={saving} placeholder="e.g. 0123456789 (MY) or 13800138000 (CN)" className={inputClass('phone', 'pl-9')} />
              {phoneCheckStatus === 'checking' ? <Loader2 className="absolute right-3 top-3.5 h-4 w-4 animate-spin text-[var(--sera-muted)]/70" /> : null}
              {phoneCheckStatus === 'available' ? <CheckCircle2 className="absolute right-3 top-3.5 h-4 w-4 text-green-500" /> : null}
            </div>
            {renderFieldError('phone') || <p className="text-xs text-[var(--sera-muted)]/70">{phoneCheckStatus === 'available' ? 'Phone number is available' : 'Malaysia (+60) or China (+86)'}</p>}
          </div>
          {!user ? (
            <>
              <div className="space-y-2">
                <Label>Password <span className="text-red-500">*</span></Label>
                <div className="relative">
                  <Input type={showPassword ? 'text' : 'password'} value={formData.password || ''} onChange={e => handleInputChange('password', e.target.value)} disabled={saving} placeholder="Min. 6 characters" className={inputClass('password', 'pr-10')} />
                  <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3 top-3.5 text-[var(--sera-muted)]/70">
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {renderFieldError('password')}
              </div>
              <div className="space-y-2">
                <Label>Confirm Password <span className="text-red-500">*</span></Label>
                <div className="relative">
                  <Input type={showConfirmPassword ? 'text' : 'password'} value={formData.confirmPassword || ''} onChange={e => handleInputChange('confirmPassword', e.target.value)} disabled={saving} placeholder="Re-enter password" className={inputClass('confirmPassword', 'pr-10')} />
                  <button type="button" onClick={() => setShowConfirmPassword(v => !v)} className="absolute right-3 top-3.5 text-[var(--sera-muted)]/70">
                    {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {renderFieldError('confirmPassword')}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )

  const renderAccessStep = () => (
    <div className="sera-sc-page space-y-6">
      {sectionHeader(<Shield className="h-5 w-5" />, 'Role & Access', "Choose the organization and the business access this person gets.")}
      <div className="space-y-3">
        <Label>Legacy level (compatibility) <span className="text-red-500">*</span></Label>
        <p className="text-xs text-[var(--sera-muted)]">
          {!accessInfo
            ? 'Compatibility level for features still being moved to Security & Access. Business access is chosen after the organization.'
            : accessInfo.legacyReadOnly
              ? 'Used only by features still being moved to Security & Access. It does not grant access by itself; business access is chosen below.'
              : 'Still decides access for features not yet moved to Security & Access. Business roles below are the new access model.'}
        </p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {availableRoles.map(role => {
            const active = formData.role_code === role.role_code
            const Icon = ROLE_ICONS[role.role_level] || Shield
            return (
              <button
                key={role.role_code}
                type="button"
                onClick={() => selectRole(role)}
                disabled={saving}
                className={`relative rounded-lg border bg-white p-4 text-center shadow-sm transition hover:border-[var(--sera-orange)]/30 hover:bg-[var(--sera-orange)]/[0.06]/40 ${active ? 'border-[var(--sera-orange)] ring-2 ring-[var(--sera-orange)]/15' : 'border-[var(--sera-line)]'}`}
              >
                {active ? <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--sera-orange)] text-white"><Check className="h-3.5 w-3.5" /></span> : null}
                <Icon className={`mx-auto mb-3 h-8 w-8 ${active ? 'text-[var(--sera-orange)]' : 'text-[var(--sera-ink)]/80'}`} />
                <div className="text-sm font-semibold text-[var(--sera-ink)]">{desiredRoleLabel(role)}</div>
                <div className="text-xs text-[var(--sera-muted)]">Level {role.role_level}</div>
              </button>
            )
          })}
        </div>
        {renderFieldError('role_code')}
      </div>
      <div className="space-y-3">
        <Label>Organization Type</Label>
        <div className="grid gap-3 md:grid-cols-4">
          {USER_ORGANIZATION_TYPES.map(type => {
            const Icon = type.icon
            const active = organizationType === type.value
            return (
              <button
                key={type.value}
                type="button"
                onClick={() => selectOrganizationType(type.value)}
                disabled={saving || lockOrganization || isGuest}
                className={`flex h-12 items-center justify-center gap-2 rounded-lg border text-sm font-semibold transition ${active ? 'border-[var(--sera-orange)] bg-[var(--sera-orange)]/[0.06] text-[var(--sera-orange-deep)]' : 'border-[var(--sera-line)] bg-white text-[var(--sera-ink)]/80 hover:border-[var(--sera-orange)]/20'}`}
              >
                <Icon className="h-4 w-4" />
                {type.label}
              </button>
            )
          })}
        </div>
        {isGuest ? <p className="text-xs text-[var(--sera-muted)]">Guest users can be independent unless an organization is selected later by an admin.</p> : null}
      </div>
      <div className="space-y-2">
        <Label>Organization {!isGuest ? <span className="text-red-500">*</span> : null}</Label>
        <Select
          value={formData.organization_id || ''}
          onValueChange={(value) => {
            handleInputChange('organization_id', value)
            setFormData(prev => ({ ...prev, organization_id: value, department_id: '', manager_user_id: '', position_id: '' }))
          }}
          disabled={saving || lockOrganization || isGuest}
        >
          <SelectTrigger className={`h-11 rounded-lg ${errors.organization_id ? 'border-red-500' : ''}`}>
            <SelectValue placeholder={isGuest ? 'Independent guest' : 'Search organization...'} />
          </SelectTrigger>
          <SelectContent className="max-h-[260px]">
            <div className="sticky top-0 z-10 bg-white p-2">
              <Input
                value={organizationSearch}
                onChange={(event) => setOrganizationSearch(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder="Search organization..."
                className="h-9"
              />
            </div>
            {filteredOrganizations.map(org => (
              <SelectItem key={org.id} value={org.id}>
                {org.org_name} ({org.org_code})
              </SelectItem>
            ))}
            {filteredOrganizations.length === 0 ? <p className="px-3 py-2 text-xs text-[var(--sera-muted)]">No matching organizations.</p> : null}
          </SelectContent>
        </Select>
        {renderFieldError('organization_id')}
      </div>
      <div className="rounded-lg border border-[var(--sera-line)] bg-white p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className={`flex h-8 w-8 items-center justify-center rounded-full ${formData.is_active ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-[var(--sera-muted)]'}`}>
              <CheckCircle2 className="h-4 w-4" />
            </span>
            <div>
              <div className="text-sm font-semibold text-[var(--sera-ink)]">Active</div>
              <p className="text-xs text-[var(--sera-muted)]">User can log in to the system</p>
            </div>
          </div>
          <Switch checked={Boolean(formData.is_active)} onCheckedChange={checked => handleInputChange('is_active', checked)} disabled={saving} />
        </div>
      </div>
      <ReferenceCheckbox
        checked={Boolean(formData.can_be_reference)}
        onCheckedChange={checked => handleInputChange('can_be_reference', checked)}
        disabled={saving}
      />
      {user ? (
        <UserPasswordResetSection
          targetUserId={user.id}
          targetUserName={getDisplayName(user)}
          targetUserEmail={user.email}
          currentUserRoleLevel={currentUserRoleLevel}
        />
      ) : null}
      {showHrFields ? (
        <div className="space-y-4 rounded-lg border border-[var(--sera-orange)]/15 bg-[var(--sera-orange)]/[0.06]/40 p-4">
          <div>
            <div className="text-sm font-semibold text-[var(--sera-ink)]">HR Configuration</div>
            <p className="text-xs text-[var(--sera-muted)]">Link this user to department, reporting line, and employment details.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Department</Label>
            <Select value={formData.department_id || ''} onValueChange={value => handleInputChange('department_id', value === 'none' ? '' : value)} disabled={saving}>
              <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Select department" /></SelectTrigger>
              <SelectContent><SelectItem value="none">No Department</SelectItem>{departments.map(dept => <SelectItem key={dept.id} value={dept.id}>{dept.dept_code ? `${dept.dept_code} - ` : ''}{dept.dept_name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Position</Label>
            <Select value={formData.position_id || ''} onValueChange={value => handleInputChange('position_id', value === 'none' ? '' : value)} disabled={saving}>
              <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Select position" /></SelectTrigger>
              <SelectContent><SelectItem value="none">No Position</SelectItem>{positions.filter(p => p.is_active).map(position => <SelectItem key={position.id} value={position.id}>{position.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Reports To</Label>
            <Select value={formData.manager_user_id || ''} onValueChange={value => handleInputChange('manager_user_id', value === 'none' ? '' : value)} disabled={saving}>
              <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Select manager" /></SelectTrigger>
              <SelectContent><SelectItem value="none">No Manager</SelectItem>{orgUsers.map(u => <SelectItem key={u.id} value={u.id}>{u.full_name || u.email}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Join Date</Label>
            <Input type="date" value={formData.join_date || ''} onChange={e => handleInputChange('join_date', e.target.value)} disabled={saving} className="h-10 bg-white" />
          </div>
          <div className="space-y-2">
            <Label>Employment Type</Label>
            <Select value={formData.employment_type || ''} onValueChange={value => handleInputChange('employment_type', value === 'none' ? '' : value)} disabled={saving}>
              <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Select type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not set</SelectItem>
                <SelectItem value="Full-time">Full-time</SelectItem>
                <SelectItem value="Part-time">Part-time</SelectItem>
                <SelectItem value="Contract">Contract</SelectItem>
                <SelectItem value="Intern">Intern</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Employment Status</Label>
            <Select value={formData.employment_status || 'active'} onValueChange={value => handleInputChange('employment_status', value)} disabled={saving}>
              <SelectTrigger className="h-10 bg-white"><SelectValue placeholder="Select status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="resigned">Resigned</SelectItem>
                <SelectItem value="terminated">Terminated</SelectItem>
              </SelectContent>
            </Select>
          </div>
          </div>
        </div>
      ) : null}
      {user ? (
        <div role="note" className="rounded-lg border border-[var(--sera-line)] p-4 text-xs text-[var(--sera-muted)]">
          Business access for an existing person is managed with Access Profiles in{' '}
          <a href="/security-access" className="font-medium text-[var(--sera-orange)] underline">Security &amp; Access → People &amp; Access</a>
          {' '}(grants, scopes, revocation and audit use the same authorization rules). The legacy level above is a compatibility field only.
        </div>
      ) : null}
      {!user && !isGuest && formData.organization_id && accessInfo ? (
        accessChoiceRequired ? (
          <>
            <AccessProfileSelector
              disabled={saving}
              organizationName={accessOrg?.name ?? selectedOrg?.org_name ?? null}
              organizationTypeCode={accessOrg?.typeCode ?? selectedOrg?.org_type_code ?? null}
              profiles={initialProfiles}
              scopes={initialScopes}
              mode={(((formData as any).initial_role_id as string) || '') as AccessMode}
              items={((formData as any).initial_profiles as ProfileChoice[]) || []}
              reason={(formData as any).initial_access_reason || ''}
              legacyLevelLabel={availableRoles.find(r => r.role_code === formData.role_code) ? `Level ${availableRoles.find(r => r.role_code === formData.role_code)!.role_level} — ${availableRoles.find(r => r.role_code === formData.role_code)!.role_name}` : null}
              legacyReadOnly={accessInfo.legacyReadOnly}
              errors={{ mode: errors.initial_role_id, items: errors.initial_profiles, reason: errors.initial_access_reason }}
              onMode={m => { setFormData(prev => ({ ...prev, initial_role_id: m, ...(m === 'self' ? { initial_profiles: [] } : {}) } as any)); clearFieldError('initial_role_id') }}
              onItems={items => { setFormData(prev => ({ ...prev, initial_profiles: items } as any)); clearFieldError('initial_profiles') }}
              onReason={v => { setFormData(prev => ({ ...prev, initial_access_reason: v } as any)); clearFieldError('initial_access_reason') }}
            />
          </>
        ) : !accessInfo.canAssign ? (
          <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
            You cannot grant business access in this organization.{accessInfo.legacyReadOnly ? ' The new user will only have employee self-service until' : ' Ask'} a Security &amp; Access administrator {accessInfo.legacyReadOnly ? 'grants a business role' : 'to grant business roles'} in Security &amp; Access → People &amp; Access.
          </div>
        ) : null
      ) : null}
    </div>
  )

  const renderBusinessStep = () => (
    <div className="sera-sc-page space-y-6">
      {sectionHeader(<Store className="h-5 w-5" />, 'Business Information', 'Provide business details for this user.')}
      <div className="space-y-2">
        <Label>Shop Name / Outlet</Label>
        <ShopPicker
          value={formData.shop_name || ''}
          onSelect={(shop: ShopResult | null, displayName: string) => {
            handleInputChange('shop_name', displayName)
            if (shop?.org_id) handleInputChange('organization_id', shop.org_id)
          }}
          disabled={saving}
          placeholder="Search shop or type name..."
        />
      </div>
      <div className="space-y-2">
        <Label><span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4 text-[var(--sera-muted)]/70" />Address</span></Label>
        <Input value={formData.address || ''} onChange={e => handleInputChange('address', e.target.value)} disabled={saving} placeholder="Enter shop address" className={inputClass('address')} />
      </div>
      <div className="space-y-2">
        <Label><span className="inline-flex items-center gap-1.5"><Search className="h-4 w-4 text-[var(--sera-muted)]/70" />Reference / Account Manager</span></Label>
        <ReferencePicker
          value={formData.referral_phone || ''}
          onSelect={(_ref: ReferenceUser | null, phone: string) => handleInputChange('referral_phone', phone)}
          disabled={saving}
          placeholder="Search reference by name, phone, or email..."
        />
      </div>
      <div className="space-y-2">
        <Label>Notes <span className="font-normal text-[var(--sera-muted)]/70">(Optional)</span></Label>
        <Textarea value={formData.notes || ''} onChange={e => handleInputChange('notes', e.target.value)} disabled={saving} placeholder="Add any notes about this user..." className="min-h-[92px] rounded-lg border-[var(--sera-line)]" />
      </div>
    </div>
  )

  const renderBankingStep = () => (
    <div className="sera-sc-page space-y-6">
      {sectionHeader(<Banknote className="h-5 w-5" />, 'Banking Information', 'Enter bank details for this user.')}
      <div className="space-y-2">
        <Label>Account Holder Name</Label>
        <Input value={formData.bank_account_holder_name || ''} onChange={e => handleInputChange('bank_account_holder_name', e.target.value)} disabled={saving} placeholder="e.g., ALI BIN ABU" className={inputClass('bank_account_holder_name')} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label>Bank</Label>
          <Select value={formData.bank_id || ''} onValueChange={value => handleInputChange('bank_id', value)} disabled={saving}>
            <SelectTrigger className="h-11 rounded-lg"><SelectValue placeholder="Select bank" /></SelectTrigger>
            <SelectContent className="max-h-[260px]">{banks.map(bank => <SelectItem key={bank.id} value={bank.id}>{bank.short_name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Account Number</Label>
          <div className="relative">
            <CreditCard className="absolute left-3 top-3.5 h-4 w-4 text-[var(--sera-muted)]/70" />
            <Input value={formData.bank_account_number || ''} onChange={e => handleInputChange('bank_account_number', e.target.value)} disabled={saving} placeholder="e.g., 1234567890" className={inputClass('bank_account_number', 'pl-9')} />
          </div>
          {renderFieldError('bank_account_number')}
        </div>
      </div>
      <div className="flex items-start gap-2 rounded-lg bg-[var(--sera-orange)]/[0.06] p-3 text-sm text-[var(--sera-orange-deep)]">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        This information is used for payment and verification purposes only.
      </div>
    </div>
  )

  const SummaryCard = ({ title, icon, step, children }: { title: string; icon: React.ReactNode; step: WizardStep; children: React.ReactNode }) => (
    <div className="rounded-lg border border-[var(--sera-line)] bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--sera-ink)]">{icon}{title}</div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setCurrentStep(step)} className="h-7 px-2 text-xs text-[var(--sera-orange)]">Edit</Button>
      </div>
      <div className="space-y-2 text-sm text-[var(--sera-muted)]">{children}</div>
    </div>
  )

  const renderReviewStep = () => (
    <div className="sera-sc-page space-y-6">
      {sectionHeader(<CheckCircle2 className="h-5 w-5" />, 'Review & Confirm', 'Please review the information before creating the user.')}
      <div className="grid gap-4 lg:grid-cols-2">
        <SummaryCard title="Basic Information" icon={<UserIcon className="h-4 w-4 text-[var(--sera-orange)]" />} step="basic">
          <p>Full Name: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.full_name)}</span></p>
          <p>Call Name: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.call_name)}</span></p>
          <p>Email: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.email)}</span></p>
          <p>Phone: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.phone)}</span></p>
        </SummaryCard>
        <SummaryCard title="Role & Access" icon={<Shield className="h-4 w-4 text-[var(--sera-orange)]" />} step="access">
          <p>Role: <span className="font-medium text-[var(--sera-ink)]">{selectedRole ? `${desiredRoleLabel(selectedRole)} (Level ${selectedRole.role_level})` : '-'}</span></p>
          <p>Organization Type: <span className="font-medium text-[var(--sera-ink)]">{organizationType === 'HQ' ? 'HQ' : getOrgTypeName(organizationType)}</span></p>
          <p>Organization: <span className="font-medium text-[var(--sera-ink)]">{selectedOrg ? `${selectedOrg.org_name} (${selectedOrg.org_code})` : '-'}</span></p>
        </SummaryCard>
        {showHrFields ? (
          <SummaryCard title="HR Configuration" icon={<Building2 className="h-4 w-4 text-[var(--sera-orange)]" />} step="access">
            <p>Department: <span className="font-medium text-[var(--sera-ink)]">{selectedDepartment ? `${selectedDepartment.dept_code ? `${selectedDepartment.dept_code} - ` : ''}${selectedDepartment.dept_name}` : '-'}</span></p>
            <p>Position: <span className="font-medium text-[var(--sera-ink)]">{selectedPosition?.name || '-'}</span></p>
            <p>Reports To: <span className="font-medium text-[var(--sera-ink)]">{selectedManager?.full_name || selectedManager?.email || '-'}</span></p>
            <p>Employment Type: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.employment_type)}</span></p>
            <p>Join Date: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.join_date)}</span></p>
            <p>Employment Status: <span className="font-medium text-[var(--sera-ink)]">{formData.employment_status || 'active'}</span></p>
          </SummaryCard>
        ) : null}
        {showBusinessStep ? (
          <SummaryCard title="Business Information" icon={<Store className="h-4 w-4 text-[var(--sera-orange)]" />} step="business">
            <p>Shop Name: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.shop_name)}</span></p>
            <p>Address: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.address)}</span></p>
            <p>Reference: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.referral_phone)}</span></p>
            <p>Notes: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.notes)}</span></p>
          </SummaryCard>
        ) : null}
        {showBankingStep ? (
          <SummaryCard title="Banking Information" icon={<Banknote className="h-4 w-4 text-[var(--sera-orange)]" />} step="banking">
            <p>Bank: <span className="font-medium text-[var(--sera-ink)]">{banks.find(bank => bank.id === formData.bank_id)?.short_name || '-'}</span></p>
            <p>Account No: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.bank_account_number)}</span></p>
            <p>Account Holder: <span className="font-medium text-[var(--sera-ink)]">{summaryValue(formData.bank_account_holder_name)}</span></p>
          </SummaryCard>
        ) : null}
        <SummaryCard title="Account/Security Status" icon={<CheckCircle2 className="h-4 w-4 text-[var(--sera-orange)]" />} step="access">
          <div className="flex items-center gap-2">
            <span>Status:</span>
            <Badge className={formData.is_active ? 'bg-green-100 text-green-700 hover:bg-green-100' : 'bg-gray-100 text-[var(--sera-muted)] hover:bg-[var(--sera-ink)]/[0.04]'}>{formData.is_active ? 'Active' : 'Inactive'}</Badge>
          </div>
          <p>Password: <span className="font-medium text-[var(--sera-ink)]">{user ? 'Unchanged' : 'Set for new user'}</span></p>
        </SummaryCard>
      </div>
      {submitError ? (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {submitError}
        </div>
      ) : null}
    </div>
  )

  const renderStep = () => {
    if (currentStep === 'basic') return renderBasicStep()
    if (currentStep === 'access') return renderAccessStep()
    if (currentStep === 'business') return renderBusinessStep()
    if (currentStep === 'banking') return renderBankingStep()
    return renderReviewStep()
  }

  if (success) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-3xl rounded-2xl bg-gradient-to-b from-emerald-50 to-white p-6 shadow-2xl sm:p-10">
          <div className="flex justify-end">
            <button onClick={handleClose} className="rounded-lg p-1 text-[var(--sera-muted)]/70 hover:bg-white/70 hover:text-[var(--sera-muted)]"><X className="h-6 w-6" /></button>
          </div>
          <div className="mx-auto max-w-xl text-center">
            <div className="mx-auto mb-5 flex h-28 w-28 items-center justify-center rounded-full bg-green-500 text-white shadow-lg">
              <Check className="h-16 w-16" />
            </div>
            <h2 className="text-2xl font-bold text-gray-950">User Created Successfully!</h2>
            <p className="mt-2 text-[var(--sera-muted)]">The new user has been added to the system.</p>
            <div className="mt-8 flex items-center gap-4 rounded-xl border border-[var(--sera-line)] bg-white p-5 text-left shadow-sm">
              <Avatar className="h-16 w-16">
                <AvatarImage src={avatarPreview || undefined} />
                <AvatarFallback className="bg-gradient-to-br from-[var(--sera-orange)] to-[var(--sera-orange-deep)] text-xl text-white">{getInitials(formData.full_name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-gray-950">{formData.full_name}</h3>
                  <Badge className="bg-green-100 text-green-700 hover:bg-green-100">Active</Badge>
                </div>
                <p className="text-sm text-[var(--sera-muted)]">{selectedRole ? `${desiredRoleLabel(selectedRole)} (Level ${selectedRole.role_level})` : '-'} {selectedOrg ? `- ${selectedOrg.org_name}` : ''}</p>
                <div className="mt-2 flex flex-wrap gap-4 text-sm text-[var(--sera-muted)]">
                  <span className="inline-flex items-center gap-1"><Mail className="h-4 w-4" />{formData.email}</span>
                  <span className="inline-flex items-center gap-1"><Phone className="h-4 w-4" />{formData.phone}</span>
                </div>
              </div>
            </div>
            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              <Button type="button" variant="outline" onClick={handleAddAnother} className="h-12 rounded-lg">
                <UserPlus className="mr-2 h-4 w-4" />
                Add Another User
              </Button>
              <Button type="button" onClick={handleClose} className="h-12 rounded-lg bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white">
                View User List
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const currentIndex = steps.indexOf(currentStep)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-2 sm:p-4">
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--sera-line)] px-5 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--sera-orange)] text-white"><UserPlus className="h-5 w-5" /></span>
            <h2 className="text-xl font-bold text-gray-950">{user ? 'Edit User' : 'Add New User'}</h2>
          </div>
          <button onClick={handleClose} disabled={saving} className="rounded-lg p-1 text-[var(--sera-muted)]/70 hover:bg-[var(--sera-ink)]/[0.04] hover:text-[var(--sera-muted)]"><X className="h-6 w-6" /></button>
        </div>
        <div className="border-b border-[var(--sera-line)] px-4 py-4 sm:px-6">
          <div className="flex gap-3 overflow-x-auto pb-1">
            {steps.map((step, index) => {
              const active = step === currentStep
              const done = index < currentIndex
              return (
                <button
                  key={step}
                  type="button"
                  onClick={() => index <= currentIndex && setCurrentStep(step)}
                  className={`flex min-w-[116px] flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left transition ${active ? 'bg-[var(--sera-orange)]/[0.06] text-[var(--sera-orange-deep)]' : done ? 'text-[var(--sera-orange)]' : 'text-[var(--sera-muted)]/70'}`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${active ? 'border-[var(--sera-orange)] bg-[var(--sera-orange)] text-white' : done ? 'border-[var(--sera-orange)] bg-[var(--sera-orange)] text-white' : 'border-[var(--sera-line)] bg-white text-[var(--sera-muted)]'}`}>
                    {done ? <Check className="h-4 w-4" /> : index + 1}
                  </span>
                  <span className="text-xs font-semibold sm:text-sm">{STEP_LABELS[step]}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-6 sm:px-6">
          {renderStep()}
        </div>
        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-[var(--sera-line)] bg-white px-5 py-4 sm:px-6">
          <Button type="button" variant="outline" onClick={currentIndex === 0 ? handleClose : goBack} disabled={saving} className="h-11 rounded-lg">
            {currentIndex === 0 ? 'Cancel' : <><ArrowLeft className="mr-2 h-4 w-4" />Back</>}
          </Button>
          {currentStep === 'review' ? (
            <Button type="button" onClick={handleSubmit} disabled={saving} className="h-11 rounded-lg bg-green-600 px-6 hover:bg-green-700">
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserPlus className="mr-2 h-4 w-4" />}
              {user ? 'Save User' : 'Create User'}
            </Button>
          ) : (
            <Button type="button" onClick={goNext} disabled={saving} className="h-11 rounded-lg bg-[var(--sera-orange)] px-6 hover:bg-[var(--sera-orange-deep)] text-white">
              Next
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
