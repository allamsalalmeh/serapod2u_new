import DashboardContent from '@/components/dashboard/DashboardContent'
import { getMarketingPageContext } from '@/app/marketing/_lib'
import { resolveMarketingSlug } from '@/modules/marketing/marketingNav'
import AccessState from '@/components/access/AccessState'
import { resolveChildViewAccess } from '@/lib/server/nav-access'

interface MarketingSubPageProps {
  params: Promise<{ slug?: string[] }>
}

export default async function MarketingSubPage({ params }: MarketingSubPageProps) {
  const { userProfile, canViewMarketing, accessState } = await getMarketingPageContext()
  const { slug = [] } = await params
  const initialView = resolveMarketingSlug(slug)

  // A deep link needs the child's own permission, not only the module entry.
  const access = canViewMarketing ? await resolveChildViewAccess(userProfile, initialView, 'mktg') : null
  if (!access || access.state !== 'allowed') {
    const state = access?.state ?? accessState
    return <AccessState kind={state === 'unavailable' ? 'unavailable' : 'denied'} />
  }

  return <DashboardContent userProfile={userProfile} initialView={initialView} />
}
