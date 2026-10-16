import DashboardContent from '@/components/dashboard/DashboardContent'
import HrEntryRouter from '@/components/hr/mobile/HrEntryRouter'
import { getHrPageContext } from '@/app/hr/_lib'

/**
 * /hr — Canonical HR entry point.
 *
 * Someone who holds the HR module entry permission (an HR administrator) gets the administrative landing page.
 * Someone who only holds Employee Self-Service gets My Workspace instead: the HR entry never opens the admin dashboard
 * for an employee. On mobile (≤768 px) the client-side HrEntryRouter redirects to /hr/mobile/home in both cases.
 */
export default async function HrPage() {
    const { userProfile, access, gate } = await getHrPageContext(['hr', 'hr/my-workspace'])
    if (gate) return <DashboardContent userProfile={userProfile} initialView="dashboard">{gate}</DashboardContent>

    return <HrEntryRouter userProfile={userProfile} initialView={access.state === 'allowed' && access.destination === 'hr' ? 'hr' : 'hr/my-workspace'} />
}
