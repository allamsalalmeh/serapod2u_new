'use client'

import { Bell, MessageCircle, Megaphone } from 'lucide-react'
import { cn } from '@/lib/utils'

const ITEMS = [
  { id: 'notifications', label: 'Overview', href: '/notifications', icon: Bell },
  { id: 'notifications/providers', label: 'Providers', href: '/notifications/providers', icon: Bell },
  { id: 'notifications/types', label: 'Types', href: '/notifications/types', icon: Megaphone },
  { id: 'notifications/whatsapp-activity-recovery', label: 'Monitor', href: '/notifications/whatsapp-activity-recovery', icon: MessageCircle },
] as const

interface NotificationsTopNavProps {
  currentView: string
  onNavigate: (href: string) => void
}

export default function NotificationsTopNav({ currentView, onNavigate }: NotificationsTopNavProps) {
  return (
    <div className="sticky top-0 z-40 border-b border-[var(--sera-line)] bg-white print:hidden">
      <div className="flex items-center gap-1 overflow-x-auto px-4 py-2">
        <span className="mr-2 shrink-0 rounded-md bg-orange-50 px-2 py-0.5 text-xs font-semibold text-orange-700">
          Notifications
        </span>
        {ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = item.id === 'notifications'
            ? currentView === 'notifications'
            : currentView === item.id
              || currentView.startsWith(`${item.id}/`)
              || (item.id === 'notifications/whatsapp-activity-recovery' && (
                currentView === 'notifications/sms-activity'
                || currentView === 'settings/notifications/sms-activity'
                || currentView === 'sms-activity'
                || currentView === 'notifications/email-activity'
                || currentView === 'settings/notifications/email-activity'
                || currentView === 'email-activity'
              ))
          return (
            <button
              key={item.id}
              type="button"
              data-nav-href={item.href}
              onClick={() => onNavigate(item.href)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
