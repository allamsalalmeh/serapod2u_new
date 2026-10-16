import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_GROWTH_DESTINATIONS,
  FINANCE_DESTINATIONS,
  financeModuleVisible,
  HR_DESTINATIONS,
  NAV_DESTINATIONS,
  ROADTOUR_DESTINATIONS,
  SUPPLY_CHAIN_ACCESS_PERMISSIONS,
  SUPPLY_CHAIN_WORK_DESTINATION,
  customerGrowthChildVisible,
  productCatalogHome,
  computeDestinations,
  customerGrowthVisible,
  destinationAllowed,
  hrAdminVisible,
  hrDestinationId,
  hrModuleVisible,
  navPermissionPlan,
  snapshotAllows,
  type NavAccessSnapshot,
  type PermissionAnswers,
} from './nav-access'
import { filterHrNavGroups, hrNavGroups } from '@/modules/hr/hrNav'
import { customerGrowthNavGroups, describeCustomerGrowthFunctions, filterCustomerGrowthNavGroups } from '@/modules/customer-growth/customerGrowthNav'
import { classifyPermission } from './modules'
import { FINAL_WAVE_CATALOG } from './catalog'
import { STAGE2D_PERMISSION_KEYS } from './stage2d-catalog'
import { filterSupplyChainNavForUser, getSupplyChainBreadcrumb } from '@/modules/supply-chain/supplyChainNav'
import { filterRoadtourNavGroups, roadtourNavGroups } from '@/modules/roadtour/roadtourNav'

// Isolated fixtures: per-permission answers, exactly what the server's canonical evaluation returns for each person.
const answers = (org: string[] = [], self: string[] = []): PermissionAnswers => ({
  org: Object.fromEntries(org.map(p => [p, true])),
  self: Object.fromEntries(self.map(p => [p, true])),
})
const snapshot = (a: PermissionAnswers): NavAccessSnapshot => ({ userId: 'u1', organizationId: 'o1', destinations: computeDestinations(a), sidebar: { users: false, securityAccess: false }, policies: [] })

// Supply Chain Full Access (permissions of the real policy that matter for navigation) + the ESS baseline.
const SUPPLY_CHAIN_FULL = ['product.catalog.view', 'product.catalog.manage', 'qr.batch.manage', 'supply_chain.order.create', 'inventory.report.view', 'warehouse.receipt.post']
const HR_ADMIN = ['hr.module.view', 'hr.employee.view', 'hr.employee.manage', 'hr.attendance.manage', 'hr.leave.approve', 'hr.payroll.view', 'hr.compensation.view', 'hr.settings.manage', 'hr.performance.manage', 'hr.employee.view_internal']

const supplyChainPlusEss = snapshot(answers(SUPPLY_CHAIN_FULL, ['hr.self_service.use']))
const essOnly = snapshot(answers([], ['hr.self_service.use']))
const hrAdmin = snapshot(answers(HR_ADMIN, ['hr.self_service.use']))
const withCustomerGrowth = snapshot(answers([...SUPPLY_CHAIN_FULL, 'customer.crm.view', 'customer.consumer.view', 'customer.support.manage', 'marketing.module.view', 'customer.campaign.manage'], ['hr.self_service.use']))
// The reproduction at the evaluation level: the SHADOW legacy rule (HQ, level <= 50) answers ALLOW for the CRM module entry
// (customer.crm.view), but no S&A policy grants any CRM function permission.
const legacyCrmEntryOnly = snapshot(answers([...SUPPLY_CHAIN_FULL, 'customer.crm.view', 'marketing.module.view']))
const cgGroups = (snap: NavAccessSnapshot) => filterCustomerGrowthNavGroups(id => customerGrowthChildVisible(snap, id))
const catalogOnly = snapshot(answers(['product.catalog.view']))
const bothModules = snapshot(answers([...SUPPLY_CHAIN_FULL, 'customer.crm.view', 'customer.consumer.view']))
const nonHqNoEss = snapshot(answers(['product.catalog.view'], []))
const revoked = snapshot(answers([], []))

