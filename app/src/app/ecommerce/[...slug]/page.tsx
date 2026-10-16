import DashboardContent from '@/components/dashboard/DashboardContent'
import { getEcommercePageContext } from '@/app/ecommerce/_lib'
import { resolveEcommerceSlug } from '@/modules/customer-growth/customerGrowthNav'
import AccessState from '@/components/access/AccessState'
import { resolveChildViewAccess } from '@/lib/server/nav-access'

interface EcommerceSubPageProps {
  params: Promise<{ slug?: string[] }>
}

export default async function EcommerceSubPage({ params }: EcommerceSubPageProps) {
  const { userProfile, canViewEcommerce, accessState } = await getEcommercePageContext()
  const { slug = [] } = await params
  const initialView = resolveEcommerceSlug(slug)

  // A deep link needs the child's own permission, not only the module entry.
  const access = canViewEcommerce ? await resolveChildViewAccess(userProfile, initialView, 'ecommerce') : null
  if (!access || access.state !== 'allowed') {
    const state = access?.state ?? accessState
    return <AccessState kind={state === 'unavailable' ? 'unavailable' : 'denied'} />
  }

  return <DashboardContent userProfile={userProfile} initialView={initialView} />
}
