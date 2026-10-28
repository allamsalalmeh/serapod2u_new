import type { Metadata } from 'next'
import { listProducts } from '@/lib/storefront/products'
import { OUTDOOR_SITE_DEFAULT } from '@/lib/hosts/outdoor-hosts'
import Serapod2uLanding, { type LandingProduct } from './Serapod2uLanding'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: { absolute: 'Serapod' },
  description: 'Shop the Serapod Store and Serapod Outdoor.',
}

const OUTDOOR_URL = process.env.NEXT_PUBLIC_OUTDOOR_SITE_URL?.replace(/\/$/, '') || OUTDOOR_SITE_DEFAULT

async function storeProducts(): Promise<LandingProduct[]> {
  try {
    const { products } = await listProducts({ sort: 'newest', limit: 16 })
    return products
      .filter((p) => p.image_url && p.media_type === 'image' && !/\btest\b/i.test(p.product_name))
      .map((p) => ({
        id: p.id,
        name: p.product_name,
        category: p.category_name || null,
        image: p.image_url as string,
        price: p.starting_price ?? null,
      }))
  } catch (err) {
    console.error('[serapod2u-home] store products failed:', err)
    return []
  }
}

/** Home page of the serapod2u.com main site (middleware rewrites `/` here on split hosts). */
export default async function Serapod2uHomePage() {
  return <Serapod2uLanding products={await storeProducts()} outdoorUrl={OUTDOOR_URL} />
}
