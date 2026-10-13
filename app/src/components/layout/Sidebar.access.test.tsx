// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar'
import { computeDestinations } from '@/lib/security-access/nav-access'

let nav: any
vi.mock('@/hooks/useNavAccess', () => ({ useNavAccess: () => nav, clearNavAccessCache: vi.fn() }))
vi.mock('@/lib/i18n/LanguageProvider', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/app/actions/auth', () => ({ signOut: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: new Error('none') }) }) }) }) }),
}))

const profile = {
  id: 'u-1', email: 'supply@dev.com', full_name: 'Supply User', role_code: 'GUEST', organization_id: 'org-hq', avatar_url: null,
  organizations: { id: 'org-hq', org_name: 'Serapod Technology Sdn Bhd', org_type_code: 'HQ' },
  roles: { role_name: 'Guest', role_level: 50 },
}
const snapshot = (org: string[], self: string[] = [], sidebar = { users: false, securityAccess: false }) => ({
  userId: 'u-1', organizationId: 'org-hq', policies: [], sidebar,
  destinations: computeDestinations({ org: Object.fromEntries(org.map(p => [p, true])), self: Object.fromEntries(self.map(p => [p, true])) }),
})
const ready = (s: any) => ({ status: 'ready', snapshot: s, allows: (id: string) => s.destinations[id] === true, allowsAny: () => false, refresh: vi.fn() })
const renderSidebar = () => render(<Sidebar userProfile={profile} currentView="dashboard" onViewChange={() => undefined} initialCollapsed={false} />)

beforeEach(() => { nav = undefined })
afterEach(cleanup)

