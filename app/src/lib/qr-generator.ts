/**
 * QR Code Generator Utility
 * Generates unique QR code strings for products and master cases
 * NOW WITH SECURITY: Includes HMAC-SHA256 hash to prevent sequential guessing
 */

import { generateSecureQRCode, generateQRHash } from './security/qr-hash'
import { qrBufferCases } from './orders/qr-buffer'

/**
 * Generate unique QR code string for individual products
 * Format (with hash): PROD-{product_code}-{variant_code}-{order_no}-{sequence}-{hash}
 * Example: PROD-VAPE001-MINT-ORD-HM-1025-11-00001-a3f9c8d2e1b4
 */
export function generateProductQRCode(
  productCode: string,
  variantCode: string,
  orderNo: string,
  sequence: number,
  withHash: boolean = true
): string {
  const paddedSequence = String(sequence).padStart(5, '0')
  const baseCode = `PROD-${productCode}-${variantCode}-${orderNo}-${paddedSequence}`

  // Add security hash to prevent sequential code guessing
  if (withHash) {
    return generateSecureQRCode(baseCode)
  }

  return baseCode
}

/**
 * Generate unique Master QR code string for cases/boxes
 * Format (with hash): MASTER-{order_no}-CASE-{case_number}-{hash}
 * Example: MASTER-ORD-HM-1025-11-CASE-001-b8e4d7a9f2c1
 */
export function generateMasterQRCode(
  orderNo: string,
  caseNumber: number,
  withHash: boolean = true
): string {
  const paddedCaseNumber = String(caseNumber).padStart(3, '0')
  const baseCode = `MASTER-${orderNo}-CASE-${paddedCaseNumber}`

  // Add security hash
  if (withHash) {
    return generateSecureQRCode(baseCode)
  }

  return baseCode
}

/**
 * Batch generate QR codes for all items in an order
 */
export interface QRCodeGenerationParams {
  orderNo: string
  manufacturerCode?: string  // NEW: Manufacturer org code for variant_key
  orderItems: Array<{
    product_id: string
    variant_id: string
    product_code: string
    variant_code: string
    product_name: string
    variant_name: string
    qty: number
    units_per_case?: number  // Individual case size for this product
  }>
  bufferPercent: number
  unitsPerCase: number  // Default case size (fallback)
  useIndividualCaseSizes?: boolean  // Whether to use individual case sizes
}

export interface GeneratedQRCode {
  code: string
  hash: string  // NEW: Security hash
  sequence_number: number
  product_id: string
  variant_id: string
  product_code: string
  variant_code: string
  product_name: string
  variant_name: string
  case_number: number
  is_buffer: boolean  // NEW: Flag for buffer codes
  variant_key: string  // NEW: PROD-{product_code}-{variant_code} for grouping
  units_per_case?: number  // Units per case for this product
}

export interface GeneratedMasterCode {
  code: string
  hash: string  // NEW: Security hash
  case_number: number
  expected_unit_count: number
}

export interface QRBatchResult {
  masterCodes: GeneratedMasterCode[]
  individualCodes: GeneratedQRCode[]
  totalMasterCodes: number
  totalUniqueCodes: number
  totalBaseUnits: number
  bufferPercent: number
}

/**
 * Generate complete QR batch for an order
 * Buffer QR codes are NOT assigned to master cases - they're spares for damaged/lost codes
 */
