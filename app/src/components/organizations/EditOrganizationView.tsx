'use client'

import { useState, useEffect } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { useToast } from '@/components/ui/use-toast'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, ArrowLeft, Save, Info, AlertTriangle, Star, Link as LinkIcon, Store } from 'lucide-react'
import OrgLogoUpload from './OrgLogoUpload'
import DistributorOrderFulfillmentCard from './DistributorOrderFulfillmentCard'
import OnlineShopWarehouseCard from './OnlineShopWarehouseCard'
import ManufacturerCategoriesCard from './ManufacturerCategoriesCard'
import { compressAvatar, formatFileSize } from '@/lib/utils/imageCompression'
import {
  getOwnedOrganizationLogoPath,
  normalizePersistedOrganizationLogo,
  persistedOrganizationLogoMatches,
} from '@/lib/organizations/logo'
import {
  getValidParentOrgs,
  isParentRequired,
  getParentHelpText,
  getParentFieldLabel,
  parseHierarchyError,
  validateOrgHierarchy,
  type OrgType
} from '@/lib/utils/orgHierarchy'
import type { Organization, OrganizationFormData } from '@/lib/types/organization'

interface EditOrganizationViewProps {
  userProfile: {
    id: string
    organization_id: string
  }
  onViewChange?: (view: string) => void
}

interface ParentOrganization {
  id: string
  org_code: string
  org_name: string
  org_type_code: string
  is_active?: boolean | null
  default_warehouse_org_id?: string | null
}

interface StateOption {
  id: string
  state_code: string
  state_name: string
}

interface DistrictOption {
  id: string
  district_code: string
  district_name: string
  state_id: string
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

export default function EditOrganizationView({ userProfile, onViewChange }: EditOrganizationViewProps) {
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [formData, setFormData] = useState<OrganizationFormData>({})
  const [parentOrgs, setParentOrgs] = useState<ParentOrganization[]>([])
  const [filteredParentOrgs, setFilteredParentOrgs] = useState<ParentOrganization[]>([])
  const [states, setStates] = useState<StateOption[]>([])
  const [districts, setDistricts] = useState<DistrictOption[]>([])
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerm[]>([])
  const [childOrgs, setChildOrgs] = useState<any[]>([])
  const [shopDistributors, setShopDistributors] = useState<any[]>([])
  const [orgUsers, setOrgUsers] = useState<any[]>([])
  const [authError, setAuthError] = useState<string | null>(null)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoRemoved, setLogoRemoved] = useState(false)
  const [logoError, setLogoError] = useState('')
  const [parentHqDetails, setParentHqDetails] = useState<ParentOrganization | null>(null)
  const [siblingWarehouses, setSiblingWarehouses] = useState<ParentOrganization[]>([])
  const [fulfillmentCardKey, setFulfillmentCardKey] = useState(0)
  const { isReady, supabase, error: authHookError } = useSupabaseAuth()
  const { toast } = useToast()