describe('HQ user with Supply Chain Full Access + Employee Self-Service (the reproduction)', () => {
  it('gets My Workspace, not the administrative HR landing or any administrative page', () => {
    expect(snapshotAllows(supplyChainPlusEss, 'hr/my-workspace')).toBe(true)
    expect(hrModuleVisible(supplyChainPlusEss)).toBe(true)
    expect(hrAdminVisible(supplyChainPlusEss)).toBe(false)
    for (const id of ['hr', 'hr/people/employees', 'hr/people/departments', 'hr/leave/requests', 'hr/payroll/payslips', 'hr/settings/configuration', 'hr/people/org-chart', 'hr:manage-people']) {
      expect(snapshotAllows(supplyChainPlusEss, id), id).toBe(false)
    }
  })

  it('keeps the shared Product Catalog authorized but homes it in Supply Chain: Customer & Growth is not shown at all', () => {
    const allowed = (id: string) => snapshotAllows(supplyChainPlusEss, id)
    expect(allowed('product-catalog')).toBe(true) // authorization is unchanged: product.catalog.view is held
    expect(allowed('catalog')).toBe(true)
    for (const id of ['crm', 'consumer-activations', 'support-inbox', 'mktg', 'marketing', 'journey-builder', 'loyalty', 'point-catalog', 'redeem-gift-management', 'ecommerce', 'hero-banners', 'roadtour']) {
      expect(allowed(id), id).toBe(false)
    }
    expect(productCatalogHome(supplyChainPlusEss)).toBe('supply-chain')
    expect(customerGrowthVisible(supplyChainPlusEss)).toBe(false)
    expect(cgGroups(supplyChainPlusEss)).toEqual([])
    expect(filterRoadtourNavGroups(allowed)).toEqual([])
  })

  it('offers the Product Catalog in the Supply Chain Products group, with a Supply Chain breadcrumb', () => {
    const groups = filterSupplyChainNavForUser('HQ', 10, productCatalogHome(supplyChainPlusEss) === 'supply-chain')
    expect(groups.find(g => g.id === 'sc-products')!.children.map(c => c.id)).toEqual(['products', 'product-management', 'product-catalog'])
    expect(getSupplyChainBreadcrumb('product-catalog', true).map(c => c.label)).toEqual(['Supply Chain', 'Products', 'Product Catalog'])
    expect(getSupplyChainBreadcrumb('catalog', true).map(c => c.label)).toEqual(['Supply Chain', 'Products', 'Product Catalog'])
    // Not offered (and breadcrumb unchanged) for everyone else.
    expect(filterSupplyChainNavForUser('HQ', 10).flatMap(g => g.children.map(c => c.id))).not.toContain('product-catalog')
  })

  it('does not unlock Customer & Growth through Supply Chain permissions alone', () => {
    const scOnly = snapshot(answers(SUPPLY_CHAIN_FULL.filter(p => !p.startsWith('product.catalog'))))
    expect(customerGrowthVisible(scOnly)).toBe(false)
    expect(productCatalogHome(scOnly)).toBeNull()
    expect(cgGroups(scOnly)).toEqual([])
  })

  it('shows only employee items in the HR navigation and landing (no administrative setup cards)', () => {
    const groups = filterHrNavGroups(ids => ids.some(id => snapshotAllows(supplyChainPlusEss, id)))
    expect(groups.map(g => g.id)).toEqual(['hr-workspace'])
    expect(groups[0].children.map(c => c.id)).toEqual(['hr/my-workspace', 'hr/mobile/attendance', 'hr/mobile/leave', 'hr/mobile/payslip'])
  })
})

