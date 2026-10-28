import type { Metadata } from 'next'
import CorporateHome from '../_components/CorporateHome'

export const metadata: Metadata = {
  title: { absolute: 'Serapod2U' },
  description: 'Serapod2U — shop the Serapod2U Store and Serapod Outdoor.',
}

/** Home page of the serapod2u.com main site (middleware rewrites `/` here on split hosts). */
export default function Serapod2uHomePage() {
  return <CorporateHome site="serapod2u" />
}