  useEffect(() => {
    // Handle auth errors from the hook
    if (authHookError) {
      setAuthError(authHookError)
      if (authHookError.includes('Session expired')) {
        setTimeout(() => {
          window.location.href = '/login'
        }, 2000)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authHookError])

  useEffect(() => {
    if (isReady) {
      loadStates()
      loadPaymentTerms()
      const orgId = sessionStorage.getItem('selectedOrgId')
      if (orgId) {
        loadOrganization(orgId)
        loadParentOrganizations()
        loadChildOrganizations(orgId)
        loadShopDistributors(orgId)
        loadOrganizationUsers(orgId)
      } else {
        // No org selected, go back to organizations
        onViewChange?.('organizations')
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  // Filter parent organizations when org type changes
  useEffect(() => {
    if (formData.org_type_code) {
      const validParents = getValidParentOrgs(
        formData.org_type_code as OrgType,
        parentOrgs as any[]
      )
      setFilteredParentOrgs(validParents as ParentOrganization[])

      // Clear parent_org_id if current selection is not valid
      if (formData.parent_org_id) {
        const isValid = validParents.some(p => p.id === formData.parent_org_id)
        if (!isValid) {
          handleInputChange('parent_org_id', null)
        }
      }

      // For HQ, always clear parent
      if (formData.org_type_code === 'HQ') {
        handleInputChange('parent_org_id', null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.org_type_code, parentOrgs])

  useEffect(() => {
    if (formData.state_id) {
      loadDistrictsForState(formData.state_id)
    } else {
      setDistricts([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.state_id])

  // Deep-link support: when the URL carries #contact-information (e.g. opened from
  // the Return Product "Edit Shop Contact" shortcut), scroll to that section once
  // the organization has finished loading.
  useEffect(() => {
    if (loading || organization === null) return
    if (typeof window === 'undefined') return
    if (window.location.hash !== '#contact-information') return
    const t = setTimeout(() => {
      document.getElementById('contact-information')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 150)
    return () => clearTimeout(t)
  }, [loading, organization])

  const loadParentOrganizations = async () => {
    try {
      const { data, error } = await supabase
        .from('organizations')
        .select('id, org_code, org_name, org_type_code, is_active, default_warehouse_org_id')
        .eq('is_active', true)
        .order('org_name')

      if (error) throw error
      setParentOrgs(data || [])
    } catch (error) {
      console.error('Error loading parent organizations:', error)
    }
  }

  const loadParentHqContext = async (org: Organization) => {
    if (org.org_type_code !== 'WH' || !org.parent_org_id) {
      setParentHqDetails(null)
      setSiblingWarehouses([])
      return
    }

    try {
      const [{ data: parent, error: parentError }, { data: siblings, error: siblingError }] = await Promise.all([
        supabase
          .from('organizations')
          .select('id, org_code, org_name, org_type_code, is_active, default_warehouse_org_id')
          .eq('id', org.parent_org_id)
          .maybeSingle(),
        supabase
          .from('organizations')
          .select('id, org_code, org_name, org_type_code, is_active, default_warehouse_org_id')
          .eq('parent_org_id', org.parent_org_id)
          .eq('org_type_code', 'WH')
          .eq('is_active', true)
          .order('org_name'),
      ])
      if (parentError) throw parentError
      if (siblingError) throw siblingError
      setParentHqDetails((parent as ParentOrganization | null) || null)
      setSiblingWarehouses((siblings || []) as ParentOrganization[])
    } catch (error) {
      console.error('Error loading parent HQ fulfillment context:', error)
      setParentHqDetails(null)
      setSiblingWarehouses([])
    }
  }

  const loadPaymentTerms = async () => {
    try {
      const { data, error } = await supabase
        .from('payment_terms')
        .select('*')
        .eq('is_active', true)
        .order('sort_order')

      if (error) throw error
      setPaymentTerms(data || [])
    } catch (error) {
      console.error('Error loading payment terms:', error)
    }
  }

  const loadChildOrganizations = async (orgId: string) => {
    try {
      const { data, error } = await supabase
        .from('organizations')
        .select('id, org_code, org_name, org_type_code')
        .eq('parent_org_id', orgId)

      if (error) throw error
      setChildOrgs(data || [])
    } catch (error) {
      console.error('Error loading child organizations:', error)
    }
  }

  const loadShopDistributors = async (orgId: string) => {
    try {
      // Only load for SHOP organizations
      const { data: orgData } = await (supabase as any)
        .from('organizations')
        .select('org_type_code')
        .eq('id', orgId)
        .single()

      if (orgData?.org_type_code === 'SHOP') {
        const { data, error } = await (supabase as any)
          .from('shop_distributors')
          .select(`
            *,
            distributor:organizations!shop_distributors_distributor_id_fkey(
              id,
              org_name,
              org_code
            )
          `)
          .eq('shop_id', orgId)
          .eq('is_active', true)
          .order('is_preferred', { ascending: false })

        if (error) throw error

        const transformed = (data || []).map((sd: any) => ({
          ...sd,
          distributor: Array.isArray(sd.distributor) ? sd.distributor[0] : sd.distributor
        }))

        setShopDistributors(transformed)
      }
    } catch (error) {
      console.error('Error loading shop distributors:', error)
    }
  }

  const loadOrganizationUsers = async (orgId: string) => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select(`
          id,
          email,
          full_name,
          phone,
          is_active,
          roles:role_code (
            role_name,
            role_level
          )
        `)
        .eq('organization_id', orgId)
        .eq('is_active', true)
        .order('full_name', { ascending: true })

      if (error) throw error

      console.log('📊 Loaded organization users:', data?.length)
      setOrgUsers(data || [])
    } catch (error) {
      console.error('Error loading organization users:', error)
    }
  }

  const loadStates = async () => {
    try {
      const { data, error } = await supabase
        .from('states')
        .select('id, state_code, state_name')
        .eq('is_active', true)
        .order('state_name', { ascending: true })

      if (error) throw error
      setStates(data || [])
    } catch (error) {
      console.error('Error loading states:', error)
      setStates([])
    }
  }

  const loadDistrictsForState = async (stateId: string) => {
    try {
      const { data, error } = await supabase
        .from('districts')
        .select('id, district_code, district_name, state_id')
        .eq('state_id', stateId)
        .eq('is_active', true)
        .order('district_name', { ascending: true })

      if (error) throw error
      setDistricts(data || [])
    } catch (error) {
      console.error('Error loading districts:', error)
      setDistricts([])
    }
  }

  const loadOrganization = async (orgId: string) => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', orgId)
        .single()

      if (error) throw error

      if (data?.state_id) {
        await loadDistrictsForState(data.state_id)
      }

      const loaded = data as Organization
      setOrganization(loaded)
      setFormData(loaded)
      await loadParentHqContext(loaded)
    } catch (error) {
      console.error('Error loading organization:', error)
      toast({
        title: '✕ Load Failed',
        description: 'Could not load organization details',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  const handleInputChange = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }))
  }

  const handleLogoChange = (file: File | null) => {
    setLogoFile(file)
    if (file) setLogoRemoved(false)
    if (file && !file.type.startsWith('image/')) {
      setLogoError('Please select an image file')
    } else if (file && file.size > 5 * 1024 * 1024) {
      setLogoError('Image must be less than 5MB')
    } else {
      setLogoError('')
    }
  }

  const handleLogoRemove = () => {
    setLogoFile(null)
    setLogoRemoved(true)
    setLogoError('')
  }

  const handleSave = async () => {
    let uploadedLogoPath: string | null = null

    try {
      setSaving(true)

      if (logoError) {
        throw new Error(logoError)
      }

      // Validate required parent_org_id for organizations that need it
      if (isParentRequired(formData.org_type_code as OrgType || organization?.org_type_code as OrgType)) {
        if (!formData.parent_org_id) {
          toast({
            title: '✕ Validation Error',
            description: `${getParentFieldLabel(formData.org_type_code as OrgType || organization?.org_type_code as OrgType)} is required`,
            variant: 'destructive'
          })
          setSaving(false)
          return
        }
      }

      // Upload logo if a new file is provided
      let logo_url = logoRemoved ? null : normalizePersistedOrganizationLogo(formData.logo_url)

      if (logoFile) {
        // Compress logo first
        const compressionResult = await compressAvatar(logoFile)

        toast({
          title: '🖼️ Logo Compressed',
          description: `${formatFileSize(compressionResult.originalSize)} → ${formatFileSize(compressionResult.compressedSize)} (${compressionResult.compressionRatio.toFixed(1)}% smaller)`,
        })

        const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`
        const filePath = `${organization!.id}/${fileName}`

        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(filePath, compressionResult.file, {
            contentType: compressionResult.file.type,
            cacheControl: '3600',
            upsert: false
          })

        if (uploadError) {
          throw new Error(`Logo upload failed: ${uploadError.message}`)
        }

        uploadedLogoPath = filePath
        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(filePath)
        logo_url = normalizePersistedOrganizationLogo(publicUrl)

        if (!logo_url) {
          throw new Error('Storage upload succeeded but did not return a valid logo URL')
        }
      }

      // Build update payload - only include fields that exist in formData
      const updatePayload: Record<string, any> = {
        updated_at: new Date().toISOString()
      }

      // if (userProfile?.id) {
      //   updatePayload.updated_by = userProfile.id
      // }

      // Only include fields that are actually in the form
      if (formData.org_name !== undefined) updatePayload.org_name = formData.org_name
      if (formData.contact_name !== undefined) updatePayload.contact_name = formData.contact_name || null
      if (formData.contact_title !== undefined) updatePayload.contact_title = formData.contact_title || null
      if (formData.contact_phone !== undefined) updatePayload.contact_phone = formData.contact_phone || null
      if (formData.contact_email !== undefined) updatePayload.contact_email = formData.contact_email || null
      if (formData.address !== undefined) updatePayload.address = formData.address || null
      if (formData.address_line2 !== undefined) updatePayload.address_line2 = formData.address_line2 || null
      if (formData.city !== undefined) updatePayload.city = formData.city || null
      if (formData.state_id !== undefined) updatePayload.state_id = formData.state_id || null
      if (formData.district_id !== undefined) updatePayload.district_id = formData.district_id || null
      if (formData.postal_code !== undefined) updatePayload.postal_code = formData.postal_code || null
      if (formData.country_code !== undefined) updatePayload.country_code = formData.country_code || null
      if (formData.website !== undefined) updatePayload.website = formData.website || null
      if (logo_url !== undefined) updatePayload.logo_url = logo_url
      if (formData.payment_term_id !== undefined) updatePayload.payment_term_id = formData.payment_term_id || null
      if (formData.warranty_bonus !== undefined) updatePayload.warranty_bonus = formData.warranty_bonus
      if (formData.signature_type !== undefined) updatePayload.signature_type = formData.signature_type
      if (formData.signature_url !== undefined) updatePayload.signature_url = formData.signature_url
      if (formData.is_active !== undefined && formData.is_active !== organization?.is_active) {
        const deactivating = organization?.is_active === true && formData.is_active === false
        const isDefaultFulfillmentWarehouse = Boolean(
          organization?.org_type_code === 'WH'
          && parentHqDetails?.org_type_code === 'HQ'
          && parentHqDetails.default_warehouse_org_id === organization.id
        )
        if (deactivating && isDefaultFulfillmentWarehouse) {
          const replacements = siblingWarehouses.filter((warehouse) => warehouse.id !== organization.id)
          toast({
            title: 'Cannot deactivate default warehouse',
            description: replacements.length > 0
              ? 'Set another active HQ warehouse as the default fulfillment warehouse before deactivating this one.'
              : 'This is the only active HQ warehouse and is currently the default. Configure another active warehouse as default before deactivation.',
            variant: 'destructive',
          })
          setSaving(false)
          return
        }
        updatePayload.is_active = formData.is_active
      }

      // Shop-specific fields
      if (organization?.org_type_code === 'SHOP') {
        if ((formData as any).branch !== undefined) updatePayload.branch = (formData as any).branch || null
        if ((formData as any).sells_serapod_flavour !== undefined) updatePayload.sells_serapod_flavour = !!(formData as any).sells_serapod_flavour
        if ((formData as any).sells_sbox !== undefined) updatePayload.sells_sbox = !!(formData as any).sells_sbox
        if ((formData as any).sells_sbox_special_edition !== undefined) updatePayload.sells_sbox_special_edition = !!(formData as any).sells_sbox_special_edition
        if ((formData as any).hot_flavour_brands !== undefined) updatePayload.hot_flavour_brands = (formData as any).hot_flavour_brands || null
      }

      // Handle parent_org_id - include if changed OR if org type requires parent and it's missing
      const needsParent = isParentRequired(organization?.org_type_code as OrgType)
      const parentChanged = formData.parent_org_id !== undefined && formData.parent_org_id !== organization?.parent_org_id
      const parentMissing = needsParent && !organization?.parent_org_id && formData.parent_org_id

      if (parentChanged || parentMissing) {
        // Validate hierarchy when parent is being changed or added
        const parentOrg = formData.parent_org_id
          ? parentOrgs.find(p => p.id === formData.parent_org_id)
          : undefined

        const hierarchyError = validateOrgHierarchy(
          organization?.org_type_code as OrgType,
          formData.parent_org_id || null,
          parentOrg?.org_type_code as OrgType | undefined
        )

        if (hierarchyError) {
          toast({
            title: '✕ Invalid Hierarchy',
            description: hierarchyError,
            variant: 'destructive'
          })
          setSaving(false)
          return
        }

        updatePayload.parent_org_id = formData.parent_org_id || null
      }

      const response = await (supabase as any)
        .from('organizations')
        .update(updatePayload)
        .eq('id', organization!.id)
        .select('*')
        .single()

      const { error, data } = response

      console.log('📊 Update response:', {
        hasError: !!error,
        hasData: !!data,
        persistedLogoUrl: data?.logo_url,
        updatePayload
      })

      if (error) {
        // Log the error in multiple ways to ensure we capture all details
        console.error('❌ Supabase update error:')
        console.error('Error object:', error)
        console.error('Error message:', error?.message)
        console.error('Error code:', error?.code)
        console.error('Error details:', error?.details)
        console.error('Error hint:', error?.hint)
        console.error('Update payload:', updatePayload)
        console.error('Full response:', response)
        throw error
      }

      if (!data) {
        throw new Error('Update succeeded but no data was returned. This may indicate an RLS policy issue.')
      }

      if (!persistedOrganizationLogoMatches(data.logo_url, logo_url)) {
        throw new Error('Organization was updated, but the persisted logo value could not be confirmed')
      }

      const persistedNewLogoPath = uploadedLogoPath
      uploadedLogoPath = null
      const previousLogoPath = getOwnedOrganizationLogoPath(organization?.logo_url, organization!.id)
      const persistedOrganization = data as Organization
      setOrganization(persistedOrganization)
      setFormData(persistedOrganization)
      setLogoFile(null)
      setLogoRemoved(false)

      // Remove the prior object only after the database points to the new value (or null).
      if ((logoFile || logoRemoved) && previousLogoPath && previousLogoPath !== persistedNewLogoPath) {
        const { error: removeError } = await supabase.storage.from('avatars').remove([previousLogoPath])
        if (removeError) {
          console.warn('Organization logo was saved, but the previous storage object could not be removed:', removeError)
        }
      }

      // Auto-repair: If this is a SHOP with a DIST parent, ensure shop_distributors entry exists
      if (organization?.org_type_code === 'SHOP' && updatePayload.parent_org_id) {
        const parentOrg = parentOrgs.find(p => p.id === updatePayload.parent_org_id)
        if (parentOrg?.org_type_code === 'DIST') {
          // Check if shop_distributors entry exists for this shop-distributor pair
          const { data: existing, error: checkError } = await (supabase as any)
            .from('shop_distributors')
            .select('id')
            .eq('shop_id', organization.id)
            .eq('distributor_id', updatePayload.parent_org_id)
            .maybeSingle()

          if (!checkError && !existing) {
            // Check if another preferred distributor already exists for this shop
            const { data: existingPreferred, error: prefCheckError } = await (supabase as any)
              .from('shop_distributors')
              .select('id, distributor_id')
              .eq('shop_id', organization.id)
              .eq('is_preferred', true)
              .maybeSingle()

            // Only set is_preferred if no other preferred entry exists
            const shouldBePreferred = !prefCheckError && !existingPreferred

            console.log('🔧 Auto-repair: Creating missing shop_distributors entry...')
            const { error: linkError } = await (supabase as any)
              .from('shop_distributors')
              .insert([{
                shop_id: organization.id,
                distributor_id: updatePayload.parent_org_id,
                payment_terms: 'NET_30',
                is_active: true,
                is_preferred: shouldBePreferred,
                created_by: userProfile.id
              }])

            if (!linkError) {
              console.log('✅ Auto-repair: shop_distributors entry created successfully')
            } else {
              console.error('❌ Auto-repair failed:', linkError)
            }
          }
        }
      }

      toast({
        title: '✓ Saved Successfully',
        description: `${formData.org_name || organization?.org_name || 'Organization'} has been updated`,
        variant: 'success'
      })

      // Set flag to refresh links and go back to organizations
      sessionStorage.setItem('needsLinkRefresh', 'true')

      // Go back to organizations
      setTimeout(() => {
        onViewChange?.('organizations')
      }, 500)
    } catch (error: any) {
      if (uploadedLogoPath) {
        const { error: cleanupError } = await supabase.storage.from('avatars').remove([uploadedLogoPath])
        if (cleanupError) console.warn('Could not clean up unpersisted organization logo:', cleanupError)
      }
      console.error('❌ Error saving organization:')
      console.error('Error type:', typeof error)
      console.error('Error constructor:', error?.constructor?.name)
      console.error('Error object:', error)
      console.error('Error message:', error?.message || 'No message')
      console.error('Error code:', error?.code)
      console.error('Error details:', error?.details)
      console.error('Error hint:', error?.hint)
      console.error('Error stack:', error?.stack)

      let friendlyError = parseHierarchyError(error)

      // If a friendly email message was embedded by parseHierarchyError, enrich it
      // by querying the conflicting org name/code when we have a contact_email
      // and the error looks like an email conflict we generated.
      if (
        error?.code === '23505' &&
        error?.message?.includes('uq_orgs_contact_email') &&
        formData.contact_email
      ) {
        try {
          const { data: conflictOrg } = await (supabase as any)
            .from('organizations')
            .select('org_name, org_code')
            .eq('contact_email', formData.contact_email)
            .neq('id', organization!.id)
            .limit(1)
            .maybeSingle()

          if (conflictOrg) {
            friendlyError = `This email is already used by ${conflictOrg.org_name} (${conflictOrg.org_code}). Please use another email.`
          }
        } catch (_) {
          // Keep the already-resolved friendly message if the lookup fails
        }
      }

      toast({
        title: '✕ Save Failed',
        description: friendlyError,
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 text-[var(--sera-orange)] animate-spin" />
      </div>
    )
  }

  // Show auth error if present
  if (authError) {
    return (
      <Card className="border-red-200">
        <CardContent className="p-12 text-center">
          <AlertTriangle className="w-12 h-12 text-red-600 mx-auto mb-4" />
          <p className="text-red-600 font-medium mb-2">{authError}</p>
          <p className="text-[var(--sera-muted)] mb-4">Your session may have expired. Please log in again.</p>
          <Button
            onClick={() => window.location.href = '/login'}
            className="bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white"
          >
            Go to Login
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!organization) {
    return (
      <Card className="sera-sc-panel overflow-hidden shadow-none">
        <CardContent className="p-12 text-center">
          <p className="text-[var(--sera-muted)]">Organization not found</p>
          <Button
            onClick={() => onViewChange?.('organizations')}
            className="mt-4"
          >
            Back to Organizations
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="sera-sc-page space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-4 mb-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onViewChange?.('organizations')}
              className="pl-0"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </div>
          <h2 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">{organization.org_name}</h2>
          <p className="text-[var(--sera-muted)]">{organization.org_code} • {organization.org_type_code}</p>
        </div>
        <Button
          onClick={handleSave}
          disabled={saving}
          className="bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white"
        >
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              Save Changes
            </>
          )}
        </Button>
      </div>

      {/* Organization Details Form */}
      <Card className="sera-sc-panel overflow-hidden shadow-none">
        <CardHeader>
          <CardTitle>Organization Information</CardTitle>
          <CardDescription>Edit basic organization details</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Logo Upload */}
          <OrgLogoUpload
            currentLogoUrl={organization.logo_url}
            orgName={organization.org_name}
            onLogoChange={handleLogoChange}
            onLogoRemove={handleLogoRemove}
            onError={setLogoError}
            error={logoError}
          />

          {/* Warning if child organizations exist */}
          {childOrgs.length > 0 && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                This organization has {childOrgs.length} child organization(s). Changing the parent may affect the organizational structure.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="org_name">Organization Name</Label>
              <Input
                id="org_name"
                value={formData.org_name || ''}
                onChange={(e) => handleInputChange('org_name', e.target.value)}
                placeholder="Enter organization name"
                className={!formData.org_name ? 'placeholder:text-gray-300' : ''}
              />
              {!formData.org_name && (
                <p className="text-xs text-[var(--sera-muted)]/80 italic">Required - enter the organization name</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                type="url"
                value={formData.website || ''}
                onChange={(e) => handleInputChange('website', e.target.value)}
                placeholder="Enter website URL"
                className={!formData.website ? 'placeholder:text-gray-300' : ''}
              />
              {!formData.website && (
                <p className="text-xs text-[var(--sera-muted)]/80 italic">e.g., https://example.com</p>
              )}
            </div>
          </div>

          {/* Parent Organization - conditional rendering based on type */}
          {formData.org_type_code && formData.org_type_code !== 'HQ' && (
            <div className="space-y-2">
              <Label htmlFor="parent_org_id">
                {getParentFieldLabel(formData.org_type_code as OrgType)}
                {isParentRequired(formData.org_type_code as OrgType) && ' *'}
              </Label>

              {/* Help text showing hierarchy rules */}
              <Alert className="mb-2">
                <Info className="h-4 w-4" />
                <AlertDescription>
                  {getParentHelpText(formData.org_type_code as OrgType)}
                </AlertDescription>
              </Alert>

              <Select
                value={formData.parent_org_id || 'none'}
                onValueChange={(value) => handleInputChange('parent_org_id', value === 'none' ? null : value)}
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
                  {filteredParentOrgs
                    .filter(org => org.id !== organization?.id) // Exclude self
                    .map((org) => (
                      <SelectItem key={org.id} value={org.id}>
                        {org.org_name} ({org.org_code})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {organization?.org_type_code === 'WH' && parentHqDetails?.org_type_code === 'HQ' && (
            <DistributorOrderFulfillmentCard
              key={`${organization.id}:${fulfillmentCardKey}`}
              warehouse={{
                id: organization.id,
                org_name: formData.org_name || organization.org_name,
                org_type_code: organization.org_type_code,
                parent_org_id: formData.parent_org_id || organization.parent_org_id,
                is_active: formData.is_active ?? organization.is_active ?? true,
              }}
              parentHq={parentHqDetails}
              onDefaultChanged={async () => {
                await loadParentHqContext({
                  ...organization,
                  parent_org_id: formData.parent_org_id || organization.parent_org_id,
                })
                setFulfillmentCardKey((value) => value + 1)
              }}
            />
          )}

          {organization?.org_type_code === 'WH' && parentHqDetails?.org_type_code === 'HQ' && (
            <OnlineShopWarehouseCard
              key={`shop:${organization.id}:${fulfillmentCardKey}`}
              warehouse={{
                id: organization.id,
                org_name: formData.org_name || organization.org_name,
                is_active: formData.is_active ?? organization.is_active ?? true,
              }}
              parentHq={{ id: parentHqDetails.id, org_name: parentHqDetails.org_name }}
            />
          )}

          {organization?.org_type_code === 'MFG' && (
            <ManufacturerCategoriesCard
              manufacturer={{ id: organization.id, org_name: formData.org_name || organization.org_name }}
            />
          )}

          {organization?.org_type_code === 'WH' && (
            <div className="flex items-center gap-3 rounded-md border border-border px-3 py-3">
              <input
                id="is_active"
                type="checkbox"
                className="h-4 w-4"
                checked={formData.is_active !== false}
                onChange={(e) => handleInputChange('is_active', e.target.checked)}
              />
              <div>
                <Label htmlFor="is_active" className="mb-0">Warehouse is active</Label>
                <p className="text-xs text-muted-foreground">
                  The default fulfillment warehouse cannot be deactivated until another active HQ warehouse is set as default.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="address">Address</Label>
            <Textarea
              id="address"
              value={formData.address || ''}
              onChange={(e) => handleInputChange('address', e.target.value)}
              placeholder="Enter street address"
              rows={2}
              className={!formData.address ? 'placeholder:text-gray-300' : ''}
            />
            {!formData.address && (
              <p className="text-xs text-[var(--sera-muted)]/80 italic">Please enter the street address</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="address_line2">Address Line 2</Label>
            <Textarea
              id="address_line2"
              value={formData.address_line2 || ''}
              onChange={(e) => handleInputChange('address_line2', e.target.value)}
              placeholder="Apartment, suite, building (optional)"
              rows={2}
              className={!formData.address_line2 ? 'placeholder:text-gray-300' : ''}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                value={formData.city || ''}
                onChange={(e) => handleInputChange('city', e.target.value)}
                placeholder="Enter city"
                className={!formData.city ? 'placeholder:text-gray-300' : ''}
              />
              {!formData.city && (
                <p className="text-xs text-[var(--sera-muted)]/80 italic">Enter city name</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="postal_code">Postal Code</Label>
              <Input
                id="postal_code"
                value={formData.postal_code || ''}
                onChange={(e) => handleInputChange('postal_code', e.target.value)}
                placeholder="Enter postal code"
                className={!formData.postal_code ? 'placeholder:text-gray-300' : ''}
              />
              {!formData.postal_code && (
                <p className="text-xs text-[var(--sera-muted)]/80 italic">Enter postal code</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="state_id">State</Label>
              <Select
                value={formData.state_id || 'none'}
                onValueChange={(value) => {
                  if (value === 'none') {
                    handleInputChange('state_id', '')
                    handleInputChange('district_id', '')
                  } else {
                    handleInputChange('state_id', value)
                    handleInputChange('district_id', null)
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

            <div className="space-y-2">
              <Label htmlFor="district_id">District</Label>
              <Select
                value={formData.district_id || 'none'}
                onValueChange={(value) => handleInputChange('district_id', value === 'none' ? '' : value)}
                disabled={!formData.state_id}
              >
                <SelectTrigger>
                  <SelectValue placeholder={formData.state_id ? 'Select district' : 'None (Not defined)'} />
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
              {!formData.state_id && (
                <p className="text-xs text-[var(--sera-muted)]/80 italic">Select a state to view districts</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="country_code">Country</Label>
            <Input
              id="country_code"
              value={formData.country_code || ''}
              onChange={(e) => handleInputChange('country_code', e.target.value)}
              placeholder="Enter country code"
              className={!formData.country_code ? 'placeholder:text-gray-300' : ''}
            />
            {!formData.country_code && (
              <p className="text-xs text-[var(--sera-muted)]/80 italic">e.g., MY, US, UK</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Linked Distributors Section (for SHOP organizations) */}
      {organization.org_type_code === 'SHOP' && shopDistributors.length > 0 && (
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <LinkIcon className="w-5 h-5 text-[var(--sera-orange)]" />
                  Linked Distributors
                </CardTitle>
                <CardDescription>
                  Distributor relationships for this shop
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {shopDistributors.map((sd) => (
              <div
                key={sd.id}
                className={`flex justify-between items-center p-4 border rounded-lg ${sd.is_preferred ? 'border-amber-300 bg-amber-50' : 'border-[var(--sera-line)]'
                  }`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center flex-shrink-0">
                    <LinkIcon className="w-5 h-5 text-green-600" />
                  </div>
                  <div>
                    <p className="font-medium text-[var(--sera-ink)]">{sd.distributor?.org_name}</p>
                    <p className="text-sm text-[var(--sera-muted)]">{sd.distributor?.org_code}</p>
                    <div className="flex gap-2 mt-1">
                      {sd.payment_terms && (
                        <span className="text-xs text-[var(--sera-muted)] bg-gray-100 px-2 py-0.5 rounded">
                          {sd.payment_terms}
                        </span>
                      )}
                      {sd.account_number && (
                        <span className="text-xs text-[var(--sera-muted)]">
                          Account: {sd.account_number}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {sd.is_preferred && (
                  <div className="flex items-center gap-2 text-amber-700">
                    <Star className="w-4 h-4 fill-current" />
                    <span className="text-sm font-medium">Default</span>
                  </div>
                )}
              </div>
            ))}
            <div className="pt-2">
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  To manage distributor relationships, close this page and click the &quot;Distributors&quot; button on the organization card.
                </AlertDescription>
              </Alert>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Shop Information - Only show for SHOP organizations */}
      {organization.org_type_code === 'SHOP' && (
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Store className="w-5 h-5 text-orange-600" />
              Shop Information
            </CardTitle>
            <CardDescription>Shop-specific details from field survey</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="branch">Branch</Label>
                <Input
                  id="branch"
                  value={(formData as any).branch || ''}
                  onChange={(e) => handleInputChange('branch', e.target.value)}
                  placeholder="Branch name or location variant"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="hot_flavour_brands">Hot Flavour Brands</Label>
                <Input
                  id="hot_flavour_brands"
                  value={(formData as any).hot_flavour_brands || ''}
                  onChange={(e) => handleInputChange('hot_flavour_brands', e.target.value)}
                  placeholder="Comma-separated brand names"
                />
                <p className="text-xs text-[var(--sera-muted)]">e.g. Brand A, Brand B</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Sells Flavour Serapod</Label>
                <Select
                  value={(formData as any).sells_serapod_flavour ? 'true' : 'false'}
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

              <div className="space-y-2">
                <Label>Sells S.Box</Label>
                <Select
                  value={(formData as any).sells_sbox ? 'true' : 'false'}
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

              <div className="space-y-2">
                <Label>Sells S.Box Special Edition</Label>
                <Select
                  value={(formData as any).sells_sbox_special_edition ? 'true' : 'false'}
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

      {/* Payment Terms & Warranty Bonus - Only show for manufacturers, distributors, and shops */}
      {(formData.org_type_code === 'MFG' || formData.org_type_code === 'DIST' || formData.org_type_code === 'SHOP') && (
        <Card className="sera-sc-panel overflow-hidden shadow-none">
          <CardHeader>
            <CardTitle>Payment Terms & Warranty Bonus</CardTitle>
            <CardDescription>Configure financial terms for orders</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
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

              <div>
                <Label htmlFor="warranty_bonus">Warranty Bonus</Label>
                <div className="relative mt-1">
                  <Input
                    id="warranty_bonus"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={formData.warranty_bonus || ''}
                    onChange={(e) => handleInputChange('warranty_bonus', e.target.value ? parseFloat(e.target.value) : null)}
                    placeholder="0"
                    className="pr-8"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--sera-muted)]">%</span>
                </div>
                <p className="text-sm text-[var(--sera-muted)] mt-2">
                  Set the warranty bonus percentage for this organization. This will be used for future calculations.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Contact Information */}
      <Card id="contact-information" className="scroll-mt-24">
        <CardHeader>
          <CardTitle>Contact Information</CardTitle>
          <CardDescription>Primary contact details for this organization</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="contact_name">Contact Name</Label>
              <Input
                id="contact_name"
                value={formData.contact_name || ''}
                onChange={(e) => handleInputChange('contact_name', e.target.value)}
                placeholder="Enter contact person name"
                className={!formData.contact_name ? 'placeholder:text-gray-300' : ''}
              />
              {!formData.contact_name && (
                <p className="text-xs text-[var(--sera-muted)]/80 italic">Please enter the contact person&apos;s name</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="contact_title">Contact Title</Label>
              <Input
                id="contact_title"
                value={formData.contact_title || ''}
                onChange={(e) => handleInputChange('contact_title', e.target.value)}
                placeholder="Enter job title (e.g., Manager, Director)"
                className={!formData.contact_title ? 'placeholder:text-gray-300' : ''}
              />
              {!formData.contact_title && (
                <p className="text-xs text-[var(--sera-muted)]/80 italic">Enter the contact person&apos;s job title</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="contact_email">Contact Email</Label>
              <Input
                id="contact_email"
                type="email"
                value={formData.contact_email || ''}
                onChange={(e) => handleInputChange('contact_email', e.target.value)}
                placeholder="Enter email (e.g., contact@example.com)"
                className={!formData.contact_email ? 'placeholder:text-gray-300' : ''}
              />
              {!formData.contact_email && (
                <p className="text-xs text-[var(--sera-muted)]/80 italic">Please enter the contact email address</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="contact_phone">Contact Phone</Label>
              <Input
                id="contact_phone"
                value={formData.contact_phone || ''}
                onChange={(e) => handleInputChange('contact_phone', e.target.value)}
                placeholder="Enter phone (e.g., +60123456789)"
                className={!formData.contact_phone ? 'placeholder:text-gray-300' : ''}
              />
              {!formData.contact_phone && (
                <p className="text-xs text-[var(--sera-muted)]/80 italic">Please enter the contact phone number</p>
              )}
            </div>
          </div>

          {/* Organization Users List - Show when there are 2 or more users */}
          {orgUsers.length >= 2 && (
            <div className="mt-6 pt-6 border-t border-[var(--sera-line)]">
              <div className="mb-4">
                <h4 className="text-sm font-semibold text-[var(--sera-ink)]">
                  Organization Users ({orgUsers.length})
                </h4>
                <p className="text-xs text-[var(--sera-muted)] mt-1">
                  All active users belonging to this organization
                </p>
              </div>

              <div className="space-y-3">
                {orgUsers.map((user: any) => (
                  <div
                    key={user.id}
                    className="flex items-start gap-4 p-3 bg-[var(--sera-ink)]/[0.02] rounded-lg border border-[var(--sera-line)] hover:bg-[var(--sera-ink)]/[0.04] transition-colors"
                  >
                    <div className="flex-shrink-0">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[var(--sera-orange)] to-[var(--sera-orange-deep)] flex items-center justify-center text-white font-medium text-sm">
                        {user.full_name ? user.full_name.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2) : 'U'}
                      </div>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-medium text-[var(--sera-ink)] truncate">
                          {user.full_name || 'No Name'}
                        </p>
                        {user.roles && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)]">
                            {Array.isArray(user.roles) ? user.roles[0]?.role_name : user.roles?.role_name}
                          </span>
                        )}
                      </div>

                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2 text-xs text-[var(--sera-muted)]">
                          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                          </svg>
                          <span className="truncate">{user.email}</span>
                        </div>

                        {user.phone && (
                          <div className="flex items-center gap-2 text-xs text-[var(--sera-muted)]">
                            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                            </svg>
                            <span>{user.phone}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Save Button - Bottom */}
      <div className="flex gap-4">
        <Button
          variant="outline"
          onClick={() => onViewChange?.('organizations')}
          className="flex-1"
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white"
        >
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              Save Changes
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
