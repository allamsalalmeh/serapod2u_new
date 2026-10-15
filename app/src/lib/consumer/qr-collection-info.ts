import type { SupabaseClient } from '@supabase/supabase-js'
import { userAllowed } from '@/lib/security-access/operation'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { resolveQrCodeRecord } from '@/lib/utils/qr-resolver'

export interface QrCollectionEntry {
  lane: 'shop' | 'consumer'
  collected_at: string | null
  points: number
  shop_name: string | null
  person_name: string | null
  phone_last4: string | null
}

export interface QrCollectionInfo {
  code: string
  product_name: string | null
  variant_name: string | null
  collections: QrCollectionEntry[]
  view_count: number
  last_viewed_at: string | null
}

interface ScanRow {
  claim_lane: string | null
  collected_points: boolean | null
  points_amount: number | null
  points_collected_at: string | null
  scanned_at: string | null
  shop_id: string | null
  consumer_id: string | null
  consumer_name: string | null
  consumer_phone: string | null
}

export function phoneLast4(phone: string | null | undefined): string | null {
  const digits = String(phone || '').replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : null
}

export function buildQrCollectionEntries(
  scans: ScanRow[],
  shopNames: Map<string, string>,
  users: Map<string, { full_name: string | null; phone: string | null }>,
): QrCollectionEntry[] {
  return scans
    .filter((scan) => scan.collected_points === true)
    .map((scan) => {
      const user = scan.consumer_id ? users.get(scan.consumer_id) : undefined
      return {
        lane: scan.claim_lane === 'consumer' ? 'consumer' as const : 'shop' as const,
        collected_at: scan.points_collected_at || scan.scanned_at,
        points: Number(scan.points_amount) || 0,
        shop_name: scan.shop_id ? shopNames.get(scan.shop_id) ?? null : null,
        person_name: user?.full_name || scan.consumer_name || null,
        phone_last4: phoneLast4(user?.phone || scan.consumer_phone),
      }
    })
    .sort((a, b) => String(b.collected_at || '').localeCompare(String(a.collected_at || '')))
}

/** HQ staff (role level <= 30) or anyone granted customer.consumer.view. */
export async function requireQrCollectionViewer() {
  const supabase = await createClient()
  const { data: { user }, error: authErr } = await supabase.auth.getUser()
  if (authErr || !user) return { status: 401 as const }

  const adminClient = createAdminClient()
  const { data: profile } = await adminClient
    .from('users')
    .select('id, organization_id, is_active, organizations!fk_users_organization(id, org_type_code), roles(role_level)')
    .eq('id', user.id)
    .single()
  if (!profile) return { status: 403 as const }

  const orgType = (profile.organizations as any)?.org_type_code
  const roleLevel = (profile.roles as any)?.role_level
  const allowed = await userAllowed(
    user.id,
    'customer.consumer.view',
    () => orgType === 'HQ' && roleLevel != null && roleLevel <= 30 && !!profile.organization_id && profile.is_active !== false,
    { organizationId: profile.organization_id },
  )
  if (!allowed) return { status: 403 as const }
  return { status: 200 as const, userId: user.id, orgId: profile.organization_id as string }
}

export async function loadQrCollectionInfo(admin: SupabaseClient, rawCode: string): Promise<QrCollectionInfo | null> {
  const qr = await resolveQrCodeRecord(admin, rawCode)
  if (!qr) return null

  const [{ data: scans, error: scanError }, { data: product }, { data: variant }] = await Promise.all([
    admin
      .from('consumer_qr_scans')
      .select('claim_lane, collected_points, points_amount, points_collected_at, scanned_at, shop_id, consumer_id, consumer_name, consumer_phone')
      .eq('qr_code_id', qr.id)
      .order('scanned_at', { ascending: false })
      .limit(500),
    qr.product_id
      ? admin.from('products').select('product_name').eq('id', qr.product_id).maybeSingle()
      : Promise.resolve({ data: null }),
    qr.variant_id
      ? admin.from('product_variants').select('variant_name').eq('id', qr.variant_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  if (scanError) throw new Error(scanError.message)

  const rows = (scans || []) as ScanRow[]
  const collected = rows.filter((row) => row.collected_points === true)
  const shopIds = [...new Set(collected.map((row) => row.shop_id).filter(Boolean))] as string[]
  const userIds = [...new Set(collected.map((row) => row.consumer_id).filter(Boolean))] as string[]

  const [{ data: shops }, { data: users }] = await Promise.all([
    shopIds.length
      ? admin.from('organizations').select('id, org_name').in('id', shopIds)
      : Promise.resolve({ data: [] }),
    userIds.length
      ? admin.from('users').select('id, full_name, phone').in('id', userIds)
      : Promise.resolve({ data: [] }),
  ])

  const shopNames = new Map<string, string>(((shops || []) as any[]).map((shop) => [shop.id, shop.org_name]))
  const userMap = new Map<string, { full_name: string | null; phone: string | null }>(
    ((users || []) as any[]).map((u) => [u.id, { full_name: u.full_name, phone: u.phone }]),
  )
  const views = rows.filter((row) => row.collected_points !== true)

  return {
    code: qr.code,
    product_name: (product as any)?.product_name ?? null,
    variant_name: (variant as any)?.variant_name ?? null,
    collections: buildQrCollectionEntries(rows, shopNames, userMap),
    view_count: views.length,
    last_viewed_at: views[0]?.scanned_at ?? null,
  }
}