describe('Employee Self-Service only', () => {
  it('sees HR (My Workspace) and nothing of Customer & Growth or RoadTour', () => {
    expect(hrModuleVisible(essOnly)).toBe(true)
    expect(hrAdminVisible(essOnly)).toBe(false)
    expect(customerGrowthVisible(essOnly)).toBe(false)
    expect(snapshotAllows(essOnly, 'roadtour')).toBe(false)
  })
  it('sees the staff organization chart only with the staff directory permission, not the administrative chart', () => {
    expect(snapshotAllows(essOnly, 'hr/people/org-chart/staff')).toBe(false)
    const withDirectory = snapshot(answers(['hr.employee.view_internal'], ['hr.self_service.use']))
    expect(snapshotAllows(withDirectory, 'hr/people/org-chart/staff')).toBe(true)
    expect(snapshotAllows(withDirectory, 'hr/people/org-chart')).toBe(false)
    expect(filterHrNavGroups(ids => ids.some(id => snapshotAllows(withDirectory, id))).flatMap(g => g.children.map(c => c.id))).toContain('hr/people/org-chart')
  })
})

describe('HR administrator', () => {
  it('keeps the administrative landing and the pages their permissions allow, and not the ones they do not', () => {
    expect(hrAdminVisible(hrAdmin)).toBe(true)
    for (const id of ['hr', 'hr/people/employees', 'hr/people/org-chart', 'hr/attendance/timesheets', 'hr/leave/requests', 'hr/payroll/payslips', 'hr/payroll/salary-structure', 'hr/settings/configuration', 'hr/performance/kpis', 'hr:manage-people']) {
      expect(snapshotAllows(hrAdmin, id), id).toBe(true)
    }
    for (const id of ['hr/recruitment', 'hr/benefits', 'hr/learning', 'hr/analytics']) expect(snapshotAllows(hrAdmin, id), id).toBe(false)
  })
  it('needs the module entry permission for administrative destinations', () => {
    const noEntry = snapshot(answers(['hr.employee.view', 'hr.payroll.view']))
    expect(snapshotAllows(noEntry, 'hr/people/employees')).toBe(false)
    expect(snapshotAllows(noEntry, 'hr/payroll/payslips')).toBe(false)
  })
  it('keeps the desktop attendance administration away from self-service; employees use My Attendance', () => {
    expect(snapshotAllows(essOnly, 'hr/attendance/clock-in-out')).toBe(false)
    expect(snapshotAllows(essOnly, 'hr/attendance/timesheets')).toBe(false)
    expect(snapshotAllows(essOnly, 'hr/my-workspace')).toBe(true)
  })
})

describe('CRM module entry without a function permission (supply@dev.com reproduction)', () => {
  it('shows none of CRM, Customer Activity or Support Inbox: the entry permission alone opens nothing', () => {
    for (const id of ['crm', 'consumer-activations', 'support-inbox', 'mktg', 'landing-pages', 'journey-builder', 'marketing']) {
      expect(snapshotAllows(legacyCrmEntryOnly, id), id).toBe(false)
    }
    // Event Management is the one Marketing destination gated by the module entry alone
    // (marketing.module.view; no event.* function permission exists yet).
    expect(snapshotAllows(legacyCrmEntryOnly, 'event-management')).toBe(true)
    const groups = cgGroups(legacyCrmEntryOnly)
    expect(groups.map(g => g.id)).toEqual(['cg-marketing']) // only Event Management remains
    expect(groups.flatMap(g => g.children.map(c => c.id))).toEqual(['event-management'])
    expect(customerGrowthVisible(legacyCrmEntryOnly)).toBe(false)
    // Without Supply Chain work the same shared catalog keeps its Customer & Growth home; the
    // Marketing module entry now also reveals Event Management (module entry alone, no function).
    const catalogGroups = cgGroups(snapshot(answers(['customer.crm.view', 'marketing.module.view', 'product.catalog.view'])))
    expect(describeCustomerGrowthFunctions(catalogGroups)).toBe('Manage marketing campaigns and field tours and the product catalog.')
  })
  it('each CRM function needs its own permission, never the sibling\'s', () => {
    const activityOnly = snapshot(answers(['customer.crm.view', 'customer.consumer.view']))
    expect(snapshotAllows(activityOnly, 'consumer-activations')).toBe(true)
    expect(snapshotAllows(activityOnly, 'support-inbox')).toBe(false)
    const supportOnly = snapshot(answers(['customer.crm.view', 'customer.support.manage']))
    expect(snapshotAllows(supportOnly, 'support-inbox')).toBe(true)
    expect(snapshotAllows(supportOnly, 'consumer-activations')).toBe(false)
    expect(snapshotAllows(supportOnly, 'crm')).toBe(true)
    const noEntry = snapshot(answers(['customer.consumer.view', 'customer.support.manage']))
    expect(snapshotAllows(noEntry, 'crm')).toBe(false)
  })
  it('Product Catalog stays reachable for Supply Chain Full Access (the policy includes the product catalogue)', () => {
    expect(snapshotAllows(supplyChainPlusEss, 'product-catalog')).toBe(true)
    expect(snapshotAllows(supplyChainPlusEss, 'crm')).toBe(false)
  })
  it('describes only what is available', () => {
    expect(describeCustomerGrowthFunctions([{ id: 'cg-crm' }, { id: 'cg-catalog' }])).toBe('Manage customer conversations and activity and the product catalog.')
    expect(describeCustomerGrowthFunctions([])).toMatch(/No Customer & Growth/)
  })
})

