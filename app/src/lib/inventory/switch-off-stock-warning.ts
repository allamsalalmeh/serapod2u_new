/**
 * Switching off a product or variant that still has stock strands that stock:
 * Stock Count and Stock Transfer only list active master data, and the shop
 * shows it as sold out. Switching off stays allowed; the user is told where the
 * stock is and how to deal with it first.
 */

export interface HeldStock {
  warehouse: string
  quantity: number
}

/** Stock on hand per location for the given variants. Empty when it cannot be read. */
export async function stockHeldByVariants(supabase: any, variantIds: string[]): Promise<HeldStock[]> {
  const ids = [...new Set(variantIds.filter(Boolean))]
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('product_inventory')
    .select('quantity_on_hand, organizations(org_name)')
    .in('variant_id', ids)
    .eq('is_active', true)
    .gt('quantity_on_hand', 0)
  if (error || !data) return []
  const byWarehouse = new Map<string, number>()
  for (const row of data as any[]) {
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations
    const name = String(org?.org_name || 'Unknown location')
    byWarehouse.set(name, (byWarehouse.get(name) || 0) + Number(row.quantity_on_hand || 0))
  }
  return [...byWarehouse.entries()]
    .map(([warehouse, quantity]) => ({ warehouse, quantity }))
    .sort((a, b) => b.quantity - a.quantity)
}

export function switchOffStockWarning(name: string, held: HeldStock[]): string {
  const lines = held.map((h) => `• ${h.warehouse}: ${h.quantity.toLocaleString('en-US')}`).join('\n')
  return [
    `${name} still has stock:`,
    lines,
    '',
    'Once it is switched off, this stock cannot be counted or moved from Stock Count or Stock Transfer, and the shop shows it as sold out.',
    'Count or move the stock first. To fix it later, switch it back on, then count or move it.',
    '',
    'Switch it off anyway?',
  ].join('\n')
}

/**
 * Asks before switching off something that holds stock. Resolves true when there is
 * no stock (or it cannot be read) or the user confirms.
 */
export async function confirmSwitchOffWithStock(
  supabase: any,
  name: string,
  variantIds: string[],
  ask: (message: string) => boolean = (message) => window.confirm(message),
): Promise<boolean> {
  const held = await stockHeldByVariants(supabase, variantIds)
  if (held.length === 0) return true
  return ask(switchOffStockWarning(name, held))
}
