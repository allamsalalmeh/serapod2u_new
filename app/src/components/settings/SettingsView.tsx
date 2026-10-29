'use client'

import { useState, useEffect, useRef } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { usePermissions } from '@/hooks/usePermissions'
import { useTheme } from '@/components/providers/ThemeProvider'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tabs as TabsComponent, TabsList as TabsList2, TabsTrigger as TabsTrigger2, TabsContent as TabsContent2 } from '@/components/ui/tabs'
import { toast } from '@/components/ui/use-toast'
import { Badge } from '@/components/ui/badge'
import DangerZoneTab from './DangerZoneTab'
import NotificationTypesTab from './NotificationTypesTab'
import NotificationProvidersTab from './NotificationProvidersTab'
import { MessagingChannelsSettingsCard } from './MessagingChannelsSettingsCard'
import DocumentTemplateTab from './DocumentTemplateTab'
import DocSequenceTab from './DocSequenceTab'
import AuthorizationTab from './AuthorizationTab'
import {
  Settings,
  User,
  Shield,
  Building2,
  Bell,
  Database,
  Mail,
  Palette,
  Lock,
  Globe,
  Save,
  Phone,
  MapPin,
  Edit,
  FileText,
  AlertTriangle,
  Upload,
  X,
  Image as ImageIcon,
  Info,
  Package,
  Hash
} from 'lucide-react'
import { compressAvatar, formatFileSize } from '@/lib/utils/imageCompression'
import { getStorageUrl } from '@/lib/utils'
import { getOrganizationTerms, TERMS_SETTINGS_KEY } from '@/lib/organizations/terms'

interface UserProfile {
  id: string
  email: string
  phone?: string | null
  role_code: string
  organization_id: string
  is_active: boolean
  department_id?: string | null
  organizations: {
    id: string
    org_name: string
    org_type_code: string
    org_code: string
  }
  roles: {
    role_name: string
    role_level: number
  }
}

interface SettingsViewProps {
  userProfile: UserProfile
  /** Optional initial tab to show (e.g. 'profile', 'organization', 'security', etc.) */
  initialTab?: string
}

interface UserSettings {
  full_name: string
  phone_number: string
  timezone: string
  language: string
  email_notifications: boolean
  sms_notifications: boolean
  theme: string
}

interface OrganizationSettings {
  org_name: string
  org_name_short: string
  /** Company registration no. (SSM), shown in the header of finance reports */
  registration_no: string
  contact_name: string
  contact_phone: string
  contact_email: string
  address: string
  address_line2: string
  city: string
  state_id: string | null
  district_id: string | null
  postal_code: string
  country_code: string
  require_payment_proof: boolean
  logo_url: string | null
  terms_conditions: string
  signature_type: 'none' | 'upload' | 'electronic'
  signature_url: string | null
  journey_builder_activation: 'shipped_distributor' | 'received_warehouse'
  auto_journey_creation: boolean
  qr_tracking_visibility: {
    manufacturer: {
      scan: boolean
      scan2: boolean
    }
    warehouse: {
      receive: boolean
      receive2: boolean
      ship: boolean
    }
  }
}

