'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  SeraModalOverlay,
  SeraModalPanel,
  SeraModalHeader,
  SeraModalBody,
  SeraModalFooter,
} from '@/components/ui/sera-modal'
import {
  X,
  Loader2,
  Plus,
  Star,
  Film,
  ImageIcon,
} from 'lucide-react'
import { getStorageUrl } from '@/lib/utils'
import {
  PRODUCT_CODE_MAX_LENGTH,
  PRODUCT_CODE_VALIDATION_UNAVAILABLE_MESSAGE,
  normalizeProductCode,
  validateProductCode,
} from '@/lib/products/product-code'
import { retailPriceError } from '@/lib/storefront/price-rules'
import { cleanAlternativeName } from '@/lib/products/alternative-name'
import VariantStockConfigurationsPanel from '@/components/products/VariantStockConfigurationsPanel'
import KkmApprovalCertificate from '@/components/products/KkmApprovalCertificate'
import { isCelleraVapeVariant } from '@/lib/inventory/cellera-variant'
import AdditionalAttributesEditor from '@/components/products/AdditionalAttributesEditor'
import {
  isRawHexVariantName,
  suggestVariantName,
  validateStructuredAttributes,
  type StructuredAttribute,
} from '@/lib/products/structured-attributes'

// ── Types ────────────────────────────────────────────────────────

interface Product {
  id: string
  product_name: string
  is_active?: boolean
  is_vape?: boolean
  product_code?: string | null
}

export interface MediaItem {
  id: string
  type: 'image' | 'video'
  url: string
  thumbnailUrl?: string | null
  file?: File | null
  thumbnailFile?: Blob | null
  isDefault: boolean
  dbId?: string | null
  mimeType?: string
  fileSize?: number
  durationMs?: number | null
}

export interface Variant {
  id?: string
  product_id: string
  variant_code?: string
  variant_name: string
  alternative_name: string | null
  attributes: Record<string, any>
  structured_attributes?: StructuredAttribute[]
  barcode: string | null
  product_code: string | null
  manufacturer_sku: string | null
  manual_sku: string | null
  base_cost: number | null
  suggested_retail_price: number | null
  retailer_price?: number | null
  distributor_price?: number | null
  other_price?: number | null
  /** Units the website may still sell; null = no limit. */
  online_stock_allocation?: number | null
  is_active: boolean
  is_default: boolean
  image_url?: string | null
  additional_images?: string[] | null
  animation_url?: string | null
  media?: MediaItem[]
}

interface VariantDialogProps {
  variant: Variant | null
  products: Product[]
  open: boolean
  isSaving: boolean
  onOpenChange: (open: boolean) => void
  onSave: (data: Partial<Variant> & { mediaItems?: MediaItem[]; certificateFile?: File | null }) => void
  canManageStockConfigurations?: boolean
  canManageCertificates?: boolean
  colourReferenceClient?: any
}

const MAX_MEDIA = 10
const MAX_IMAGE_SIZE = 5 * 1024 * 1024
const MAX_VIDEO_SIZE = 50 * 1024 * 1024
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
const ACCEPTED_VIDEO_TYPES = ['video/mp4', 'video/webm']
const ALL_ACCEPTED = [...ACCEPTED_IMAGE_TYPES, ...ACCEPTED_VIDEO_TYPES]

function isVideoType(mime: string) {
  return ACCEPTED_VIDEO_TYPES.includes(mime)
}

function compressImage(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(file)
    reader.onload = (event) => {
      const img = new Image()
      img.src = event.target?.result as string
      img.onload = () => {
        const canvas = document.createElement('canvas')
        let w = img.width, h = img.height
        const MAX = 400
        if (w > h) { if (w > MAX) { h = Math.round((h * MAX) / w); w = MAX } }
        else { if (h > MAX) { w = Math.round((w * MAX) / h); h = MAX } }
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d')?.drawImage(img, 0, 0, w, h)
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error('compress failed'))
            resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg', lastModified: Date.now() }))
          },
          'image/jpeg',
          0.75,
        )
      }
      img.onerror = () => reject(new Error('Image load failed'))
    }
    reader.onerror = () => reject(new Error('File read failed'))
  })
}

