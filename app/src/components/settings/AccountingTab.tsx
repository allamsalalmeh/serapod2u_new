'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'
import ConfigurationTab from './ConfigurationTab'
import GLJournalView from '../accounting/GLJournalView'
import {
  Calculator,
  BookOpen,
  FileText,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Database,
  Sparkles,
  Settings2,
  Trash2,
  ShieldAlert,
  Cog
} from 'lucide-react'
import { useSaCapability } from '@/hooks/useSaCapability'

interface AccountingTabProps {
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
  /**
   * 'fiscal-year' renders only the Fiscal Year & Periods section (no GL Journals /
   * Configuration tabs) — used by Finance Settings > Fiscal Year & Periods.
   */
  view?: 'fiscal-year'
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

export default function AccountingTab({ userProfile, view }: AccountingTabProps) {
  const [activeSubTab, setActiveSubTab] = useState('gl-journals')
  const [status, setStatus] = useState<AccountingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [seeding, setSeeding] = useState(false)

  // DEV reset state
  const [resetAvailable, setResetAvailable] = useState(false)
  const [resetModalOpen, setResetModalOpen] = useState(false)
  const [resetConfirmation, setResetConfirmation] = useState('')
  const [resetting, setResetting] = useState(false)

  // Shown when Security & Access allows finance.settings.manage (the server decides the
  // operation); the historical role-level rule applies until it is enforced.
  const canManage = useSaCapability('finance.settings.manage', userProfile.roles.role_level <= 20)

  useEffect(() => {
    loadStatus()
    checkResetAvailability()
  }, [])

  const loadStatus = async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/accounting/status')
      if (response.ok) {
        const data = await response.json()
        setStatus(data)
      } else {
        console.error('Failed to load accounting status')
      }
    } catch (error) {
      console.error('Error loading accounting status:', error)
    } finally {
      setLoading(false)
    }
  }

  const checkResetAvailability = async () => {
    try {
      const response = await fetch('/api/accounting/reset')
      if (response.ok) {
        const data = await response.json()
        setResetAvailable(data.resetAvailable)
      }
    } catch (error) {
      console.error('Error checking reset availability:', error)
    }
  }

  const handleSeedAccounts = async () => {
    if (!canManage) {
      toast({
        title: 'Permission Denied',
        description: 'You need admin permissions to seed accounts',
        variant: 'destructive'
      })
      return
    }

    try {
      setSeeding(true)
      const response = await fetch('/api/accounting/accounts/seed', {
        method: 'POST'
      })

      const data = await response.json()

      if (response.ok) {
        const settingsMsg = data.settingsConfigured > 0
          ? ` Auto-configured ${data.settingsConfigured} default posting accounts.`
          : ''
        toast({
          title: 'Success',
          description: `Created ${data.created} accounts, skipped ${data.skipped} existing.${settingsMsg}`
        })
        loadStatus()
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to seed accounts',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error seeding accounts:', error)
      toast({
        title: 'Error',
        description: 'Failed to seed accounts',
        variant: 'destructive'
      })
    } finally {
      setSeeding(false)
    }
  }

  const handleReset = async () => {
    if (!canManage || !resetAvailable) {
      toast({
        title: 'Permission Denied',
        description: 'Reset is not available',
        variant: 'destructive'
      })
      return
    }

    if (resetConfirmation !== 'RESET') {
      toast({
        title: 'Confirmation Required',
        description: 'Type "RESET" to confirm',
        variant: 'destructive'
      })
      return
    }

    try {
      setResetting(true)
      const response = await fetch('/api/accounting/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmationToken: 'RESET' })
      })

      const data = await response.json()

      if (response.ok) {
        toast({
          title: 'Reset Complete',
          description: `Deleted: ${data.deleted.accounts} accounts, ${data.deleted.settings} settings, ${data.deleted.journals} journals`
        })
        setResetModalOpen(false)
        setResetConfirmation('')
        loadStatus()
        // Switch to Configuration tab to show empty state
        setActiveSubTab('configuration')
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to reset',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error resetting:', error)
      toast({
        title: 'Error',
        description: 'Failed to reset accounting setup',
        variant: 'destructive'
      })
    } finally {
      setResetting(false)
    }
  }

  const getStatusIcon = (statusType: 'ok' | 'warning' | 'error') => {
    switch (statusType) {
      case 'ok':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />
      case 'warning':
        return <AlertTriangle className="w-5 h-5 text-yellow-500" />
      case 'error':
        return <AlertCircle className="w-5 h-5 text-red-500" />
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        <span className="ml-2 text-gray-600">Loading accounting module...</span>
      </div>
    )
  }

  // If module is disabled, show disabled state
  if (!status?.enabled) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Calculator className="w-6 h-6 text-gray-400" />
            <CardTitle>Accounting Module</CardTitle>
            <Badge variant="secondary">Disabled</Badge>
          </div>
          <CardDescription>
            The accounting module is not currently enabled for this environment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-yellow-500 mt-0.5" />
              <div>
                <h4 className="font-medium text-yellow-800">Module Not Enabled</h4>
                <p className="text-sm text-yellow-700 mt-1">
                  To enable the accounting module, set the environment variable:
                </p>
                <code className="block mt-2 bg-yellow-100 px-2 py-1 rounded text-sm font-mono">
                  NEXT_PUBLIC_ACCOUNTING_ENABLED=true
                </code>
                <p className="text-sm text-yellow-700 mt-2">
                  Contact your system administrator to enable this feature.
                </p>
              </div>
            </div>
          </div>

          {/* Still show status checklist */}
          {status?.checklist && status.checklist.length > 0 && (
            <div className="mt-6">
              <h4 className="font-medium text-gray-900 mb-3">Readiness Checklist</h4>
              <div className="space-y-2">
                {status.checklist.map((item, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg"
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
          )}
        </CardContent>
      </Card>
    )
  }

  // Dedicated page: Finance Settings > Fiscal Year & Periods
  if (view === 'fiscal-year') {
    return (
      <ConfigurationTab
        userProfile={userProfile}
        status={status}
        loadStatus={loadStatus}
        canManage={canManage}
        seeding={seeding}
        handleSeedAccounts={handleSeedAccounts}
        resetAvailable={false}
        setResetModalOpen={setResetModalOpen}
        getStatusIcon={getStatusIcon}
        onlyTab="fiscal-year"
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* Sub-navigation tabs */}
      <Tabs value={activeSubTab} onValueChange={setActiveSubTab}>
        <TabsList className="grid w-full grid-cols-2 lg:w-auto lg:inline-flex">
          <TabsTrigger value="gl-journals" className="flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4" />
            GL Journals
          </TabsTrigger>
          <TabsTrigger value="configuration" className="flex items-center gap-2">
            <Cog className="w-4 h-4" />
            Configuration
          </TabsTrigger>
        </TabsList>

        {/* GL Journals Tab */}
        <TabsContent value="gl-journals" className="mt-6">
          <GLJournalView userProfile={userProfile} />
        </TabsContent>

        {/* Configuration Tab - Contains Chart of Accounts, Default Accounts, Currency, Fiscal Year, Status */}
        <TabsContent value="configuration" className="mt-6">
          <ConfigurationTab
            userProfile={userProfile}
            status={status}
            loadStatus={loadStatus}
            canManage={canManage}
            seeding={seeding}
            handleSeedAccounts={handleSeedAccounts}
            resetAvailable={resetAvailable}
            setResetModalOpen={setResetModalOpen}
            getStatusIcon={getStatusIcon}
          />
        </TabsContent>
      </Tabs>

      {/* Reset Confirmation Modal */}
      <Dialog open={resetModalOpen} onOpenChange={setResetModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <ShieldAlert className="w-5 h-5" />
              Reset Accounting Setup
            </DialogTitle>
            <DialogDescription>
              This action will permanently delete all accounting data for your company:
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
              <li>All GL accounts (Chart of Accounts)</li>
              <li>Default posting account settings</li>
              <li>Any journal entries and postings</li>
            </ul>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-yellow-600 mt-0.5" />
                <p className="text-sm text-yellow-800">
                  <strong>This is irreversible.</strong> Only use in development environment.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="reset-confirm">
                Type <strong>RESET</strong> to confirm:
              </Label>
              <Input
                id="reset-confirm"
                value={resetConfirmation}
                onChange={(e) => setResetConfirmation(e.target.value.toUpperCase())}
                placeholder="Type RESET"
                className="font-mono"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setResetModalOpen(false)
                setResetConfirmation('')
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReset}
              disabled={resetting || resetConfirmation !== 'RESET'}
            >
              {resetting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-2" />
              )}
              Reset Everything
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
