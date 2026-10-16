'use client'

import { useState, useEffect } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { getStorageUrl } from '@/lib/utils'
import { 
  Package, 
  Search, 
  ShoppingCart, 
  Grid3x3,
  List,
  Eye,
  Plus,
  Minus,
  X,
  Check,
  ArrowRight,
  Tag,
  TrendingUp,
  Box,
  ShoppingBag
} from 'lucide-react'
import SupplyChainPageHeader from '@/modules/supply-chain/components/SupplyChainPageHeader'
import { useNavAccess } from '@/hooks/useNavAccess'
import { productCatalogHome } from '@/lib/security-access/nav-access'

interface Product {
  id: string
  product_code: string
  product_name: string
  product_description: string | null
  is_active: boolean
  brand_name?: string
  category_name?: string
  manufacturer_name?: string
  primary_image_url?: string | null
  variants?: Variant[]
  hide_price?: boolean
  hide_product?: boolean
}

interface Variant {
  id: string
  product_id: string
  variant_name: string
  manufacturer_sku: string | null
  barcode: string | null
  attributes: Record<string, any>
  base_cost: number | null
  suggested_retail_price: number | null
  is_active: boolean
  is_default: boolean
  image_url?: string | null
}

interface CartItem {
  variant: Variant
  product: Product
  quantity: number
  units_per_case: number
}

interface ProductCatalogViewProps {
  userProfile: {
    id: string
    organization_id: string | null
    organizations: {
      id: string
      org_name: string
      org_type_code: string
    } | null
    roles: {
      role_level: number
    }
  }
  onViewChange: (view: string) => void
}

