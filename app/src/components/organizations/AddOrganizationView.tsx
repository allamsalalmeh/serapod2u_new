'use client'

import { useState, useEffect } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ArrowLeft, Building2, Save, AlertCircle, Info, MapPin, Loader2, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react'
import OrgLogoUpload from './OrgLogoUpload'
import OrganizationImport from './OrganizationImport'
import ManufacturerCategoryField from './ManufacturerCategoryField'
import { compressAvatar, formatFileSize } from '@/lib/utils/imageCompression'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { 
  getValidParentOrgs, 
  isParentRequired, 
  getParentHelpText,
  getParentFieldLabel,
  validateOrgHierarchy,
  type OrgType
} from '@/lib/utils/orgHierarchy'
import {
  validateOrgCode,
  validateOrgForm,
  translateOrgError,
  getFieldRules,
  ORG_CODE_PREFIX_MAP,
} from '@/lib/utils/orgValidation'
import {
  loadCategoryOptions,
  saveManufacturerCategories,
  validateManufacturerCategories,
  type CategoryOption,
} from '@/lib/organizations/manufacturer-categories'

interface AddOrganizationViewProps {
  userProfile: any
  onViewChange: (view: string) => void
}

interface OrganizationType {
  id: string
  type_code: string
  type_name: string
  description: string
  hierarchy_level: number
  is_active: boolean
}

interface State {
  id: string
  state_code: string
  state_name: string
  is_active: boolean
}

interface District {
  id: string
  district_code: string
  district_name: string
  state_id: string
  is_active: boolean
}

interface Organization {
  id: string
  org_code: string
  org_name: string
  org_type_code: string
}

interface PaymentTerm {
  id: string
  term_code: string
  term_name: string
  deposit_percentage: number
  balance_percentage: number
  description: string | null
  is_default: boolean
  is_active: boolean
}

