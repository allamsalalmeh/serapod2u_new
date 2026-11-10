'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'
import {
  Loader2,
  Save,
  Plus,
  Trash2,
  Pencil,
  Zap,
  Hand,
  Settings2,
  FileText,
  Receipt,
  CreditCard,
  Wallet,
  ArrowUpFromLine,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Info,
  RefreshCw,
} from 'lucide-react'
import { POSTING_TYPES, POSTING_TYPE_COLORS, type PostingTypeInfo } from '@/modules/finance/postingMap'
import type { GLPostingMode } from '@/types/accounting'
import { useSaCapability } from '@/hooks/useSaCapability'

// ── Types ─────────────────────────────────────────────────────────

interface PostingRule {
  id: string
  company_id: string
  rule_code: string
  rule_name: string
  description: string | null
  document_type: string
  posting_config: Record<string, any>
  is_active: boolean
  created_at: string
  updated_at: string
}

interface PostingRulesSettingsProps {
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

// ── Document Type Options ────────────────────────────────────────

const DOCUMENT_TYPE_OPTIONS = [
  { value: 'SALES_INVOICE', label: 'Sales Invoice', icon: Receipt, color: 'blue' },
  { value: 'RECEIPT', label: 'Customer Receipt', icon: CreditCard, color: 'green' },
  { value: 'SUPPLIER_DEPOSIT', label: 'Supplier Deposit', icon: ArrowUpFromLine, color: 'purple' },
  { value: 'SUPPLIER_PAYMENT', label: 'Supplier Payment', icon: Wallet, color: 'orange' },
]

// ── Main Component ──────────────────────────────────────────────

export default function PostingRulesSettings({ userProfile }: PostingRulesSettingsProps) {
  const [loading, setLoading] = useState(true)
  const [rules, setRules] = useState<PostingRule[]>([])
  const [postingMode, setPostingMode] = useState<GLPostingMode>('MANUAL')
  const [saving, setSaving] = useState(false)
  const [modeChanging, setModeChanging] = useState(false)

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<PostingRule | null>(null)
  const [formData, setFormData] = useState({
    rule_code: '',
    rule_name: '',
    description: '',
    document_type: '',
    is_active: true,
    posting_config: {} as Record<string, any>,
  })

  // Shown when Security & Access allows finance.settings.manage (the server decides the
  // operation); the historical role-level rule applies until it is enforced.
  const canManage = useSaCapability('finance.settings.manage', userProfile.roles.role_level <= 20)

  // ── Load Data ───────────────────────────────────────────────

  const loadData = useCallback(async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/accounting/posting-rules')
      if (response.ok) {
        const data = await response.json()
        setRules(data.rules || [])
        setPostingMode(data.posting_mode || 'MANUAL')
      } else if (response.status === 403) {
        // Module not enabled - show empty state
        setRules([])
      } else {
        const data = await response.json()
        toast({ title: 'Error', description: data.error || 'Failed to load posting rules', variant: 'destructive' })
      }
    } catch (error) {
      console.error('Error loading posting rules:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // ── Toggle Posting Mode ─────────────────────────────────────

  const handleModeToggle = async (checked: boolean) => {
    if (!canManage) {
      toast({ title: 'Permission Denied', description: 'Admin permissions required.', variant: 'destructive' })
      return
    }

    const newMode: GLPostingMode = checked ? 'AUTO' : 'MANUAL'
    try {
      setModeChanging(true)
      const response = await fetch('/api/accounting/posting-rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posting_mode: newMode }),
      })

      if (response.ok) {
        setPostingMode(newMode)
        toast({
          title: 'Posting Mode Updated',
          description: `Posting mode changed to ${newMode === 'AUTO' ? 'Automatic' : 'Manual'}`,
        })
      } else {
        const data = await response.json()
        toast({ title: 'Error', description: data.error || 'Failed to update posting mode', variant: 'destructive' })
      }
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to update posting mode', variant: 'destructive' })
    } finally {
      setModeChanging(false)
    }
  }

  // ── Open Create/Edit Dialog ─────────────────────────────────

  const openCreateDialog = () => {
    setEditingRule(null)
    setFormData({
      rule_code: '',
      rule_name: '',
      description: '',
      document_type: '',
      is_active: true,
      posting_config: {},
    })
    setDialogOpen(true)
  }

  const openEditDialog = (rule: PostingRule) => {
    setEditingRule(rule)
    setFormData({
      rule_code: rule.rule_code,
      rule_name: rule.rule_name,
      description: rule.description || '',
      document_type: rule.document_type,
      is_active: rule.is_active,
      posting_config: rule.posting_config || {},
    })
    setDialogOpen(true)
  }

  // ── Save Rule ───────────────────────────────────────────────

  const handleSaveRule = async () => {
    if (!formData.rule_code || !formData.rule_name || !formData.document_type) {
      toast({ title: 'Validation Error', description: 'Rule code, name, and document type are required.', variant: 'destructive' })
      return
    }

    try {
      setSaving(true)
      const response = await fetch('/api/accounting/posting-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })

      if (response.ok) {
        toast({ title: 'Success', description: editingRule ? 'Posting rule updated' : 'Posting rule created' })
        setDialogOpen(false)
        loadData()
      } else {
        const data = await response.json()
        toast({ title: 'Error', description: data.error || 'Failed to save rule', variant: 'destructive' })
      }
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to save rule', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  // ── Delete Rule ─────────────────────────────────────────────

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('Delete this posting rule?')) return

    try {
      const response = await fetch(`/api/accounting/posting-rules?id=${ruleId}`, { method: 'DELETE' })
      if (response.ok) {
        toast({ title: 'Deleted', description: 'Posting rule deleted' })
        loadData()
      } else {
        const data = await response.json()
        toast({ title: 'Error', description: data.error || 'Failed to delete', variant: 'destructive' })
      }
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to delete rule', variant: 'destructive' })
    }
  }

  // ── Toggle Rule Active Status ───────────────────────────────

  const handleToggleActive = async (rule: PostingRule) => {
    try {
      const response = await fetch('/api/accounting/posting-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...rule,
          is_active: !rule.is_active,
        }),
      })

      if (response.ok) {
        toast({ title: 'Updated', description: `Rule ${!rule.is_active ? 'enabled' : 'disabled'}` })
        loadData()
      }
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to toggle rule', variant: 'destructive' })
    }
  }