function captureVideoThumbnail(file: File): Promise<{ blob: Blob; url: string; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    const objectUrl = URL.createObjectURL(file)
    video.src = objectUrl
    video.onloadeddata = () => { video.currentTime = Math.min(video.duration * 0.25, 2) }
    video.onseeked = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.min(video.videoWidth, 400)
      canvas.height = Math.round((canvas.width / video.videoWidth) * video.videoHeight)
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(
        (blob) => {
          const durationMs = Math.round(video.duration * 1000)
          URL.revokeObjectURL(objectUrl)
          if (!blob) return reject(new Error('Thumbnail capture failed'))
          resolve({ blob, url: URL.createObjectURL(blob), durationMs })
        },
        'image/jpeg',
        0.8,
      )
    }
    video.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Video load failed')) }
  })
}

export default function VariantDialog({
  variant,
  products,
  open,
  isSaving,
  onOpenChange,
  onSave,
  canManageStockConfigurations = false,
  canManageCertificates = false,
  colourReferenceClient,
}: VariantDialogProps) {
  const mkInitial = useCallback(
    (): Partial<Variant> =>
      variant
        ? {
            product_id: variant.product_id || (products.length === 1 ? products[0].id : ''),
            variant_name: variant.variant_name || '',
            alternative_name: variant.alternative_name || '',
            attributes: variant.attributes || {},
            barcode: variant.barcode || '',
            product_code: variant.product_code || '',
            manufacturer_sku: variant.manufacturer_sku || '',
            manual_sku: variant.manual_sku || '',
            base_cost: variant.base_cost,
            suggested_retail_price: variant.suggested_retail_price,
            retailer_price: variant.retailer_price,
            distributor_price: variant.distributor_price,
            other_price: variant.other_price,
            online_stock_allocation: variant.online_stock_allocation ?? null,
            is_active: variant.is_active !== false,
            is_default: variant.is_default || false,
          }
        : {
            product_id: products.length > 0 ? products[0].id : '',
            variant_name: '',
            alternative_name: '',
            attributes: {},
            barcode: '',
            product_code: '',
            manufacturer_sku: '',
            manual_sku: '',
            base_cost: null,
            suggested_retail_price: null,
            retailer_price: null,
            distributor_price: null,
            other_price: null,
            online_stock_allocation: null,
            is_active: true,
            is_default: false,
          },
    [variant, products],
  )

  const [formData, setFormData] = useState<Partial<Variant>>(mkInitial)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [isValidatingProductCode, setIsValidatingProductCode] = useState(false)
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([])
  const [configurationProfile, setConfigurationProfile] = useState<'new_standard' | 'transition'>('new_standard')
  const [certificateFile, setCertificateFile] = useState<File | null>(null)
  const [structuredAttributes, setStructuredAttributes] = useState<StructuredAttribute[]>(variant?.structured_attributes || [])
  const [attributeSaveAttempted, setAttributeSaveAttempted] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setFormData(mkInitial())
    setErrors({})
    setConfigurationProfile('new_standard')
    setCertificateFile(null)
    setStructuredAttributes(variant?.structured_attributes || [])
    setAttributeSaveAttempted(false)
    const items: MediaItem[] = []
    if (variant?.media && variant.media.length > 0) {
      items.push(...variant.media.map((m) => ({ ...m, file: null, thumbnailFile: null })))
    } else {
      if (variant?.image_url) {
        items.push({ id: `legacy-img-${Date.now()}`, type: 'image' as const, url: getStorageUrl(variant.image_url) || variant.image_url, isDefault: true, dbId: null, file: null })
      }
      if (variant?.animation_url) {
        items.push({ id: `legacy-vid-${Date.now()}`, type: 'video' as const, url: getStorageUrl(variant.animation_url) || variant.animation_url, thumbnailUrl: null, isDefault: items.length === 0, dbId: null, file: null })
      }
    }
    setMediaItems(items)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, variant, products])

  const selectedProduct = products.find((p) => p.id === (formData.product_id || variant?.product_id)) || null
  const isVapeCategory = selectedProduct?.is_vape === true
  const isNewCelleraVariant = !variant && isCelleraVapeVariant(selectedProduct)
  const variantNameSuggestion = suggestVariantName(structuredAttributes)

  const generateBarcode = useCallback(() => {
    if (!formData.product_id || !formData.variant_name) return ''
    const product = products.find((p) => p.id === formData.product_id)
    const pc = product ? product.product_name.substring(0, 3).toUpperCase() : 'PRD'
    const vc = formData.variant_name.substring(0, 2).toUpperCase()
    return `${pc}${vc}${Date.now().toString().slice(-5)}`
  }, [formData.product_id, formData.variant_name, products])

  const generateSKU = useCallback(() => {
    if (!formData.product_id || !formData.variant_name) return ''
    const product = products.find((p) => p.id === formData.product_id)
    const pc = product ? product.product_name.substring(0, 3).toUpperCase() : 'PRD'
    const vc = formData.variant_name.substring(0, 3).toUpperCase()
    return `SKU-${pc}-${vc}-${Date.now().toString().slice(-4)}`
  }, [formData.product_id, formData.variant_name, products])

  const generateVariantCode = useCallback(() => {
    const nc = formData.variant_name?.substring(0, 3).toUpperCase() || 'VAR'
    return `${nc}-${Date.now().toString().slice(-6)}`
  }, [formData.variant_name])

  useEffect(() => {
    if (formData.variant_name && formData.product_id && !variant) {
      setFormData((p) => ({ ...p, barcode: generateBarcode(), manufacturer_sku: generateSKU() }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.product_id, formData.variant_name, variant])

  const validate = (): boolean => {
    setAttributeSaveAttempted(true)
    const e: Record<string, string> = {}
    if (!(formData.product_id || variant?.product_id)) e.product_id = 'Product is required'
    if (!formData.variant_name?.trim()) e.variant_name = 'Name is required'
    const nameChanged = formData.variant_name?.trim() !== variant?.variant_name?.trim()
    if (formData.variant_name && isRawHexVariantName(formData.variant_name) && (!variant || nameChanged)) {
      e.variant_name = 'Use a readable Variant Name (for example, Black) and store the hex under Colour Hex.'
    }
    if (!validateStructuredAttributes(structuredAttributes).isValid) e.attributes = 'Please fix the Additional Attributes errors.'
    const productCodeError = validateProductCode(formData.product_code)
    if (productCodeError) e.product_code = productCodeError
    const priceError = retailPriceError(formData.suggested_retail_price)
    if (priceError) e.suggested_retail_price = priceError
    const allocation = formData.online_stock_allocation
    if (allocation != null && (!Number.isInteger(allocation) || allocation < 0)) {
      e.online_stock_allocation = 'Enter a whole number of 0 or more, or leave it blank for no limit.'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleAddMedia = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    const remaining = MAX_MEDIA - mediaItems.length
    if (remaining <= 0) { setErrors((p) => ({ ...p, media: `Maximum ${MAX_MEDIA} media items allowed` })); return }
    const toProcess = Array.from(files).slice(0, remaining)
    const newItems: MediaItem[] = []
    for (const file of toProcess) {
      const isVideo = isVideoType(file.type)
      if (!ALL_ACCEPTED.includes(file.type)) { setErrors((p) => ({ ...p, media: `Unsupported type: ${file.type}` })); continue }
      if (file.type === 'image/avif') { setErrors((p) => ({ ...p, media: 'AVIF not supported.' })); continue }
      if (isVideo && file.size > MAX_VIDEO_SIZE) { setErrors((p) => ({ ...p, media: 'Video must be under 50 MB' })); continue }
      if (!isVideo && file.size > MAX_IMAGE_SIZE) { setErrors((p) => ({ ...p, media: 'Image must be under 5 MB' })); continue }
      try {
        if (isVideo) {
          const { blob: thumbBlob, url: thumbUrl, durationMs } = await captureVideoThumbnail(file)
          newItems.push({ id: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`, type: 'video', url: URL.createObjectURL(file), thumbnailUrl: thumbUrl, file, thumbnailFile: thumbBlob, isDefault: false, mimeType: file.type, fileSize: file.size, durationMs })
        } else {
          const compressed = await compressImage(file)
          newItems.push({ id: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`, type: 'image', url: URL.createObjectURL(compressed), file: compressed, isDefault: false, mimeType: compressed.type, fileSize: compressed.size })
        }
        setErrors((p) => ({ ...p, media: '' }))
      } catch (err) {
        console.error('Media processing error:', err)
        setErrors((p) => ({ ...p, media: 'Failed to process file.' }))
      }
    }
    if (newItems.length > 0) {
      setMediaItems((prev) => {
        const merged = [...prev, ...newItems]
        if (!merged.some((m) => m.isDefault)) merged[0].isDefault = true
        return merged
      })
    }
    if (e.target) e.target.value = ''
  }

  const handleRemoveMedia = (id: string) => {
    setMediaItems((prev) => {
      const filtered = prev.filter((m) => m.id !== id)
      if (filtered.length > 0 && !filtered.some((m) => m.isDefault)) filtered[0].isDefault = true
      return filtered
    })
  }

  const handleSetDefault = (id: string) => {
    setMediaItems((prev) => prev.map((m) => ({ ...m, isDefault: m.id === id })))
  }

  const handleMoveMedia = (index: number, direction: -1 | 1) => {
    setMediaItems((prev) => {
      const next = [...prev]
      const target = index + direction
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const handleSubmit = async () => {
    if (!validate()) return
    const finalProductId = formData.product_id || variant?.product_id || ''
    const productCode = normalizeProductCode(formData.product_code)
    const alternativeName = cleanAlternativeName(formData.alternative_name)

    setIsValidatingProductCode(true)
    try {
      const response = await fetch('/api/product-variants/validate-product-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: finalProductId,
          productCode,
          alternativeName,
          variantId: variant?.id,
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        setErrors((previous) => ({
          ...previous,
          [result.field === 'alternative_name' ? 'alternative_name' : 'product_code']:
            result.error || PRODUCT_CODE_VALIDATION_UNAVAILABLE_MESSAGE,
        }))
        return
      }
    } catch {
      setErrors((previous) => ({
        ...previous,
        product_code: PRODUCT_CODE_VALIDATION_UNAVAILABLE_MESSAGE,
      }))
      return
    } finally {
      setIsValidatingProductCode(false)
    }

    onSave({
      ...formData,
      product_id: finalProductId,
      product_code: productCode,
      alternative_name: alternativeName,
      variant_code: variant?.variant_code || generateVariantCode(),
      barcode: variant ? formData.barcode : generateBarcode(),
      structured_attributes: structuredAttributes,
      mediaItems: mediaItems.map((m, i) => ({ ...m, sort_order: i } as any)),
      ...(certificateFile ? { certificateFile } : {}),
      ...(isNewCelleraVariant ? { configurationProfile } : {}),
    } as any)
  }

  if (!open) return null

  return (
    <SeraModalOverlay>
      <SeraModalPanel className="overflow-y-auto">
        <SeraModalHeader
          sticky
          title={variant ? 'Edit Variant' : 'Add Variant'}
          onClose={() => !(isSaving || isValidatingProductCode) && onOpenChange(false)}
        />

        <SeraModalBody className="space-y-5">
          {/* Unified Variant Media */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Variant Media <span className="font-normal text-[var(--sera-muted)]">(Up to {MAX_MEDIA} — images &amp; videos)</span></Label>
            <div className="flex flex-wrap gap-3">
              {mediaItems.map((item, idx) => (
                <div key={item.id} className="relative group">
                  <div className={`w-20 h-20 rounded-lg border-2 overflow-hidden ${item.isDefault ? 'border-[var(--sera-orange)] ring-2 ring-[var(--sera-orange)]/30' : 'border-[var(--sera-line)]'}`}>
                    {item.type === 'video' ? (
                      <video src={item.url} className="w-full h-full object-cover" muted loop autoPlay playsInline />
                    ) : (
                      <img src={item.url} alt={`Media ${idx + 1}`} className="w-full h-full object-cover" />
                    )}
                  </div>
                  <span className={`absolute bottom-0.5 left-0.5 text-[9px] font-bold uppercase px-1 py-[1px] rounded flex items-center gap-0.5 ${item.type === 'video' ? 'bg-purple-600 text-white' : 'bg-emerald-600 text-white'}`}>
                    {item.type === 'video' ? <><Film className="w-2.5 h-2.5" /> Vid</> : <><ImageIcon className="w-2.5 h-2.5" /> Img</>}
                  </span>
                  {item.isDefault && <div className="absolute -top-1 -right-1 bg-[var(--sera-orange)] text-white text-[10px] px-1.5 py-0.5 rounded-full">Default</div>}
                  <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center gap-1">
                    {idx > 0 && <button type="button" onClick={() => handleMoveMedia(idx, -1)} className="p-1 bg-white/90 rounded-full hover:bg-white text-gray-700" title="Move left"><span className="text-[10px] font-bold">←</span></button>}
                    {!item.isDefault && <button type="button" onClick={() => handleSetDefault(item.id)} className="p-1.5 bg-white/90 rounded-full hover:bg-white text-[var(--sera-orange)]" title="Set as default"><Star className="w-3.5 h-3.5" /></button>}
                    <button type="button" onClick={() => handleRemoveMedia(item.id)} className="p-1.5 bg-white/90 rounded-full hover:bg-white text-red-600" title="Remove"><X className="w-3.5 h-3.5" /></button>
                    {idx < mediaItems.length - 1 && <button type="button" onClick={() => handleMoveMedia(idx, 1)} className="p-1 bg-white/90 rounded-full hover:bg-white text-gray-700" title="Move right"><span className="text-[10px] font-bold">→</span></button>}
                  </div>
                </div>
              ))}
              {mediaItems.length < MAX_MEDIA && (
                <button type="button" onClick={() => fileInputRef.current?.click()} className="w-20 h-20 rounded-lg border-2 border-dashed border-[var(--sera-line)] hover:border-[var(--sera-orange)] hover:bg-[var(--sera-orange)]/[0.06] transition-colors flex flex-col items-center justify-center gap-1 text-[var(--sera-muted)] hover:text-[var(--sera-orange)]">
                  <Plus className="w-5 h-5" /><span className="text-[10px]">Add</span>
                </button>
              )}
            </div>
            <input ref={fileInputRef} type="file" accept={ALL_ACCEPTED.join(',')} onChange={handleAddMedia} multiple className="hidden" />
            <p className="text-xs text-gray-500">Images: PNG, JPG, GIF ≤ 5 MB · Videos: MP4, WebM ≤ 50 MB (8–15s recommended) · {mediaItems.length}/{MAX_MEDIA}</p>
            {errors.media && <p className="text-xs text-red-500">{errors.media}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="product">Product *</Label>
            <select id="product" value={formData.product_id || variant?.product_id || ''} onChange={(e) => { setFormData((p) => ({ ...p, product_id: e.target.value })); if (errors.product_id) setErrors((p) => ({ ...p, product_id: '' })) }} className={`w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.product_id ? 'border-red-500' : ''}`}>
              <option value="">Select a product</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.product_name}</option>)}
            </select>
            {errors.product_id && <p className="text-xs text-red-500">{errors.product_id}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Variant Name *</Label>
            <Input id="name" placeholder="e.g., Strawberry - 6mg" value={formData.variant_name || ''} onChange={(e) => { setFormData((p) => ({ ...p, variant_name: e.target.value })); if (errors.variant_name) setErrors((p) => ({ ...p, variant_name: '' })) }} className={errors.variant_name ? 'border-red-500' : ''} />
            {errors.variant_name && <p className="text-xs text-red-500">{errors.variant_name}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="alternative_name">Alternative Name <span className="text-xs text-gray-500">(Optional)</span></Label>
            <Input
              id="alternative_name"
              placeholder="e.g. Banana Vanilla"
              value={formData.alternative_name || ''}
              onChange={(event) => {
                setFormData((previous) => ({ ...previous, alternative_name: event.target.value }))
                if (errors.alternative_name) setErrors((previous) => ({ ...previous, alternative_name: '' }))
              }}
              className={errors.alternative_name ? 'border-red-500' : ''}
            />
            <p className="text-xs text-gray-500">Alternative name commonly used by distributors.</p>
            {errors.alternative_name && <p className="text-xs text-red-500">{errors.alternative_name}</p>}
          </div>

          <AdditionalAttributesEditor
            value={structuredAttributes}
            onChange={(attributes) => {
              setStructuredAttributes(attributes)
              if (errors.attributes) setErrors((current) => ({ ...current, attributes: '' }))
            }}
            disabled={isSaving || isValidatingProductCode}
            showValidationErrors={attributeSaveAttempted}
            colourReferenceClient={colourReferenceClient}
          />
          {errors.attributes && <p className="text-xs text-red-500">{errors.attributes}</p>}

          {variantNameSuggestion && variantNameSuggestion !== formData.variant_name?.trim() && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
              <span>Suggested Variant Name: <strong>{variantNameSuggestion}</strong></span>
              <Button type="button" variant="outline" size="sm" onClick={() => setFormData((current) => ({ ...current, variant_name: variantNameSuggestion }))} disabled={isSaving || isValidatingProductCode}>Use suggestion</Button>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="barcode">Barcode <span className="text-xs text-gray-500">(Auto-generated)</span></Label>
            <Input id="barcode" value={formData.barcode || ''} readOnly className="bg-gray-100 cursor-not-allowed text-gray-700" />
            <p className="text-xs text-gray-500">Automatically generated from product and variant name</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="product_code">Product Code <span className="text-xs text-gray-500">(Optional, 5 chars max)</span></Label>
            <Input
              id="product_code"
              value={formData.product_code || ''}
              onChange={(event) => {
                setFormData((previous) => ({ ...previous, product_code: event.target.value.toUpperCase() }))
                if (errors.product_code) setErrors((previous) => ({ ...previous, product_code: '' }))
              }}
              onBlur={() => setFormData((previous) => ({ ...previous, product_code: normalizeProductCode(previous.product_code) || '' }))}
              maxLength={PRODUCT_CODE_MAX_LENGTH}
              placeholder="Enter product code"
              className={`uppercase ${errors.product_code ? 'border-red-500' : ''}`}
              aria-invalid={Boolean(errors.product_code)}
              aria-describedby={errors.product_code ? 'product_code_error' : undefined}
            />
            {errors.product_code && <p id="product_code_error" className="text-xs text-red-500">{errors.product_code}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sku">Manufacturer SKU <span className="text-xs text-gray-500">(Auto-generated)</span></Label>
            <Input id="sku" value={formData.manufacturer_sku || ''} readOnly className="bg-gray-100 cursor-not-allowed text-gray-700" />
          </div>

          {isVapeCategory && (
            <>
              <div className="space-y-2">
                <Label htmlFor="manual_sku">KKM Approval <span className="text-xs text-gray-500">(Optional)</span></Label>
                <Input
                  id="manual_sku"
                  value={formData.manual_sku || ''}
                  onChange={(event) => setFormData((previous) => ({ ...previous, manual_sku: event.target.value }))}
                  placeholder="Enter KKM approval/reference number"
                />
              </div>
              <KkmApprovalCertificate
                variantId={variant?.id}
                canManage={canManageCertificates}
                pendingFile={certificateFile}
                onPendingFileChange={setCertificateFile}
                kkmApproval={formData.manual_sku}
              />
            </>
          )}

          {variant?.id ? (
            <VariantStockConfigurationsPanel
              variantId={variant.id}
              product={selectedProduct}
              canManage={canManageStockConfigurations}
            />
          ) : null}

          {isNewCelleraVariant ? (
            <div className="space-y-2 rounded-lg border border-[var(--sera-orange)]/20 bg-[var(--sera-orange)]/[0.06] p-4">
              <Label className="text-sm font-semibold">Stock Configuration Setup Profile</Label>
              <p className="text-xs text-slate-600">Choose how this Cellera flavour's inventory stock configurations are set up once created.</p>
              <RadioGroup value={configurationProfile} onValueChange={(value) => setConfigurationProfile(value as 'new_standard' | 'transition')} className="space-y-2">
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="new_standard" id="profile-new-standard" className="mt-1" />
                  <Label htmlFor="profile-new-standard" className="font-normal cursor-pointer">
                    <span className="font-medium">New Standard Product</span> — 20 mg New Box only (default)
                  </Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="transition" id="profile-transition" className="mt-1" />
                  <Label htmlFor="profile-transition" className="font-normal cursor-pointer">
                    <span className="font-medium">Existing / Transition Product</span> — 20 mg New Box, 50 mg New Box, and 50 mg Old Box
                  </Label>
                </div>
              </RadioGroup>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="baseCost">Base Cost (RM)</Label>
              <div className="flex items-center"><span className="text-gray-600 mr-2">RM</span><Input id="baseCost" type="number" step="0.01" placeholder="0.00" value={formData.base_cost ?? ''} onChange={(e) => setFormData((p) => ({ ...p, base_cost: e.target.value ? parseFloat(e.target.value) : null }))} className="flex-1" /></div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="retailPrice">Retail Price (RM)</Label>
              <div className="flex items-center"><span className="text-gray-600 mr-2">RM</span><Input id="retailPrice" type="number" step="0.01" placeholder="0.00" value={formData.suggested_retail_price ?? ''} onChange={(e) => { setFormData((p) => ({ ...p, suggested_retail_price: e.target.value ? parseFloat(e.target.value) : null })); if (errors.suggested_retail_price) setErrors((p) => ({ ...p, suggested_retail_price: '' })) }} className={`flex-1 ${errors.suggested_retail_price ? 'border-red-500' : ''}`} aria-invalid={Boolean(errors.suggested_retail_price)} /></div>
              {errors.suggested_retail_price && <p className="text-xs text-red-500">{errors.suggested_retail_price}</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="retailerPrice">Retailer Price (RM)</Label>
              <div className="flex items-center"><span className="text-gray-600 mr-2">RM</span><Input id="retailerPrice" type="number" step="0.01" placeholder="0.00" value={formData.retailer_price ?? ''} onChange={(e) => setFormData((p) => ({ ...p, retailer_price: e.target.value ? parseFloat(e.target.value) : null }))} className="flex-1" /></div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="distributorPrice">Distributor Price (RM)</Label>
              <div className="flex items-center"><span className="text-gray-600 mr-2">RM</span><Input id="distributorPrice" type="number" step="0.01" placeholder="0.00" value={formData.distributor_price ?? ''} onChange={(e) => setFormData((p) => ({ ...p, distributor_price: e.target.value ? parseFloat(e.target.value) : null }))} className="flex-1" /></div>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="otherPrice">Promo Price (RM)</Label>
            <div className="flex items-center"><span className="text-gray-600 mr-2">RM</span><Input id="otherPrice" type="number" step="0.01" placeholder="0.00" value={formData.other_price ?? ''} onChange={(e) => setFormData((p) => ({ ...p, other_price: e.target.value ? parseFloat(e.target.value) : null }))} className="flex-1" /></div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="onlineStockAllocation">Online Stock Limit (website)</Label>
            <Input
              id="onlineStockAllocation"
              type="number"
              step="1"
              min="0"
              placeholder="No limit"
              value={formData.online_stock_allocation ?? ''}
              onChange={(e) => {
                setFormData((p) => ({ ...p, online_stock_allocation: e.target.value === '' ? null : Number(e.target.value) }))
                if (errors.online_stock_allocation) setErrors((p) => ({ ...p, online_stock_allocation: '' }))
              }}
              className={errors.online_stock_allocation ? 'border-red-500' : ''}
              aria-invalid={Boolean(errors.online_stock_allocation)}
            />
            <p className="text-xs text-gray-500">
              How many the website may still sell. It goes down as website orders ship. Leave blank to sell all stock in the shop&apos;s warehouse. Warehouse stock is not changed.
            </p>
            {errors.online_stock_allocation && <p className="text-xs text-red-500">{errors.online_stock_allocation}</p>}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="is_default" checked={formData.is_default || false} onCheckedChange={(checked) => setFormData((p) => ({ ...p, is_default: Boolean(checked) }))} />
            <Label htmlFor="is_default" className="font-normal cursor-pointer">Set as Default Variant</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="is_active" checked={formData.is_active !== false} onCheckedChange={(checked) => setFormData((p) => ({ ...p, is_active: Boolean(checked) }))} />
            <Label htmlFor="is_active" className="font-normal cursor-pointer">Active</Label>
          </div>
        </SeraModalBody>

        <SeraModalFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving || isValidatingProductCode}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isSaving || isValidatingProductCode} className="bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white">
            {isSaving || isValidatingProductCode ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{isSaving ? 'Saving...' : 'Validating...'}</> : 'Save'}
          </Button>
        </SeraModalFooter>
      </SeraModalPanel>
    </SeraModalOverlay>
  )
}
