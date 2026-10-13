'use client'

import { useEffect, useState } from 'react'
import { reportClientError } from '@/lib/system-logs/client'

/**
 * Shared render-error fallback for app/error.tsx and app/global-error.tsx. Reports the failure once (System Logs) and
 * shows its reference so the user can quote it; the Next.js digest links it to the server's own report when the
 * failure happened in a server render.
 */
export default function ErrorFallback({ error, reset, scope }: {
  error: Error & { digest?: string }
  reset?: () => void
  scope: 'page' | 'application'
}) {
  const [reference, setReference] = useState<string | null>(null)
  useEffect(() => {
    setReference(reportClientError(error, {
      action: scope === 'application' ? 'Application render (global error boundary)' : 'Page render (error boundary)',
      reportWarnings: true,
      details: { boundary: scope },
    }))
  }, [error, scope])

  return (
    <div role="alert" style={{ minHeight: scope === 'application' ? '100vh' : '50vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ maxWidth: 440, width: '100%', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.05)', fontFamily: 'inherit' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#111827' }}>Something went wrong</h2>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#4b5563' }}>
          This {scope === 'application' ? 'application' : 'page'} could not be displayed. You can try again; if it keeps happening, share the reference below with your administrator.
        </p>
        {reference && (
          <p style={{ margin: '12px 0 0', fontSize: 13, color: '#374151' }}>
            Reference: <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', userSelect: 'all' }}>{reference}</code>
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {reset && (
            <button type="button" onClick={() => reset()} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #ea580c', background: '#ea580c', color: '#fff', fontSize: 14, cursor: 'pointer' }}>
              Try again
            </button>
          )}
          <button type="button" onClick={() => { window.location.href = '/dashboard' }} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#111827', fontSize: 14, cursor: 'pointer' }}>
            Go to dashboard
          </button>
        </div>
      </div>
    </div>
  )
}
