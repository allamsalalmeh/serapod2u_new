import 'server-only'
import { getMarketingPageContext } from '@/app/marketing/_lib'

/**
 * Server-only context helper for Event Management admin pages.
 * Reuses the existing Marketing parent gate exactly (getMarketingPageContext),
 * so navigation, pages and APIs share the same `marketing.module.view`
 * authorization semantics. No event.* permissions are introduced.
 */
export async function getEventManagementPageContext() {
  const context = await getMarketingPageContext()
  const organizationId = (context.userProfile as any)?.organization_id ?? null
  return { ...context, organizationId }
}
