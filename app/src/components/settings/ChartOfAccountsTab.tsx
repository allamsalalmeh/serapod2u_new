'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import {
  Plus,
  Search,
  Edit,
  Trash2,
  Loader2,
  ChevronLeft,
  ChevronRight,
  BookOpen,
  Filter,
  X,
  Sparkles,
  FileStack,
  AlertTriangle
} from 'lucide-react'
import { GLAccount, GLAccountType, GLAccountInsert, GLAccountUpdate, GLAccountsListResponse } from '@/types/accounting'
import { useSaCapability } from '@/hooks/useSaCapability'
import ChartOfAccountsTree from '@/components/accounting/ChartOfAccountsTree'

interface ChartOfAccountsTabProps {
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

const ACCOUNT_TYPES: { value: GLAccountType; label: string; color: string }[] = [
  { value: 'ASSET', label: 'Asset', color: 'bg-blue-100 text-blue-800' },
  { value: 'LIABILITY', label: 'Liability', color: 'bg-red-100 text-red-800' },
  { value: 'EQUITY', label: 'Equity', color: 'bg-purple-100 text-purple-800' },
  { value: 'INCOME', label: 'Income', color: 'bg-green-100 text-green-800' },
  { value: 'EXPENSE', label: 'Expense', color: 'bg-orange-100 text-orange-800' }
]

const PAGE_SIZES = [10, 25, 50]

export default function ChartOfAccountsTab({ userProfile }: ChartOfAccountsTabProps) {
  // State
  const [accounts, setAccounts] = useState<GLAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [hasAnyAccounts, setHasAnyAccounts] = useState(true) // Track if company has ANY accounts
  const [devModeAvailable, setDevModeAvailable] = useState(false) // DEV-only delete
  
  // Filters
  const [search, setSearch] = useState('')
  const [accountTypeFilter, setAccountTypeFilter] = useState<GLAccountType | 'ALL'>('ALL')
  const [activeFilter, setActiveFilter] = useState<'ALL' | 'true' | 'false'>('ALL')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  // Tree view (ERPNext-style, with balances) or the paged list
  const [viewMode, setViewMode] = useState<'tree' | 'list'>('tree')
  const [treeReload, setTreeReload] = useState(0)
  
  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [accountToDelete, setAccountToDelete] = useState<GLAccount | null>(null)
  const [editingAccount, setEditingAccount] = useState<GLAccount | null>(null)
  const [formData, setFormData] = useState<Partial<GLAccountInsert>>({
    code: '',
    name: '',
    account_type: 'ASSET',
    subtype: '',
    description: '',
    is_active: true
  })

  // Shown when Security & Access allows finance.account.manage (the server decides the
  // operation); the historical role-level rule applies until it is enforced.
  const canManage = useSaCapability('finance.account.manage', userProfile.roles.role_level <= 20)

  // Check if DEV mode is available for hard delete
  useEffect(() => {
    const checkDevMode = async () => {
      try {
        const response = await fetch('/api/accounting/reset')
        if (response.ok) {
          const data = await response.json()
          setDevModeAvailable(data.resetAvailable)
        }
      } catch (error) {
        // Ignore - DEV mode not available
      }
    }
    checkDevMode()
  }, [])

  // Load accounts
  const loadAccounts = useCallback(async () => {
    try {
      setLoading(true)
      
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: pageSize.toString(),
        sortBy: 'code',
        sortOrder: 'asc'
      })
      
      if (search) params.set('search', search)
      if (accountTypeFilter !== 'ALL') params.set('accountType', accountTypeFilter)
      if (activeFilter !== 'ALL') params.set('isActive', activeFilter)

      const response = await fetch(`/api/accounting/accounts?${params}`)
      
      if (response.ok) {
        const data: GLAccountsListResponse = await response.json()
        setAccounts(data.accounts)
        setTotal(data.total)
        
        // Check if company has ANY accounts (no filters applied)
        if (!search && accountTypeFilter === 'ALL' && activeFilter === 'ALL' && page === 1) {
          setHasAnyAccounts(data.total > 0)
        }
      } else if (response.status === 403) {
        // Module not enabled
        setAccounts([])
        setTotal(0)
        setHasAnyAccounts(false)
      } else {
        toast({
          title: 'Error',
          description: 'Failed to load accounts',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error loading accounts:', error)
      toast({
        title: 'Error',
        description: 'Failed to load accounts',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, accountTypeFilter, activeFilter])

  useEffect(() => {
    loadAccounts()
  }, [loadAccounts])

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1)
      loadAccounts()
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  // Handle filter changes
  const handleFilterChange = () => {
    setPage(1)
    loadAccounts()
  }

  // Open create modal
  // preset: from the tree's "+" on a group (type, subtype and parent account)
  const handleCreate = (preset?: { account_type: string; subtype: string | null; parent_account_id: string | null }) => {
    setEditingAccount(null)
    setFormData({
      code: '',
      name: '',
      account_type: (preset?.account_type as GLAccountType) || 'ASSET',
      subtype: preset?.subtype || '',
      description: '',
      is_active: true,
      parent_account_id: preset?.parent_account_id || null
    })
    setModalOpen(true)
  }

  // Edit from the tree, which knows only the account id
  const handleEditById = async (accountId: string) => {
    try {
      const response = await fetch(`/api/accounting/accounts/${accountId}`)
      const data = await response.json()
      if (response.ok && data.account) handleEdit(data.account)
      else toast({ title: 'Error', description: data.error || 'Failed to load account', variant: 'destructive' })
    } catch {
      toast({ title: 'Error', description: 'Failed to load account', variant: 'destructive' })
    }
  }

  // Open edit modal
  const handleEdit = (account: GLAccount) => {
    setEditingAccount(account)
    setFormData({
      code: account.code,
      name: account.name,
      account_type: account.account_type,
      subtype: account.subtype || '',
      description: account.description || '',
      is_active: account.is_active
    })
    setModalOpen(true)
  }

  // Save account (create or update)
  const handleSave = async () => {
    if (!formData.code || !formData.name || !formData.account_type) {
      toast({
        title: 'Validation Error',
        description: 'Code, Name, and Account Type are required',
        variant: 'destructive'
      })
      return
    }

    try {
      setSaving(true)
      
      const url = editingAccount 
        ? `/api/accounting/accounts/${editingAccount.id}`
        : '/api/accounting/accounts'
      
      const method = editingAccount ? 'PUT' : 'POST'
      
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })

      const data = await response.json()

      if (response.ok) {
        toast({
          title: 'Success',
          description: editingAccount 
            ? `Account "${data.account.code}" updated` 
            : `Account "${data.account.code}" created`
        })
        setModalOpen(false)
        loadAccounts()
        setTreeReload((k) => k + 1)
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to save account',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error saving account:', error)
      toast({
        title: 'Error',
        description: 'Failed to save account',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
    }
  }

  // Toggle active status
  const handleToggleActive = async (account: GLAccount) => {
    try {
      const response = await fetch(`/api/accounting/accounts/${account.id}/toggle-active`, {
        method: 'PATCH'
      })

      const data = await response.json()

      if (response.ok) {
        toast({
          title: 'Success',
          description: data.message
        })
        loadAccounts()
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to update account status',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error toggling account status:', error)
      toast({
        title: 'Error',
        description: 'Failed to update account status',
        variant: 'destructive'
      })
    }
  }

  // Seed starter accounts
  const handleSeedStarterAccounts = async (template: 'starter' | 'full' = 'starter') => {
    if (!canManage) {
      toast({
        title: 'Permission Denied',
        description: 'You need admin permissions to create accounts',
        variant: 'destructive'
      })
      return
    }

    try {
      setSeeding(true)
      const response = await fetch(`/api/accounting/accounts/seed?template=${template}`, {
        method: 'POST'
      })
      
      const data = await response.json()
      
      if (response.ok) {
        const settingsMsg = data.settingsConfigured > 0 
          ? ` Auto-configured ${data.settingsConfigured} default accounts.`
          : ''
        toast({
          title: 'Success',
          description: data.created > 0 
            ? `Created ${data.created} accounts successfully.${settingsMsg}` 
            : 'All accounts already exist'
        })
        setHasAnyAccounts(true)
        loadAccounts()
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to create accounts',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error seeding accounts:', error)
      toast({
        title: 'Error',
        description: 'Failed to create accounts',
        variant: 'destructive'
      })
    } finally {
      setSeeding(false)
    }
  }

  // DEV-only: Hard delete account
  const handleDeleteAccount = async () => {
    if (!accountToDelete || !canManage || !devModeAvailable) {
      return
    }

    try {
      setDeleting(accountToDelete.id)
      
      const response = await fetch(`/api/accounting/accounts/${accountToDelete.id}`, {
        method: 'DELETE'
      })

      const data = await response.json()

      if (response.ok) {
        toast({
          title: 'Deleted',
          description: `Account "${accountToDelete.code}" deleted successfully`
        })
        setDeleteModalOpen(false)
        setAccountToDelete(null)
        loadAccounts()
      } else {
        toast({
          title: 'Error',
          description: data.error || 'Failed to delete account',
          variant: 'destructive'
        })
      }
    } catch (error) {
      console.error('Error deleting account:', error)
      toast({
        title: 'Error',
        description: 'Failed to delete account',
        variant: 'destructive'
      })
    } finally {
      setDeleting(null)
    }
  }

  // Open delete modal
  const openDeleteModal = (account: GLAccount) => {
    setAccountToDelete(account)
    setDeleteModalOpen(true)
  }

  // Get account type badge
  const getAccountTypeBadge = (type: GLAccountType) => {
    const typeInfo = ACCOUNT_TYPES.find(t => t.value === type)
    return typeInfo ? (
      <Badge variant="secondary" className={typeInfo.color}>
        {typeInfo.label}
      </Badge>
    ) : (
      <Badge variant="secondary">{type}</Badge>
    )
  }

  // Pagination
  const totalPages = Math.ceil(total / pageSize)
  const canPrevious = page > 1
  const canNext = page < totalPages

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-blue-500" />
            <div>
              <CardTitle className="text-lg">Chart of Accounts</CardTitle>
              <CardDescription>
                Manage your general ledger accounts
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border p-0.5">
            <Button size="sm" variant={viewMode === 'tree' ? 'secondary' : 'ghost'} onClick={() => setViewMode('tree')}>
              Tree View
            </Button>
            <Button size="sm" variant={viewMode === 'list' ? 'secondary' : 'ghost'} onClick={() => setViewMode('list')}>
              List View
            </Button>
          </div>
          {canManage && (
            <Button onClick={() => handleCreate()}>
              <Plus className="w-4 h-4 mr-2" />
              New Account
            </Button>
          )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {viewMode === 'tree' && hasAnyAccounts ? (
          <ChartOfAccountsTree
            companyName={(userProfile.organizations as any)?.org_name}
            canManage={canManage}
            reloadKey={treeReload}
            onEdit={handleEditById}
            onAddChild={handleCreate}
          />
        ) : (<>
        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
            <Input
              placeholder="Search by code or name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          
          {/* Type Filter */}
          <Select 
            value={accountTypeFilter} 
            onValueChange={(value) => {
              setAccountTypeFilter(value as GLAccountType | 'ALL')
              handleFilterChange()
            }}
          >
            <SelectTrigger className="w-full sm:w-[150px]">
              <Filter className="w-4 h-4 mr-2" />
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Types</SelectItem>
              {ACCOUNT_TYPES.map(type => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Active Filter */}
          <Select 
            value={activeFilter} 
            onValueChange={(value) => {
              setActiveFilter(value as 'ALL' | 'true' | 'false')
              handleFilterChange()
            }}
          >
            <SelectTrigger className="w-full sm:w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Status</SelectItem>
              <SelectItem value="true">Active</SelectItem>
              <SelectItem value="false">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <div className="border rounded-lg overflow-x-auto">
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[120px]">Code</TableHead>
                <TableHead>Account Name</TableHead>
                <TableHead className="w-[100px]">Type</TableHead>
                <TableHead className="hidden md:table-cell">Subtype</TableHead>
                <TableHead className="w-[80px] text-center">Active</TableHead>
                {canManage && <TableHead className="w-[100px] text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={canManage ? 6 : 5} className="text-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-gray-400" />
                    <p className="mt-2 text-gray-500">Loading accounts...</p>
                  </TableCell>
                </TableRow>
              ) : accounts.length === 0 && !hasAnyAccounts && !search && accountTypeFilter === 'ALL' && activeFilter === 'ALL' ? (
                // Empty state - No accounts exist at all, show starter accounts prompt
                <TableRow>
                  <TableCell colSpan={canManage ? 6 : 5} className="text-center py-12">
                    <div className="max-w-md mx-auto">
                      <BookOpen className="w-12 h-12 mx-auto text-blue-300" />
                      <h3 className="mt-4 text-lg font-medium text-gray-900">
                        Set Up Your Chart of Accounts
                      </h3>
                      <p className="mt-2 text-gray-500">
                        Get started with a pre-configured set of essential accounts for your business.
                      </p>
                      
                      {canManage && (
                        <div className="mt-6 space-y-3">
                          <Button 
                            onClick={() => handleSeedStarterAccounts('starter')}
                            disabled={seeding}
                            className="w-full sm:w-auto"
                          >
                            {seeding ? (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                              <Sparkles className="w-4 h-4 mr-2" />
                            )}
                            Create Starter Accounts
                          </Button>
                          
                          <div className="text-xs text-gray-400">
                            Creates 6 essential accounts: Cash, AR, AP, Supplier Deposits, Sales, COGS
                          </div>
                          
                          <div className="pt-2 border-t">
                            <Button 
                              variant="outline"
                              size="sm"
                              onClick={() => handleSeedStarterAccounts('full')}
                              disabled={seeding}
                            >
                              <FileStack className="w-4 h-4 mr-2" />
                              Or Load Full Template (33 accounts)
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : accounts.length === 0 ? (
                // Empty state - Filters applied but no results
                <TableRow>
                  <TableCell colSpan={canManage ? 6 : 5} className="text-center py-8">
                    <BookOpen className="w-10 h-10 mx-auto text-gray-300" />
                    <p className="mt-2 text-gray-500">No accounts found</p>
                    {(search || accountTypeFilter !== 'ALL' || activeFilter !== 'ALL') && (
                      <p className="text-sm text-gray-400 mt-1">Try adjusting your filters</p>
                    )}
                    {canManage && !search && accountTypeFilter === 'ALL' && activeFilter === 'ALL' && (
                      <Button variant="outline" className="mt-4" onClick={() => handleCreate()}>
                        <Plus className="w-4 h-4 mr-2" />
                        Create First Account
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((account) => (
                  <TableRow key={account.id} className={!account.is_active ? 'opacity-50' : ''}>
                    <TableCell className="font-mono font-medium">{account.code}</TableCell>
                    <TableCell>
                      <div>
                        <p className="font-medium">{account.name}</p>
                        {account.description && (
                          <p className="text-sm text-gray-500 truncate max-w-[300px]">
                            {account.description}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{getAccountTypeBadge(account.account_type)}</TableCell>
                    <TableCell className="hidden md:table-cell text-gray-500">
                      {account.subtype || '-'}
                    </TableCell>
                    <TableCell className="text-center">
                      {canManage ? (
                        <Switch
                          checked={account.is_active}
                          onCheckedChange={() => handleToggleActive(account)}
                          disabled={account.is_system}
                        />
                      ) : (
                        <Badge variant={account.is_active ? 'default' : 'secondary'}>
                          {account.is_active ? 'Yes' : 'No'}
                        </Badge>
                      )}
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(account)}
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                          {/* DEV-only: Hard delete button */}
                          {devModeAvailable && !account.is_system && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-500 hover:text-red-700 hover:bg-red-50"
                              onClick={() => openDeleteModal(account)}
                              disabled={deleting === account.id}
                            >
                              {deleting === account.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Trash2 className="w-4 h-4" />
                              )}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {total > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mt-4">
            <div className="text-sm text-gray-500">
              Showing {((page - 1) * pageSize) + 1} to {Math.min(page * pageSize, total)} of {total} accounts
            </div>
            <div className="flex items-center gap-2">
              <Select 
                value={pageSize.toString()} 
                onValueChange={(value) => {
                  setPageSize(parseInt(value, 10))
                  setPage(1)
                }}
              >
                <SelectTrigger className="w-[80px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map(size => (
                    <SelectItem key={size} value={size.toString()}>
                      {size}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-sm text-gray-500">per page</span>
              <div className="flex gap-1 ml-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => p - 1)}
                  disabled={!canPrevious}
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="px-3 py-1 text-sm">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => p + 1)}
                  disabled={!canNext}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
        </>)}
      </CardContent>

      {/* Create/Edit Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {editingAccount ? 'Edit Account' : 'Create Account'}
            </DialogTitle>
            <DialogDescription>
              {editingAccount 
                ? 'Update the account details below'
                : 'Enter the details for the new GL account'
              }
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Code */}
            <div className="space-y-2">
              <Label htmlFor="code">Account Code *</Label>
              <Input
                id="code"
                placeholder="e.g., 1100, 2100, 4100"
                value={formData.code || ''}
                onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
                maxLength={20}
              />
              <p className="text-xs text-gray-500">
                Alphanumeric (A-Z, 0-9, ., -), max 20 characters
              </p>
            </div>

            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="name">Account Name *</Label>
              <Input
                id="name"
                placeholder="e.g., Cash on Hand, Trade Receivables"
                value={formData.name || ''}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>

            {/* Account Type */}
            <div className="space-y-2">
              <Label htmlFor="account_type">Account Type *</Label>
              <Select 
                value={formData.account_type} 
                onValueChange={(value) => setFormData({ ...formData, account_type: value as GLAccountType })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map(type => (
                    <SelectItem key={type.value} value={type.value}>
                      {type.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Subtype */}
            <div className="space-y-2">
              <Label htmlFor="subtype">Subtype</Label>
              <Input
                id="subtype"
                placeholder="e.g., Current Asset, Fixed Asset"
                value={formData.subtype || ''}
                onChange={(e) => setFormData({ ...formData, subtype: e.target.value })}
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                placeholder="Optional description"
                value={formData.description || ''}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              />
            </div>

            {/* Active */}
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="is_active">Active</Label>
                <p className="text-xs text-gray-500">
                  Inactive accounts won't appear in posting selections
                </p>
              </div>
              <Switch
                id="is_active"
                checked={formData.is_active ?? true}
                onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {editingAccount ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DEV-only: Delete Confirmation Modal */}
      <Dialog open={deleteModalOpen} onOpenChange={setDeleteModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <Trash2 className="w-5 h-5" />
              Delete Account
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this account?
            </DialogDescription>
          </DialogHeader>
          
          {accountToDelete && (
            <div className="py-4">
              <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-lg">{accountToDelete.code}</span>
                  {getAccountTypeBadge(accountToDelete.account_type)}
                </div>
                <p className="font-medium">{accountToDelete.name}</p>
                {accountToDelete.description && (
                  <p className="text-sm text-gray-500">{accountToDelete.description}</p>
                )}
              </div>

              <div className="mt-4 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-yellow-600 mt-0.5" />
                  <div className="text-sm text-yellow-800">
                    <p className="font-medium">DEV-ONLY: This action is irreversible</p>
                    <p className="mt-1">
                      If this account has journal entries, deletion will fail. 
                      Use "Deactivate" instead for production environments.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button 
              variant="outline" 
              onClick={() => {
                setDeleteModalOpen(false)
                setAccountToDelete(null)
              }}
            >
              Cancel
            </Button>
            <Button 
              variant="destructive"
              onClick={handleDeleteAccount}
              disabled={deleting !== null}
            >
              {deleting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4 mr-2" />
              )}
              Delete Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
