import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const order = source('components/orders/ViewOrderDetailsView.tsx')
const receive = source('components/dashboard/views/qr-tracking/WarehouseReceiveView2.tsx')
const ship = source('components/dashboard/views/qr-tracking/WarehouseShipV2.tsx')
const addStock = source('components/inventory/AddStockView.tsx')
const transfer = source('components/inventory/StockTransferView.tsx')
const inventory = source('components/inventory/InventoryView.tsx')
const movementReport = source('components/inventory/StockMovementReportView.tsx')

describe('stock configuration operational UI contracts', () => {
  it('keeps configuration off the sales order view now that allocation confirms it', () => {
    // Eligibility, old-box exclusion and sufficient availability are enforced
    // in resolve_so_stock_config() at allocation time (migration
    // 20260814100000), so the order view no longer offers a manual choice and
    // shows master-data identity instead. See
    // src/lib/orders/so-stock-config-auto-confirm-sql.test.tsx.
    expect(order).not.toContain('config.eligible')
    expect(order).not.toContain('Insufficient available stock. Fulfilment is blocked.')
    expect(order).not.toContain('Move this line\'s allocation')
    expect(order).toContain('item.variant?.product_code')
  })

  it('shows the receipt history configuration', () => {
    // The per-line "Inventory destination:" label was removed on purpose (2ddf7e85, simplified receive labels); the
    // destination data stays in the API — ReceiveItemLabel.test.tsx asserts both.
    expect(receive).toContain('Inventory Destination')
    expect(receive).toContain('Legacy / Unclassified')
  })

  it('makes WMS picking order-item configuration explicit and fail-closed', () => {
    expect(ship).toContain('order_items_stock_config_variant_fkey')
    expect(ship).toContain('Every order line must have a confirmed Stock SKU and order-item allocation before scanning.')
    expect(ship).toContain('Blocked: missing confirmed order-item configuration')
    expect(ship).toContain('QR identity does not select inventory')
    // Fulfillment WH (Serapp / HQ→WH) must bind ship sessions, not only seller_org_id.
    expect(ship).toContain('fulfillment_warehouse_id.eq.')
    expect(ship).toContain('seller_org_id.eq.')
  })

  it('uses exact configurations while hiding dimension controls for STD products', () => {
    expect(addStock).toContain('Manual Stock Addition')
    expect(addStock).toContain('post_manual_stock_addition')
    expect(addStock).toContain('stockConfigId')
    expect(addStock).toContain('Select all visible')
    expect(addStock).toContain('Review & Add Stock')
    expect(addStock).toContain('Ready to Post')
    expect(addStock).toContain('Legacy/Unclassified')
    expect(addStock).toContain('Use ORD Receiving for stock linked to a manufacturer order')
    // Shared exact-config anchor that remains true for both the committed and
    // in-progress Stock Transfer redesigns on this branch.
    expect(transfer).toContain('stock_config_id')
  })

  it('provides non-duplicating inventory summaries and configuration movement filters', () => {
    // The summary row is still one aggregated row per organization + variant;
    // the former "Aggregate variant total" caption was replaced by the
    // master-data variant identity line, so anchor on the aggregation itself.
    expect(inventory).toContain('aggregateVariantInventory')
    expect(inventory).toContain('variantIdentityLabel(summary.variantName, summary.variantProductCode)')
    // Renamed and restricted to inventory administrators: it reveals RETIRED
    // configurations carrying no stock, which is an audit question rather than
    // an operational one. See operational-inventory-simplification.test.tsx.
    expect(inventory).toContain('Show retired zero-balance configurations')
    expect(inventory).toContain('{canEditSettings() && (')
    expect(inventory).toContain('Legacy / Unclassified')
    expect(movementReport).toContain('Stock SKU / Configuration')
    expect(movementReport).toContain('All volumes')
    expect(movementReport).toContain('All packaging')
  })
})