export function generateQRBatch(params: QRCodeGenerationParams): QRBatchResult {
  const { orderNo, manufacturerCode, orderItems, bufferPercent, unitsPerCase, useIndividualCaseSizes } = params

  // Calculate total base units (actual order quantity)
  const totalBaseUnits = orderItems.reduce((sum, item) => sum + item.qty, 0)

  // Calculate buffer quantity (extra codes for damaged/lost QR codes):
  // floor(ordered cases × percent ÷ 100), the shared rule in lib/orders/qr-buffer
  const bufferQuantity = qrBufferCases(totalBaseUnits, bufferPercent)

  // Total unique codes = base units + buffer
  const totalUniqueCodes = totalBaseUnits + bufferQuantity

  // Case packing logic depends on whether using individual case sizes
  let totalMasterCodes: number
  let casePacking: Array<{ caseNumber: number; expectedCount: number; items: Array<{ item: any; qty: number }> }> = []

  if (useIndividualCaseSizes) {
    // Individual case sizes: Pack each product into full cases, then mix remainders
    const remainders: Array<{ item: any; qty: number }> = []
    let caseNumber = 1

    // First pass: Pack full cases for each product
    for (const item of orderItems) {
      const itemCaseSize = item.units_per_case || unitsPerCase
      const fullCases = Math.floor(item.qty / itemCaseSize)
      const remainder = item.qty % itemCaseSize

      // Generate full cases
      for (let i = 0; i < fullCases; i++) {
        casePacking.push({
          caseNumber: caseNumber++,
          expectedCount: itemCaseSize,
          items: [{ item, qty: itemCaseSize }]
        })
      }

      // Collect remainder
      if (remainder > 0) {
        remainders.push({ item, qty: remainder })
      }
    }

    // Second pass: Mix remainders into shared cases (using 200 units/case for mixed cases)
    const mixedCaseSize = 200
    let currentMixedCase: Array<{ item: any; qty: number }> = []
    let currentMixedCaseQty = 0

    for (const { item, qty } of remainders) {
      let remainingQty = qty

      while (remainingQty > 0) {
        const spaceInCurrentCase = mixedCaseSize - currentMixedCaseQty
        const qtyToAdd = Math.min(remainingQty, spaceInCurrentCase)

        currentMixedCase.push({ item, qty: qtyToAdd })
        currentMixedCaseQty += qtyToAdd
        remainingQty -= qtyToAdd

        // If case is full, add it to packing
        if (currentMixedCaseQty >= mixedCaseSize) {
          casePacking.push({
            caseNumber: caseNumber++,
            expectedCount: currentMixedCaseQty,
            items: [...currentMixedCase]
          })
          currentMixedCase = []
          currentMixedCaseQty = 0
        }
      }
    }

    // Add final mixed case if not empty
    if (currentMixedCase.length > 0) {
      casePacking.push({
        caseNumber: caseNumber++,
        expectedCount: currentMixedCaseQty,
        items: [...currentMixedCase]
      })
    }

    totalMasterCodes = casePacking.length
  } else {
    // Standard mode: Use single case size for all products
    totalMasterCodes = Math.ceil(totalBaseUnits / unitsPerCase)

    // Create simple case packing
    let remainingUnits = totalBaseUnits
    for (let i = 1; i <= totalMasterCodes; i++) {
      const expectedCount = Math.min(unitsPerCase, remainingUnits)
      casePacking.push({
        caseNumber: i,
        expectedCount,
        items: [] // Will be filled during individual code generation
      })
      remainingUnits -= expectedCount
    }
  }

  // Generate Master QR codes based on case packing
  const masterCodes: GeneratedMasterCode[] = []
  for (const caseInfo of casePacking) {
    const secureCode = generateMasterQRCode(orderNo, caseInfo.caseNumber, true)
    const hash = generateQRHash(secureCode.split('-').slice(0, -1).join('-'))

    masterCodes.push({
      code: secureCode,
      hash: hash,
      case_number: caseInfo.caseNumber,
      expected_unit_count: caseInfo.expectedCount
    })
  }

  // Generate individual QR codes based on case packing
  const individualCodes: GeneratedQRCode[] = []
  let globalSequence = 1

  if (useIndividualCaseSizes) {
    // Use the pre-calculated case packing
    for (const caseInfo of casePacking) {
      for (const { item, qty } of caseInfo.items) {
        const variantKey = manufacturerCode
          ? `PROD-${item.product_code}-${item.variant_code}-${manufacturerCode}`
          : `PROD-${item.product_code}-${item.variant_code}`

        for (let i = 0; i < qty; i++) {
          const secureCode = generateProductQRCode(
            item.product_code,
            item.variant_code,
            orderNo,
            globalSequence,
            true
          )
          const hash = generateQRHash(secureCode.split('-').slice(0, -1).join('-'))

          individualCodes.push({
            code: secureCode,
            hash: hash,
            sequence_number: globalSequence,
            product_id: item.product_id,
            variant_id: item.variant_id,
            product_code: item.product_code,
            variant_code: item.variant_code,
            product_name: item.product_name,
            variant_name: item.variant_name,
            case_number: caseInfo.caseNumber,
            is_buffer: false,
            variant_key: variantKey,
            units_per_case: item.units_per_case || unitsPerCase
          })

          globalSequence++
        }
      }
    }
  } else {
    // Standard mode: Pack sequentially
    let currentCaseNumber = 1
    let codesInCurrentCase = 0

    for (const item of orderItems) {
      const variantKey = manufacturerCode
        ? `PROD-${item.product_code}-${item.variant_code}-${manufacturerCode}`
        : `PROD-${item.product_code}-${item.variant_code}`

      for (let i = 0; i < item.qty; i++) {
        // Move to next case if current is full
        if (codesInCurrentCase >= unitsPerCase && currentCaseNumber < totalMasterCodes) {
          currentCaseNumber++
          codesInCurrentCase = 0
        }

        const secureCode = generateProductQRCode(
          item.product_code,
          item.variant_code,
          orderNo,
          globalSequence,
          true
        )
        const hash = generateQRHash(secureCode.split('-').slice(0, -1).join('-'))

        individualCodes.push({
          code: secureCode,
          hash: hash,
          sequence_number: globalSequence,
          product_id: item.product_id,
          variant_id: item.variant_id,
          product_code: item.product_code,
          variant_code: item.variant_code,
          product_name: item.product_name,
          variant_name: item.variant_name,
          case_number: currentCaseNumber,
          is_buffer: false,
          variant_key: variantKey,
          units_per_case: item.units_per_case || unitsPerCase
        })

        globalSequence++
        codesInCurrentCase++
      }
    }
  }

  // Then, generate buffer codes - NOT assigned to any case
  // Buffer codes are spare QR codes for damaged/lost codes, not part of production cases
  let remainingBuffer = bufferQuantity
  const totalQty = totalBaseUnits

  for (const item of orderItems) {
    // Build variant_key: PROD-{product_code}-{variant_code}-{manufacturer_code}
    const variantKey = manufacturerCode
      ? `PROD-${item.product_code}-${item.variant_code}-${manufacturerCode}`
      : `PROD-${item.product_code}-${item.variant_code}`

    // Calculate this item's share of buffer codes proportionally
    const itemBufferQty = Math.floor((item.qty / totalQty) * bufferQuantity)
    const actualItemBuffer = Math.min(itemBufferQty, remainingBuffer)

    for (let i = 0; i < actualItemBuffer; i++) {
      const secureCode = generateProductQRCode(
        item.product_code,
        item.variant_code,
        orderNo,
        globalSequence,
        true
      )
      const hash = generateQRHash(secureCode.split('-').slice(0, -1).join('-'))

      individualCodes.push({
        code: secureCode,
        hash: hash,
        sequence_number: globalSequence,
        product_id: item.product_id,
        variant_id: item.variant_id,
        product_code: item.product_code,
        variant_code: item.variant_code,
        product_name: item.product_name,
        variant_name: item.variant_name,
        case_number: 0, // Buffer codes not assigned to any case (0 will be converted to null in Excel)
        is_buffer: true,  // Mark as buffer code
        variant_key: variantKey,
        units_per_case: item.units_per_case || unitsPerCase
      })

      globalSequence++
      remainingBuffer--
    }
  }

  // Distribute any remaining buffer codes using first item's details
  if (remainingBuffer > 0 && orderItems.length > 0) {
    const firstItem = orderItems[0]
    const variantKey = manufacturerCode
      ? `PROD-${firstItem.product_code}-${firstItem.variant_code}-${manufacturerCode}`
      : `PROD-${firstItem.product_code}-${firstItem.variant_code}`

    for (let i = 0; i < remainingBuffer; i++) {
      const secureCode = generateProductQRCode(
        firstItem.product_code,
        firstItem.variant_code,
        orderNo,
        globalSequence,
        true
      )
      const hash = generateQRHash(secureCode.split('-').slice(0, -1).join('-'))

      individualCodes.push({
        code: secureCode,
        hash: hash,
        sequence_number: globalSequence,
        product_id: firstItem.product_id,
        variant_id: firstItem.variant_id,
        product_code: firstItem.product_code,
        variant_code: firstItem.variant_code,
        product_name: firstItem.product_name,
        variant_name: firstItem.variant_name,
        case_number: 0, // Buffer codes not assigned to any case (0 will be converted to null in Excel)
        is_buffer: true,  // Mark as buffer code
        variant_key: variantKey,
        units_per_case: firstItem.units_per_case || unitsPerCase
      })

      globalSequence++
    }
  }

  return {
    masterCodes,
    individualCodes,
    totalMasterCodes,
    totalUniqueCodes,
    totalBaseUnits,
    bufferPercent
  }
}

