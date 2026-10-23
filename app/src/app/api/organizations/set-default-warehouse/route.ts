import { userAllowed } from '@/lib/security-access/operation'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { DEFAULT_DISTRIBUTOR_FULFILLMENT_WAREHOUSE_SETTING_KEY } from '@/lib/orders/hq-fulfillment-warehouses'

function onlineShopSaveError(error: { message?: string }) {
  console.error('Failed to set online shop warehouse:', error)
  if (/storefront_warehouse_org_id|outdoor_warehouse_org_id/i.test(String(error.message || ''))) {
    return NextResponse.json(
      { error: 'The online shop warehouse setting is not installed yet. Apply the storefront warehouse migrations first.' },
      { status: 503 },
    )
  }
  return NextResponse.json({ error: error.message || 'Failed to set the online shop warehouse' }, { status: 400 })
}

async function followWebsiteForOutdoorShop(supabase: any, userId: string, hqOrgId: string) {
  const { data: isHqAdmin, error: adminError } = await supabase.rpc('is_hq_admin')
  if (adminError) {
    return NextResponse.json({ error: 'Unable to verify admin permissions.' }, { status: 500 })
  }
  if (!(await userAllowed(userId, 'platform.organization.manage', () => Boolean(isHqAdmin)))) {
    return NextResponse.json({ error: 'Only HQ Admin can change the Outdoor shop warehouse.' }, { status: 403 })
  }
  const { data: hq } = await supabase
    .from('organizations')
    .select('id, org_type_code, is_active')
    .eq('id', hqOrgId)
    .maybeSingle()
  if (!hq || hq.org_type_code !== 'HQ') {
    return NextResponse.json({ error: 'HQ organization not found' }, { status: 404 })
  }
  const { error } = await supabase
    .from('organizations')
    .update({ outdoor_warehouse_org_id: null, updated_at: new Date().toISOString() })
    .eq('id', hqOrgId)
  if (error) return onlineShopSaveError(error)
  return NextResponse.json({
    success: true,
    message: 'The Outdoor shop now uses the same warehouse as the other website orders.',
    hq_org_id: hqOrgId,
    warehouse_org_id: null,
  })
}

async function followDefaultForOnlineShop(supabase: any, userId: string, hqOrgId: string) {
  const { data: isHqAdmin, error: adminError } = await supabase.rpc('is_hq_admin')
  if (adminError) {
    return NextResponse.json({ error: 'Unable to verify admin permissions.' }, { status: 500 })
  }
  if (!(await userAllowed(userId, 'platform.organization.manage', () => Boolean(isHqAdmin)))) {
    return NextResponse.json({ error: 'Only HQ Admin can change the online shop warehouse.' }, { status: 403 })
  }
  const { data: hq } = await supabase
    .from('organizations')
    .select('id, org_type_code, is_active')
    .eq('id', hqOrgId)
    .maybeSingle()
  if (!hq || hq.org_type_code !== 'HQ') {
    return NextResponse.json({ error: 'HQ organization not found' }, { status: 404 })
  }
  const { error } = await supabase
    .from('organizations')
    .update({ storefront_warehouse_org_id: null, updated_at: new Date().toISOString() })
    .eq('id', hqOrgId)
  if (error) return onlineShopSaveError(error)
  return NextResponse.json({
    success: true,
    message: 'Website orders now follow the default fulfillment warehouse.',
    hq_org_id: hqOrgId,
    warehouse_org_id: null,
  })
}

