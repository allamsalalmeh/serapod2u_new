import { EventManagementAdminView } from '@/app/marketing/event-management/_EventManagementAdminView'
import { EventManagementSettingsView } from '@/modules/event-management/components/EventManagementSettingsView'

export const dynamic = 'force-dynamic'

export default function EventManagementSettingsPage() {
  return <EventManagementAdminView view="event-management-settings" render={() => <EventManagementSettingsView />} />
}
