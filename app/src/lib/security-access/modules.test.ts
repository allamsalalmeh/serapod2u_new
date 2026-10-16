import { describe, expect, it } from 'vitest'
import {
  CROSS_MODULE, MODULE_TAXONOMY, OTHER_MODULE, classifyPermission, classifyRole, classifyServiceTeam, groupByModule,
  permissionModuleLabel, roleInModule,
} from './modules'
import { FINAL_WAVE_PERMISSION_KEYS } from './catalog'
import { IDENTITY_PERMISSION_KEYS } from './identity-catalog'
import { STAGE2D_PERMISSION_KEYS } from './stage2d-catalog'
import { USER_ADMIN_PERMISSION_KEYS } from './user-admin-catalog'
import { BANK_STATEMENT_PERMISSION_KEYS } from './bank-statement-catalog'

const catalog = Array.from(new Set([...FINAL_WAVE_PERMISSION_KEYS, ...IDENTITY_PERMISSION_KEYS, ...STAGE2D_PERMISSION_KEYS, ...USER_ADMIN_PERMISSION_KEYS]))
const role = (...keys: string[]) => ({ permissions: keys.map(k => ({ permission: { permission_key: k } })) })

describe('S&A module taxonomy', () => {
  it('maps every catalogue permission to a known group, and to an area wherever the group has areas', () => {
    for (const key of catalog) {
      const c = classifyPermission(key)
      expect(c.groupId, key).not.toBe(OTHER_MODULE.id)
      const group = MODULE_TAXONOMY.find(g => g.id === c.groupId)!
      if (group.areas) expect(c.areaId, key).not.toBeNull()
    }
  })

  it('keeps unknown modules visible as Other / Unmapped', () => {
    expect(classifyPermission('logistics.route.plan')).toEqual({ groupId: 'other', areaId: null, areaName: null })
    expect(permissionModuleLabel('logistics.route.plan')).toBe('Other / Unmapped')
  })

  it('classifies by key identifiers, keeping report permissions in their originating module', () => {
    expect(permissionModuleLabel('customer.report.view')).toBe('Customer & Growth · CRM & Customers')
    expect(permissionModuleLabel('roadtour.report.view')).toBe('Customer & Growth · RoadTour')
    expect(permissionModuleLabel('finance.report.view_sensitive')).toBe('Finance · Financial Reports')
    expect(permissionModuleLabel('reporting.analytics.view')).toBe('Reporting')
  })

  it('gives Outdoor its own area instead of folding it into generic E-Commerce', () => {
    expect(classifyPermission('ecommerce.outdoor.operate')).toMatchObject({ groupId: 'customer_growth', areaId: 'outdoor', areaName: 'Outdoor Store' })
    expect(classifyPermission('ecommerce.order.manage')).toMatchObject({ groupId: 'customer_growth', areaId: 'ecommerce' })
  })

  it('classifies roles by the permissions they hold, never by name', () => {
    expect(classifyRole({ name: 'Outdoor Store Operator', ...role('ecommerce.outdoor.operate') })).toMatchObject({ groupId: 'customer_growth', crossModule: false })
    // A module-entry permission only adds a related-module tag.
    expect(classifyRole(role('hr.payroll.approve', 'finance.module.view'))).toEqual({ groupId: 'hr_payroll', modules: ['hr_payroll', 'finance'], related: ['finance'], crossModule: false })
    // Substantive permissions in several groups make a role cross-module.
    expect(classifyRole(role('hr.payroll.approve', 'finance.payment.approve'))).toEqual({ groupId: CROSS_MODULE.id, modules: ['hr_payroll', 'finance'], related: ['hr_payroll', 'finance'], crossModule: true })
    expect(classifyRole(role())).toMatchObject({ groupId: OTHER_MODULE.id })
    expect(classifyRole(role('logistics.route.plan'))).toMatchObject({ groupId: OTHER_MODULE.id })
  })

  it('keeps cross-module roles discoverable from every module they touch', () => {
    const pfa = role('hr.payroll.approve', 'finance.payment.approve')
    expect(roleInModule(pfa, 'hr_payroll')).toBe(true)
    expect(roleInModule(pfa, 'finance')).toBe(true)
    expect(roleInModule(pfa, CROSS_MODULE.id)).toBe(true)
    expect(roleInModule(pfa, 'supply_chain')).toBe(false)
    expect(roleInModule(pfa, 'all')).toBe(true)
  })

  it('maps service owner teams onto the taxonomy and keeps unknown teams visible', () => {
    expect(classifyServiceTeam('E-Commerce')).toEqual({ groupId: 'customer_growth', areaName: 'E-Commerce' })
    expect(classifyServiceTeam('Security')).toEqual({ groupId: 'security_access', areaName: 'Security Governance' })
    expect(classifyServiceTeam('Supply Chain')).toEqual({ groupId: 'supply_chain', areaName: null })
    expect(classifyServiceTeam('Logistics')).toEqual({ groupId: 'other', areaName: 'Logistics' })
    expect(classifyServiceTeam(null)).toEqual({ groupId: 'other', areaName: null })
  })

  it('groups in taxonomy order, then Shared, then Other, and hides empty groups', () => {
    const items = ['other', 'finance', 'cross_module', 'supply_chain', 'finance']
    expect(groupByModule(items, x => x).map(g => [g.name, g.items.length])).toEqual([
      ['Supply Chain', 1], ['Finance', 2], ['Shared / Cross-module', 1], ['Other / Unmapped', 1],
    ])
  })
})
