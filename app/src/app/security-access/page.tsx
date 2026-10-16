import DashboardContent from '@/components/dashboard/DashboardContent'
import { getSecurityAccessContext } from './_lib'

export const dynamic = 'force-dynamic'

export default async function SecurityAccessPage() {
  const { userProfile, allowed, unavailable } = await getSecurityAccessContext()
  if (unavailable) return <div className="p-8"><h1 className="text-xl font-semibold">Security & Access is temporarily unavailable</h1><p className="mt-2 text-sm text-gray-600">Access could not be verified right now, so the page is not shown. Reload the page to try again.</p></div>
  if (!allowed) return <div className="p-8"><h1 className="text-xl font-semibold">Unauthorized</h1><p className="mt-2 text-sm text-gray-600">Security & Access administration requires the Security & Access view permission (security.access.view).</p></div>
  return <DashboardContent userProfile={userProfile} initialView="security-access" />
}
