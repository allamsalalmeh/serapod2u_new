// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SupplyChainLandingView from './components/SupplyChainLandingView'
import SupplyChainTopNav from './components/SupplyChainTopNav'
import CustomerGrowthLandingView from '@/modules/customer-growth/components/CustomerGrowthLandingView'
import CustomerGrowthTopNav from '@/modules/customer-growth/components/CustomerGrowthTopNav'
import { computeDestinations } from '@/lib/security-access/nav-access'

let nav: any
vi.mock('@/hooks/useNavAccess', () => ({ useNavAccess: () => nav, useAccessibleNavGroups: (g: any) => g }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

const ready = (org: string[]) => {
  const destinations = computeDestinations({ org: Object.fromEntries(org.map(p => [p, true])), self: {} })
  const snapshot = { userId: 'u', organizationId: 'o', destinations, sidebar: { users: false, securityAccess: false }, policies: [] }
  return { status: 'ready', snapshot, allows: (id: string) => destinations[id] === true, allowsAny: () => false, refresh: vi.fn() }
}
const SC = ['product.catalog.view', 'qr.batch.manage', 'inventory.report.view']
const catalogLinks = () => screen.queryAllByText('Product Catalog')

beforeEach(() => { nav = undefined })
afterEach(cleanup)

describe('Supply Chain landing and top navigation offer the shared Product Catalog only to people who work in Supply Chain', () => {
  it('Supply Chain + catalog: the card link and the top navigation both reach the existing Product Catalog destination', () => {
    nav = ready(SC)
    const onViewChange = vi.fn()
    render(<SupplyChainLandingView onViewChange={onViewChange} orgTypeCode="HQ" roleLevel={10} />)
    expect(catalogLinks().length).toBe(1)
    catalogLinks()[0].click()
    expect(onViewChange).toHaveBeenCalledWith('product-catalog')
    cleanup()
    render(<SupplyChainTopNav currentView="product-catalog" onNavigate={vi.fn()} orgTypeCode="HQ" roleLevel={10} />)
    // Breadcrumb agrees with the module: Supply Chain > Products > Product Catalog (never Customer & Growth).
    expect(screen.queryByText('Customer & Growth')).toBeNull()
    expect(screen.getAllByText('Supply Chain').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Product Catalog').length).toBeGreaterThan(0)
  })
  it('catalog landing view id maps to the same destination', () => {
    nav = ready(SC)
    render(<SupplyChainTopNav currentView="catalog" onNavigate={vi.fn()} orgTypeCode="HQ" roleLevel={10} />)
    expect(screen.getAllByText('Product Catalog').length).toBeGreaterThan(0)
  })
  it('no catalog permission, catalog-only access and unresolved answers do not add the entry', () => {
    for (const value of [ready(['qr.batch.manage']), ready(['product.catalog.view']), { status: 'loading', snapshot: null, allows: () => false, allowsAny: () => false, refresh: vi.fn() }]) {
      nav = value
      render(<SupplyChainLandingView onViewChange={vi.fn()} orgTypeCode="HQ" roleLevel={10} />)
      expect(catalogLinks().length).toBe(0)
      cleanup()
    }
  })
})

describe('Customer & Growth landing and top navigation', () => {
  it('Supply Chain + catalog: no Product Catalog card or menu entry under Customer & Growth', () => {
    nav = ready(SC)
    render(<CustomerGrowthLandingView onViewChange={vi.fn()} />)
    expect(catalogLinks().length).toBe(0)
    cleanup()
    render(<CustomerGrowthTopNav currentView="customer-growth" onNavigate={vi.fn()} />)
    expect(catalogLinks().length).toBe(0)
  })
  it('catalog-only access keeps the Product Catalog card', () => {
    nav = ready(['product.catalog.view'])
    render(<CustomerGrowthLandingView onViewChange={vi.fn()} />)
    expect(catalogLinks().length).toBeGreaterThan(0)
  })
  it('both modules: the card list has Customer & Growth functions and the catalog appears once overall (Supply Chain)', () => {
    nav = ready([...SC, 'customer.crm.view', 'customer.consumer.view'])
    render(<CustomerGrowthLandingView onViewChange={vi.fn()} />)
    expect(screen.getByText('Customer Activity')).toBeTruthy()
    expect(catalogLinks().length).toBe(0)
    cleanup()
    render(<SupplyChainLandingView onViewChange={vi.fn()} orgTypeCode="HQ" roleLevel={10} />)
    expect(catalogLinks().length).toBe(1)
  })
})
