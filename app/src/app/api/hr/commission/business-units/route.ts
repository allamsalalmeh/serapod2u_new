import { NextResponse } from 'next/server'
import { badRequest, commissionContext, isDate, isUuid, readJson, requireAny, rpc, text } from '@/lib/server/commission/route-kit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/hr/commission/business-units
 *   { action: 'save', id?, code, name, description?, isActive?, reason }
 *   { action: 'map_brand', businessUnitId, brandId, effectiveFrom, reason }
 *   { action: 'end_mapping', mappingId, effectiveTo, reason }
 * hr.commission.manage (enforced again by the database function).
 */
export async function POST(request: Request) {
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.manage')
  if (denied) return denied
  const body = await readJson(request)
  const reason = text(body.reason) || null

  if (body.action === 'save') {
    if (body.id != null && !isUuid(body.id)) return badRequest('Invalid Business Unit.')
    const code = text(body.code, 30).toUpperCase()
    const name = text(body.name, 120)
    if (!body.id && !/^[A-Z][A-Z0-9_-]{1,29}$/.test(code)) return badRequest('Code: 2–30 characters, letters, digits, _ or -, starting with a letter.')
    if (name.length < 2) return badRequest('Enter a Business Unit name.')
    const r = await rpc(ctx, 'hr_commission_save_business_unit', {
      p_id: body.id ?? null, p_code: code, p_name: name, p_description: text(body.description) || null,
      p_is_active: body.isActive ?? true, p_reason: reason,
    })
    return 'response' in r ? r.response : NextResponse.json({ success: true, businessUnit: r.data })
  }
  if (body.action === 'map_brand') {
    if (!isUuid(body.businessUnitId) || !isUuid(body.brandId) || !isDate(body.effectiveFrom)) return badRequest('Choose a Business Unit, a brand and an effective date.')
    const r = await rpc(ctx, 'hr_commission_map_brand', { p_business_unit: body.businessUnitId, p_brand: body.brandId, p_effective_from: body.effectiveFrom, p_reason: reason })
    return 'response' in r ? r.response : NextResponse.json({ success: true, mapping: r.data })
  }
  if (body.action === 'end_mapping') {
    if (!isUuid(body.mappingId) || !isDate(body.effectiveTo)) return badRequest('Choose a mapping and an end date.')
    const r = await rpc(ctx, 'hr_commission_end_brand_mapping', { p_mapping: body.mappingId, p_effective_to: body.effectiveTo, p_reason: reason })
    return 'response' in r ? r.response : NextResponse.json({ success: true, mapping: r.data })
  }
  return badRequest('Unknown action.')
}
