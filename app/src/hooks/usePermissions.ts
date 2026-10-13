'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import {
    buildDefaultPermissionMap,
    normalizeRolePermissions,
    resolveRoleLevel,
} from '@/lib/role-permissions'

interface RolePermissions {
    [permissionId: string]: boolean
}

interface UsePermissionsResult {
    hasPermission: (permissionId: string) => boolean
    permissions: RolePermissions
    loading: boolean
    refresh: () => Promise<void>
}

export function usePermissions(roleLevel?: number, roleCode?: string, departmentId?: string | null): UsePermissionsResult {
    const { supabase, isReady } = useSupabaseAuth()
    const [permissions, setPermissions] = useState<RolePermissions>({})
    const [loading, setLoading] = useState(true)
    const [deniedPermissions, setDeniedPermissions] = useState<Set<string>>(new Set())
    const effectiveRoleLevel = resolveRoleLevel(roleLevel, roleCode)

    const applyDepartmentOverrides = useCallback((basePerms: RolePermissions, overrides: any) => {
        const allow = Array.isArray(overrides?.allow) ? overrides.allow.filter(Boolean) : []
        const deny = Array.isArray(overrides?.deny) ? overrides.deny.filter(Boolean) : []
        const allowSet = new Set<string>(allow)
        const denySet = new Set<string>(deny)

        const merged: RolePermissions = { ...basePerms }
        allowSet.forEach(key => {
            merged[key] = true
        })
        denySet.forEach(key => {
            merged[key] = false
        })

        setDeniedPermissions(denySet)
        return merged
    }, [])

    const loadPermissions = useCallback(async () => {
        if (!isReady || effectiveRoleLevel === undefined) {
            // Keep loading true while waiting for supabase to be ready
            // This prevents rendering with stale/default permissions
            return
        }


        try {
            // Try to load permissions from database
            const { data: roleData, error } = await supabase
                .from('roles')
                .select('permissions')
                .eq('role_level', effectiveRoleLevel)
                .single()


            if (error || !roleData?.permissions) {
                const perms = buildDefaultPermissionMap(effectiveRoleLevel)
                let merged = perms
                if (departmentId) {
                    const { data: deptData } = await supabase
                        .from('departments')
                        .select('permission_overrides')
                        .eq('id', departmentId)
                        .single()
                    merged = applyDepartmentOverrides(perms, deptData?.permission_overrides)
                } else {
                    setDeniedPermissions(new Set())
                }
                setPermissions(merged)
            } else {
                // Use database permissions with proper type handling
                const dbPerms = roleData.permissions
                if (dbPerms && typeof dbPerms === 'object' && !Array.isArray(dbPerms)) {
                    const validPerms = normalizeRolePermissions(effectiveRoleLevel, dbPerms)

                    let merged = validPerms
                    if (departmentId) {
                        const { data: deptData } = await supabase
                            .from('departments')
                            .select('permission_overrides')
                            .eq('id', departmentId)
                            .single()
                        merged = applyDepartmentOverrides(validPerms, deptData?.permission_overrides)
                    } else {
                        setDeniedPermissions(new Set())
                    }
                    setPermissions(merged)
                } else {
                    // Fall back to defaults
                    const fallbackPerms = buildDefaultPermissionMap(effectiveRoleLevel)
                    let merged = fallbackPerms
                    if (departmentId) {
                        const { data: deptData } = await supabase
                            .from('departments')
                            .select('permission_overrides')
                            .eq('id', departmentId)
                            .single()
                        merged = applyDepartmentOverrides(fallbackPerms, deptData?.permission_overrides)
                    } else {
                        setDeniedPermissions(new Set())
                    }
                    setPermissions(merged)
                }
            }
        } catch (err) {
            console.error('Error loading permissions:', err)
            // Fall back to defaults on error
            const perms = buildDefaultPermissionMap(effectiveRoleLevel)
            let merged = perms
            if (departmentId) {
                const { data: deptData } = await supabase
                    .from('departments')
                    .select('permission_overrides')
                    .eq('id', departmentId)
                    .single()
                merged = applyDepartmentOverrides(perms, deptData?.permission_overrides)
            } else {
                setDeniedPermissions(new Set())
            }
            setPermissions(merged)
        } finally {
            setLoading(false)
        }
    }, [isReady, effectiveRoleLevel, supabase, departmentId, applyDepartmentOverrides])

    useEffect(() => {
        loadPermissions()
    }, [loadPermissions])

    const hasPermission = useCallback((permissionId: string): boolean => {
        // Super admin (level 1) always has all permissions
        if (effectiveRoleLevel === 1) return true

        // If still loading, return false (menu will re-render when loaded)
        if (loading) {
            return false
        }

        if (deniedPermissions.has(permissionId)) {
            return false
        }

        // Check if permission exists in the loaded permissions
        const result = permissions[permissionId] === true
        return result
    }, [permissions, effectiveRoleLevel, loading, deniedPermissions])

    return {
        hasPermission,
        permissions,
        loading,
        refresh: loadPermissions
    }
}

// Convenience hook for checking a single permission
export function useHasPermission(permissionId: string, roleLevel?: number, departmentId?: string | null): boolean {
    const { hasPermission, loading } = usePermissions(roleLevel, undefined, departmentId)
    const effectiveRoleLevel = resolveRoleLevel(roleLevel)

    if (loading) {
        // Return default based on role level during loading
        if (effectiveRoleLevel === undefined) return false
        return buildDefaultPermissionMap(effectiveRoleLevel)[permissionId] === true
    }

    return hasPermission(permissionId)
}
