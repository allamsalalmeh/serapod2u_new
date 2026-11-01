'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from '@/components/ui/use-toast'
import ChartOfAccountsTab from './ChartOfAccountsTab'
import DefaultAccountsSettings from './DefaultAccountsSettings'
import {
  Calendar,
  DollarSign,
  Plus,
  Save,
  Loader2,
  CheckCircle2,
  Lock,
  Unlock,
  AlertCircle,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  BookOpen,
  Settings2,
  Database,
  Calculator,
  Sparkles,
  ShieldAlert,
  Trash2,
  AlertTriangle,
  Zap,
  Hand
} from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { useSaCapability } from '@/hooks/useSaCapability'
import { fiscalLegacyAllowed } from '@/lib/security-access/fiscal-period-catalog'

// Posting Mode Configuration Component
function PostingModeConfig({
  status,
  canManage,
  onStatusChange
}: {
  status: AccountingStatus | null
  canManage: boolean
  onStatusChange: () => void
}) {
  const [saving, setSaving] = useState(false)
  const currentMode = status?.posting_mode || 'MANUAL'
  const isAutoMode = currentMode === 'AUTO'

  const handleToggle = async (checked: boolean) => {
    if (!canManage) {
      toast({
        title: 'Permission Denied',
        description: 'You need admin permissions to change posting mode',
        variant: 'destructive'
      })
      return
    }

    try {
      setSaving(true)
      const newMode = checked ? 'AUTO' : 'MANUAL'

      const response = await fetch('/api/accounting/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posting_mode: newMode })
      })

      if (response.ok) {
        toast({
          title: 'Success',
          description: `Posting mode changed to ${newMode === 'AUTO' ? 'Automatic' : 'Manual'}`
        })
        onStatusChange() // Refresh status
      } else {
        const data = await response.json()
        toast({
          title: 'Error',
          description: data.error || 'Failed to change posting mode',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error changing posting mode:', error)
      toast({
        title: 'Error',
        description: 'Failed to change posting mode',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <h4 className="font-medium text-gray-900">GL Posting Mode</h4>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Manual Mode Card */}
        <div
          className={`p-4 rounded-lg border-2 transition-colors ${!isAutoMode
              ? 'border-blue-500 bg-blue-50'
              : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
            }`}
        >
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-lg ${!isAutoMode ? 'bg-blue-500' : 'bg-gray-300'}`}>
              <Hand className={`w-5 h-5 ${!isAutoMode ? 'text-white' : 'text-gray-600'}`} />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h5 className="font-medium text-gray-900">Manual Posting</h5>
                {!isAutoMode && <Badge variant="default" className="text-xs">Active</Badge>}
              </div>
              <p className="text-sm text-gray-600 mt-1">
                Review and post each document to GL individually. Full control over when entries are posted.
              </p>
              <ul className="mt-2 text-xs text-gray-500 space-y-1">
                <li>• Click "Post to GL" button for each document</li>
                <li>• Review journal preview before posting</li>
                <li>• Best for audit trails and controlled environments</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Auto Mode Card */}
        <div
          className={`p-4 rounded-lg border-2 transition-colors ${isAutoMode
              ? 'border-green-500 bg-green-50'
              : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
            }`}
        >
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-lg ${isAutoMode ? 'bg-green-500' : 'bg-gray-300'}`}>
              <Zap className={`w-5 h-5 ${isAutoMode ? 'text-white' : 'text-gray-600'}`} />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h5 className="font-medium text-gray-900">Automatic Posting</h5>
                {isAutoMode && <Badge className="text-xs bg-green-500">Active</Badge>}
              </div>
              <p className="text-sm text-gray-600 mt-1">
                Automatically post to GL when documents are created or acknowledged.
              </p>
              <ul className="mt-2 text-xs text-gray-500 space-y-1">
                <li>• Zero manual intervention required</li>
                <li>• Real-time GL updates</li>
                <li>• Best for high-volume operations</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Toggle Switch */}
      <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
        <div>
          <Label htmlFor="posting-mode" className="font-medium">
            Enable Automatic Posting
          </Label>
          <p className="text-sm text-gray-500">
            {isAutoMode
              ? 'Documents will be posted to GL automatically'
              : 'You will need to manually post each document'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
          <Switch
            id="posting-mode"
            checked={isAutoMode}
            onCheckedChange={handleToggle}
            disabled={saving || !canManage}
          />
        </div>
      </div>

      {isAutoMode && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5" />
            <div className="text-sm text-amber-700">
              <strong>Note:</strong> In auto-posting mode, journal entries cannot be modified after creation.
              Ensure your Chart of Accounts and default posting accounts are correctly configured.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface ConfigurationTabProps {
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
  status: AccountingStatus | null
  loadStatus: () => void
  canManage: boolean
  seeding: boolean
  handleSeedAccounts: () => void
  resetAvailable: boolean
  setResetModalOpen: (open: boolean) => void
  getStatusIcon: (statusType: 'ok' | 'warning' | 'error') => JSX.Element
  /** Show a single section without the tab strip (e.g. the Fiscal Year & Periods page). */
  onlyTab?: 'chart-of-accounts' | 'default-accounts' | 'currency' | 'fiscal-year' | 'status'
}

interface StatusChecklist {
  item: string
  status: 'ok' | 'warning' | 'error'
  message: string
}

interface AccountingStatus {
  enabled: boolean
  company_id: string | null
  checklist: StatusChecklist[]
  phase: string
  posting_mode?: 'MANUAL' | 'AUTO'
  features: {
    chart_of_accounts: boolean
    journals_view: boolean
    posting: boolean
    reports: boolean
  }
}

interface CurrencySettings {
  base_currency_code: string
  base_currency_name: string
  base_currency_symbol: string
  decimal_places: number
  thousand_separator: string
  decimal_separator: string
  symbol_position: string
}

interface FiscalPeriod {
  id: string
  period_number: number
  period_name: string
  start_date: string
  end_date: string
  status: 'future' | 'open' | 'closed' | 'locked'
  period_type: string
  closed_at: string | null
}

interface FiscalYear {
  id: string
  fiscal_year_name: string
  fiscal_year_code: string
  start_date: string
  end_date: string
  status: 'open' | 'closed' | 'locked'
  closed_at: string | null
  fiscal_periods: FiscalPeriod[]
}

// Common currencies for selection
const CURRENCIES = [
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM' },
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British Pound', symbol: '£' },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp' },
  { code: 'THB', name: 'Thai Baht', symbol: '฿' },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱' },
]

export default function ConfigurationTab({
  userProfile,
  status,
  loadStatus,
  canManage,
  seeding,
  handleSeedAccounts,
  resetAvailable,
  setResetModalOpen,
  getStatusIcon,
  onlyTab
}: ConfigurationTabProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [currency, setCurrency] = useState<CurrencySettings>({
    base_currency_code: 'MYR',
    base_currency_name: 'Malaysian Ringgit',
    base_currency_symbol: 'RM',
    decimal_places: 2,
    thousand_separator: ',',
    decimal_separator: '.',
    symbol_position: 'before'
  })
  const [fiscalYears, setFiscalYears] = useState<FiscalYear[]>([])
  const [expandedYears, setExpandedYears] = useState<Record<string, boolean>>({})

  // New fiscal year dialog
  const [showNewYearDialog, setShowNewYearDialog] = useState(false)
  const [newYear, setNewYear] = useState({
    fiscal_year_name: '',
    fiscal_year_code: '',
    start_date: '',
    end_date: '',
    period_type: 'monthly'
  })
  const [creatingYear, setCreatingYear] = useState(false)

  // Fiscal Year & Periods: one Security & Access permission per action (until enforced: Super Admin only).
  const fiscalLegacy = fiscalLegacyAllowed(userProfile.roles.role_level)
  const canCreateYear = useSaCapability('finance.fiscal_year.create', fiscalLegacy)
  const canOpenPeriod = useSaCapability('finance.period.open', fiscalLegacy)
  const canClosePeriod = useSaCapability('finance.period.close', fiscalLegacy)
  const canReopenPeriod = useSaCapability('finance.period.reopen', fiscalLegacy)
  const canLockYear = useSaCapability('finance.fiscal_year.lock', fiscalLegacy)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const [settingsRes, fiscalRes] = await Promise.all([
        fetch('/api/accounting/system-settings'),
        fetch('/api/accounting/fiscal-years')
      ])

      if (settingsRes.ok) {
        const data = await settingsRes.json()
        setCurrency(data.currency)
      }

      if (fiscalRes.ok) {
        const data = await fiscalRes.json()
        setFiscalYears(data.fiscalYears || [])
        // Auto-expand current fiscal year
        const currentYear = data.fiscalYears?.find((fy: FiscalYear) =>
          fy.status === 'open' &&
          new Date() >= new Date(fy.start_date) &&
          new Date() <= new Date(fy.end_date)
        )
        if (currentYear) {
          setExpandedYears({ [currentYear.id]: true })
        }
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
  }

  const handleCurrencyChange = (code: string) => {
    const selected = CURRENCIES.find(c => c.code === code)
    if (selected) {
      setCurrency({
        ...currency,
        base_currency_code: selected.code,
        base_currency_name: selected.name,
        base_currency_symbol: selected.symbol
      })
    }
  }

  const saveCurrencySettings = async () => {
    if (!canManage) return

    try {
      setSaving(true)
      const response = await fetch('/api/accounting/system-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currency)
      })

      if (response.ok) {
        toast({
          title: 'Success',
          description: 'Currency settings saved'
        })
      } else {
        const data = await response.json()
        toast({
          title: 'Error',
          description: data.error || 'Failed to save settings',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error saving currency:', error)
      toast({
        title: 'Error',
        description: 'Failed to save settings',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  const createFiscalYear = async () => {
    if (!canManage) return

    // Validate
    if (!newYear.fiscal_year_name || !newYear.fiscal_year_code || !newYear.start_date || !newYear.end_date) {
      toast({
        title: 'Validation Error',
        description: 'Please fill in all required fields',
        variant: 'destructive'
      })
      return
    }

    try {
      setCreatingYear(true)
      const response = await fetch('/api/accounting/fiscal-years', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newYear,
          generate_periods: true
        })
      })

      const data = await response.json()

      if (response.ok) {
        toast({
          title: 'Success',
          description: `Created ${data.fiscalYear.fiscal_year_name} with ${data.periodsCreated} periods`
        })
        setShowNewYearDialog(false)
        setNewYear({
          fiscal_year_name: '',
          fiscal_year_code: '',
          start_date: '',
          end_date: '',
          period_type: 'monthly'
        })
        loadData()
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to create fiscal year',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error creating fiscal year:', error)
      toast({
        title: 'Error',
        description: 'Failed to create fiscal year',
        variant: 'destructive'
      })
    } finally {
      setCreatingYear(false)
    }
  }

  const updatePeriodStatus = async (fiscalYearId: string, periodId: string, newStatus: string) => {
    if (!canManage) return

    try {
      const response = await fetch(`/api/accounting/fiscal-years/${fiscalYearId}/periods/${periodId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      })

      if (response.ok) {
        toast({
          title: 'Success',
          description: `Period ${newStatus}`
        })
        loadData()
      } else {
        const data = await response.json()
        toast({
          title: 'Error',
          description: data.error || 'Failed to update period',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error updating period:', error)
    }
  }

  const updateFiscalYearStatus = async (id: string, newStatus: string) => {
    if (!canManage) return

    try {
      const response = await fetch(`/api/accounting/fiscal-years/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      })

      if (response.ok) {
        toast({
          title: 'Success',
          description: `Fiscal year ${newStatus}`
        })
        loadData()
      } else {
        const data = await response.json()
        toast({
          title: 'Error',
          description: data.error || 'Failed to update fiscal year',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error updating fiscal year:', error)
    }
  }

  const getStatusBadge = (statusValue: string) => {
    switch (statusValue) {
      case 'open':
        return <Badge className="bg-green-100 text-green-700 border-green-200">Open</Badge>
      case 'closed':
        return <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200">Closed</Badge>
      case 'locked':
        return <Badge className="bg-red-100 text-red-700 border-red-200">Locked</Badge>
      case 'future':
        return <Badge className="bg-gray-100 text-gray-600 border-gray-200">Future</Badge>
      default:
        return <Badge variant="outline">{statusValue}</Badge>
    }
  }

  const toggleYearExpand = (id: string) => {
    setExpandedYears(prev => ({ ...prev, [id]: !prev[id] }))
  }

  // Auto-generate year details when dates change
  const handleStartDateChange = (date: string) => {
    setNewYear(prev => {
      const startDate = new Date(date)
      const year = startDate.getFullYear()
      const endDate = new Date(year, 11, 31) // Dec 31

      return {
        ...prev,
        start_date: date,
        end_date: format(endDate, 'yyyy-MM-dd'),
        fiscal_year_name: `Financial Year ${year}`,
        fiscal_year_code: `FY${year}`
      }
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        <span className="ml-2 text-gray-600">Loading configuration...</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Tabs
        {...(onlyTab ? { value: onlyTab } : { defaultValue: 'chart-of-accounts' })}
        className="space-y-4"
      >
        <TabsList className={onlyTab ? 'hidden' : 'grid w-full grid-cols-5 lg:w-auto lg:inline-flex'}>
          <TabsTrigger value="chart-of-accounts" className="flex items-center gap-2">
            <BookOpen className="w-4 h-4" />
            Chart of Accounts
          </TabsTrigger>
          <TabsTrigger value="default-accounts" className="flex items-center gap-2">
            <Settings2 className="w-4 h-4" />
            Default Accounts
          </TabsTrigger>
          <TabsTrigger value="currency" className="flex items-center gap-2">
            <DollarSign className="w-4 h-4" />
            Currency
          </TabsTrigger>
          <TabsTrigger value="fiscal-year" className="flex items-center gap-2">
            <Calendar className="w-4 h-4" />
            Fiscal Year
          </TabsTrigger>
          <TabsTrigger value="status" className="flex items-center gap-2">
            <Database className="w-4 h-4" />
            Status
          </TabsTrigger>
        </TabsList>

        {/* Chart of Accounts Tab */}
        <TabsContent value="chart-of-accounts">
          <ChartOfAccountsTab userProfile={userProfile} />
        </TabsContent>

        {/* Default Accounts Tab */}
        <TabsContent value="default-accounts">
          <DefaultAccountsSettings userProfile={userProfile} />
        </TabsContent>

        {/* Currency Settings */}
        <TabsContent value="currency">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-green-500" />
                Currency Settings
              </CardTitle>
              <CardDescription>
                Configure the base currency for your accounting system.
                This affects how amounts are displayed throughout the system.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="currency">Base Currency</Label>
                  <Select
                    value={currency.base_currency_code}
                    onValueChange={handleCurrencyChange}
                    disabled={!canManage}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select currency" />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map(c => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.symbol} {c.code} - {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-sm text-gray-500">
                    All financial transactions will be recorded in this currency
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="decimal_places">Decimal Places</Label>
                  <Select
                    value={currency.decimal_places.toString()}
                    onValueChange={(v) => setCurrency({ ...currency, decimal_places: parseInt(v) })}
                    disabled={!canManage}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">0 (Whole numbers)</SelectItem>
                      <SelectItem value="2">2 (Standard)</SelectItem>
                      <SelectItem value="3">3 (High precision)</SelectItem>
                      <SelectItem value="4">4 (Maximum precision)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="symbol_position">Symbol Position</Label>
                  <Select
                    value={currency.symbol_position}
                    onValueChange={(v) => setCurrency({ ...currency, symbol_position: v })}
                    disabled={!canManage}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="before">Before amount (RM 1,000.00)</SelectItem>
                      <SelectItem value="after">After amount (1,000.00 RM)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Number Format Preview</Label>
                  <div className="p-3 bg-gray-50 rounded-lg font-mono text-lg">
                    {currency.symbol_position === 'before' ? currency.base_currency_symbol + ' ' : ''}
                    1{currency.thousand_separator}234{currency.decimal_separator}{'0'.repeat(currency.decimal_places)}
                    {currency.symbol_position === 'after' ? ' ' + currency.base_currency_symbol : ''}
                  </div>
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-5 h-5 text-blue-500 mt-0.5" />
                  <div>
                    <h4 className="font-medium text-blue-800">Important Note</h4>
                    <p className="text-sm text-blue-700 mt-1">
                      Changing the base currency after transactions have been posted is not recommended.
                      This setting is primarily for display purposes and does not support multi-currency transactions.
                    </p>
                  </div>
                </div>
              </div>

              {canManage && (
                <div className="flex justify-end">
                  <Button onClick={saveCurrencySettings} disabled={saving}>
                    {saving ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4 mr-2" />
                    )}
                    Save Currency Settings
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Fiscal Year Settings */}
        <TabsContent value="fiscal-year">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Calendar className="w-5 h-5 text-purple-500" />
                    Fiscal Year Management
                  </CardTitle>
                  <CardDescription>
                    Define fiscal years and manage accounting periods for proper financial closing
                  </CardDescription>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                  <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={loadData}>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Refresh
                  </Button>
                  {canCreateYear && (
                    <Dialog open={showNewYearDialog} onOpenChange={setShowNewYearDialog}>
                      <DialogTrigger asChild>
                        <Button className="w-full sm:w-auto">
                          <Plus className="w-4 h-4 mr-2" />
                          New Fiscal Year
                        </Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-md">
                        <DialogHeader>
                          <DialogTitle>Create Fiscal Year</DialogTitle>
                          <DialogDescription>
                            Define a new fiscal year. Monthly periods will be auto-generated.
                          </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-4 py-4">
                          <div className="space-y-2">
                            <Label htmlFor="start_date">Start Date *</Label>
                            <Input
                              id="start_date"
                              type="date"
                              value={newYear.start_date}
                              onChange={(e) => handleStartDateChange(e.target.value)}
                            />
                            <p className="text-xs text-gray-500">
                              Tip: Enter Jan 1st for calendar year, or your fiscal year start
                            </p>
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="end_date">End Date *</Label>
                            <Input
                              id="end_date"
                              type="date"
                              value={newYear.end_date}
                              onChange={(e) => setNewYear({ ...newYear, end_date: e.target.value })}
                            />
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="fiscal_year_name">Fiscal Year Name *</Label>
                            <Input
                              id="fiscal_year_name"
                              value={newYear.fiscal_year_name}
                              onChange={(e) => setNewYear({ ...newYear, fiscal_year_name: e.target.value })}
                              placeholder="e.g., Financial Year 2026"
                            />
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="fiscal_year_code">Fiscal Year Code *</Label>
                            <Input
                              id="fiscal_year_code"
                              value={newYear.fiscal_year_code}
                              onChange={(e) => setNewYear({ ...newYear, fiscal_year_code: e.target.value.toUpperCase() })}
                              placeholder="e.g., FY2026"
                            />
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="period_type">Period Type</Label>
                            <Select
                              value={newYear.period_type}
                              onValueChange={(v) => setNewYear({ ...newYear, period_type: v })}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="monthly">Monthly (12 periods)</SelectItem>
                                <SelectItem value="quarterly">Quarterly (4 periods)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <DialogFooter>
                          <Button variant="outline" onClick={() => setShowNewYearDialog(false)}>
                            Cancel
                          </Button>
                          <Button onClick={createFiscalYear} disabled={creatingYear}>
                            {creatingYear ? (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                              <Plus className="w-4 h-4 mr-2" />
                            )}
                            Create Fiscal Year
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {fiscalYears.length === 0 ? (
                <div className="text-center py-12 bg-gray-50 rounded-lg">
                  <CalendarDays className="w-12 h-12 mx-auto text-gray-400 mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No Fiscal Years Defined</h3>
                  <p className="text-gray-500 mb-4">
                    Create your first fiscal year to start managing accounting periods.
                  </p>
                  {canCreateYear && (
                    <Button onClick={() => setShowNewYearDialog(true)}>
                      <Plus className="w-4 h-4 mr-2" />
                      Create Fiscal Year
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {fiscalYears.map((fy) => (
                    <div
                      key={fy.id}
                      className="border rounded-lg overflow-hidden"
                    >
                      {/* Fiscal Year Header */}
                      <div
                        className={`p-4 cursor-pointer hover:bg-gray-50 transition-colors ${expandedYears[fy.id] ? 'bg-gray-50' : ''
                          }`}
                        onClick={() => toggleYearExpand(fy.id)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            {expandedYears[fy.id] ? (
                              <ChevronDown className="w-5 h-5 text-gray-400" />
                            ) : (
                              <ChevronRight className="w-5 h-5 text-gray-400" />
                            )}
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="font-medium">{fy.fiscal_year_name}</h3>
                                <Badge variant="outline" className="text-xs">{fy.fiscal_year_code}</Badge>
                                {getStatusBadge(fy.status)}
                              </div>
                              <p className="text-sm text-gray-500 mt-1">
                                {format(parseISO(fy.start_date), 'MMM d, yyyy')} - {format(parseISO(fy.end_date), 'MMM d, yyyy')}
                                {fy.fiscal_periods && (
                                  <span className="ml-2">• {fy.fiscal_periods.length} periods</span>
                                )}
                              </p>
                            </div>
                          </div>

                          {fy.status !== 'locked' && (
                            <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                              {fy.status === 'open' && canClosePeriod && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => updateFiscalYearStatus(fy.id, 'closed')}
                                >
                                  <Lock className="w-4 h-4 mr-1" />
                                  Close Year
                                </Button>
                              )}
                              {fy.status === 'closed' && canReopenPeriod && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => updateFiscalYearStatus(fy.id, 'open')}
                                >
                                  <Unlock className="w-4 h-4 mr-1" />
                                  Reopen
                                </Button>
                              )}
                              {fy.status === 'closed' && canLockYear && (
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => updateFiscalYearStatus(fy.id, 'locked')}
                                >
                                  <Lock className="w-4 h-4 mr-1" />
                                  Lock Permanently
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Periods (Expanded) */}
                      {expandedYears[fy.id] && fy.fiscal_periods && (
                        <div className="border-t bg-white">
                          <div className="p-4">
                            <h4 className="text-sm font-medium text-gray-700 mb-3">Accounting Periods</h4>
                            <div className="space-y-2">
                              {fy.fiscal_periods.map((period) => {
                                const isCurrentPeriod =
                                  new Date() >= new Date(period.start_date) &&
                                  new Date() <= new Date(period.end_date)

                                return (
                                  <div
                                    key={period.id}
                                    className={`flex items-center justify-between p-3 rounded-lg ${isCurrentPeriod ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50'
                                      }`}
                                  >
                                    <div className="flex items-center gap-3">
                                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${period.status === 'open' ? 'bg-green-100 text-green-700' :
                                          period.status === 'closed' ? 'bg-yellow-100 text-yellow-700' :
                                            period.status === 'locked' ? 'bg-red-100 text-red-700' :
                                              'bg-gray-100 text-gray-600'
                                        }`}>
                                        {period.period_number}
                                      </div>
                                      <div>
                                        <div className="flex items-center gap-2">
                                          <span className="font-medium">{period.period_name}</span>
                                          {isCurrentPeriod && (
                                            <Badge className="bg-blue-100 text-blue-700 text-xs">Current</Badge>
                                          )}
                                        </div>
                                        <span className="text-sm text-gray-500">
                                          {format(parseISO(period.start_date), 'MMM d')} - {format(parseISO(period.end_date), 'MMM d, yyyy')}
                                        </span>
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                      {getStatusBadge(period.status)}

                                      {fy.status !== 'locked' && (
                                        <>
                                          {period.status === 'future' && canOpenPeriod && (
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              title="Open period"
                                              onClick={() => updatePeriodStatus(fy.id, period.id, 'open')}
                                            >
                                              <Unlock className="w-4 h-4" />
                                            </Button>
                                          )}
                                          {period.status === 'open' && canClosePeriod && (
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              title="Close period"
                                              onClick={() => updatePeriodStatus(fy.id, period.id, 'closed')}
                                            >
                                              <Lock className="w-4 h-4" />
                                            </Button>
                                          )}
                                          {period.status === 'closed' && canReopenPeriod && (
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              title="Reopen closed period"
                                              onClick={() => updatePeriodStatus(fy.id, period.id, 'open')}
                                            >
                                              <Unlock className="w-4 h-4" />
                                            </Button>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Help Section */}
              <div className="mt-6 bg-purple-50 border border-purple-200 rounded-lg p-4">
                <h4 className="font-medium text-purple-800 mb-2">📅 Understanding Fiscal Periods</h4>
                <ul className="text-sm text-purple-700 space-y-1">
                  <li><strong>Future:</strong> Period not yet started - no transactions can be posted</li>
                  <li><strong>Open:</strong> Active period - normal posting allowed</li>
                  <li><strong>Closed:</strong> Period closed for month-end - can be reopened if needed</li>
                  <li><strong>Locked:</strong> Permanently locked - no changes allowed (for audit)</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Status Tab */}
        <TabsContent value="status">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Calculator className="w-6 h-6 text-blue-500" />
                  <CardTitle>Accounting Module Status</CardTitle>
                  <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                    {status?.phase || 'Phase 1'}
                  </Badge>
                </div>
                <Button variant="outline" size="sm" onClick={loadStatus}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Refresh
                </Button>
              </div>
              <CardDescription>
                Monitor the accounting module configuration and readiness
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Readiness Checklist */}
              <div>
                <h4 className="font-medium text-gray-900 mb-3">Readiness Checklist</h4>
                <div className="space-y-2">
                  {status?.checklist?.map((item, index) => (
                    <div
                      key={index}
                      className={`flex items-start gap-3 p-3 rounded-lg ${item.status === 'ok' ? 'bg-green-50' :
                          item.status === 'warning' ? 'bg-yellow-50' :
                            'bg-red-50'
                        }`}
                    >
                      {getStatusIcon(item.status)}
                      <div>
                        <p className="font-medium text-gray-900">{item.item}</p>
                        <p className="text-sm text-gray-600">{item.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick Actions */}
              {canManage && (
                <div>
                  <h4 className="font-medium text-gray-900 mb-3">Quick Actions</h4>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      variant="outline"
                      onClick={handleSeedAccounts}
                      disabled={seeding}
                    >
                      {seeding ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Sparkles className="w-4 h-4 mr-2" />
                      )}
                      Seed Default Accounts
                    </Button>
                  </div>
                  <p className="text-sm text-gray-500 mt-2">
                    Seed the default Chart of Accounts template. This is idempotent and won't duplicate existing accounts.
                  </p>
                </div>
              )}

              {/* Feature Status */}
              <div>
                <h4 className="font-medium text-gray-900 mb-3">Feature Status</h4>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className={`p-3 rounded-lg ${status?.features?.chart_of_accounts ? 'bg-green-50' : 'bg-gray-50'}`}>
                    <div className="flex items-center gap-2">
                      {status?.features?.chart_of_accounts ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-gray-400" />
                      )}
                      <span className="text-sm font-medium">Chart of Accounts</span>
                    </div>
                  </div>
                  <div className={`p-3 rounded-lg ${status?.features?.journals_view ? 'bg-green-50' : 'bg-gray-50'}`}>
                    <div className="flex items-center gap-2">
                      {status?.features?.journals_view ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-gray-400" />
                      )}
                      <span className="text-sm font-medium">Journals View</span>
                    </div>
                  </div>
                  <div className={`p-3 rounded-lg ${status?.features?.posting ? 'bg-green-50' : 'bg-gray-50'}`}>
                    <div className="flex items-center gap-2">
                      {status?.features?.posting ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-gray-400" />
                      )}
                      <span className="text-sm font-medium">GL Posting</span>
                    </div>
                  </div>
                  <div className={`p-3 rounded-lg ${status?.features?.reports ? 'bg-green-50' : 'bg-gray-50'}`}>
                    <div className="flex items-center gap-2">
                      {status?.features?.reports ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-gray-400" />
                      )}
                      <span className="text-sm font-medium">Reports</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Phase Information */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h4 className="font-medium text-blue-800 mb-2">Current Phase: Manual Posting</h4>
                <p className="text-sm text-blue-700">
                  Phase 2 provides GL posting and journal management. Financial reports
                  will be available in Phase 3.
                </p>
                <div className="mt-3 text-xs text-blue-600">
                  <strong>Roadmap:</strong> <span className="line-through">Phase 1 (Foundation)</span> → <strong className="text-blue-800">Phase 2 (Manual Posting)</strong> → Phase 3 (Reports) → Phase 4 (Inventory/COGS)
                </div>
              </div>

              {/* Posting Mode Configuration */}
              <PostingModeConfig
                status={status}
                canManage={canManage}
                onStatusChange={loadStatus}
              />

              {/* DEV-ONLY: Reset Section */}
              {resetAvailable && canManage && (
                <div className="border-t pt-6">
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <ShieldAlert className="w-5 h-5 text-red-500 mt-0.5" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="font-medium text-red-800">DEV-ONLY: Reset Accounting Setup</h4>
                          <Badge variant="outline" className="bg-red-100 text-red-700 border-red-300 text-xs">
                            Development
                          </Badge>
                        </div>
                        <p className="text-sm text-red-700 mb-3">
                          Clear all accounting data for this company. This will delete all accounts,
                          settings, and any journal entries. Use this for rapid dev iteration.
                        </p>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setResetModalOpen(true)}
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Reset Accounting Setup
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
