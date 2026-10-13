import { checkPermissionForUser } from '@/lib/server/permissions'
import { normalizeAndDedupeManualEmails } from '@/lib/notifications/manualEmailAddresses'
import {
    STOCK_COUNT_EVENT_CODE, STOCK_COUNT_POST_PERMISSION, isValidStockCountPostingNote,
    type StockCountVerificationErrorCode,
} from './stock-count-verification-errors'
import { normalizeBaseCost, sumStockCountImpacts } from './stock-count-costing'
import { stockCountDraftSignature } from './stock-count-snapshot'
import {
    CLASSIFICATION_LEGACY_CONFIG_CODE,
    CLASSIFICATION_TARGET_CONFIG_CODES,
    evaluateClassificationPostable,
    type ClassificationLiveLegacyBalance,
} from './stock-count-classification'

export interface StockCountPreflightSuccess {
    ok: true
    organizationId: string
    session: any
    items: any[]
    recipients: string[]
    provider: any
    authoritativeBaseCosts: Record<string, number | null>
    // Signature of the *persisted* counted rows. The client computes the same
    // signature over the rows currently on screen; a mismatch means the draft
    // was saved from a different (stale) state than what the user is reviewing,
    // and posting must be blocked before a code is issued.
    persistedSignature: string
    summary: {
        totalVariantsCounted: number
        varianceItems: number
        netQuantityAdjustment: number
        estimatedAdjustmentValue: number
    }
}

export type StockCountPreflightResult =
    | StockCountPreflightSuccess
    | { ok: false; code: StockCountVerificationErrorCode; message?: string }

interface StockCountSessionItem {
    stock_config_id: string | null
    variant_id: string
    physical_quantity: number | null
    adjustment_quantity: number | null
    unit_cost: number | null
    note?: string | null
    inventory_stock_configurations?: { config_code?: string | null } | Array<{ config_code?: string | null }> | null
}

export interface StockCountPreflightDependencies {
    loadAccessibleSession: (sessionId: string) => Promise<any | null>
    loadActiveWarehouse: (warehouseId: string) => Promise<{ id: string } | null>
    loadVariantBaseCosts: (variantIds: string[]) => Promise<Array<{ id: string; base_cost: number | string | null }>>
    loadClassificationLiveLegacy: (
        warehouseId: string,
        variantIds: string[],
    ) => Promise<ClassificationLiveLegacyBalance[]>
    loadVariantLabels: (variantIds: string[]) => Promise<Array<{ id: string; variant_name: string | null; product_name: string | null }>>
    loadClassificationAllocationResolutions: (
        sessionId: string,
    ) => Promise<Array<{ variant_id: string; target_stock_config_id: string }>>
    checkPermission: (userId: string, permission: string) => Promise<{ allowed: boolean; context: { organization_id: string | null } | null }>
    /**
     * Authoritative decision for inventory.stock_count.post on this session's warehouse, through the S&A contract:
     * LEGACY_ENFORCED/SHADOW → `legacyAllowed` decides (and SHADOW records the comparison); NEW_ENFORCED/
     * LEGACY_RETIRED → the S&A decision for the warehouse decides. Absent (unit tests) → legacy only.
     */
    authorizePost?: (input: { userId: string; organizationId: string; warehouseId: string; sessionId: string; legacyAllowed: boolean }) => Promise<boolean>
    loadEvent: () => Promise<any | null>
    loadSetting: (orgId: string) => Promise<any | null>
    loadUsers: (ids: string[]) => Promise<any[]>
    loadProvider: (orgId: string) => Promise<any | null>
}

function configCodeOf(item: StockCountSessionItem): string | null {
    const cfg = Array.isArray(item.inventory_stock_configurations)
        ? item.inventory_stock_configurations[0]
        : item.inventory_stock_configurations
    return cfg?.config_code ? String(cfg.config_code) : null
}

function providerLooksUsable(provider: any): boolean {
    if (!provider?.provider_name) return false
    const config = provider.config_public || {}
    const encrypted = provider.config_encrypted
    if (!encrypted) return false
    if (provider.provider_name === 'smtp') return Boolean(config.smtp_host && (config.from_email || config.username))
    if (provider.provider_name === 'gmail') return Boolean(config.gmail_email && config.oauth_client_id)
    if (provider.provider_name === 'mailgun') return Boolean(config.domain && config.from_email)
    return ['sendgrid', 'resend', 'postmark', 'aws_ses'].includes(provider.provider_name) && Boolean(config.from_email)
}