const SettingsView = ({ userProfile, initialTab }: SettingsViewProps) => {
  const [activeTab, setActiveTab] = useState(initialTab || 'profile')
  const [orgSubTab] = useState<'info'>('info')
  const [loading, setLoading] = useState(false)
  const { theme, setTheme } = useTheme()
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [signatureFile, setSignatureFile] = useState<File | null>(null)
  const [signaturePreview, setSignaturePreview] = useState<string | null>(null)
  const signatureInputRef = useRef<HTMLInputElement>(null)
  const [rawSettings, setRawSettings] = useState<any>({})
  const [userSettings, setUserSettings] = useState<UserSettings>({
    full_name: '',
    phone_number: '',
    timezone: 'Asia/Kuala_Lumpur',
    language: 'en',
    email_notifications: true,
    sms_notifications: false,
    theme: 'light'
  })
  const [orgSettings, setOrgSettings] = useState<OrganizationSettings>({
    org_name: '',
    org_name_short: '',
    registration_no: '',
    contact_name: '',
    contact_phone: '',
    contact_email: '',
    address: '',
    address_line2: '',
    city: '',
    state_id: null,
    district_id: null,
    postal_code: '',
    country_code: 'MY',
    require_payment_proof: true,
    logo_url: null,
    terms_conditions: '',
    signature_type: 'none',
    signature_url: null,
    journey_builder_activation: 'shipped_distributor',
    auto_journey_creation: false,
    qr_tracking_visibility: {
      manufacturer: { scan: true, scan2: true },
      warehouse: { receive: true, receive2: true, ship: true }
    }
  })

  // Branding settings state for live preview
  const [brandingSettings, setBrandingSettings] = useState({
    appName: 'Serapod2U',
    appTagline: 'Supply Chain',
    loginTitle: 'Welcome to Serapod2U',
    loginSubtitle: 'Supply Chain Management System',
    copyrightYear: '2025',
    companyName: 'Serapod2U',
    copyrightText: '© 2025 Serapod2U. All rights reserved.'
  })

  const [brandingLogoFile, setBrandingLogoFile] = useState<File | null>(null)
  const [brandingLogoPreview, setBrandingLogoPreview] = useState<string | null>(null)
  const brandingLogoInputRef = useRef<HTMLInputElement>(null)

  const { isReady, supabase } = useSupabaseAuth()

  useEffect(() => {
    if (isReady) {
      loadSettings()
    }
    // Sync theme from context
    setUserSettings(prev => ({ ...prev, theme }))
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, theme])

  const loadSettings = async () => {
    if (!isReady) return

    try {
      setLoading(true)

      // Load user profile data (mock for now)
      setUserSettings({
        full_name: 'John Doe',
        phone_number: '+60123456789',
        timezone: 'Asia/Kuala_Lumpur',
        language: 'en',
        email_notifications: true,
        sms_notifications: false,
        theme: 'light'
      })

      // Load organization data from database
      const { data: orgData, error: orgError } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', userProfile.organizations.id)
        .single() as { data: any; error: any }

      if (orgError) throw orgError

      let settings = orgData.settings || {}
      if (typeof settings === 'string') {
        try {
          settings = JSON.parse(settings)
        } catch (e) {
          console.error('Failed to parse settings JSON:', e)
          settings = {}
        }
      }

      setRawSettings(settings)

      // Load system preferences
      const { data: prefs } = await (supabase as any)
        .schema('core')
        .from('system_preferences')
        .select('*')
        .eq('company_id', userProfile.organizations.id)
        .eq('module', 'qr_tracking') as { data: any[] | null }

      const qrVisibility = {
        manufacturer: {
          scan: prefs?.find((p: any) => p.key === 'manufacturer_scan')?.value?.visible ?? true,
          scan2: prefs?.find((p: any) => p.key === 'manufacturer_scan_2')?.value?.visible ?? true,
        },
        warehouse: {
          receive: prefs?.find((p: any) => p.key === 'warehouse_receive')?.value?.visible ?? true,
          receive2: prefs?.find((p: any) => p.key === 'warehouse_receive_2')?.value?.visible ?? true,
          ship: prefs?.find((p: any) => p.key === 'warehouse_ship')?.value?.visible ?? true,
        }
      }

      setOrgSettings({
        org_name: orgData.org_name || '',
        org_name_short: orgData.org_code || userProfile.organizations.org_code,
        registration_no: orgData.registration_no || '',
        contact_name: orgData.contact_name || '',
        contact_phone: orgData.contact_phone || '',
        contact_email: orgData.contact_email || '',
        address: orgData.address || '',
        address_line2: orgData.address_line2 || '',
        city: orgData.city || '',
        state_id: orgData.state_id || null,
        district_id: orgData.district_id || null,
        postal_code: orgData.postal_code || '',
        country_code: orgData.country_code || 'MY',
        require_payment_proof: settings.require_payment_proof ?? true,
        logo_url: orgData.logo_url || null,
        terms_conditions: getOrganizationTerms(orgData),
        signature_type: orgData.signature_type || 'none',
        signature_url: orgData.signature_url || null,
        journey_builder_activation: settings.journey_builder_activation || 'shipped_distributor',
        auto_journey_creation: settings.auto_journey_creation ?? false,
        qr_tracking_visibility: qrVisibility
      })

      // Set initial logo preview (resolve to a browsable URL - self-hosted
      // Supabase requires an apikey query param even on "public" storage URLs)
      setLogoPreview(orgData.logo_url ? getStorageUrl(orgData.logo_url) : null)
      setSignaturePreview(orgData.signature_url ? getStorageUrl(orgData.signature_url) : null)

      // Load branding settings from database
      if (settings.branding) {
        setBrandingSettings({
          appName: settings.branding.appName || 'Serapod2U',
          appTagline: settings.branding.appTagline || 'Supply Chain',
          loginTitle: settings.branding.loginTitle || 'Welcome to Serapod2U',
          loginSubtitle: settings.branding.loginSubtitle || 'Supply Chain Management System',
          copyrightYear: settings.branding.copyrightYear || '2025',
          companyName: settings.branding.companyName || 'Serapod2U',
          copyrightText: settings.branding.copyrightText || '© 2025 Serapod2U. All rights reserved.'
        })

        // Set branding logo preview from database
        const logoUrl = settings.branding.logoUrl || orgData.logo_url
        if (logoUrl) {
          setBrandingLogoPreview(logoUrl)
        }
      }
    } catch (error) {
      console.error('Error loading settings:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveProfile = async () => {
    try {
      setLoading(true)
      // In real implementation, this would update the user profile
      console.log('Saving profile settings:', userSettings)
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1000))
      alert('Profile settings saved successfully!')
    } catch (error) {
      console.error('Error saving profile:', error)
      alert('Error saving profile settings')
    } finally {
      setLoading(false)
    }
  }

  const handleSaveNotifications = async () => {
    try {
      setLoading(true)

      // Save user notification settings (profile)
      console.log('Saving notification settings:', userSettings)
      await new Promise(resolve => setTimeout(resolve, 500))

      // Save organization settings if user has permission (Admin/Manager)
      if (userProfile.roles.role_level <= 20 && isReady) {
        // Try to save to system_preferences (new way) - wrap in try/catch to not block legacy save
        try {
          const updates = [
            { key: 'manufacturer_scan', value: { visible: orgSettings.qr_tracking_visibility.manufacturer.scan } },
            { key: 'manufacturer_scan_2', value: { visible: orgSettings.qr_tracking_visibility.manufacturer.scan2 } },
            { key: 'warehouse_receive', value: { visible: orgSettings.qr_tracking_visibility.warehouse.receive } },
            { key: 'warehouse_receive_2', value: { visible: orgSettings.qr_tracking_visibility.warehouse.receive2 } },
            { key: 'warehouse_ship', value: { visible: orgSettings.qr_tracking_visibility.warehouse.ship } },
          ]

          for (const update of updates) {
            const { error: prefError } = await (supabase as any).schema('core').from('system_preferences').upsert({
              company_id: userProfile.organizations.id,
              module: 'qr_tracking',
              key: update.key,
              value: update.value,
              updated_at: new Date().toISOString()
            }, { onConflict: 'company_id, module, key' })

            if (prefError) {
              console.warn('Warning: Failed to save to system_preferences (migration might be missing):', prefError)
            }
          }
        } catch (err) {
          console.warn('Warning: Error saving system preferences:', err)
        }

        // Always save legacy settings for backward compatibility
        const { error } = await (supabase as any)
          .from('organizations')
          .update({
            settings: {
              ...rawSettings,
              require_payment_proof: orgSettings.require_payment_proof,
              journey_builder_activation: orgSettings.journey_builder_activation,
              auto_journey_creation: orgSettings.auto_journey_creation,
              qr_tracking_visibility: orgSettings.qr_tracking_visibility // Keeping as fallback
            },
            updated_at: new Date().toISOString()
          })
          .eq('id', userProfile.organizations.id)

        if (error) throw error

        // Dispatch event to update sidebar
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('settingsUpdated'))
        }
      }

      alert('Settings saved successfully!')

      // Reload page to ensure changes are reflected
      setTimeout(() => {
        window.location.reload()
      }, 500)
    } catch (error: any) {
      console.error('Error saving notifications:', error)
      alert(`Error saving preferences: ${error.message}`)
    } finally {
      setLoading(false)
    }
  }

  const handleSaveOrganization = async () => {
    if (!isReady) return

    try {
      setLoading(true)

      let logoUrl = orgSettings.logo_url

      // Handle logo upload if there's a new file
      if (logoFile) {
        // Compress logo first
        const compressionResult = await compressAvatar(logoFile)

        toast({
          title: '🖼️ Logo Compressed',
          description: `${formatFileSize(compressionResult.originalSize)} → ${formatFileSize(compressionResult.compressedSize)} (${compressionResult.compressionRatio.toFixed(1)}% smaller)`,
        })

        const fileName = `org-${userProfile.organizations.id}-${Date.now()}.jpg`

        // Upload the logo to avatars bucket
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(fileName, compressionResult.file, {
            contentType: compressionResult.file.type,
            cacheControl: '3600',
            upsert: false
          })

        if (uploadError) throw uploadError

        // Get public URL
        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(uploadData.path)

        // Add cache-busting parameter
        logoUrl = `${publicUrl}?v=${Date.now()}`
      }

      let signatureUrl = orgSettings.signature_url

      // Handle signature upload if there's a new file
      if (signatureFile) {
        const fileExt = signatureFile.name.split('.').pop()
        const fileName = `sig-${userProfile.organizations.id}-${Date.now()}.${fileExt}`

        // Upload the signature to avatars bucket
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(fileName, signatureFile, {
            contentType: signatureFile.type,
            cacheControl: '3600',
            upsert: false
          })

        if (uploadError) throw uploadError

        // Get public URL
        const { data: { publicUrl } } = supabase.storage
          .from('avatars')
          .getPublicUrl(uploadData.path)

        // Add cache-busting parameter
        signatureUrl = `${publicUrl}?v=${Date.now()}`
      }

      // Update the organizations table with new settings including logo
      // Check if signature columns exist before including them
      const updateData: any = {
        org_name: orgSettings.org_name,
        registration_no: orgSettings.registration_no.trim() || null,
        contact_name: orgSettings.contact_name || null,
        contact_phone: orgSettings.contact_phone || null,
        contact_email: orgSettings.contact_email || null,
        address: orgSettings.address || null,
        address_line2: orgSettings.address_line2 || null,
        city: orgSettings.city || null,
        state_id: orgSettings.state_id || null,
        district_id: orgSettings.district_id || null,
        postal_code: orgSettings.postal_code || null,
        country_code: orgSettings.country_code || null,
        logo_url: logoUrl,
        settings: {
          ...rawSettings,
          require_payment_proof: orgSettings.require_payment_proof,
          journey_builder_activation: orgSettings.journey_builder_activation,
          // Stored verbatim - the user's line breaks and indentation are the
          // content, so nothing here trims or reformats the value.
          [TERMS_SETTINGS_KEY]: orgSettings.terms_conditions
        },
        is_active: true,
        updated_at: new Date().toISOString()
      }

      // Only include signature fields if they have values (migration may not be applied)
      if (orgSettings.signature_type) {
        updateData.signature_type = orgSettings.signature_type
      }
      // Persist the signature reference even when it is cleared, so "Remove"
      // is not silently reverted by the reload below.
      updateData.signature_url = signatureUrl ?? null

      const { error } = await (supabase as any)
        .from('organizations')
        .update(updateData)
        .eq('id', userProfile.organizations.id)

      if (error) throw error

      // Clear the logo and signature file selection
      setLogoFile(null)
      setSignatureFile(null)

      // Reload organization data to ensure we have the latest logo_url from database
      // This also ensures the cache-busted URL is properly set
      await loadSettings()

      toast({
        title: 'Organization settings saved',
        description: 'Your organization details have been updated successfully.',
      })
    } catch (error: any) {
      console.error('Error saving organization:', error)
      toast({
        title: 'Error saving organization',
        description: error.message || 'Something went wrong while saving.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  // Handle logo file selection
  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast({ title: 'Invalid file', description: 'Please select an image file', variant: 'destructive' })
      return
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: 'File too large', description: 'File size must be less than 5MB', variant: 'destructive' })
      return
    }

    setLogoFile(file)

    // Create preview
    const reader = new FileReader()
    reader.onloadend = () => {
      setLogoPreview(reader.result as string)
    }
    reader.readAsDataURL(file)
  }

  // Remove logo
  const handleRemoveLogo = () => {
    setLogoFile(null)
    setLogoPreview(null)
    setOrgSettings(prev => ({ ...prev, logo_url: null }))
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // Handle signature file selection
  const handleSignatureFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate file type
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file')
      return
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      alert('File size must be less than 5MB')
      return
    }

    setSignatureFile(file)

    // Create preview
    const reader = new FileReader()
    reader.onloadend = () => {
      setSignaturePreview(reader.result as string)
    }
    reader.readAsDataURL(file)
  }

  // Remove signature
  const handleRemoveSignature = () => {
    setSignatureFile(null)
    setSignaturePreview(null)
    setOrgSettings(prev => ({ ...prev, signature_url: null }))
    if (signatureInputRef.current) {
      signatureInputRef.current.value = ''
    }
  }

  // Handle branding logo file change
  const handleBrandingLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate file type
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file')
      return
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      alert('File size must be less than 5MB')
      return
    }

    setBrandingLogoFile(file)

    // Create preview
    const reader = new FileReader()
    reader.onloadend = () => {
      setBrandingLogoPreview(reader.result as string)
    }
    reader.readAsDataURL(file)
  }

  // Remove branding logo
  const handleRemoveBrandingLogo = () => {
    setBrandingLogoFile(null)
    setBrandingLogoPreview(null)
    if (brandingLogoInputRef.current) {
      brandingLogoInputRef.current.value = ''
    }
  }

  // Get organization initials for fallback
  const getOrgInitials = (name: string) => {
    return name
      .split(' ')
      .filter(word => word.length > 0)
      .map(word => word[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  const tabs = [
    { id: 'profile', label: 'Profile', icon: User },
    { id: 'organization', label: 'Organization', icon: Building2 },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'preferences', label: 'Preferences', icon: Settings },
    ...(userProfile.roles.role_level === 1 ? [{ id: 'authorization', label: 'Authorization', icon: Lock }] : []),
    ...(userProfile.roles.role_level === 1 ? [{ id: 'danger-zone', label: 'Danger Zone', icon: AlertTriangle }] : [])
  ]

  const { hasPermission } = usePermissions(
    userProfile.roles.role_level,
    userProfile.role_code,
    userProfile.department_id
  )

  // Check if user can edit organization settings or org chart
  const canEditOrganization =
    userProfile.roles.role_level <= 20 ||
    hasPermission('edit_org_settings') ||
    hasPermission('manage_org_chart')

  return (
    <div className="space-y-6">
      {/* Tab Content */}
      <div>
        {/* Profile Settings */}
        {activeTab === 'profile' && (
          <Card>
            <CardHeader>
              <CardTitle>Profile Information</CardTitle>
              <CardDescription>
                Update your personal information and contact details
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="fullName">Full Name</Label>
                  <Input
                    id="fullName"
                    value={userSettings.full_name}
                    onChange={(e) => setUserSettings({ ...userSettings, full_name: e.target.value })}
                    placeholder="Enter your full name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email Address</Label>
                  <Input
                    id="email"
                    type="email"
                    value={userProfile.email}
                    disabled
                    className="bg-gray-50"
                  />
                  <p className="text-xs text-gray-500">Email cannot be changed here</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number</Label>
                  <Input
                    id="phone"
                    value={userSettings.phone_number}
                    onChange={(e) => setUserSettings({ ...userSettings, phone_number: e.target.value })}
                    placeholder="+60123456789"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="role">Role</Label>
                  <Input
                    id="role"
                    value={userProfile.roles.role_name}
                    disabled
                    className="bg-gray-50"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={handleSaveProfile} disabled={loading}>
                  <Save className="w-4 h-4 mr-2" />
                  {loading ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Organization Settings with Sub-tabs */}
        {activeTab === 'organization' && (
          <div className="space-y-6">
            {/* Organization Information */}
            {orgSubTab === 'info' && (
              <Card>
                <CardHeader>
                  <CardTitle>Organization Information</CardTitle>
                  <CardDescription>
                    {canEditOrganization
                      ? 'Update your organization details and contact information'
                      : 'View your organization information (read-only)'
                    }
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Logo Upload Section */}
                  {canEditOrganization && (
                    <div className="pb-6 border-b border-gray-200">
                      <Label className="text-base font-semibold mb-4 block">Organization Logo</Label>
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
                        {/* Logo Preview */}
                        <div className="flex-shrink-0">
                          <Avatar className="w-32 h-32 rounded-lg" key={logoPreview || 'no-logo'}>
                            <AvatarImage
                              src={logoPreview || undefined}
                              alt={`${orgSettings.org_name} logo`}
                              className="object-contain"
                              onError={() => console.error('Failed to load organization logo:', logoPreview)}
                            />
                            <AvatarFallback className="rounded-lg bg-gradient-to-br from-blue-100 to-blue-50">
                              <Building2 className="w-12 h-12 text-blue-600" />
                            </AvatarFallback>
                          </Avatar>
                        </div>

                        {/* Upload Controls */}
                        <div className="flex-1 space-y-3">
                          <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-3">
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept="image/*"
                              onChange={handleLogoFileChange}
                              className="hidden"
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => fileInputRef.current?.click()}
                              disabled={loading}
                            >
                              <Upload className="w-4 h-4 mr-2" />
                              {logoPreview ? 'Change Logo' : 'Upload Logo'}
                            </Button>
                            {logoPreview && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={handleRemoveLogo}
                                disabled={loading}
                              >
                                <X className="w-4 h-4 mr-2" />
                                Remove
                              </Button>
                            )}
                          </div>
                          <div className="text-sm text-gray-500 space-y-1">
                            <p className="flex items-center gap-1">
                              <ImageIcon className="w-4 h-4" />
                              Recommended: Square image, at least 200x200px
                            </p>
                            <p>Supported formats: JPG, PNG, GIF (Max 5MB)</p>
                            {logoFile && (
                              <p className="text-blue-600 font-medium">
                                New logo selected: {logoFile.name}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <Label htmlFor="orgName">Organization Name</Label>
                      <Input
                        id="orgName"
                        value={orgSettings.org_name}
                        onChange={(e) => setOrgSettings({ ...orgSettings, org_name: e.target.value })}
                        disabled={!canEditOrganization}
                        className={!canEditOrganization ? 'bg-gray-50' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="orgCode">Organization Code</Label>
                      <Input
                        id="orgCode"
                        value={orgSettings.org_name_short}
                        onChange={(e) => setOrgSettings({ ...orgSettings, org_name_short: e.target.value })}
                        disabled={!canEditOrganization}
                        className={!canEditOrganization ? 'bg-gray-50' : ''}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="registrationNo">Registration No. (SSM)</Label>
                      <Input
                        id="registrationNo"
                        value={orgSettings.registration_no}
                        onChange={(e) => setOrgSettings({ ...orgSettings, registration_no: e.target.value })}
                        disabled={!canEditOrganization}
                        placeholder="e.g. 1511495-X"
                        className={!canEditOrganization ? 'bg-gray-50 placeholder:text-gray-300' : 'placeholder:text-gray-300'}
                      />
                      <p className="text-xs text-gray-400">Shown next to the company name on financial reports</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="contactPerson">Contact Name</Label>
                      <Input
                        id="contactPerson"
                        value={orgSettings.contact_name}
                        onChange={(e) => setOrgSettings({ ...orgSettings, contact_name: e.target.value })}
                        disabled={!canEditOrganization}
                        placeholder="Enter contact person name"
                        className={!canEditOrganization ? 'bg-gray-50 placeholder:text-gray-300' : 'placeholder:text-gray-300'}
                      />
                      {!orgSettings.contact_name && canEditOrganization && (
                        <p className="text-xs text-gray-400 italic">Please enter the contact person&apos;s name</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="orgPhone">Phone</Label>
                      <Input
                        id="orgPhone"
                        value={orgSettings.contact_phone}
                        onChange={(e) => setOrgSettings({ ...orgSettings, contact_phone: e.target.value })}
                        disabled={!canEditOrganization}
                        placeholder="Enter phone number (e.g., +60123456789)"
                        className={!canEditOrganization ? 'bg-gray-50 placeholder:text-gray-300' : 'placeholder:text-gray-300'}
                      />
                      {!orgSettings.contact_phone && canEditOrganization && (
                        <p className="text-xs text-gray-400 italic">Please enter the contact phone number</p>
                      )}
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="orgEmail">Email</Label>
                      <Input
                        id="orgEmail"
                        type="email"
                        value={orgSettings.contact_email}
                        onChange={(e) => setOrgSettings({ ...orgSettings, contact_email: e.target.value })}
                        disabled={!canEditOrganization}
                        placeholder="Enter email address"
                        className={!canEditOrganization ? 'bg-gray-50 placeholder:text-gray-300' : 'placeholder:text-gray-300'}
                      />
                      {!orgSettings.contact_email && canEditOrganization && (
                        <p className="text-xs text-gray-400 italic">Please enter the contact email address</p>
                      )}
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="address">Address</Label>
                      <Input
                        id="address"
                        value={orgSettings.address}
                        onChange={(e) => setOrgSettings({ ...orgSettings, address: e.target.value })}
                        disabled={!canEditOrganization}
                        placeholder="Enter street address"
                        className={!canEditOrganization ? 'bg-gray-50 placeholder:text-gray-300' : 'placeholder:text-gray-300'}
                      />
                      {!orgSettings.address && canEditOrganization && (
                        <p className="text-xs text-gray-400 italic">Please enter the street address</p>
                      )}
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <Label htmlFor="address_line2">Address Line 2 (Optional)</Label>
                      <Input
                        id="address_line2"
                        value={orgSettings.address_line2}
                        onChange={(e) => setOrgSettings({ ...orgSettings, address_line2: e.target.value })}
                        disabled={!canEditOrganization}
                        placeholder="Apt, suite, unit, building, floor, etc."
                        className={!canEditOrganization ? 'bg-gray-50 placeholder:text-gray-300' : 'placeholder:text-gray-300'}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="city">City</Label>
                      <Input
                        id="city"
                        value={orgSettings.city}
                        onChange={(e) => setOrgSettings({ ...orgSettings, city: e.target.value })}
                        disabled={!canEditOrganization}
                        placeholder="Enter city"
                        className={!canEditOrganization ? 'bg-gray-50 placeholder:text-gray-300' : 'placeholder:text-gray-300'}
                      />
                      {!orgSettings.city && canEditOrganization && (
                        <p className="text-xs text-gray-400 italic">Enter city name</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="state_id">State</Label>
                      <Input
                        id="state_id"
                        value={orgSettings.state_id || ''}
                        disabled={true}
                        placeholder="State (managed in Organizations)"
                        className="bg-gray-50 placeholder:text-gray-300"
                      />
                      <p className="text-xs text-gray-400 italic">State must be managed through Organizations page</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="postalCode">Postal Code</Label>
                      <Input
                        id="postalCode"
                        value={orgSettings.postal_code}
                        onChange={(e) => setOrgSettings({ ...orgSettings, postal_code: e.target.value })}
                        disabled={!canEditOrganization}
                        placeholder="Enter postal code"
                        className={!canEditOrganization ? 'bg-gray-50 placeholder:text-gray-300' : 'placeholder:text-gray-300'}
                      />
                      {!orgSettings.postal_code && canEditOrganization && (
                        <p className="text-xs text-gray-400 italic">Enter postal code</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="country">Country Code</Label>
                      <Input
                        id="country"
                        value={orgSettings.country_code}
                        onChange={(e) => setOrgSettings({ ...orgSettings, country_code: e.target.value })}
                        disabled={!canEditOrganization}
                        placeholder="Enter country code (e.g., MY, US, SG)"
                        className={!canEditOrganization ? 'bg-gray-50 placeholder:text-gray-300' : 'placeholder:text-gray-300'}
                      />
                      {!orgSettings.country_code && canEditOrganization && (
                        <p className="text-xs text-gray-400 italic">e.g., MY (Malaysia), US (United States), SG (Singapore)</p>
                      )}
                    </div>
                  </div>

                  {/* Terms & Conditions Section */}
                  {canEditOrganization && (
                    <div className="pb-6 border-b border-gray-200 mb-6">
                      <Label htmlFor="termsConditions" className="text-base font-semibold mb-4 block">Terms &amp; Conditions</Label>
                      <div className="space-y-2">
                        <Textarea
                          id="termsConditions"
                          value={orgSettings.terms_conditions}
                          onChange={(e) => setOrgSettings({ ...orgSettings, terms_conditions: e.target.value })}
                          disabled={loading}
                          rows={10}
                          spellCheck={false}
                          className="min-h-[220px] font-mono text-sm whitespace-pre-wrap"
                          placeholder={'Payment to be made to:\n(Bank name)\nACCOUNT HOLDER\n0000 0000 000'}
                        />
                        <p className="text-xs text-gray-500">
                          Shown on order documents exactly as typed - line breaks, blank lines and
                          indentation are preserved. Leave empty to omit the section entirely.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Signature Section */}
                  {canEditOrganization && (
                    <div className="pb-6 border-b border-gray-200 mb-6">
                      <Label className="text-base font-semibold mb-4 block">Organization Signature</Label>
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label htmlFor="signatureType">Signature Type</Label>
                          <Select
                            value={orgSettings.signature_type}
                            onValueChange={(value: any) => setOrgSettings({ ...orgSettings, signature_type: value })}
                          >
                            <SelectTrigger id="signatureType" className="w-full md:w-1/2">
                              <SelectValue placeholder="Select signature type" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">No signature</SelectItem>
                              <SelectItem value="electronic">Electronic signature</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-gray-500">
                            This signature will be used for documentation created by this organization.
                          </p>
                        </div>

                        {orgSettings.signature_type === 'electronic' && (
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6 mt-4">
                            {/* Signature Preview */}
                            <div className="flex-shrink-0">
                              <div className="w-48 h-24 border border-gray-200 rounded-lg flex items-center justify-center bg-gray-50 overflow-hidden">
                                {signaturePreview ? (
                                  <img
                                    src={signaturePreview}
                                    alt="Signature preview"
                                    className="max-w-full max-h-full object-contain"
                                  />
                                ) : (
                                  <span className="text-gray-400 text-sm">No signature</span>
                                )}
                              </div>
                            </div>

                            {/* Upload Controls */}
                            <div className="flex-1 space-y-3">
                              <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-3">
                                <input
                                  ref={signatureInputRef}
                                  type="file"
                                  accept="image/*"
                                  onChange={handleSignatureFileChange}
                                  className="hidden"
                                />
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => signatureInputRef.current?.click()}
                                  disabled={loading}
                                >
                                  <Upload className="w-4 h-4 mr-2" />
                                  {signaturePreview ? 'Change Signature' : 'Upload Signature'}
                                </Button>
                                {signaturePreview && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={handleRemoveSignature}
                                    disabled={loading}
                                  >
                                    <X className="w-4 h-4 mr-2" />
                                    Remove
                                  </Button>
                                )}
                              </div>
                              <div className="text-sm text-gray-500 space-y-1">
                                <p>Recommended: Transparent PNG, approx 300x100px</p>
                                {signatureFile && (
                                  <p className="text-blue-600 font-medium">
                                    New file selected: {signatureFile.name}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {canEditOrganization && (
                    <div className="flex justify-end">
                      <Button onClick={handleSaveOrganization} disabled={loading}>
                        <Save className="w-4 h-4 mr-2" />
                        {loading ? 'Saving...' : 'Save Changes'}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* System Branding Settings (Only for Super Admin) */}
            {orgSubTab === 'info' && userProfile.roles.role_level === 1 && (
              <Card className="mt-6 border-2 border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50">
                <CardHeader className="border-b border-blue-200">
                  <CardTitle className="flex items-center gap-2">
                    <Palette className="w-5 h-5 text-blue-600" />
                    System Branding & White-Label Settings
                  </CardTitle>
                  <CardDescription className="text-blue-700">
                    Customize the system branding, application name, logo, and footer for a white-label experience.
                    <span className="block mt-1 font-semibold text-blue-800">⚠️ Super Admin Only - Changes affect the entire system and login page</span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-8 pt-6">

                  {/* Application Branding Section */}
                  <div className="space-y-4 pb-6 border-b border-blue-200">
                    <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                      <Building2 className="w-5 h-5 text-blue-600" />
                      Application Branding
                    </h3>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="appName" className="text-sm font-medium">
                          Application Name
                        </Label>
                        <Input
                          id="appName"
                          placeholder="e.g., Serapod2U"
                          className="font-medium"
                          value={brandingSettings.appName}
                          onChange={(e) => setBrandingSettings({ ...brandingSettings, appName: e.target.value })}
                        />
                        <p className="text-xs text-gray-500 italic">
                          Displayed in sidebar header, browser title, and login page
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="appTagline" className="text-sm font-medium">
                          Application Tagline
                        </Label>
                        <Input
                          id="appTagline"
                          placeholder="e.g., Supply Chain Management"
                          value={brandingSettings.appTagline}
                          onChange={(e) => setBrandingSettings({ ...brandingSettings, appTagline: e.target.value })}
                        />
                        <p className="text-xs text-gray-500 italic">
                          Shown below app name in sidebar
                        </p>
                      </div>
                    </div>

                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <Label className="text-sm font-medium mb-3 block">Preview: Sidebar Header</Label>
                      <div className="p-3 bg-gray-50 rounded-lg space-y-3">
                        {/* Row 1: Logo + App Name & Tagline */}
                        <div className="flex items-center gap-3">
                          {brandingLogoPreview ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={brandingLogoPreview}
                              alt="Logo preview"
                              className="h-10 w-10 rounded-lg object-contain flex-shrink-0"
                            />
                          ) : (
                            <div className="h-10 w-10 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
                              <Package className="h-6 w-6 text-white" />
                            </div>
                          )}
                          <div>
                            <h1 className="font-semibold text-gray-900">{brandingSettings.appName || 'Serapod2U'}</h1>
                            <p className="text-xs text-gray-600">{brandingSettings.appTagline || 'Supply Chain'}</p>
                          </div>
                        </div>

                        {/* Row 2: Date, Day, Time - Aligned Left */}
                        <div className="text-left text-xs text-gray-600 space-y-0.5 pl-0">
                          <div><span className="font-medium">Date:</span> 24 Oct 2025</div>
                          <div><span className="font-medium">Day:</span> Friday</div>
                          <div><span className="font-medium">Time:</span> 7:32 AM</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Application Logo Section */}
                  <div className="space-y-4 pb-6 border-b border-blue-200">
                    <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                      <ImageIcon className="w-5 h-5 text-blue-600" />
                      Application Logo
                    </h3>

                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <input
                        ref={brandingLogoInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleBrandingLogoFileChange}
                        className="hidden"
                      />
                      <div className="flex items-start gap-6">
                        <div className="flex-shrink-0">
                          {brandingLogoPreview ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={brandingLogoPreview}
                              alt="Logo preview"
                              className="w-16 h-16 rounded-lg object-contain"
                            />
                          ) : (
                            <div className="w-16 h-16 bg-blue-600 rounded-lg flex items-center justify-center">
                              <Package className="w-8 h-8 text-white" />
                            </div>
                          )}
                          <p className="text-xs text-gray-500 mt-2 text-center">Current</p>
                        </div>

                        <div className="flex-1 space-y-3">
                          <div>
                            <div className="flex gap-2 mb-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => brandingLogoInputRef.current?.click()}
                                type="button"
                              >
                                <Upload className="w-4 h-4 mr-2" />
                                Upload New Logo
                              </Button>
                              {brandingLogoPreview && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={handleRemoveBrandingLogo}
                                  type="button"
                                >
                                  Remove
                                </Button>
                              )}
                            </div>
                            <p className="text-xs text-gray-500">
                              Logo appears in sidebar and login page (Recommended: 200x200px, PNG/SVG, Max 5MB)
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Login Page Branding */}
                  <div className="space-y-4 pb-6 border-b border-blue-200">
                    <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                      <Globe className="w-5 h-5 text-blue-600" />
                      Login Page Customization
                    </h3>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="loginTitle" className="text-sm font-medium">
                          Login Page Title
                        </Label>
                        <Input
                          id="loginTitle"
                          placeholder="e.g., Welcome to Serapod2U"
                          value={brandingSettings.loginTitle}
                          onChange={(e) => setBrandingSettings({ ...brandingSettings, loginTitle: e.target.value })}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="loginSubtitle" className="text-sm font-medium">
                          Login Page Subtitle
                        </Label>
                        <Input
                          id="loginSubtitle"
                          placeholder="e.g., Supply Chain Management System"
                          value={brandingSettings.loginSubtitle}
                          onChange={(e) => setBrandingSettings({ ...brandingSettings, loginSubtitle: e.target.value })}
                        />
                      </div>
                    </div>

                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <Label className="text-sm font-medium mb-3 block">Preview: Login Page Header</Label>
                      <div className="text-center space-y-2 p-4 bg-gradient-to-b from-blue-50 to-white rounded-lg">
                        {brandingLogoPreview ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={brandingLogoPreview}
                            alt="Logo preview"
                            className="h-12 w-12 rounded-lg object-contain mx-auto"
                          />
                        ) : (
                          <div className="h-12 w-12 bg-blue-600 rounded-lg flex items-center justify-center mx-auto">
                            <Package className="h-6 w-6 text-white" />
                          </div>
                        )}
                        <h1 className="text-2xl font-bold text-gray-900">{brandingSettings.loginTitle || 'Welcome to Serapod2U'}</h1>
                        <p className="text-gray-600">{brandingSettings.loginSubtitle || 'Supply Chain Management System'}</p>
                      </div>
                    </div>
                  </div>

                  {/* Footer Customization */}
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                      <FileText className="w-5 h-5 text-blue-600" />
                      Footer & Copyright
                    </h3>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="copyrightYear" className="text-sm font-medium">
                          Copyright Year
                        </Label>
                        <Input
                          id="copyrightYear"
                          placeholder="e.g., 2025"
                          value={brandingSettings.copyrightYear}
                          onChange={(e) => setBrandingSettings({ ...brandingSettings, copyrightYear: e.target.value })}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="companyName" className="text-sm font-medium">
                          Company Name
                        </Label>
                        <Input
                          id="companyName"
                          placeholder="e.g., Serapod2U"
                          value={brandingSettings.companyName}
                          onChange={(e) => setBrandingSettings({ ...brandingSettings, companyName: e.target.value })}
                        />
                      </div>

                      <div className="space-y-2 md:col-span-2">
                        <Label htmlFor="copyrightText" className="text-sm font-medium">
                          Full Copyright Text
                        </Label>
                        <Input
                          id="copyrightText"
                          placeholder="e.g., © 2025 Serapod2U. All rights reserved."
                          value={brandingSettings.copyrightText}
                          onChange={(e) => setBrandingSettings({ ...brandingSettings, copyrightText: e.target.value })}
                          className="font-medium"
                        />
                        <p className="text-xs text-gray-500 italic">
                          Displayed at the bottom of login page and system footer
                        </p>
                      </div>
                    </div>

                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <Label className="text-sm font-medium mb-3 block">Preview: Footer</Label>
                      <div className="text-center p-4 bg-gray-50 rounded-lg border-t border-gray-200">
                        <p className="text-sm text-gray-600">{brandingSettings.copyrightText}</p>
                      </div>
                    </div>
                  </div>

                  {/* Save Button */}
                  <div className="flex justify-between items-center pt-6 border-t border-blue-200">
                    <div className="text-sm text-gray-600">
                      <AlertTriangle className="w-4 h-4 inline mr-1 text-amber-600" />
                      Changes will affect all users and require page refresh
                    </div>
                    <Button
                      type="button"
                      className="bg-blue-600 hover:bg-blue-700"
                      onClick={async () => {
                        try {
                          setLoading(true)

                          let logoUrl = brandingLogoPreview

                          // Upload logo to Supabase storage if new file selected
                          if (brandingLogoFile) {
                            // Compress logo first
                            const compressionResult = await compressAvatar(brandingLogoFile)

                            toast({
                              title: '🖼️ Logo Compressed',
                              description: `${formatFileSize(compressionResult.originalSize)} → ${formatFileSize(compressionResult.compressedSize)} (${compressionResult.compressionRatio.toFixed(1)}% smaller)`,
                            })

                            const timestamp = Date.now()
                            const fileName = `branding/${userProfile.organizations.id}-logo-${timestamp}.jpg`

                            // Upload to existing avatars bucket (same bucket used for user avatars and org logos)
                            const { data: uploadData, error: uploadError } = await supabase.storage
                              .from('avatars')
                              .upload(fileName, compressionResult.file, {
                                contentType: compressionResult.file.type,
                                cacheControl: '3600',
                                upsert: true
                              })

                            if (uploadError) {
                              console.error('Storage upload error:', uploadError)

                              // Fallback: convert to base64 and save directly
                              const reader = new FileReader()
                              logoUrl = await new Promise<string>((resolve, reject) => {
                                reader.onloadend = () => resolve(reader.result as string)
                                reader.onerror = reject
                                reader.readAsDataURL(brandingLogoFile)
                              })

                              toast({
                                title: "⚠️ Note",
                                description: "Logo saved as base64. For better performance, please configure storage permissions.",
                              })
                            } else {
                              // Get public URL with timestamp to bust cache
                              const { data: urlData } = supabase.storage
                                .from('avatars')
                                .getPublicUrl(fileName)

                              logoUrl = `${urlData.publicUrl}?t=${timestamp}`
                            }
                          }

                          // Save branding settings to organization settings
                          const settings = {
                            branding: {
                              appName: brandingSettings.appName,
                              appTagline: brandingSettings.appTagline,
                              loginTitle: brandingSettings.loginTitle,
                              loginSubtitle: brandingSettings.loginSubtitle,
                              copyrightYear: brandingSettings.copyrightYear,
                              companyName: brandingSettings.companyName,
                              copyrightText: brandingSettings.copyrightText,
                              logoUrl: logoUrl
                            }
                          }

                          const { error: updateError } = await supabase
                            .from('organizations')
                            .update({
                              settings,
                              logo_url: logoUrl,
                              updated_at: new Date().toISOString()
                            })
                            .eq('id', userProfile.organizations.id)

                          if (updateError) {
                            throw updateError
                          }

                          toast({
                            title: "✅ Success!",
                            description: "Branding settings have been saved successfully.",
                          })

                          // Reload page to apply changes
                          setTimeout(() => {
                            window.location.reload()
                          }, 1500)

                        } catch (error: any) {
                          console.error('Failed to save branding:', error)
                          toast({
                            title: "❌ Error",
                            description: error?.message || "Failed to save branding settings. Please try again.",
                            variant: "destructive",
                          })
                        } finally {
                          setLoading(false)
                        }
                      }}
                      disabled={loading}
                    >
                      <Save className="w-4 h-4 mr-2" />
                      {loading ? 'Saving...' : 'Save Branding Settings'}
                    </Button>
                  </div>

                  {/* Information Note */}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-4">
                    <div className="flex items-start gap-3">
                      <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                      <div className="text-sm text-blue-900">
                        <p className="font-semibold mb-1">White-Label Configuration</p>
                        <p>These settings allow you to fully customize the system branding for your organization. Perfect for resellers and enterprise deployments who want to maintain their own brand identity.</p>
                        <ul className="mt-2 space-y-1 list-disc list-inside text-blue-800">
                          <li>Application name and logo appear throughout the system</li>
                          <li>Login page branding creates a professional first impression</li>
                          <li>Custom copyright footer ensures legal compliance</li>
                          <li>All changes are stored in database and persist across sessions</li>
                        </ul>
                      </div>
                    </div>
                  </div>

                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Notifications Settings */}
        {activeTab === 'notifications' && (
          <div className="space-y-6">
            {/* For HQ Power Users - Show comprehensive notification system */}
            {userProfile.organizations.org_type_code === 'HQ' && userProfile.roles.role_level <= 20 ? (
              <TabsComponent defaultValue="types" className="w-full">
                <TabsList2 className="grid w-full grid-cols-3">
                  <TabsTrigger2 value="types">Notification Types</TabsTrigger2>
                  <TabsTrigger2 value="providers">Providers</TabsTrigger2>
                  <TabsTrigger2 value="messaging">Messaging Orders</TabsTrigger2>
                </TabsList2>

                <TabsContent2 value="types" className="mt-6">
                  <NotificationTypesTab userProfile={userProfile} />
                </TabsContent2>

                <TabsContent2 value="providers" className="mt-6">
                  <NotificationProvidersTab userProfile={userProfile} />
                </TabsContent2>

                <TabsContent2 value="messaging" className="mt-6">
                  <MessagingChannelsSettingsCard />
                </TabsContent2>
              </TabsComponent>
            ) : (
              /* Regular Users - Show simple notification preferences */
              <Card>
                <CardHeader>
                  <CardTitle>Notification Preferences</CardTitle>
                  <CardDescription>
                    Choose how you want to be notified about important updates
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-4">
                    {/* Email Notifications */}
                    <div className="flex items-center justify-between p-4 rounded-lg border bg-gray-50">
                      <div className="space-y-0.5 flex-1">
                        <div className="flex items-center gap-2">
                          <Mail className="w-4 h-4 text-gray-600" />
                          <Label className="text-base font-medium">Email Notifications</Label>
                        </div>
                        <p className="text-sm text-gray-500">
                          Receive notifications via email for important updates
                        </p>
                      </div>
                      <Switch
                        checked={userSettings.email_notifications}
                        onCheckedChange={(checked) => setUserSettings({
                          ...userSettings,
                          email_notifications: checked
                        })}
                      />
                    </div>

                    {/* SMS Notifications */}
                    <div className="flex items-center justify-between p-4 rounded-lg border bg-gray-50">
                      <div className="space-y-0.5 flex-1">
                        <div className="flex items-center gap-2">
                          <Phone className="w-4 h-4 text-gray-600" />
                          <Label className="text-base font-medium">SMS Notifications</Label>
                        </div>
                        <p className="text-sm text-gray-500">
                          Receive urgent notifications via SMS
                        </p>
                      </div>
                      <Switch
                        checked={userSettings.sms_notifications}
                        onCheckedChange={(checked) => setUserSettings({
                          ...userSettings,
                          sms_notifications: checked
                        })}
                      />
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <Button onClick={handleSaveNotifications} disabled={loading}>
                      <Save className="w-4 h-4 mr-2" />
                      {loading ? 'Saving...' : 'Save Preferences'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Preferences Settings */}
        {activeTab === 'preferences' && (
          <TabsComponent defaultValue="system" className="w-full">
            <TabsList2 className="grid w-full grid-cols-3 mb-4">
              <TabsTrigger2 value="system">System Preferences</TabsTrigger2>
              <TabsTrigger2 value="document-template">Document Template</TabsTrigger2>
              <TabsTrigger2 value="doc-sequence">Doc Sequence</TabsTrigger2>
            </TabsList2>

            <TabsContent2 value="system">
              <Card>
                <CardHeader>
                  <CardTitle>System Preferences</CardTitle>
                  <CardDescription>
                    Customize your system experience and regional settings
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <Label htmlFor="timezone">Timezone</Label>
                      <Select
                        value={userSettings.timezone}
                        onValueChange={(value) => setUserSettings({ ...userSettings, timezone: value })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Asia/Kuala_Lumpur">Asia/Kuala_Lumpur (GMT+8)</SelectItem>
                          <SelectItem value="Asia/Singapore">Asia/Singapore (GMT+8)</SelectItem>
                          <SelectItem value="Asia/Jakarta">Asia/Jakarta (GMT+7)</SelectItem>
                          <SelectItem value="Asia/Bangkok">Asia/Bangkok (GMT+7)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="language">Language</Label>
                      <Select
                        value={userSettings.language}
                        onValueChange={(value) => setUserSettings({ ...userSettings, language: value })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="en">English</SelectItem>
                          <SelectItem value="ms">Bahasa Malaysia</SelectItem>
                          <SelectItem value="zh">中文</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="theme">Theme</Label>
                      <Select
                        value={theme}
                        onValueChange={(value) => {
                          setTheme(value as 'light' | 'dark')
                          setUserSettings({ ...userSettings, theme: value })
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="light">Light</SelectItem>
                          <SelectItem value="dark">Dark</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button onClick={handleSaveNotifications} disabled={loading}>
                      <Save className="w-4 h-4 mr-2" />
                      {loading ? 'Saving...' : 'Save Preferences'}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent2>


            <TabsContent2 value="document-template">
              <DocumentTemplateTab userProfile={userProfile} />
            </TabsContent2>

            <TabsContent2 value="doc-sequence">
              <DocSequenceTab userProfile={userProfile} />
            </TabsContent2>
          </TabsComponent>
        )}

        {/* Authorization Tab - Super Admin Only */}
        {activeTab === 'authorization' && userProfile.roles.role_level === 1 && (
          <AuthorizationTab userProfile={userProfile} />
        )}

        {/* Danger Zone Tab - Super Admin Only */}
        {activeTab === 'danger-zone' && (
          <DangerZoneTab userProfile={userProfile} />
        )}
      </div>
    </div>
  )
}

export default SettingsView