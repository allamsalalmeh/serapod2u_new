import { AsyncLocalStorage } from 'node:async_hooks'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeRolePermissions } from '@/lib/role-permissions'

export interface PermissionOverrides {
    allow: string[]
    deny: string[]
}

export interface UserPermissionContext {
    id: string
    organization_id: string | null
    department_id: string | null
    role_code: string | null
    role_level: number | null
}

const normalizeOverrides = (overrides: any): PermissionOverrides => {
    const allow = Array.isArray(overrides?.allow) ? overrides.allow.filter(Boolean) : []
    const deny = Array.isArray(overrides?.deny) ? overrides.deny.filter(Boolean) : []
    return {
        allow: Array.from(new Set(allow)),
        deny: Array.from(new Set(deny))
    }
}

const extractPermissions = (permissions: any): Set<string> => {
    if (!permissions) return new Set()
    if (Array.isArray(permissions)) {
        return new Set(permissions.filter(Boolean))
    }
    if (typeof permissions === 'object') {
        return new Set(Object.keys(permissions).filter(key => permissions[key] === true))
    }
    return new Set()
}

const getAllPermissionKeys = async (): Promise<Set<string>> => {
    const adminClient = createAdminClient()
    const { data: roles } = await adminClient.from('roles').select('permissions')
    const all = new Set<string>()
    for (const role of roles || []) {
        const perms = extractPermissions(role?.permissions)
        perms.forEach(key => all.add(key))
    }
    return all
}

export const getRolePermissions = async (roleCode?: string | null): Promise<Set<string>> => {
    if (!roleCode) return new Set()
    const adminClient = createAdminClient()
    const { data, error } = await adminClient
        .from('roles')
        .select('permissions, role_level')
        .eq('role_code', roleCode)
        .single()

    if (error || !data) return new Set()

    if (data.role_level === 1) {
        const allKeys = await getAllPermissionKeys()
        return allKeys
    }

    return extractPermissions(data.permissions)
}

export const getDepartmentOverrides = async (departmentId?: string | null): Promise<PermissionOverrides> => {
    if (!departmentId) return { allow: [], deny: [] }
    const adminClient = createAdminClient() as any
    const { data, error } = await adminClient
        .from('departments')
        .select('permission_overrides')
        .eq('id', departmentId)
        .single()

    if (error || !data) return { allow: [], deny: [] }
    return normalizeOverrides(data.permission_overrides)
}

export const getUserPermissionContext = async (userId: string): Promise<UserPermissionContext | null> => {
    const adminClient = createAdminClient()
    const { data, error } = await adminClient
        .from('users')
        .select('id, organization_id, department_id, role_code, roles(role_level)')
        .eq('id', userId)
        .single()

    if (error || !data) return null

    return {
        id: data.id,
        organization_id: data.organization_id ?? null,
        department_id: data.department_id ?? null,
        role_code: data.role_code ?? null,
        role_level: (data.roles as any)?.role_level ?? null
    }
}

type EffectivePermissions = Awaited<ReturnType<typeof computeEffectivePermissionsUncached>>

/**
 * One evaluation that asks many legacy questions (a navigation snapshot, a page guard over several permissions) reads
 * each user's role, department overrides and context once instead of once per question. The memo lives only for the
 * callback passed to withPermissionEvaluationScope, so no answer outlives the evaluation that read it.
 */
const evaluationScope = new AsyncLocalStorage<Map<string, Promise<EffectivePermissions>>>()

export function withPermissionEvaluationScope<T>(fn: () => Promise<T>): Promise<T> {
    return evaluationScope.getStore() ? fn() : evaluationScope.run(new Map(), fn)
}

export const computeEffectivePermissions = async (userId: string): Promise<EffectivePermissions> => {
    const memo = evaluationScope.getStore()
    if (!memo) return computeEffectivePermissionsUncached(userId)
    let pending = memo.get(userId)
    if (!pending) {
        pending = computeEffectivePermissionsUncached(userId)
        memo.set(userId, pending)
    }
    return pending
}

const computeEffectivePermissionsUncached = async (userId: string) => {
    const ctx = await getUserPermissionContext(userId)
    if (!ctx) {
        return {
            context: null,
            allowed: new Set<string>(),
            denied: new Set<string>(),
            explain: (key: string) => 'Missing'
        }
    }

    const rolePermissions = await getRolePermissions(ctx.role_code)
    const overrides = await getDepartmentOverrides(ctx.department_id)
    const allowSet = new Set(overrides.allow)
    const denySet = new Set(overrides.deny)

    const allowed = new Set(rolePermissions)
    allowSet.forEach(key => allowed.add(key))
    denySet.forEach(key => allowed.delete(key))

    const explain = (key: string) => {
        if (denySet.has(key)) return 'Denied by Department'
        if (allowSet.has(key)) return 'Allowed by Department'
        if (rolePermissions.has(key)) return 'Inherited from Role'
        return 'Missing'
    }

    return {
        context: ctx,
        allowed,
        denied: denySet,
        explain
    }
}

export const checkPermissionForUser = async (userId: string, permissionKey: string) => {
    const evaluation = await computeEffectivePermissions(userId)

    // Super Admin (role_level 1) has all permissions unconditionally
    const isSuperAdmin = evaluation.context?.role_level === 1
    const allowed = isSuperAdmin || evaluation.allowed.has(permissionKey)

    return {
        allowed,
        reason: isSuperAdmin ? 'Super Admin' : evaluation.explain(permissionKey),
        context: evaluation.context
    }
}

/**
 * A role permission as the portal shell has always resolved it (hooks/usePermissions): the role's level defaults
 * (lib/role-permissions.ts) with the role's own stored true/false values over them, then department overrides. Unlike
 * checkPermissionForUser, a key the stored role JSON never mentions falls back to the level default (the HQ role stores
 * `manage_all` but no `view_users`). Throws when the role cannot be read, so callers can report "unavailable".
 */
export const checkRolePermissionWithDefaults = async (userId: string, permissionKey: string): Promise<boolean> => {
    const evaluation = await computeEffectivePermissions(userId)
    const ctx = evaluation.context
    if (!ctx) return false
    if (ctx.role_level === 1) return true
    if (evaluation.denied.has(permissionKey)) return false
    if (evaluation.allowed.has(permissionKey)) return true
    if (!ctx.role_code) return false
    const adminClient = createAdminClient()
    const { data, error } = await adminClient.from('roles').select('permissions').eq('role_code', ctx.role_code).maybeSingle()
    if (error) throw new Error('role_permissions_unavailable')
    return normalizeRolePermissions(ctx.role_level ?? undefined, data?.permissions)[permissionKey] === true
}

export const hasPermission = async (userId: string, permissionKey: string): Promise<boolean> => {
    const result = await checkPermissionForUser(userId, permissionKey)
    return result.allowed
}

export const requirePermission = async (userId: string, permissionKey: string) => {
    const result = await checkPermissionForUser(userId, permissionKey)
    if (!result.allowed) {
        throw new Error('Forbidden')
    }
    return result
}
