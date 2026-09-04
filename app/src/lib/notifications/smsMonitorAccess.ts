/**
 * Shared authorization check for the SMS delivery monitor endpoints
 * (GET/PATCH /api/settings/notifications/sms-activity and its
 * /refresh-status action). Kept in one place so the two routes can't
 * drift out of sync on who is allowed to view/operate the monitor.
 */
import { canViewMonitor, loadMonitorViewer } from '@/lib/notifications/monitorScope'

export async function canViewSmsMonitor(supabase: any, userId: string): Promise<boolean> {
  const viewer = await loadMonitorViewer(supabase, userId)
  return viewer ? canViewMonitor(viewer) : false
}
