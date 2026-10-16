import { listOutdoorProducts, listOutdoorCategories, getOutdoorCategoryNav } from '@/lib/outdoor/catalog'
import OutdoorCategoryNav from '@/components/outdoor/OutdoorCategoryNav'
import OutdoorShopBrowser from '@/components/outdoor/OutdoorShopBrowser'
import OutdoorCombos from '@/components/outdoor/OutdoorCombos'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Shop' }

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function OutdoorShopPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const search = typeof params.search === 'string' ? params.search : ''
  const category = typeof params.category === 'string' ? params.category : ''
  const collection = typeof params.collection === 'string' ? params.collection : ''
  const sortRaw = typeof params.sort === 'string' ? params.sort : 'newest'
  const sort = (['newest', 'price_asc', 'price_desc', 'name_asc'].includes(sortRaw)
    ? sortRaw
    : 'newest') as 'newest' | 'price_asc' | 'price_desc' | 'name_asc'

  const [{ products, scope }, categories, circles] = await Promise.all([
    listOutdoorProducts({ sort: 'newest', limit: 200 }),
    listOutdoorCategories(),
    getOutdoorCategoryNav(),
  ])

  return (
    <>
      <OutdoorCategoryNav items={circles} />
    <div className="mx-auto max-w-xl sm:max-w-3xl px-4 sm:px-8 py-6 sm:py-10">
      <h1 className="font-display text-3xl sm:text-5xl tracking-tight text-[var(--out-ink)]">Shop</h1>
      <OutdoorCombos />
      <OutdoorShopBrowser
        key={collection || 'all'}
        products={products}
        categories={categories}
        initialSearch={search}
        initialCategory={category}
        initialCollection={collection}
        initialSort={sort}
        catalogueLinked={scope.matchedBy !== 'none'}
      />
    </div>
    </>
  )
}
