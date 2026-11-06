'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/use-toast'
import {
  Loader2,
  Save,
  Settings2,
  AlertCircle,
  CheckCircle2,
  Info
} from 'lucide-react'
import { 
  GLAccount, 
  GLSettings, 
  GLSettingsUpdate, 
  GLSettingsWithAccounts,
  CONTROL_ACCOUNT_CONFIGS,
  ControlAccountConfig
} from '@/types/accounting'
import { useSaCapability } from '@/hooks/useSaCapability'

interface DefaultAccountsSettingsProps {
  userProfile: {
    id: string
    organizations: {
      id: string
      org_type_code: string
    }
    roles: {
      role_level: number
    }
  }
}

export default function DefaultAccountsSettings({ userProfile }: DefaultAccountsSettingsProps) {
  const [settings, setSettings] = useState<GLSettingsWithAccounts | null>(null)
  const [accounts, setAccounts] = useState<GLAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [formData, setFormData] = useState<GLSettingsUpdate>({})
  const [hasChanges, setHasChanges] = useState(false)

  // Shown when Security & Access allows finance.settings.manage (the server decides the
  // operation); the historical role-level rule applies until it is enforced.
  const canManage = useSaCapability('finance.settings.manage', userProfile.roles.role_level <= 20)

  // Load settings and accounts
  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      
      // Load settings and accounts in parallel
      const [settingsRes, accountsRes] = await Promise.all([
        fetch('/api/accounting/settings'),
        fetch('/api/accounting/accounts?pageSize=200&isActive=true')
      ])

      if (settingsRes.ok) {
        const settingsData = await settingsRes.json()
        setSettings(settingsData.settings)
        
        // Initialize form data from existing settings
        if (settingsData.settings) {
          setFormData({
            cash_account_id: settingsData.settings.cash_account_id,
            ar_control_account_id: settingsData.settings.ar_control_account_id,
            ap_control_account_id: settingsData.settings.ap_control_account_id,
            supplier_deposit_account_id: settingsData.settings.supplier_deposit_account_id,
            sales_revenue_account_id: settingsData.settings.sales_revenue_account_id,
            cogs_account_id: settingsData.settings.cogs_account_id,
            inventory_account_id: settingsData.settings.inventory_account_id,
            require_supplier_ack_for_payment_posting: !!settingsData.settings.require_supplier_ack_for_payment_posting,
          })
        }
      }

      if (accountsRes.ok) {
        const accountsData = await accountsRes.json()
        setAccounts(accountsData.accounts || [])
      }
    } catch (error) {
      console.error('Error loading data:', error)
      toast({
        title: 'Error',
        description: 'Failed to load settings',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Handle account selection change
  const handleAccountChange = (key: keyof GLSettingsUpdate, value: string | null) => {
    setFormData(prev => ({
      ...prev,
      [key]: value === 'none' ? null : value
    }))
    setHasChanges(true)
  }

  // Save settings
  const handleSave = async () => {
    if (!canManage) {
      toast({
        title: 'Permission Denied',
        description: 'You need admin permissions to save settings',
        variant: 'destructive'
      })
      return
    }

    try {
      setSaving(true)
      
      const response = await fetch('/api/accounting/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })

      const data = await response.json()

      if (response.ok) {
        toast({
          title: 'Success',
          description: 'Accounting settings saved successfully'
        })
        setSettings(data.settings)
        setHasChanges(false)
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to save settings',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error saving settings:', error)
      toast({
        title: 'Error',
        description: 'Failed to save settings',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  // Filter accounts by type
  const getAccountsForConfig = (config: ControlAccountConfig) => {
    return accounts.filter(account => 
      config.accountTypes.includes(account.account_type)
    )
  }

  // Get current value for a setting
  const getCurrentValue = (key: keyof GLSettingsUpdate): string => {
    const value = formData[key]
    return typeof value === 'string' && value ? value : 'none'
  }

  const handleRequireAckChange = (checked: boolean) => {
    setFormData(prev => ({ ...prev, require_supplier_ack_for_payment_posting: checked }))
    setHasChanges(true)
  }

  // Count configured required accounts
  const configuredRequiredCount = CONTROL_ACCOUNT_CONFIGS
    .filter(c => c.requiredForPosting)
    .filter(c => formData[c.key])
    .length
  const totalRequiredCount = CONTROL_ACCOUNT_CONFIGS.filter(c => c.requiredForPosting).length

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        <span className="ml-2 text-gray-600">Loading settings...</span>
      </div>
    )
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Settings2 className="w-6 h-6 text-gray-400" />
            <CardTitle className="text-lg">Default Posting Accounts</CardTitle>
          </div>
          <CardDescription>
            Configure which GL accounts to use for different transaction types
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-yellow-500 mt-0.5" />
              <div>
                <h4 className="font-medium text-yellow-800">No Accounts Available</h4>
                <p className="text-sm text-yellow-700 mt-1">
                  You need to create accounts in the Chart of Accounts before configuring default posting accounts.
                </p>
                <p className="text-sm text-yellow-700 mt-2">
                  Go to <strong>Chart of Accounts</strong> tab and click "Create Starter Accounts" to get started.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings2 className="w-6 h-6 text-blue-500" />
            <div>
              <CardTitle className="text-lg">Default Posting Accounts</CardTitle>
              <CardDescription>
                Configure which GL accounts to use for different transaction types
              </CardDescription>
            </div>
          </div>
          {canManage && (
            <Button 
              onClick={handleSave} 
              disabled={saving || !hasChanges}
            >
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Settings
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Progress indicator */}
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">
              Configuration Progress
            </span>
            <Badge variant={configuredRequiredCount === totalRequiredCount ? 'default' : 'secondary'}>
              {configuredRequiredCount} / {totalRequiredCount} Required
            </Badge>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div 
              className="bg-blue-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${(configuredRequiredCount / totalRequiredCount) * 100}%` }}
            />
          </div>
          {configuredRequiredCount < totalRequiredCount && (
            <p className="text-xs text-gray-500 mt-2">
              Configure all required accounts before GL posting can be enabled (Phase 2)
            </p>
          )}
        </div>

        {/* Phase info */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <Info className="w-4 h-4 text-blue-500 mt-0.5" />
            <p className="text-sm text-blue-700">
              These settings are configuration only (Phase 1). Actual GL posting will be available in Phase 2.
            </p>
          </div>
        </div>

        {/* Account mappings */}
        <div className="grid gap-6">
          {CONTROL_ACCOUNT_CONFIGS.map((config) => {
            const availableAccounts = getAccountsForConfig(config)
            const currentValue = getCurrentValue(config.key)
            const isConfigured = currentValue !== 'none'

            return (
              <div key={config.key} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Label htmlFor={config.key} className="font-medium">
                    {config.label}
                  </Label>
                  {config.requiredForPosting ? (
                    <Badge variant="outline" className="text-xs">Required</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs">Optional</Badge>
                  )}
                  {isConfigured && (
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  )}
                </div>
                <p className="text-sm text-gray-500">{config.description}</p>
                
                <Select
                  value={currentValue}
                  onValueChange={(value) => handleAccountChange(config.key, value)}
                  disabled={!canManage}
                >
                  <SelectTrigger className="w-full md:w-[400px]">
                    <SelectValue placeholder="Select an account..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      <span className="text-gray-400">-- Not configured --</span>
                    </SelectItem>
                    {availableAccounts.map(account => (
                      <SelectItem key={account.id} value={account.id}>
                        <span className="font-mono">{account.code}</span>
                        <span className="mx-2">-</span>
                        <span>{account.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {availableAccounts.length === 0 && (
                  <p className="text-xs text-yellow-600">
                    No {config.accountTypes.join('/')} type accounts available. Create accounts first.
                  </p>
                )}
              </div>
            )
          })}
        </div>

        {/* Supplier payment posting rule */}
        <div className="border-t pt-6 space-y-2">
          <div className="flex items-start gap-3">
            <input
              id="require_supplier_ack_for_payment_posting"
              type="checkbox"
              className="mt-1 h-4 w-4"
              checked={!!formData.require_supplier_ack_for_payment_posting}
              onChange={(e) => handleRequireAckChange(e.target.checked)}
              disabled={!canManage}
            />
            <div>
              <Label htmlFor="require_supplier_ack_for_payment_posting" className="font-medium">
                Post supplier payments only after the supplier acknowledges them
              </Label>
              <p className="text-sm text-gray-500">
                When on, a supplier payment cannot be posted to the GL until the supplier has acknowledged the payment document. When off, payments can be posted as soon as HQ records them.
              </p>
            </div>
          </div>
        </div>

        {/* Usage notes */}
        <div className="border-t pt-6 mt-6">
          <h4 className="font-medium text-gray-900 mb-3">How these accounts will be used</h4>
          <div className="grid gap-4 text-sm text-gray-600">
            <div className="flex gap-2">
              <span className="font-medium text-gray-700 w-40">AR Control:</span>
              <span>Debited when invoicing distributors, credited when receiving payments</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-gray-700 w-40">AP Control:</span>
              <span>Credited when receiving manufacturer invoices, debited on payment</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-gray-700 w-40">Inventory:</span>
              <span>Debited when manufacturer invoices are posted (purchases go to stock)</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-gray-700 w-40">Supplier Deposits:</span>
              <span>Debited for 30/70 or 50/50 deposit payments, cleared on final payment</span>
            </div>
            <div className="flex gap-2">
              <span className="font-medium text-gray-700 w-40">Cash/Bank:</span>
              <span>Default account for all cash receipts and payments</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
