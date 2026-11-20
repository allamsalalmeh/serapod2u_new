import type { Metadata } from 'next'
import StoreOrdersClient from '@/components/storefront/StoreOrdersClient'

export const metadata: Metadata = {
  title: 'My Purchases',
  description: 'Your Serapod Store orders.',
}

export default function StoreOrdersPage() {
  return <StoreOrdersClient />
}
