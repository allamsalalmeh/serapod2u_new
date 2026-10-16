'use client'

import { useEffect, useState } from 'react'
import { ArrowRight, Bell, Megaphone, AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import ModuleLightHeader from '@/components/layout/ModuleLightHeader'
import ModuleLandingCard from '@/components/layout/ModuleLandingCard'
import { landingAccents, type LandingAccent } from '@/lib/landing-accents'

interface NotificationsCardItem {
  id: string
  label: string
  description: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  accent: LandingAccent
}

const notificationCards: NotificationsCardItem[] = [
  {
    id: 'notification-providers',
    label: 'Notification Providers',
    description: 'Configure SMS, Email, and WhatsApp providers used by the system.',
    href: '/notifications/providers',
    icon: Bell,
    accent: landingAccents.violet,
  },
  {
    id: 'notification-types',
    label: 'Notification Types',
    description: 'Manage notification event categories and delivery channel rules.',
    href: '/notifications/types',
    icon: Megaphone,
    accent: landingAccents.rose,
  },
  {
    id: 'failed-notifications',
    label: 'Notification Monitor',
    description: 'Monitor WhatsApp, SMS, and Email delivery, failed notifications, provider status, and recovery actions.',
    href: '/notifications/whatsapp-activity-recovery',
    icon: AlertTriangle,
    accent: landingAccents.amber,
  },
]

export default function NotificationsLandingView() {
  const [providersHref, setProvidersHref] = useState('/notifications/providers?channel=whatsapp&provider=meta&tab=configuration')
  const [providersAction, setProvidersAction] = useState('Continue Setup')

  useEffect(() => {
    const loadProviderDestination = async () => {
      const supabase = createClient()
      const { data } = await supabase
        .from('notification_provider_configs')
        .select('provider_name,is_active,is_default,config_public,last_test_status')
        .eq('channel', 'whatsapp')

      const records = data || []
      const selected = records.find(record => record.is_default) || records.find(record => record.is_active) || records.find(record => record.provider_name === 'whatsapp_business')
      if (!selected) return

      const aliases: Record<string, string> = {
        whatsapp_business: 'meta',
        baileys: 'baileys-hostinger',
        baileys_home: 'baileys-home',
        twilio: 'twilio',
        messagebird: 'messagebird'
      }
      const provider = aliases[selected.provider_name] || 'meta'
      const tab = selected.provider_name === 'baileys' || selected.provider_name === 'baileys_home' ? 'status' : 'configuration'
      const metaIncomplete = selected.provider_name === 'whatsapp_business' && !(
        (selected.config_public as any)?.phone_number_id && (selected.config_public as any)?.waba_id
      )

      setProvidersHref(`/notifications/providers?channel=whatsapp&provider=${provider}&tab=${tab}`)
      setProvidersAction(metaIncomplete ? 'Continue Setup' : 'Manage')
    }

    loadProviderDestination().catch(error => console.error('Failed to resolve notification provider destination', error))
  }, [])

  return (
    <div className="sera-module-landing">
      <ModuleLightHeader
        eyebrow="Notifications"
        title="Delivery monitoring"
        description="Monitor system notifications, WhatsApp delivery, and failed messages."
        lead="Operational monitoring lives here. Configuration pages remain reusable and are linked below."
      />

      <div className="sera-module-landing__grid">
        {notificationCards.map((item) => {
          const href = item.id === 'notification-providers' ? providersHref : item.href
          const action = item.id === 'notification-providers' ? providersAction : 'Open'

          return (
            <ModuleLandingCard
              key={item.id}
              icon={item.icon}
              accent={item.accent}
              title={item.label}
              description={item.description}
            >
              <a
                href={href}
                className="sera-module-landing__link sera-module-landing__link--text-only group"
              >
                <span className="flex-1">{action}</span>
                <ArrowRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity text-[var(--sera-orange)]" />
              </a>
            </ModuleLandingCard>
          )
        })}
      </div>
    </div>
  )
}
