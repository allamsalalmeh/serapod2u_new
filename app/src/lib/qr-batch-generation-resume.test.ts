import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateQRExcel = vi.fn()
vi.mock('@/lib/excel-generator', () => ({
  generateQRExcel: (...args: unknown[]) => generateQRExcel(...args),
  generateQRExcelFilename: () => 'ORD26000106.xlsx',
}))
vi.mock('@/lib/notifications/supplyChainEventQueue', () => ({ queueNotificationEvent: vi.fn() }))

import { runQRBatchGeneration } from './qr-batch-generation'

const updates: Array<{ patch: any; id: unknown }> = []

function clientFor(batch: any) {
  return {
    from: () => ({
      select: () => {
        const q: any = { in: () => q, eq: () => q, order: () => q, limit: () => q, single: async () => ({ data: batch, error: null }) }
        return q
      },
      update: (patch: any) => {
        const q: any = {
          eq: (k: string, v: unknown) => {
            if (k === 'id') updates.push({ patch, id: v })
            return q
          },
          select: async () => ({ data: [{ ...batch, ...patch }], error: null }),
          then: (resolve: any) => resolve({ error: null }),
        }
        return q
      },
    }),
  } as any
}

const batch = (overrides: Record<string, unknown> = {}) => ({
  id: 'batch-1',
  status: 'processing',
  buffer_percent: 10,
  excel_generated: false,
  master_inserted: false,
  qr_inserted_count: 0,
  total_unique_codes: 1100,
  order: {
    id: 'order-106',
    order_no: 'ORD26000106',
    // The order's setting has since moved to 1%; the batch was created at 10%.
    qr_buffer_percent: 1,
    units_per_case: 100,
    created_at: '2026-10-01T00:00:00Z',
    buyer_org: { id: 'hq', org_name: 'Serapod', org_code: 'HQ' },
    seller_org: { id: 'mfg', org_name: 'Manufacturer', org_code: 'MFG' },
    order_items: [
      {
        id: 'i1', qty: 1000, product_id: 'p', variant_id: 'v', units_per_case: null,
        product: { id: 'p', product_code: 'CEL', product_name: 'Cellera Hero' },
        variant: { id: 'v', variant_code: 'HONEYDEW', variant_name: 'Honeydew' },
      },
    ],
  },
  ...overrides,
})

describe('runQRBatchGeneration', () => {
  beforeEach(() => {
    updates.length = 0
    generateQRExcel.mockReset()
  })

  it('resumes with the buffer percent the batch was created with', async () => {
    generateQRExcel.mockRejectedValue(new Error('stop after counting'))
    await runQRBatchGeneration(clientFor(batch()), { notificationBaseUrl: 'https://x', batchId: 'batch-1' })

    const args = generateQRExcel.mock.calls[0][0]
    expect(args.bufferPercent).toBe(10)
    expect(args.totalUniqueCodes).toBe(1100)
  })

  it('a 1% batch generates 1,010 case codes and 10 master codes', async () => {
    generateQRExcel.mockRejectedValue(new Error('stop after counting'))
    await runQRBatchGeneration(clientFor(batch({ buffer_percent: 1, total_unique_codes: 1010 })), {
      notificationBaseUrl: 'https://x',
      batchId: 'batch-1',
    })

    const args = generateQRExcel.mock.calls[0][0]
    expect(args.totalUniqueCodes).toBe(1010)
    expect(args.totalMasterCodes).toBe(10)
    expect(args.individualCodes).toHaveLength(1010)
  })

  it('records the failure on the batch and leaves its status for the next run to resume', async () => {
    generateQRExcel.mockRejectedValue(new Error('Storage upload timed out'))
    const res = await runQRBatchGeneration(clientFor(batch()), { notificationBaseUrl: 'https://x', batchId: 'batch-1' })

    expect(res.status).toBe(500)
    const logged = updates.find((u) => 'last_error' in u.patch)
    expect(logged).toEqual({ id: 'batch-1', patch: { last_error: 'Storage upload timed out' } })
    expect(updates.some((u) => 'status' in u.patch)).toBe(false)
  })
})
