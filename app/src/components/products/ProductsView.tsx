'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { getStorageUrl } from '@/lib/utils'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { 
  Package, 
  Search, 
  Plus, 
  Download, 
  Eye, 
  Edit, 
  Trash2,
  TrendingUp,
  Filter,
  LayoutGrid,
  List
} from 'lucide-react'
import SupplyChainPageHeader from '@/modules/supply-chain/components/SupplyChainPageHeader'
import { MANUFACTURER_PRODUCTS_PARAM } from '@/lib/organizations/manufacturer-categories'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Product {
  id: string
  product_code: string
  product_name: string
  product_description: string | null
  is_vape: boolean
  is_active: boolean
  age_restriction: number | null
  manufacturer_id: string | null
  brands?: {
    brand_name: string
  } | null
  product_categories?: {
    category_name: string
  } | null
  manufacturers?: {
    org_name: string
    org_code: string
  } | null
  product_images?: Array<{
    image_url: string
    is_primary: boolean
  }>
  product_variants?: Array<any>
}

interface ProductsViewProps {
  userProfile: any
  onViewChange?: (view: string) => void
}

export default function ProductsView({ userProfile, onViewChange }: ProductsViewProps) {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [failedImageKeys, setFailedImageKeys] = useState<Record<string, boolean>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [brandFilter, setBrandFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [viewMode, setViewMode] = useState<'card' | 'list'>('list')
  const [currentPage, setCurrentPage] = useState(1)
  const [categories, setCategories] = useState<any[]>([])
  const [brands, setBrands] = useState<any[]>([])
  const [manufacturers, setManufacturers] = useState<any[]>([])
  // "View products" from a manufacturer deep-links here with ?manufacturer=<organization id>.
  const searchParams = useSearchParams()
  const requestedManufacturer = searchParams?.get(MANUFACTURER_PRODUCTS_PARAM) || ''
  const manufacturerParam = UUID_PATTERN.test(requestedManufacturer) ? requestedManufacturer : ''
  const [manufacturerFilter, setManufacturerFilter] = useState(() => manufacturerParam || 'all')
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  
  const { isReady, supabase } = useSupabaseAuth()
  const { toast } = useToast()
  const itemsPerPage = 10

  const resolveProductImageUrl = (imageUrl?: string | null) => {
    const normalizedImageUrl = imageUrl?.trim()

    if (!normalizedImageUrl) return ''
    if (normalizedImageUrl.startsWith('/')) {
      return normalizedImageUrl
    }

    return getStorageUrl(normalizedImageUrl, 'product-images')
  }

  const markImageFailed = (imageKey: string) => {
    setFailedImageKeys((current) => {
      if (current[imageKey]) return current

      return {
        ...current,
        [imageKey]: true
      }
    })
  }

  useEffect(() => {
    if (isReady) {
      fetchProducts()
      fetchCategories()
      fetchManufacturers()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  useEffect(() => {
    setManufacturerFilter(manufacturerParam || 'all')
    setCurrentPage(1)
  }, [manufacturerParam])

  useEffect(() => {
    if (isReady) {
      fetchBrands()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, categoryFilter])

  useEffect(() => {
    if (isReady) {
      fetchProducts()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, categoryFilter, brandFilter, manufacturerFilter, statusFilter, currentPage, sortColumn, sortDirection])

  const fetchProducts = async () => {
    if (!isReady) return
    
    setLoading(true)
    try {
      let query = supabase
        .from('products')
        .select(`
          id,
          product_code,
          product_name,
          product_description,
          is_vape,
          is_active,
          age_restriction,
          brand_id,
          category_id,
          manufacturer_id,
          brands (
            brand_name
          ),
          product_categories (
            category_name
          ),
          manufacturers:organizations!products_manufacturer_id_fkey (
            org_name,
            org_code
          ),
          product_images (
            image_url,
            is_primary
          )
        `)
        .order('created_at', { ascending: false })

      // Filter by manufacturer_id for manufacturers - they can only see their own products
      const orgTypeCode = userProfile?.organizations?.org_type_code
      if (orgTypeCode === 'MANU' || orgTypeCode === 'MFG') {
        query = query.eq('manufacturer_id', userProfile.organization_id)
      }

      // Apply filters
      if (searchQuery) {
        query = query.or(`product_name.ilike.%${searchQuery}%,product_code.ilike.%${searchQuery}%`)
      }

      if (categoryFilter !== 'all') {
        query = query.eq('category_id', categoryFilter)
      }

      if (brandFilter !== 'all') {
        query = query.eq('brand_id', brandFilter)
      }

      if (manufacturerFilter !== 'all') {
        query = query.eq('manufacturer_id', manufacturerFilter)
      }

      if (statusFilter !== 'all') {
        query = query.eq('is_active', statusFilter === 'active')
      }

      // Apply sorting
      if (sortColumn) {
        const ascending = sortDirection === 'asc'
        switch (sortColumn) {
          case 'product_name':
            query = query.order('product_name', { ascending })
            break
          case 'brand':
            query = query.order('brand_id', { ascending })
            break
          case 'category':
            query = query.order('category_id', { ascending })
            break
          case 'manufacturer':
            query = query.order('manufacturer_id', { ascending })
            break
          case 'is_vape':
            query = query.order('is_vape', { ascending })
            break
          case 'status':
            query = query.order('is_active', { ascending })
            break
          default:
            query = query.order('created_at', { ascending: false })
        }
      }

      // Pagination
      const start = (currentPage - 1) * itemsPerPage
      const end = start + itemsPerPage - 1
      query = query.range(start, end)

      const { data, error } = await query

      if (error) throw error
      
      // Transform the data to match our interface
      const transformedData = (data || []).map((item: any) => ({
        ...item,
        brands: Array.isArray(item.brands) ? item.brands[0] : item.brands,
        product_categories: Array.isArray(item.product_categories) ? item.product_categories[0] : item.product_categories,
        manufacturers: Array.isArray(item.manufacturers) ? item.manufacturers[0] : item.manufacturers
      }))
      
      setProducts(transformedData)
    } catch (error) {
      console.error('Error fetching products:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchCategories = async () => {
    try {
      const { data, error } = await supabase
        .from('product_categories')
        .select('id, category_name')
        .eq('is_active', true)
        .order('category_name')

      if (error) throw error
      setCategories(data || [])
    } catch (error) {
      console.error('Error fetching categories:', error)
    }
  }

  const fetchBrands = async () => {
    try {
      if (categoryFilter === 'all') {
        // Fetch all brands
        const { data, error } = await supabase
          .from('brands')
          .select('id, brand_name')
          .eq('is_active', true)
          .order('brand_name')

        if (error) throw error
        setBrands(data || [])
      } else {
        // Fetch brands that have products in the selected category
        const { data, error } = await supabase
          .from('products')
          .select('brand_id, brands(id, brand_name)')
          .eq('category_id', categoryFilter)
          .eq('is_active', true)
          .not('brand_id', 'is', null)

        if (error) throw error
        
        // Extract unique brands
        const uniqueBrands = new Map()
        data?.forEach((item: any) => {
          const brand = Array.isArray(item.brands) ? item.brands[0] : item.brands
          if (brand && brand.id) {
            uniqueBrands.set(brand.id, brand)
          }
        })
        
        setBrands(Array.from(uniqueBrands.values()).sort((a, b) => 
          a.brand_name.localeCompare(b.brand_name)
        ))
      }
    } catch (error) {
      console.error('Error fetching brands:', error)
    }
  }

  const fetchManufacturers = async () => {
    try {
      const { data, error } = await supabase
        .from('organizations')
        .select('id, org_name, org_code')
        .in('org_type_code', ['MANU', 'MFG'])
        .eq('is_active', true)
        .order('org_name')

      if (error) throw error
      const list = data || []
      // Keep a deep-linked manufacturer selectable even when it is inactive.
      if (manufacturerParam && !list.some((manufacturer: any) => manufacturer.id === manufacturerParam)) {
        const { data: linked } = await supabase
          .from('organizations')
          .select('id, org_name, org_code')
          .eq('id', manufacturerParam)
          .in('org_type_code', ['MANU', 'MFG'])
          .maybeSingle()
        if (linked) list.push({ ...linked, org_name: `${linked.org_name} (inactive)` })
      }
      setManufacturers(list)
    } catch (error) {
      console.error('Error fetching manufacturers:', error)
    }
  }

  const handleViewProduct = (product: Product) => {
    // Store product ID and navigate to view
    sessionStorage.setItem('selectedProductId', product.id)
    onViewChange?.('view-product')
  }

  const handleEditProduct = (product: Product) => {
    // Store product ID and navigate to edit
    sessionStorage.setItem('selectedProductId', product.id)
    onViewChange?.('edit-product')
  }

  const handleDeleteProduct = async (product: Product) => {
    if (!window.confirm(`Are you sure you want to delete "${product.product_name}"? This action cannot be undone.`)) {
      return
    }

    setDeleting(true)
    setSelectedProductId(product.id)
    
    try {
      // Delete product - cascade will handle variants and images
      const { error } = await supabase
        .from('products')
        .delete()
        .eq('id', product.id)

      if (error) throw error

      // Refresh the product list
      setProducts(products.filter(p => p.id !== product.id))
      
      toast({
        title: 'Success',
        description: `Product "${product.product_name}" has been deleted`,
      })
    } catch (error: any) {
      console.error('Error deleting product:', error)
      toast({
        title: 'Error',
        description: error.message || 'Failed to delete product',
        variant: 'destructive'
      })
    } finally {
      setDeleting(false)
      setSelectedProductId(null)
    }
  }

  const getStatusBadge = (isActive: boolean, isVape: boolean) => {
    if (!isActive) {
      return <Badge variant="outline" className="bg-gray-50 text-gray-700 border-gray-200">Inactive</Badge>
    }
    return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">Active</Badge>
  }

  // Mock stats - in real implementation, these would come from API
  const stats = {
    totalProducts: products.length,
    activeProducts: products.filter(p => p.is_active).length,
    totalCategories: categories.length,
    totalBrands: brands.length
  }

  return (
    <div className="sera-sc-page">
      <SupplyChainPageHeader
        title="Products"
        description="Manage your product catalog"
        actions={
          <>
            <Button variant="outline" size="sm" className="border-[var(--sera-line)] text-[var(--sera-ink)]">
              <Download className="w-4 h-4 mr-2" />
              Export
            </Button>
            <Button
              size="sm"
              className="bg-[var(--sera-ink)] text-white hover:bg-[var(--sera-ink-soft)]"
              onClick={() => onViewChange?.('add-product')}
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Product
            </Button>
          </>
        }
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="sera-sc-kpi">
          <p className="sera-sc-kpi__label">Total Products</p>
          <p className="sera-sc-kpi__value">{stats.totalProducts}</p>
        </div>
        <div className="sera-sc-kpi">
          <p className="sera-sc-kpi__label">Active Products</p>
          <p className="sera-sc-kpi__value">{stats.activeProducts}</p>
        </div>
        <div className="sera-sc-kpi">
          <p className="sera-sc-kpi__label">Categories</p>
          <p className="sera-sc-kpi__value">{stats.totalCategories}</p>
        </div>
        <div className="sera-sc-kpi">
          <p className="sera-sc-kpi__label">Brands</p>
          <p className="sera-sc-kpi__value">{stats.totalBrands}</p>
        </div>
      </div>

      {/* Filters */}
      <Card className="sera-sc-panel shadow-none">
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-4">
            <div className="w-full min-w-0 flex-1 sm:min-w-[220px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[var(--sera-muted)] w-5 h-5" />
                <Input
                  placeholder="Search products by name or code..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 border-[var(--sera-line)] focus-visible:ring-[var(--sera-orange)]/30"
                />
              </div>
            </div>
            
            <Select value={categoryFilter} onValueChange={(value) => {
              setCategoryFilter(value)
              setBrandFilter('all') // Reset brand filter when category changes
            }}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.category_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={brandFilter} onValueChange={setBrandFilter}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Brand" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Brands</SelectItem>
                {brands.map((brand) => (
                  <SelectItem key={brand.id} value={brand.id}>
                    {brand.brand_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={manufacturerFilter} onValueChange={setManufacturerFilter}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <SelectValue placeholder="Manufacturer" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Manufacturers</SelectItem>
                {manufacturers.map((manufacturer) => (
                  <SelectItem key={manufacturer.id} value={manufacturer.id}>
                    {manufacturer.org_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full sm:w-[150px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex gap-2">
              <Button
                variant={viewMode === 'card' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setViewMode('card')}
                className={viewMode === 'card' ? 'bg-[var(--sera-ink)] text-white hover:bg-[var(--sera-ink-soft)]' : 'border-[var(--sera-line)]'}
              >
                <LayoutGrid className="w-4 h-4" />
              </Button>
              <Button
                variant={viewMode === 'list' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setViewMode('list')}
                className={viewMode === 'list' ? 'bg-[var(--sera-ink)] text-white hover:bg-[var(--sera-ink-soft)]' : 'border-[var(--sera-line)]'}
              >
                <List className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Products Display - Card or List View */}
      {viewMode === 'card' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {loading ? (
            [...Array(6)].map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-6">
                  <div className="h-32 bg-gray-200 rounded mb-4"></div>
                  <div className="h-4 bg-gray-200 rounded mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded w-2/3"></div>
                </CardContent>
              </Card>
            ))
          ) : products.length === 0 ? (
            <Card className="col-span-full">
              <CardContent className="p-12 text-center">
                <Package className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">No products found</h3>
                <p className="text-gray-600">Try adjusting your search criteria</p>
              </CardContent>
            </Card>
          ) : (
            products.map((product) => {
              const primaryImage = product.product_images?.find(img => img.is_primary)?.image_url ||
                                 product.product_images?.[0]?.image_url
              const resolvedPrimaryImage = resolveProductImageUrl(primaryImage)
              const imageKey = `${product.id}:${resolvedPrimaryImage || 'no-image'}`
              const initials = product.product_name
                .split(' ')
                .map(word => word[0])
                .join('')
                .toUpperCase()
                .slice(0, 2)

              return (
                <Card key={product.id} className="sera-sc-panel overflow-hidden transition-colors hover:border-[var(--sera-orange)]/30">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between mb-3">
                      {resolvedPrimaryImage && !failedImageKeys[imageKey] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={resolvedPrimaryImage}
                          alt={product.product_name}
                          className="h-32 w-full object-cover rounded-lg"
                          onError={(event) => {
                            event.currentTarget.style.display = 'none'
                            markImageFailed(imageKey)
                          }}
                        />
                      ) : (
                        <div className="h-32 w-full rounded-lg bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center">
                          <span className="text-3xl font-bold text-white">{initials}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-base mb-1">
                          <button
                            type="button"
                            onClick={() => handleViewProduct(product)}
                            className="w-full text-left text-[var(--sera-orange)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)] focus-visible:ring-offset-2 rounded"
                          >
                            {product.product_name}
                          </button>
                        </CardTitle>
                        <CardDescription className="text-xs">{product.product_code}</CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {product.is_vape && (
                        <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
                          Vape
                        </Badge>
                      )}
                      {product.age_restriction && product.age_restriction > 0 && (
                        <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200">
                          {product.age_restriction}+
                        </Badge>
                      )}
                      {getStatusBadge(product.is_active, product.is_vape)}
                    </div>
                    
                    <div className="text-xs space-y-1">
                      <p className="text-gray-600">
                        <span className="font-medium">Brand:</span> {product.brands?.brand_name || 'No Brand'}
                      </p>
                      <p className="text-gray-600">
                        <span className="font-medium">Category:</span> {product.product_categories?.category_name || 'No Category'}
                      </p>
                      <p className="text-gray-600">
                        <span className="font-medium">Manufacturer:</span> {product.manufacturers?.org_name || 'Unknown'} {product.manufacturers?.org_code && `(${product.manufacturers.org_code})`}
                      </p>
                      {product.product_description && (
                        <p className="text-gray-600 text-xs mt-2 line-clamp-2">
                          {product.product_description}
                        </p>
                      )}
                    </div>

                    <div className="flex gap-2 pt-2">
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="flex-1"
                        onClick={() => handleViewProduct(product)}
                      >
                        <Eye className="w-4 h-4 mr-2" />
                        View
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="flex-1"
                        onClick={() => handleEditProduct(product)}
                      >
                        <Edit className="w-4 h-4 mr-2" />
                        Edit
                      </Button>
                      {/* Hide delete button for manufacturers */}
                      {userProfile?.organizations?.org_type_code !== 'MANU' && 
                       userProfile?.organizations?.org_type_code !== 'MFG' && (
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="text-red-600 hover:text-red-700"
                          onClick={() => handleDeleteProduct(product)}
                          disabled={deleting && selectedProductId === product.id}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      ) : (
      <Card>
        <CardHeader>
          <CardTitle>Products</CardTitle>
          <CardDescription>
            {loading ? 'Loading...' : `${products.length} products found`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => {
                      if (sortColumn === 'product_name') {
                        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
                      } else {
                        setSortColumn('product_name')
                        setSortDirection('asc')
                      }
                    }}
                    className="flex items-center gap-1 hover:text-[var(--sera-orange)]"
                  >
                    Product Name
                    {sortColumn === 'product_name' && (
                      <span className="text-[var(--sera-orange)]">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => {
                      if (sortColumn === 'brand') {
                        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
                      } else {
                        setSortColumn('brand')
                        setSortDirection('asc')
                      }
                    }}
                    className="flex items-center gap-1 hover:text-[var(--sera-orange)]"
                  >
                    Brand
                    {sortColumn === 'brand' && (
                      <span className="text-[var(--sera-orange)]">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => {
                      if (sortColumn === 'category') {
                        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
                      } else {
                        setSortColumn('category')
                        setSortDirection('asc')
                      }
                    }}
                    className="flex items-center gap-1 hover:text-[var(--sera-orange)]"
                  >
                    Category
                    {sortColumn === 'category' && (
                      <span className="text-[var(--sera-orange)]">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => {
                      if (sortColumn === 'manufacturer') {
                        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
                      } else {
                        setSortColumn('manufacturer')
                        setSortDirection('asc')
                      }
                    }}
                    className="flex items-center gap-1 hover:text-[var(--sera-orange)]"
                  >
                    Manufacturer
                    {sortColumn === 'manufacturer' && (
                      <span className="text-[var(--sera-orange)]">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => {
                      if (sortColumn === 'is_vape') {
                        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
                      } else {
                        setSortColumn('is_vape')
                        setSortDirection('asc')
                      }
                    }}
                    className="flex items-center gap-1 hover:text-[var(--sera-orange)]"
                  >
                    Type
                    {sortColumn === 'is_vape' && (
                      <span className="text-[var(--sera-orange)]">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    type="button"
                    onClick={() => {
                      if (sortColumn === 'status') {
                        setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
                      } else {
                        setSortColumn('status')
                        setSortDirection('asc')
                      }
                    }}
                    className="flex items-center gap-1 hover:text-[var(--sera-orange)]"
                  >
                    Status
                    {sortColumn === 'status' && (
                      <span className="text-[var(--sera-orange)]">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </button>
                </TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8">
                    Loading products...
                  </TableCell>
                </TableRow>
              ) : products.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8">
                    No products found
                  </TableCell>
                </TableRow>
              ) : (
                products.map((product) => {
                  // Get primary image or first image
                  const primaryImage = product.product_images?.find(img => img.is_primary)?.image_url ||
                                     product.product_images?.[0]?.image_url
                  const resolvedPrimaryImage = resolveProductImageUrl(primaryImage)
                  const imageKey = `${product.id}:${resolvedPrimaryImage || 'no-image'}`
                  // Get initials for avatar if no image
                  const initials = product.product_name
                    .split(' ')
                    .map(word => word[0])
                    .join('')
                    .toUpperCase()
                    .slice(0, 2)

                  return (
                  <TableRow key={product.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {/* Avatar/Image */}
                        <div className="relative">
                          {resolvedPrimaryImage && !failedImageKeys[imageKey] ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={resolvedPrimaryImage}
                              alt={product.product_name}
                              className="h-10 w-10 rounded-lg object-cover"
                              onError={(event) => {
                                event.currentTarget.style.display = 'none'
                                markImageFailed(imageKey)
                              }}
                            />
                          ) : (
                            <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center">
                              <span className="text-xs font-semibold text-white">{initials}</span>
                            </div>
                          )}
                        </div>
                        {/* Product Info */}
                        <div className="flex-1">
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleViewProduct(product)}
                              className="text-xs font-medium text-left text-[var(--sera-orange)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)] focus-visible:ring-offset-2 rounded"
                            >
                              {product.product_name}
                            </button>
                            {product.is_vape && (
                              <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 text-[10px] px-1.5 py-0 h-4">
                                Vape
                              </Badge>
                            )}
                            {product.age_restriction && product.age_restriction > 0 && (
                              <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200 text-[10px] px-1.5 py-0 h-4">
                                {product.age_restriction}+
                              </Badge>
                            )}
                          </div>
                          {product.product_description && (
                            <p className="text-xs text-gray-600 truncate max-w-[250px]">
                              {product.product_description}
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {product.brands?.brand_name || 'No Brand'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {product.product_categories?.category_name || 'No Category'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {product.manufacturers?.org_name || 'Unknown'} {product.manufacturers?.org_code && `(${product.manufacturers.org_code})`}
                    </TableCell>
                    <TableCell>
                      {product.is_vape ? (
                        <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200 text-[10px] px-1.5 py-0 h-5">
                          Vape Product
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)] border-[var(--sera-orange)]/25 text-[10px] px-1.5 py-0 h-5">
                          Regular Product
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(product.is_active, product.is_vape)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="h-8 w-8 p-0"
                          onClick={() => handleViewProduct(product)}
                          title="View product details"
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="h-8 w-8 p-0"
                          onClick={() => handleEditProduct(product)}
                          title="Edit product"
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        {/* Hide delete button for manufacturers */}
                        {userProfile?.organizations?.org_type_code !== 'MANU' && 
                         userProfile?.organizations?.org_type_code !== 'MFG' && (
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="h-8 w-8 p-0 text-red-600 hover:text-red-700"
                            onClick={() => handleDeleteProduct(product)}
                            disabled={deleting && selectedProductId === product.id}
                            title="Delete product"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
          </div>

          {/* Pagination */}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-gray-600 text-xs">
              Showing {(currentPage - 1) * itemsPerPage + 1} to {Math.min(currentPage * itemsPerPage, products.length)} of {products.length} items
            </p>
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                className="bg-[var(--sera-orange)]/10 text-[var(--sera-orange)] border-[var(--sera-orange)]/25"
              >
                {currentPage}
              </Button>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setCurrentPage(currentPage + 1)}
                disabled={products.length < itemsPerPage}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      )}
    </div>
  )
}