describe('A user granted an additional Customer & Growth policy', () => {
  it('sees exactly the granted children, with their parent entry', () => {
    expect(customerGrowthVisible(withCustomerGrowth)).toBe(true)
    const groups = cgGroups(withCustomerGrowth)
    expect(groups.map(g => g.id).sort()).toEqual(['cg-crm', 'cg-loyalty', 'cg-marketing']) // the catalog is offered once, under Supply Chain // campaign.manage also covers lucky draw and games
    expect(groups.find(g => g.id === 'cg-crm')!.children.map(c => c.id).sort()).toEqual(['consumer-activations', 'support-inbox'])
    // RoadTour sits under Marketing in the Customer & Growth menu but needs its own permission.
    expect(groups.find(g => g.id === 'cg-marketing')!.children.map(c => c.id)).not.toContain('roadtour')
  })
  it('opens RoadTour sections only with the matching RoadTour permission', () => {
    const rt = snapshot(answers(['roadtour.report.view']))
    const groups = filterRoadtourNavGroups(id => snapshotAllows(rt, id))
    expect(groups.map(g => g.id)).toEqual(['rt-reporting'])
    expect(groups[0].children.map(c => c.id)).not.toContain('roadtour-kpi-settings')
    expect(snapshotAllows(rt, 'roadtour')).toBe(true)
  })
})

describe('Product Catalog home (one place per person)', () => {
  it('catalog-only access (no Supply Chain work) keeps Customer & Growth and the catalog card', () => {
    expect(productCatalogHome(catalogOnly)).toBe('customer-growth')
    expect(customerGrowthVisible(catalogOnly)).toBe(true)
    expect(cgGroups(catalogOnly).flatMap(g => g.children.map(c => c.id))).toEqual(['product-catalog'])
    expect(filterSupplyChainNavForUser('HQ', 10, productCatalogHome(catalogOnly) === 'supply-chain').flatMap(g => g.children.map(c => c.id))).not.toContain('product-catalog')
  })
  it('both modules: Customer & Growth stays for its own functions, the catalog appears once (Supply Chain)', () => {
    expect(customerGrowthVisible(bothModules)).toBe(true)
    expect(productCatalogHome(bothModules)).toBe('supply-chain')
    const ids = cgGroups(bothModules).flatMap(g => g.children.map(c => c.id))
    expect(ids).toEqual(['consumer-activations']) // support inbox needs its own permission
    expect(ids).not.toContain('product-catalog')
    expect(cgGroups(bothModules).map(g => g.id)).not.toContain('cg-catalog')
  })
  it('Customer & Growth functions alone (no catalog, no Supply Chain) behave as before', () => {
    const crmOnly = snapshot(answers(['customer.crm.view', 'customer.consumer.view']))
    expect(productCatalogHome(crmOnly)).toBeNull()
    expect(customerGrowthVisible(crmOnly)).toBe(true)
  })
  it('no catalog permission means no home anywhere, even with Supply Chain work', () => {
    expect(productCatalogHome(snapshot(answers(['qr.batch.manage'])))).toBeNull()
  })
  it('is unresolved (null) without answers, and revocation removes the catalog from both modules', () => {
    expect(productCatalogHome(null)).toBeNull()
    expect(productCatalogHome(revoked)).toBeNull()
  })
  it('grant changes move the home without stale state: the answers are the only input', () => {
    const before = snapshot(answers(['product.catalog.view']))
    const after = snapshot(answers(['product.catalog.view', 'inventory.report.view']))
    expect([productCatalogHome(before), productCatalogHome(after)]).toEqual(['customer-growth', 'supply-chain'])
  })
})

