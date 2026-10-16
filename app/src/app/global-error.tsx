'use client'

import ErrorFallback from '@/components/system-logs/ErrorFallback'

/** Last-resort boundary: failures in the root layout itself. Replaces the root layout, so it renders html/body. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#f9fafb', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <ErrorFallback error={error} reset={reset} scope="application" />
      </body>
    </html>
  )
}