export default function AddOrganizationView({ userProfile, onViewChange }: AddOrganizationViewProps) {
  const [loading, setLoading] = useState(false)
  const [dataLoading, setDataLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  
  const [orgTypes, setOrgTypes] = useState<OrganizationType[]>([])
  const [states, setStates] = useState<State[]>([])
  const [districts, setDistricts] = useState<District[]>([])
  const [parentOrgs, setParentOrgs] = useState<Organization[]>([])
  const [filteredParentOrgs, setFilteredParentOrgs] = useState<Organization[]>([])
  const [autoAssignedHQ, setAutoAssignedHQ] = useState<Organization | null>(null)
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerm[]>([])

  const [formData, setFormData] = useState({
    org_type_code: '',
    parent_org_id: '',
    org_code: '',
    org_name: '',
    registration_no: '',
    tax_id: '',
    website: '',
    address: '',
    address_line2: '',
    city: '',
    state_id: '',
    district_id: '',
    postal_code: '',
    country_code: 'MY',
    latitude: '',
    longitude: '',
    contact_name: '',
    contact_title: '',
    contact_phone: '',
    contact_email: '',
    payment_term_id: '',
    is_active: true,
    // Shop-specific fields
    branch: '',
    sells_serapod_flavour: false,
    sells_sbox: false,
    sells_sbox_special_edition: false,
    hot_flavour_brands: '',
  })

  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoError, setLogoError] = useState('')
  const [gettingLocation, setGettingLocation] = useState(false)
  const [orgCodeStatus, setOrgCodeStatus] = useState<'idle' | 'generating' | 'ready' | 'error'>('idle')
  const [orgCodeError, setOrgCodeError] = useState('')
  const [formWarnings, setFormWarnings] = useState<string[]>([])
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[] | null>(null)
  const [categoryIds, setCategoryIds] = useState<string[]>([])
  const [categoryError, setCategoryError] = useState('')

  const { isReady, supabase } = useSupabaseAuth()
  const isManufacturer = formData.org_type_code === 'MFG'

  // Product Master categories are only needed once Manufacturer is chosen.
  useEffect(() => {
    if (!isReady || !isManufacturer || categoryOptions) return
    loadCategoryOptions(supabase)
      .then(setCategoryOptions)
      .catch((loadError) => {
        console.error('Error fetching product categories:', loadError)
        setCategoryOptions([])
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, isManufacturer])

  useEffect(() => {
    if (isReady) {
      fetchFormData()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  useEffect(() => {
    if (formData.state_id) {
      fetchDistricts(formData.state_id)
    } else {
      setDistricts([])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.state_id])

  // Auto-generate org code when type changes
  useEffect(() => {
    if (formData.org_type_code) {
      generateOrgCode(formData.org_type_code)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.org_type_code])

  // Filter parent organizations when org type changes
  useEffect(() => {
    if (formData.org_type_code) {
      const validParents = getValidParentOrgs(
        formData.org_type_code as OrgType,
        parentOrgs as any[]
      )
      setFilteredParentOrgs(validParents as Organization[])
      
      // Smart auto-assignment logic for DIST and MANU
      if ((formData.org_type_code === 'DIST' || formData.org_type_code === 'MFG') && validParents.length === 1) {
        // Only 1 HQ exists - auto-assign it
        const singleHQ = validParents[0]
        handleInputChange('parent_org_id', singleHQ.id)
        setAutoAssignedHQ(singleHQ)
        console.log('✅ Auto-assigned to single HQ:', singleHQ.org_name)
      } else if ((formData.org_type_code === 'DIST' || formData.org_type_code === 'MFG') && validParents.length > 1) {
        // Multiple HQs - user must choose
        setAutoAssignedHQ(null)
        // Don't clear selection if already valid
        if (formData.parent_org_id) {
          const isValid = validParents.some(p => p.id === formData.parent_org_id)
          if (!isValid) {
            handleInputChange('parent_org_id', '')
          }
        }
      } else {
        // Other org types or no HQ available
        setAutoAssignedHQ(null)
        // Clear parent_org_id if current selection is not valid
        if (formData.parent_org_id) {
          const isValid = validParents.some(p => p.id === formData.parent_org_id)
          if (!isValid) {
            handleInputChange('parent_org_id', '')
          }
        }
      }
      
      // For HQ, always clear parent
      if (formData.org_type_code === 'HQ') {
        handleInputChange('parent_org_id', '')
        setAutoAssignedHQ(null)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.org_type_code, parentOrgs])

  const fetchFormData = async () => {
    if (!isReady) return

    try {
      setDataLoading(true)

      // Fetch organization types
      const { data: types, error: typesError } = await supabase
        .from('organization_types')
        .select('*')
        .eq('is_active', true)
        .order('hierarchy_level', { ascending: true })

      if (typesError) throw typesError
      setOrgTypes((types || []).map(t => ({
        id: t.id,
        type_code: t.type_code,
        type_name: t.type_name,
        description: t.type_description || '',
        hierarchy_level: t.hierarchy_level,
        is_active: t.is_active ?? true
      })))

      // Fetch states
      const { data: statesData, error: statesError } = await supabase
        .from('states')
        .select('*')
        .eq('is_active', true)
        .order('state_name', { ascending: true })

      if (statesError) throw statesError
      setStates((statesData || []).map(s => ({
        id: s.id,
        state_code: s.state_code,
        state_name: s.state_name,
        is_active: s.is_active ?? true
      })))

      // Fetch parent organizations based on user role
      let parentQuery = supabase
        .from('organizations')
        .select('id, org_code, org_name, org_type_code')
        .eq('is_active', true)

      // Apply access control based on role level
      if (userProfile.roles.role_level > 50) {
        // Super Admin (1-50): Can see all organizations
        // Power users (50+): See their org hierarchy
      } else {
        // Regular users can only see their own org and direct parents/children
        parentQuery = parentQuery.or(`id.eq.${userProfile.organization_id},parent_org_id.eq.${userProfile.organization_id}`)
      }

      const { data: parents, error: parentsError } = await parentQuery.order('org_name', { ascending: true })

      if (parentsError) throw parentsError
      setParentOrgs(parents || [])

      // Fetch payment terms
      const { data: termsData, error: termsError } = await supabase
        .from('payment_terms')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })

      if (termsError) throw termsError
      setPaymentTerms(termsData || [])

      // Set default payment term if available
      const defaultTerm = (termsData || []).find((t: any) => t.is_default)
      if (defaultTerm) {
        setFormData(prev => ({ ...prev, payment_term_id: defaultTerm.id }))
      }

    } catch (error: any) {
      console.error('Error fetching form data:', error)
      setError('Failed to load form data: ' + error.message)
    } finally {
      setDataLoading(false)
    }
  }

  const fetchDistricts = async (stateId: string) => {
    try {
      const { data, error } = await supabase
        .from('districts')
        .select('*')
        .eq('state_id', stateId)
        .eq('is_active', true)
        .order('district_name', { ascending: true })

      if (error) throw error
      setDistricts((data || []).map(d => ({
        id: d.id,
        district_code: d.district_code,
        district_name: d.district_name,
        state_id: d.state_id,
        is_active: d.is_active ?? true
      })))
    } catch (error: any) {
      console.error('Error fetching districts:', error)
      setDistricts([])
    }
  }

  const generateOrgCode = async (typeCode: string) => {
    try {
      setOrgCodeStatus('generating')
      setOrgCodeError('')

      const prefix = ORG_CODE_PREFIX_MAP[typeCode] || typeCode.substring(0, 2).toUpperCase()

      const { data, error } = await (supabase as any)
        .from('organizations')
        .select('org_code')
        .eq('org_type_code', typeCode)

      if (error) throw error

      let maxNumber = 0
      
      if (data && data.length > 0) {
        data.forEach((org: any) => {
          if (org.org_code && org.org_code.startsWith(prefix)) {
            const numberPart = org.org_code.substring(prefix.length)
            const number = parseInt(numberPart)
            if (!isNaN(number) && number > maxNumber) {
              maxNumber = number
            }
          }
        })
      }

      const nextNumber = maxNumber + 1
      const newCode = `${prefix}${String(nextNumber).padStart(3, '0')}`

      // Validate the generated code before setting it
      const codeErr = validateOrgCode(newCode)
      if (codeErr) {
        throw new Error(codeErr)
      }

      handleInputChange('org_code', newCode)
      setOrgCodeStatus('ready')
    } catch (error: any) {
      console.error('Error generating org code:', error)
      setOrgCodeStatus('error')
      setOrgCodeError(error?.message || 'Failed to generate organization code')
      // Set a fallback code so the form isn't stuck with empty value
      // User can retry via the retry button
    }
  }

  const checkDuplicateOrgName = async (orgName: string, orgType: string): Promise<boolean> => {
    try {
      const { data, error } = await supabase
        .from('organizations')
        .select('id')
        .eq('org_name', orgName.trim())
        .eq('org_type_code', orgType)
        .eq('is_active', true)

      if (error) throw error
      return data && data.length > 0
    } catch (error: any) {
      console.error('Error checking duplicate name:', error)
      return false
    }
  }

  const validateForm = (): string | null => {
    const result = validateOrgForm(formData as any)
    setFormWarnings(result.warnings)
    if (!result.valid) {
      return result.errors[0] // Show first error
    }
    return null
  }

  const handleInputChange = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    setError('')
  }

  const handleLogoChange = (file: File | null) => {
    setLogoFile(file)
    if (file && !file.type.startsWith('image/')) {
      setLogoError('Please select an image file')
    } else if (file && file.size > 5 * 1024 * 1024) {
      setLogoError('Image must be less than 5MB')
    } else {
      setLogoError('')
    }
  }

  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      setError('Geolocation is not supported by your browser')
      return
    }

    setGettingLocation(true)
    setError('')

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords
        handleInputChange('latitude', latitude.toFixed(6))
        handleInputChange('longitude', longitude.toFixed(6))
        setGettingLocation(false)
      },
      (error) => {
        setGettingLocation(false)
        switch (error.code) {
          case error.PERMISSION_DENIED:
            setError('Location permission denied. Please enable location access in your browser settings.')
            break
          case error.POSITION_UNAVAILABLE:
            setError('Location information is unavailable.')
            break
          case error.TIMEOUT:
            setError('Location request timed out.')
            break
          default:
            setError('An error occurred while getting your location.')
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const validationError = validateForm()
    if (validationError) {
      setError(validationError)
      return
    }

    if (isManufacturer) {
      const categoryValidation = validateManufacturerCategories({
        mode: 'create',
        saved: [],
        selected: categoryIds,
        options: categoryOptions || [],
      })
      setCategoryError(categoryValidation || '')
      if (categoryValidation) {
        setError(categoryValidation)
        return
      }
    }

    // Validate organization hierarchy constraints
    const parentOrg = formData.parent_org_id 
      ? parentOrgs.find(p => p.id === formData.parent_org_id)
      : undefined
    
    const hierarchyError = validateOrgHierarchy(
      formData.org_type_code as OrgType,
      formData.parent_org_id || null,
      parentOrg?.org_type_code as OrgType | undefined
    )
    
    if (hierarchyError) {
      setError(hierarchyError)
      return
    }

    // Check for duplicate organization name within the same type
    const isDuplicate = await checkDuplicateOrgName(formData.org_name, formData.org_type_code)
    if (isDuplicate) {
      setError(`An organization with the name "${formData.org_name}" already exists for this type. Please choose a different name.`)
      return
    }

    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const insertData: any = {
        org_type_code: formData.org_type_code,
        org_code: formData.org_code,
        org_name: formData.org_name,
        registration_no: formData.registration_no || null,
        tax_id: formData.tax_id || null,
        website: formData.website || null,
        address: formData.address || null,
        address_line2: formData.address_line2 || null,
        city: formData.city || null,
        state_id: formData.state_id || null,
        district_id: formData.district_id || null,
        postal_code: formData.postal_code || null,
        country_code: formData.country_code,
        latitude: formData.latitude ? parseFloat(formData.latitude) : null,
        longitude: formData.longitude ? parseFloat(formData.longitude) : null,
        contact_name: formData.contact_name || null,
        contact_title: formData.contact_title || null,
        contact_phone: formData.contact_phone || null,
        contact_email: formData.contact_email || null,
        payment_term_id: formData.payment_term_id || null,
        is_active: formData.is_active,
        logo_url: null, // Will be updated after upload
        created_by: userProfile.id,
        // Always include parent_org_id (required for SHOP and DIST, optional for others)
        parent_org_id: formData.parent_org_id || null
      }

      // Add shop-specific fields for SHOP type
      if (formData.org_type_code === 'SHOP') {
        insertData.branch = formData.branch || null
        insertData.sells_serapod_flavour = !!formData.sells_serapod_flavour
        insertData.sells_sbox = !!formData.sells_sbox
        insertData.sells_sbox_special_edition = !!formData.sells_sbox_special_edition
        insertData.hot_flavour_brands = formData.hot_flavour_brands || null
      }

      const { data, error: insertError } = await (supabase as any)
        .from('organizations')
        .insert([insertData])
        .select()

      if (insertError) throw insertError

      const newOrgId = data[0].id

      // Classification is saved right after the manufacturer exists; the organization is kept
      // if this fails, and the admin is taken to Edit to finish (it shows "Not classified").
      let categorySaveError = ''
      if (isManufacturer && newOrgId) {
        try {
          await saveManufacturerCategories(supabase, newOrgId, categoryIds)
        } catch (saveError: any) {
          categorySaveError = saveError?.message || 'Product categories could not be saved.'
        }
      }

      if ((formData.org_type_code === 'SHOP' || formData.org_type_code === 'DIST') && newOrgId) {
        try {
          const membershipResponse = await fetch('/api/loyalty/memberships/organization', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationId: newOrgId }),
          })
          if (!membershipResponse.ok) {
            const membershipResult = await membershipResponse.json().catch(() => null)
            console.error('Failed to enroll organization in Cellera Loyalty:', membershipResult?.error || membershipResponse.statusText)
          }
        } catch (membershipError) {
          console.error('Failed to enroll organization in Cellera Loyalty:', membershipError)
        }
      }

      // Upload logo if provided (using same pattern as user avatars)
      if (logoFile && newOrgId) {
        try {
          // Compress logo first
          const compressionResult = await compressAvatar(logoFile)
          
          console.log(`🖼️ Logo compressed: ${formatFileSize(compressionResult.originalSize)} → ${formatFileSize(compressionResult.compressedSize)} (${compressionResult.compressionRatio.toFixed(1)}% smaller)`)

          const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`
          const filePath = `${newOrgId}/${fileName}` // Nested folder: org_id/filename

          const { error: uploadError } = await supabase.storage
            .from('avatars') // Use same bucket as user avatars
            .upload(filePath, compressionResult.file, {
              contentType: compressionResult.file.type,
              cacheControl: '3600',
              upsert: true // Allow overwrite
            })

          if (uploadError) {
            console.error('Logo upload error:', uploadError)
            // Continue without logo if upload fails
          } else {
            const { data: { publicUrl } } = supabase.storage
              .from('avatars')
              .getPublicUrl(filePath)
            
            const logo_url = `${publicUrl}?v=${Date.now()}` // Add cache-busting
            
            // Update organization with logo URL
            await (supabase as any)
              .from('organizations')
              .update({ logo_url })
              .eq('id', newOrgId)
          }
        } catch (logoUploadError) {
          console.error('Error uploading logo:', logoUploadError)
          // Continue without logo if upload fails
        }
      }

      // If creating a SHOP with a DIST parent, automatically create shop_distributors relationship
      if (data && data.length > 0 && formData.org_type_code === 'SHOP' && formData.parent_org_id) {
        const parentOrg = parentOrgs.find(p => p.id === formData.parent_org_id)
        console.log('🔍 Auto-link check:', {
          shopId: data[0].id,
          parentOrgId: formData.parent_org_id,
          parentOrgCode: parentOrg?.org_type_code,
          parentOrgName: parentOrg?.org_name
        })
        
        if (parentOrg && parentOrg.org_type_code === 'DIST') {
          try {
            console.log('✅ Creating shop_distributors link...', {
              shop_id: data[0].id,
              distributor_id: formData.parent_org_id
            })
            
            // First check if link already exists (to prevent duplicates)
            const { data: existingLink, error: checkError } = await (supabase as any)
              .from('shop_distributors')
              .select('id')
              .eq('shop_id', data[0].id)
              .eq('distributor_id', formData.parent_org_id)
              .maybeSingle()
            
            if (checkError) {
              console.error('⚠️ Error checking existing link:', checkError.message)
            }
            
            if (existingLink) {
              console.log('ℹ️ Shop-distributor link already exists, skipping creation')
            } else {
              // Create the link
              const { data: linkData, error: linkError } = await (supabase as any)
                .from('shop_distributors')
                .insert([{
                  shop_id: data[0].id,
                  distributor_id: formData.parent_org_id,
                  payment_terms: 'NET_30',
                  is_active: true,
                  is_preferred: true, // First distributor is always default
                  approved_by: userProfile.id,
                  approved_at: new Date().toISOString(),
                  created_by: userProfile.id // Track who created this relationship
                }])
                .select()
              
              if (linkError) {
                console.error('❌ Failed to create shop-distributor link:', {
                  errorString: String(linkError),
                  message: linkError.message || 'No message',
                  details: linkError.details || 'No details',
                  hint: linkError.hint || 'No hint',
                  code: linkError.code || 'No code',
                  fullError: JSON.stringify(linkError, Object.getOwnPropertyNames(linkError))
                })
                
                // Check if it's a duplicate key error (code 23505)
                if (linkError.code === '23505') {
                  console.log('ℹ️ Link already exists (duplicate key), continuing...')
                } else {
                  // Log but don't fail the whole operation
                  console.warn('⚠️ Shop-distributor link creation failed but shop was created successfully')
                }
              } else {
                console.log('✅ Shop-distributor link created successfully:', linkData)
                // Longer delay to ensure database transaction is committed and indexed
                await new Promise(resolve => setTimeout(resolve, 800))
                // Signal parent to refresh link status
                sessionStorage.setItem('needsLinkRefresh', 'true')
              }
            }
          } catch (linkErr: any) {
            console.error('❌ Exception creating shop-distributor link:', {
              errorString: String(linkErr),
              message: linkErr?.message || 'No message',
              stack: linkErr?.stack || 'No stack',
              fullError: JSON.stringify(linkErr, Object.getOwnPropertyNames(linkErr))
            })
          }
        } else {
          console.log('ℹ️ Parent is not a distributor, skipping shop_distributors link')
        }
      }

      if (categorySaveError) {
        setError(`Manufacturer created, but its product categories were not saved: ${categorySaveError} Opening the manufacturer so you can assign them.`)
        sessionStorage.setItem('selectedOrgId', newOrgId)
        sessionStorage.setItem('selectedOrgType', 'MFG')
        setTimeout(() => {
          onViewChange('edit-organization')
        }, 2500)
        return
      }

      setSuccess('Organization created successfully!')
      
      // Redirect after 1 second (reduced since we already waited 800ms above)
      setTimeout(() => {
        onViewChange('organizations')
      }, 1000)

    } catch (error: any) {
      console.error('Error creating organization:', error)
      const friendlyError = translateOrgError(error)
      setError(friendlyError)
    } finally {
      setLoading(false)
    }
  }

  if (dataLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[var(--sera-orange)] mx-auto mb-4"></div>
          <p className="text-[var(--sera-muted)]">Loading form...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="sera-sc-page space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onViewChange('organizations')}
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>
        <div>
          <h2 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">Add New Organization</h2>
          <p className="text-[var(--sera-muted)] text-sm">Create a new organization in your supply chain network</p>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert className="border-red-200 bg-red-50">
          <AlertCircle className="h-4 w-4 text-red-600" />
          <AlertDescription className="text-red-800 ml-2">{error}</AlertDescription>
        </Alert>
      )}

      {/* Success Alert */}
      {success && (
        <Alert className="border-green-200 bg-green-50">
          <AlertDescription className="text-green-800">{success}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="manual" className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-2 gap-2 rounded-2xl bg-transparent p-0">
          <TabsTrigger
            value="manual"
            className="rounded-xl border border-[var(--sera-line)] px-3 py-2 text-sm font-medium text-[var(--sera-muted)] transition data-[state=active]:border-[var(--sera-orange)] data-[state=active]:bg-[var(--sera-orange)] data-[state=active]:text-white"
          >
            Manual Entry
          </TabsTrigger>
          <TabsTrigger
            value="import"
            className="rounded-xl border border-[var(--sera-line)] px-3 py-2 text-sm font-medium text-[var(--sera-muted)] transition data-[state=active]:border-[var(--sera-orange)] data-[state=active]:bg-[var(--sera-orange)] data-[state=active]:text-white"
          >
            Import CSV/Excel
          </TabsTrigger>
        </TabsList>

        <TabsContent value="import" className="mt-6">
          <OrganizationImport parentOrgs={parentOrgs} />
        </TabsContent>

        <TabsContent value="manual" className="mt-6">
      {/* Form */}
      <form onSubmit={handleSubmit} className="sera-sc-page space-y-6">
        {/* Basic Information */}
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Building2 className="w-5 h-5" />
                  Basic Information
                </CardTitle>
                <CardDescription>Core organization details</CardDescription>
              </div>
              
              {/* Auto-assigned HQ Badge */}
              {autoAssignedHQ && (
                <div className="bg-[var(--sera-orange)]/[0.06] border border-[var(--sera-orange)]/20 rounded-lg px-4 py-2 text-sm">
                  <div className="flex items-center gap-2 text-[var(--sera-orange-deep)] font-medium mb-1">
                    <Info className="w-4 h-4" />
                    Headquarters Active
                  </div>
                  <div className="text-[var(--sera-orange)] font-semibold">
                    {autoAssignedHQ.org_name}
                  </div>
                  <div className="text-[var(--sera-orange)] text-xs mt-0.5">
                    ({autoAssignedHQ.org_code})
                  </div>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Logo Upload */}
            <OrgLogoUpload
              orgName={formData.org_name || 'New Organization'}
              onLogoChange={handleLogoChange}
              onError={setLogoError}
              error={logoError}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="org_type_code">Organization Type *</Label>
                <Select
                  value={formData.org_type_code}
                  onValueChange={(value) => handleInputChange('org_type_code', value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select organization type" />
                  </SelectTrigger>
                  <SelectContent>
                    {orgTypes.map((type) => (
                      <SelectItem key={type.id} value={type.type_code}>
                        {type.type_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Parent Organization - conditional rendering based on type */}
              {formData.org_type_code && formData.org_type_code !== 'HQ' && (
                <div className="space-y-2">
                  <Label htmlFor="parent_org_id">
                    {getParentFieldLabel(formData.org_type_code as OrgType)}
                    {isParentRequired(formData.org_type_code as OrgType) && ' *'}
                  </Label>
                  
                  {/* Smart rendering: Show dropdown only if multiple HQs or not auto-assigned */}
                  {autoAssignedHQ ? (
                    // Single HQ - show read-only info (no dropdown needed)
                    <div className="relative">
                      <Input
                        value={`${autoAssignedHQ.org_name} (${autoAssignedHQ.org_code})`}
                        disabled
                        className="bg-[var(--sera-orange)]/[0.06] border-[var(--sera-orange)]/20 text-[var(--sera-ink)] font-medium cursor-not-allowed"
                      />
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 bg-[var(--sera-orange)] text-white text-xs px-2 py-1 rounded-full font-semibold">
                        Auto-assigned
                      </div>
                      <p className="text-xs text-[var(--sera-orange)] mt-1 flex items-center gap-1">
                        <Info className="w-3 h-3" />
                        Only one headquarters available - automatically assigned
                      </p>
                    </div>
                  ) : (
                    // Multiple HQs or other scenarios - show dropdown
                    <>
                      {/* Help text showing hierarchy rules */}
                      <Alert className="mb-2">
                        <Info className="h-4 w-4" />
                        <AlertDescription>
                          {getParentHelpText(formData.org_type_code as OrgType)}
                        </AlertDescription>
                      </Alert>

                      <Select
                        value={formData.parent_org_id || 'none'}
                        onValueChange={(value) => handleInputChange('parent_org_id', value === 'none' ? '' : value)}
                      >
                        <SelectTrigger>
                          <SelectValue 
                            placeholder={
                              isParentRequired(formData.org_type_code as OrgType)
                                ? "Select parent organization"
                                : "Select parent organization (optional)"
                            } 
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {!isParentRequired(formData.org_type_code as OrgType) && (
                            <SelectItem value="none">No parent organization</SelectItem>
                          )}
                          {filteredParentOrgs.map((org) => (
                            <SelectItem key={org.id} value={org.id}>
                              {org.org_name} ({org.org_code})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      
                      {filteredParentOrgs.length > 1 && (formData.org_type_code === 'DIST' || formData.org_type_code === 'MFG') && (
                        <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" />
                          Multiple headquarters detected - please select one
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {isManufacturer && (
                <div className="md:col-span-2">
                  <ManufacturerCategoryField
                    mode="create"
                    options={categoryOptions || []}
                    savedIds={[]}
                    value={categoryIds}
                    onChange={(ids) => {
                      setCategoryIds(ids)
                      setCategoryError('')
                      setError('')
                    }}
                    error={categoryError}
                    disabled={loading || categoryOptions === null}
                  />
                </div>
              )}

              <div>
                <Label htmlFor="org_code">Organization Code</Label>
                <div className="relative">
                  <Input
                    id="org_code"
                    value={formData.org_code}
                    disabled
                    placeholder={orgCodeStatus === 'generating' ? 'Generating...' : 'Select org type to auto-generate'}
                    className={`bg-gray-100 cursor-not-allowed pr-10 ${
                      orgCodeStatus === 'error' ? 'border-red-300 bg-red-50' :
                      orgCodeStatus === 'ready' ? 'border-green-300 bg-green-50' : ''
                    }`}
                  />
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {orgCodeStatus === 'generating' && (
                      <Loader2 className="w-4 h-4 text-[var(--sera-orange)] animate-spin" />
                    )}
                    {orgCodeStatus === 'ready' && (
                      <CheckCircle2 className="w-4 h-4 text-green-500" />
                    )}
                    {orgCodeStatus === 'error' && (
                      <button
                        type="button"
                        onClick={() => formData.org_type_code && generateOrgCode(formData.org_type_code)}
                        className="p-0.5 rounded hover:bg-red-100 transition-colors"
                        title="Retry code generation"
                      >
                        <RefreshCw className="w-4 h-4 text-red-500" />
                      </button>
                    )}
                  </div>
                </div>
                {orgCodeStatus === 'error' && orgCodeError && (
                  <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {orgCodeError} — <button type="button" onClick={() => formData.org_type_code && generateOrgCode(formData.org_type_code)} className="underline hover:text-red-800">click to retry</button>
                  </p>
                )}
                {orgCodeStatus === 'ready' && (
                  <p className="text-xs text-green-600 mt-1">
                    Auto-generated based on organization type
                  </p>
                )}
                {orgCodeStatus === 'idle' && (
                  <p className="text-xs text-[var(--sera-muted)] mt-1">
                    Select an organization type to auto-generate code
                  </p>
                )}
              </div>

              <div>
                <Label htmlFor="org_name">Organization Name *</Label>
                <Input
                  id="org_name"
                  value={formData.org_name}
                  onChange={(e) => handleInputChange('org_name', e.target.value)}
                  placeholder="Enter full organization name"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label htmlFor="registration_no">Registration Number</Label>
                <Input
                  id="registration_no"
                  value={formData.registration_no}
                  onChange={(e) => handleInputChange('registration_no', e.target.value)}
                  placeholder="Enter business registration number"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>

              <div>
                <Label htmlFor="tax_id">Tax ID</Label>
                <Input
                  id="tax_id"
                  value={formData.tax_id}
                  onChange={(e) => handleInputChange('tax_id', e.target.value)}
                  placeholder="Enter tax identification number"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>

              <div>
                <Label htmlFor="website">Website</Label>
                <Input
                  id="website"
                  value={formData.website}
                  onChange={(e) => handleInputChange('website', e.target.value)}
                  placeholder="Enter website URL (e.g., https://example.com)"
                  type="url"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Address Information */}
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle>Address Information</CardTitle>
            <CardDescription>Physical location details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="address">Address Line 1</Label>
              <Textarea
                id="address"
                value={formData.address}
                onChange={(e) => handleInputChange('address', e.target.value)}
                placeholder="Enter street address (e.g., 123 Main Street)"
                rows={2}
                className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
              />
            </div>

            <div>
              <Label htmlFor="address_line2">Address Line 2</Label>
              <Textarea
                id="address_line2"
                value={formData.address_line2}
                onChange={(e) => handleInputChange('address_line2', e.target.value)}
                placeholder="Enter additional address information (e.g., Suite 100, Building B)"
                rows={2}
                className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={formData.city}
                  onChange={(e) => handleInputChange('city', e.target.value)}
                  placeholder="Enter city name (e.g., Kuala Lumpur)"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>

              <div>
                <Label htmlFor="postal_code">Postal Code</Label>
                <Input
                  id="postal_code"
                  value={formData.postal_code}
                  onChange={(e) => handleInputChange('postal_code', e.target.value)}
                  placeholder="Enter 5-digit postal code (e.g., 50450)"
                  maxLength={5}
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="state_id">State</Label>
                <Select
                  value={formData.state_id || 'none'}
                  onValueChange={(value) => {
                    if (value === 'none') {
                      handleInputChange('state_id', '')
                      handleInputChange('district_id', '')
                    } else {
                      handleInputChange('state_id', value)
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select state" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (Not defined)</SelectItem>
                    {states.map((state) => (
                      <SelectItem key={state.id} value={state.id}>
                        {state.state_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="district_id">District</Label>
                <Select
                  value={formData.district_id || 'none'}
                  onValueChange={(value) => handleInputChange('district_id', value === 'none' ? '' : value)}
                  disabled={!formData.state_id}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={formData.state_id ? "Select district" : "None (Not defined)"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (Not defined)</SelectItem>
                    {districts.map((district) => (
                      <SelectItem key={district.id} value={district.id}>
                        {district.district_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label htmlFor="country_code">Country Code</Label>
                <Input
                  id="country_code"
                  value={formData.country_code}
                  onChange={(e) => handleInputChange('country_code', e.target.value)}
                  maxLength={2}
                  placeholder="Enter 2-letter country code (e.g., MY)"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>

              <div>
                <Label htmlFor="latitude">Latitude</Label>
                <Input
                  id="latitude"
                  value={formData.latitude}
                  onChange={(e) => handleInputChange('latitude', e.target.value)}
                  placeholder="Enter latitude (-90 to 90, e.g., 3.139003)"
                  type="number"
                  step="0.000001"
                  min="-90"
                  max="90"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>

              <div>
                <Label htmlFor="longitude">Longitude</Label>
                <Input
                  id="longitude"
                  value={formData.longitude}
                  onChange={(e) => handleInputChange('longitude', e.target.value)}
                  placeholder="Enter longitude (-180 to 180, e.g., 101.686855)"
                  type="number"
                  step="0.000001"
                  min="-180"
                  max="180"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>
            </div>

            {/* GPS Auto-fill Button */}
            <div className="flex items-center gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleGetLocation}
                disabled={gettingLocation}
                className="text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)]"
              >
                {gettingLocation ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Getting location...
                  </>
                ) : (
                  <>
                    <MapPin className="w-4 h-4 mr-2" />
                    Auto-detect my location (GPS)
                  </>
                )}
              </Button>
              {(formData.latitude && formData.longitude) && (
                <span className="text-xs text-green-600 flex items-center gap-1">
                  <MapPin className="w-3 h-3" />
                  Coordinates set
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Payment Terms - Only show for manufacturers, distributors, and shops */}
        {(formData.org_type_code === 'MFG' || formData.org_type_code === 'DIST' || formData.org_type_code === 'SHOP') && (
          <Card className="sera-sc-panel overflow-hidden shadow-none">
            <CardHeader>
              <CardTitle>Payment Terms</CardTitle>
              <CardDescription>Default payment terms for orders with this organization as seller</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="payment_term_id">Payment Terms</Label>
                <Select
                  value={formData.payment_term_id || undefined}
                  onValueChange={(value) => handleInputChange('payment_term_id', value)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select payment terms" />
                  </SelectTrigger>
                  <SelectContent>
                    {paymentTerms.map((term) => (
                      <SelectItem key={term.id} value={term.id}>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{term.term_name}</span>
                          {term.is_default && (
                            <span className="text-xs text-[var(--sera-orange)]">(Default)</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {formData.payment_term_id && (
                  <p className="text-sm text-[var(--sera-muted)] mt-2">
                    {paymentTerms.find(t => t.id === formData.payment_term_id)?.description}
                  </p>
                )}
                <div className="mt-3 p-3 bg-[var(--sera-orange)]/[0.06] border border-[var(--sera-orange)]/20 rounded-lg">
                  <p className="text-xs text-[var(--sera-orange-deep)]">
                    <strong>Note:</strong> This payment term will be automatically applied when creating orders with this organization as the seller.
                    It determines the deposit and balance payment split in the document workflow.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Shop Information - Only show for SHOP type */}
        {formData.org_type_code === 'SHOP' && (
          <Card className="sera-sc-panel overflow-hidden shadow-none">
            <CardHeader>
              <CardTitle>Shop Information</CardTitle>
              <CardDescription>Shop-specific details for field survey data</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="branch">Branch</Label>
                  <Input
                    id="branch"
                    value={formData.branch}
                    onChange={(e) => handleInputChange('branch', e.target.value)}
                    placeholder="Branch name or location variant"
                    className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                  />
                </div>
                <div>
                  <Label htmlFor="hot_flavour_brands">Hot Flavour Brands</Label>
                  <Input
                    id="hot_flavour_brands"
                    value={formData.hot_flavour_brands}
                    onChange={(e) => handleInputChange('hot_flavour_brands', e.target.value)}
                    placeholder="Comma-separated brand names"
                    className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                  />
                  <p className="text-xs text-[var(--sera-muted)] mt-1">e.g. Brand A, Brand B</p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label>Sells Flavour Serapod</Label>
                  <Select
                    value={formData.sells_serapod_flavour ? 'true' : 'false'}
                    onValueChange={(v) => handleInputChange('sells_serapod_flavour', v === 'true')}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Ya</SelectItem>
                      <SelectItem value="false">Tidak</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Sells S.Box</Label>
                  <Select
                    value={formData.sells_sbox ? 'true' : 'false'}
                    onValueChange={(v) => handleInputChange('sells_sbox', v === 'true')}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Ya</SelectItem>
                      <SelectItem value="false">Tidak</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Sells S.Box Special Edition</Label>
                  <Select
                    value={formData.sells_sbox_special_edition ? 'true' : 'false'}
                    onValueChange={(v) => handleInputChange('sells_sbox_special_edition', v === 'true')}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Ya</SelectItem>
                      <SelectItem value="false">Tidak</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Contact Information */}
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle>Contact Information</CardTitle>
            <CardDescription>Primary contact details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="contact_name">Contact Name</Label>
                <Input
                  id="contact_name"
                  value={formData.contact_name}
                  onChange={(e) => handleInputChange('contact_name', e.target.value)}
                  placeholder="Enter contact person's full name (e.g., John Doe)"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>

              <div>
                <Label htmlFor="contact_title">Contact Title</Label>
                <Input
                  id="contact_title"
                  value={formData.contact_title}
                  onChange={(e) => handleInputChange('contact_title', e.target.value)}
                  placeholder="Enter job title (e.g., General Manager)"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>

              <div>
                <Label htmlFor="contact_phone">Contact Phone</Label>
                <Input
                  id="contact_phone"
                  value={formData.contact_phone}
                  onChange={(e) => handleInputChange('contact_phone', e.target.value)}
                  placeholder="Enter phone number (e.g., +60123456789)"
                  type="tel"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>

              <div>
                <Label htmlFor="contact_email">Contact Email</Label>
                <Input
                  id="contact_email"
                  value={formData.contact_email}
                  onChange={(e) => handleInputChange('contact_email', e.target.value)}
                  placeholder="Enter email address (e.g., contact@example.com)"
                  type="email"
                  className="placeholder:text-[var(--sera-muted)]/70 placeholder:italic"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Settings */}
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle>Settings</CardTitle>
            <CardDescription>Organization configuration</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center space-x-3">
              <input
                type="checkbox"
                id="is_active"
                checked={formData.is_active}
                onChange={(e) => handleInputChange('is_active', e.target.checked)}
                className="h-4 w-4 rounded border-[var(--sera-line)] text-[var(--sera-orange)]"
              />
              <Label htmlFor="is_active" className="mb-0">Organization is active</Label>
            </div>
          </CardContent>
        </Card>

        {/* Warnings */}
        {formWarnings.length > 0 && (
          <Alert className="border-amber-200 bg-amber-50">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertDescription className="text-amber-800 ml-2">
              <ul className="list-disc list-inside space-y-0.5">
                {formWarnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* Readiness Check */}
        {formData.org_type_code && (
          <Card className="border-dashed">
            <CardContent className="py-3">
              <p className="text-xs font-medium text-[var(--sera-muted)] mb-2">Readiness Check</p>
              <div className="flex flex-wrap gap-3 text-xs">
                <span className={`flex items-center gap-1 ${formData.org_type_code ? 'text-green-600' : 'text-[var(--sera-muted)]/70'}`}>
                  {formData.org_type_code ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                  Type
                </span>
                <span className={`flex items-center gap-1 ${orgCodeStatus === 'ready' ? 'text-green-600' : orgCodeStatus === 'error' ? 'text-red-500' : 'text-[var(--sera-muted)]/70'}`}>
                  {orgCodeStatus === 'ready' ? <CheckCircle2 className="w-3 h-3" /> : orgCodeStatus === 'generating' ? <Loader2 className="w-3 h-3 animate-spin" /> : <AlertCircle className="w-3 h-3" />}
                  Code
                </span>
                <span className={`flex items-center gap-1 ${formData.org_name.trim() ? 'text-green-600' : 'text-[var(--sera-muted)]/70'}`}>
                  {formData.org_name.trim() ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                  Name
                </span>
                {isParentRequired(formData.org_type_code as OrgType) && (
                  <span className={`flex items-center gap-1 ${formData.parent_org_id ? 'text-green-600' : 'text-[var(--sera-muted)]/70'}`}>
                    {formData.parent_org_id ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                    Parent
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Form Actions */}
        <div className="flex justify-end gap-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onViewChange('organizations')}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={loading || orgCodeStatus === 'generating' || orgCodeStatus === 'error'}
            className="bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white"
            title={orgCodeStatus === 'error' ? 'Fix the organization code error first' : undefined}
          >
            <Save className="w-4 h-4 mr-2" />
            {loading ? 'Creating...' : 'Create Organization'}
          </Button>
        </div>
      </form>
        </TabsContent>
      </Tabs>
    </div>
  )
}
