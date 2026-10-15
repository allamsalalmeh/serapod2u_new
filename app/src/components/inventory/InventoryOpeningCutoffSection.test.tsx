// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InventoryOpeningCutoffSection from './InventoryOpeningCutoffSection'
import { INVENTORY_DATA_REFRESH_EVENT } from '@/lib/inventory/inventory-data-refresh'

// ---------------------------------------------------------------------------
// A read-only preview fixture: one actionable (submitted) D2H order with two
// lines, one closed historical D2H order, one H2M order and no blocking activity.
// ---------------------------------------------------------------------------
const buildReport = (overrides: Record<string, unknown> = {}) => ({
  cutoff_id: 'cutoff-1',
  status: 'counting',
  proposed_cutoff_at: '2026-07-31T09:32:00Z',
  warehouse_organization_id: 'wh-1',
  company_id: 'co-1',
  product_category_name: 'Vape',
  readiness: 'Blocked',
  freeze_active: true,
  qr_status: 'Protected — No Impact',
  notice: 'Preview only — no inventory, order, allocation, or QR data will be changed.',
  inventory: [
    { stock_config_id: 'c1', variant_name: 'Mango', stock_configuration: '20ml New Box', system_quantity: 100, physical_quantity: 100, variance: 0, allocated_quantity: 0 },
  ],
  distributor_orders: [
    { order_id: 'ord-so85', order_item_id: 'd1', order_number: 'SO26000085', status: 'submitted', customer: 'Distributor ABC', warehouse: 'WH Balakong', variant_id: 'var-potato', variant: 'Potato', quantity: 500, decision: null, classification: 'Blocked', has_active_allocation: true },
    { order_id: 'ord-so85', order_item_id: 'd2', order_number: 'SO26000085', status: 'submitted', customer: 'Distributor ABC', warehouse: 'WH Balakong', variant_id: 'var-corn', variant: 'Corn', quantity: 1000, decision: null, classification: 'Blocked', has_active_allocation: true },
    { order_id: 'ord-so01', order_item_id: 'd9', order_number: 'SO25000001', status: 'closed', customer: 'Distributor XYZ', warehouse: 'WH Balakong', variant_id: 'var-grape', variant: 'Grapefruit', quantity: 3, decision: null, classification: 'History Only' },
  ],
  manufacturer_incoming: [
    { order_item_id: 'm1', order_number: 'ORD26000023', status: 'approved', manufacturer: 'Shenzhen', variant_id: 'var-krill', variant: 'Krill', ordered_quantity: 100, received_quantity: 40, remaining_incoming_quantity: 60, stock_config_id: 'cfg', stock_configuration: '20ml New Box', decision: null },
  ],
  warehouse_activity: [],
  stock_count_drafts: [],
  blockers: [],
  review_items: [],
  ...overrides,
})

const h2mLine = (overrides: Record<string, unknown> = {}) => ({
  order_item_id: 'm1',
  order_id: 'hm-order',
  order_number: 'ORD26000023',
  status: 'approved',
  manufacturer: 'Shenzhen',
  variant_id: 'var-krill',
  variant: 'Krill',
  ordered_quantity: 100,
  received_quantity: 40,
  remaining_incoming_quantity: 60,
  stock_config_id: null,
  stock_configuration: null,
  decision: null,
  ...overrides,
})

let currentReport: any = buildReport()

const buildQuery = (result: unknown) => {
  const query: any = {}
  for (const method of ['select', 'eq', 'order']) query[method] = vi.fn(() => query)
  query.maybeSingle = () => Promise.resolve(result)
  query.then = (resolve: (value: unknown) => void) => resolve(result)
  return query
}

const rpcSpy = vi.fn()
const sessionUpdateSpy = vi.fn()
let decisionRpcError: { message: string } | null = null
let cancelRpcError: { message: string } | null = null
const cancelCalls = () => rpcSpy.mock.calls.filter(([name]) => name === 'cancel_inventory_opening_cutoff').length
let currentCutoffRow: Record<string, unknown> = {
  id: 'cutoff-1',
  status: 'counting',
  stock_count_session_id: 'sess-1',
  warehouse_organization_id: 'wh-1',
  proposed_cutoff_at: '2026-07-31T09:32:00Z',
}
let currentSessionNotes = ''
let currentSessionItems: Array<{ adjustment_quantity: number }> = [
  { adjustment_quantity: 0 },
]

const buildSessionQuery = () => {
  const query: any = {}
  for (const method of ['select', 'eq', 'order']) query[method] = vi.fn(() => query)
  query.maybeSingle = () => Promise.resolve({ data: { notes: currentSessionNotes }, error: null })
  query.update = (payload: unknown) => {
    sessionUpdateSpy(payload)
    if (payload && typeof payload === 'object' && 'notes' in (payload as any)) {
      currentSessionNotes = String((payload as any).notes || '')
    }
    const chain: any = {}
    for (const method of ['eq']) chain[method] = vi.fn(() => chain)
    chain.then = (resolve: (value: unknown) => void) => resolve({ data: null, error: null })
    return chain
  }
  query.then = (resolve: (value: unknown) => void) => resolve({ data: { notes: currentSessionNotes }, error: null })
  return query
}

const buildItemsQuery = () => {
  const query: any = {}
  for (const method of ['select', 'eq', 'order']) query[method] = vi.fn(() => query)
  query.then = (resolve: (value: unknown) => void) => resolve({ data: currentSessionItems, error: null })
  return query
}

// A STABLE client object (the real hook returns a singleton). Returning a fresh
// object per render would change `supabase` identity, re-firing the preview
// effect and clearing the report — a test artifact, not app behaviour.
const stableSupabase = {
  from: (table: string) => {
    if (table === 'inventory_opening_cutoffs') return buildQuery({ data: currentCutoffRow, error: null })
    if (table === 'stock_count_sessions') return buildSessionQuery()
    if (table === 'stock_count_session_items') return buildItemsQuery()
    return buildQuery({ data: [], error: null })
  },
  rpc: (name: string, args: unknown) => {
    rpcSpy(name, args)
    if (name === 'inventory_cutoff_preview') return Promise.resolve({ data: currentReport, error: null })
    if (name === 'set_inventory_cutoff_decision' && decisionRpcError) {
      return Promise.resolve({ data: null, error: decisionRpcError })
    }
    if (name === 'cancel_inventory_opening_cutoff') {
      if (cancelRpcError) return Promise.resolve({ data: null, error: cancelRpcError })
      // Mirror the server: the cutoff transitions to cancelled so the next load
      // renders the read-only cancelled view.
      currentCutoffRow = { ...currentCutoffRow, status: 'cancelled' }
      return Promise.resolve({ data: null, error: null })
    }
    return Promise.resolve({ data: null, error: null })
  },
}

vi.mock('@/lib/hooks/useSupabaseAuth', () => ({
  useSupabaseAuth: () => ({ isReady: true, supabase: stableSupabase }),
}))

// Stable toast (real hook memoizes it). A fresh `toast` per render would change
// the `load` callback identity and re-fire the load effect in a loop.
const stableToast = { toast: vi.fn() }
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => stableToast }))

// The component navigates to the stock-configuration workspace via next router.
const routerPush = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush }) }))

// Read-only Carry Forward preflight response, mutable per test. Default: both
// submitted variants of SO26000085 lack a valid 20ml New Box target config.
let preflightEligibility: Record<string, unknown> = {}
const preflightCalls = () =>
  (global.fetch as any).mock.calls.filter(([url]: [string]) => String(url).includes('carry-forward-preflight')).length
const resetPreflight = (available: boolean) => {
  preflightEligibility = {
    d1: { orderItemId: 'd1', variantId: 'var-potato', carryForwardAvailable: available, configId: available ? 'cfg-p' : null, reasonCode: available ? 'eligible' : 'inventory_cutoff_configuration_not_in_session_scope', variantName: 'Potato', variantCode: 'POT-20', productCode: 'PC-POT' },
    d2: { orderItemId: 'd2', variantId: 'var-corn', carryForwardAvailable: true, configId: 'cfg-c', reasonCode: 'eligible', variantName: 'Corn', variantCode: 'CRN-20', productCode: 'PC-CRN' },
  }
}
let h2mPreflightEligibility: Record<string, unknown> = {}
const h2mPreflightCalls = () =>
  (global.fetch as any).mock.calls.filter(([url]: [string]) => String(url).includes('h2m-incoming-preflight')).length
const resetH2mPreflight = (available: boolean, reasonCode = 'inventory_cutoff_configuration_missing') => {
  h2mPreflightEligibility = {
    m1: {
      orderItemId: 'm1',
      variantId: 'var-krill',
      incomingAvailable: available,
      configId: available ? 'cfg' : null,
      configLabel: available ? '20ml New Box' : null,
      reasonCode: available ? 'eligible' : reasonCode,
      variantName: 'Krill',
      variantCode: 'KRL',
    },
  }
}

const hqProfile = { organizations: { org_type_code: 'HQ' }, roles: { role_level: 10 } }

const DEFAULT_DRAFT_REFERENCE = '5th Initial'

const renderSection = (props: Record<string, unknown> = {}) =>
  render(
    <InventoryOpeningCutoffSection
      userProfile={hqProfile}
      sessionId="sess-1"
      warehouseOrganizationId="wh-1"
      warehouseName="Serapod Warehouse Balakong"
      draftReference={DEFAULT_DRAFT_REFERENCE}
      productCategoryId="cat-1"
      productCategoryName="Vape"
      countsReady
      savedDraftSignature="sig-1"
      openingBalancePosted={false}
      {...props}
    />,
  )

