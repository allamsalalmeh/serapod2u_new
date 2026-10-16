import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * How a master case's product/variant was resolved from its unit codes:
 * - single:  every non-buffer unit in the case has the same variant
 * - mixed:   units carry more than one variant (variantId stays null)
 * - missing: no unit codes are linked to the case (variantId stays null)
 */
type MasterVariantStatus = 'single' | 'mixed' | 'missing'

interface ScannedCodeDetail {
  code: string
  codeType: 'master' | 'unique'
  productName: string | null
  variantName: string | null
  variantId: string | null
  imageUrl?: string | null
  quantity: number
  scannedAt: string
  variantStatus?: MasterVariantStatus
  variantIds?: string[]
}

type VariantDetail = {
  id: string
  variant_name: string | null
  image_url: string | null
  products: { product_name: string | null } | Array<{ product_name: string | null }> | null
}

// Keeps PostgREST `in.(...)` filters well inside URL limits.
const IN_CHUNK_SIZE = 100
// PostgREST caps a response at its max-rows setting; read every page.
const PAGE_SIZE = 1000

const chunk = <T,>(values: T[]): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < values.length; i += IN_CHUNK_SIZE) chunks.push(values.slice(i, i + IN_CHUNK_SIZE))
  return chunks
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>

const readAllPages = async <T,>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> => {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE_SIZE) return rows
  }
}

const productNameOf = (variant: VariantDetail | undefined): string | null => {
  const product = Array.isArray(variant?.products) ? variant?.products[0] : variant?.products
  return product?.product_name || null
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'inventory.report.view')
    if (saDenied) return saDenied

    const searchParams = request.nextUrl.searchParams
    const sessionId = searchParams.get('session_id')

    if (!sessionId) {
      return NextResponse.json({ error: 'session_id is required' }, { status: 400 })
    }

    // Fetch the validation session
    const { data: session, error: sessionError } = await supabase
      .from('qr_validation_reports')
      .select('master_codes_scanned, unique_codes_scanned, scanned_quantities, created_at')
      .eq('id', sessionId)
      .maybeSingle()

    if (sessionError || !session) {
      console.error('❌ Failed to load session:', sessionError)
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }

    const masterCodes: string[] = Array.isArray(session.master_codes_scanned) ? session.master_codes_scanned : []
    const uniqueCodes: string[] = Array.isArray(session.unique_codes_scanned) ? session.unique_codes_scanned : []
    const scannedQuantities = (session.scanned_quantities || {}) as {
      per_variant?: Record<string, { units: number; cases: number }>
    }
    const scannedAt = session.created_at || new Date().toISOString()

    const details: ScannedCodeDetail[] = []

    // Process master codes: product/variant come from the case's own unit codes
    // (qr_codes.master_code_id -> qr_codes.variant_id), never from the batch.
    if (masterCodes.length > 0) {
      type MasterRow = {
        id: string
        master_code: string
        case_number: number | null
        actual_unit_count: number | null
        expected_unit_count: number | null
      }
      const masters: MasterRow[] = []
      const variantIdsByMaster = new Map<string, Set<string>>()
      const variantsById = new Map<string, VariantDetail>()

      try {
        for (const codes of chunk(Array.from(new Set(masterCodes)))) {
          masters.push(...await readAllPages<MasterRow>((from, to) =>
            supabase
              .from('qr_master_codes')
              .select('id, master_code, case_number, actual_unit_count, expected_unit_count')
              .in('master_code', codes)
              .order('id', { ascending: true })
              .range(from, to)
          ))
        }

        for (const ids of chunk(masters.map(master => master.id))) {
          const units = await readAllPages<{ master_code_id: string | null; variant_id: string | null }>((from, to) =>
            supabase
              .from('qr_codes')
              .select('id, master_code_id, variant_id')
              .in('master_code_id', ids)
              .eq('is_buffer', false)
              .order('id', { ascending: true })
              .range(from, to)
          )
          for (const unit of units) {
            if (!unit.master_code_id || !unit.variant_id) continue
            const variantIds = variantIdsByMaster.get(unit.master_code_id) ?? new Set<string>()
            variantIds.add(unit.variant_id)
            variantIdsByMaster.set(unit.master_code_id, variantIds)
          }
        }

        const allVariantIds = Array.from(new Set(Array.from(variantIdsByMaster.values()).flatMap(ids => Array.from(ids))))
        for (const ids of chunk(allVariantIds)) {
          const { data: variants, error: variantError } = await supabase
            .from('product_variants')
            .select('id, variant_name, image_url, products!inner ( product_name )')
            .in('id', ids)
          if (variantError) throw variantError
          for (const variant of (variants || []) as VariantDetail[]) variantsById.set(variant.id, variant)
        }
      } catch (masterError) {
        console.error('❌ Failed to load scanned master cases:', masterError)
        return NextResponse.json({ error: 'Failed to load scanned master cases' }, { status: 500 })
      }

      for (const master of masters) {
        const variantIds = Array.from(variantIdsByMaster.get(master.id) ?? []).sort()
        const variantStatus: MasterVariantStatus =
          variantIds.length === 0 ? 'missing' : variantIds.length === 1 ? 'single' : 'mixed'
        const variant = variantStatus === 'single' ? variantsById.get(variantIds[0]) : undefined
        const productNames = new Set(variantIds.map(id => productNameOf(variantsById.get(id))))

        details.push({
          code: master.master_code,
          codeType: 'master',
          // A mixed case still names its product when every variant shares it.
          productName: productNames.size === 1 ? Array.from(productNames)[0] : null,
          variantName: variant?.variant_name || `Case ${master.case_number || '?'}`,
          variantId: variantStatus === 'single' ? variantIds[0] : null,
          imageUrl: variant?.image_url || null,
          quantity: master.actual_unit_count || master.expected_unit_count || 0,
          scannedAt,
          variantStatus,
          ...(variantStatus === 'mixed' ? { variantIds } : {})
        })
      }
    }

    // Process unique codes
    if (uniqueCodes.length > 0) {
      const { data: uniqueData, error: uniqueError } = await supabase
        .from('qr_codes')
        .select(`
          code,
          variant_id,
          product_variants!inner (
            variant_name,
            image_url,
            products!inner (
              product_name
            )
          )
        `)
        .in('code', uniqueCodes)

      if (uniqueError) {
        console.error('❌ Failed to load scanned unique codes:', uniqueError)
        return NextResponse.json({ error: 'Failed to load scanned unique codes' }, { status: 500 })
      }

      for (const unique of uniqueData || []) {
        const variant = unique.product_variants
        const variantObj = Array.isArray(variant) ? variant[0] : variant
        const product = variantObj?.products
        const productObj = Array.isArray(product) ? product[0] : product

        details.push({
          code: unique.code,
          codeType: 'unique',
          productName: productObj?.product_name || null,
          variantName: variantObj?.variant_name || null,
          variantId: unique.variant_id || null,
          imageUrl: variantObj?.image_url || null,
          quantity: 1,
          scannedAt
        })
      }
    }

    return NextResponse.json({
      session_id: sessionId,
      scanned_codes: details,
      summary: {
        total_master: masterCodes.length,
        total_unique: uniqueCodes.length,
        total_codes: details.length,
        per_variant: scannedQuantities.per_variant || {}
      }
    })
  } catch (error: any) {
    console.error('❌ Failed to fetch scanned codes:', error)
    return NextResponse.json(
      { error: 'Failed to fetch scanned codes' },
      { status: 500 }
    )
  }
}