describe('Supply Chain work permissions', () => {
  it('are exactly the taxonomy Supply Chain permissions known to the catalogues, minus the shared catalog view', () => {
    const known = new Set([...FINAL_WAVE_CATALOG.map(e => e.key), ...STAGE2D_PERMISSION_KEYS])
    const scKnown = [...known].filter(k => classifyPermission(k).groupId === 'supply_chain' && k !== 'product.catalog.view')
    for (const key of scKnown) expect(SUPPLY_CHAIN_ACCESS_PERMISSIONS, key).toContain(key)
    for (const key of SUPPLY_CHAIN_ACCESS_PERMISSIONS) expect(classifyPermission(key).groupId, key).toBe('supply_chain')
    expect(SUPPLY_CHAIN_ACCESS_PERMISSIONS).not.toContain('product.catalog.view')
  })
  it('are not a Customer & Growth child and not part of any other destination', () => {
    expect(CUSTOMER_GROWTH_DESTINATIONS[SUPPLY_CHAIN_WORK_DESTINATION]).toBeUndefined()
    expect(NAV_DESTINATIONS[SUPPLY_CHAIN_WORK_DESTINATION]).toBeDefined()
  })
})

describe('Non-HQ user without ESS, revoked access and failed checks', () => {
  it('gets no HR at all', () => {
    expect(hrModuleVisible(nonHqNoEss)).toBe(false)
    expect(filterHrNavGroups(ids => ids.some(id => snapshotAllows(nonHqNoEss, id)))).toEqual([])
  })
  it('shows nothing after revocation', () => {
    expect(hrModuleVisible(revoked)).toBe(false)
    expect(customerGrowthVisible(revoked)).toBe(false)
    expect(Object.values(revoked.destinations).some(Boolean)).toBe(false)
  })
  it('shows nothing when there is no snapshot (loading or failed permission check): unknown is never an allow', () => {
    expect(hrModuleVisible(null)).toBe(false)
    expect(customerGrowthVisible(undefined)).toBe(false)
    expect(snapshotAllows(null, 'hr/my-workspace')).toBe(false)
  })
})

