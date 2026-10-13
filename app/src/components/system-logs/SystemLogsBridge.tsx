'use client'

import { useEffect } from 'react'
import { installGlobalErrorListeners } from '@/lib/system-logs/client'

/** Installs the uncaught-error / unhandled-rejection listeners once per tab (System Logs). Renders nothing. */
export default function SystemLogsBridge() {
  useEffect(() => installGlobalErrorListeners(), [])
  return null
}
