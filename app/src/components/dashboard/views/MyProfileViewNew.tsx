'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getOrgTypeName } from '@/lib/utils/orgHierarchy'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  User, Mail, Building2, Shield, Calendar, Phone, Edit2, Save, X,
  Loader2, Camera, CheckCircle, XCircle, Clock, MapPin, AlertCircle, CreditCard, Landmark, Home, UserCheck, Briefcase
} from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import SignatureUpload from '@/components/profile/SignatureUpload'
import ChangePasswordCard from '@/components/profile/ChangePasswordCard'
import MyAccessRequests from '@/components/security-access/MyAccessRequests'
import { updateUserWithAuth } from '@/lib/actions'
import { normalizePhone, validatePhoneNumber, getAvatarSrc, type PhoneValidationResult } from '@/lib/utils'
import { compressAvatar, formatFileSize } from '@/lib/utils/imageCompression'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ReferencePicker, type ReferenceUser } from '@/components/ui/reference-picker'
import { ShopPicker, type ShopResult } from '@/components/ui/shop-picker'
import { ShopRequestDialog } from '@/components/shop-requests/ShopRequestDialog'
import ModuleLightHeader from '@/components/layout/ModuleLightHeader'

interface UserProfile {
  id: string
  email: string
  full_name: string | null
  phone: string | null
  address: string | null
  location: string | null
  shop_name: string | null
  role_code: string
  organization_id: string
  avatar_url: string | null
  signature_url: string | null
  is_active: boolean
  is_verified: boolean
  email_verified_at: string | null
  phone_verified_at: string | null
  last_login_at: string | null
  last_login_ip: string | null
  created_at: string
  updated_at: string
  bank_id: string | null
  bank_account_number: string | null
  bank_account_holder_name: string | null
  referral_phone: string | null
  // Account scope
  account_scope?: 'store' | 'portal' | null
  // HR Foundation fields
  department_id?: string | null
  manager_user_id?: string | null
  position_id?: string | null
  employment_type?: string | null
  join_date?: string | null
  employment_status?: string | null
  organizations?: {
    id: string
    org_name: string
    org_type_code: string
    org_code: string
  }
  roles?: {
    role_name: string
    role_level: number
  }
  msia_banks?: {
    id: string
    short_name: string
  }
  // Joined data for display
  departments?: {
    id: string
    dept_code: string | null
    dept_name: string
  } | null
  manager?: {
    id: string
    full_name: string | null
    email: string
  } | null
  positions?: {
    id: string
    name: string
  } | null
}

interface MsiaBank {
  id: string
  short_name: string
  is_active: boolean
}

const MALAYSIA_STATES = [
  "Johor", "Kedah", "Kelantan", "Melaka", "Negeri Sembilan",
  "Pahang", "Penang", "Perak", "Perlis", "Sabah", "Sarawak",
  "Selangor", "Terengganu", "Kuala Lumpur", "Labuan", "Putrajaya"
]

interface MyProfileViewNewProps {
  userProfile: UserProfile
}