describe('destination registry', () => {
  it('registers every destination the navigation trees refer to', () => {
    for (const group of hrNavGroups) {
      for (const child of group.children) {
        for (const id of child.requiresAny ?? [child.id]) expect(NAV_DESTINATIONS[id], `${group.id}/${id}`).toBeDefined()
      }
    }
    for (const group of customerGrowthNavGroups) for (const child of group.children) expect(NAV_DESTINATIONS[child.id], child.id).toBeDefined()
    for (const group of roadtourNavGroups) {
      expect(NAV_DESTINATIONS[group.requires], group.id).toBeDefined()
      for (const child of group.children) expect(NAV_DESTINATIONS[child.requires ?? group.requires], child.id).toBeDefined()
    }
  })
  it('never gates an administrative HR destination on Employee Self-Service alone', () => {
    for (const [id, req] of Object.entries(HR_DESTINATIONS)) {
      if (id === 'hr/my-workspace' || id === 'hr/self-service/overview') continue
      expect(req.self, id).toBeUndefined()
    }
  })
  it('keeps Customer & Growth and RoadTour independent of HR and Supply Chain permissions', () => {
    for (const [id, req] of Object.entries({ ...CUSTOMER_GROWTH_DESTINATIONS, ...ROADTOUR_DESTINATIONS })) {
      const perms = [...(req.org ?? []), ...(req.self ?? []), ...(req.staff ?? [])]
      expect(perms.some(p => /^(hr|supply_chain|inventory|warehouse|manufacturing|qr)\./.test(p)), id).toBe(false)
    }
  })
  it('plans each permission on the right kind of resource (own record only for self-service)', () => {
    const plan = navPermissionPlan()
    expect(plan.self).toEqual(['hr.self_service.use'])
    expect(plan.org).not.toContain('hr.self_service.use')
  })
  it('normalizes view ids and paths onto destinations', () => {
    expect(hrDestinationId('/hr/people/employees')).toBe('hr/people/employees')
    expect(hrDestinationId('hr-people')).toBe('hr/people')
    expect(hrDestinationId('hr-settings')).toBe('hr/settings')
    expect(hrDestinationId('hr/recruitment/offers')).toBe('hr/recruitment')
    expect(hrDestinationId('hr/learning/overview')).toBe('hr/learning')
    expect(hrDestinationId('hr/org-chart')).toBe('hr/people/org-chart')
  })
  it('destinationAllowed treats an unknown shape as denied', () => {
    expect(destinationAllowed({}, answers(['hr.module.view'], ['hr.self_service.use']))).toBe(false)
  })
})

describe('Finance destinations', () => {
  it('register every Finance menu entry and every /finance page route (an unregistered page would be denied)', async () => {
    const { financeNavGroups } = await import('@/modules/finance/financeNav')
    const { readdirSync, statSync } = await import('node:fs')
    const { join, relative } = await import('node:path')
    for (const child of financeNavGroups.flatMap(g => g.children)) expect(FINANCE_DESTINATIONS[child.id], child.id).toBeDefined()
    const root = join(__dirname, '../../app/finance')
    const routes: string[] = []
    const walk = (dir: string) => readdirSync(dir).forEach(name => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name === 'page.tsx') routes.push(['finance', relative(root, dir)].filter(Boolean).join('/'))
    })
    walk(root)
    expect(routes.length).toBeGreaterThan(20)
    for (const id of routes) expect(FINANCE_DESTINATIONS[id], id).toBeDefined()
  })

  it('every Finance destination requires the module entry; data sections also need their own read permission', () => {
    const moduleOnly = new Set(['finance', 'finance/status', 'finance/settings/permissions'])
    for (const [id, req] of Object.entries(FINANCE_DESTINATIONS)) {
      expect(req.module, id).toBe('finance.module.view')
      expect(req.self ?? req.staff, id).toBeUndefined()
      if (!moduleOnly.has(id)) expect(req.org?.length, id).toBeGreaterThan(0)
      // Operations are never a navigation requirement (they are decided on the server, per operation).
      for (const p of req.org ?? []) expect(['finance.journal.post', 'finance.payment.approve', 'finance.data.reset', 'finance.reconciliation.perform']).not.toContain(p)
    }
  })

  it('financeModuleVisible is the landing destination answer', () => {
    const snap = (org: string[]) => ({ userId: 'u', organizationId: 'o', sidebar: { users: false, securityAccess: false }, policies: [],
      destinations: computeDestinations({ org: Object.fromEntries(org.map(p => [p, true])), self: {} }) })
    expect(financeModuleVisible(snap(['finance.module.view']))).toBe(true)
    expect(financeModuleVisible(snap(['finance.ledger.view', 'finance.payment.approve']))).toBe(false)
    expect(financeModuleVisible(null)).toBe(false)
  })
})
