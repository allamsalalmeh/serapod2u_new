'use client'

import { MAX_POLICY_SCOPE_PAIRS, missingScopeMessage, pruneSelections } from '@/lib/security-access/group-policy-picker'
import AccessProfileSelector, { scopesForPolicy, type AccessMode, type ProfileChoice, type SelectableProfile, type SelectableScope } from './AccessProfileSelector'
import { IdentityMatchNotice, lookupBlocker, useIdentityLookup, type EmployeeLink } from './IdentityMatch'
import { InfoPopover, FOCUS } from '@/components/security-access/ui'
import { scopeLabels } from '@/lib/security-access/scope-labels'
import { isHqOrgType } from '@/lib/security-access/ess-eligibility'
import UserEditAccess, { useEditAccess } from './UserEditAccess'
import { applyPlan, computePlan, initialItems, moverImpact, type ApplyOutcome } from '@/lib/users/edit-access'
import { callApi } from '@/components/security-access/client-api'
import { useSaCapability } from '@/hooks/useSaCapability'
import { employmentAllowedForOrgType } from '@/lib/users/employment-eligibility'
import { referenceAllowedForOrgType } from '@/lib/users/reference-eligibility'
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
  Building2,
  Camera,
  Check,
  CheckCircle2,
  CreditCard,
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
  X,
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

type WizardStep = 'basic' | 'access' | 'review'
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
  compact = false,
  onCheckedChange,
}: {
  checked: boolean
  disabled?: boolean
  /** Moves the explanatory sentence into the shared information popover. */
  compact?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  if (compact) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Checkbox id="can-be-reference" checked={checked} onCheckedChange={value => onCheckedChange(value === true)} disabled={disabled} />
        <Label htmlFor="can-be-reference" className="cursor-pointer text-sm font-medium text-gray-900">Reference</Label>
        <InfoPopover label="About the Reference setting"><p>Allow this user to be selected as a Reference in RoadTour campaigns.</p></InfoPopover>
      </div>
    )
  }
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
  /** False until the organization list has loaded successfully; gates the single-HQ auto-select. Defaults to true. */
  organizationsLoaded?: boolean
  open: boolean
  isSaving?: boolean
  currentUserRoleLevel?: number
  /** Root Access (server answer): the legacy role-level ceiling on assignable roles does not apply. Display only. */
  rootAccess?: boolean
  lockOrganization?: boolean
  defaultValues?: {
    organization_id?: string
    department_id?: string
    role_code?: string
  }
  onOpenChange: (open: boolean) => void
  /** Add User: open an existing account found by the identity check (the host closes this dialog). */
  onOpenExistingUser?: (userId: string) => void
  /** Seam for previews and tests; defaults to the server action. */
  accessOptionsLoader?: (organizationId: string | null) => Promise<any>
  /**
   * Add User: the new account. Edit User: the profile changes plus, when Group Policy changes are pending, a way to apply
   * them AFTER the profile is saved (a failure there is reported, never swallowed). A password reset is never part of a save.
   */
  onSave: (userData: Partial<User>, avatarFile?: File | null, access?: EditAccessSubmission) => void | Promise<void>
}

export interface EditAccessSubmission { apply: () => Promise<ApplyOutcome> }

const WIZARD_STEPS: WizardStep[] = ['basic', 'access', 'review']

const STEP_LABELS: Record<WizardStep, string> = { basic: 'Basic details', access: 'Organization & access', review: 'Review' }

export const USER_ORGANIZATION_TYPES: Array<{ value: OrganizationType; label: string; icon: typeof Building2 }> = [
  { value: 'HQ', label: 'HQ', icon: Building2 },
  { value: 'MFG', label: 'Manufacturer', icon: Factory },
  { value: 'DIST', label: 'Distributor', icon: Store },
  { value: 'SHOP', label: 'Shop', icon: Store },
]

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

/**
 * Edit User → Advanced: the stored legacy compatibility level. It is preserved on every save and never reset or promoted
 * automatically. The control exists only for someone with access-administration authority (the same decision the server
 * takes for a role change); everyone else keeps the stored value untouched and does not see it.
 */
