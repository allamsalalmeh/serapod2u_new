'use client'

import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/use-toast'
import {
    Shield,
    Plus,
    Save,
    Loader2,
    Trash2,
    Users,
    Key,
    UserPlus,
    ChevronDown,
    ChevronRight,
    Lock,
    Sparkles,
} from 'lucide-react'

interface Permission {
    id: string
    code: string
    module: string
    name: string
    description: string
    is_system: boolean
}

interface GroupPermission {
    id: string
    permission_id: string
    hr_permissions: Pick<Permission, 'id' | 'code' | 'module' | 'name'>
}

interface GroupMember {
    id: string
    user_id: string
    scope_type: string
    scope_value: string | null
    granted_by: string | null
}

interface AccessGroup {
    id: string
    organization_id: string
    name: string
    description: string
    is_system: boolean
    hr_access_group_permissions: GroupPermission[]
    hr_access_group_members: GroupMember[]
}

interface OrgUser {
    id: string
    full_name: string
    email: string
}

const MODULE_COLORS: Record<string, string> = {
    leave: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    attendance: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    payroll: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
    recruitment: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
    employee: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
    settings: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400',
    reports: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
    expense: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

export default function HrSettingsPermissionsView() {
    const [loading, setLoading] = useState(true)
    const [permissions, setPermissions] = useState<Permission[]>([])
    const [groups, setGroups] = useState<AccessGroup[]>([])
    const [users, setUsers] = useState<OrgUser[]>([])
    const [isAdmin, setIsAdmin] = useState(false)
    const [readOnly, setReadOnly] = useState(false)
    const [expandedGroup, setExpandedGroup] = useState<string | null>(null)

    // Create group dialog
    const [showCreateGroup, setShowCreateGroup] = useState(false)
    const [newGroupName, setNewGroupName] = useState('')
    const [newGroupDesc, setNewGroupDesc] = useState('')
    const [creatingGroup, setCreatingGroup] = useState(false)

    // Add member dialog
    const [showAddMember, setShowAddMember] = useState(false)
    const [addMemberGroupId, setAddMemberGroupId] = useState('')
    const [addMemberUserId, setAddMemberUserId] = useState('')
    const [addingMember, setAddingMember] = useState(false)

    // Edit permissions dialog
    const [showEditPerms, setShowEditPerms] = useState(false)
    const [editPermsGroupId, setEditPermsGroupId] = useState('')
    const [editPermsGroupName, setEditPermsGroupName] = useState('')
    const [selectedPermIds, setSelectedPermIds] = useState<Set<string>>(new Set())
    const [savingPerms, setSavingPerms] = useState(false)
    const [seeding, setSeeding] = useState(false)

    const loadData = useCallback(async () => {
        try {
            setLoading(true)
            const res = await fetch('/api/hr/settings/permissions')
            if (!res.ok) throw new Error('Failed to load')
            const data = await res.json()
            setPermissions(data.permissions || [])
            setGroups(data.groups || [])
            setUsers(data.users || [])
            setIsAdmin(data.isAdmin)
            setReadOnly(Boolean(data.readOnly))
            // Auto-expand first group
            if (data.groups?.length > 0 && !expandedGroup) {
                setExpandedGroup(data.groups[0].id)
            }
        } catch (err) {
            console.error(err)
            toast({ title: 'Error', description: 'Failed to load permissions data', variant: 'destructive' })
        } finally {
            setLoading(false)
        }
    }, [expandedGroup])

    useEffect(() => { loadData() }, [loadData])

    const handleCreateGroup = async () => {
        if (!newGroupName.trim()) return
        try {
            setCreatingGroup(true)
            const res = await fetch('/api/hr/settings/permissions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'create_group', name: newGroupName, description: newGroupDesc })
            })
            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || 'Failed to create')
            }
            toast({ title: 'Created', description: `Access group "${newGroupName}" created` })
            setShowCreateGroup(false)
            setNewGroupName('')
            setNewGroupDesc('')
            loadData()
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        } finally {
            setCreatingGroup(false)
        }
    }

    const handleAddMember = async () => {
        if (!addMemberUserId || !addMemberGroupId) return
        try {
            setAddingMember(true)
            const res = await fetch('/api/hr/settings/permissions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'add_member', group_id: addMemberGroupId, user_id: addMemberUserId })
            })
            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || 'Failed to add')
            }
            toast({ title: 'Added', description: 'Member added to group' })
            setShowAddMember(false)
            setAddMemberUserId('')
            loadData()
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        } finally {
            setAddingMember(false)
        }
    }

    const handleDeleteGroup = async (id: string, name: string) => {
        if (!confirm(`Delete access group "${name}"? Members will lose their permissions.`)) return
        try {
            const res = await fetch(`/api/hr/settings/permissions?type=group&id=${id}`, { method: 'DELETE' })
            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || 'Failed')
            }
            toast({ title: 'Deleted', description: `Group "${name}" removed` })
            loadData()
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        }
    }

    const handleRemoveMember = async (memberId: string) => {
        if (!confirm('Remove this member from the group?')) return
        try {
            const res = await fetch(`/api/hr/settings/permissions?type=member&id=${memberId}`, { method: 'DELETE' })
            if (!res.ok) throw new Error('Failed')
            toast({ title: 'Removed', description: 'Member removed' })
            loadData()
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        }
    }

    const openEditPerms = (group: AccessGroup) => {
        setEditPermsGroupId(group.id)
        setEditPermsGroupName(group.name)
        const ids = new Set(group.hr_access_group_permissions.map(gp => gp.permission_id))
        setSelectedPermIds(ids)
        setShowEditPerms(true)
    }

    const handleSavePerms = async () => {
        try {
            setSavingPerms(true)
            const res = await fetch('/api/hr/settings/permissions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'set_permissions',
                    group_id: editPermsGroupId,
                    permission_ids: Array.from(selectedPermIds)
                })
            })
            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || 'Failed')
            }
            toast({ title: 'Saved', description: `Permissions updated for "${editPermsGroupName}"` })
            setShowEditPerms(false)
            loadData()
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        } finally {
            setSavingPerms(false)
        }
    }

    const togglePerm = (id: string) => {
        setSelectedPermIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const toggleModule = (module: string) => {
        const modulePerms = permissions.filter(p => p.module === module)
        const allSelected = modulePerms.every(p => selectedPermIds.has(p.id))
        setSelectedPermIds(prev => {
            const next = new Set(prev)
            modulePerms.forEach(p => {
                if (allSelected) next.delete(p.id)
                else next.add(p.id)
            })
            return next
        })
    }

    const getUserName = (userId: string) => {
        const u = users.find(u => u.id === userId)
        return u ? u.full_name : userId.substring(0, 8) + '…'
    }

    const handleSeedTemplates = async () => {
        setSeeding(true)
        try {
            // Step 1: Seed permission catalog
            const res1 = await fetch('/api/hr/settings/permissions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'seed_permissions_catalog' })
            })
            const d1 = await res1.json()
            if (!d1.success) throw new Error(d1.error || 'Failed to seed permissions')

            // Step 2: Seed template groups with permissions
            const res2 = await fetch('/api/hr/settings/permissions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'seed_template_groups' })
            })
            const d2 = await res2.json()
            if (!d2.success) throw new Error(d2.error || 'Failed to seed groups')

            toast({ title: 'Templates Loaded', description: `${d1.message}. ${d2.message}` })
            loadData()
        } catch (err: any) {
            toast({ title: 'Error', description: err.message, variant: 'destructive' })
        } finally {
            setSeeding(false)
        }
    }

    const permsByModule = permissions.reduce<Record<string, Permission[]>>((acc, p) => {
        if (!acc[p.module]) acc[p.module] = []
        acc[p.module].push(p)
        return acc
    }, {})

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-6">
            {/* Header */}
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle className="flex items-center gap-2">
                                <Shield className="h-5 w-5 text-blue-600" />
                                HR Permissions & Access Groups
                            </CardTitle>
                            <CardDescription>
                                HR access groups are informational. HR authorization is decided by{' '}
                                <a href="/security-access" className="font-medium underline">Security &amp; Access</a>{' '}
                                (HR, payroll and compensation permissions).
                            </CardDescription>
                            {readOnly && (
                                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                                    Read-only: access is granted, reviewed and revoked in Security &amp; Access.
                                </div>
                            )}
                        </div>
                        {isAdmin && (
                            <div className="flex items-center gap-2">
                                <Button variant="outline" onClick={handleSeedTemplates} disabled={seeding} className="gap-2">
                                    {seeding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                                    {seeding ? 'Loading…' : 'Load Templates'}
                                </Button>
                                <Button onClick={() => setShowCreateGroup(true)} className="gap-2">
                                    <Plus className="h-4 w-4" />
                                    New Access Group
                                </Button>
                            </div>
                        )}
                    </div>
                </CardHeader>
            </Card>

            {/* Access Groups */}
            {groups.length === 0 ? (
                <Card>
                    <CardContent className="py-10 text-center text-muted-foreground">
                        <Shield className="h-10 w-10 mx-auto mb-3 opacity-30" />
                        <p className="text-sm">No access groups created yet.</p>
                        <p className="text-xs mt-1">Create a group like &quot;HR Manager&quot; or &quot;Department Head&quot; to get started.</p>
                    </CardContent>
                </Card>
            ) : (
                groups.map(group => {
                    const isExpanded = expandedGroup === group.id
                    const memberCount = group.hr_access_group_members.length
                    const permCount = group.hr_access_group_permissions.length

                    return (
                        <Card key={group.id}>
                            <CardHeader
                                className="cursor-pointer hover:bg-muted/30 transition-colors"
                                onClick={() => setExpandedGroup(isExpanded ? null : group.id)}
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                        <div>
                                            <CardTitle className="text-base flex items-center gap-2">
                                                {group.name}
                                                {group.is_system && (
                                                    <Badge variant="outline" className="text-xs gap-1">
                                                        <Lock className="h-3 w-3" /> System
                                                    </Badge>
                                                )}
                                            </CardTitle>
                                            {group.description && (
                                                <CardDescription className="mt-0.5">{group.description}</CardDescription>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <Badge variant="secondary" className="gap-1">
                                            <Users className="h-3 w-3" /> {memberCount}
                                        </Badge>
                                        <Badge variant="secondary" className="gap-1">
                                            <Key className="h-3 w-3" /> {permCount}
                                        </Badge>
                                    </div>
                                </div>
                            </CardHeader>

                            {isExpanded && (
                                <CardContent className="border-t space-y-4 pt-4">
                                    {/* Permissions */}
                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <Label className="text-sm font-medium flex items-center gap-1">
                                                <Key className="h-3.5 w-3.5" /> Permissions ({permCount})
                                            </Label>
                                            {isAdmin && (
                                                <Button variant="outline" size="sm" onClick={() => openEditPerms(group)}>
                                                    Edit Permissions
                                                </Button>
                                            )}
                                        </div>
                                        {permCount === 0 ? (
                                            <p className="text-xs text-muted-foreground">No permissions assigned.</p>
                                        ) : (
                                            <div className="flex flex-wrap gap-1.5">
                                                {group.hr_access_group_permissions.map(gp => (
                                                    <Badge
                                                        key={gp.id}
                                                        variant="outline"
                                                        className={`text-xs ${MODULE_COLORS[gp.hr_permissions.module] || ''}`}
                                                    >
                                                        {gp.hr_permissions.name}
                                                    </Badge>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Members */}
                                    <div>
                                        <div className="flex items-center justify-between mb-2">
                                            <Label className="text-sm font-medium flex items-center gap-1">
                                                <Users className="h-3.5 w-3.5" /> Members ({memberCount})
                                            </Label>
                                            {isAdmin && (
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => {
                                                        setAddMemberGroupId(group.id)
                                                        setShowAddMember(true)
                                                    }}
                                                    className="gap-1"
                                                >
                                                    <UserPlus className="h-3.5 w-3.5" />
                                                    Add Member
                                                </Button>
                                            )}
                                        </div>
                                        {memberCount === 0 ? (
                                            <p className="text-xs text-muted-foreground">No members in this group.</p>
                                        ) : (
                                            <div className="space-y-1.5">
                                                {group.hr_access_group_members.map(m => (
                                                    <div
                                                        key={m.id}
                                                        className="flex items-center justify-between rounded border px-3 py-1.5 text-sm"
                                                    >
                                                        <div className="flex items-center gap-2">
                                                            <span className="font-medium">{getUserName(m.user_id)}</span>
                                                            {m.scope_type !== 'global' && (
                                                                <Badge variant="outline" className="text-xs">
                                                                    {m.scope_type}: {m.scope_value}
                                                                </Badge>
                                                            )}
                                                        </div>
                                                        {isAdmin && (
                                                            <Button
                                                                variant="ghost"
                                                                size="icon"
                                                                className="h-6 w-6 text-destructive hover:text-destructive"
                                                                onClick={() => handleRemoveMember(m.id)}
                                                            >
                                                                <Trash2 className="h-3 w-3" />
                                                            </Button>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Delete group button */}
                                    {isAdmin && !group.is_system && (
                                        <div className="pt-2 border-t">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-destructive hover:text-destructive gap-1"
                                                onClick={() => handleDeleteGroup(group.id, group.name)}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                                Delete Group
                                            </Button>
                                        </div>
                                    )}
                                </CardContent>
                            )}
                        </Card>
                    )
                })
            )}

            {/* Permission Catalog */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                        <Key className="h-4 w-4 text-purple-600" />
                        Permission Catalog
                    </CardTitle>
                    <CardDescription>
                        All available HR permissions grouped by module. Assign these to access groups above.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="space-y-4">
                        {Object.entries(permsByModule).map(([module, perms]) => (
                            <div key={module}>
                                <h4 className="text-sm font-medium capitalize mb-2 flex items-center gap-2">
                                    <Badge className={`text-xs ${MODULE_COLORS[module] || ''}`}>
                                        {module}
                                    </Badge>
                                    <span className="text-muted-foreground text-xs">({perms.length})</span>
                                </h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    {perms.map(p => (
                                        <div key={p.id} className="rounded border px-3 py-2 text-sm">
                                            <div className="font-medium">{p.name}</div>
                                            <div className="text-xs text-muted-foreground">
                                                <span className="font-mono">{p.code}</span>
                                                {p.description && <span> — {p.description}</span>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>

            {/* ─── Create Group Dialog ─── */}
            <Dialog open={showCreateGroup} onOpenChange={setShowCreateGroup}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create Access Group</DialogTitle>
                        <DialogDescription>
                            Create a named access group and assign permissions and members to it.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-2">
                            <Label>Group Name</Label>
                            <Input
                                placeholder="e.g. HR Manager, Department Head"
                                value={newGroupName}
                                onChange={(e) => setNewGroupName(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label>Description (optional)</Label>
                            <Input
                                placeholder="What this group is for…"
                                value={newGroupDesc}
                                onChange={(e) => setNewGroupDesc(e.target.value)}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowCreateGroup(false)}>Cancel</Button>
                        <Button onClick={handleCreateGroup} disabled={creatingGroup || !newGroupName.trim()}>
                            {creatingGroup ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
                            Create Group
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ─── Add Member Dialog ─── */}
            <Dialog open={showAddMember} onOpenChange={setShowAddMember}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Add Member to Group</DialogTitle>
                        <DialogDescription>Select a user to add to this access group.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-2">
                            <Label>User</Label>
                            <Select value={addMemberUserId} onValueChange={setAddMemberUserId}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select user…" />
                                </SelectTrigger>
                                <SelectContent>
                                    {users.map(u => (
                                        <SelectItem key={u.id} value={u.id}>
                                            {u.full_name} ({u.email})
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowAddMember(false)}>Cancel</Button>
                        <Button onClick={handleAddMember} disabled={addingMember || !addMemberUserId}>
                            {addingMember ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <UserPlus className="h-4 w-4 mr-2" />}
                            Add Member
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* ─── Edit Permissions Dialog ─── */}
            <Dialog open={showEditPerms} onOpenChange={setShowEditPerms}>
                <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Edit Permissions — {editPermsGroupName}</DialogTitle>
                        <DialogDescription>Check/uncheck permissions to assign to this group.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        {Object.entries(permsByModule).map(([module, perms]) => {
                            const allSelected = perms.every(p => selectedPermIds.has(p.id))
                            const someSelected = perms.some(p => selectedPermIds.has(p.id))
                            return (
                                <div key={module} className="space-y-2">
                                    <div className="flex items-center gap-2">
                                        <Checkbox
                                            checked={allSelected}
                                            indeterminate={!allSelected && someSelected}
                                            onCheckedChange={() => toggleModule(module)}
                                        />
                                        <Badge className={`text-xs ${MODULE_COLORS[module] || ''}`}>
                                            {module}
                                        </Badge>
                                        <span className="text-xs text-muted-foreground">({perms.length})</span>
                                    </div>
                                    <div className="ml-6 space-y-1">
                                        {perms.map(p => (
                                            <div key={p.id} className="flex items-center gap-2">
                                                <Checkbox
                                                    checked={selectedPermIds.has(p.id)}
                                                    onCheckedChange={() => togglePerm(p.id)}
                                                />
                                                <span className="text-sm">{p.name}</span>
                                                <span className="text-xs text-muted-foreground font-mono">{p.code}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setShowEditPerms(false)}>Cancel</Button>
                        <Button onClick={handleSavePerms} disabled={savingPerms}>
                            {savingPerms ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                            Save Permissions
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
