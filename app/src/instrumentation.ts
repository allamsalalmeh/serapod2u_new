/**
 * Next.js Instrumentation Hook
 * Runs once when the server starts up.
 *
 * Used to bootstrap the internal cron scheduler on persistent
 * servers (Coolify / Docker / VPS). Skipped on serverless platforms.
 */
export async function register() {
  // Only run on the Node.js server runtime, not in the browser or edge
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Skip on serverless platforms where background intervals are unreliable
    const isServerless =
      process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.SERVERLESS === 'true'

    if (!isServerless) {
      const { startCronScheduler } = await import('@/lib/cron-scheduler')
      startCronScheduler()
    } else {
      console.log('[Instrumentation] Serverless detected — cron scheduler disabled')
    }
  }
}

/**
 * Next.js server error hook: uncaught failures in server component renders, route handlers and server actions.
 * Recorded in System Logs (sanitized, bounded, never throws); Next.js's own error handling and logging are unchanged.
 * Handled failures (a route that catches and returns 500) are reported explicitly with reportServerError.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routerKind: string; routePath: string; routeType: string; renderSource?: string },
) {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { reportRequestError } = await import('@/lib/system-logs/server')
    await reportRequestError(error, request, context)
  } catch {
    // Diagnostics must never change how Next.js handles the original error.
  }
}
