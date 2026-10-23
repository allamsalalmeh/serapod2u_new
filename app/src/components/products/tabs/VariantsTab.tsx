'use client'

import { useState, useEffect } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { useToast } from '@/components/ui/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Edit, Trash2, Search, Loader2, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import VariantDialog, { type MediaItem } from '../dialogs/VariantDialog'
import { getStorageUrl } from '@/lib/utils'
import {
  PRODUCT_CODE_DUPLICATE_MESSAGE,
  isProductCodeDuplicateError,
  normalizeProductCode,
} from '@/lib/products/product-code'
import {
  ALTERNATIVE_NAME_DUPLICATE_MESSAGE,
  cleanAlternativeName,
  isAlternativeNameDuplicateError,
} from '@/lib/products/alternative-name'
import {
  buildVariantMasterDataFilename,
  exportVariantMasterDataBlob,
  matchesVariantSearch,
} from '@/lib/products/variant-master-data'
import { uploadKkmCertificate } from '@/lib/products/kkm-certificate'
import {
  VariantArchiveRefreshError,
  archiveProductVariantAndRefresh,
  variantArchiveSuccessDescription,
} from '@/lib/products/variant-deletion'
import { syncStructuredAttributes, type StructuredAttribute } from '@/lib/products/structured-attributes'

interface Product {
  id: string
  product_name: string
  is_active?: boolean
  is_vape?: boolean
  product_code?: string | null
}

interface Variant {
  id: string
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
  retailer_price: number | null
  distributor_price: number | null
  other_price: number | null
  online_stock_allocation?: number | null
  is_active: boolean
  is_default: boolean
  created_at: string
  product_name?: string
  image_url?: string | null
  additional_images?: string[] | null
  animation_url?: string | null
  media?: MediaItem[]
}

interface VariantsTabProps {
  userProfile: any
  onRefresh: () => void
  refreshTrigger: number
}