describe('Sidebar follows effective access', () => {
  it('the Supply Chain Full Access + ESS user: Supply Chain and HR (My Workspace) yes; no Customer & Growth (the shared catalog lives in Supply Chain)', () => {
    nav = ready(snapshot(['product.catalog.view', 'qr.batch.manage'], ['hr.self_service.use']))
    renderSidebar()
    expect(screen.getByText('sidebar.supplyChain')).toBeTruthy()
    expect(screen.getByText('sidebar.hr')).toBeTruthy()
    // product.catalog.view is shared with Supply Chain Full Access: the catalog is offered under Supply Chain, never as the sole reason for Customer & Growth.
    expect(screen.queryByText('sidebar.customerGrowth')).toBeNull()
  })

  it('catalog-only access (no Supply Chain permission) keeps Customer & Growth', () => {
    nav = ready(snapshot(['product.catalog.view']))
    renderSidebar()
    expect(screen.getByText('sidebar.customerGrowth')).toBeTruthy()
  })

  it('both modules: Customer & Growth stays for its own functions', () => {
    nav = ready(snapshot(['product.catalog.view', 'qr.batch.manage', 'customer.crm.view', 'customer.consumer.view']))
    renderSidebar()
    expect(screen.getByText('sidebar.customerGrowth')).toBeTruthy()
    expect(screen.getByText('sidebar.supplyChain')).toBeTruthy()
  })

  it('on the catalog page only the module that offers it is highlighted', () => {
    const classes = (label: string) => screen.getByText(label).closest('button, a')?.className ?? ''
    const answersFor = (org: string[]) => ready(snapshot(org))
    const view = (org: string[], currentView: string) => {
      cleanup(); nav = answersFor(org)
      render(<Sidebar userProfile={profile} currentView={currentView} onViewChange={() => undefined} initialCollapsed={false} />)
      // A catalog-only person has no Supply Chain entry at all (the module needs a Supply Chain permission).
      return { sc: screen.queryByText('sidebar.supplyChain') ? classes('sidebar.supplyChain') : null, cg: classes('sidebar.customerGrowth') }
    }
    const both = ['product.catalog.view', 'qr.batch.manage', 'customer.crm.view', 'customer.consumer.view']
    const idle = view(both, 'dashboard')
    const scHome = view(both, 'product-catalog')
    expect(scHome.sc).not.toBe(idle.sc) // Supply Chain highlighted
    expect(scHome.cg).toBe(idle.cg) // Customer & Growth not
    const cgOrg = ['product.catalog.view', 'customer.crm.view', 'customer.consumer.view']
    const idleCg = view(cgOrg, 'dashboard')
    const cgHome = view(cgOrg, 'product-catalog')
    expect(cgHome.cg).not.toBe(idleCg.cg)
    expect([cgHome.sc, idleCg.sc]).toEqual([null, null])
  })

  it('hides Customer & Growth entirely when no child destination is accessible', () => {
    nav = ready(snapshot([], ['hr.self_service.use']))
    renderSidebar()
    expect(screen.queryByText('sidebar.customerGrowth')).toBeNull()
    expect(screen.getByText('sidebar.hr')).toBeTruthy()
  })

  it('hides Supply Chain without a Supply Chain permission (orderapp@dev.com: ESS only after Full Access was revoked)', () => {
    nav = ready(snapshot([], ['hr.self_service.use']))
    render(<Sidebar userProfile={{ ...profile, roles: { role_name: 'Super Admin', role_level: 1 } }} currentView="dashboard" onViewChange={() => undefined} initialCollapsed={false} />)
    expect(screen.queryByText('sidebar.supplyChain')).toBeNull()
  })

  it('shows Supply Chain for any one Supply Chain permission (Inventory Viewer, Order Approver)', () => {
    for (const org of [['inventory.stock.view'], ['supply_chain.order.approve']]) {
      cleanup(); nav = ready(snapshot(org))
      renderSidebar()
      expect(screen.getByText('sidebar.supplyChain'), org[0]).toBeTruthy()
    }
  })

  it('Finance follows the module entry decision, not the legacy role level (order@dev.com: HQ L50 with Finance Full Access)', () => {
    nav = ready(snapshot(['finance.module.view', 'finance.ledger.view', 'supply_chain.order.create'], ['hr.self_service.use']))
    renderSidebar()
    expect(screen.getByText('sidebar.finance')).toBeTruthy()
    expect(screen.getByText('sidebar.supplyChain')).toBeTruthy()
    expect(screen.getByText('sidebar.hr')).toBeTruthy()
  })

  it('hides Finance without the module entry (no grant, revoked or expired), whatever the role level', () => {
    nav = ready(snapshot(['finance.receivable.view', 'supply_chain.order.create']))
    render(<Sidebar userProfile={{ ...profile, roles: { role_name: 'Super Admin', role_level: 1 } }} currentView="dashboard" onViewChange={() => undefined} initialCollapsed={false} />)
    expect(screen.queryByText('sidebar.finance')).toBeNull()
  })

  it('hides HR for a person with no HR destination (non-HQ without ESS, revoked)', () => {
    nav = ready(snapshot(['product.catalog.view']))
    renderSidebar()
    expect(screen.queryByText('sidebar.hr')).toBeNull()
  })

  it('shows a skeleton (no partial menu, no gated entry) while access is unresolved', () => {
    nav = { status: 'loading', snapshot: null, allows: () => false, allowsAny: () => false, refresh: vi.fn() }
    const { container } = renderSidebar()
    expect(screen.getAllByRole('status').length).toBe(2)
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBe(2)
    for (const label of ['sidebar.hr', 'sidebar.customerGrowth', 'sidebar.supplyChain', 'sidebar.userManagement', 'Dashboard']) {
      expect(screen.queryByText(label)).toBeNull()
    }
    // Unresolved is not a confirmed denial: nothing says "denied" or offers a retry.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a recoverable error with Retry when the check fails, never a menu built from a fallback', () => {
    nav = { status: 'unavailable', snapshot: null, allows: () => false, allowsAny: () => false, refresh: vi.fn() }
    renderSidebar()
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn’t load your menu/)
    expect(screen.queryByText('sidebar.supplyChain')).toBeNull()
    expect(screen.queryByText('sidebar.userManagement')).toBeNull()
    screen.getByRole('button', { name: /retry/i }).click()
    expect(nav.refresh).toHaveBeenCalled()
  })

  it('ready: the whole menu appears together, with no skeleton left', () => {
    nav = ready(snapshot(['qr.batch.manage'], ['hr.self_service.use'], { users: true, securityAccess: true }))
    renderSidebar()
    expect(screen.queryAllByRole('status').length).toBe(0)
    for (const label of ['sidebar.supplyChain', 'sidebar.hr', 'sidebar.userManagement', 'Security & Access']) {
      expect(screen.getByText(label), label).toBeTruthy()
    }
  })

  it('User Management and Security & Access follow the server decisions (an HQ user holding neither sees neither)', () => {
    nav = ready(snapshot([], ['hr.self_service.use'], { users: false, securityAccess: false }))
    renderSidebar()
    expect(screen.queryByText('sidebar.userManagement')).toBeNull()
    expect(screen.queryByText('Security & Access')).toBeNull()
  })

  it('limited delegated administrator: Security & Access without User Management; a non-HQ user never gets User Management by a role rule alone', () => {
    nav = ready(snapshot([], [], { users: false, securityAccess: true }))
    renderSidebar()
    expect(screen.getByText('Security & Access')).toBeTruthy()
    expect(screen.queryByText('sidebar.userManagement')).toBeNull()
    cleanup()
    nav = ready(snapshot([], [], { users: true, securityAccess: false }))
    render(<Sidebar userProfile={{ ...profile, organizations: { ...profile.organizations, org_type_code: 'MANU' } }} currentView="dashboard" onViewChange={() => undefined} initialCollapsed={false} />)
    expect(screen.queryByText('sidebar.userManagement')).toBeNull()
  })

  it('labels the person as staff with their organization, not Guest / Level 50', () => {
    nav = ready(snapshot([], ['hr.self_service.use']))
    const { container } = renderSidebar()
    expect(container.textContent).toContain('HQ staff • Serapod Technology Sdn Bhd')
    expect(container.textContent).not.toMatch(/Guest|Level|\b50\b/)
  })
})