export default function ProductCatalogView({ userProfile, onViewChange }: ProductCatalogViewProps) {
  const [products, setProducts] = useState<Product[]>([])
  const [filteredProducts, setFilteredProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')

  const { isReady, supabase } = useSupabaseAuth()
  // The module that offers the catalog for this person (shared page, one home); blank until the answers are ready.
  const catalogHome = productCatalogHome(useNavAccess().snapshot)
  const catalogEyebrow = catalogHome === 'supply-chain' ? 'Supply Chain' : catalogHome === 'customer-growth' ? 'Customer & Growth' : ''
  const { toast } = useToast()

  // Check if user is independent (no organization)
  const isIndependentUser = !userProfile.organization_id || !userProfile.organizations

  useEffect(() => {
    if (isReady) {
      loadProducts()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  useEffect(() => {
    filterProducts()
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, categoryFilter, products])

  const loadProducts = async () => {
    try {
      setLoading(true)
      
      const { data, error } = await supabase
        .from('products')
        .select(`
          id,
          product_code,
          product_name,
          product_description,
          is_active,
          brands (brand_name),
          product_categories (category_name),
          product_groups (
            hide_price,
            hide_product
          ),
          product_images (
            image_url,
            is_primary
          ),
          product_variants (
            id,
            variant_name,
            suggested_retail_price,
            is_active
          )
        `)
        .eq('is_active', true)
        .order('product_name')

      if (error) throw error

      const transformedProducts = (data || []).map((item: any) => {
        // Handle both array and object responses from Supabase
        const groupData = Array.isArray(item.product_groups) 
          ? item.product_groups[0] 
          : item.product_groups
        
        return {
          ...item,
          brand_name: item.brands?.brand_name || 'No Brand',
          category_name: item.product_categories?.category_name || 'Uncategorized',
          primary_image_url: item.product_images?.find((img: any) => img.is_primary)?.image_url || 
                            item.product_images?.[0]?.image_url || null,
          variants: (item.product_variants || []).filter((v: any) => v.is_active),
          hide_price: groupData?.hide_price === true,
          hide_product: groupData?.hide_product === true
        }
      })

      // Filter out products from groups marked as hidden
      const visibleProducts = transformedProducts.filter((p: Product) => !p.hide_product)

      setProducts(visibleProducts)
      setFilteredProducts(visibleProducts)
    } catch (error: any) {
      console.error('Error loading products:', error)
      toast({
        title: 'Error',
        description: 'Failed to load products',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  const filterProducts = () => {
    let filtered = [...products]

    if (searchQuery) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(p => 
        p.product_name.toLowerCase().includes(query) ||
        p.product_code.toLowerCase().includes(query) ||
        p.brand_name?.toLowerCase().includes(query)
      )
    }

    if (categoryFilter && categoryFilter !== 'all') {
      filtered = filtered.filter(p => p.category_name === categoryFilter)
    }

    setFilteredProducts(filtered)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Package className="h-12 w-12 text-gray-400 mx-auto animate-pulse" />
          <p className="mt-4 text-gray-600">Loading product catalog...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="sera-sc-page sera-page-enter">
      <SupplyChainPageHeader
        eyebrow={catalogEyebrow}
        title="Product Catalog"
        description={
          isIndependentUser
            ? 'Browse products from our extensive catalog'
            : 'Browse and order products from our extensive catalog'
        }
        actions={
          <div className="inline-flex rounded-lg border border-[var(--sera-line)] bg-[var(--sera-mist)] p-1">
            <span className="px-4 py-2 text-sm font-medium rounded-md bg-white text-[var(--sera-ink)] shadow-sm border border-[var(--sera-line)]">
              Storefront Catalog
            </span>
            <a
              href="/engagement/product-catalog/roadtour"
              className="px-4 py-2 text-sm font-medium rounded-md text-[var(--sera-muted)] hover:text-[var(--sera-ink)]"
            >
              RoadTour Catalog
            </a>
          </div>
        }
      />

      {/* Info Banner - Only show for users with organization */}
      {!isIndependentUser && (
      <div className="sera-sc-panel p-5 border-[var(--sera-orange)]/20 bg-[var(--sera-orange)]/5">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-[var(--sera-orange)] rounded-lg">
              <ShoppingCart className="h-5 w-5 text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-[var(--sera-ink)]">Quick Ordering</h3>
              <p className="text-sm text-[var(--sera-muted)] mt-1">
                Click &quot;Order Now&quot; on any product to be taken to the order creation page where you can select variants, quantities, and complete your order.
              </p>
            </div>
          </div>
      </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
        <div className="sera-sc-kpi">
          <p className="sera-sc-kpi__label">Total Products</p>
          <p className="sera-sc-kpi__value">{filteredProducts.length}</p>
        </div>
      </div>

      {/* Filters & Search */}
      <Card className="sera-sc-panel border-0 shadow-none">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="md:col-span-2 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="Search products..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            <div className="flex gap-2">
              <Button
                variant={viewMode === 'grid' ? 'default' : 'outline'}
                size="icon"
                onClick={() => setViewMode('grid')}
              >
                <Grid3x3 className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === 'list' ? 'default' : 'outline'}
                size="icon"
                onClick={() => setViewMode('list')}
              >
                <List className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Products Grid */}
      {filteredProducts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Box className="h-16 w-16 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-600">No products found</p>
          </CardContent>
        </Card>
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {filteredProducts.map(product => (
            <Card key={product.id} className="group hover:shadow-xl transition-all duration-300">
              <div 
                className="relative h-48 bg-gradient-to-br from-gray-100 to-gray-200 overflow-hidden cursor-pointer"
                onClick={() => {
                  sessionStorage.setItem('selectedProductId', product.id)
                  onViewChange('view-product')
                }}
              >
                {product.primary_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img 
                    src={getStorageUrl(product.primary_image_url) || product.primary_image_url} 
                    alt={product.product_name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Package className="h-20 w-20 text-gray-400" />
                  </div>
                )}
                {product.variants && product.variants.length > 0 && (
                  <Badge className="absolute top-2 right-2 bg-blue-600">
                    {product.variants.length} Variants
                  </Badge>
                )}
              </div>
              
              <CardContent className="pt-4">
                <div className="space-y-2">
                  <h3 
                    className="font-semibold text-gray-900 line-clamp-2 min-h-[3rem] cursor-pointer hover:text-blue-600 transition-colors"
                    onClick={() => {
                      sessionStorage.setItem('selectedProductId', product.id)
                      onViewChange('view-product')
                    }}
                  >
                    {product.product_name}
                  </h3>
                  
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {product.brand_name}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">
                      {product.category_name}
                    </Badge>
                  </div>

                  {product.variants && product.variants.length > 0 && !product.hide_price && (
                    <div className="pt-2">
                      <p className="text-sm text-gray-600">Starting from</p>
                      <p className="text-2xl font-bold text-purple-600">
                        ${Math.min(...product.variants.map(v => v.suggested_retail_price || 0)).toFixed(2)}
                      </p>
                    </div>
                  )}

                  {!product.hide_price && !isIndependentUser && (
                  <Button
                    className="w-full mt-4 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
                    onClick={() => {
                      // Navigate to create order view
                      sessionStorage.setItem('preselectedProduct', JSON.stringify({
                        product_id: product.id,
                        product_name: product.product_name,
                        variants: product.variants
                      }))
                      onViewChange('create-order')
                    }}
                  >
                    <ShoppingCart className="h-4 w-4 mr-2" />
                    Order Now
                  </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {filteredProducts.map(product => (
                <div key={product.id} className="p-6 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-6">
                    <div 
                      className="w-24 h-24 bg-gray-100 rounded-lg flex items-center justify-center overflow-hidden cursor-pointer hover:ring-2 hover:ring-blue-500 transition-all"
                      onClick={() => {
                        sessionStorage.setItem('selectedProductId', product.id)
                        onViewChange('view-product')
                      }}
                    >
                      {product.primary_image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img 
                          src={getStorageUrl(product.primary_image_url) || product.primary_image_url} 
                          alt={product.product_name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <Package className="h-10 w-10 text-gray-400" />
                      )}
                    </div>

                    <div className="flex-1">
                      <h3 
                        className="font-semibold text-lg text-gray-900 cursor-pointer hover:text-blue-600 transition-colors"
                        onClick={() => {
                          sessionStorage.setItem('selectedProductId', product.id)
                          onViewChange('view-product')
                        }}
                      >
                        {product.product_name}
                      </h3>
                      <p className="text-sm text-gray-600 mt-1">
                        {product.product_description || 'No description available'}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <Badge variant="outline">{product.brand_name}</Badge>
                        <Badge variant="secondary">{product.category_name}</Badge>
                      </div>
                    </div>

                    <div className="text-right">
                      {product.variants && product.variants.length > 0 && !product.hide_price && (
                        <>
                          <p className="text-sm text-gray-600">Starting from</p>
                          <p className="text-2xl font-bold text-purple-600">
                            ${Math.min(...product.variants.map(v => v.suggested_retail_price || 0)).toFixed(2)}
                          </p>
                        </>
                      )}
                      {!product.hide_price && !isIndependentUser && (
                      <Button
                        className="mt-4"
                        onClick={() => {
                          // Navigate to create order view
                          sessionStorage.setItem('preselectedProduct', JSON.stringify({
                            product_id: product.id,
                            product_name: product.product_name,
                            variants: product.variants
                          }))
                          onViewChange('create-order')
                        }}
                      >
                        <ShoppingCart className="h-4 w-4 mr-2" />
                        Order Now
                      </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
