import { STAGE2D_PERMISSION_KEYS } from './stage2d-catalog'
import { IDENTITY_ARCHIVE_ENFORCEMENT_READY, IDENTITY_ENFORCEMENT_READY } from './identity-catalog'
import { HR_DATA_PERMISSION_KEYS } from './hr-data-catalog'
import { USER_ADMIN_ENFORCEMENT_READY } from './user-admin-catalog'
import { SYSTEM_LOGS_ENFORCEMENT_READY } from './system-logs-catalog'

/**
 * Operations whose every reachable path enforces the S&A decision: the
 * server route (requireAuthorization / guardOperation) AND the database
 * backstop (RPC guard, RLS gate, transition guard, governance function, or no
 * API-role write path). Only these may be NEW_ENFORCED / LEGACY_RETIRED.
 *
 * Must equal public.sa_enforcement_readiness
 * (20260928130000_sa_final_legacy_retirement_support.sql); the lock-step test
 * (catalog-migration.test.ts) keeps the two aligned, and
 * sa_set_migration_mode() refuses any other permission.
 */
export const ENFORCEMENT_READY_PERMISSIONS: readonly string[] = [
  'inventory.stock_count.verify',
  'security.access.view',
  'security.role.assign',
  'security.permission.manage',
  'security.role.manage',
  'security.scope.manage',
  'security.policy.manage',
  'security.audit.view',
  'security.access_request.approve',
  'security.access_review.manage',
  'security.delegation.manage',
  'security.service_identity.manage',
  'finance.module.view',
  'finance.ledger.view',
  'finance.report.view_sensitive',
  'finance.receivable.view',
  'finance.payable.view',
  'finance.cash.view',
  'finance.reconciliation.perform',
  'finance.journal.post',
  'finance.account.manage',
  'finance.settings.manage',
  'finance.data.reset',
  'finance.payment.approve',
  'finance.payroll_integration.manage',
  'hr.module.view',
  'hr.employee.view',
  'hr.employee.manage',
  'hr.attendance.manage',
  'hr.leave.approve',
  'hr.payroll.view',
  'hr.payroll.prepare',
  'hr.payroll.approve',
  'hr.payroll.release',
  'hr.compensation.view',
  'hr.compensation.manage',
  'hr.contract.view',
  'hr.contract.manage',
  'hr.benefits.manage',
  'hr.learning.manage',
  'hr.onboarding.manage',
  'hr.recruitment.manage',
  'hr.policy.manage',
  'hr.performance.manage',
  'hr.expense.manage',
  'hr.analytics.view',
  'hr.settings.manage',
  'hr.ai.use',
  'hr.self_service.use',
  'supply_chain.order.create',
  'supply_chain.order.approve',
  'supply_chain.order.cancel',
  'supply_chain.document.acknowledge',
  'supply_chain.document.manage',
  'inventory.transfer.request',
  'inventory.transfer.approve',
  'inventory.transfer.cancel',
  'inventory.transfer.dispatch',
  'inventory.transfer.receive',
  'inventory.adjustment.post',
  'inventory.opening_balance.manage',
  'inventory.stock_config.manage',
  'inventory.return.manage',
  'inventory.return.request',
  'warehouse.receipt.post',
  'warehouse.shipment.manage',
  'qr.batch.manage',
  'product.catalog.manage',
  'manufacturing.adjustment.manage',
  'customer.loyalty.adjust',
  'customer.redemption.manage',
  'customer.program.manage',
  'customer.shop.manage',
  'customer.reward.manage',
  'roadtour.kpi.manage',
  'roadtour.report.view',
  'ecommerce.store.manage',
  'ecommerce.order.manage',
  'ecommerce.channel.manage',
  'customer.campaign.manage',
  'customer.support.manage',
  'customer.consumer.view',
  'manufacturing.production.manage',
  'manufacturing.scan.reverse',
  'roadtour.campaign.manage',
  'roadtour.visit.manage',
  'platform.settings.manage',
  'platform.organization.manage',
  'platform.user.manage',
  'platform.data.destructive',
  'reporting.analytics.view',
  'inventory.report.view',
  'inventory.stock_count.view',
  'inventory.transfer.view',
]

/**
 * Stock Count draft creation and posting (20261019100000_sa_stock_count_create_post_enforcement.sql): API-role write
 * guard + discard guard for create; verification routes, stock_count_user_can_post and the code-consumption backstop
 * for post.
 */
export const STOCK_COUNT_ENFORCEMENT_READY: readonly string[] = ['inventory.stock_count.create', 'inventory.stock_count.post']

/** Final Wave registrations (20260928130000), Identity Foundation (20260929110000), Stage 2D (20260930100000) and HR Data Management (20261003100000) and User Administration password reset (20261016100000) and System Logs (20261017110000) and Stock Count create/post (20261019100000) and Archive Identities (20261023100000). */
export const ALL_ENFORCEMENT_READY_PERMISSIONS: readonly string[] = [...ENFORCEMENT_READY_PERMISSIONS, ...IDENTITY_ENFORCEMENT_READY, ...STAGE2D_PERMISSION_KEYS, ...HR_DATA_PERMISSION_KEYS, ...USER_ADMIN_ENFORCEMENT_READY, ...SYSTEM_LOGS_ENFORCEMENT_READY, ...STOCK_COUNT_ENFORCEMENT_READY, ...IDENTITY_ARCHIVE_ENFORCEMENT_READY]

export function isEnforcementReady(permissionKey: string): boolean {
  return ALL_ENFORCEMENT_READY_PERMISSIONS.includes(permissionKey)
}
