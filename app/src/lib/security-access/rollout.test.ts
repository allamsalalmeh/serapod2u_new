import { describe, expect, it } from 'vitest'
import { aggregateRollout, classifyPermission, filterRollout, rolloutMode, summarizeDifferences, type Rollout, type RolloutNode } from './rollout'
import { FINAL_WAVE_PERMISSION_KEYS } from './catalog'
import { IDENTITY_PERMISSION_KEYS } from './identity-catalog'
import { STAGE2D_PERMISSION_KEYS } from './stage2d-catalog'
import { USER_ADMIN_PERMISSION_KEYS } from './user-admin-catalog'

const WAVE1_KEYS = [
  'inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.post',
  'inventory.transfer.view', 'inventory.transfer.request', 'inventory.transfer.approve', 'inventory.transfer.dispatch',
  'inventory.transfer.receive', 'inventory.transfer.cancel', 'security.access.view', 'security.role.assign', 'security.permission.manage',
]
const MODES = ['NEW_ENFORCED', 'SHADOW', 'LEGACY_RETIRED']
const catalog = Array.from(new Set([...FINAL_WAVE_PERMISSION_KEYS, ...WAVE1_KEYS, ...IDENTITY_PERMISSION_KEYS, ...STAGE2D_PERMISSION_KEYS, ...USER_ADMIN_PERMISSION_KEYS]))
const catalogModes = catalog.map((permission_key, i) => ({ permission_key, mode: MODES[i % MODES.length] }))

const leafKeys = (r: Rollout) => r.groups.flatMap(g => [...g.permissions, ...g.children.flatMap(c => c.permissions)]).map(p => p.key)
const sumCounts = (nodes: RolloutNode[], mode: string) => nodes.reduce((n, x) => n + (x.counts[mode] ?? 0), 0)

describe('Overview hierarchy (Main group → Subgroup → Permission)', () => {
  const rollout = aggregateRollout(catalogModes)

  it('places every catalogue permission exactly once, with none left unmapped', () => {
    const keys = leafKeys(rollout)
    expect(keys.length).toBe(catalog.length)
    expect(new Set(keys).size).toBe(catalog.length)
    expect(rollout.groups.find(g => g.id === 'other')).toBeUndefined()
  })

  it('shows the seven main groups in order', () => {
    expect(rollout.groups.map(g => g.name)).toEqual(
      ['Supply Chain', 'Customer & Growth', 'HR & Payroll', 'Finance', 'Security & Access', 'Platform & Settings', 'Reporting'])
  })

  it('uses the shared taxonomy areas; Reporting expands straight to permissions', () => {
    const sub = (id: string) => rollout.groups.find(g => g.id === id)!.children.map(c => c.name)
    expect(sub('supply_chain')).toEqual(['Orders & Documents', 'Stock Count', 'Stock Transfer', 'Inventory', 'Warehouse', 'Manufacturing', 'Product Catalogue', 'QR & Traceability'])
    expect(sub('customer_growth')).toEqual(['CRM & Customers', 'Loyalty & Rewards', 'Messaging & Support', 'RoadTour', 'Marketing & Campaigns', 'Outdoor Store', 'E-Commerce'])
    expect(sub('hr_payroll')).toEqual(['Payroll & Compensation', 'Employees & Contracts', 'Time, Leave & Expenses', 'Performance & Learning', 'Employee Self-Service', 'HR Administration'])
    expect(sub('finance')).toEqual(['General Ledger', 'Payables & Payments', 'Receivables', 'Cash & Bank', 'Financial Reports', 'Finance Administration'])
    expect(sub('security_access')).toEqual(['Access Administration', 'Migration Modes', 'Security Governance', 'Review & Audit', 'Technical Access'])
    expect(sub('platform_settings')).toEqual(['Identity', 'User Administration', 'Notifications', 'Integrations & Settings', 'Organizations & Data'])
    const reporting = rollout.groups.find(x => x.id === 'reporting')!
    expect(reporting.children).toEqual([])
    expect(reporting.permissions.length).toBe(reporting.total)
    // Every catalogue permission has an area: nothing is left loose under a group with areas.
    for (const g of rollout.groups) if (g.children.length) expect(g.permissions).toEqual([])
  })

  it('reconciles subgroup → main group → overall totals for every mode', () => {
    for (const mode of MODES) {
      for (const g of rollout.groups) {
        expect(g.counts[mode] ?? 0).toBe(sumCounts(g.children, mode) + g.permissions.filter(p => p.mode === mode).length)
      }
      expect(sumCounts(rollout.groups, mode)).toBe(rollout.totals[mode])
      expect(rollout.totals[mode]).toBe(catalogModes.filter(m => m.mode === mode).length)
    }
    expect(rollout.groups.reduce((n, g) => n + g.total, 0)).toBe(rollout.total)
    expect(rollout.total).toBe(catalog.length)
  })

  it('classifies by stable key identifiers, not display text', () => {
    expect(classifyPermission('supply_chain.document.acknowledge')).toEqual({ groupId: 'supply_chain', subgroupId: 'orders' })
    expect(classifyPermission('inventory.stock_count.post')).toEqual({ groupId: 'supply_chain', subgroupId: 'stock_count' })
    expect(classifyPermission('inventory.opening_balance.manage')).toEqual({ groupId: 'supply_chain', subgroupId: 'inventory' })
    expect(classifyPermission('platform.user.profile_edit')).toEqual({ groupId: 'platform_settings', subgroupId: 'user_admin' })
    expect(classifyPermission('platform.data.destructive')).toEqual({ groupId: 'platform_settings', subgroupId: 'organizations' })
    expect(classifyPermission('hr.payroll.approve')).toEqual({ groupId: 'hr_payroll', subgroupId: 'payroll' })
    expect(classifyPermission('ecommerce.outdoor.operate')).toEqual({ groupId: 'customer_growth', subgroupId: 'outdoor' })
    expect(classifyPermission('reporting.analytics.view')).toEqual({ groupId: 'reporting', subgroupId: null })
  })

  it('keeps unknown categories visible in an explicit Other group and hides empty groups', () => {
    const r = aggregateRollout([
      { permission_key: 'finance.ledger.view', mode: 'NEW_ENFORCED' },
      { permission_key: 'logistics.route.plan', mode: 'SHADOW' },
    ])
    expect(r.groups.map(g => g.id)).toEqual(['finance', 'other'])
    expect(r.groups[1].name).toMatch(/Other/)
    expect(r.groups[1].permissions.map(p => p.key)).toEqual(['logistics.route.plan'])
    expect(r.total).toBe(2)
  })

  it('never drops a mode', () => {
    const r = aggregateRollout([...catalogModes.slice(0, 5), { permission_key: 'qr.batch.manage', mode: 'LEGACY_ENFORCED' }])
    expect(r.columns).toEqual(['NEW_ENFORCED', 'SHADOW', 'LEGACY_RETIRED', 'LEGACY_ENFORCED'])
    expect(sumCounts(r.groups, 'LEGACY_ENFORCED')).toBe(1)
  })

  it('counts each key once even if the source repeats it', () => {
    const r = aggregateRollout([{ permission_key: 'finance.ledger.view', mode: 'NEW_ENFORCED' }, { permission_key: 'finance.ledger.view', mode: 'NEW_ENFORCED' }])
    expect(r.total).toBe(1)
  })
})

