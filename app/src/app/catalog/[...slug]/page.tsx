import DashboardContent from '@/components/dashboard/DashboardContent'
import { getCatalogPageContext } from '@/app/catalog/_lib'
import { resolveCatalogSlug } from '@/modules/catalog/catalogNav'
import AccessState from '@/components/access/AccessState'
import { resolveChildViewAccess } from '@/lib/server/nav-access'

interface CatalogSubPageProps {
  params: Promise<{ slug?: string[] }>
}

export default async function CatalogSubPage({ params }: CatalogSubPageProps) {
  const { userProfile, canViewCatalog, accessState } = await getCatalogPageContext()
  const { slug = [] } = await params
  const initialView = resolveCatalogSlug(slug)

  // A deep link needs the child's own permission, not only the module entry.
  const access = canViewCatalog ? await resolveChildViewAccess(userProfile, initialView, 'catalog') : null
  if (!access || access.state !== 'allowed') {
    const state = access?.state ?? accessState
    return <AccessState kind={state === 'unavailable' ? 'unavailable' : 'denied'} />
  }

  return <DashboardContent userProfile={userProfile} initialView={initialView} />
}
