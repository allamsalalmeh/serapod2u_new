import type { Metadata } from 'next'
import StoreAffiliateClient from '@/components/affiliate/StoreAffiliateClient'

export const metadata: Metadata = {
  title: 'Affiliate program',
  description: 'Share Serapod products with your link and earn commission on paid orders.',
}

export default function StoreAffiliatePage() {
  return <StoreAffiliateClient />
}