describe('Opening Balance guided wizard', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    currentCutoffRow = {
      id: 'cutoff-1',
      status: 'counting',
      stock_count_session_id: 'sess-1',
      warehouse_organization_id: 'wh-1',
      proposed_cutoff_at: '2026-07-31T09:32:00Z',
    }
    currentSessionNotes = ''
    currentSessionItems = [{ adjustment_quantity: 0 }]
    sessionUpdateSpy.mockClear()
    // Default: Carry Forward is available for all variants (no config issue), so
    // tests unrelated to the preflight see the prior, unblocked behaviour.
    resetPreflight(true)
    resetH2mPreflight(true)
    global.fetch = vi.fn(async (url: any) => {
      if (String(url).includes('carry-forward-preflight')) {
        return { ok: true, json: async () => ({ eligibility: preflightEligibility }) } as any
      }
      if (String(url).includes('h2m-incoming-preflight')) {
        return { ok: true, json: async () => ({ eligibility: h2mPreflightEligibility }) } as any
      }
      return { ok: true, json: async () => ({}) } as any
    }) as any
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    currentReport = buildReport()
    decisionRpcError = null
    cancelRpcError = null
    currentSessionNotes = ''
    currentSessionItems = [{ adjustment_quantity: 0 }]
    currentCutoffRow = {
      id: 'cutoff-1',
      status: 'counting',
      stock_count_session_id: 'sess-1',
      warehouse_organization_id: 'wh-1',
      proposed_cutoff_at: '2026-07-31T09:32:00Z',
    }
  })

  // Step chips live inside the progress <nav>; the label text is a nested span.
  const gotoStep = async (label: string) => {
    const nav = await screen.findByRole('navigation', { name: /Opening Balance steps/i })
    fireEvent.click(within(nav).getByText(label))
  }

  it('renders the five-step progress indicator', async () => {
    renderSection()
    const nav = await screen.findByRole('navigation', { name: /Opening Balance steps/i })
    for (const label of ['Freeze', 'D2H', 'H2M', 'Transactions', 'Review & Post']) {
      expect(within(nav).getByText(label)).toBeTruthy()
    }
  })

  it('keeps the current step after a parent-driven rerender', async () => {
    const { rerender } = renderSection()
    // Navigate to the D2H step.
    await gotoStep('D2H')
    expect(await screen.findByText('Resolve Distributor (D2H) Orders')).toBeTruthy()
    // A parent rerender (unrelated prop change) must not reset the wizard step.
    rerender(
      <InventoryOpeningCutoffSection
        userProfile={hqProfile}
        sessionId="sess-1"
        warehouseOrganizationId="wh-1"
        warehouseName="Serapod Warehouse Balakong"
        draftReference="OB-20260731"
        productCategoryId="cat-1"
        productCategoryName="Vape"
        countsReady
        savedDraftSignature="sig-1"
        openingBalancePosted={false}
        onPosted={() => {}}
      />,
    )
    expect(screen.getByText('Resolve Distributor (D2H) Orders')).toBeTruthy()
  })

  it('groups D2H lines by order and hides historical orders by default', async () => {
    renderSection()
    await gotoStep('D2H')
    fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
    // The actionable order card is shown once (grouped), not once per line.
    expect(await screen.findByText('SO26000085')).toBeTruthy()
    // History is collapsed: the closed order number is not visible yet.
    expect(screen.queryByText('SO25000001')).toBeNull()
    // The collapsed section advertises its count.
    expect(screen.getByText(/Already historical \/ non-submitted \(1\)/)).toBeTruthy()
  })

  it('expands one order to reveal only its own lines', async () => {
    renderSection()
    await gotoStep('D2H')
    fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
    await screen.findByText('SO26000085')
    // Line variants are hidden until the order is expanded.
    expect(screen.queryByText('Potato')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: /View items/ })[0])
    expect(await screen.findByText('Potato')).toBeTruthy()
    expect(screen.getByText('Corn')).toBeTruthy()
    // The historical order's variant is still not rendered.
    expect(screen.queryByText('Grapefruit')).toBeNull()
  })

  describe('D2H and H2M two-policy UI', () => {
    const excludeAllD2h = () => buildReport({
      d2h_policy: {
        policy: 'exclude_all',
        boundary_at: '2026-07-31T09:32:00Z',
        eligible_order_count: 1,
        eligible_item_count: 2,
        eligible_quantity: 1500,
        selected_order_count: 0,
        selected_item_count: 0,
        selected_quantity: 0,
        excluded_order_count: 1,
        excluded_item_count: 2,
        excluded_quantity: 1500,
        eligible_order_ids: ['ord-so85'],
        selected_order_ids: [],
        excluded_order_ids: ['ord-so85'],
      },
      d2h_historical_summary: {
        order_count: 1,
        item_count: 2,
        ordered_quantity: 1500,
        notice: '1 historical D2H orders will be excluded from the new inventory baseline. Order history and reporting remain unchanged.',
      },
      distributor_orders: [
        { order_id: 'ord-so85', order_item_id: 'd1', order_number: 'SO26000085', status: 'submitted', customer: 'ABC', warehouse: 'WH', variant_id: 'var-potato', variant: 'Potato', quantity: 500, decision: 'do_not_carry_forward', classification: 'Historical Excluded', has_active_allocation: true },
        { order_id: 'ord-so85', order_item_id: 'd2', order_number: 'SO26000085', status: 'submitted', customer: 'ABC', warehouse: 'WH', variant_id: 'var-corn', variant: 'Corn', quantity: 1000, decision: 'do_not_carry_forward', classification: 'Historical Excluded', has_active_allocation: true },
      ],
    })

    const reviewD2h = () => buildReport({
      d2h_policy: {
        policy: 'review_select',
        boundary_at: '2026-07-31T09:32:00Z',
        eligible_order_count: 1,
        eligible_item_count: 2,
        eligible_quantity: 1500,
        selected_order_count: 1,
        selected_item_count: 2,
        selected_quantity: 1500,
        excluded_order_count: 0,
        excluded_item_count: 0,
        excluded_quantity: 0,
        eligible_order_ids: ['ord-so85'],
        selected_order_ids: ['ord-so85'],
        excluded_order_ids: [],
      },
      distributor_orders: [
        { order_id: 'ord-so85', order_item_id: 'd1', order_number: 'SO26000085', status: 'submitted', customer: 'ABC', warehouse: 'WH', variant_id: 'var-potato', variant: 'Potato', quantity: 500, decision: 'carry_forward', classification: 'Carry Forward', has_active_allocation: true },
        { order_id: 'ord-so85', order_item_id: 'd2', order_number: 'SO26000085', status: 'submitted', customer: 'ABC', warehouse: 'WH', variant_id: 'var-corn', variant: 'Corn', quantity: 1000, decision: 'carry_forward', classification: 'Carry Forward', has_active_allocation: true },
      ],
    })

    const excludeAllH2m = () => buildReport({
      h2m_policy: {
        policy: 'exclude_all',
        boundary_at: '2026-07-31T09:32:00Z',
        eligible_order_count: 1,
        eligible_item_count: 1,
        eligible_quantity: 4200,
        eligible_ordered_quantity: 5200,
        eligible_received_before_boundary: 1000,
        eligible_outstanding_quantity: 4200,
        selected_order_count: 0,
        selected_item_count: 0,
        selected_quantity: 0,
        excluded_order_count: 1,
        excluded_item_count: 1,
        excluded_quantity: 4200,
        eligible_order_ids: ['ord-h2m'],
        selected_order_ids: [],
        excluded_order_ids: ['ord-h2m'],
      },
      h2m_historical_summary: {
        order_count: 1,
        item_count: 1,
        ordered_quantity: 5200,
        received_before_boundary: 1000,
        outstanding_quantity: 4200,
        notice: '1 historical H2M orders will be excluded from expected incoming.',
      },
      manufacturer_incoming: [
        h2mLine({ decision: 'history_only', remaining_incoming_quantity: 4200, ordered_quantity: 5200, received_quantity: 1000 }),
      ],
    })

    it('shows the D2H policy selection card and does not expose Cancel & Release', async () => {
      renderSection()
      await gotoStep('D2H')
      expect(await screen.findByText('How should existing distributor orders be treated?')).toBeTruthy()
      expect(screen.getAllByText(/Start Fresh — Exclude All Existing D2H Orders/).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/Review Orders to Carry Into New Inventory/).length).toBeGreaterThan(0)
      expect(screen.queryByRole('button', { name: /^Cancel & Release$/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Do Not Carry Forward$/ })).toBeNull()
    })

    it('1. Option A hides all interactive D2H order controls and stale carry status', async () => {
      currentReport = excludeAllD2h()
      renderSection()
      await gotoStep('D2H')
      await screen.findByText('Start Fresh policy saved')
      expect(screen.queryByRole('button', { name: /^Select All Eligible$/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Save D2H Decision$/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Carry Into New Inventory$/ })).toBeNull()
      expect(screen.queryByRole('checkbox', { name: /Select SO26000085/ })).toBeNull()
      expect(screen.queryByText('Carry Into New Inventory')).toBeNull()
      expect(screen.queryByText(/To review specific orders, choose/)).toBeNull()
    })

    it('4–6. Option B reveals selectable list with checkbox-only decisions', async () => {
      renderSection()
      await gotoStep('D2H')
      expect(screen.queryByText('SO26000085')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
      expect(await screen.findByText('SO26000085')).toBeTruthy()
      expect(screen.getByRole('button', { name: /^Select All Eligible$/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: /^Clear Selection$/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: /^Selected only$/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: /^Save D2H Decision$/ })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^Carry Into New Inventory$/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Keep as Historical$/ })).toBeNull()
      const checkbox = screen.getByRole('checkbox', { name: /Select SO26000085/ })
      expect(checkbox).toBeTruthy()
      fireEvent.click(checkbox)
      expect(await screen.findByText('Selected to carry')).toBeTruthy()
      fireEvent.click(checkbox)
      expect(await screen.findByText('Keep as Historical')).toBeTruthy()
    })

    it('7. Switching B draft to A cannot leave carry controls active', async () => {
      currentReport = reviewD2h()
      renderSection()
      await gotoStep('D2H')
      fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
      await screen.findByText('SO26000085')
      // Choosing Start Fresh clears review draft controls pending confirmation.
      fireEvent.click(screen.getByRole('button', { name: /Start Fresh — Exclude All Existing D2H Orders/ }))
      // Confirmation may open; either way interactive review list is no longer the active Option A surface once draft cleared.
      expect(screen.queryByRole('button', { name: /^Carry Into New Inventory$/ })).toBeNull()
    })

    it('8. Refresh reproduces the authoritative saved D2H policy', async () => {
      currentReport = excludeAllD2h()
      const first = renderSection()
      await gotoStep('D2H')
      await screen.findByText('Start Fresh policy saved')
      first.unmount()
      renderSection()
      await gotoStep('D2H')
      await screen.findByText('Start Fresh policy saved')
      expect(screen.queryByRole('checkbox', { name: /Select SO26000085/ })).toBeNull()
    })

    it('shows H2M policy options and hides legacy bulk/order decision buttons under Option A', async () => {
      currentReport = excludeAllH2m()
      renderSection()
      await gotoStep('H2M')
      expect(await screen.findByText('How should existing manufacturer orders be treated?')).toBeTruthy()
      expect(screen.getAllByText(/Start Fresh — Exclude All Existing H2M Orders/).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/Review Orders Expected After Cut-off/).length).toBeGreaterThan(0)
      await screen.findByText('Start Fresh H2M policy saved')
      expect(screen.queryByRole('button', { name: /Mark Selected as Incoming/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /Mark All Remaining as Not Incoming/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Mark Incoming After Cut-off$/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Incoming After Cut-off$/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Not Incoming$/ })).toBeNull()
    })

    it('Option B H2M reveals checkbox-only selection and Save H2M Decision', async () => {
      currentReport = buildReport({ manufacturer_incoming: [h2mLine()] })
      renderSection()
      await gotoStep('H2M')
      fireEvent.click(screen.getByRole('button', { name: /Review Orders Expected After Cut-off/ }))
      expect(await screen.findByText('ORD26000023')).toBeTruthy()
      expect(screen.getByRole('button', { name: /^Select All Eligible$/ })).toBeTruthy()
      expect(screen.getByRole('button', { name: /^Save H2M Decision$/ })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /Mark Selected as Incoming/ })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Mark Incoming After Cut-off$/ })).toBeNull()
      const checkbox = screen.getByRole('checkbox', { name: /Select actionable order ORD26000023/ })
      fireEvent.click(checkbox)
      expect(await screen.findByText('Expected Incoming After Cut-off')).toBeTruthy()
    })
  })

  it('unifies readiness: shows a Final Verification section, blocker details and no Request OTP while not Ready', async () => {
    renderSection()
    await gotoStep('Review & Post')
    // The single clear primary posting section.
    expect(await screen.findByText('Final Verification & Posting')).toBeTruthy()
    // Authoritative status is not "Ready to Post"; blockers are listed.
    expect(screen.getByText(/resolve the .* blocker\(s\) below/i)).toBeTruthy()
    expect(screen.queryByText('Ready to Post')).toBeNull()
    // A D2H policy blocker with a direct resolution route.
    expect(screen.getByText('D2H Policy Not Saved')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Go to D2H Policy' }).length).toBeGreaterThan(0)
    // The normal primary action (Request OTP) never appears while blocked.
    expect(screen.queryByRole('button', { name: /^Request OTP$/ })).toBeNull()
  })

  it('never shows both "All resolved" and a positive blocker count on Review & Post', async () => {
    // The reported contract-mismatch bug: readiness Blocked, no client-derived
    // step remaining, but a server blocker present.
    currentReport = buildReport({
      readiness: 'Blocked',
      distributor_orders: [],
      manufacturer_incoming: [],
      d2h_policy: null,
      blockers: ['Return RET26-000007 requires individual resolution.'],
    })
    renderSection()
    await gotoStep('Review & Post')
    await screen.findByText('Final Verification & Posting')
    // Never "All resolved" while a blocker exists.
    expect(screen.queryByText('All resolved')).toBeNull()
    expect(screen.queryByText('Ready to Post')).toBeNull()
    // The genuine server blocker is surfaced with a contextual Transactions route
    // (no longer the generic "Go to Transactions" that landed on an empty page).
    expect(screen.getByText('Requires Individual Resolution')).toBeTruthy()
    expect(screen.getByText(/Return RET26-000007 requires individual resolution/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Resolve Transaction Blocker' }).length).toBeGreaterThan(0)
  })

  // ------------------------------------------------------------------------
  // Issue 4 — allocation-ownership blocker recognition & guided resolution.
  // The blocker lives only in top-level report.blockers[]; it is NOT a scoped
  // transaction row, so the old contract left Step 4 reading "All resolved" (0)
  // while Step 5 reported one blocker. The two steps must now agree.
  // ------------------------------------------------------------------------
  const POTATO_BLOCKER =
    'Allocation ownership does not reconcile for Zero Edition Novella [ Potato ] (Unclassified (pending stock take)): inventory allocated 1, selected order quantity 0.'

  const allocationReport = () => buildReport({
    readiness: 'Blocked',
    distributor_orders: [],
    manufacturer_incoming: [],
    d2h_policy: null,
    warehouse_activity: [],
    blockers: [POTATO_BLOCKER],
    transactions_historical_summary: { eligible_count: 0, carried_count: 0, excluded_count: 0, blocked_count: 0, inventory_impact: 0 },
  })

  // The authoritative live shape: a STRUCTURED orphan blocker with the exact
  // variant + configuration + cut-off identity (no source order — it is cancelled).
  const structuredBlockerDetail = () => ({
    id: 'allocation_reconciliation:var-potato:cfg-unc',
    code: 'allocation_reconciliation',
    category: 'allocation_reconciliation',
    step: 'transactions',
    orphan: true,
    reason: POTATO_BLOCKER,
    cutoff_id: 'cutoff-1',
    difference: 1,
    variant_name: 'Zero Edition Novella [ Potato ]',
    config_label: 'Unclassified (pending stock take)',
    source_order_id: null,
    source_order_number: null,
    stock_config_id: 'cfg-unc',
    allocation_status: 'allocated',
    selected_quantity: 0,
    allocated_quantity: 1,
    product_variant_id: 'var-potato',
    before_cutoff: true,
    warehouse_organization_id: 'wh-1',
  })

  const allocationReportStructured = () => buildReport({
    readiness: 'Blocked',
    distributor_orders: [],
    manufacturer_incoming: [],
    d2h_policy: null,
    warehouse_activity: [],
    blockers: [POTATO_BLOCKER],
    blocker_details: [structuredBlockerDetail()],
    transactions_historical_summary: { eligible_count: 0, carried_count: 0, excluded_count: 0, blocked_count: 0, inventory_impact: 0 },
  })

  // Server 'Review Required': ZERO blockers, only non-blocking advisories (e.g. an
  // in-transit transfer note) plus 51 historical-excluded transactions. This must
  // NOT block Continue — it mirrors the live post-release state of the 5th Initial.
  const reviewRequiredReport = (overrides: Record<string, unknown> = {}) => buildReport({
    readiness: 'Review Required',
    distributor_orders: [],
    manufacturer_incoming: [],
    d2h_policy: null,
    h2m_policy: null,
    warehouse_activity: [],
    blockers: [],
    blocker_details: [],
    review_items: ['A warehouse transfer is in transit. It remains Stock in Transit and is not included in physical opening stock.'],
    transactions_policy: { policy: 'exclude_all', boundary_at: '2026-08-01T01:01:00Z' },
    transactions_historical_summary: { eligible_count: 51, carried_count: 0, excluded_count: 51, blocked_count: 0, inventory_impact: 0 },
    ...overrides,
  })

  it('Step 5 offers a contextual, identity-bearing route for the allocation blocker', async () => {
    currentReport = allocationReport()
    renderSection()
    await gotoStep('Review & Post')
    await screen.findByText('Final Verification & Posting')
    expect(screen.queryByText('Ready to Post')).toBeNull()
    // Contextual action label, not the generic "Go to Transactions".
    expect(screen.getAllByRole('button', { name: 'Review Potato Allocation' }).length).toBeGreaterThan(0)
    expect(screen.getByText('Allocation Reconciliation')).toBeTruthy()
  })

  it('guides to Step 4 and highlights the Potato allocation with a Requires Resolution badge', async () => {
    currentReport = allocationReport()
    renderSection()
    await gotoStep('Review & Post')
    fireEvent.click(await screen.findByRole('button', { name: 'Review Potato Allocation' }))

    // The guided-resolution card is rendered under Individual Resolution.
    const card = await screen.findByTestId('allocation-blocker-card')
    expect(within(card).getByText('Requires Resolution')).toBeTruthy()
    // Reconciliation arithmetic: allocated 1, selected 0, difference 1.
    expect(within(card).getByText('Inventory allocated')).toBeTruthy()
    expect(within(card).getByText('Difference')).toBeTruthy()
    // The exact authoritative reason is shown, identical to Review & Post.
    expect(within(card).getByText(/Allocation ownership does not reconcile/)).toBeTruthy()
    // The "you were brought here" banner appears.
    expect(screen.getByText(/You were brought here to resolve the blocker/i)).toBeTruthy()
  })

  it('Step 4 and Step 5 report the same blocker count — never "All resolved" while blocked', async () => {
    currentReport = allocationReport()
    renderSection()
    await gotoStep('Transactions')
    // Requires Individual Resolution count reflects the orphan allocation (1).
    expect(await screen.findByText('Items Requiring Individual Resolution (1)')).toBeTruthy()
    // The Step 4 header badge is not "All resolved" while the blocker exists.
    const header = screen.getByText('Review Existing Transactions').closest('div')?.parentElement
    expect(within(header as HTMLElement).queryByText('All resolved')).toBeNull()
  })

  it('enables exclude_and_release for the (cancelled-owner) orphan residual but keeps select/carry-forward disabled', async () => {
    currentReport = allocationReportStructured()
    renderSection()
    await gotoStep('Transactions')
    const card = await screen.findByTestId('allocation-blocker-card')
    // exclude_and_release is the valid audited cleanup for an orphan → enabled.
    const release = within(card).getByRole('button', { name: /Exclude Transaction & Release Allocation/i })
    expect((release as HTMLButtonElement).disabled).toBe(false)
    // select/carry-forward need a genuine submitted owner → remain disabled.
    const select = within(card).getByRole('button', { name: /Select Correct Related Order/i })
    expect((select as HTMLButtonElement).disabled).toBe(true)
    const carry = within(card).getByRole('button', { name: /Carry Forward Related Transaction/i })
    expect((carry as HTMLButtonElement).disabled).toBe(true)
    // The "no source order" message is explicit (never a silent blank).
    expect(within(card).getByText(/No active source order is linked to this residual allocation/i)).toBeTruthy()
    // Enabling the button must NOT itself call any mutating RPC (only an explicit
    // confirmed click does), and never product_inventory from the client.
    const resolverPosts = (global.fetch as any).mock.calls.filter(([url]: [string]) =>
      String(url).includes('allocation-resolve'))
    expect(resolverPosts.length).toBe(0)
  })

  it('keeps exclude_and_release disabled for a legacy string blocker with no resolvable identity', async () => {
    currentReport = allocationReport()
    renderSection()
    await gotoStep('Transactions')
    const card = await screen.findByTestId('allocation-blocker-card')
    const release = within(card).getByRole('button', { name: /Exclude Transaction & Release Allocation/i })
    expect((release as HTMLButtonElement).disabled).toBe(true)
  })

  it('View Unresolved Order opens a modal listing the blocker with full details (one blocker)', async () => {
    currentReport = allocationReportStructured()
    renderSection()
    await gotoStep('Transactions')
    fireEvent.click(await screen.findByRole('button', { name: /View Unresolved Order/i }))
    // A modal appears listing the unresolved blocker (not a silent no-op).
    const rows = await screen.findAllByTestId('unresolved-blocker-row')
    expect(rows.length).toBe(1)
    expect(within(rows[0]).getByText(/Allocation ownership does not reconcile/i)).toBeTruthy()
    expect(within(rows[0]).getByText(/No active source order is linked/i)).toBeTruthy()
  })

  it('View Unresolved Order lists every blocker when multiple are present', async () => {
    const second = {
      ...structuredBlockerDetail(),
      id: 'allocation_reconciliation:var-corn:cfg-unc',
      reason: 'Allocation ownership does not reconcile for Zero Edition Novella [ Corn ] (Unclassified (pending stock take)): inventory allocated 2, selected order quantity 0.',
      variant_name: 'Zero Edition Novella [ Corn ]',
      product_variant_id: 'var-corn',
      allocated_quantity: 2,
      difference: 2,
    }
    currentReport = buildReport({
      readiness: 'Blocked',
      distributor_orders: [], manufacturer_incoming: [], d2h_policy: null, warehouse_activity: [],
      blockers: [POTATO_BLOCKER, second.reason],
      blocker_details: [structuredBlockerDetail(), second],
      transactions_historical_summary: { eligible_count: 0, carried_count: 0, excluded_count: 0, blocked_count: 0, inventory_impact: 0 },
    })
    renderSection()
    await gotoStep('Transactions')
    fireEvent.click(await screen.findByRole('button', { name: /View Unresolved Order/i }))
    const rows = await screen.findAllByTestId('unresolved-blocker-row')
    expect(rows.length).toBe(2)
  })

  it('exclude_and_release posts the resolver payload (integer expected_*) and refreshes on success', async () => {
    currentReport = allocationReportStructured()
    // Resolver bridge succeeds; preview reloads to a Ready (cleared) state.
    global.fetch = vi.fn(async (url: any, init?: any) => {
      if (String(url).includes('allocation-resolve')) {
        return { ok: true, json: async () => ({ result: { blocker_cleared: true } }) } as any
      }
      if (String(url).includes('carry-forward-preflight')) return { ok: true, json: async () => ({ eligibility: preflightEligibility }) } as any
      if (String(url).includes('h2m-incoming-preflight')) return { ok: true, json: async () => ({ eligibility: h2mPreflightEligibility }) } as any
      return { ok: true, json: async () => ({}) } as any
    }) as any
    renderSection()
    await gotoStep('Transactions')
    const card = await screen.findByTestId('allocation-blocker-card')
    fireEvent.click(within(card).getByRole('button', { name: /Exclude Transaction & Release Allocation/i }))
    // Confirmation dialog requires an explicit reason.
    const reason = await screen.findByLabelText(/Reason/i)
    fireEvent.change(reason, { target: { value: 'Residual from cancelled SO26000085' } })
    fireEvent.click(screen.getByRole('button', { name: /Release allocation/i }))
    await waitFor(() => {
      const post = (global.fetch as any).mock.calls.find(([url]: [string]) => String(url).includes('allocation-resolve'))
      expect(post).toBeTruthy()
      const body = JSON.parse(post[1].body)
      expect(body.action).toBe('exclude_and_release')
      expect(body.productVariantId).toBe('var-potato')
      expect(body.stockConfigId).toBe('cfg-unc')
      expect(body.cutoffId).toBe('cutoff-1')
      expect(body.reason).toBe('Residual from cancelled SO26000085')
      // Integer expected_* — never a float / wrong numeric signature.
      expect(Number.isInteger(body.expectedAllocated)).toBe(true)
      expect(Number.isInteger(body.expectedSelected)).toBe(true)
      expect(body.expectedAllocated).toBe(1)
      expect(body.expectedSelected).toBe(0)
      expect(typeof body.idempotencyKey).toBe('string')
    })
  })

  it('shows the backend refusal visibly (active owner) instead of failing silently', async () => {
    currentReport = allocationReportStructured()
    global.fetch = vi.fn(async (url: any) => {
      if (String(url).includes('allocation-resolve')) {
        return { ok: false, status: 409, json: async () => ({ error: 'inventory_cutoff_allocation_active_owner: order SO26000085 (submitted) still owns this allocation' }) } as any
      }
      if (String(url).includes('carry-forward-preflight')) return { ok: true, json: async () => ({ eligibility: preflightEligibility }) } as any
      if (String(url).includes('h2m-incoming-preflight')) return { ok: true, json: async () => ({ eligibility: h2mPreflightEligibility }) } as any
      return { ok: true, json: async () => ({}) } as any
    }) as any
    renderSection()
    await gotoStep('Transactions')
    const card = await screen.findByTestId('allocation-blocker-card')
    fireEvent.click(within(card).getByRole('button', { name: /Exclude Transaction & Release Allocation/i }))
    fireEvent.change(await screen.findByLabelText(/Reason/i), { target: { value: 'test' } })
    fireEvent.click(screen.getByRole('button', { name: /Release allocation/i }))
    await waitFor(() => {
      const refusal = stableToast.toast.mock.calls.find(([arg]) =>
        /submitted order still owns/i.test(String(arg?.description)))
      expect(refusal).toBeTruthy()
    })
  })

  it('Review Required (advisories only, e.g. 51 excluded) lets Continue advance to Review & Post', async () => {
    currentReport = reviewRequiredReport()
    renderSection()
    await gotoStep('Transactions')
    // The single authoritative gate is clear → Continue enabled, footer not blocking.
    const cont = await screen.findByRole('button', { name: /Continue to Review/i })
    expect((cont as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(/Resolve .* transaction blocker/i)).toBeNull()
    fireEvent.click(cont)
    // Advances to Review & Post; never "Resolve blockers first".
    expect(await screen.findByText('Final Verification & Posting')).toBeTruthy()
    const refused = stableToast.toast.mock.calls.find(([a]) => /Resolve blockers first/i.test(String(a?.title)))
    expect(refused).toBeFalsy()
  })

  it('a genuine transaction blocker keeps Continue disabled and does not advance', async () => {
    currentReport = allocationReportStructured()
    renderSection()
    await gotoStep('Transactions')
    const cont = await screen.findByRole('button', { name: /Continue to Review/i })
    expect((cont as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('Final Verification & Posting')).toBeNull()
  })

  it('after resolution the refetched preview flips blocker 1 → 0 so summary AND Continue change together', async () => {
    currentReport = allocationReportStructured() // Blocked: 1 orphan allocation
    renderSection()
    await gotoStep('Transactions')
    expect(await screen.findByText('Items Requiring Individual Resolution (1)')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Continue to Review/i }) as HTMLButtonElement).disabled).toBe(true)
    // The server now reports the residual resolved → Review Required, zero blockers.
    currentReport = reviewRequiredReport()
    fireEvent.click(screen.getByRole('button', { name: /Refresh transactions/i }))
    // ONE refetch rebuilds all derived state: the blocker card clears AND the gate opens.
    await waitFor(() => expect(screen.queryByText('Items Requiring Individual Resolution (1)')).toBeNull())
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Continue to Review/i }) as HTMLButtonElement).disabled).toBe(false),
    )
    // Continue now succeeds immediately (no stale onClick closure).
    fireEvent.click(screen.getByRole('button', { name: /Continue to Review/i }))
    expect(await screen.findByText('Final Verification & Posting')).toBeTruthy()
  })

  it('Review Required reaches Review & Post: lists advisories and enables Request OTP (posting allowed)', async () => {
    currentReport = reviewRequiredReport()
    renderSection()
    await gotoStep('Review & Post')
    expect(await screen.findByText('Final Verification & Posting')).toBeTruthy()
    // Zero blockers + advisory readiness — do not falsely claim exact "Ready".
    expect(screen.getByText('No blockers — OTP may be requested')).toBeTruthy()
    expect(screen.queryByText('Ready to Post')).toBeNull()
    // The advisory is listed explicitly as non-blocking (never a silent disabled button).
    expect(screen.getByText(/Advisories — review before posting/i)).toBeTruthy()
    expect(screen.getByText(/warehouse transfer is in transit/i)).toBeTruthy()
    // Request OTP is enabled — consistent with the relaxed backend contract.
    const otp = screen.getByRole('button', { name: /Request OTP/i })
    expect((otp as HTMLButtonElement).disabled).toBe(false)
  })

  it('Review Required OTP request succeeds with session id; Posting Note survives a prior failure', async () => {
    currentReport = reviewRequiredReport({
      inventory: Array.from({ length: 112 }, (_, i) => ({
        stock_config_id: `c${i + 1}`,
        variant_name: `V${i + 1}`,
        stock_configuration: '20ml New Box',
        system_quantity: 2650,
        physical_quantity: i < 110 ? 2650 : 2475,
        variance: i === 0 ? -10 : 0,
        allocated_quantity: 0,
      })),
    })
    currentSessionItems = [{ adjustment_quantity: -10 }]
    currentSessionNotes = 'Testing for OTP'
    let otpCalls = 0
    const baseFetch = global.fetch as any
    global.fetch = vi.fn(async (url: any, init: any) => {
      if (String(url).includes('verification/request')) {
        otpCalls += 1
        if (otpCalls === 1) {
          return {
            ok: false,
            json: async () => ({
              error: 'This Stock Count does not contain valid counted quantities.',
              code: 'invalid_count_data',
            }),
          } as any
        }
        expect(JSON.parse(init.body)).toEqual({ sessionId: 'sess-1' })
        return {
          ok: true,
          json: async () => ({ requestId: 'req-rr', recipients: ['a@b.com'], expiresAt: '2026-08-02T10:00:00Z' }),
        } as any
      }
      return baseFetch(url, init)
    }) as any

    renderSection()
    await gotoStep('Review & Post')
    const note = await screen.findByLabelText(/Posting Note/i)
    expect((note as HTMLTextAreaElement).value).toBe('Testing for OTP')
    fireEvent.click(screen.getByRole('button', { name: /^Request OTP$/ }))
    expect(await screen.findByText('Verification unavailable')).toBeTruthy()
    expect(screen.getByText(/does not contain valid counted quantities/i)).toBeTruthy()
    // Note must not be cleared by the failed request.
    expect((screen.getByLabelText(/Posting Note/i) as HTMLTextAreaElement).value).toBe('Testing for OTP')
    // Retry succeeds (route now allows Review Required); OTP UI appears once.
    fireEvent.click(screen.getByRole('button', { name: /^Request OTP$/ }))
    expect(await screen.findByLabelText('Opening Balance OTP code')).toBeTruthy()
    expect(otpCalls).toBe(2)
  })

  it('a genuinely Blocked cut-off shows blockers and offers NO OTP request', async () => {
    currentReport = allocationReportStructured() // readiness 'Blocked', 1 orphan
    renderSection()
    await gotoStep('Review & Post')
    expect(await screen.findByText('Final Verification & Posting')).toBeTruthy()
    expect(screen.getByText(/resolve the 1 blocker/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Request OTP/i })).toBeNull()
  })

  it('returns to the relevant step when a blocker summary card is clicked', async () => {
    renderSection()
    await gotoStep('Review & Post')
    // Click the D2H policy review card → navigates back to D2H step.
    fireEvent.click(await screen.findByText('D2H Policy'))
    expect(await screen.findByText('Resolve Distributor (D2H) Orders')).toBeTruthy()
  })

  // The number of `inventory_cutoff_preview` RPCs recorded so far. Save/advance
  // re-pulls the preview, so this doubles as a "save requests" counter.
  const previewCalls = () => rpcSpy.mock.calls.filter(([name]) => name === 'inventory_cutoff_preview').length

  it('shows exactly one primary Continue action on Step 1, labelled for the next step', async () => {
    renderSection()
    // Wait for the wizard (and its footer) to render.
    await screen.findByText(/Warehouse frozen — count active/)
    const continues = screen.getAllByRole('button', { name: /^Continue to/ })
    expect(continues).toHaveLength(1)
    expect(continues[0].textContent).toContain('Continue to D2H Orders')
    // The removed duplicate call-to-action must be gone.
    expect(screen.queryByRole('button', { name: /Continue to Resolve Orders/ })).toBeNull()
  })

  it('saves the draft before navigating when Continue is clicked', async () => {
    renderSection()
    await screen.findByText(/Warehouse frozen — count active/)
    const before = previewCalls()
    fireEvent.click(screen.getByRole('button', { name: /Continue to D2H Orders/ }))
    // A save (preview re-pull) is issued...
    await waitFor(() => expect(previewCalls()).toBe(before + 1))
    // ...and then the wizard advances to the D2H step.
    expect(await screen.findByText('Resolve Distributor (D2H) Orders')).toBeTruthy()
  })

  it('cannot double-save or double-navigate on rapid Continue clicks', async () => {
    renderSection()
    await screen.findByText(/Warehouse frozen — count active/)
    const before = previewCalls()
    const button = screen.getByRole('button', { name: /Continue to D2H Orders/ })
    // Two clicks in the same tick, before the disabled state can re-render.
    fireEvent.click(button)
    fireEvent.click(button)
    await screen.findByText('Resolve Distributor (D2H) Orders')
    // Exactly one save request was made despite the second click.
    expect(previewCalls()).toBe(before + 1)
    // And the destination is the single next step (D2H), not two hops forward.
    expect(screen.queryByText('Resolve Manufacturer (H2M) Incoming')).toBeNull()
  })

  it('labels the Continue action for the correct destination on every step', async () => {
    renderSection()
    await screen.findByText(/Warehouse frozen — count active/)
    const continueText = () => screen.queryByRole('button', { name: /^Continue to/ })?.textContent ?? null

    expect(continueText()).toContain('Continue to D2H Orders')
    await gotoStep('D2H')
    expect(continueText()).toContain('Continue to H2M Incoming')
    await gotoStep('H2M')
    expect(continueText()).toContain('Continue to Transactions')
    await gotoStep('Transactions')
    expect(continueText()).toContain('Continue to Review & Post')
    // The final step drops the footer navigation action; posting lives in the
    // Final Verification & Posting section instead.
    await gotoStep('Review & Post')
    expect(continueText()).toBeNull()
    expect(await screen.findByText('Final Verification & Posting')).toBeTruthy()
  })

  it('hides Back on Step 1 and shows it on later steps', async () => {
    renderSection()
    await screen.findByText(/Warehouse frozen — count active/)
    expect(screen.queryByRole('button', { name: /^Back$/ })).toBeNull()
    await gotoStep('D2H')
    expect(screen.getByRole('button', { name: /^Back$/ })).toBeTruthy()
  })

  it('enables the post action only when server readiness is Ready', async () => {
    currentReport = buildReport({
      readiness: 'Ready',
      distributor_orders: [
        { order_item_id: 'd1', order_number: 'SO26000085', status: 'submitted', customer: 'ABC', warehouse: 'WH', variant: 'Potato', quantity: 500, decision: 'carry_forward', classification: 'Carry Forward' },
      ],
      manufacturer_incoming: [],
    })
    renderSection()
    await gotoStep('Review & Post')
    expect((await screen.findAllByText('Ready to Post')).length).toBeGreaterThan(0)
    // The normal primary action is a single "Request OTP" button, enabled.
    const post = screen.getByRole('button', { name: /^Request OTP$/ })
    expect(post.hasAttribute('disabled')).toBe(false)
    // "Ready to Post" and a zero blocker count never contradict.
    expect(screen.queryByText(/resolve the .* blocker/i)).toBeNull()
  })

  // ======================================================================
  // D2H Carry Forward configuration preflight
  // ======================================================================

  it('warns on Freeze & Overview when a D2H order has a configuration issue', async () => {
    resetPreflight(false)
    renderSection()
    await screen.findByText(/Warehouse frozen — count active/)
    // The preflight runs on the freeze step; wait for the early warning subtext.
    expect(await screen.findByText(/1 order has a configuration issue/)).toBeTruthy()
    // Entry into the D2H step is never blocked from Step 1.
    const cont = screen.getByRole('button', { name: /Continue to D2H Orders/ })
    expect(cont.hasAttribute('disabled')).toBe(false)
  })

  it('shows the precise authoritative scope reason before Apply', async () => {
    resetPreflight(false)
    renderSection()
    await gotoStep('D2H')
    fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
    expect(await screen.findByText('Blocked — Outside Session Scope')).toBeTruthy()
    // Concise explanation + affected variant + corrective action, not a raw code.
    expect(screen.getByText(/do not have a valid 20 mg New Box stock configuration/)).toBeTruthy()
    expect(screen.getAllByText(/Potato/).length).toBeGreaterThan(0)
    expect(screen.getByText(/not part of this Opening Balance session’s immutable scope/)).toBeTruthy()
    expect(screen.queryByText('inventory_cutoff_20ml_new_box_missing')).toBeNull()
  })

  it('shows Carry Forward blocked banner under Option B without row decision buttons', async () => {
    resetPreflight(false)
    renderSection()
    await gotoStep('D2H')
    fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
    await screen.findByText('Blocked — Outside Session Scope')
    expect(screen.queryByRole('button', { name: /^Carry Into New Inventory$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Keep as Historical$/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Open Stock Configuration/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Refresh & Recheck/ })).toBeTruthy()
  })

  it('does not auto-select a decision for a blocked order', async () => {
    resetPreflight(false)
    renderSection()
    await gotoStep('D2H')
    fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
    await screen.findByText('Blocked — Outside Session Scope')
    fireEvent.click(screen.getAllByRole('button', { name: /View items|Hide items/ })[0])
    // Each submitted line's decision selector still shows the placeholder.
    expect(await screen.findAllByText('Keep as Historical')).toBeTruthy()
    // Line-level decision selects are removed; checkbox is the only control.
  })

  it('blocks Continue to H2M while a D2H policy is not saved', async () => {
    resetPreflight(false)
    renderSection()
    await gotoStep('D2H')
    fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
    await screen.findByText('Blocked — Outside Session Scope')
    expect(screen.getByText('Save a D2H policy (Start Fresh or Review Orders) before continuing.')).toBeTruthy()
    const cont = screen.getByRole('button', { name: /Continue to H2M Incoming/ })
    expect(cont.hasAttribute('disabled')).toBe(true)
  })

  it('Refresh & Recheck re-runs the read-only preflight and never records a decision', async () => {
    resetPreflight(false)
    renderSection()
    await gotoStep('D2H')
    fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
    await screen.findByText('Blocked — Outside Session Scope')
    const before = preflightCalls()
    const rpcBefore = rpcSpy.mock.calls.filter(([n]) => n === 'set_inventory_cutoff_decision').length
    // The config is created externally; the recheck now reports it available.
    resetPreflight(true)
    fireEvent.click(screen.getByRole('button', { name: /Refresh & Recheck/ }))
    await waitFor(() => expect(preflightCalls()).toBe(before + 1))
    // Carry Forward becomes available once the prerequisite passes.
    await waitFor(() => expect(screen.queryByText('Blocked — Outside Session Scope')).toBeNull())
    // The preflight recorded no decision — it is strictly read-only.
    expect(rpcSpy.mock.calls.filter(([n]) => n === 'set_inventory_cutoff_decision').length).toBe(rpcBefore)
  })

  it('cannot duplicate the read-only check on rapid Refresh & Recheck clicks', async () => {
    resetPreflight(false)
    renderSection()
    await gotoStep('D2H')
    fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
    await screen.findByText('Blocked — Outside Session Scope')
    const before = preflightCalls()
    const button = screen.getByRole('button', { name: /Refresh & Recheck/ })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(preflightCalls()).toBe(before + 1))
    // A short settle window proves the guarded second click issued no request.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(preflightCalls()).toBe(before + 1)
  })

  it('Open Stock Configuration navigates to the products workspace with variant context', async () => {
    resetPreflight(false)
    renderSection()
    await gotoStep('D2H')
    fireEvent.click(screen.getByRole('button', { name: /Review Orders to Carry Into New Inventory/ }))
    await screen.findByText('Blocked — Outside Session Scope')
    fireEvent.click(screen.getByRole('button', { name: /Open Stock Configuration/ }))
    expect(routerPush).toHaveBeenCalledTimes(1)
    const target = String(routerPush.mock.calls[0][0])
    expect(target).toContain('/supply-chain/products')
    expect(target).toContain('POT-20')
  })

  it('allows continuing to H2M once the D2H Start Fresh policy is saved', async () => {
    currentReport = buildReport({
      d2h_policy: {
        policy: 'exclude_all',
        boundary_at: '2026-07-31T09:32:00Z',
        eligible_order_count: 1,
        eligible_item_count: 2,
        eligible_quantity: 1500,
        selected_order_count: 0,
        selected_item_count: 0,
        selected_quantity: 0,
        excluded_order_count: 1,
        excluded_item_count: 2,
        excluded_quantity: 1500,
        eligible_order_ids: ['ord-so85'],
        selected_order_ids: [],
        excluded_order_ids: ['ord-so85'],
      },
      d2h_historical_summary: {
        order_count: 1,
        item_count: 2,
        ordered_quantity: 1500,
        notice: '1 historical D2H orders will be excluded from the new inventory baseline. Order history and reporting remain unchanged.',
      },
      distributor_orders: [
        { order_id: 'ord-so85', order_item_id: 'd1', order_number: 'SO26000085', status: 'submitted', customer: 'ABC', warehouse: 'WH Balakong', variant_id: 'var-potato', variant: 'Potato', quantity: 500, decision: 'do_not_carry_forward', classification: 'Do Not Carry Forward' },
        { order_id: 'ord-so85', order_item_id: 'd2', order_number: 'SO26000085', status: 'submitted', customer: 'ABC', warehouse: 'WH Balakong', variant_id: 'var-corn', variant: 'Corn', quantity: 1000, decision: 'do_not_carry_forward', classification: 'Do Not Carry Forward' },
      ],
    })
    renderSection()
    await gotoStep('D2H')
    await screen.findByText('Start Fresh policy saved')
    expect(screen.queryByText('Save a D2H policy (Start Fresh or Review Orders) before continuing.')).toBeNull()
    const cont = screen.getByRole('button', { name: /Continue to H2M Incoming/ })
    expect(cont.hasAttribute('disabled')).toBe(false)
  })

  describe('authoritative H2M Incoming workflow', () => {
    it('waits for the reopened cutoff ID and sends the exact current payload once ready', async () => {
      renderSection()
      await waitFor(() => expect(h2mPreflightCalls()).toBeGreaterThan(0))
      const call = (global.fetch as any).mock.calls.find(
        ([url]: [string]) => String(url).includes('h2m-incoming-preflight'),
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(call[1].body)).toEqual({
        cutoffId: 'cutoff-1',
        orderItemIds: ['m1'],
      })
      expect(call[1].cache).toBe('no-store')
      await gotoStep('H2M')
      expect(h2mPreflightCalls()).toBe(1)
    })

    it('shows a valid empty reopened draft without an unavailable error', async () => {
      currentReport = buildReport({ manufacturer_incoming: [] })
      renderSection()
      await gotoStep('H2M')
      expect(await screen.findByText('How should existing manufacturer orders be treated?')).toBeTruthy()
      expect(screen.queryByText(/H2M Incoming readiness check needs attention/)).toBeNull()
      expect(stableToast.toast).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'H2M Incoming check unavailable' }),
      )
    })

    it('categorizes a missing RPC and recovers through inline Retry under Option B', async () => {
      let attempts = 0
      global.fetch = vi.fn(async (url: any) => {
        if (String(url).includes('carry-forward-preflight')) {
          return { ok: true, json: async () => ({ eligibility: preflightEligibility }) } as any
        }
        if (String(url).includes('h2m-incoming-preflight')) {
          attempts += 1
          if (attempts === 1) {
            return {
              ok: false,
              status: 503,
              json: async () => ({
                category: 'h2m_resolver_unavailable',
                error: 'The H2M readiness database resolver is unavailable. Apply the required H2M resolver migration to this environment, then retry.',
                correlationId: 'request-123',
              }),
            } as any
          }
          return {
            ok: true,
            json: async () => ({ eligibility: h2mPreflightEligibility, correlationId: 'request-456' }),
          } as any
        }
        return { ok: true, json: async () => ({}) } as any
      }) as any

      renderSection()
      await gotoStep('H2M')
      fireEvent.click(screen.getByRole('button', { name: /Review Orders Expected After Cut-off/ }))
      expect(await screen.findByText(/Apply the required H2M resolver migration/)).toBeTruthy()
      expect(screen.getByText('Reference: request-123')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: /Retry H2M Check/ }))
      await waitFor(() => {
        expect(screen.queryByText(/Apply the required H2M resolver migration/)).toBeNull()
      })
      expect(screen.getByRole('button', { name: /^Save H2M Decision$/ })).toBeTruthy()
    })

    it('keeps H2M policy options and never mutates orders while selecting policy', async () => {
      currentReport = buildReport({ manufacturer_incoming: [h2mLine()] })
      renderSection()
      await gotoStep('H2M')
      fireEvent.click(screen.getByRole('button', { name: /Review Orders Expected After Cut-off/ }))
      await screen.findByText('ORD26000023')
      const before = rpcSpy.mock.calls.filter(([name]) => name === 'set_inventory_cutoff_decision').length
      fireEvent.click(screen.getByRole('checkbox', { name: /Select actionable order ORD26000023/ }))
      expect(rpcSpy.mock.calls.filter(([name]) => name === 'set_inventory_cutoff_decision').length).toBe(before)
      expect(screen.queryByRole('button', { name: /Mark Selected as Incoming/ })).toBeNull()
    })
  })

  it('renders the Transactions policy step: three options, typed rows, zero impact, genuine blockers', async () => {
    const adjustmentId = '9b587a24-dd17-44c3-a675-edcba5915993'
    const returnId = '1c2d3e4f-a111-4b22-8c33-445566778899'
    const transferId = 'aa112233-4455-6677-8899-aabbccddeeff'
    currentReport = buildReport({
      readiness: 'Blocked',
      distributor_orders: [],
      manufacturer_incoming: [],
      warehouse_activity: [
        {
          movement_type: 'stock_adjustment',
          reference_no: null,
          reference_id: adjustmentId,
          status: 'pending',
          quantity: 15,
          line_count: 2,
          occurred_at: '2026-07-18T08:58:41.000Z',
          latest_stage: 'Draft / pending adjustment',
          remaining_action: 'Approve or cancel in the Stock Adjustment workflow',
          expected_event: 'Inventory changes only when the adjustment is approved/posted',
          eligibility: 'eligible',
          blocker_reason: null,
          classification: 'Historical Excluded',
          items: [
            { item_id: 'i1', variant_name: 'Mango Ice', stock_configuration: '20ml · New Box', quantity: 10 },
          ],
        },
        {
          movement_type: 'return',
          reference_no: 'RET26-000007',
          reference_id: returnId,
          status: 'return_received',
          quantity: 0,
          line_count: 1,
          occurred_at: '2026-07-13T08:29:49.000Z',
          latest_stage: 'Received at warehouse',
          remaining_action: 'Continue the Return workflow',
          expected_event: 'At the return disposition stage',
          eligibility: 'requires_resolution',
          blocker_reason: 'Return already posted stock movements but is not completed; resolve it in the Return workflow to avoid replay.',
          classification: 'Requires Individual Resolution',
        },
        {
          movement_type: 'stock_transfer',
          reference_no: 'ST25110001',
          reference_id: transferId,
          status: 'pending',
          quantity: 50,
          line_count: 1,
          occurred_at: '2026-07-06T00:18:23.000Z',
          latest_stage: 'Pending',
          remaining_action: 'Continue the transfer workflow to dispatch',
          expected_event: 'Source is deducted only at legitimate dispatch',
          eligibility: 'eligible',
          blocker_reason: null,
          classification: 'Historical Excluded',
        },
      ],
      transactions_historical_summary: {
        eligible_count: 2, carried_count: 0, excluded_count: 2, blocked_count: 1, notice: null,
      },
      blockers: [
        'Return RET26-000007 (return_received) requires individual resolution: Return already posted stock movements but is not completed; resolve it in the Return workflow to avoid replay.',
      ],
    })

    renderSection()
    await gotoStep('Transactions')

    // Heading + all three policy options.
    expect(await screen.findByText('How should eligible existing transactions be treated?')).toBeTruthy()
    expect(screen.getByText('Start Fresh — Exclude All Eligible Transactions')).toBeTruthy()
    expect(screen.getByText('Carry Forward All Eligible Transactions')).toBeTruthy()
    expect(screen.getByText('Review Transactions to Carry Forward')).toBeTruthy()

    // Zero Opening Balance inventory impact is always shown.
    expect(screen.getByText('Inventory impact during Opening Balance')).toBeTruthy()

    // A genuine Requires-Individual-Resolution blocker is surfaced with its reason.
    expect(screen.getAllByText(/Requires Individual Resolution/).length).toBeGreaterThan(0)
    expect(screen.getByText('RET26-000007')).toBeTruthy()

    // No raw UUID is ever shown as a label.
    expect(screen.queryByText(adjustmentId)).toBeNull()
    expect(screen.queryByText('stock_adjustment')).toBeNull()

    // Options 1/2 hide the eligible transaction list/checkboxes.
    expect(screen.queryByText('ST25110001')).toBeNull()

    // Selecting Review reveals the list with the checkbox as the only decision.
    fireEvent.click(screen.getByText('Review Transactions to Carry Forward'))
    expect(await screen.findByText('ST25110001')).toBeTruthy()
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0)
    expect(screen.getByText(/Checked = Carry Forward/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save Transactions Policy' })).toBeTruthy()
  })

  it('shows Cancelled — Read Only and Return to Active Draft when another active draft exists', async () => {
    currentCutoffRow = {
      id: 'cutoff-cancelled',
      status: 'cancelled',
      stock_count_session_id: 'sess-1',
      warehouse_organization_id: 'wh-1',
      proposed_cutoff_at: '2026-07-30T09:00:00Z',
    }
    const onReturnToActiveDraft = vi.fn()
    const onCreateNewOpeningBalance = vi.fn()

    renderSection({
      activeDraft: {
        sessionId: 'sess-active',
        referenceName: 'OB-20260731',
        createdAt: '2026-07-31T09:00:00.000Z',
        progressLabel: '0/112',
      },
      onReturnToActiveDraft,
      onCreateNewOpeningBalance,
    })

    expect(await screen.findByText('Cancelled — Read Only')).toBeTruthy()
    expect(screen.getByText(/Active draft: OB-20260731/)).toBeTruthy()
    expect(screen.getByText(/Progress 0\/112/)).toBeTruthy()
    expect(screen.queryByText(/Create a new Opening Balance draft to retry/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Request OTP' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Post Official Opening Balance/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Activate Count/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Return to Active Draft' }))
    expect(onReturnToActiveDraft).toHaveBeenCalledWith('sess-active')
    expect(onCreateNewOpeningBalance).not.toHaveBeenCalled()
  })

  it('offers Create New Opening Balance when cancelled and no active draft exists', async () => {
    currentCutoffRow = {
      id: 'cutoff-cancelled',
      status: 'cancelled',
      stock_count_session_id: 'sess-1',
      warehouse_organization_id: 'wh-1',
      proposed_cutoff_at: '2026-07-30T09:00:00Z',
    }
    const onCreateNewOpeningBalance = vi.fn()

    renderSection({
      activeDraft: null,
      onCreateNewOpeningBalance,
    })

    expect(await screen.findByText('Cancelled — Read Only')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Create New Opening Balance' }))
    expect(onCreateNewOpeningBalance).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Return to Active Draft' })).toBeNull()
  })

  // =========================================================================
  // Posting Note + OTP flow + protected cancellation (Danger Zone)
  // =========================================================================
  const readyReport = (overrides: Record<string, unknown> = {}) => buildReport({
    readiness: 'Ready',
    distributor_orders: [
      { order_item_id: 'd1', order_number: 'SO26000085', status: 'submitted', customer: 'ABC', warehouse: 'WH', variant: 'Potato', quantity: 500, decision: 'carry_forward', classification: 'Carry Forward' },
    ],
    manufacturer_incoming: [],
    ...overrides,
  })

  const varianceReadyReport = () => readyReport({
    inventory: [
      { stock_config_id: 'c1', variant_name: 'Mango', stock_configuration: '20ml New Box', system_quantity: 100, physical_quantity: 90, variance: -10, allocated_quantity: 0 },
    ],
  })

  const openDangerZone = async () => {
    await gotoStep('Review & Post')
    fireEvent.click(await screen.findByRole('button', { name: /Danger Zone \/ More Actions/i }))
    return screen.findByLabelText('Cancellation Reason')
  }

  const openCancelModal = async (reason = 'abandon this exercise') => {
    await openDangerZone()
    const reasonField = await screen.findByLabelText('Cancellation Reason')
    fireEvent.change(reasonField, { target: { value: reason } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Entire Opening Balance Exercise' }))
    return screen.findByText('Cancel Entire Opening Balance Exercise?')
  }

  const mockOtpRequest = (opts: { ok?: boolean; error?: string; code?: string } = {}) => {
    const baseFetch = global.fetch as any
    global.fetch = vi.fn(async (url: any, init: any) => {
      if (String(url).includes('verification/request')) {
        if (opts.ok === false) {
          return {
            ok: false,
            json: async () => ({ error: opts.error || 'blocked', code: opts.code || 'invalid_count_data' }),
          } as any
        }
        return {
          ok: true,
          json: async () => ({ requestId: 'req-1', recipients: ['a@b.com'], expiresAt: '2026-08-01T10:00:00Z' }),
        } as any
      }
      if (String(url).includes('verification/verify')) {
        return { ok: true, json: async () => ({ status: 'posted' }) } as any
      }
      return baseFetch(url, init)
    }) as any
  }

  it('shows Posting Note before Request OTP and hides cancellation under Danger Zone by default', async () => {
    currentReport = readyReport()
    renderSection()
    await gotoStep('Review & Post')
    expect(await screen.findByText('Final Verification & Posting')).toBeTruthy()
    expect(screen.getByLabelText(/Posting Note/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Request OTP$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Danger Zone \/ More Actions/i })).toBeTruthy()
    expect(screen.queryByLabelText('Cancellation Reason')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel Entire Opening Balance Exercise' })).toBeNull()
    expect(screen.getByRole('button', { name: /^Back$/ })).toBeTruthy()
  })

  it('variance exists → Posting Note is required; empty/whitespace note blocks OTP with inline error', async () => {
    currentSessionItems = [{ adjustment_quantity: -10 }]
    currentReport = varianceReadyReport()
    mockOtpRequest()
    renderSection()
    await gotoStep('Review & Post')
    const note = await screen.findByLabelText(/Posting Note/i)
    expect(note.closest('div')?.textContent || '').toContain('*')
    fireEvent.click(screen.getByRole('button', { name: /^Request OTP$/ }))
    expect((await screen.findAllByText(/Posting Note is required when the Stock Count contains variance/i)).length).toBeGreaterThan(0)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    expect((global.fetch as any).mock.calls.filter(([u]: [string]) => String(u).includes('verification/request')).length).toBe(0)

    fireEvent.change(note, { target: { value: '   \n  ' } })
    fireEvent.click(screen.getByRole('button', { name: /^Request OTP$/ }))
    expect((global.fetch as any).mock.calls.filter(([u]: [string]) => String(u).includes('verification/request')).length).toBe(0)
  })

  it('valid Posting Note persists to the session then calls the exact OTP request payload', async () => {
    currentSessionItems = [{ adjustment_quantity: -10 }]
    currentReport = varianceReadyReport()
    mockOtpRequest()
    renderSection()
    await gotoStep('Review & Post')
    const noteText = 'Opening balance based on verified physical stock count.'
    fireEvent.change(await screen.findByLabelText(/Posting Note/i), { target: { value: `  ${noteText}  ` } })
    fireEvent.click(screen.getByRole('button', { name: /^Request OTP$/ }))
    expect(await screen.findByLabelText('Opening Balance OTP code')).toBeTruthy()
    expect(sessionUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ notes: noteText }))
    const otpCalls = (global.fetch as any).mock.calls.filter(([u]: [string]) => String(u).includes('verification/request'))
    expect(otpCalls.length).toBe(1)
    expect(JSON.parse(otpCalls[0][1].body)).toEqual({ sessionId: 'sess-1' })
  })

  it('Posting Note survives preview refresh and Back/return navigation', async () => {
    currentSessionItems = [{ adjustment_quantity: -10 }]
    currentReport = varianceReadyReport()
    renderSection()
    await gotoStep('Review & Post')
    const typed = 'Keep this note across refresh'
    fireEvent.change(await screen.findByLabelText(/Posting Note/i), { target: { value: typed } })
    // Leave Review via sticky Back, then return via the step progress control.
    fireEvent.click(screen.getByRole('button', { name: /^Back$/ }))
    await gotoStep('Review & Post')
    expect(await screen.findByText('Final Verification & Posting')).toBeTruthy()
    expect((screen.getByLabelText(/Posting Note/i) as HTMLTextAreaElement).value).toBe(typed)
  })

  it('OTP UI appears after mocked request; duplicate clicks do not duplicate OTP requests', async () => {
    currentReport = readyReport()
    mockOtpRequest()
    renderSection()
    await gotoStep('Review & Post')
    const otp = await screen.findByRole('button', { name: /^Request OTP$/ })
    fireEvent.click(otp)
    fireEvent.click(otp)
    expect(await screen.findByLabelText('Opening Balance OTP code')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Verify OTP & Post Opening Balance/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Resend code/i })).toBeTruthy()
    await waitFor(() => {
      expect((global.fetch as any).mock.calls.filter(([u]: [string]) => String(u).includes('verification/request')).length).toBe(1)
    })
  })

  it('note reaches final posting path via session.notes and verify payload stays the OTP contract', async () => {
    currentSessionItems = [{ adjustment_quantity: -5 }]
    currentReport = varianceReadyReport()
    mockOtpRequest()
    renderSection()
    await gotoStep('Review & Post')
    fireEvent.change(await screen.findByLabelText(/Posting Note/i), { target: { value: 'Variance explained for audit' } })
    fireEvent.click(screen.getByRole('button', { name: /^Request OTP$/ }))
    await screen.findByLabelText('Opening Balance OTP code')
    fireEvent.change(screen.getByLabelText('Opening Balance OTP code'), { target: { value: '12345678' } })
    fireEvent.click(screen.getByRole('button', { name: /Verify OTP & Post Opening Balance/ }))
    await waitFor(() => {
      const verifyCalls = (global.fetch as any).mock.calls.filter(([u]: [string]) => String(u).includes('verification/verify'))
      expect(verifyCalls.length).toBe(1)
      expect(JSON.parse(verifyCalls[0][1].body)).toEqual({
        requestId: 'req-1',
        sessionId: 'sess-1',
        code: '12345678',
      })
    })
    expect(sessionUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ notes: 'Variance explained for audit' }))
  })

  it('backend OTP errors are shown visibly and genuine blockers keep Request OTP unavailable', async () => {
    currentReport = readyReport()
    mockOtpRequest({ ok: false, error: 'Resolve all cut-off blockers before requesting verification.', code: 'invalid_count_data' })
    renderSection()
    await gotoStep('Review & Post')
    fireEvent.click(await screen.findByRole('button', { name: /^Request OTP$/ }))
    expect(await screen.findByText(/Resolve all cut-off blockers before requesting verification/i)).toBeTruthy()

    cleanup()
    currentReport = buildReport({ readiness: 'Blocked', blockers: ['D2H unresolved'] })
    renderSection()
    await gotoStep('Review & Post')
    expect(screen.queryByRole('button', { name: /^Request OTP$/ })).toBeNull()
  })

  it('normal Back does not cancel the exercise', async () => {
    currentReport = readyReport()
    renderSection()
    await gotoStep('Review & Post')
    fireEvent.click(screen.getByRole('button', { name: /^Back$/ }))
    expect(cancelCalls()).toBe(0)
    expect(screen.queryByText('Cancel Entire Opening Balance Exercise?')).toBeNull()
  })

  it('opens cancel confirmation only from Danger Zone and requires exact cutoff name + reason', async () => {
    currentReport = readyReport()
    renderSection()
    await openCancelModal()
    expect(cancelCalls()).toBe(0)
    expect(screen.getByText(/permanently abandon '5th Initial'/i)).toBeTruthy()
    expect(screen.getByText(/not the same as going back or cancelling OTP/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm Cancel Entire Exercise' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(DEFAULT_DRAFT_REFERENCE), { target: { value: 'wrong' } })
    expect(screen.getByRole('button', { name: 'Confirm Cancel Entire Exercise' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByPlaceholderText(DEFAULT_DRAFT_REFERENCE), { target: { value: DEFAULT_DRAFT_REFERENCE } })
    expect(screen.getByRole('button', { name: 'Confirm Cancel Entire Exercise' }).hasAttribute('disabled')).toBe(false)
  })

  it('Keep Opening Balance closes the modal without any mutation', async () => {
    currentReport = readyReport()
    renderSection()
    await openCancelModal()
    fireEvent.click(screen.getByRole('button', { name: 'Keep Opening Balance' }))
    await waitFor(() => expect(screen.queryByText('Cancel Entire Opening Balance Exercise?')).toBeNull())
    expect(cancelCalls()).toBe(0)
  })

  it('Confirm Cancel Entire Exercise cancels the correct exercise once (mocked RPC only)', async () => {
    const onCancelled = vi.fn()
    currentReport = readyReport()
    renderSection({ onCancelled })
    await openCancelModal('operator abandoned')
    fireEvent.change(screen.getByPlaceholderText(DEFAULT_DRAFT_REFERENCE), { target: { value: DEFAULT_DRAFT_REFERENCE } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Cancel Entire Exercise' }))
    await waitFor(() => expect(cancelCalls()).toBe(1))
    const args = rpcSpy.mock.calls.find(([n]) => n === 'cancel_inventory_opening_cutoff')![1]
    expect(args).toEqual({ p_cutoff_id: 'cutoff-1', p_reason: 'operator abandoned' })
    expect(await screen.findByText('Opening Balance cancelled. The warehouse has been reopened.')).toBeTruthy()
    expect(onCancelled).toHaveBeenCalledTimes(1)
    expect(rpcSpy.mock.calls.some(([n]) => n === 'verify_and_post_inventory_opening_cutoff')).toBe(false)
    expect((global.fetch as any).mock.calls.filter(([u]: [string]) => String(u).includes('verification/')).length).toBe(0)
  })

  it('cannot cancel twice on rapid confirm clicks', async () => {
    currentReport = readyReport()
    renderSection()
    await openCancelModal()
    fireEvent.change(screen.getByPlaceholderText(DEFAULT_DRAFT_REFERENCE), { target: { value: DEFAULT_DRAFT_REFERENCE } })
    const confirm = screen.getByRole('button', { name: 'Confirm Cancel Entire Exercise' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await waitFor(() => expect(cancelCalls()).toBe(1))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cancelCalls()).toBe(1)
  })

  it('disables cancellation for non-HQ users once Danger Zone is opened', async () => {
    const nonHq = { organizations: { org_type_code: 'DISTRIBUTOR' }, roles: { role_level: 50 } }
    currentReport = readyReport()
    renderSection({ userProfile: nonHq })
    await openDangerZone()
    fireEvent.change(await screen.findByLabelText('Cancellation Reason'), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: 'Cancel Entire Opening Balance Exercise' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('Only an HQ Admin may cancel an Opening Balance exercise.')).toBeTruthy()
  })

  it('does not render the Danger Zone for a posted exercise', async () => {
    currentCutoffRow = {
      id: 'cutoff-1',
      status: 'posted',
      stock_count_session_id: 'sess-1',
      warehouse_organization_id: 'wh-1',
      proposed_cutoff_at: '2026-07-31T09:32:00Z',
    }
    currentReport = readyReport()
    renderSection({ openingBalancePosted: true })
    expect(await screen.findByText('Official Opening Balance posted')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Danger Zone \/ More Actions/i })).toBeNull()
    expect(screen.queryByLabelText('Cancellation Reason')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Final OTP post — failure, retry and post-commit refresh.
  // Regression cover for SC-MSB3UFDM-1FSK: the post failed with a specific
  // server rejection (inventory_cutoff_distributor_decision_stale) but the UI
  // showed only "an unexpected error" and kept inviting reuse of the same code.
  // -------------------------------------------------------------------------
  const reachOtpEntry = async () => {
    currentReport = reviewRequiredReport({
      inventory: Array.from({ length: 112 }, (_, i) => ({
        stock_config_id: `c${i + 1}`,
        variant_name: `V${i + 1}`,
        stock_configuration: '20ml New Box',
        system_quantity: 2650,
        physical_quantity: 2475,
        variance: -175,
        allocated_quantity: 0,
      })),
    })
    currentSessionItems = [{ adjustment_quantity: -175 }]
    currentSessionNotes = 'Testing for OTP ok'
    renderSection()
    await gotoStep('Review & Post')
    fireEvent.click(await screen.findByRole('button', { name: /^Request OTP$/ }))
    const input = await screen.findByLabelText('Opening Balance OTP code')
    fireEvent.change(input, { target: { value: '34185883' } })
    return input
  }

  /** Route the OTP request to success and the final post to `postResponse`. */
  const mockPostFetch = (postResponse: { ok: boolean; body: unknown }) => {
    const baseFetch = global.fetch as any
    const verifyCalls: any[] = []
    global.fetch = vi.fn(async (url: any, init: any) => {
      if (String(url).includes('verification/request')) {
        return {
          ok: true,
          json: async () => ({ requestId: 'req-1', recipients: ['a@b.com'], expiresAt: '2026-08-02T01:25:14Z' }),
        } as any
      }
      if (String(url).includes('verification/verify')) {
        verifyCalls.push(JSON.parse(init.body))
        return { ok: postResponse.ok, json: async () => postResponse.body } as any
      }
      return baseFetch(url, init)
    }) as any
    return verifyCalls
  }

  it('surfaces the specific server error plus its correlation reference, not a bare "unexpected error"', async () => {
    const verifyCalls = mockPostFetch({
      ok: false,
      body: {
        error: 'A distributor (D2H/S2D) order changed after the Distributor Orders policy was saved, so the Opening Balance was not posted. No inventory was changed. Reopen Step 2 (Distributor Orders), re-save the policy, then request a new verification code.',
        code: 'opening_balance_distributor_decision_stale',
        reference: 'SC-MSB3UFDM-1FSK',
        stage: 'post',
      },
    })
    await reachOtpEntry()
    fireEvent.click(screen.getByRole('button', { name: /Verify OTP & Post Opening Balance/i }))

    expect(await screen.findByText(/Reopen Step 2 \(Distributor Orders\)/i)).toBeTruthy()
    // The correlation reference stays visible for an actionable error too.
    expect(screen.getByText(/SC-MSB3UFDM-1FSK/)).toBeTruthy()
    expect(verifyCalls).toEqual([{ requestId: 'req-1', sessionId: 'sess-1', code: '34185883' }])
  })

  it('keeps the Posting Note and the still-valid code after a rolled-back post', async () => {
    mockPostFetch({
      ok: false,
      body: { error: 'Opening Balance was not posted.', code: 'opening_balance_distributor_decision_stale', reference: 'SC-X-1' },
    })
    await reachOtpEntry()
    fireEvent.click(screen.getByRole('button', { name: /Verify OTP & Post Opening Balance/i }))
    await screen.findByText(/SC-X-1/)

    // The note survives the failure so the retry keeps its audit text.
    expect((screen.getByLabelText(/Posting Note/i) as HTMLTextAreaElement).value).toBe('Testing for OTP ok')
    expect(screen.getByText(/Inventory was not changed and your Posting Note has been kept/i)).toBeTruthy()
    // A rolled-back post leaves the request usable — the OTP field stays.
    expect(screen.getByLabelText('Opening Balance OTP code')).toBeTruthy()
    // ...but the UI must not simultaneously claim the code "was sent" and OK.
    expect(screen.queryByText(/A verification code was sent\./i)).toBeNull()
  })

  it('withdraws the OTP field and demands a fresh code once the request is spent', async () => {
    mockPostFetch({
      ok: false,
      body: { error: 'This verification code has already been used. Please request a new code.', code: 'code_already_used', reference: 'SC-Y-2' },
    })
    await reachOtpEntry()
    fireEvent.click(screen.getByRole('button', { name: /Verify OTP & Post Opening Balance/i }))

    expect(await screen.findByText('A new verification code is required')).toBeTruthy()
    // The spent code can no longer be re-submitted.
    expect(screen.queryByLabelText('Opening Balance OTP code')).toBeNull()
    expect(screen.queryByRole('button', { name: /Verify OTP & Post Opening Balance/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Request a new OTP/i })).toBeTruthy()
    expect(screen.getByText(/SC-Y-2/)).toBeTruthy()
    // The note is still preserved for the retry.
    expect((screen.getByLabelText(/Posting Note/i) as HTMLTextAreaElement).value).toBe('Testing for OTP ok')
  })

  it('never shows posting success while the post failed', async () => {
    mockPostFetch({ ok: false, body: { error: 'nope', code: 'opening_balance_not_ready', reference: 'SC-Z-3' } })
    await reachOtpEntry()
    fireEvent.click(screen.getByRole('button', { name: /Verify OTP & Post Opening Balance/i }))
    await screen.findByText(/SC-Z-3/)
    const posted = stableToast.toast.mock.calls.find(([a]) => /Opening Balance posted/i.test(String(a?.title)))
    expect(posted).toBeFalsy()
    expect(screen.queryByText('Official Opening Balance posted')).toBeNull()
  })

  it('a double-click issues exactly one post call', async () => {
    let resolvePost: (value: unknown) => void = () => {}
    const pending = new Promise(resolve => { resolvePost = resolve })
    const baseFetch = global.fetch as any
    const verifyCalls: any[] = []
    global.fetch = vi.fn(async (url: any, init: any) => {
      if (String(url).includes('verification/request')) {
        return { ok: true, json: async () => ({ requestId: 'req-1', recipients: ['a@b.com'], expiresAt: '2026-08-02T01:25:14Z' }) } as any
      }
      if (String(url).includes('verification/verify')) {
        verifyCalls.push(JSON.parse(init.body))
        await pending
        return { ok: true, json: async () => ({ status: 'posted', variance_movements: 98 }) } as any
      }
      return baseFetch(url, init)
    }) as any

    await reachOtpEntry()
    const button = screen.getByRole('button', { name: /Verify OTP & Post Opening Balance/i })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    resolvePost({})
    await waitFor(() => expect(verifyCalls.length).toBe(1))
  })

  it('broadcasts one inventory refresh only after the commit is confirmed', async () => {
    const refreshes: any[] = []
    const listener = (event: Event) => refreshes.push((event as CustomEvent).detail)
    window.addEventListener(INVENTORY_DATA_REFRESH_EVENT, listener)
    try {
      mockPostFetch({ ok: true, body: { status: 'posted', cutoff_id: 'cutoff-1', session_id: 'sess-1', variance_movements: 98 } })
      await reachOtpEntry()
      fireEvent.click(screen.getByRole('button', { name: /Verify OTP & Post Opening Balance/i }))
      await waitFor(() => expect(refreshes.length).toBe(1))
      expect(refreshes[0]).toMatchObject({
        reason: 'opening_balance_posted',
        warehouseOrganizationId: 'wh-1',
        referenceId: 'sess-1',
      })
    } finally {
      window.removeEventListener(INVENTORY_DATA_REFRESH_EVENT, listener)
    }
  })

  it('does not broadcast a refresh when the post is rejected', async () => {
    const refreshes: any[] = []
    const listener = (event: Event) => refreshes.push((event as CustomEvent).detail)
    window.addEventListener(INVENTORY_DATA_REFRESH_EVENT, listener)
    try {
      mockPostFetch({ ok: false, body: { error: 'rejected', code: 'opening_balance_distributor_decision_stale', reference: 'SC-Q-9' } })
      await reachOtpEntry()
      fireEvent.click(screen.getByRole('button', { name: /Verify OTP & Post Opening Balance/i }))
      await screen.findByText(/SC-Q-9/)
      expect(refreshes).toEqual([])
    } finally {
      window.removeEventListener(INVENTORY_DATA_REFRESH_EVENT, listener)
    }
  })

})
