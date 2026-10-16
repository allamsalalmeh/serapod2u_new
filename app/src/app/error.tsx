'use client'

import ErrorFallback from '@/components/system-logs/ErrorFallback'

/** Route-segment error boundary for every page under the root layout (System Logs records the failure). */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorFallback error={error} reset={reset} scope="page" />
}