/**
 * POST /api/organizations/set-default-warehouse
 * Sets organizations.default_warehouse_org_id for an HQ.
 * Application setting key: default_distributor_fulfillment_warehouse_id
 *
 * With purpose 'online_shop' it sets organizations.storefront_warehouse_org_id
 * instead (website orders only); warehouse_org_id null = follow the default.
 * With purpose 'outdoor_shop' it sets organizations.outdoor_warehouse_org_id
 * (Outdoor shop only); warehouse_org_id null = same as the website warehouse.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { hq_org_id, warehouse_org_id } = body
    const onlineShop = body.purpose === 'online_shop'
    const outdoorShop = body.purpose === 'outdoor_shop'

    if (onlineShop && hq_org_id && warehouse_org_id === null) {
      return followDefaultForOnlineShop(supabase, user.id, hq_org_id)
    }
    if (outdoorShop && hq_org_id && warehouse_org_id === null) {
      return followWebsiteForOutdoorShop(supabase, user.id, hq_org_id)
    }

    if (!hq_org_id || !warehouse_org_id) {
      return NextResponse.json(
        { error: 'hq_org_id and warehouse_org_id are required' },
        { status: 400 },
      )
    }

    const { data: isHqAdmin, error: adminError } = await supabase.rpc('is_hq_admin')
    if (adminError) {
      console.error('Failed to verify HQ admin:', adminError)
      return NextResponse.json({ error: 'Unable to verify admin permissions.' }, { status: 500 })
    }
    if (!(await userAllowed(user.id, 'platform.organization.manage', () => Boolean(isHqAdmin)))) {
      return NextResponse.json(
        { error: 'Only HQ Admin can update the default fulfillment warehouse.' },
        { status: 403 },
      )
    }

    const { data: hq, error: hqError } = await supabase
      .from('organizations')
      .select('id, org_type_code, is_active')
      .eq('id', hq_org_id)
      .maybeSingle()

    if (hqError || !hq) {
      return NextResponse.json({ error: 'HQ organization not found' }, { status: 404 })
    }
    if (hq.org_type_code !== 'HQ' || hq.is_active !== true) {
      return NextResponse.json({ error: 'Target organization must be an active HQ' }, { status: 400 })
    }

    const { data: warehouse, error: warehouseError } = await supabase
      .from('organizations')
      .select('id, org_name, org_type_code, parent_org_id, is_active')
      .eq('id', warehouse_org_id)
      .single()

    if (warehouseError || !warehouse) {
      return NextResponse.json({ error: 'Warehouse not found' }, { status: 404 })
    }
    if (warehouse.org_type_code !== 'WH' || warehouse.is_active !== true) {
      return NextResponse.json(
        { error: 'Organization must be an active warehouse (WH type)' },
        { status: 400 },
      )
    }
    if (warehouse.parent_org_id !== hq_org_id) {
      return NextResponse.json(
        { error: 'Warehouse must be an active child of this HQ' },
        { status: 400 },
      )
    }

    if (outdoorShop) {
      const { error: shopError } = await supabase
        .from('organizations')
        .update({ outdoor_warehouse_org_id: warehouse_org_id, updated_at: new Date().toISOString() })
        .eq('id', hq_org_id)
      if (shopError) return onlineShopSaveError(shopError)
      return NextResponse.json({
        success: true,
        message: `The Outdoor shop now sells from ${warehouse.org_name}. The Serapod2U store and distributor orders are unchanged.`,
        hq_org_id,
        warehouse_org_id,
        warehouse_name: warehouse.org_name,
      })
    }

    if (onlineShop) {
      const { error: shopError } = await supabase
        .from('organizations')
        .update({ storefront_warehouse_org_id: warehouse_org_id, updated_at: new Date().toISOString() })
        .eq('id', hq_org_id)
      if (shopError) return onlineShopSaveError(shopError)
      return NextResponse.json({
        success: true,
        message: `Website orders now ship from ${warehouse.org_name}. Distributor orders are unchanged.`,
        hq_org_id,
        warehouse_org_id,
        warehouse_name: warehouse.org_name,
      })
    }

    const { error: updateError } = await supabase
      .from('organizations')
      .update({
        default_warehouse_org_id: warehouse_org_id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', hq_org_id)

    if (updateError) {
      console.error('Failed to set default warehouse:', updateError)
      throw updateError
    }

    return NextResponse.json({
      success: true,
      setting_key: DEFAULT_DISTRIBUTOR_FULFILLMENT_WAREHOUSE_SETTING_KEY,
      message: `${warehouse.org_name} is now the default fulfillment warehouse`,
      hq_org_id,
      warehouse_org_id,
      warehouse_name: warehouse.org_name,
    })
  } catch (error: any) {
    console.error('Set default warehouse error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to set default warehouse' },
      { status: 500 },
    )
  }
}
