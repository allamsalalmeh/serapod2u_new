import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadOrderBumpOffer, loadOutdoorBundles, loadOutdoorCheckoutSettings } from '@/lib/outdoor/sales-tools-server'

export const dynamic = 'force-dynamic'

/** GET /api/storefront/outdoor-offers — Outdoor combos and the checkout offer, from public catalogue data. */
export async function GET() {
  try {
    const supabase: any = createAdminClient()
    const settings = await loadOutdoorCheckoutSettings(supabase)
    const [orderBump, bundles] = await Promise.all([loadOrderBumpOffer(supabase, settings), loadOutdoorBundles(supabase)])
    return NextResponse.json({
      orderBump,
      bundles: bundles.map(({ isActive: _isActive, sortOrder: _sortOrder, complete: _complete, ...bundle }) => bundle),
    })
  } catch (err) {
    console.error('[outdoor-offers]', err)
    return NextResponse.json({ orderBump: null, bundles: [] })
  }
}
