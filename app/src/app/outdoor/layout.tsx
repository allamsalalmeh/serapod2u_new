import type { Metadata } from 'next'
import { Manrope, Syne } from 'next/font/google'
import { CartProvider } from '@/lib/storefront/cart-context'
import OutdoorChrome from '@/components/outdoor/OutdoorChrome'
import OutdoorAnalytics from '@/components/outdoor/OutdoorAnalytics'
import OutdoorRefCapture from '@/components/outdoor/OutdoorRefCapture'
import { OUTDOOR_SITE_DEFAULT } from '@/lib/hosts/outdoor-hosts'
import './outdoor.css'

const display = Syne({
  subsets: ['latin'],
  variable: '--font-outdoor-display',
  display: 'swap',
})

const body = Manrope({
  subsets: ['latin'],
  variable: '--font-outdoor-body',
  display: 'swap',
})

const siteUrl =
  process.env.NEXT_PUBLIC_OUTDOOR_SITE_URL?.replace(/\/$/, '') || OUTDOOR_SITE_DEFAULT

const gsc = String(process.env.NEXT_PUBLIC_OUTDOOR_GSC_VERIFICATION || '').trim()

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'SeraOutdoor',
    template: '%s | SeraOutdoor',
  },
  description:
    'SeraOutdoor — Moon Chair, Tumbler, and Camp Mat. Secure checkout and Malaysia delivery.',
  openGraph: {
    title: 'SeraOutdoor',
    description: 'SeraOutdoor — Moon Chair, Tumbler, and Camp Mat.',
    url: siteUrl,
    siteName: 'SeraOutdoor',
    type: 'website',
    locale: 'en_MY',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SeraOutdoor',
    description: 'SeraOutdoor — Moon Chair, Tumbler, and Camp Mat.',
  },
  ...(gsc
    ? {
        verification: {
          google: gsc,
        },
      }
    : {}),
}

export default function OutdoorLayout({ children }: { children: React.ReactNode }) {
  return (
    <CartProvider storageKey="serapod_outdoor_cart" accountScoped>
      <div className={`sera-outdoor ${display.variable} ${body.variable} min-h-screen min-w-0`}>
        <OutdoorAnalytics />
        <OutdoorRefCapture />
        <OutdoorChrome>{children}</OutdoorChrome>
      </div>
    </CartProvider>
  )
}
