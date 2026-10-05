import { describe, expect, it } from 'vitest'
import { comparisonLabel, modeLabel, permissionLabel, reasonLabel, warehousesForOrganization } from './labels'

describe('Security & Access labels', () => {
  it('gives every Wave 1 permission a friendly label, group and resource type', () => {
    expect(permissionLabel('inventory.stock_count.view')).toEqual({ label: 'View Stock Count', group: 'Stock Count', resourceType: 'stock_count' })
    expect(permissionLabel('inventory.stock_count.create').label).toBe('Create Stock Count')
    expect(permissionLabel('inventory.stock_count.verify').label).toBe('Verify Stock Count')
    expect(permissionLabel('inventory.stock_count.post').label).toBe('Post Stock Count')
    expect(permissionLabel('inventory.transfer.dispatch')).toEqual({ label: 'Dispatch Stock Transfer', group: 'Stock Transfer', resourceType: 'stock_transfer' })
    expect(permissionLabel('security.role.assign')).toMatchObject({ label: 'Assign Business Roles', group: 'Security Administration', resourceType: 'business_role' })
    expect(permissionLabel('security.access.view').group).toBe('Security Administration')
  })

  it('falls back to readable text for unknown keys', () => {
    expect(permissionLabel('hr.leave_request.approve')).toMatchObject({ label: 'Approve Leave Request', group: 'HR & Payroll' })
    expect(permissionLabel('unknownmod.thing.do')).toMatchObject({ label: 'Do Thing', group: 'Unknownmod' })
    expect(permissionLabel('finance.report.view_sensitive')).toMatchObject({ label: 'View sensitive Financial Reports', group: 'Finance' })
    expect(modeLabel('NEW_ENFORCED').label).toBe('New Access Active')
    expect(comparisonLabel('LEGACY_ALLOW_NEW_DENY').label).toBe('Legacy allows, new denies')
    expect(reasonLabel('SCOPE_MISMATCH')).toMatch(/different organization or warehouse/)
    expect(reasonLabel(undefined)).toBe('—')
  })

  it('lists only warehouses belonging to the selected organization', () => {
    const orgs = [
      { id: 'hq', org_name: 'HQ', org_type_code: 'HQ', parent_org_id: null },
      { id: 'dist', org_name: 'Dist', org_type_code: 'DIST', parent_org_id: 'hq' },
      { id: 'wh1', org_name: 'WH1', org_type_code: 'WH', parent_org_id: 'hq' },
      { id: 'wh2', org_name: 'WH2', org_type_code: 'WH', parent_org_id: 'dist' },
      { id: 'hqb', org_name: 'HQ B', org_type_code: 'HQ', parent_org_id: null },
      { id: 'whb', org_name: 'WH B', org_type_code: 'WH', parent_org_id: 'hqb' },
    ]
    expect(warehousesForOrganization(orgs, 'hq').map(o => o.id)).toEqual(['wh1', 'wh2'])
    expect(warehousesForOrganization(orgs, 'dist').map(o => o.id)).toEqual(['wh2'])
    expect(warehousesForOrganization(orgs, 'wh1').map(o => o.id)).toEqual(['wh1'])
    expect(warehousesForOrganization(orgs, 'hqb').map(o => o.id)).toEqual(['whb'])
    expect(warehousesForOrganization(orgs, '').map(o => o.id)).toEqual(['wh1', 'wh2', 'whb'])
  })
})