export default function VariantsTab({ userProfile, onRefresh, refreshTrigger }: VariantsTabProps) {
  const [variants, setVariants] = useState<Variant[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedProduct, setSelectedProduct] = useState<string>('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingVariant, setEditingVariant] = useState<Variant | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [archivingVariantId, setArchivingVariantId] = useState<string | null>(null)
  const [sortColumn, setSortColumn] = useState<string>('variant_name')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage] = useState(20)

  const { isReady, supabase } = useSupabaseAuth()
  const { toast } = useToast()

  useEffect(() => {
    if (isReady) {
      loadProducts()
      loadVariants()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, refreshTrigger])

  const loadProducts = async () => {
    try {
      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, is_active, product_code, product_categories(is_vape)')
        .order('product_name', { ascending: true })

      if (error) throw error
      const productRows = (data || []).map((product: any) => ({
        id: product.id,
        product_name: product.product_name,
        is_active: product.is_active,
        product_code: product.product_code,
        // Product-category Vape classification is the source of truth for KKM fields.
        is_vape: Array.isArray(product.product_categories)
          ? product.product_categories[0]?.is_vape === true
          : product.product_categories?.is_vape === true,
      }))
      setProducts(productRows)
      if (data && data.length > 0 && !selectedProduct) {
        setSelectedProduct(productRows[0].id)
      }
    } catch (error) {
      console.error('Error loading products:', error)
    }
  }

  const loadVariants = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('product_variants')
        .select('*, products(product_name), product_attributes(id, attribute_name, attribute_value, attribute_type, unit_of_measure, attribute_group, is_searchable, is_filterable, display_order), variant_media(id, type, url, thumbnail_url, sort_order, is_default, file_size, mime_type, duration_ms)')
        .order('variant_name', { ascending: true })

      if (error) throw error
      const variantsData = (data || []).map((variant: any) => {
        const rawMedia = variant.variant_media || []
        const media: MediaItem[] = rawMedia
          .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
          .map((m: any) => ({
            id: m.id,
            type: m.type as 'image' | 'video',
            url: getStorageUrl(m.url) || m.url,
            thumbnailUrl: m.thumbnail_url ? (getStorageUrl(m.thumbnail_url) || m.thumbnail_url) : null,
            isDefault: m.is_default || false,
            dbId: m.id,
            file: null,
            fileSize: m.file_size,
            mimeType: m.mime_type,
            durationMs: m.duration_ms,
          }))

        return {
          ...variant,
          product_name: variant.products?.product_name || '-',
          image_url: variant.image_url || null,
          animation_url: variant.animation_url || null,
          media,
          structured_attributes: (variant.product_attributes || [])
            .sort((a: any, b: any) => (a.display_order ?? 0) - (b.display_order ?? 0)),
          product_attributes: undefined,
          variant_media: undefined,
          products: undefined,
        }
      })
      setVariants(variantsData as Variant[])
      return true
    } catch (error) {
      console.error('Error loading variants:', error)
      toast({
        title: 'Error',
        description: 'Failed to load variants',
        variant: 'destructive'
      })
      return false
    } finally {
      setLoading(false)
    }
  }

  const getVariantInitials = (name: string) => {
    if (!name) return 'V'
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
  }

  // Upload a single media file to storage, return the path
  const uploadMediaFile = async (file: File, prefix: string): Promise<string> => {
    const ext = file.name.split('.').pop() || 'bin'
    const fileName = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(fileName, file, { contentType: file.type, cacheControl: '3600', upsert: false })
    if (uploadError) throw uploadError
    return uploadData.path
  }

  const handleSave = async (variantData: Partial<Variant> & { mediaItems?: MediaItem[]; certificateFile?: File | null }) => {
    try {
      setIsSaving(true)
      const mediaItems = variantData.mediaItems || []

      // ── Upload new media files ───────────────────────
      const uploadedMedia: Array<{
        type: 'image' | 'video'
        url: string
        thumbnail_url: string | null
        sort_order: number
        is_default: boolean
        file_size: number | null
        mime_type: string | null
        duration_ms: number | null
      }> = []

      for (let i = 0; i < mediaItems.length; i++) {
        const item = mediaItems[i]
        let storagePath: string
        let thumbPath: string | null = null

        if (item.file) {
          // New file — upload it
          storagePath = await uploadMediaFile(item.file, item.type === 'video' ? 'variant-vid' : 'variant-img')
          // Upload thumbnail for videos
          if (item.thumbnailFile) {
            thumbPath = await uploadMediaFile(
              new File([item.thumbnailFile], 'thumb.jpg', { type: 'image/jpeg' }),
              'variant-thumb'
            )
          }
        } else if (item.dbId) {
          // Existing row — keep original storage path
          storagePath = item.url
          thumbPath = item.thumbnailUrl || null
        } else {
          // Legacy item (from image_url/animation_url) — keep URL as-is
          storagePath = item.url
          thumbPath = item.thumbnailUrl || null
        }

        uploadedMedia.push({
          type: item.type,
          url: storagePath,
          thumbnail_url: thumbPath,
          sort_order: i,
          is_default: item.isDefault,
          file_size: item.fileSize || null,
          mime_type: item.mimeType || null,
          duration_ms: item.durationMs || null,
        })
      }

      // ── Determine backward-compat image_url / animation_url ──
      const defaultMedia = uploadedMedia.find(m => m.is_default) || uploadedMedia[0]
      let imageUrl: string | null = null
      let animationUrl: string | null = null
      if (defaultMedia) {
        if (defaultMedia.type === 'image') {
          imageUrl = defaultMedia.url
        } else {
          animationUrl = defaultMedia.url
          imageUrl = defaultMedia.thumbnail_url || null
        }
      }
      if (!imageUrl) {
        const firstImage = uploadedMedia.find(m => m.type === 'image')
        if (firstImage) imageUrl = firstImage.url
      }

      // ── Build DB save data ───────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { mediaItems: _mi, certificateFile: _cf, structured_attributes: structuredAttributes = [], imageFile: _if, animationFile: _af, imageFiles: _ifs, existingImageUrls: _eu, defaultImageIndex: _di, media: _m, ...dbDataClean } = variantData as any

      const productId = dbDataClean.product_id || (editingVariant ? editingVariant.product_id : null)
      const variantName = dbDataClean.variant_name || (editingVariant ? editingVariant.variant_name : null)

      if (!productId) throw new Error('Product is required.')
      if (!variantName) throw new Error('Variant name is required.')

      const dataToSave: Record<string, any> = {
        variant_name: variantName,
        alternative_name: cleanAlternativeName(dbDataClean.alternative_name),
        attributes: dbDataClean.attributes || {},
        barcode: dbDataClean.barcode || null,
        product_code: normalizeProductCode(dbDataClean.product_code),
        manufacturer_sku: dbDataClean.manufacturer_sku || null,
        manual_sku: dbDataClean.manual_sku || null,
        base_cost: dbDataClean.base_cost,
        suggested_retail_price: dbDataClean.suggested_retail_price,
        retailer_price: dbDataClean.retailer_price,
        distributor_price: dbDataClean.distributor_price,
        other_price: dbDataClean.other_price,
        is_active: dbDataClean.is_active !== false,
        is_default: dbDataClean.is_default || false,
        image_url: imageUrl,
        animation_url: animationUrl,
      }

      if (!editingVariant) {
        dataToSave.product_id = productId
        dataToSave.variant_code = dbDataClean.variant_code || `VAR-${Date.now().toString().slice(-6)}`
      }

      // Written only when changed: website shipments lower it while the dialog is open.
      const allocation = dbDataClean.online_stock_allocation ?? null
      if (allocation !== (editingVariant?.online_stock_allocation ?? null)) {
        dataToSave.online_stock_allocation = allocation
      }

      let variantId: string

      if (editingVariant) {
        variantId = editingVariant.id
        const { error } = await (supabase as any).from('product_variants').update(dataToSave).eq('id', variantId)
        if (error) throw error
      } else {
        const { data: inserted, error } = await (supabase as any).from('product_variants').insert([dataToSave]).select('id').single()
        if (error) throw error
        variantId = inserted.id
        if (dbDataClean.configurationProfile) {
          try {
            const response = await fetch(`/api/inventory/stock-configurations/variant/${variantId}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ profile: dbDataClean.configurationProfile }),
            })
            if (!response.ok) {
              const body = await response.json().catch(() => ({}))
              toast({ title: 'Stock configuration setup warning', description: body.error || 'Variant created, but the configuration profile could not be applied automatically. Enable it manually from Edit Variant.', variant: 'destructive' })
            }
          } catch {
            toast({ title: 'Stock configuration setup warning', description: 'Variant created, but the configuration profile could not be applied automatically. Enable it manually from Edit Variant.', variant: 'destructive' })
          }
        }
      }

      await syncStructuredAttributes(supabase, { variantId }, structuredAttributes)

      // ── Sync variant_media rows ──────────────────────
      await (supabase as any).from('variant_media').delete().eq('variant_id', variantId)

      if (uploadedMedia.length > 0) {
        const mediaRows = uploadedMedia.map((m) => ({
          variant_id: variantId,
          type: m.type,
          url: m.url,
          thumbnail_url: m.thumbnail_url,
          sort_order: m.sort_order,
          is_default: m.is_default,
          file_size: m.file_size,
          mime_type: m.mime_type,
          duration_ms: m.duration_ms,
        }))
        const { error: mediaError } = await (supabase as any).from('variant_media').insert(mediaRows)
        if (mediaError) {
          console.error('variant_media insert error:', mediaError)
          toast({ title: 'Warning', description: 'Variant saved but media sync failed. Media may need to be re-added.' })
        }
      }

      if (variantData.certificateFile) {
        try {
          await uploadKkmCertificate(supabase, variantId, variantData.certificateFile)
        } catch (certificateError: any) {
          toast({
            title: 'Variant saved; certificate upload failed',
            description: certificateError?.message || 'Open Edit Variant to retry the certificate upload.',
            variant: 'destructive',
          })
        }
      }

      toast({
        title: 'Success',
        description: editingVariant ? 'Variant updated successfully' : 'Variant created successfully'
      })
      setDialogOpen(false)
      setEditingVariant(null)
      loadVariants()
    } catch (error: any) {
      console.error('Error saving variant:', error)
      let errorMessage = 'Failed to save variant'
      if (isProductCodeDuplicateError(error)) {
        errorMessage = PRODUCT_CODE_DUPLICATE_MESSAGE
      } else if (isAlternativeNameDuplicateError(error)) {
        errorMessage = ALTERNATIVE_NAME_DUPLICATE_MESSAGE
      } else {
        if (error?.message) errorMessage = error.message
        if (error?.details) errorMessage += ': ' + error.details
      }
      toast({ title: 'Error', description: errorMessage, variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Archive this variant? It will be hidden from new operations while inventory and transaction history remain unchanged.')) return
    setArchivingVariantId(id)
    try {
      const result = await archiveProductVariantAndRefresh(supabase as any, id, loadVariants)
      toast({ title: 'Variant Archived', description: variantArchiveSuccessDescription(result) })
    } catch (error: any) {
      console.error('Error archiving variant:', error)
      toast({
        title: error instanceof VariantArchiveRefreshError ? 'Variant archived; refresh failed' : 'Variant archive failed',
        description: error?.message || 'The variant was not archived. No success was recorded.',
        variant: 'destructive',
      })
    } finally {
      setArchivingVariantId(null)
    }
  }

  const filteredVariants = variants.filter(variant => {
    const matchesSearch = matchesVariantSearch(variant, searchQuery)
    const matchesProduct = !selectedProduct || variant.product_id === selectedProduct
    return matchesSearch && matchesProduct && variant.is_active
  })

  useEffect(() => { setCurrentPage(1) }, [searchQuery, selectedProduct])

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column)
      setSortDirection('asc')
    }
  }

  const getSortedVariants = () => {
    const sorted = [...filteredVariants].sort((a, b) => {
      let aValue: any = a[sortColumn as keyof Variant]
      let bValue: any = b[sortColumn as keyof Variant]
      if (typeof aValue === 'string') {
        aValue = aValue.toLowerCase()
        bValue = (bValue as string).toLowerCase()
        return sortDirection === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue)
      }
      if (typeof aValue === 'boolean') { aValue = aValue ? 1 : 0; bValue = bValue ? 1 : 0 }
      return sortDirection === 'asc' ? (aValue || 0) - (bValue || 0) : (bValue || 0) - (aValue || 0)
    })
    return sorted
  }

  const handleExport = async () => {
    setIsExporting(true)
    try {
      // This is the complete filtered/sorted dataset, intentionally before pagination.
      const blob = await exportVariantMasterDataBlob(getSortedVariants())
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = buildVariantMasterDataFilename()
      anchor.click()
      URL.revokeObjectURL(url)
      toast({ title: 'Excel downloaded', description: `${getSortedVariants().length} variant(s) exported.` })
    } catch (error: any) {
      toast({ title: 'Excel export failed', description: error?.message || 'Please try again.', variant: 'destructive' })
    } finally {
      setIsExporting(false)
    }
  }

  const totalItems = getSortedVariants().length
  const totalPages = Math.ceil(totalItems / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const paginatedVariants = getSortedVariants().slice(startIndex, endIndex)

  const renderSortIcon = (column: string) => {
    if (sortColumn !== column) return <ArrowUpDown className="w-4 h-4 opacity-40" />
    return sortDirection === 'asc' ? <ArrowDown className="w-4 h-4" /> : <ArrowUp className="w-4 h-4" />
  }

  const getPreviewMedia = (variant: Variant) => {
    if (variant.media && variant.media.length > 0) {
      const def = variant.media.find(m => m.isDefault) || variant.media[0]
      return def
    }
    if (variant.animation_url) return { type: 'video' as const, url: getStorageUrl(variant.animation_url) || variant.animation_url }
    if (variant.image_url) return { type: 'image' as const, url: getStorageUrl(variant.image_url) || variant.image_url }
    return null
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 text-[var(--sera-orange)] animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-1">
          <select
            value={selectedProduct}
            onChange={(e) => setSelectedProduct(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]"
          >
            <option value="">All Products</option>
            {products.map(product => (
              <option key={product.id} value={product.id}>{product.product_name}</option>
            ))}
          </select>
          <div className="flex-1 max-w-md relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="Search variants..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleExport} disabled={isExporting}>
            {isExporting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />} Download Excel
          </Button>
          <Button onClick={() => { setEditingVariant(null); setDialogOpen(true) }} className="bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)]">
            <Plus className="w-4 h-4 mr-2" /> Add Variant
          </Button>
        </div>
      </div>

      <VariantDialog
        key={editingVariant?.id || 'new'}
        variant={editingVariant}
        products={products}
        open={dialogOpen}
        isSaving={isSaving}
        onOpenChange={setDialogOpen}
        onSave={handleSave}
        colourReferenceClient={supabase}
        canManageStockConfigurations={
          userProfile?.organizations?.org_type_code === 'HQ' &&
          [1, 10].includes(Number(userProfile?.roles?.role_level))
        }
        canManageCertificates={
          userProfile?.organizations?.org_type_code === 'HQ' &&
          [1, 10].includes(Number(userProfile?.roles?.role_level))
        }
      />

      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 text-center">#</TableHead>
              <TableHead>Media</TableHead>
              <TableHead className="cursor-pointer hover:bg-gray-100 select-none" onClick={() => handleSort('variant_name')}>
                <div className="flex items-center justify-between gap-2">Name {renderSortIcon('variant_name')}</div>
              </TableHead>
              <TableHead className="cursor-pointer hover:bg-gray-100 select-none" onClick={() => handleSort('product_name')}>
                <div className="flex items-center justify-between gap-2">Product {renderSortIcon('product_name')}</div>
              </TableHead>
              <TableHead className="cursor-pointer hover:bg-gray-100 select-none" onClick={() => handleSort('product_code')}>
                <div className="flex items-center justify-between gap-2">Product Code {renderSortIcon('product_code')}</div>
              </TableHead>
              <TableHead className="text-right cursor-pointer hover:bg-gray-100 select-none" onClick={() => handleSort('base_cost')}>
                <div className="flex items-center justify-end gap-2">Base Cost {renderSortIcon('base_cost')}</div>
              </TableHead>
              <TableHead className="text-right cursor-pointer hover:bg-gray-100 select-none" onClick={() => handleSort('suggested_retail_price')}>
                <div className="flex items-center justify-end gap-2">Retail Price {renderSortIcon('suggested_retail_price')}</div>
              </TableHead>
              <TableHead className="text-right cursor-pointer hover:bg-gray-100 select-none" onClick={() => handleSort('other_price')}>
                <div className="flex items-center justify-end gap-2">Promo Price {renderSortIcon('other_price')}</div>
              </TableHead>
              <TableHead className="text-center cursor-pointer hover:bg-gray-100 select-none" onClick={() => handleSort('is_active')}>
                <div className="flex items-center justify-center gap-2">Status {renderSortIcon('is_active')}</div>
              </TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedVariants.length > 0 ? (
              paginatedVariants.map((variant, index) => {
                const preview = getPreviewMedia(variant)
                return (
                  <TableRow key={variant.id} className="hover:bg-gray-50">
                    <TableCell className="text-center text-sm text-[var(--sera-muted)] font-medium">{startIndex + index + 1}</TableCell>
                    <TableCell>
                      <div className="relative w-10 h-10 rounded-lg overflow-hidden bg-gray-50 border border-gray-100 flex items-center justify-center">
                        {preview ? (
                          preview.type === 'video' ? (
                            <video src={preview.url} className="w-full h-full object-cover" muted loop autoPlay playsInline />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={preview.url} alt={variant.variant_name} className="w-full h-full object-cover" />
                          )
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-blue-50 to-blue-100 text-[var(--sera-orange)] text-xs font-semibold">
                            {getVariantInitials(variant.variant_name)}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      <div>{variant.variant_name}</div>
                      {variant.alternative_name && <div className="mt-0.5 text-xs text-[var(--sera-muted)]">Alternative: {variant.alternative_name}</div>}
                    </TableCell>
                    <TableCell className="text-xs text-[var(--sera-muted)]">{variant.product_name}</TableCell>
                    <TableCell className="text-xs font-medium text-[var(--sera-ink)]/80">{variant.product_code || '-'}</TableCell>
                    <TableCell className="text-right text-xs">{variant.base_cost ? `$${variant.base_cost.toFixed(2)}` : '-'}</TableCell>
                    <TableCell className="text-right text-xs">{variant.suggested_retail_price ? `$${variant.suggested_retail_price.toFixed(2)}` : '-'}</TableCell>
                    <TableCell className="text-right text-xs">{variant.other_price ? `$${variant.other_price.toFixed(2)}` : '-'}</TableCell>
                    <TableCell className="text-center">
                      <Badge variant={variant.is_active ? 'default' : 'secondary'} className="text-xs">
                        {variant.is_active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => { setEditingVariant(variant); setDialogOpen(true) }}>
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(variant.id)}
                          disabled={archivingVariantId === variant.id}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          title="Archive variant"
                        >
                          {archivingVariantId === variant.id
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Trash2 className="w-4 h-4" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            ) : (
              <TableRow>
                <TableCell colSpan={10} className="text-center py-8 text-[var(--sera-muted)]">No variants found</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination Controls */}
      <div className="flex items-center justify-between">
        <div className="text-xs text-[var(--sera-muted)]">
          Showing {totalItems > 0 ? startIndex + 1 : 0} - {Math.min(endIndex, totalItems)} of {totalItems} variants
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))} disabled={currentPage === 1} className="h-8">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                let pageNum: number
                if (totalPages <= 5) { pageNum = i + 1 }
                else if (currentPage <= 3) { pageNum = i + 1 }
                else if (currentPage >= totalPages - 2) { pageNum = totalPages - 4 + i }
                else { pageNum = currentPage - 2 + i }
                return (
                  <Button key={pageNum} variant={currentPage === pageNum ? 'default' : 'outline'} size="sm" onClick={() => setCurrentPage(pageNum)} className="h-8 w-8 p-0">
                    {pageNum}
                  </Button>
                )
              })}
            </div>
            <Button variant="outline" size="sm" onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))} disabled={currentPage === totalPages} className="h-8">
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