export async function evaluateStockCountPreflight(
    deps: StockCountPreflightDependencies,
    userId: string,
    sessionId: string,
): Promise<StockCountPreflightResult> {
    const session = await deps.loadAccessibleSession(sessionId)
    if (!session) return { ok: false, code: 'stock_count_access_denied' }
    const warehouse = await deps.loadActiveWarehouse(session.warehouse_organization_id)
    if (!warehouse) {
        return {
            ok: false,
            code: 'invalid_warehouse',
            message: 'Selected organization is not an active warehouse.',
        }
    }
    if (session.status !== 'draft') return { ok: false, code: 'already_posted' }
    if (session.count_type === 'initial_configuration_classification') {
        return {
            ok: false,
            code: 'invalid_count_data',
            message: 'Legacy Initial Classification drafts are read-only. Create an Inventory Opening Balance & Initial Classification draft instead.',
        }
    }

    const permission = await deps.checkPermission(userId, STOCK_COUNT_POST_PERMISSION)
    if (!permission.context?.organization_id) return { ok: false, code: 'permission_denied' }
    const mayPost = deps.authorizePost
        ? await deps.authorizePost({
            userId, organizationId: permission.context.organization_id, warehouseId: session.warehouse_organization_id,
            sessionId: session.id ?? sessionId, legacyAllowed: permission.allowed,
        })
        : permission.allowed
    if (!mayPost) return { ok: false, code: 'permission_denied' }

    const items: StockCountSessionItem[] = Array.isArray(session.stock_count_session_items)
        ? session.stock_count_session_items
        : []
    const counted = items.filter((item) => item.physical_quantity !== null)
    if (!counted.length) return { ok: false, code: 'invalid_count_data' }
    if (counted.some((item) => !item.stock_config_id)) return { ok: false, code: 'configuration_identity_missing' }
    const varianceItems = counted.filter((item) => Number(item.adjustment_quantity || 0) !== 0)
    if (varianceItems.length && !isValidStockCountPostingNote(session.notes)) return { ok: false, code: 'posting_note_required' }
    let persistedAllocationResolutions: Array<{ variant_id: string; target_stock_config_id: string }> = []

    // Initial Physical Count & Configuration Classification: revalidate live
    // Legacy balances and refuse already-classified stock. An allocation is
    // allowed only with its persisted explicit target; database preparation
    // then reconciles the owning orders and target capacity under row locks.
    if (session.count_type === 'initial_configuration_classification') {
        const variantIds = Array.from(new Set(counted.map((item) => item.variant_id)))
        const [liveRows, labels, allocationResolutions] = await Promise.all([
            deps.loadClassificationLiveLegacy(session.warehouse_organization_id, variantIds),
            deps.loadVariantLabels(variantIds),
            deps.loadClassificationAllocationResolutions(sessionId),
        ])
        persistedAllocationResolutions = allocationResolutions
        const liveByVariant = new Map(liveRows.map((row) => [row.variantId, row]))
        const labelByVariant = new Map(labels.map((row) => [row.id, row]))
        const allocationTargetByVariant = new Map(
            allocationResolutions.map((row) => [row.variant_id, row.target_stock_config_id]),
        )
        const flavours = variantIds.map((variantId) => {
            const variantItems = counted.filter((item) => item.variant_id === variantId)
            const requestedTotal = variantItems
                .filter((item) => (CLASSIFICATION_TARGET_CONFIG_CODES as readonly string[]).includes(configCodeOf(item) || ''))
                .reduce((sum, item) => sum + Number(item.physical_quantity || 0), 0)
            const hasLegacyRow = variantItems.some((item) => configCodeOf(item) === CLASSIFICATION_LEGACY_CONFIG_CODE)
            const label = labelByVariant.get(variantId)
            return {
                variantId,
                productName: label?.product_name || 'Unknown product',
                variantName: label?.variant_name || 'Unknown flavour',
                requestedTotal,
                selected: hasLegacyRow,
                allocationTargetStockConfigId: allocationTargetByVariant.get(variantId) || null,
            }
        })
        const classificationGate = evaluateClassificationPostable(flavours, liveByVariant)
        if (!classificationGate.ok) {
            return { ok: false, code: classificationGate.code, message: classificationGate.message }
        }
    }

    // Master-data Base Cost is authoritative for Stock Count. The draft's
    // unit_cost may be stale (or may have come from legacy average-cost logic),
    // so never use it to calculate the approval summary.
    const baseCostRows = await deps.loadVariantBaseCosts(Array.from(new Set(counted.map(item => item.variant_id))))
    const baseCosts = new Map(baseCostRows.map(row => [row.id, normalizeBaseCost(row.base_cost)]))
    if (varianceItems.some(item => baseCosts.get(item.variant_id) === null || !baseCosts.has(item.variant_id))) {
        return { ok: false, code: 'base_cost_missing' }
    }

    const event = await deps.loadEvent()
    if (!event) return { ok: false, code: 'notification_event_missing' }
    const setting = await deps.loadSetting(permission.context.organization_id)
    if (!setting) return { ok: false, code: 'notification_setting_missing' }
    if (!setting.enabled) return { ok: false, code: 'notification_event_disabled' }

    const config = setting.recipient_config || {}
    const manualEmails = normalizeAndDedupeManualEmails(config.manual_email_addresses)
    const userIds = config.recipient_targets?.users && Array.isArray(config.recipient_users) ? config.recipient_users : []
    const users = userIds.length ? await deps.loadUsers(userIds) : []
    const userEmails = normalizeAndDedupeManualEmails(users.map((user) => user.email).filter(Boolean))
    const recipients = Array.from(new Set([...manualEmails, ...userEmails]))
    if (!recipients.length) {
        return { ok: false, code: userIds.length || manualEmails.length ? 'recipient_emails_invalid' : 'no_authorized_recipients' }
    }

    const provider = await deps.loadProvider(permission.context.organization_id)
    if (!provider) return { ok: false, code: 'email_provider_missing' }
    if (!providerLooksUsable(provider)) return { ok: false, code: 'email_provider_unavailable' }

    return {
        ok: true,
        organizationId: permission.context.organization_id,
        session,
        items,
        recipients,
        provider,
        authoritativeBaseCosts: Object.fromEntries(baseCosts),
        persistedSignature: stockCountDraftSignature(items.map((item) => ({
            stockConfigId: item.stock_config_id ?? null,
            variantId: item.variant_id,
            physicalCount: item.physical_quantity === null || item.physical_quantity === undefined
                ? null
                : Number(item.physical_quantity),
            note: typeof item.note === 'string' ? item.note : '',
        })), persistedAllocationResolutions.map((row) => ({
            variantId: row.variant_id,
            targetStockConfigId: row.target_stock_config_id,
        }))),
        summary: {
            totalVariantsCounted: counted.length,
            varianceItems: varianceItems.length,
            netQuantityAdjustment: counted.reduce((sum, item) => sum + Number(item.adjustment_quantity || 0), 0),
            estimatedAdjustmentValue: sumStockCountImpacts(counted.map(item => ({
                quantityChange: Number(item.adjustment_quantity || 0),
                baseCost: baseCosts.get(item.variant_id),
            }))),
        },
    }
}