function LegacyCompatibilitySection({ storedRole, value, roles, currentUserRoleLevel, organizationId, disabled, onChange }: {
  storedRole: Role | null
  value: string
  roles: Role[]
  currentUserRoleLevel: number
  organizationId: string | null
  disabled: boolean
  onChange: (roleCode: string) => void
}) {
  const allowed = useSaCapability('platform.identity_access.manage', currentUserRoleLevel <= 10, organizationId)
  if (!allowed) return null
  const options = storedRole && !roles.some(r => r.role_code === storedRole.role_code) ? [storedRole, ...roles] : roles
  return (
    <details className="rounded-lg border border-gray-200">
      <summary className={`cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-gray-950 ${FOCUS}`}>Advanced <span className="text-xs font-normal text-gray-500">(legacy compatibility)</span></summary>
      <div className="space-y-2 border-t border-gray-100 p-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
          <span>Stored level: <strong className="text-gray-900">{storedRole ? `${desiredRoleLabel(storedRole)} (Level ${storedRole.role_level})` : '—'}</strong></span>
          <InfoPopover label="About the legacy compatibility level">
            <p>A compatibility field for features still moving to Security &amp; Access. It is kept as it is on every save and is never reset or promoted automatically; business access comes from Group Policies.</p>
            <p>Changing it needs access-administration authority, and the server checks that again when you save.</p>
          </InfoPopover>
        </div>
        <Label htmlFor="user-dialog-legacy-level" className="text-sm">Change legacy level</Label>
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id="user-dialog-legacy-level" className="h-9 rounded-lg"><SelectValue placeholder="Keep the stored level" /></SelectTrigger>
          <SelectContent>{options.map(role => <SelectItem key={role.role_code} value={role.role_code}>{desiredRoleLabel(role)} (Level {role.role_level})</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </details>
  )
}

export default function UserDialogNew({
  user,
  roles,
  organizations,
  organizationsLoaded = true,
  open,
  isSaving = false,
  currentUserRoleLevel = 100,
  rootAccess = false,
  lockOrganization = false,
  defaultValues,
  onOpenChange,
  onOpenExistingUser,
  accessOptionsLoader = listInitialAccessRoles,
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
      .filter(role => rootAccess || role.role_level >= currentUserRoleLevel)
      .filter(role => [10, 20, 30, 40, 50].includes(role.role_level))
      .sort((a, b) => a.role_level - b.role_level)
  }, [currentUserRoleLevel, rootAccess, roles])

  const selectedRole = roles.find(r => r.role_code === formData.role_code)
  const selectedRoleLevel = selectedRole?.role_level
  const selectedOrg = organizations.find(o => o.id === formData.organization_id)
  const selectedOrgIsShop = selectedOrg?.org_type_code?.toUpperCase() === 'SHOP'
  const selectedDepartment = departments.find(dept => dept.id === formData.department_id)
  const selectedPosition = positions.find(position => position.id === formData.position_id)
  const selectedManager = orgUsers.find(orgUser => orgUser.id === formData.manager_user_id)
  // Creating a user no longer selects a legacy level, so the Guest (organization-less) shortcut exists only when editing.
  // The legacy GUEST level alone does not make an independent guest: see isGuest below (account organization + S&A memberships).
  const legacyGuest = Boolean(user) && selectedRoleLevel === 50
  // Optional initial Security & Access business role (create mode only; the
  // list is empty unless the administrator may assign roles in that org).
  const [initialRoles, setInitialRoles] = useState<Array<{ id: string; name: string; description: string | null }>>([])
  // canAssign: the administrator may grant business roles in this org.
  // legacyReadOnly: legacy role codes no longer grant access here, so a new
  // user without a business role can use only employee self-service.
  const [accessInfo, setAccessInfo] = useState<{ canAssign: boolean; legacyReadOnly: boolean } | null>(null)
  // Group Policies offered for the chosen organization (applicable, non-administrative) and the scopes
  // that may be chosen for each. Falls back to the plain role list before the profile migration.
  const [initialProfiles, setInitialProfiles] = useState<SelectableProfile[]>([])
  const [deferredProfiles, setDeferredProfiles] = useState<Array<{ id: string; name: string }>>([])
  const [ineligibleProfiles, setIneligibleProfiles] = useState<Array<{ id: string; name: string; message: string }>>([])
  const [initialScopes, setInitialScopes] = useState<SelectableScope[]>([])
  const [canOpenGroupPolicies, setCanOpenGroupPolicies] = useState(false)
  const [accessOrg, setAccessOrg] = useState<{ name: string | null; typeCode: string | null } | null>(null)
  const [orgNames, setOrgNames] = useState<Record<string, string>>({})
  // Visible, dismissible explanations of selections the form removed or reset (organization / email / phone changed).
  const [notices, setNotices] = useState<string[]>([])
  const [employeeLink, setEmployeeLink] = useState<EmployeeLink | null>(null)
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  const submitLock = useRef(false)
  const [linkedOnSuccess, setLinkedOnSuccess] = useState(false)
  const formRef = useRef<WizardUser>({})
  formRef.current = formData
  const addNotice = (message: string) => setNotices(prev => (prev.includes(message) ? prev : [...prev, message]))
  const selectedOrgIsHq = isHqOrgType(selectedOrg?.org_type_code)
  const isCreate = !user
  const editOrgChanged = Boolean(user) && (formData.organization_id || '') !== (user?.organization_id || '')

  // ── Edit User: current Group Policy access, the draft, and what a save would change ──────────────────────────
  // Loaded for every edited person: memberships are the real Security & Access data (a legacy GUEST can be an HQ member).
  const editAccess = useEditAccess({ enabled: open && Boolean(user), userId: user?.id, organizationId: user?.organization_id ?? null, loader: accessOptionsLoader })
  const activeMemberships = (editAccess.snapshot?.memberships ?? []).filter(m => m.status === 'active')
  // An independent guest: legacy GUEST with no organization on the account and no active organization membership.
  // A GUEST with an organization or an active membership is managed like any member (organization, Group Policies).
  const isGuest = legacyGuest && !user?.organization_id && activeMemberships.length === 0
  const [accessDraft, setAccessDraft] = useState<ProfileChoice[]>([])
  const [accessReason, setAccessReason] = useState('')
  const [moverAck, setMoverAck] = useState(false)
  // The draft restarts from what is stored after every load (open, retry, after a save attempt); closing discards it.
  useEffect(() => { setAccessDraft(editAccess.classified ? initialItems(editAccess.classified) : []) }, [editAccess.version]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open) { setAccessDraft([]); setAccessReason(''); setMoverAck(false) } }, [open])
  const accessPlan = editAccess.classified && !editOrgChanged && Boolean(editAccess.options?.canAssign) ? computePlan(editAccess.classified, accessDraft) : null
  const moverEffect = editOrgChanged && editAccess.snapshot ? moverImpact(editAccess.snapshot, formData.organization_id || null) : null
  // Moving the person ends the memberships that follow their organization (and every grant on them): always acknowledged first.
  const orgMoveNeedsAck = editOrgChanged && (!editAccess.snapshot || Boolean(moverEffect && (moverEffect.assignments.length || moverEffect.memberships.length)))

  // What the assignment-permission check said for the CURRENT organization. Never carried over from another organization.
  const [accessCheck, setAccessCheck] = useState<'idle' | 'checking' | 'authorized' | 'denied' | 'failed'>('idle')
  const [accessDenial, setAccessDenial] = useState<{ reason: string; cannotCreate: boolean } | null>(null)
  const [accessAttempt, setAccessAttempt] = useState(0)
  // Which stage of the check failed: the authorization decision itself, or the policy/scope lists loaded after it.
  const [accessFailedStage, setAccessFailedStage] = useState<string | null>(null)
  useEffect(() => {
    const reset = () => { setAccessFailedStage(null); setInitialRoles([]); setInitialProfiles([]); setDeferredProfiles([]); setIneligibleProfiles([]); setInitialScopes([]); setAccessOrg(null); setAccessInfo(null); setAccessDenial(null) }
    reset()
    if (user || !open || isGuest || !formData.organization_id) { setAccessCheck('idle'); return }
    setAccessCheck('checking')
    let cancelled = false
    accessOptionsLoader(formData.organization_id).then((r: any) => {
      if (cancelled) return
      if (!r?.success) { setAccessFailedStage(((r as any)?.failedStage as string | undefined) ?? null); setAccessCheck('failed'); return }
      setAccessDenial((r as any).denial ? { reason: (r as any).denial.reason, cannotCreate: Boolean((r as any).denial.cannotCreate) } : null)
      const profiles: SelectableProfile[] = ((r as any).profiles as SelectableProfile[] | undefined) ?? (r.roles || [])
      const scopes: SelectableScope[] = ((r as any).scopes as SelectableScope[] | undefined) ?? []
      setInitialRoles(r.roles || [])
      setInitialProfiles(profiles)
      setDeferredProfiles(((r as any).deferredProfiles as Array<{ id: string; name: string }> | undefined) ?? [])
      setIneligibleProfiles(((r as any).ineligibleProfiles as Array<{ id: string; name: string; message: string }> | undefined) ?? [])
      setInitialScopes(scopes)
      setOrgNames(((r as any).orgNames as Record<string, string> | undefined) ?? {})
      setAccessOrg((r as any).organization ?? null)
      setCanOpenGroupPolicies(Boolean((r as any).canOpenGroupPolicies))
      setAccessInfo({ canAssign: Boolean((r as any).canAssign), legacyReadOnly: Boolean((r as any).legacyReadOnly) })
      setAccessCheck(r.canAssign ? 'authorized' : 'denied')
      // A change of organization revalidates earlier choices: what no longer applies is removed AND explained, never kept silently.
      const current = formRef.current as any
      const picked: ProfileChoice[] = current.initial_profiles || []
      const { kept, removed } = pruneSelections({ profiles, scopes }, picked)
      const next: Record<string, unknown> = {}
      // ESS exclusion needs assignment authority and an HQ organization; it never survives a switch to anything else.
      if ((current as any).ess_excluded && (!r.canAssign || !(r as any).essAllowed)) {
        next.ess_excluded = false
        addNotice(!(r as any).essAllowed ? 'Employee Self Service is available to HQ users only, so the exclusion was cleared.' : 'The Employee Self Service exclusion was cleared because you cannot assign access in this organization.')
      }
      if (!r.canAssign) {
        if (picked.length || current.initial_role_id === 'profiles') { next.initial_profiles = []; next.initial_role_id = ''; addNotice('Group Policies were cleared because you cannot assign them in this organization.') }
      } else if (removed > 0) {
        next.initial_profiles = kept
        addNotice(`${removed} selected Group Policy ${removed === 1 ? 'selection does' : 'selections do'} not apply to this organization and ${removed === 1 ? 'was' : 'were'} removed. Review the list below.`)
      }
      if (current.initial_role_id === 'self' && !(r as any).essAllowed) {
        // 'self' is the HQ "no additional policy" state; a non-HQ organization asks for its own explicit choice.
        next.initial_role_id = ''
        addNotice('Employee Self Service is available to HQ users only, so it was removed. Choose Group Policies or “No Group Policy for now”.')
      } else if (current.initial_role_id === 'profiles' && (r as any).essAllowed && !((next.initial_profiles ?? picked) as ProfileChoice[]).length) {
        next.initial_role_id = 'self'
      }
      if (Object.keys(next).length) setFormData(prev => ({ ...prev, ...next } as any))
    }).catch(() => { if (!cancelled) setAccessCheck('failed') })
    return () => { cancelled = true }
  }, [user, open, isGuest, formData.organization_id, accessAttempt])
  // Business access must be an explicit choice when it can be granted here.
  const accessChoiceRequired = !user && !isGuest && accessCheck === 'authorized' && initialRoles.length > 0 && !selectedOrgIsHq
  // HQ staff hold Employee Self Service by default; additional Group Policies are optional, so no explicit choice is required.
  const hqEssSelector = !user && !isGuest && accessCheck === 'authorized' && selectedOrgIsHq
  const essExcluded = Boolean((formData as any).ess_excluded) && hqEssSelector
  const showBusinessStep = organizationType === 'SHOP' || selectedOrgIsShop
  // Employment details are HQ-only (judged on the organization's stored type; the server checks it again on create).
  const showHrFields = Boolean(
    formData.organization_id &&
    selectedOrg &&
    selectedOrgIsHq &&
    // Create has no legacy level: eligibility is the organization's stored type alone. Editing keeps its level rule.
    (!user || [1, 10, 20, 30, 40].includes(selectedRoleLevel || 0))
  )
  // Identity onboarding (create) does not collect banking: payee details belong to an employee/vendor/beneficiary domain.
  // Existing banking data is shown and editable on an existing user (see bankingAvailable).
  // Banking details are shown (and sent) only when the record the administrator was given carries them: never invented or cleared.
  const bankingAvailable = Boolean(user) && ['bank_id', 'bank_account_number', 'bank_account_holder_name'].some(k => k in (user as object))
  // Adding and editing a user share the same three steps: Basic details → Organization & access → Review.
  const steps = WIZARD_STEPS
  const lookup = useIdentityLookup({ email: formData.email, phone: formData.phone, organizationId: formData.organization_id, enabled: open && isCreate && !isGuest })
  const lookupKey = `${(formData.email || '').trim().toLowerCase()}|${(formData.phone || '').trim()}|${formData.organization_id || ''}`
  // The link belongs to one email / phone / organization combination; any change drops it and the lookup offers it again if it still matches.
  useEffect(() => {
    if (!employeeLink || employeeLink.key === lookupKey) return
    const orgChanged = employeeLink.key.split('|')[2] !== (formData.organization_id || '')
    setEmployeeLink(null)
    addNotice(orgChanged && !selectedOrgIsHq
      ? 'Employee Self Service is available to HQ users only, so the HR employee link was removed.'
      : 'The HR employee link was removed because the email, phone or organization changed. Check the match again.')
  }, [lookupKey])
  // Reference is HQ-only. A pending value is cleared when the organization is not HQ (never restored on switching back).
  // An existing user's stored value is left alone: it is simply not editable while the organization is non-HQ.
  const referenceAllowed = referenceAllowedForOrgType(selectedOrg?.org_type_code)
  useEffect(() => {
    if (referenceAllowed || user || !formData.can_be_reference) return
    setFormData(prev => ({ ...prev, can_be_reference: false }))
  }, [referenceAllowed, user, formData.can_be_reference])
  // Employment details are HQ-only. On a new account, pending values are cleared when the organization is not HQ and are
  // never restored on switching back. An existing user's stored values are left alone (the section is just not shown).
  useEffect(() => {
    if (user || !formData.organization_id || employmentAllowedForOrgType(selectedOrg?.org_type_code)) return
    const f = formRef.current as any
    const pending = ['department_id', 'manager_user_id', 'position_id', 'employment_type', 'join_date'].some(k => Boolean(f[k])) || (f.employment_status && f.employment_status !== 'active')
    if (!pending) return
    setFormData(prev => ({ ...prev, department_id: '', manager_user_id: '', position_id: '', employment_type: '', join_date: '', employment_status: 'active' }))
    addNotice('Employment details are available for HQ accounts only, so the pending employment selections were cleared.')
  }, [selectedOrg?.org_type_code, formData.organization_id, user])
  const filteredOrganizations = filterOrganizationsForType(organizations, organizationType, organizationSearch)
  // Add User: when exactly one HQ organization is available, select it as a manual pick would (the existing
  // organization_id effects then load policies and scopes). Only for an empty HQ selection on the access step.
  const singleHqOrg = (() => {
    if (user || isGuest || lockOrganization || !organizationsLoaded || organizationType !== 'HQ') return null
    const hq = filterOrganizationsForType(organizations, 'HQ')
    return hq.length === 1 ? hq[0] : null
  })()
  useEffect(() => {
    if (!open || currentStep !== 'access' || !singleHqOrg || formData.organization_id) return
    setFormData(prev => prev.organization_id ? prev : { ...prev, organization_id: singleHqOrg.id, department_id: '', manager_user_id: '', position_id: '' })
    clearFieldError('organization_id')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentStep, singleHqOrg?.id, formData.organization_id])

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
        role_code: '', // creating a user never carries a legacy level
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
    setNotices([])
    setEmployeeLink(null)
    setLinkedOnSuccess(false)
    submitLock.current = false
  }, [defaultValues?.department_id, defaultValues?.organization_id, open, organizations, user])

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
    // A registered email is not an input error by itself: the identity check below offers to link an eligible HQ employee,
    // otherwise it explains that no second account is created. Creating is blocked either way (client and server).
    setEmailCheckStatus(data && data.length > 0 ? 'taken' : 'available')
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
    if (!formData.phone?.trim()) next.phone = 'Phone number is required'
    else {
      const validation = validatePhoneNumber(formData.phone)
      if (!validation.isValid) next.phone = validation.error || 'Invalid phone number format'
    }
    // An existing person keeps their login: a password is only needed for a brand-new account.
    const existingPerson = emailCheckStatus === 'taken' || phoneCheckStatus === 'taken' || Boolean(employeeLink)
    if (!user && !existingPerson) {
      if (!formData.password) next.password = 'Password is required'
      else if (formData.password.length < 6) next.password = 'Password must be at least 6 characters'
      if (!formData.confirmPassword) next.confirmPassword = 'Please confirm your password'
      else if (formData.password !== formData.confirmPassword) next.confirmPassword = 'Passwords do not match'
    }
    return next
  }

  const validateAccess = () => {
    const next: Record<string, string> = {}
    // Keys are added in screen order: the first one is focused when validation fails.
    if (!isGuest && !formData.organization_id) {
      next.organization_id = `${organizationType === 'HQ' ? 'HQ' : getOrgTypeName(organizationType)} organization is required`
    }
    if (isCreate && !isGuest && formData.organization_id) {
      // Nothing is assigned unchecked: the permission check must have completed, and creating users here must be allowed.
      if (accessCheck === 'checking') next.access_authority = 'Assignment permissions are still being checked.'
      else if (accessCheck === 'failed') next.access_authority = 'Unable to check assignment permissions. Retry before continuing.'
      else if (accessCheck === 'denied' && accessDenial?.cannotCreate) next.access_authority = accessDenial.reason
      const blocker = lookupBlocker(lookup, Boolean(employeeLink))
      if (blocker) next.identity = blocker
    }
    if (accessChoiceRequired || hqEssSelector) {
      const picked: ProfileChoice[] = (formData as any).initial_profiles || []
      const choice = hqEssSelector ? (picked.length ? 'profiles' : 'self') : (formData as any).initial_role_id
      if (!choice) next.initial_role_id = 'Choose the business access for this person: Group Policies, or none for now.'
      else if (choice === 'profiles') {
        if (picked.length === 0) next.initial_profiles = 'Select at least one Group Policy (or choose “No Group Policy for now”).'
        else if (picked.length > MAX_POLICY_SCOPE_PAIRS) next.initial_profiles = `At most ${MAX_POLICY_SCOPE_PAIRS} policy and scope selections can be made at once.`
        else if (picked.some(p => !p.roleId)) next.initial_profiles = 'A selected Group Policy is not valid. Untick it and choose again.'
        else if (picked.some(p => !p.scopeId)) next.initial_profiles = missingScopeMessage({ profiles: initialProfiles, scopes: initialScopes }, picked) ?? 'Each Group Policy needs its own scope.'
        else if (new Set(picked.map(p => `${p.roleId}:${p.scopeId}`)).size !== picked.length) next.initial_profiles = 'The same Group Policy and scope were added twice.'
        else if (picked.some(p => !initialProfiles.some(x => x.id === p.roleId) || !scopesForPolicy(initialProfiles.find(x => x.id === p.roleId), initialScopes).some(x => x.id === p.scopeId))) next.initial_profiles = 'A selected Group Policy or scope does not apply to this organization. Remove it and choose again.'
      } else if (choice !== 'self') next.initial_role_id = 'Choose the business access for this person.'
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

  // Edit User: what a save would change must be complete before it is submitted (never a broader grant, never an unexplained one).
  const validateEditReview = () => {
    const next: Record<string, string> = {}
    if (!user) return next
    if (accessPlan?.incomplete) next.initial_profiles = accessPlan.incomplete
    if (accessPlan && !accessPlan.empty && accessReason.trim().length < 5) next.access_reason = 'Enter a reason of at least 5 characters for the Group Policy changes (it is recorded in the access change log).'
    if (orgMoveNeedsAck && !moverAck) next.org_move = 'Confirm that you understand what moving this person ends.'
    return next
  }

  const FIELD_ORDER = ['full_name', 'email', 'phone', 'password', 'confirmPassword', 'bank_account_number', 'organization_id', 'access_authority', 'identity', 'initial_role_id', 'initial_profiles', 'access_reason', 'org_move'] as const
  const FIELD_STEP: Record<string, WizardStep> = { full_name: 'basic', email: 'basic', phone: 'basic', password: 'basic', confirmPassword: 'basic', organization_id: 'access', access_authority: 'access', identity: 'access', initial_role_id: 'access', initial_profiles: 'access', bank_account_number: 'basic', access_reason: 'review', org_move: 'review' }
  const FIELD_ID: Record<string, string> = { full_name: 'user-dialog-full-name', email: 'user-dialog-email', phone: 'user-dialog-phone', password: 'user-dialog-password', confirmPassword: 'user-dialog-confirm-password', organization_id: 'user-dialog-organization', access_authority: 'user-dialog-access-status', identity: 'user-dialog-identity', initial_role_id: 'user-dialog-access', initial_profiles: 'user-dialog-access', bank_account_number: 'user-dialog-bank-account', access_reason: 'user-dialog-access-reason', org_move: 'user-dialog-org-move' }
  const firstInvalid = (errs: Record<string, string>) => FIELD_ORDER.find(k => errs[k])

  const validateStep = (step: WizardStep) => {
    const next = {
      ...(step === 'basic' ? { ...validateBasic(), ...(bankingAvailable ? validateBanking() : {}) } : {}),
      ...(step === 'access' ? { ...validateAccess(), ...(user && validateEditReview().initial_profiles ? { initial_profiles: validateEditReview().initial_profiles } : {}) } : {}),
    }
    setErrors(prev => ({ ...prev, ...next }))
    const first = firstInvalid(next)
    if (first) {
      setPendingFocus(first)
    }
    return Object.keys(next).length === 0
  }

  const validateAll = () => {
    const next = { ...validateBasic(), ...(bankingAvailable ? validateBanking() : {}), ...validateAccess(), ...validateEditReview() }
    setErrors(next)
    const first = firstInvalid(next)
    if (first) {
      setCurrentStep(FIELD_STEP[first] ?? 'basic')
      setPendingFocus(first)
      return false
    }
    return true
  }

  // Focus the first invalid field once the step containing it is on screen.
  useEffect(() => {
    if (!pendingFocus) return
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(FIELD_ID[pendingFocus] ?? '')
      if (el) { el.focus(); el.scrollIntoView?.({ block: 'center' }) }
      setPendingFocus(null)
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocus, currentStep])

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
    if (submitLock.current) return
    if (!validateAll()) return
    submitLock.current = true
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
      // A password is only ever set when creating; editing never carries one (a reset is its own action).
      if (user) delete (dataToSave as any).password
      // A new user is always created Active: never trust a stale form value (the Active control exists only when editing).
      if (!user) dataToSave.is_active = true
      if (!referenceAllowed) {
        // HQ-only: a new non-HQ account never carries Reference; an edit leaves the stored value untouched.
        if (user) delete (dataToSave as any).can_be_reference
        else (dataToSave as any).can_be_reference = false
      }
      // Employee Self Service: sent only for HQ (default = included; an explicit exclusion travels as false). The server re-judges it.
      delete (dataToSave as any).ess_excluded
      if (!user) {
        if (hqEssSelector) (dataToSave as any).include_ess = !essExcluded
        else delete (dataToSave as any).include_ess
      }
      if (employeeLink) {
        // Linking an existing employee keeps their login: no password travels with the request.
        (dataToSave as any).linked_user_id = employeeLink.userId
        delete (dataToSave as any).password
      }
      const finalAvatarFile = sourceAvatarFile
        ? await compressImage(sourceAvatarFile, avatarCropPosition)
        : avatarFile
      if (user && !bankingAvailable) {
        // Banking was not part of the record this administrator received: it is neither shown nor sent (nothing is cleared).
        for (const key of ['bank_id', 'bank_account_number', 'bank_account_holder_name']) delete (dataToSave as any)[key]
      }
      const plan = user && accessPlan && !accessPlan.empty ? accessPlan : null
      const access: EditAccessSubmission | undefined = user && plan ? {
        apply: async () => {
          const outcome = await applyPlan(plan, {
            userId: user.id, organizationId: user.organization_id as string, reason: accessReason.trim(),
            names: id => editAccess.options?.profiles.find(p => p.id === id)?.name ?? 'a policy',
          }, callApi)
          // What is stored now is the new starting point, whether everything or only part was applied.
          editAccess.refresh()
          return outcome
        },
      } : undefined
      await onSave(dataToSave as Partial<User>, finalAvatarFile, access)
      if (!user) {
        setLinkedOnSuccess(Boolean(employeeLink))
        setSuccess(true)
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Failed to save user')
    } finally {
      submitLock.current = false
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
    setLinkedOnSuccess(false)
    setEmployeeLink(null)
    setNotices([])
    submitLock.current = false
    setCurrentStep('basic')
    setFormData({
      email: '',
      full_name: '',
      call_name: '',
      phone: '',
      password: '',
      confirmPassword: '',
      role_code: '', // creating a user never carries a legacy level
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
  const inputClass = (field: string, extra = '') => `h-9 rounded-lg border-[var(--sera-line)] text-sm ${errors[field] ? 'border-red-500 focus-visible:ring-red-200' : ''} ${extra}`

  const summaryValue = (value?: string | null) => value?.trim() || '-'

  const identityNotice = (
    <IdentityMatchNotice
      state={lookup}
      link={employeeLink}
      currentName={formData.full_name || ''}
      disabled={saving}
      onLink={(replaceName) => {
        if (lookup.phase !== 'done' || lookup.result.status !== 'employee') return
        const r = lookup.result
        setEmployeeLink({ userId: r.userId, name: r.name, organizationName: r.organizationName, employeeNo: r.employeeNo, key: lookupKey })
        if (replaceName && r.name) handleInputChange('full_name', r.name)
        clearFieldError('identity')
      }}
      onUnlink={() => setEmployeeLink(null)}
      onOpenUser={onOpenExistingUser}
    />
  )

  const renderBasicStep = () => (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-950">Basic details</h3>
        <p className="text-xs text-gray-500">{isCreate ? 'Who is this person? Their login is created from the email and password.' : 'Who is this person? The login email is fixed; resetting the password is a separate action below.'}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-[88px_1fr]">
        <div className="flex flex-row items-center gap-3 sm:flex-col sm:items-center">
          <div
            role="button"
            tabIndex={0}
            aria-label={avatarPreview ? 'Profile photo (drag to reposition)' : 'Upload profile photo'}
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
            className={`group flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-[var(--sera-orange)] to-[var(--sera-orange-deep)] text-white shadow-sm ring-2 ring-[var(--sera-orange)]/10 ${saving ? 'pointer-events-none opacity-70' : avatarPreview ? 'cursor-move' : 'cursor-pointer'}`}
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
              <div className="relative flex h-full w-full items-center justify-center bg-gray-200 text-lg font-medium text-[var(--sera-ink)]/80">
                {getInitials(formData.full_name)}
                <span className="absolute bottom-0.5 right-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--sera-orange)] text-white shadow-sm">
                  <Camera className="h-3.5 w-3.5" />
                </span>
              </div>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="image/jpeg,image/jpg,image/png,image/gif,image/webp" onChange={handleAvatarChange} className="hidden" />
          <div className="flex flex-col items-start gap-0.5 sm:items-center">
            <Button type="button" variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} disabled={saving} className="h-7 px-2 text-xs text-[var(--sera-orange)]">
              <Upload className="mr-1 h-3.5 w-3.5" />
              {avatarPreview ? 'Change' : 'Upload'}
            </Button>
            {avatarFile || avatarPreview ? (
              <Button type="button" variant="ghost" size="sm" onClick={resetAvatarUpload} disabled={saving} className="h-6 px-2 text-xs text-red-500">
                Remove
              </Button>
            ) : null}
          </div>
          {renderFieldError('avatar')}
        </div>
        <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="user-dialog-full-name" className="text-sm">Full Name <span className="text-red-500" aria-hidden>*</span></Label>
            <Input id="user-dialog-full-name" name="user_dialog_full_name" autoComplete="off" aria-invalid={Boolean(errors.full_name)} aria-required value={formData.full_name || ''} onChange={e => handleInputChange('full_name', e.target.value)} disabled={saving} placeholder="Enter full name" className={inputClass('full_name')} />
            {renderFieldError('full_name')}
          </div>
          <div className="space-y-1">
            <Label htmlFor="user-dialog-call-name" className="text-sm">Call Name <span className="font-normal text-[var(--sera-muted)]/70">(Optional)</span></Label>
            <Input id="user-dialog-call-name" name="user_dialog_call_name" autoComplete="off" value={formData.call_name || ''} onChange={e => handleInputChange('call_name', e.target.value)} disabled={saving} placeholder="Short name / preferred name" className={inputClass('call_name')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="user-dialog-email" className="text-sm">Email <span className="text-red-500" aria-hidden>*</span></Label>
            <div className="relative">
              <Mail className="absolute left-3 top-2.5 h-4 w-4 text-[var(--sera-muted)]/70" />
              <Input id="user-dialog-email" name="user_dialog_email" type="email" inputMode="email" autoComplete="off" aria-invalid={Boolean(errors.email)} aria-required value={formData.email || ''} onChange={e => handleInputChange('email', e.target.value)} disabled={saving || !!user} placeholder="Enter email address" className={inputClass('email', 'pl-9')} />
              {emailCheckStatus === 'checking' ? <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-[var(--sera-muted)]/70" /> : null}
              {emailCheckStatus === 'available' ? <CheckCircle2 className="absolute right-3 top-2.5 h-4 w-4 text-green-500" /> : null}
            </div>
            {renderFieldError('email') || (isCreate && emailCheckStatus === 'taken' ? <p className="text-xs text-amber-700">This email is already registered. Continue to Organization &amp; access to check whether the person can be linked.</p> : null)}
          </div>
          <div className="space-y-1">
            <Label htmlFor="user-dialog-phone" className="text-sm">Phone Number <span className="text-red-500" aria-hidden>*</span></Label>
            <div className="relative">
              <Phone className="absolute left-3 top-2.5 h-4 w-4 text-[var(--sera-muted)]/70" />
              {/* A telephone field of the person being edited/created, never the signed-in administrator's login: not a username, no browser autofill. */}
              <Input id="user-dialog-phone" name="user_dialog_phone" type="tel" inputMode="tel" autoComplete="off" aria-invalid={Boolean(errors.phone)} aria-required value={formData.phone || ''} onChange={e => handleInputChange('phone', e.target.value)} disabled={saving} placeholder="Enter your phone number" className={inputClass('phone', 'pl-9')} />
              {phoneCheckStatus === 'checking' ? <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-[var(--sera-muted)]/70" /> : null}
              {phoneCheckStatus === 'available' ? <CheckCircle2 className="absolute right-3 top-2.5 h-4 w-4 text-green-500" /> : null}
            </div>
            {renderFieldError('phone') || (isCreate && phoneCheckStatus === 'taken'
              ? <p className="text-xs text-amber-700">This phone number is already registered. Continue to Organization &amp; access to check whether the person can be linked.</p>
              : <p className="text-xs text-[var(--sera-muted)]/70">{phoneCheckStatus === 'available' ? 'Phone number is available' : 'Malaysia (+60) or China (+86)'}</p>)}
          </div>
          {!user ? (
            // One grid so the two visibility buttons can follow BOTH inputs in the DOM (Password → Confirm Password → eye buttons)
            // while sitting visually inside their own input. Rows: label / input / error; columns stack on small screens.
            <div className="grid gap-x-4 gap-y-1 md:col-span-2 md:grid-cols-2">
              <Label htmlFor="user-dialog-password" className="row-start-1 text-sm md:col-start-1">Password <span className="text-red-500" aria-hidden>*</span></Label>
              <Input id="user-dialog-password" name="user_dialog_new_password" type={showPassword ? 'text' : 'password'} autoComplete="new-password" aria-invalid={Boolean(errors.password)} aria-required value={formData.password || ''} onChange={e => handleInputChange('password', e.target.value)} disabled={saving} placeholder="Min. 6 characters" className={inputClass('password', 'row-start-2 pr-10 md:col-start-1')} />
              <div className="row-start-3 md:col-start-1">{renderFieldError('password')}</div>
              <Label htmlFor="user-dialog-confirm-password" className="row-start-4 text-sm md:col-start-2 md:row-start-1">Confirm Password <span className="text-red-500" aria-hidden>*</span></Label>
              <Input id="user-dialog-confirm-password" name="user_dialog_confirm_password" type={showConfirmPassword ? 'text' : 'password'} autoComplete="new-password" aria-invalid={Boolean(errors.confirmPassword)} aria-required value={formData.confirmPassword || ''} onChange={e => handleInputChange('confirmPassword', e.target.value)} disabled={saving} placeholder="Re-enter password" className={inputClass('confirmPassword', 'row-start-5 pr-10 md:col-start-2 md:row-start-2')} />
              <div className="row-start-6 md:col-start-2 md:row-start-3">{renderFieldError('confirmPassword')}</div>
              <button type="button" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} aria-controls="user-dialog-password" disabled={saving}
                className="row-start-2 mr-3 self-center justify-self-end text-[var(--sera-muted)]/70 md:col-start-1">
                {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </button>
              <button type="button" onClick={() => setShowConfirmPassword(v => !v)} aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'} aria-pressed={showConfirmPassword} aria-controls="user-dialog-confirm-password" disabled={saving}
                className="row-start-5 mr-3 self-center justify-self-end text-[var(--sera-muted)]/70 md:col-start-2 md:row-start-2">
                {showConfirmPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </button>
            </div>
          ) : null}
          {isCreate && formData.organization_id ? <div className="md:col-span-2">{identityNotice}</div> : null}
        </div>
      </div>
      {user ? (
        <UserPasswordResetSection
          targetUserId={user.id}
          targetUserName={getDisplayName(user)}
          targetUserEmail={user.email}
          currentUserRoleLevel={currentUserRoleLevel}
          targetOrganizationId={user.organization_id ?? null}
        />
      ) : null}
      {!isCreate && bankingAvailable ? renderBankingDetails() : null}
    </div>
  )

  const renderHrFields = () => (
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
  )

  const renderBusinessStep = () => (
    <div className="sera-sc-page space-y-6">
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

  const SummaryCard = ({ title, icon, step, children }: { title: string; icon: React.ReactNode; step: WizardStep; children: React.ReactNode }) => (
    <div className="rounded-lg border border-[var(--sera-line)] bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--sera-ink)]">{icon}{title}</div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setCurrentStep(step)} className="h-7 px-2 text-xs text-[var(--sera-orange)]">Edit</Button>
      </div>
      <div className="space-y-2 text-sm text-[var(--sera-muted)]">{children}</div>
    </div>
  )

  /** Organization type + organization, shared by Add User and Edit User (same markup, same selection rules). */
  const renderOrganizationPicker = () => (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="space-y-1">
        <Label className="text-sm">Organization Type</Label>
        <div className="grid grid-cols-2 gap-2">
          {USER_ORGANIZATION_TYPES.map(type => {
            const Icon = type.icon
            const active = organizationType === type.value
            return (
              <button key={type.value} type="button" aria-pressed={active} onClick={() => selectOrganizationType(type.value)} disabled={saving || lockOrganization || isGuest}
                className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border text-sm font-medium transition ${active ? 'border-orange-400 bg-orange-50 text-orange-800' : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'} ${FOCUS}`}>
                <Icon className="h-3.5 w-3.5" aria-hidden />{type.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="user-dialog-organization" className="text-sm">Organization {!isGuest ? <span className="text-red-500" aria-hidden>*</span> : null}</Label>
        <Select
          value={formData.organization_id || ''}
          onValueChange={(value) => {
            setFormData(prev => ({ ...prev, organization_id: value, department_id: '', manager_user_id: '', position_id: '' }))
            clearFieldError('organization_id')
            setSubmitError(null)
          }}
          disabled={saving || lockOrganization || isGuest}
        >
          <SelectTrigger id="user-dialog-organization" aria-invalid={Boolean(errors.organization_id)} className={`h-9 rounded-lg ${errors.organization_id ? 'border-red-500' : ''}`}>
            <SelectValue placeholder={isGuest ? 'Independent guest' : 'Search organization...'} />
          </SelectTrigger>
          <SelectContent className="max-h-[260px]">
            <div className="sticky top-0 z-10 bg-white p-2">
              <Input value={organizationSearch} onChange={(event) => setOrganizationSearch(event.target.value)} onKeyDown={(event) => event.stopPropagation()} placeholder="Search organization..." className="h-9" />
            </div>
            {filteredOrganizations.map(org => (<SelectItem key={org.id} value={org.id}>{org.org_name} ({org.org_code})</SelectItem>))}
            {filteredOrganizations.length === 0 ? <p className="px-3 py-2 text-xs text-[var(--sera-muted)]">No matching organizations.</p> : null}
          </SelectContent>
        </Select>
        {renderFieldError('organization_id')}
        {!isGuest && organizationsLoaded && !formData.organization_id && filterOrganizationsForType(organizations, organizationType).length === 0 ? <p role="status" className="text-xs text-amber-700">No {organizationType === 'HQ' ? 'HQ' : getOrgTypeName(organizationType)} organization is available to you.</p> : null}
        {isGuest ? <p className="text-xs text-gray-500">Guest users can be independent unless an organization is selected later by an admin.</p> : null}
      </div>
    </div>
  )

  const renderCreateAccessStep = () => {
    return (
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-950">Organization &amp; access</h3>
          <p className="text-xs text-gray-500">Choose where this person belongs, then what they can do.</p>
        </div>
        {renderOrganizationPicker()}

        {notices.length > 0 && (
          <div role="status" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {notices.map(n => <p key={n}>{n}</p>)}
            <button type="button" onClick={() => setNotices([])} className={`rounded font-medium underline ${FOCUS}`}>Dismiss</button>
          </div>
        )}

        {formData.organization_id && !isGuest ? (
          <div id="user-dialog-identity" tabIndex={-1} className={`space-y-1 rounded-lg focus:outline-none ${errors.identity ? 'ring-2 ring-red-200' : ''}`}>
            {identityNotice}
            {errors.identity && !(lookup.phase === 'done' && ['account_exists', 'conflict', 'blocked'].includes(lookup.result.status)) && lookup.phase !== 'checking' && lookup.phase !== 'denied'
              ? <p role="alert" className="text-xs text-red-600">{errors.identity}</p> : null}
          </div>
        ) : null}

        {referenceAllowed ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2">
            <ReferenceCheckbox compact checked={Boolean(formData.can_be_reference)} onCheckedChange={checked => handleInputChange('can_be_reference', checked)} disabled={saving} />
          </div>
        ) : null}

        {formData.organization_id && !isGuest ? (
          <div id="user-dialog-access-status" tabIndex={-1} className="space-y-2 focus:outline-none">
            {accessCheck === 'checking' && (
              <p role="status" className="flex items-center gap-2 text-sm text-gray-600"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Checking assignment permissions…</p>
            )}
            {accessCheck === 'failed' && (
              <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{accessFailedStage === 'catalogue' || accessFailedStage === 'scopes' ? 'Your permission was confirmed, but the Group Policies or scopes for this organization could not be loaded. Nothing can be assigned until they load.' : 'Unable to check assignment permissions. Nothing can be assigned until the check succeeds.'}</span>
                <button type="button" onClick={() => setAccessAttempt(n => n + 1)} className={`rounded-lg border border-red-300 px-3 py-1 text-xs font-medium ${FOCUS}`}>Retry</button>
              </div>
            )}
            {accessCheck === 'denied' && (
              <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                <p>{accessDenial?.reason ?? 'You cannot assign Group Policies in this organization.'}</p>
                {accessDenial && !accessDenial.cannotCreate && <p className="mt-1 text-xs">You can still create the user without Group Policies; someone with assignment authority here can grant them afterwards in Security &amp; Access → People &amp; Access.</p>}
              </div>
            )}
            {accessCheck === 'authorized' && (accessChoiceRequired || hqEssSelector ? (
              <AccessProfileSelector
                disabled={saving}
                essAllowed={selectedOrgIsHq}
                groupPoliciesHref={canOpenGroupPolicies ? '/security-access?tab=roles' : null}
                organizationName={accessOrg?.name ?? selectedOrg?.org_name ?? null}
                organizationTypeCode={accessOrg?.typeCode ?? selectedOrg?.org_type_code ?? null}
                profiles={initialProfiles}
                deferredProfiles={deferredProfiles}
                ineligibleProfiles={ineligibleProfiles}
                scopes={initialScopes}
                orgNames={orgNames}
                mode={selectedOrgIsHq ? ((((formData as any).initial_profiles as ProfileChoice[]) || []).length ? 'profiles' : 'self') : (((formData as any).initial_role_id as string) || '') as AccessMode}
                items={((formData as any).initial_profiles as ProfileChoice[]) || []}
                errors={{ mode: errors.initial_role_id, items: errors.initial_profiles }}
                essExcluded={essExcluded}
                onEssExcluded={excluded => { setFormData(prev => ({ ...prev, ess_excluded: excluded } as any)) }}
                onMode={m => { setFormData(prev => ({ ...prev, initial_role_id: m, ...(m === 'self' ? { initial_profiles: [] } : {}) } as any)); clearFieldError('initial_role_id') }}
                onItems={items => { setFormData(prev => ({ ...prev, initial_profiles: items, ...(selectedOrgIsHq ? { initial_role_id: items.length ? 'profiles' : 'self' } : {}) } as any)); clearFieldError('initial_profiles') }}
              />
            ) : (
              <p role="note" className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700">
                You may assign Group Policies here, but none is eligible for this organization and account type{deferredProfiles.length ? ` (${deferredProfiles.map(d => d.name).join(', ')} can only be assigned after the person exists)` : ''}. The user can be created without one.
              </p>
            ))}
            {errors.access_authority && accessCheck !== 'denied' && accessCheck !== 'failed' && accessCheck !== 'checking' ? <p role="alert" className="text-xs text-red-600">{errors.access_authority}</p> : null}
          </div>
        ) : (
          !isGuest && <p className="text-xs text-gray-500">Choose an organization to see the Group Policies you can assign.</p>
        )}

        {showHrFields ? (
          <details className="rounded-lg border border-gray-200">
            <summary className={`cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-gray-950 ${FOCUS}`}>Employment details <span className="text-xs font-normal text-gray-500">(optional)</span></summary>
            <div className="space-y-3 border-t border-gray-100 p-3">
              <p className="text-xs text-gray-500">Department, position and reporting line are organizational facts only; they never grant access.</p>
              {renderHrFields()}
            </div>
          </details>
        ) : null}

        {showBusinessStep ? (
          <details className="rounded-lg border border-gray-200">
            <summary className={`cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-gray-950 ${FOCUS}`}>Shop details <span className="text-xs font-normal text-gray-500">(optional)</span></summary>
            <div className="p-3">{renderBusinessStep()}</div>
          </details>
        ) : null}
      </div>
    )
  }

  const renderCreateReview = () => {
    const picked: ProfileChoice[] = (formData as any).initial_profiles || []
    const mode = ((formData as any).initial_role_id as string) || ''
    const fallback = scopeLabels(initialScopes, new Map(Object.entries(orgNames)))
    const labels = new Map(initialScopes.map(sc => [sc.id, sc.label ?? fallback.get(sc.id) ?? sc.display_name]))
    const coverage = (id: string) => initialScopes.find(sc => sc.id === id)?.coverage
    const policy = (id: string) => initialProfiles.find(p => p.id === id)?.name ?? 'Policy'
    const row = (label: string, value: React.ReactNode) => (<div className="flex gap-2"><dt className="w-36 shrink-0 text-gray-500">{label}</dt><dd className="min-w-0 font-medium text-gray-900">{value}</dd></div>)
    return (
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-950">Review</h3>
          <p className="text-xs text-gray-500">Check the details before creating the user. Passwords are never shown.</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <SummaryCard title="Basic details" icon={<UserIcon className="h-4 w-4 text-[var(--sera-orange)]" />} step="basic">
            <dl className="space-y-1 text-sm">
              {row('Full name', summaryValue(formData.full_name))}
              {row('Call name', summaryValue(formData.call_name))}
              {row('Email', summaryValue(formData.email))}
              {row('Phone', summaryValue(formData.phone))}
              {row('Password', employeeLink ? 'Existing login kept' : 'Set (hidden)')}
            </dl>
          </SummaryCard>
          <SummaryCard title="Organization" icon={<Building2 className="h-4 w-4 text-[var(--sera-orange)]" />} step="access">
            <dl className="space-y-1 text-sm">
              {row('Type', organizationType === 'HQ' ? 'HQ' : getOrgTypeName(organizationType))}
              {row('Organization', selectedOrg ? `${selectedOrg.org_name} (${selectedOrg.org_code})` : '-')}
              {row('Status', 'Active')}
              {referenceAllowed ? row('Reference', formData.can_be_reference ? 'Yes' : 'No') : null}
              {selectedOrgIsHq ? row('HR employee', employeeLink ? `Linked: ${employeeLink.name || 'Employee'}${employeeLink.organizationName ? ` · ${employeeLink.organizationName}` : ''}` : 'Not linked (a new account is created)') : null}
            </dl>
          </SummaryCard>
          <SummaryCard title="Group Policies" icon={<Shield className="h-4 w-4 text-[var(--sera-orange)]" />} step="access">
            {(mode === 'profiles' || (selectedOrgIsHq && picked.length > 0)) && picked.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-4 text-sm">{picked.map(c => <li key={`${c.roleId}:${c.scopeId}`}><strong>{policy(c.roleId)}</strong> — scope: {labels.get(c.scopeId) ?? '—'}{coverage(c.scopeId) ? ` · covers: ${coverage(c.scopeId)}` : ''}</li>)}</ul>
            ) : null}
            {selectedOrgIsHq && mode === 'profiles' && picked.length > 0 ? null : (!selectedOrgIsHq ? <p className="text-sm">{mode === 'self' ? 'No Group Policy for now.' : accessChoiceRequired ? 'Not chosen yet.' : 'None granted from this form.'}</p> : <p className="text-sm">No additional Group Policy.</p>)}
            {selectedOrgIsHq ? (essExcluded
              ? <p data-testid="review-ess" className="text-sm"><strong>Employee Self Service excluded</strong> — non-employee HQ account.</p>
              : <p data-testid="review-ess" className="text-sm"><strong>Employee Self Service</strong> — own employee record only{accessCheck === 'authorized' ? '' : ' (default HQ baseline)'}.</p>) : null}
            <p className="text-xs text-gray-500">Not the complete effective access: automatic lifecycle access may add more. No legacy level is assigned.</p>
          </SummaryCard>
        </div>
        {submitError ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {submitError}
          </div>
        ) : null}
      </div>
    )
  }


  /** Edit User: banking details, a compact optional section of Basic details (shown only when the record carries them). */
  const renderBankingDetails = () => (
    <details className="rounded-lg border border-gray-200" open={Boolean(errors.bank_account_number) || undefined}>
      <summary className={`cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-gray-950 ${FOCUS}`}>Banking details <span className="text-xs font-normal text-gray-500">(optional)</span></summary>
      <div className="space-y-3 border-t border-gray-100 p-3">
        <p className="text-xs text-gray-500">Used for payment and verification purposes only.</p>
        <div className="space-y-1">
          <Label htmlFor="user-dialog-bank-holder" className="text-sm">Account Holder Name</Label>
          <Input id="user-dialog-bank-holder" autoComplete="off" value={formData.bank_account_holder_name || ''} onChange={e => handleInputChange('bank_account_holder_name', e.target.value)} disabled={saving} placeholder="e.g., ALI BIN ABU" className={inputClass('bank_account_holder_name')} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="user-dialog-bank" className="text-sm">Bank</Label>
            <Select value={formData.bank_id || ''} onValueChange={value => handleInputChange('bank_id', value)} disabled={saving}>
              <SelectTrigger id="user-dialog-bank" className="h-9 rounded-lg"><SelectValue placeholder="Select bank" /></SelectTrigger>
              <SelectContent className="max-h-[260px]">{banks.map(bank => <SelectItem key={bank.id} value={bank.id}>{bank.short_name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="user-dialog-bank-account" className="text-sm">Account Number</Label>
            <div className="relative">
              <CreditCard className="absolute left-3 top-2.5 h-4 w-4 text-[var(--sera-muted)]/70" />
              <Input id="user-dialog-bank-account" autoComplete="off" aria-invalid={Boolean(errors.bank_account_number)} value={formData.bank_account_number || ''} onChange={e => handleInputChange('bank_account_number', e.target.value)} disabled={saving} placeholder="e.g., 1234567890" className={inputClass('bank_account_number', 'pl-9')} />
            </div>
            {renderFieldError('bank_account_number')}
          </div>
        </div>
      </div>
    </details>
  )

  const renderEditAccessStep = () => {
    const storedOrgName = organizations.find(o => o.id === user?.organization_id)?.org_name ?? null
    return (
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-950">Organization &amp; access</h3>
          <p className="text-xs text-gray-500">Where this person belongs, whether they can sign in, and what they can do.</p>
        </div>
        {renderOrganizationPicker()}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <Switch id="user-dialog-active" aria-label="Active" checked={Boolean(formData.is_active)} onCheckedChange={checked => handleInputChange('is_active', checked)} disabled={saving} />
            <Label htmlFor="user-dialog-active" className="cursor-pointer text-sm font-medium text-gray-900">{formData.is_active ? 'Active' : 'Inactive'}</Label>
            <InfoPopover label="About Active"><p>Inactive users cannot sign in. Deactivating or reactivating applies through the account lifecycle and needs its own permission; the server decides when you save.</p></InfoPopover>
          </div>
          {referenceAllowed ? (
            <ReferenceCheckbox compact checked={Boolean(formData.can_be_reference)} onCheckedChange={checked => handleInputChange('can_be_reference', checked)} disabled={saving} />
          ) : null}
        </div>

        {!isGuest && user?.organization_id ? (
          <div id="user-dialog-access" tabIndex={-1} className="focus:outline-none">
            <UserEditAccess
              state={editAccess}
              draft={accessDraft}
              onDraft={items => { setAccessDraft(items); clearFieldError('initial_profiles') }}
              disabled={saving}
              organizationName={storedOrgName}
              organizationChanged={editOrgChanged}
              error={errors.initial_profiles}
            />
          </div>
        ) : isGuest ? <p className="text-xs text-gray-500">Independent guests hold no organization membership, so there are no Group Policies to manage here.</p>
          : activeMemberships.length ? (
            <p role="note" className="text-xs text-gray-600">
              Active {activeMemberships.length === 1 ? 'membership' : 'memberships'}: {activeMemberships.map(m => `${m.organizationName}${m.isPrimary ? ' (primary)' : ''}`).join(', ')}. This account has no organization of its own, so its Group Policies are managed in People &amp; Access.
            </p>
          ) : null}

        {showHrFields ? (
          <details className="rounded-lg border border-gray-200">
            <summary className={`cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-gray-950 ${FOCUS}`}>Employment details <span className="text-xs font-normal text-gray-500">(optional)</span></summary>
            <div className="space-y-3 border-t border-gray-100 p-3">
              <p className="text-xs text-gray-500">Department, position and reporting line are organizational facts only; they never grant access.</p>
              {renderHrFields()}
            </div>
          </details>
        ) : null}

        {showBusinessStep ? (
          <details className="rounded-lg border border-gray-200">
            <summary className={`cursor-pointer rounded-lg px-3 py-2 text-sm font-semibold text-gray-950 ${FOCUS}`}>Shop details <span className="text-xs font-normal text-gray-500">(optional)</span></summary>
            <div className="p-3">{renderBusinessStep()}</div>
          </details>
        ) : null}

        {user ? (
          <LegacyCompatibilitySection
            storedRole={roles.find(r => r.role_code === user.role_code) ?? null}
            value={formData.role_code || ''}
            roles={availableRoles}
            currentUserRoleLevel={currentUserRoleLevel}
            organizationId={user.organization_id ?? null}
            disabled={saving}
            onChange={code => handleInputChange('role_code', code)}
          />
        ) : null}
      </div>
    )
  }

  const renderEditReview = () => {
    const text = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim())
    const orgLabel = (id?: string | null) => { const o = organizations.find(x => x.id === id); return o ? `${o.org_name} (${o.org_code})` : (id ? 'Unknown organization' : 'None') }
    const bankName = (id?: string | null) => banks.find(b => b.id === id)?.short_name || (id ? 'Selected bank' : 'None')
    const mask = (v: unknown) => { const d = text(v); return d ? `••••${d.slice(-4)}` : 'None' }
    const u = user as any
    const f = formData as any
    type Row = { label: string; from: string; to: string }
    const rows: Row[] = []
    const track = (label: string, from: unknown, to: unknown, show: (v: unknown) => string = v => text(v) || 'None') => { if (text(from) !== text(to)) rows.push({ label, from: show(from), to: show(to) }) }
    track('Full name', u.full_name, f.full_name)
    track('Call name', u.call_name, f.call_name)
    track('Phone', u.phone, f.phone)
    track('Organization', u.organization_id, f.organization_id, v => orgLabel(v as string))
    if (Boolean(u.is_active) !== Boolean(f.is_active)) rows.push({ label: 'Status', from: u.is_active ? 'Active' : 'Inactive', to: f.is_active ? 'Active' : 'Inactive' })
    if (referenceAllowed) track('Reference', Boolean(u.can_be_reference), Boolean(f.can_be_reference), v => (v ? 'Yes' : 'No'))
    if (showHrFields) {
      track('Department', u.department_id, f.department_id, v => (v ? (departments.find(d => d.id === v)?.dept_name ?? 'Selected') : 'None'))
      track('Position', u.position_id, f.position_id, v => (v ? (positions.find(x => x.id === v)?.name ?? 'Selected') : 'None'))
      track('Reports to', u.manager_user_id, f.manager_user_id, v => (v ? (orgUsers.find(x => x.id === v)?.full_name ?? 'Selected') : 'None'))
      track('Employment type', u.employment_type, f.employment_type)
      track('Join date', u.join_date, f.join_date)
      track('Employment status', u.employment_status || 'active', f.employment_status || 'active')
    }
    if (showBusinessStep) { track('Shop name', u.shop_name, f.shop_name); track('Address', u.address, f.address); track('Reference phone', u.referral_phone, f.referral_phone) }
    track('Legacy compatibility level', u.role_code, f.role_code, v => { const r = roles.find(x => x.role_code === v); return r ? `${desiredRoleLabel(r)} (Level ${r.role_level})` : text(v) || 'None' })
    if (bankingAvailable) {
      track('Bank', u.bank_id, f.bank_id, v => bankName(v as string))
      track('Account number', normalizeBankAccountNumber(u.bank_account_number), normalizeBankAccountNumber(f.bank_account_number), mask)
      track('Account holder', u.bank_account_holder_name, f.bank_account_holder_name)
    }
    if (avatarFile) rows.push({ label: 'Photo', from: 'Current', to: 'New photo' })

    const plan = accessPlan
    const options = editAccess.options
    const policyName = (id: string) => options?.profiles.find(p => p.id === id)?.name ?? 'Policy'
    const labelMap = scopeLabels(options?.scopes ?? [], new Map(Object.entries(options?.orgNames ?? {})))
    const scopeNames = (ids: string[]) => ids.map(id => labelMap.get(id) ?? options?.scopes.find(x => x.id === id)?.display_name ?? 'Scope').join(', ')
    const kept = editAccess.classified ? editAccess.classified.held.length : 0
    const hasPolicyChanges = Boolean(plan && !plan.empty)
    return (
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-950">Review</h3>
          <p className="text-xs text-gray-500">Check what will change. Nothing is saved until you press Save. A password reset is a separate action and is never part of this save.</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <SummaryCard title="Profile" icon={<UserIcon className="h-4 w-4 text-[var(--sera-orange)]" />} step="basic">
            {rows.length === 0 ? <p className="text-sm">No profile changes.</p> : (
              <dl className="space-y-1 text-sm" aria-label="Profile changes">
                {rows.map(r => <div key={r.label} className="flex flex-wrap gap-x-2"><dt className="w-40 shrink-0 text-gray-500">{r.label}</dt><dd className="min-w-0 font-medium text-gray-900">{r.from} <span aria-hidden>→</span><span className="sr-only"> changes to </span> {r.to}</dd></div>)}
              </dl>
            )}
          </SummaryCard>
          <SummaryCard title="Group Policies" icon={<Shield className="h-4 w-4 text-[var(--sera-orange)]" />} step="access">
            {editOrgChanged ? <p className="text-sm">Group Policy changes are not applied together with an organization change.</p>
              : editAccess.status !== 'ready' || !editAccess.classified ? <p className="text-sm">Current Group Policies were not loaded, so no access change is made.</p>
                : !options?.canAssign ? <p className="text-sm">No Group Policy changes (you cannot assign Group Policies here).</p>
                  : !hasPolicyChanges ? <p className="text-sm">No Group Policy changes.</p>
                    : (
                      <ul aria-label="Group Policy changes" className="list-disc space-y-0.5 pl-4 text-sm">
                        {plan!.adds.map(op => <li key={`a-${op.roleId}`}><strong>Add</strong> {policyName(op.roleId)} — scope: {scopeNames(op.scopeIds)}</li>)}
                        {plan!.removes.map(op => <li key={`r-${op.assignment.id}`}><strong>Remove</strong> {op.assignment.roleName} — scope: {scopeNames(op.assignment.scopes.map(x => x.id)) || '—'}</li>)}
                        {plan!.scopeChanges.map(op => <li key={`s-${op.assignment.id}`}><strong>Change scope of</strong> {op.assignment.roleName}: {scopeNames(op.from)} → {scopeNames(op.to)}{op.assignment.effectiveUntil ? ' (end date kept)' : ''}</li>)}
                      </ul>
                    )}
            {kept > 0 ? <p className="text-xs text-gray-500">{kept} other {kept === 1 ? 'grant is' : 'grants are'} kept exactly as is (managed, legacy-migration, another organization, or outside your authority).</p> : null}
          </SummaryCard>
        </div>
        {hasPolicyChanges ? (
          <div className="space-y-1">
            <Label htmlFor="user-dialog-access-reason" className="text-sm">Reason for the Group Policy changes <span className="text-red-500" aria-hidden>*</span></Label>
            <Input id="user-dialog-access-reason" aria-invalid={Boolean(errors.access_reason)} aria-required autoComplete="off" value={accessReason} onChange={e => { setAccessReason(e.target.value); clearFieldError('access_reason') }} disabled={saving} placeholder="Why is this access changing?" className={inputClass('access_reason')} />
            {renderFieldError('access_reason')}
            <p className="text-xs text-gray-500">Applied after the profile is saved, one change at a time, with the same checks as Security &amp; Access → People &amp; Access. If part fails you will be told exactly which part.</p>
          </div>
        ) : null}
        {editOrgChanged ? (
          <div id="user-dialog-org-move" tabIndex={-1} role="alert" className={`space-y-1.5 rounded-lg border px-3 py-2 text-sm focus:outline-none ${errors.org_move ? 'border-red-300 bg-red-50 text-red-900' : 'border-amber-200 bg-amber-50 text-amber-950'}`}>
            <p><strong>Moving this person to {orgLabel(formData.organization_id)}.</strong> The account lifecycle ends memberships that follow the person’s organization, together with every grant on them. Memberships created manually are kept, and nothing is moved to the new organization automatically.</p>
            {moverEffect && (moverEffect.memberships.length || moverEffect.assignments.length) ? (
              <p className="text-xs">Ends: {moverEffect.memberships.join(', ') || 'no membership'}; {moverEffect.assignments.length} active {moverEffect.assignments.length === 1 ? 'grant' : 'grants'}{moverEffect.assignments.length ? ` (${Array.from(new Set(moverEffect.assignments.map(a => a.roleName))).join(', ')})` : ''}. Grant access again for the new organization afterwards in this form or in People &amp; Access.</p>
            ) : <p className="text-xs">The current memberships could not be read, so the exact effect is unknown.</p>}
            <label className="flex cursor-pointer items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-orange-500" checked={moverAck} disabled={saving} onChange={e => { setMoverAck(e.target.checked); clearFieldError('org_move') }} />I understand and want to move this person.</label>
            {errors.org_move ? <p className="text-xs">{errors.org_move}</p> : null}
          </div>
        ) : null}
        {submitError ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {submitError}
          </div>
        ) : null}
      </div>
    )
  }

  const renderStep = () => {
    if (currentStep === 'basic') return renderBasicStep()
    if (currentStep === 'access') return isCreate ? renderCreateAccessStep() : renderEditAccessStep()
    return isCreate ? renderCreateReview() : renderEditReview()
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
            <h2 className="text-2xl font-bold text-gray-950">{linkedOnSuccess ? 'Employee Linked Successfully!' : 'User Created Successfully!'}</h2>
            <p className="mt-2 text-[var(--sera-muted)]">{linkedOnSuccess ? 'The existing employee was linked and their Group Policies were assigned. No duplicate account was created.' : 'The new user has been added to the system.'}</p>
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
                <p className="text-sm text-[var(--sera-muted)]">{selectedOrg ? selectedOrg.org_name : '-'}</p>
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
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-gray-950">{user ? 'Edit User' : 'Add New User'}</h2>
              {user ? (
                <p data-testid="edit-user-identity" className="truncate text-sm text-[var(--sera-muted)]">
                  <span className="font-medium text-gray-900">{getDisplayName(user)}</span>{user.email ? <> · {user.email}</> : null}
                </p>
              ) : null}
            </div>
          </div>
          <button onClick={handleClose} disabled={saving} className="rounded-lg p-1 text-[var(--sera-muted)]/70 hover:bg-[var(--sera-ink)]/[0.04] hover:text-[var(--sera-muted)]"><X className="h-6 w-6" /></button>
        </div>
        <div className="border-b border-[var(--sera-line)] px-4 py-4 sm:px-6">
          <div className="flex gap-1 overflow-x-auto pb-1 sm:gap-3">
            {steps.map((step, index) => {
              const active = step === currentStep
              const done = index < currentIndex
              return (
                <button
                  key={step}
                  type="button"
                  onClick={() => index <= currentIndex && setCurrentStep(step)}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left transition sm:min-w-[116px] ${active ? 'bg-[var(--sera-orange)]/[0.06] text-[var(--sera-orange-deep)]' : done ? 'text-[var(--sera-orange)]' : 'text-[var(--sera-muted)]/70'}`}
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
