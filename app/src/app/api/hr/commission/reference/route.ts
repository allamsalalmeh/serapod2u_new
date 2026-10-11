import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { commissionContext, requireAny } from '@/lib/server/commission/route-kit'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/commission/reference — Business Units (with brand mappings), brands and the company's departments.
 * Business Units and mappings are read through RLS; brands are the shared catalogue; departments come from HR.
 */
export async function GET() {
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.view', 'reporting.commission.view')
  if (denied) return denied

  const [{ data: units }, { data: mappings }] = await Promise.all([
    ctx.supabase.from('hr_commission_business_units').select('id, code, name, description, is_active, updated_at').order('name'),
    ctx.supabase.from('hr_commission_bu_brands').select('id, business_unit_id, brand_id, effective_from, effective_to').order('effective_from'),
  ])
  const admin = createAdminClient() as any
  const [{ data: brands }, { data: departments }] = await Promise.all([
    admin.from('brands').select('id, brand_name, brand_code, is_active').order('brand_name'),
    ctx.access.companyId
      ? admin.from('departments').select('id, dept_name, organization_id').eq('organization_id', ctx.access.companyId).eq('is_active', true).order('dept_name')
      : Promise.resolve({ data: [] }),
  ])
  const brandName = new Map((brands ?? []).map((b: any) => [b.id, b.brand_name]))
  return NextResponse.json({
    success: true,
    businessUnits: (units ?? []).map((u: any) => ({
      ...u,
      brands: (mappings ?? []).filter((m: any) => m.business_unit_id === u.id).map((m: any) => ({ ...m, brand_name: brandName.get(m.brand_id) ?? 'Unknown brand' })),
    })),
    brands: brands ?? [],
    departments: (departments ?? []).map((d: any) => ({ id: d.id, name: d.dept_name })),
  })
}