export default function MyProfileViewNew({ userProfile: initialProfile }: MyProfileViewNewProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isShopRequestOpen, setIsShopRequestOpen] = useState(false)
  const [pendingShopRequestName, setPendingShopRequestName] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [userProfile, setUserProfile] = useState<UserProfile>(initialProfile)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [sourceAvatarFile, setSourceAvatarFile] = useState<File | null>(null)
  const [avatarCropPosition, setAvatarCropPosition] = useState({ x: 50, y: 50 })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const avatarObjectUrlRef = useRef<string | null>(null)
  const avatarDragRef = useRef<{ startX: number; startY: number; cropX: number; cropY: number; moved: boolean } | null>(null)
  const avatarSuppressClickRef = useRef(false)
  const avatarCropPositionRef = useRef({ x: 50, y: 50 })
  // Only the first load shows the skeleton; later reloads keep the current
  // profile (and avatar) on screen. Each load gets a sequence number so a slow,
  // older response never overwrites a newer one.
  const hasLoadedProfileRef = useRef(false)
  const profileLoadSeqRef = useRef(0)
  const router = useRouter()
  const [formData, setFormData] = useState({
    full_name: '',
    phone: '',
    address: '',
    location: '',
    shop_name: '',
    organization_id: '',
    bank_id: '',
    bank_account_number: '',
    bank_account_holder_name: '',
    referral_phone: ''
  })
  const [phoneCheckStatus, setPhoneCheckStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle')
  const [referralCheckStatus, setReferralCheckStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [referralName, setReferralName] = useState('')
  const [referralDisplayName, setReferralDisplayName] = useState<string | null>(null)
  const phoneCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const referralCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [banks, setBanks] = useState<MsiaBank[]>([])
  const [isSavingBank, setIsSavingBank] = useState(false)
  const [isEditingBank, setIsEditingBank] = useState(false)
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})
  const { toast } = useToast()
  const supabase = createClient()

  // Load fresh user data on mount and when editing is cancelled
  useEffect(() => {
    loadUserProfile()
    loadBanks()

    return () => {
      if (phoneCheckTimeoutRef.current) clearTimeout(phoneCheckTimeoutRef.current)
      if (referralCheckTimeoutRef.current) clearTimeout(referralCheckTimeoutRef.current)
      if (avatarObjectUrlRef.current) URL.revokeObjectURL(avatarObjectUrlRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadBanks = async () => {
    const { data, error } = await supabase
      .from('msia_banks')
      .select('id, short_name, is_active')
      .eq('is_active', true)
      .order('short_name')

    if (data) {
      setBanks(data)
    }
  }

  const loadUserProfile = async () => {
    const loadSeq = ++profileLoadSeqRef.current
    const isStale = () => loadSeq !== profileLoadSeqRef.current
    try {
      if (!hasLoadedProfileRef.current) setIsLoading(true)

      let targetUserId = initialProfile?.id

      // If no initial profile or ID, fall back to current session user
      if (!targetUserId) {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          toast({
            title: "Error",
            description: "Not authenticated",
            variant: "destructive",
          })
          return
        }
        targetUserId = user.id
      }

      // Fetch complete user profile with related data including HR Foundation fields
      // First try full query with all joins
      let profile: any = null
      let queryError: any = null

      const { data: fullProfile, error: fullError } = await (supabase as any)
        .from('users')
        .select(`
          *,
          organizations:organization_id (
            id,
            org_name,
            org_type_code,
            org_code
          ),
          roles:role_code (
            role_name,
            role_level
          ),
          msia_banks:bank_id (
            id,
            short_name
          )
        `)
        .eq('id', targetUserId)
        .single()

      if (fullError) {
        // FK joins might fail if columns don't exist yet — fallback to basic query
        console.warn('Full profile query failed, trying fallback:', fullError.message || fullError.code)
        const { data: basicProfile, error: basicError } = await supabase
          .from('users')
          .select(`
            *,
            organizations:organization_id (
              id,
              org_name,
              org_type_code,
              org_code
            ),
            roles:role_code (
              role_name,
              role_level
            ),
            msia_banks:bank_id (
              id,
              short_name
            )
          `)
          .eq('id', targetUserId)
          .single()

        if (basicError) {
          queryError = basicError
        } else {
          profile = basicProfile
        }
      } else {
        profile = fullProfile
      }

      if (queryError) throw queryError
      if (isStale()) return

      if (profile) {
        const [departmentResult, managerResult, positionResult] = await Promise.all([
          (profile as any).department_id
            ? supabase.from('departments').select('id, dept_code, dept_name').eq('id', (profile as any).department_id).maybeSingle()
            : Promise.resolve({ data: null }),
          (profile as any).manager_user_id
            ? supabase.from('users').select('id, full_name, email').eq('id', (profile as any).manager_user_id).maybeSingle()
            : Promise.resolve({ data: null }),
          (profile as any).position_id
            ? supabase.from('hr_positions').select('id, name').eq('id', (profile as any).position_id).maybeSingle()
            : Promise.resolve({ data: null }),
        ])

        const transformedProfile: UserProfile = {
          ...(profile as any),
          organizations: Array.isArray((profile as any).organizations)
            ? (profile as any).organizations[0]
            : (profile as any).organizations,
          roles: Array.isArray((profile as any).roles)
            ? (profile as any).roles[0]
            : (profile as any).roles,
          msia_banks: Array.isArray((profile as any).msia_banks)
            ? (profile as any).msia_banks[0]
            : (profile as any).msia_banks,
          departments: Array.isArray((profile as any).departments)
            ? (profile as any).departments[0]
            : (profile as any).departments || departmentResult.data,
          manager: managerResult.data,
          positions: positionResult.data
        }

        if (isStale()) return
        hasLoadedProfileRef.current = true
        setUserProfile(transformedProfile)
        setFormData({
          full_name: transformedProfile.full_name || '',
          phone: transformedProfile.phone || '',
          address: transformedProfile.address || '',
          location: transformedProfile.location || '',
          shop_name: transformedProfile.shop_name || '',
          organization_id: transformedProfile.organization_id || '',
          bank_id: transformedProfile.bank_id || '',
          bank_account_number: transformedProfile.bank_account_number || '',
          bank_account_holder_name: transformedProfile.bank_account_holder_name || '',
          referral_phone: transformedProfile.referral_phone || ''
        })

        // Resolve reference user name for read-only display
        if (transformedProfile.referral_phone) {
          try {
            const res = await fetch(`/api/reference/search?q=${encodeURIComponent(transformedProfile.referral_phone)}&limit=5`)
            const data = await res.json()
            if (data.success && data.results?.length > 0) {
              const match = data.results.find((r: any) =>
                r.phone === transformedProfile.referral_phone || r.phone?.replace(/\D/g, '') === transformedProfile.referral_phone?.replace(/\D/g, '')
              )
              if (match) setReferralDisplayName(match.full_name)
            }
          } catch { /* silently fail */ }
        } else {
          setReferralDisplayName(null)
        }
      }
    } catch (error: any) {
      if (isStale()) return
      console.error('Error loading profile:', error?.message || error?.code || JSON.stringify(error))
      toast({
        title: "Error",
        description: error?.message || "Failed to load profile data",
        variant: "destructive",
      })
    } finally {
      if (!isStale()) setIsLoading(false)
    }
  }

  const checkPhoneAvailability = async (phone: string) => {
    // Validate phone format
    const validation = validatePhoneNumber(phone)
    if (!validation.isValid) {
      setPhoneCheckStatus('invalid')
      setValidationErrors(prev => ({ ...prev, phone: validation.error || 'Invalid phone format' }))
      return
    }

    const normalizedPhone = normalizePhone(phone)

    // If same as current user's phone, it's valid (their own)
    if (userProfile.phone && normalizePhone(userProfile.phone) === normalizedPhone) {
      setPhoneCheckStatus('available')
      setValidationErrors(prev => {
        const newErrors = { ...prev }
        delete newErrors.phone
        return newErrors
      })
      return
    }

    setPhoneCheckStatus('checking')
    try {
      const { data: exists, error } = await supabase
        .rpc('check_phone_exists', {
          p_phone: normalizedPhone,
          p_exclude_user_id: userProfile.id
        })

      if (error) throw error

      if (exists) {
        setPhoneCheckStatus('taken')
        setValidationErrors(prev => ({ ...prev, phone: 'Phone number already exists' }))
      } else {
        setPhoneCheckStatus('available')
        setValidationErrors(prev => {
          const newErrors = { ...prev }
          delete newErrors.phone
          return newErrors
        })
      }
    } catch (error) {
      console.error('Error checking phone:', error)
      setPhoneCheckStatus('idle')
    }
  }

  const checkReferralPhone = async (value: string) => {
    const rawValue = value?.trim() || ''
    if (!rawValue) {
      setReferralCheckStatus('idle')
      setReferralName('')
      return
    }

    const isEmail = rawValue.includes('@')
    if (isEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(rawValue)) {
        setReferralCheckStatus('invalid')
        setReferralName('')
        setValidationErrors(prev => ({ ...prev, referral_phone: 'Invalid email format' }))
        return
      }
    } else {
      const validation = validatePhoneNumber(rawValue)
      if (!validation.isValid) {
        setReferralCheckStatus('invalid')
        setReferralName('')
        setValidationErrors(prev => ({ ...prev, referral_phone: 'Invalid phone format' }))
        return
      }
    }

    const normalizedPhone = isEmail ? rawValue : normalizePhone(rawValue)
    setReferralCheckStatus('checking')

    try {
      const res = await fetch('/api/user/lookup-phone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: normalizedPhone })
      })

      const data = await res.json()

      if (res.ok && data?.success) {
        setReferralCheckStatus('valid')
        setReferralName(data?.name || '')
        setValidationErrors(prev => {
          const newErrors = { ...prev }
          delete newErrors.referral_phone
          return newErrors
        })
      } else {
        setReferralCheckStatus('invalid')
        setReferralName('')
        setValidationErrors(prev => ({ ...prev, referral_phone: 'Referred user not found' }))
      }
    } catch (error) {
      console.error('Error checking referral:', error)
      setReferralCheckStatus('idle')
      setReferralName('')
    }
  }

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      // Validate file type
      if (!file.type.startsWith('image/')) {
        toast({
          title: "Invalid File",
          description: "Please select an image file.",
          variant: "destructive",
        })
        return
      }

      // Check for AVIF format - not supported by Supabase Storage
      if (file.type === 'image/avif') {
        toast({
          title: "Format Not Supported",
          description: "AVIF format is not supported. Please use JPG, PNG, GIF, or WebP instead.",
          variant: "destructive",
        })
        if (e.target) {
          e.target.value = ''
        }
        return
      }

      if (avatarObjectUrlRef.current) {
        URL.revokeObjectURL(avatarObjectUrlRef.current)
      }

      const previewUrl = URL.createObjectURL(file)
      avatarObjectUrlRef.current = previewUrl
      setAvatarPreview(previewUrl)
      setSourceAvatarFile(file)
      setAvatarCrop({ x: 50, y: 50 })

      try {
        const compressedFile = await compressImage(file, { x: 50, y: 50 })
        setAvatarFile(compressedFile)
      } catch (error) {
        console.error('Compression error:', error)
        toast({
          title: "Error",
          description: "Failed to process image. Please try another one.",
          variant: "destructive",
        })
      }
    }
  }

  const clampPercent = (value: number) => Math.max(0, Math.min(100, value))

  const setAvatarCrop = (position: { x: number; y: number }) => {
    const next = {
      x: clampPercent(position.x),
      y: clampPercent(position.y)
    }
    avatarCropPositionRef.current = next
    setAvatarCropPosition(next)
  }

  const compressImage = (file: File, cropPosition = avatarCropPositionRef.current): Promise<File> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload = (event) => {
        const img = new Image()
        img.src = event.target?.result as string
        img.onload = () => {
          const canvas = document.createElement('canvas')
          const MAX_SIZE = 150
          const sourceSize = Math.min(img.width, img.height)
          const sourceX = (img.width - sourceSize) * (clampPercent(cropPosition.x) / 100)
          const sourceY = (img.height - sourceSize) * (clampPercent(cropPosition.y) / 100)

          canvas.width = MAX_SIZE
          canvas.height = MAX_SIZE
          const ctx = canvas.getContext('2d')
          ctx?.drawImage(img, sourceX, sourceY, sourceSize, sourceSize, 0, 0, MAX_SIZE, MAX_SIZE)

          // Start with quality 0.7
          let quality = 0.7

          const compress = () => {
            canvas.toBlob((blob) => {
              if (!blob) {
                reject(new Error('Canvas is empty'))
                return
              }

              // If still > 5KB and quality > 0.1, reduce quality and try again
              if (blob.size > 5 * 1024 && quality > 0.1) {
                quality -= 0.1
                compress()
              } else {
                // Create new file
                const newFile = new File([blob], file.name, {
                  type: 'image/jpeg',
                  lastModified: Date.now(),
                })
                resolve(newFile)
              }
            }, 'image/jpeg', quality)
          }

          compress()
        }
        img.onerror = (error) => reject(error)
      }
      reader.onerror = (error) => reject(error)
    })
  }

  const handleAvatarClick = () => {
    if (isEditing) {
      fileInputRef.current?.click()
    }
  }

  const handleAvatarMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isEditing || !avatarPreview) return
    event.preventDefault()
    avatarDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      cropX: avatarCropPositionRef.current.x,
      cropY: avatarCropPositionRef.current.y,
      moved: false
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

    setAvatarCrop({
      x: drag.cropX - (dx / rect.width) * 100,
      y: drag.cropY - (dy / rect.height) * 100
    })
  }

  const handleAvatarMouseUp = async () => {
    const drag = avatarDragRef.current
    avatarDragRef.current = null
    avatarSuppressClickRef.current = Boolean(drag?.moved)
    if (!drag?.moved || !sourceAvatarFile) return

    try {
      setAvatarFile(await compressImage(sourceAvatarFile, avatarCropPositionRef.current))
    } catch (error) {
      console.error('Avatar crop compression error:', error)
      toast({
        title: "Error",
        description: "Failed to process image crop. Please try another one.",
        variant: "destructive",
      })
    }
  }

  const handleSave = async () => {
    setIsSaving(true)
    try {
      // Validate phone number format if provided
      if (formData.phone && formData.phone.trim()) {
        const phoneValidation = validatePhoneNumber(formData.phone)
        if (!phoneValidation.isValid) {
          toast({
            title: "Invalid Phone Number",
            description: phoneValidation.error || "Please enter a valid Malaysian (+60) or Chinese (+86) phone number.",
            variant: "destructive",
          })
          setIsSaving(false)
          return
        }
      }

      // Check if phone is already in use if changed
      if (formData.phone && formData.phone !== userProfile.phone) {
        const normalizedPhone = normalizePhone(formData.phone)
        const { data: exists, error: checkError } = await supabase
          .rpc('check_phone_exists', {
            p_phone: normalizedPhone,
            p_exclude_user_id: userProfile.id
          })

        if (checkError) throw checkError

        if (exists) {
          toast({
            title: "Error",
            description: "This phone number is already in use by another account.",
            variant: "destructive",
          })
          setIsSaving(false)
          return
        }
      }

      // Validate referred by if provided (phone or email)
      if (formData.referral_phone && formData.referral_phone.trim()) {
        const rawReferral = formData.referral_phone.trim()
        const isEmail = rawReferral.includes('@')
        if (isEmail) {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
          if (!emailRegex.test(rawReferral)) {
            toast({
              title: "Invalid Referred By",
              description: "Please enter a valid email for the referred user.",
              variant: "destructive",
            })
            setIsSaving(false)
            return
          }
        } else {
          const validation = validatePhoneNumber(rawReferral)
          if (!validation.isValid) {
            toast({
              title: "Invalid Referred By",
              description: validation.error || "Please enter a valid phone number for the referred user.",
              variant: "destructive",
            })
            setIsSaving(false)
            return
          }
        }

        const lookupValue = isEmail ? rawReferral : normalizePhone(rawReferral)
        const lookupRes = await fetch('/api/user/lookup-phone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: lookupValue })
        })

        const lookupData = await lookupRes.json()

        if (!lookupRes.ok || !lookupData?.success) {
          toast({
            title: "Invalid Referred By",
            description: "Referred user not found.",
            variant: "destructive",
          })
          setIsSaving(false)
          return
        }
      }

      // Separate referral_phone change from main update — handled via RPC
      const referralChanged = (formData.referral_phone?.trim() || null) !== (userProfile.referral_phone || null)

      let updateData: any = {
        full_name: formData.full_name?.trim() || null,
        phone: formData.phone?.trim() || null,
        address: formData.address?.trim() || null,
        location: formData.location || null,
        shop_name: formData.shop_name?.trim() || null,
      }

      // If referral module is not enabled, include referral_phone directly (legacy)
      if (!referralChanged) {
        updateData.referral_phone = formData.referral_phone?.trim() || null
      }

      const uploadAvatarFile = sourceAvatarFile
        ? await compressImage(sourceAvatarFile, avatarCropPositionRef.current)
        : avatarFile

      // Handle avatar upload if file is selected
      if (uploadAvatarFile) {
        try {
          // Compress the avatar first
          const compressionResult = await compressAvatar(uploadAvatarFile)

          toast({
            title: '🖼️ Avatar Compressed',
            description: `${formatFileSize(compressionResult.originalSize)} → ${formatFileSize(compressionResult.compressedSize)} (${compressionResult.compressionRatio.toFixed(1)}% smaller)`,
          })

          // Delete old avatar if exists
          if (userProfile.avatar_url) {
            const oldPath = userProfile.avatar_url.split('/').pop()?.split('?')[0]
            if (oldPath) {
              const pathToDelete = `${userProfile.id}/${oldPath}`
              await supabase.storage.from('avatars').remove([pathToDelete])
            }
          }

          // Upload new avatar
          const fileName = `${Date.now()}.jpg`
          const filePath = `${userProfile.id}/${fileName}`

          const { error: uploadError } = await supabase.storage
            .from('avatars')
            .upload(filePath, compressionResult.file, {
              contentType: compressionResult.file.type,
              cacheControl: '3600',
              upsert: true
            })

          if (uploadError) throw uploadError

          // Get public URL
          const { data: urlData } = supabase.storage
            .from('avatars')
            .getPublicUrl(filePath)

          updateData.avatar_url = `${urlData.publicUrl}?v=${Date.now()}`
        } catch (avatarError: any) {
          console.error('Avatar upload error:', avatarError)
          toast({
            title: 'Warning',
            description: `Avatar upload failed: ${avatarError.message}`,
            variant: 'destructive'
          })
          // Don't return - continue with other updates
        }
      }

      // Update user profile in database (self-update - pass own profile info)
      const result = await updateUserWithAuth(userProfile.id, updateData, {
        id: userProfile.id,
        role_code: userProfile.role_code
      })

      if (!result.success) throw new Error(result.error || 'Failed to update profile')

      // Handle referral phone change via RPC (supports approval flow)
      if (referralChanged) {
        const { data: refResult, error: refError } = await supabase.rpc('process_reference_change', {
          p_shop_user_id: userProfile.id,
          p_new_reference_phone: formData.referral_phone?.trim() || '',
          p_changed_by: userProfile.id
        })

        if (refError) {
          console.error('Referral change RPC error:', refError)
          // Fallback: update directly if RPC fails (module may not be deployed yet)
          await supabase.from('users').update({
            referral_phone: formData.referral_phone?.trim() || null,
            updated_at: new Date().toISOString()
          }).eq('id', userProfile.id)
        } else if (refResult && typeof refResult === 'object') {
          const refData = refResult as any
          if (!refData.success) {
            toast({
              title: "Reference Change",
              description: refData.error || "Reference change request failed.",
              variant: "destructive",
            })
          } else if (refData.status === 'pending') {
            toast({
              title: "Reference Change Pending",
              description: "Your reference change request has been submitted for approval by HQ.",
            })
          }
        }
      }

      toast({
        title: "Success",
        description: "Your profile has been updated successfully.",
      })

      // Reset editing state
      setIsEditing(false)
      setAvatarFile(null)
      setAvatarPreview(null)
      setSourceAvatarFile(null)
      setAvatarCrop({ x: 50, y: 50 })
      if (avatarObjectUrlRef.current) {
        URL.revokeObjectURL(avatarObjectUrlRef.current)
        avatarObjectUrlRef.current = null
      }

      // Reload fresh data from database
      await loadUserProfile()
      // Re-render the server shell so the sidebar picks up the saved name/avatar
      // from the same users row, without a logout.
      router.refresh()

    } catch (error: any) {
      console.error('Error updating profile:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to update profile. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleCancel = () => {
    setFormData({
      full_name: userProfile.full_name || '',
      phone: userProfile.phone || '',
      address: userProfile.address || '',
      location: userProfile.location || '',
      shop_name: userProfile.shop_name || '',
      organization_id: userProfile.organization_id || '',
      bank_id: userProfile.bank_id || '',
      bank_account_number: userProfile.bank_account_number || '',
      bank_account_holder_name: userProfile.bank_account_holder_name || '',
      referral_phone: userProfile.referral_phone || ''
    })
    setAvatarFile(null)
    setAvatarPreview(null)
    setSourceAvatarFile(null)
    setAvatarCrop({ x: 50, y: 50 })
    if (avatarObjectUrlRef.current) {
      URL.revokeObjectURL(avatarObjectUrlRef.current)
      avatarObjectUrlRef.current = null
    }
    setIsEditing(false)
  }

  // Helper function to convert text to title case
  const toTitleCase = (str: string): string => {
    return str.replace(/\b\w/g, (char) => char.toUpperCase())
  }

  const handleSaveBankDetails = async () => {
    setIsSavingBank(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Not authenticated')

      const { error } = await supabase
        .from('users')
        .update({
          bank_id: formData.bank_id || null,
          bank_account_number: formData.bank_account_number || null,
          bank_account_holder_name: formData.bank_account_holder_name || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id)

      if (error) throw error

      toast({
        title: "Success",
        description: "Bank details saved successfully!",
      })

      // Update local state
      setUserProfile(prev => ({
        ...prev,
        bank_id: formData.bank_id || null,
        bank_account_number: formData.bank_account_number || null,
        bank_account_holder_name: formData.bank_account_holder_name || null
      }))
      setIsEditingBank(false)

      // Refresh profile to get updated bank name
      loadUserProfile()
    } catch (error: any) {
      console.error('Error saving bank details:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to save bank details",
        variant: "destructive",
      })
    } finally {
      setIsSavingBank(false)
    }
  }

  const handleCancelBankEdit = () => {
    setFormData(prev => ({
      ...prev,
      bank_id: userProfile.bank_id || '',
      bank_account_number: userProfile.bank_account_number || '',
      bank_account_holder_name: userProfile.bank_account_holder_name || ''
    }))
    setIsEditingBank(false)
  }

  const getInitials = (name: string | null, email: string): string => {
    if (name && name.trim()) {
      const parts = name.trim().split(' ')
      if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      return name.substring(0, 2).toUpperCase()
    }
    return email.substring(0, 2).toUpperCase()
  }

  const formatRelativeTime = (dateString: string | null): string => {
    if (!dateString) return 'Never'
    try {
      const date = new Date(dateString)
      const now = new Date()
      const seconds = Math.floor((now.getTime() - date.getTime()) / 1000)
      if (seconds < 60) return 'just now'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m ago`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h ago`
      const days = Math.floor(hours / 24)
      if (days < 30) return `${days}d ago`
      const months = Math.floor(days / 30)
      if (months < 12) return `${months}mo ago`
      return `${Math.floor(months / 12)}y ago`
    } catch { return 'Unknown' }
  }

  const formatDate = (dateString: string | null): string => {
    if (!dateString) return 'N/A'
    try {
      return new Date(dateString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      })
    } catch { return 'Invalid date' }
  }

  const formatDateTime = (dateString: string | null): string => {
    if (!dateString) return 'Never'
    try {
      return new Date(dateString).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    } catch { return 'Invalid date' }
  }

  const formatLoginIp = (ip: string | null): string | null => {
    if (!ip) return null

    const normalized = ip.trim()
    if (!normalized) return null

    if (normalized === '127.0.0.1' || normalized === '::1' || normalized.toLowerCase() === 'localhost') {
      return '127.0.0.1 (localhost)'
    }

    return normalized
  }

  // Use shared getOrgTypeName from @/lib/utils/orgHierarchy

  if (isLoading) {
    return (
      <div className="sera-sc-page flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--sera-orange)]" />
      </div>
    )
  }

  const displayLastLoginIp = formatLoginIp(userProfile.last_login_ip)

  return (
    <div className="sera-sc-page mx-auto w-full max-w-6xl gap-8 pb-10 pt-4">
      <ModuleLightHeader
        eyebrow="Account"
        title="My Profile"
        description="View and manage your personal information"
        actions={
          !isEditing ? (
            <Button
              onClick={() => setIsEditing(true)}
              className="gap-2 bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]"
            >
              <Edit2 className="h-4 w-4" />
              Edit Profile
            </Button>
          ) : null
        }
      />

      {/* Verification Status Alert */}
      {(!userProfile.email_verified_at || !userProfile.phone_verified_at) && (
        <Alert className="border-[var(--sera-orange)]/30 bg-[var(--sera-orange)]/[0.06]">
          <AlertCircle className="h-4 w-4 text-[var(--sera-orange)]" />
          <AlertDescription className="text-[var(--sera-ink-soft)]">
            <strong className="text-[var(--sera-ink)]">Action Required:</strong> Please verify your{' '}
            {!userProfile.email_verified_at && 'email'}
            {!userProfile.email_verified_at && !userProfile.phone_verified_at && ' and '}
            {!userProfile.phone_verified_at && 'phone number'} to complete your profile setup.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
        {/* Profile Information Card */}
        <Card className="sera-sc-panel overflow-hidden border-[var(--sera-line)] shadow-none">
          <CardHeader className="space-y-1.5 border-b border-[var(--sera-line)] bg-[var(--sera-mist)]/40 p-0 px-6 py-5">
            <CardTitle className="font-display text-lg text-[var(--sera-ink)]">Profile Information</CardTitle>
            <CardDescription className="text-[var(--sera-muted)]">Your personal details and avatar</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 p-0 px-6 pb-6 pt-5">
            {/* Avatar Section */}
            <div className="flex flex-col gap-4 rounded-xl border border-[var(--sera-line)] bg-[var(--sera-mist)]/35 p-4 sm:flex-row sm:items-center">
              <div className="relative shrink-0">
                <Avatar
                  className={`h-24 w-24 border-4 border-white shadow-sm ${isEditing && avatarPreview ? 'cursor-move' : isEditing ? 'cursor-pointer' : ''}`}
                  onClick={() => {
                    if (avatarSuppressClickRef.current) {
                      avatarSuppressClickRef.current = false
                      return
                    }
                    if (!avatarPreview) handleAvatarClick()
                  }}
                  onMouseDown={handleAvatarMouseDown}
                  onMouseMove={handleAvatarMouseMove}
                  onMouseUp={handleAvatarMouseUp}
                  onMouseLeave={handleAvatarMouseUp}
                  title={isEditing && avatarPreview ? 'Drag to reposition image' : undefined}
                >
                  {avatarPreview ? (
                    <img
                      src={avatarPreview}
                      alt="Avatar preview"
                      draggable={false}
                      className="h-full w-full select-none object-cover"
                      style={{ objectPosition: `${avatarCropPosition.x}% ${avatarCropPosition.y}%` }}
                    />
                  ) : userProfile.avatar_url ? (
                    <AvatarImage
                      src={getAvatarSrc(userProfile.avatar_url)}
                      alt={userProfile.full_name || 'User'}
                    />
                  ) : null}
                  {!avatarPreview && (
                    <AvatarFallback className="bg-gradient-to-br from-[var(--sera-ink)] to-[var(--sera-ink-soft)] text-3xl font-semibold text-white">
                      {getInitials(userProfile.full_name, userProfile.email)}
                    </AvatarFallback>
                  )}
                </Avatar>
                {isEditing && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="absolute -bottom-2 -right-2 h-10 w-10 rounded-full border border-[var(--sera-line)] bg-white p-0 text-[var(--sera-ink-soft)] shadow-sm hover:bg-[var(--sera-orange)] hover:text-white"
                    onClick={handleAvatarClick}
                  >
                    <Camera className="h-5 w-5" />
                  </Button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                  onChange={handleAvatarChange}
                  className="hidden"
                />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-2xl font-semibold tracking-tight text-[var(--sera-ink)]">
                  {userProfile.full_name || userProfile.email?.split('@')[0] || 'User'}
                </h2>
                <p className="mt-0.5 text-sm text-[var(--sera-muted)]">{userProfile.email}</p>
                {(userProfile.roles?.role_name || userProfile.role_code) && (
                  <span className="mt-3 inline-flex items-center rounded-full border border-[var(--sera-orange)]/20 bg-[var(--sera-orange)]/[0.06] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--sera-orange-deep)]">
                    {userProfile.roles?.role_name || userProfile.role_code}
                  </span>
                )}
                {avatarFile && (
                  <p className="mt-2 flex items-center gap-1 text-xs text-emerald-600">
                    <CheckCircle className="h-3 w-3" />
                    New avatar selected
                  </p>
                )}
                {avatarPreview && (
                  <p className="mt-1 text-xs text-[var(--sera-muted)]">
                    Drag the avatar to reposition it before saving.
                  </p>
                )}
              </div>
            </div>

            {/* Editable Fields */}
            <div className="space-y-4 pt-4 border-t">
              {isEditing ? (
                <>
                  <div>
                    <Label htmlFor="full_name" className="text-sm font-medium">Full Name</Label>
                    <Input
                      id="full_name"
                      value={formData.full_name}
                      onChange={(e) => {
                        let newValue = e.target.value
                        // Auto-capitalize words in Full Name when space is pressed
                        if (newValue.endsWith(' ') && newValue.length > 1) {
                          const words = newValue.split(' ')
                          if (words.length >= 2) {
                            const lastWordIndex = words.length - 2
                            const lastWord = words[lastWordIndex]
                            if (lastWord) {
                              words[lastWordIndex] = lastWord.charAt(0).toUpperCase() + lastWord.slice(1).toLowerCase()
                              newValue = words.join(' ')
                            }
                          }
                        }
                        setFormData({ ...formData, full_name: newValue })
                      }}
                      placeholder="Enter your full name"
                      disabled={isSaving}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="phone" className="text-sm font-medium">Phone Number</Label>
                    <div className="relative">
                      <Input
                        id="phone"
                        value={formData.phone}
                        onChange={(e) => {
                          const val = e.target.value
                          setFormData({ ...formData, phone: val })
                          setPhoneCheckStatus('idle')

                          if (phoneCheckTimeoutRef.current) clearTimeout(phoneCheckTimeoutRef.current)
                          phoneCheckTimeoutRef.current = setTimeout(() => {
                            checkPhoneAvailability(val)
                          }, 500)
                        }}
                        placeholder="Enter your phone number"
                        disabled={isSaving}
                        className={`mt-1 pr-10 ${validationErrors.phone ? 'border-red-500 focus-visible:ring-red-500' : ''}`}
                      />
                      <div className="absolute right-3 top-3">
                        {phoneCheckStatus === 'checking' && <Loader2 className="h-4 w-4 animate-spin text-[var(--sera-muted)]/70" />}
                        {phoneCheckStatus === 'available' && <CheckCircle className="h-4 w-4 text-green-500" />}
                        {(phoneCheckStatus === 'taken' || phoneCheckStatus === 'invalid') && <XCircle className="h-4 w-4 text-red-500" />}
                      </div>
                    </div>
                    {phoneCheckStatus === 'available' && <p className="text-xs text-green-600 mt-1 flex items-center gap-1"><CheckCircle className="h-3 w-3" /> Phone number is available</p>}
                    {validationErrors.phone && <p className="text-xs text-red-500 mt-1">{validationErrors.phone}</p>}
                  </div>

                  <div>
                    <Label htmlFor="referral_phone" className="text-sm font-medium">Referred By</Label>
                    <ReferencePicker
                      value={formData.referral_phone}
                      onSelect={(_ref: ReferenceUser | null, phone: string) => {
                        setFormData({ ...formData, referral_phone: phone })
                        if (_ref) {
                          setReferralCheckStatus('valid')
                          setReferralName(_ref.full_name)
                          setValidationErrors(prev => {
                            const newErrors = { ...prev }
                            delete newErrors.referral_phone
                            return newErrors
                          })
                        } else if (!phone) {
                          setReferralCheckStatus('idle')
                          setReferralName('')
                        }
                      }}
                      disabled={isSaving}
                      placeholder="Search reference by name, phone, or email..."
                    />
                    {formData.referral_phone && !referralName && !referralDisplayName && !validationErrors.referral_phone && (
                      <p className="text-xs text-amber-700 mt-1">Stored reference is from an older profile value. Please update to the latest eligible reference.</p>
                    )}
                    {validationErrors.referral_phone && <p className="text-xs text-red-500 mt-1">{validationErrors.referral_phone}</p>}
                  </div>
                  <div>
                    <Label htmlFor="address" className="text-sm font-medium">Address</Label>
                    <Input
                      id="address"
                      value={formData.address}
                      onChange={(e) => {
                        const value = e.target.value
                        // Convert to title case as user types
                        const titleCased = toTitleCase(value)
                        if (titleCased.length <= 255) {
                          setFormData({ ...formData, address: titleCased })
                        }
                      }}
                      placeholder="Enter your delivery address"
                      disabled={isSaving}
                      className="mt-1"
                      maxLength={255}
                    />
                    <p className="text-xs text-[var(--sera-muted)] mt-1">{formData.address.length}/255 characters</p>
                  </div>

                  <div>
                    <Label className="text-sm font-medium">State</Label>
                    <Select
                      value={formData.location}
                      onValueChange={(value) => setFormData({ ...formData, location: value })}
                      disabled={isSaving}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Select your state" />
                      </SelectTrigger>
                      <SelectContent>
                        {MALAYSIA_STATES.map((state) => (
                          <SelectItem key={state} value={state}>
                            {state}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {(!userProfile.organizations || !userProfile.organizations.org_name) && (
                    <div>
                      <Label htmlFor="shop_name" className="text-sm font-medium">Shop Name</Label>
                      <ShopPicker
                        value={formData.shop_name}
                        onSelect={(shop: ShopResult | null, displayName: string) => {
                          setFormData({
                            ...formData,
                            shop_name: displayName,
                            organization_id: shop?.org_id || formData.organization_id,
                          })
                        }}
                        onCreateRequest={(shopName) => {
                          setPendingShopRequestName(shopName)
                          setIsShopRequestOpen(true)
                        }}
                        disabled={isSaving}
                        placeholder="Search shop or type name..."
                        maxLength={120}
                      />
                      <p className="mt-1 text-xs text-[var(--sera-muted)]">Selecting a shop from the list links your profile to that shop for RoadTour and staff rewards.</p>
                    </div>
                  )}

                  <div className="flex gap-3 pt-4">
                    <ShopRequestDialog
                      open={isShopRequestOpen}
                      onOpenChange={setIsShopRequestOpen}
                      defaultShopName={pendingShopRequestName}
                      onSubmitted={() => {
                        setIsShopRequestOpen(false)
                        toast({
                          title: 'Shop Request Submitted',
                          description: 'HQ/Admin will review your request before the shop can be selected in Profile Information.',
                        })
                      }}
                    />
                    <Button
                      onClick={handleSave}
                      className="flex-1 gap-2 bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)]"
                      disabled={isSaving}
                    >
                      {isSaving ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Save className="h-4 w-4" />
                          Save Changes
                        </>
                      )}
                    </Button>
                    <Button
                      onClick={handleCancel}
                      variant="outline"
                      className="flex-1 gap-2"
                      disabled={isSaving}
                    >
                      <X className="h-4 w-4" />
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                    <User className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-[var(--sera-muted)] font-medium">Full Name</p>
                        <button
                          onClick={() => setIsEditing(true)}
                          className="text-xs font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline"
                        >
                          Edit
                        </button>
                      </div>
                      <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                        {userProfile.full_name || (
                          <span className="text-[var(--sera-muted)]/70 italic">Not set</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                    <Phone className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-[var(--sera-muted)] font-medium">Phone Number</p>
                        <button
                          onClick={() => setIsEditing(true)}
                          className="text-xs font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline"
                        >
                          Edit
                        </button>
                      </div>
                      <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                        {userProfile.phone || (
                          <span className="text-[var(--sera-muted)]/70 italic">Not set</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                    <Shield className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-[var(--sera-muted)] font-medium">Reference</p>
                        <button
                          onClick={() => setIsEditing(true)}
                          className="text-xs font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline"
                        >
                          Edit
                        </button>
                      </div>
                      {userProfile.referral_phone ? (
                        <div className="mt-1">
                          {referralDisplayName && (
                            <p className="text-base font-medium text-[var(--sera-ink)]">{referralDisplayName}</p>
                          )}
                          <p className={`text-sm ${referralDisplayName ? 'text-[var(--sera-muted)]' : 'text-base font-medium text-[var(--sera-ink)]'}`}>
                            {userProfile.referral_phone}
                          </p>
                          {!referralDisplayName && (
                            <p className="text-xs text-amber-700 mt-1">Please update to the latest eligible reference.</p>
                          )}
                        </div>
                      ) : (
                        <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                          <span className="text-[var(--sera-muted)]/70 italic">Not set</span>
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                    <Home className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-[var(--sera-muted)] font-medium">Address</p>
                        <button
                          onClick={() => setIsEditing(true)}
                          className="text-xs font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline"
                        >
                          Edit
                        </button>
                      </div>
                      <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                        {userProfile.address || (
                          <span className="text-[var(--sera-muted)]/70 italic">Not set</span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                    <MapPin className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-[var(--sera-muted)] font-medium">State</p>
                        <button
                          onClick={() => setIsEditing(true)}
                          className="text-xs font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline"
                        >
                          Edit
                        </button>
                      </div>
                      <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                        {userProfile.location || (
                          <span className="text-[var(--sera-muted)]/70 italic">Not set</span>
                        )}
                      </p>
                    </div>
                  </div>

                  {(!userProfile.organizations || !userProfile.organizations.org_name) && (
                    <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                      <Building2 className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <p className="text-sm text-[var(--sera-muted)] font-medium">Shop Name</p>
                          <button
                            onClick={() => setIsEditing(true)}
                            className="text-xs font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline"
                          >
                            Edit
                          </button>
                        </div>
                        <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                          {userProfile.shop_name || (
                            <span className="text-[var(--sera-muted)]/70 italic">Not set</span>
                          )}
                        </p>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Account Information Card */}
        <Card className="sera-sc-panel overflow-hidden border-[var(--sera-line)] shadow-none">
          <CardHeader className="space-y-1.5 border-b border-[var(--sera-line)] bg-[var(--sera-mist)]/40 p-0 px-6 py-5">
            <CardTitle className="font-display text-lg text-[var(--sera-ink)]">Account Information</CardTitle>
            <CardDescription className="text-[var(--sera-muted)]">Your account details and role</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-0 px-6 pb-6 pt-5">
            <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
              <Mail className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-[var(--sera-muted)] font-medium">Email Address</p>
                <p className="text-base font-medium text-[var(--sera-ink)] mt-1 break-all">
                  {userProfile.email}
                </p>
                {userProfile.email_verified_at ? (
                  <Badge variant="outline" className="mt-2 bg-green-50 text-green-700 border-green-200">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    Verified {formatRelativeTime(userProfile.email_verified_at)}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="mt-2 bg-yellow-50 text-yellow-700 border-yellow-200">
                    <XCircle className="h-3 w-3 mr-1" />
                    Not Verified
                  </Badge>
                )}
              </div>
            </div>

            <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
              <Phone className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-[var(--sera-muted)] font-medium">Phone Verification</p>
                {userProfile.phone ? (
                  <>
                    <p className="text-base font-medium text-[var(--sera-ink)] mt-1">{userProfile.phone}</p>
                    {userProfile.phone_verified_at ? (
                      <Badge variant="outline" className="mt-2 bg-green-50 text-green-700 border-green-200">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Verified {formatRelativeTime(userProfile.phone_verified_at)}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="mt-2 bg-yellow-50 text-yellow-700 border-yellow-200">
                        <XCircle className="h-3 w-3 mr-1" />
                        Not Verified
                      </Badge>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-[var(--sera-muted)]/70 italic mt-1">No phone number set</p>
                )}
              </div>
            </div>

            <div className="border-t pt-4"></div>

            <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
              <Shield className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-[var(--sera-muted)] font-medium">Role</p>
                <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                  {userProfile.roles?.role_name || userProfile.role_code}
                </p>
                <p className="text-xs text-[var(--sera-muted)] mt-1">
                  Level: {userProfile.roles?.role_level || 'Unknown'}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
              <Building2 className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm text-[var(--sera-muted)] font-medium">Organization</p>
                <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                  {userProfile.organizations?.org_name || 'N/A'}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outline" className="text-xs">
                    {userProfile.organizations?.org_code || 'N/A'}
                  </Badge>
                  <Badge variant="outline" className="text-xs bg-[var(--sera-orange)]/[0.06] text-[var(--sera-orange-deep)] border-[var(--sera-orange)]/25">
                    {getOrgTypeName(userProfile.organizations?.org_type_code || '')}
                  </Badge>
                </div>
              </div>
            </div>

            {/* Department & Reports To — portal-only blocks */}
            {userProfile.account_scope === 'portal' && userProfile.organization_id && (
              <>
                {/* Department (HR Foundation) */}
                <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                  <Briefcase className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm text-[var(--sera-muted)] font-medium">Department</p>
                    {userProfile.departments ? (
                      <>
                        <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                          {userProfile.departments.dept_name}
                        </p>
                        {userProfile.departments.dept_code && (
                          <Badge variant="outline" className="text-xs mt-1">
                            {userProfile.departments.dept_code}
                          </Badge>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-[var(--sera-muted)]/70 italic mt-1">Not assigned</p>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                  <Briefcase className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm text-[var(--sera-muted)] font-medium">Position</p>
                    {userProfile.positions ? (
                      <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                        {userProfile.positions.name}
                      </p>
                    ) : (
                      <p className="text-sm text-[var(--sera-muted)]/70 italic mt-1">Not assigned</p>
                    )}
                  </div>
                </div>

                {/* Reports To (HR Foundation) */}
                <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                  <UserCheck className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm text-[var(--sera-muted)] font-medium">Reports To</p>
                    {userProfile.manager ? (
                      <>
                        <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                          {userProfile.manager.full_name || userProfile.manager.email}
                        </p>
                        {userProfile.manager.full_name && (
                          <p className="text-xs text-[var(--sera-muted)] mt-1">
                            {userProfile.manager.email}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-[var(--sera-muted)]/70 italic mt-1">Not assigned</p>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                  <Calendar className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm text-[var(--sera-muted)] font-medium">Employment</p>
                    <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                      {userProfile.employment_type || 'Not set'}
                    </p>
                    <p className="text-xs text-[var(--sera-muted)] mt-1">
                      Status: {userProfile.employment_status || 'active'}
                      {userProfile.join_date ? ` · Joined ${formatDate(userProfile.join_date)}` : ''}
                    </p>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity Information */}
      <Card className="sera-sc-panel overflow-hidden border-[var(--sera-line)] shadow-none">
        <CardHeader className="space-y-1.5 border-b border-[var(--sera-line)] bg-[var(--sera-mist)]/40 p-0 px-6 py-5">
          <CardTitle className="font-display text-lg text-[var(--sera-ink)]">Activity & Timeline</CardTitle>
          <CardDescription className="text-[var(--sera-muted)]">Your account activity and login history</CardDescription>
        </CardHeader>
        <CardContent className="p-0 px-6 pb-6 pt-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="sera-sc-kpi sera-sc-kpi--accent">
              <div className="flex items-start gap-3">
                <Calendar className="mt-0.5 h-5 w-5 text-[var(--sera-orange)]" />
                <div className="min-w-0 flex-1">
                  <p className="sera-sc-kpi__label">Member Since</p>
                  <p className="mt-1 text-base font-medium text-[var(--sera-ink)]">
                    {formatDate(userProfile.created_at)}
                  </p>
                  <p className="mt-1 text-xs text-[var(--sera-muted)]">
                    {formatRelativeTime(userProfile.created_at)}
                  </p>
                </div>
              </div>
            </div>

            <div className="sera-sc-kpi">
              <div className="flex items-start gap-3">
                <Clock className="mt-0.5 h-5 w-5 text-[var(--sera-orange)]" />
                <div className="min-w-0 flex-1">
                  <p className="sera-sc-kpi__label">Last Login</p>
                  <p className="mt-1 text-base font-medium text-[var(--sera-ink)]">
                    {formatDateTime(userProfile.last_login_at)}
                  </p>
                  <p className="mt-1 text-xs text-[var(--sera-muted)]">
                    {formatRelativeTime(userProfile.last_login_at)}
                  </p>
                </div>
              </div>
            </div>

            <div className="sera-sc-kpi">
              <div className="flex items-start gap-3">
                <MapPin className="mt-0.5 h-5 w-5 text-[var(--sera-orange)]" />
                <div className="min-w-0 flex-1">
                  <p className="sera-sc-kpi__label">Last Login IP</p>
                  <p className="mt-1 text-base font-medium text-[var(--sera-ink)]">
                    {displayLastLoginIp ? (
                      displayLastLoginIp
                    ) : (
                      <span className="italic text-[var(--sera-muted)]/70">Not available</span>
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Account Status Card */}
      <Card className="sera-sc-panel overflow-hidden border-[var(--sera-line)] shadow-none">
        <CardHeader className="space-y-1.5 border-b border-[var(--sera-line)] bg-[var(--sera-mist)]/40 p-0 px-6 py-5">
          <CardTitle className="font-display text-lg text-[var(--sera-ink)]">Account Status</CardTitle>
          <CardDescription className="text-[var(--sera-muted)]">Current verification and account status</CardDescription>
        </CardHeader>
        <CardContent className="p-0 px-6 pb-6 pt-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="sera-sc-kpi">
              <div className="flex items-center gap-3">
              <div className={`h-2.5 w-2.5 rounded-full ${userProfile.is_active ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <div>
                <p className="sera-sc-kpi__label">Account Status</p>
                <p className="text-base font-medium text-[var(--sera-ink)]">
                  {userProfile.is_active ? 'Active' : 'Inactive'}
                </p>
              </div>
              </div>
            </div>

            <div className="sera-sc-kpi">
              <div className="flex items-center gap-3">
              <div className={`h-2.5 w-2.5 rounded-full ${userProfile.is_verified ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              <div>
                <p className="sera-sc-kpi__label">Verification Status</p>
                <p className="text-base font-medium text-[var(--sera-ink)]">
                  {userProfile.is_verified ? 'Verified' : 'Pending'}
                </p>
              </div>
              </div>
            </div>

            <div className="sera-sc-kpi">
              <div className="flex items-center gap-3">
              <Calendar className="h-4 w-4 text-[var(--sera-orange)]" />
              <div>
                <p className="sera-sc-kpi__label">Last Updated</p>
                <p className="text-base font-medium text-[var(--sera-ink)]">
                  {formatRelativeTime(userProfile.updated_at)}
                </p>
              </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bank Information Card */}
      <Card className="sera-sc-panel overflow-hidden border-[var(--sera-line)] shadow-none">
        <CardHeader className="space-y-1.5 border-b border-[var(--sera-line)] bg-[var(--sera-mist)]/40 p-0 px-6 py-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="font-display text-lg text-[var(--sera-ink)]">Bank Information</CardTitle>
              <CardDescription className="text-[var(--sera-muted)]">Your bank account details for payouts and transfers</CardDescription>
            </div>
            {!isEditingBank && (
              <Button
                onClick={() => setIsEditingBank(true)}
                variant="outline"
                size="sm"
                className="gap-2 border-[var(--sera-line)] text-[var(--sera-ink-soft)] hover:border-[var(--sera-orange)]/30 hover:text-[var(--sera-orange)]"
              >
                <Edit2 className="h-4 w-4" />
                Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-0 px-6 pb-6 pt-5">
          {isEditingBank ? (
            <>
              <div>
                <Label htmlFor="bank_account_holder_name" className="text-sm font-medium">Account Holder Name</Label>
                <Input
                  id="bank_account_holder_name"
                  value={formData.bank_account_holder_name}
                  onChange={(e) => setFormData({ ...formData, bank_account_holder_name: e.target.value.toUpperCase() })}
                  placeholder="e.g., ALI BIN ABU"
                  disabled={isSavingBank}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="bank_id" className="text-sm font-medium">Bank Name</Label>
                <select
                  id="bank_id"
                  value={formData.bank_id}
                  onChange={(e) => setFormData({ ...formData, bank_id: e.target.value })}
                  disabled={isSavingBank}
                  className="w-full mt-1 h-10 px-3 rounded-md border border-input bg-background text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">Select Bank</option>
                  {banks.map(bank => (
                    <option key={bank.id} value={bank.id}>{bank.short_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="bank_account_number" className="text-sm font-medium">Account Number</Label>
                <Input
                  id="bank_account_number"
                  value={formData.bank_account_number}
                  onChange={(e) => setFormData({ ...formData, bank_account_number: e.target.value.replace(/\D/g, '') })}
                  placeholder="e.g., 1234567890"
                  disabled={isSavingBank}
                  className="mt-1"
                />
              </div>
              <div className="flex gap-3 pt-4">
                <Button
                  onClick={handleSaveBankDetails}
                  className="flex-1 gap-2 bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)]"
                  disabled={isSavingBank}
                >
                  {isSavingBank ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4" />
                      Save Bank Details
                    </>
                  )}
                </Button>
                <Button
                  onClick={handleCancelBankEdit}
                  variant="outline"
                  className="flex-1 gap-2"
                  disabled={isSavingBank}
                >
                  <X className="h-4 w-4" />
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                <User className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm text-[var(--sera-muted)] font-medium">Account Holder Name</p>
                  <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                    {userProfile.bank_account_holder_name || (
                      <span className="text-[var(--sera-muted)]/70 italic">Not set</span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                <Landmark className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm text-[var(--sera-muted)] font-medium">Bank Name</p>
                  <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                    {userProfile.msia_banks?.short_name || (
                      <span className="text-[var(--sera-muted)]/70 italic">Not set</span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 text-[var(--sera-ink-soft)]">
                <CreditCard className="h-5 w-5 text-[var(--sera-muted)]/70 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm text-[var(--sera-muted)] font-medium">Account Number</p>
                  <p className="text-base font-medium text-[var(--sera-ink)] mt-1">
                    {userProfile.bank_account_number || (
                      <span className="text-[var(--sera-muted)]/70 italic">Not set</span>
                    )}
                  </p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Digital Signature Card - Visible for all users who may create/approve orders */}
      <Card className="sera-sc-panel overflow-hidden border-[var(--sera-line)] shadow-none">
        <CardHeader className="space-y-1.5 border-b border-[var(--sera-line)] bg-[var(--sera-mist)]/40 p-0 px-6 py-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="font-display text-lg text-[var(--sera-ink)]">Digital Signature</CardTitle>
              <CardDescription className="text-[var(--sera-muted)]">Upload your signature for document acknowledgement</CardDescription>
            </div>
            {userProfile.signature_url && (
              <Badge variant="outline" className="w-fit border-green-200 bg-green-50 text-green-700">
                <CheckCircle className="mr-1 h-3 w-3" />
                Uploaded
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-0 px-6 pb-6 pt-5">
          <Alert className="border-[var(--sera-orange)]/25 bg-[var(--sera-orange)]/[0.06]">
            <AlertCircle className="h-4 w-4 text-[var(--sera-orange)]" />
            <AlertDescription className="text-[var(--sera-ink-soft)]">
              <strong className="text-[var(--sera-ink)]">Required for Document Acknowledgement:</strong> Upload your digital signature to acknowledge Purchase Orders, Invoices, Payments, and other documents.
              <div className="mt-2 text-sm">
                <p className="mb-1 font-medium text-[var(--sera-ink)]">Tips for best results:</p>
                <ul className="list-inside list-disc space-y-1 text-xs text-[var(--sera-muted)]">
                  <li>Sign on white paper with dark ink</li>
                  <li>Take a clear photo or scan the signature</li>
                  <li>Use transparent PNG format (recommended)</li>
                  <li>Ensure signature is clearly visible</li>
                </ul>
              </div>
            </AlertDescription>
          </Alert>

          <SignatureUpload
            userId={userProfile.id}
            currentSignatureUrl={userProfile.signature_url}
            onSignatureUpdated={(url) => {
              setUserProfile(prev => ({ ...prev, signature_url: url || null }))
              loadUserProfile() // Refresh the entire profile
            }}
          />
        </CardContent>
      </Card>

      {/* Change Password Card */}
      <ChangePasswordCard userEmail={userProfile.email} userPhone={userProfile.phone} />

      <MyAccessRequests />
    </div>
  )
}
