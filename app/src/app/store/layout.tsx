import type { Metadata } from 'next'
import StorefrontNavbar from '@/components/storefront/StorefrontNavbar'
import StorefrontFooter from '@/components/storefront/StorefrontFooter'
import { CartProvider } from '@/lib/storefront/cart-context'
import AffiliateRefCapture from '@/components/affiliate/AffiliateRefCapture'
import './store.css'

export const metadata: Metadata = {
  title: {
    default: 'Serapod2U Store',
    template: '%s | Serapod2U Store',
  },
  description: 'Browse and shop quality products from Serapod2U.',
}

export default function StorefrontLayout({ children }: { children: React.ReactNode }) {
  return (
    <CartProvider>
      <div className="sera-store min-h-screen flex flex-col">
        <AffiliateRefCapture />
        <StorefrontNavbar />
        <main className="flex-1">
          {children}
        </main>
        <StorefrontFooter />
      </div>
    </CartProvider>
  )
}