describe('filterRollout', () => {
  const rollout = aggregateRollout(catalogModes)

  it('a permission match keeps only its ancestors and opens them', () => {
    const { rollout: f, autoOpen } = filterRollout(rollout, 'inventory.stock_count.post')
    expect(f.groups.map(g => g.id)).toEqual(['supply_chain'])
    expect(f.groups[0].children.map(c => c.id)).toEqual(['supply_chain/stock_count'])
    expect(leafKeys(f)).toEqual(['inventory.stock_count.post'])
    expect(autoOpen).toEqual(expect.arrayContaining(['supply_chain', 'supply_chain/stock_count']))
    expect(f.total).toBe(1)
  })

  it('a subgroup name match shows all its permissions', () => {
    const { rollout: f } = filterRollout(rollout, 'stock transfer')
    const sg = f.groups[0].children.find(c => c.id === 'supply_chain/stock_transfer')!
    expect(sg.total).toBe(rollout.groups[0].children.find(c => c.id === 'supply_chain/stock_transfer')!.total)
  })

  it('a main-group name match shows all its descendants', () => {
    const { rollout: f } = filterRollout(rollout, 'platform & settings')
    expect(f.groups.map(g => g.id)).toEqual(['platform_settings'])
    expect(f.groups[0].total).toBe(rollout.groups.find(g => g.id === 'platform_settings')!.total)
  })

  it('recomputes counts for the filtered tree and supports no results', () => {
    const { rollout: f } = filterRollout(rollout, 'approve')
    expect(f.total).toBe(leafKeys(f).length)
    expect(f.total).toBeLessThan(rollout.total)
    expect(filterRollout(rollout, 'zzz-nothing').rollout.groups).toEqual([])
    expect(filterRollout(rollout, '  ').rollout).toBe(rollout)
  })
})

describe('summarizeDifferences', () => {
  const modes = [
    { permission_key: 'finance.ledger.view', mode: 'NEW_ENFORCED' },
    { permission_key: 'customer.crm.view', mode: 'SHADOW' },
  ]
  const decisions = [
    { occurred_at: '2026-09-29T10:00:00Z', permission_key: 'customer.crm.view', comparison: 'LEGACY_ALLOW_NEW_DENY' },
    { occurred_at: '2026-09-28T09:00:00Z', permission_key: 'finance.ledger.view', comparison: 'SCOPE_MISMATCH' },
    { occurred_at: '2026-09-27T09:00:00Z', permission_key: 'finance.ledger.view', comparison: 'MATCH_DENY' },
  ]

  it('counts only real differences over the actual sample period and separates pending from historical', () => {
    const s = summarizeDifferences(decisions, modes, 100)
    expect(s).toMatchObject({ count: 2, from: '2026-09-27T09:00:00Z', to: '2026-09-29T10:00:00Z', pending: 1, historical: 1, capped: false })
    expect(s.pendingPermissions).toEqual(['customer.crm.view'])
    expect(summarizeDifferences(decisions, modes, 3).capped).toBe(true)
  })

  it('keeps the Overview wording without changing mode values', () => {
    expect(rolloutMode('SHADOW').label).toBe('Monitoring / Shadow')
    expect(rolloutMode('NEW_ENFORCED').label).toBe('New Access Active')
    expect(rolloutMode('LEGACY_RETIRED').label).toBe('Legacy Retired')
  })
})