export function createStockCountPreflightDependencies(supabase: any, admin: any): StockCountPreflightDependencies {
    return {
        loadAccessibleSession: async (sessionId) => {
            const { data } = await supabase.from('stock_count_sessions').select(`
                id, warehouse_organization_id, count_date, count_type, reference_name, notes, status,
                stock_count_session_items(stock_config_id, variant_id, physical_quantity, adjustment_quantity, unit_cost, note)
            `).eq('id', sessionId).maybeSingle()
            if (!data || data.count_type !== 'initial_configuration_classification') return data || null
            const items = Array.isArray(data.stock_count_session_items) ? data.stock_count_session_items : []
            const configIds = Array.from(new Set(items.map((item: any) => item.stock_config_id).filter(Boolean)))
            if (!configIds.length) return data
            const { data: configs } = await admin
                .from('inventory_stock_configurations')
                .select('id, config_code')
                .in('id', configIds)
            const codeById = new Map((configs || []).map((row: any) => [row.id, row.config_code]))
            return {
                ...data,
                stock_count_session_items: items.map((item: any) => ({
                    ...item,
                    inventory_stock_configurations: item.stock_config_id
                        ? { config_code: codeById.get(item.stock_config_id) || null }
                        : null,
                })),
            }
        },
        loadActiveWarehouse: async (warehouseId) => {
            const { data } = await admin
                .from('organizations')
                .select('id')
                .eq('id', warehouseId)
                .eq('org_type_code', 'WH')
                .eq('is_active', true)
                .maybeSingle()
            return data || null
        },
        loadVariantBaseCosts: async (variantIds) => {
            if (!variantIds.length) return []
            const { data } = await admin.from('product_variants').select('id,base_cost').in('id', variantIds)
            return data || []
        },
        loadClassificationLiveLegacy: async (warehouseId, variantIds) => {
            if (!variantIds.length) return []
            const { data: configs } = await admin
                .from('inventory_stock_configurations')
                .select('id, variant_id, config_code, stock_sku, product_variants!inner(variant_name, products!inner(product_name))')
                .in('variant_id', variantIds)
                .eq('config_code', CLASSIFICATION_LEGACY_CONFIG_CODE)
            const configRows = (configs || []) as any[]
            if (!configRows.length) return []
            const configIds = configRows.map((row) => row.id)
            const { data: inventory } = await admin
                .from('product_inventory')
                .select('variant_id, stock_config_id, quantity_on_hand, quantity_allocated')
                .eq('organization_id', warehouseId)
                .eq('is_active', true)
                .in('stock_config_id', configIds)
            const invByConfig = new Map<string, any>((inventory || []).map((row: any) => [row.stock_config_id, row]))
            return configRows.map((cfg) => {
                const inv = invByConfig.get(cfg.id)
                const variant = Array.isArray(cfg.product_variants) ? cfg.product_variants[0] : cfg.product_variants
                const product = Array.isArray(variant?.products) ? variant.products[0] : variant?.products
                return {
                    variantId: cfg.variant_id,
                    productName: product?.product_name || 'Unknown product',
                    variantName: variant?.variant_name || 'Unknown flavour',
                    liveOnHand: Number(inv?.quantity_on_hand || 0),
                    liveAllocated: Number(inv?.quantity_allocated || 0),
                } satisfies ClassificationLiveLegacyBalance
            })
        },
        loadVariantLabels: async (variantIds) => {
            if (!variantIds.length) return []
            const { data } = await admin
                .from('product_variants')
                .select('id, variant_name, products!inner(product_name)')
                .in('id', variantIds)
            return (data || []).map((row: any) => {
                const product = Array.isArray(row.products) ? row.products[0] : row.products
                return {
                    id: row.id,
                    variant_name: row.variant_name || null,
                    product_name: product?.product_name || null,
                }
            })
        },
        loadClassificationAllocationResolutions: async (sessionId) => {
            const { data } = await admin
                .from('stock_count_classification_allocation_resolutions')
                .select('variant_id,target_stock_config_id')
                .eq('session_id', sessionId)
            return data || []
        },
        checkPermission: (userId, permission) => checkPermissionForUser(userId, permission) as any,
        authorizePost: async ({ userId, organizationId, warehouseId, sessionId, legacyAllowed }) => {
            // Loaded lazily: the S&A helper is server-only.
            const [{ authorize }, { resolveWarehouseResourceContext }] = await Promise.all([
                import('@/lib/security-access/authorization'),
                import('@/lib/security-access/resource-context'),
            ])
            const decision = await authorize({
                actorId: userId,
                permission: 'inventory.stock_count.post',
                resource: { type: 'stock_count', id: sessionId, ...(await resolveWarehouseResourceContext(organizationId, warehouseId)) },
            }, { legacy: () => legacyAllowed })
            return decision.decision === 'ALLOW'
        },
        loadEvent: async () => {
            const { data } = await admin.from('notification_types').select('event_code,available_channels').eq('event_code', STOCK_COUNT_EVENT_CODE).maybeSingle()
            return data || null
        },
        loadSetting: async (orgId) => {
            const { data } = await admin.from('notification_settings').select('enabled,channels_enabled,recipient_config').eq('org_id', orgId).eq('event_code', STOCK_COUNT_EVENT_CODE).maybeSingle()
            return data || null
        },
        loadUsers: async (ids) => {
            const { data } = await admin.from('users').select('id,email').in('id', ids).eq('is_active', true)
            return data || []
        },
        loadProvider: async (orgId) => {
            const { data } = await admin.from('notification_provider_configs').select('provider_name,config_public,config_encrypted,is_active')
                .eq('org_id', orgId).eq('channel', 'email').eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle()
            return data || null
        },
    }
}
