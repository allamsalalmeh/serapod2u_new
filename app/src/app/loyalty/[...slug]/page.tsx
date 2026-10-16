import DashboardContent from '@/components/dashboard/DashboardContent'
import { getLoyaltyPageContext } from '@/app/loyalty/_lib'
import { resolveLoyaltySlug } from '@/modules/loyalty/loyaltyNav'
import AccessState from '@/components/access/AccessState'
import { resolveChildViewAccess } from '@/lib/server/nav-access'

interface LoyaltySubPageProps {
  params: Promise<{ slug?: string[] }>
}

export default async function LoyaltySubPage({ params }: LoyaltySubPageProps) {
  const { userProfile, canViewLoyalty, accessState } = await getLoyaltyPageContext()
  const { slug = [] } = await params
  const initialView = resolveLoyaltySlug(slug)

  // A deep link needs the child's own permission, not only the module entry.
  const access = canViewLoyalty ? await resolveChildViewAccess(userProfile, initialView, 'loyalty') : null
  if (!access || access.state !== 'allowed') {
    const state = access?.state ?? accessState
    return <AccessState kind={state === 'unavailable' ? 'unavailable' : 'denied'} />
  }

  return <DashboardContent userProfile={userProfile} initialView={initialView} />
}