  // ── Get Posting Type Info ───────────────────────────────────

  const getDocTypeInfo = (docType: string) => {
    return DOCUMENT_TYPE_OPTIONS.find((d) => d.value === docType) || { label: docType, color: 'gray' }
  }

  const getPostingTypeEntry = (docType: string): PostingTypeInfo | undefined => {
    return POSTING_TYPES.find((t) => t.code === docType || t.code.startsWith(docType.replace('_PAYMENT', '')))
  }

  // ── Loading State ───────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        <span className="ml-2 text-gray-600">Loading posting rules...</span>
      </div>
    )
  }

  // ── Render ──────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Posting Mode Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Settings2 className="w-6 h-6 text-blue-500" />
              <div>
                <CardTitle className="text-lg">Posting Mode</CardTitle>
                <CardDescription>
                  Control how journal entries are created from business documents
                </CardDescription>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={loadData}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-4 border rounded-lg">
            <div className="flex items-center gap-4">
              <div className={`p-3 rounded-lg ${postingMode === 'AUTO' ? 'bg-green-100' : 'bg-gray-100'}`}>
                {postingMode === 'AUTO' ? (
                  <Zap className="w-6 h-6 text-green-600" />
                ) : (
                  <Hand className="w-6 h-6 text-gray-600" />
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-lg">
                    {postingMode === 'AUTO' ? 'Automatic Posting' : 'Manual Posting'}
                  </span>
                  <Badge variant={postingMode === 'AUTO' ? 'default' : 'secondary'}>
                    {postingMode}
                  </Badge>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  {postingMode === 'AUTO'
                    ? 'Journal entries are automatically created when invoices, receipts, and payments are finalized.'
                    : 'Journal entries must be manually posted from the Pending Postings queue.'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Label htmlFor="posting-mode" className="text-sm text-gray-500">
                {postingMode === 'AUTO' ? 'Auto' : 'Manual'}
              </Label>
              <Switch
                id="posting-mode"
                checked={postingMode === 'AUTO'}
                onCheckedChange={handleModeToggle}
                disabled
              />
            </div>
          </div>

          <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-800">
            Automatic posting is retired. Every document is posted from <strong>Pending Postings</strong>, where the
            accountant enters the amount actually paid or received; accounts come from <strong>Default Accounts</strong>.
            The rules below are not used for posting.
          </div>

          {/* Mode explanation cards */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className={`p-4 rounded-lg border-2 ${postingMode === 'MANUAL' ? 'border-blue-300 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center gap-2 mb-2">
                <Hand className="w-4 h-4 text-blue-600" />
                <span className="font-medium">Manual Mode</span>
                {postingMode === 'MANUAL' && <Badge className="bg-blue-500 text-xs">Active</Badge>}
              </div>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>• Documents go to Pending Postings queue</li>
                <li>• Review before posting to GL</li>
                <li>• Full control over journal entries</li>
                <li>• Recommended for initial setup</li>
              </ul>
            </div>
            <div className={`p-4 rounded-lg border-2 ${postingMode === 'AUTO' ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center gap-2 mb-2">
                <Zap className="w-4 h-4 text-green-600" />
                <span className="font-medium">Auto Mode</span>
                {postingMode === 'AUTO' && <Badge className="bg-green-500 text-xs">Active</Badge>}
              </div>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>• Journals created automatically on finalize</li>
                <li>• Faster workflow for experienced teams</li>
                <li>• Configure rules per document type below</li>
                <li>• Reversal entries auto-created on void</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Posting Rules by Document Type */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FileText className="w-6 h-6 text-indigo-500" />
              <div>
                <CardTitle className="text-lg">Posting Rules by Document Type</CardTitle>
                <CardDescription>
                  Define how each document type maps to GL journal entries
                </CardDescription>
              </div>
            </div>
            {canManage && (
              <Button onClick={openCreateDialog} size="sm">
                <Plus className="w-4 h-4 mr-2" />
                Add Rule
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {/* Default posting type reference */}
          <div className="mb-6">
            <h4 className="text-sm font-medium text-gray-700 mb-3">Default Journal Entry Templates</h4>
            <div className="grid gap-3">
              {POSTING_TYPES.map((pt) => {
                const colors = POSTING_TYPE_COLORS[pt.code] || { bg: 'bg-gray-50', text: 'text-gray-700', border: 'border-gray-200' }
                const matchingRule = rules.find((r) => r.document_type === pt.code || r.rule_code === pt.code)

                return (
                  <div key={pt.code} className={`p-4 rounded-lg border ${colors.border} ${colors.bg}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <pt.icon className={`w-5 h-5 ${colors.text}`} />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{pt.label}</span>
                            <Badge variant="outline" className="text-xs">
                              {pt.subledger}
                            </Badge>
                            {matchingRule ? (
                              <Badge className={matchingRule.is_active ? 'bg-green-500 text-xs' : 'bg-gray-400 text-xs'}>
                                {matchingRule.is_active ? 'Active' : 'Disabled'}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs">Default</Badge>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {pt.entries.map((e, i) => (
                              <span key={i} className="mr-3">
                                {e.debit && <span>Dr: {e.debit}</span>}
                                {e.debit && e.credit && <span> → </span>}
                                {e.credit && <span>Cr: {e.credit}</span>}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                      {canManage && matchingRule && (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={matchingRule.is_active}
                            onCheckedChange={() => handleToggleActive(matchingRule)}
                            className="scale-90"
                          />
                          <Button variant="ghost" size="sm" onClick={() => openEditDialog(matchingRule)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDeleteRule(matchingRule.id)}>
                            <Trash2 className="w-3.5 h-3.5 text-red-500" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Custom Rules */}
          {rules.filter((r) => !POSTING_TYPES.find((pt) => pt.code === r.document_type || pt.code === r.rule_code)).length > 0 && (
            <div className="mt-6">
              <h4 className="text-sm font-medium text-gray-700 mb-3">Custom Rules</h4>
              <div className="grid gap-3">
                {rules
                  .filter((r) => !POSTING_TYPES.find((pt) => pt.code === r.document_type || pt.code === r.rule_code))
                  .map((rule) => (
                    <div key={rule.id} className="p-4 rounded-lg border bg-white">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{rule.rule_name}</span>
                            <Badge variant="outline" className="text-xs font-mono">{rule.rule_code}</Badge>
                            <Badge className={rule.is_active ? 'bg-green-500 text-xs' : 'bg-gray-400 text-xs'}>
                              {rule.is_active ? 'Active' : 'Disabled'}
                            </Badge>
                          </div>
                          {rule.description && (
                            <p className="text-xs text-gray-500 mt-1">{rule.description}</p>
                          )}
                        </div>
                        {canManage && (
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={rule.is_active}
                              onCheckedChange={() => handleToggleActive(rule)}
                              className="scale-90"
                            />
                            <Button variant="ghost" size="sm" onClick={() => openEditDialog(rule)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handleDeleteRule(rule.id)}>
                              <Trash2 className="w-3.5 h-3.5 text-red-500" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {rules.length === 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mt-4">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-blue-500 mt-0.5" />
                <div>
                  <h4 className="font-medium text-blue-800">Using Default Posting Templates</h4>
                  <p className="text-sm text-blue-700 mt-1">
                    All document types use the built-in default posting templates shown above.
                    You can create custom rules to override behavior for specific document types.
                  </p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Posting Approval Workflow Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-6 h-6 text-gray-400" />
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">Posting Approval Workflow</CardTitle>
                <Badge variant="outline" className="text-xs text-amber-600">Phase 2</Badge>
              </div>
              <CardDescription>
                Require approval before journal entries are posted to the GL
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="bg-gray-50 border rounded-lg p-4">
            <p className="text-sm text-gray-600">
              In a future update, you will be able to configure multi-level approval workflows for journal postings.
              This includes threshold-based approvals, mandatory dual review for high-value entries, and
              audit trail for all approval actions.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Create/Edit Rule Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingRule ? 'Edit Posting Rule' : 'Create Posting Rule'}</DialogTitle>
            <DialogDescription>
              {editingRule ? 'Update the posting rule configuration.' : 'Define a new posting rule for a document type.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rule_code">Rule Code</Label>
                <Input
                  id="rule_code"
                  value={formData.rule_code}
                  onChange={(e) => setFormData({ ...formData, rule_code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') })}
                  placeholder="e.g. SALES_INV_01"
                  disabled={!!editingRule}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="document_type">Document Type</Label>
                <Select
                  value={formData.document_type}
                  onValueChange={(v) => setFormData({ ...formData, document_type: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type..." />
                  </SelectTrigger>
                  <SelectContent>
                    {DOCUMENT_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rule_name">Rule Name</Label>
              <Input
                id="rule_name"
                value={formData.rule_name}
                onChange={(e) => setFormData({ ...formData, rule_name: e.target.value })}
                placeholder="e.g. Standard Sales Invoice Posting"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe when this rule applies..."
                rows={3}
              />
            </div>

            <div className="flex items-center gap-3 p-3 border rounded-lg">
              <Switch
                checked={formData.is_active}
                onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              />
              <div>
                <Label>Active</Label>
                <p className="text-xs text-gray-500">Enable this rule for automatic posting</p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveRule} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              {editingRule ? 'Update Rule' : 'Create Rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
