import type { Metadata } from 'next'
import StoreAccountClient from './StoreAccountClient'
import AffiliateAccountCard from '@/components/affiliate/AffiliateAccountCard'

export const metadata: Metadata = {
  title: 'My Account',
  description: 'Manage your store profile and account settings.',
}

export default function StoreAccountPage() {
  return (
    <>
      <StoreAccountClient />
      <AffiliateAccountCard />
    </>
  )
}