/**
 * Validate QR code format
 */
export function validateQRCodeFormat(code: string): boolean {
  // Product QR: PROD-{code}-{variant}-{order}-{seq}
  const productPattern = /^PROD-[A-Z0-9\-]+-[A-Z0-9\-]+-ORD-[A-Z]{2}-\d{4}-\d{2}-\d{5}$/

  // Master QR: MASTER-{order}-CASE-{num}
  const masterPattern = /^MASTER-ORD-[A-Z]{2}-\d{4}-\d{2}-CASE-\d{3}$/

  return productPattern.test(code) || masterPattern.test(code)
}

/**
 * Parse QR code to extract information
 */
export interface ParsedQRCode {
  type: 'product' | 'master'
  orderNo?: string
  productCode?: string
  variantCode?: string
  sequence?: number
  caseNumber?: number
}

export function parseQRCode(code: string): ParsedQRCode | null {
  if (!validateQRCodeFormat(code)) {
    return null
  }

  // Parse product QR code
  if (code.startsWith('PROD-')) {
    const parts = code.split('-')
    // PROD-{product}-{variant}-ORD-{type}-{yymm}-{seq}-{itemseq}
    return {
      type: 'product',
      productCode: parts[1],
      variantCode: parts[2],
      orderNo: `${parts[3]}-${parts[4]}-${parts[5]}-${parts[6]}`,
      sequence: parseInt(parts[7], 10)
    }
  }

  // Parse master QR code
  if (code.startsWith('MASTER-')) {
    const parts = code.split('-')
    // MASTER-ORD-{type}-{yymm}-{seq}-CASE-{num}
    return {
      type: 'master',
      orderNo: `${parts[1]}-${parts[2]}-${parts[3]}-${parts[4]}`,
      caseNumber: parseInt(parts[6], 10)
    }
  }

  return null
}
