import DashboardContent from '@/components/dashboard/DashboardContent'
import { getCrmPageContext } from '@/app/crm/_lib'
import { resolveCrmSlug } from '@/modules/crm/crmNav'
import AccessState from '@/components/access/AccessState'
import { resolveChildViewAccess } from '@/lib/server/nav-access'

interface CrmSubPageProps {
  params: Promise<{ slug?: string[] }>
}

export default async function CrmSubPage({ params }: CrmSubPageProps) {
  const { userProfile, canViewCrm, accessState } = await getCrmPageContext()
  const { slug = [] } = await params
  const initialView = resolveCrmSlug(slug)

  // A deep link needs the child's own permission, not only the module entry.
  const access = canViewCrm ? await resolveChildViewAccess(userProfile, initialView, 'crm') : null
  if (!access || access.state !== 'allowed') {
    const state = access?.state ?? accessState
    return <AccessState kind={state === 'unavailable' ? 'unavailable' : 'denied'} />
  }

  return <DashboardContent userProfile={userProfile} initialView={initialView} />
}
