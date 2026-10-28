'use client'

import { toast } from '@/components/ui/use-toast'
import { installDenialNotifications } from '@/lib/security-access/denial-notifications'
import { useEffect } from 'react'
import { installGlobalErrorListeners } from '@/lib/system-logs/client'

/** Installs the uncaught-error / unhandled-rejection listeners once per tab (System Logs). Renders nothing. */
export default function SystemLogsBridge() {
  useEffect(() => {
    const stopErrors = installGlobalErrorListeners()
    const stopDenials = installDenialNotifications(toast)
    return () => { stopDenials(); stopErrors() }
  }, [])
  return null
}
