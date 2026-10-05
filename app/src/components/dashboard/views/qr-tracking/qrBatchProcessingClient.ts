/**
 * Browser-side trigger for POST /api/qr-batches/process.
 *
 * Processes one batch the signed-in user's organization owns. The request
 * carries only the session cookies - never CRON_SECRET - and never reaches the
 * global cron worker. Any non-2xx response is thrown as an Error carrying the
 * server's own message, so a 401/403/404/409/500/503 can never be mistaken for
 * a completed run.
 */

export const QR_BATCH_PROCESS_PATH = '/api/qr-batches/process'

/** Same marker as LEASE_SKIPPED in '@/lib/cron/lease' (kept local: that module is server-only). */
const LEASE_SKIPPED = 'SKIPPED_ALREADY_RUNNING'
/** Body marker of lib/cron/remote-db-guard (HTTP 409). */
export const REMOTE_DB_WORKER_BLOCKED = 'REMOTE_DB_WORKER_BLOCKED'

export type QRWorkerRunOutcome =
  /** Nothing left to process. */
  | 'idle'
  /** Another run (usually the scheduled cron) holds the worker lease; poll again. */
  | 'busy'
  /** This run yielded with work remaining; call again. */
  | 'progress'
  /** The batch is no longer queued/processing. */
  | 'complete'
  /** This (local) process may not run workers against the remote DB; the batch is confirmed queued for the deployed worker. */
  | 'waiting_for_worker'

export class QRWorkerRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'QRWorkerRequestError'
    this.status = status
  }
}

type WorkerBody = {
  message?: unknown
  error?: unknown
  details?: unknown
  status?: unknown
  hasMore?: unknown
  batch_status?: unknown
}

function describeFailure(status: number, body: WorkerBody | null): string {
  const parts = [body?.error, body?.details, body?.message]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
  const detail = parts.length > 0 ? parts.join(': ') : 'No response details'
  return `QR batch processing failed (HTTP ${status}): ${detail}`
}

/** Maps a processing response to an outcome, throwing on any failure. */
export async function interpretQRWorkerResponse(response: Response): Promise<QRWorkerRunOutcome> {
  let body: WorkerBody | null = null
  try {
    body = (await response.json()) as WorkerBody
  } catch {
    body = null
  }

  // The one 409 that is not a failure: the guard refused to run here AND the API confirmed the batch is still
  // queued/processing. Any other 409 (or a guard reply without that confirmation) stays an error.
  if (response.status === 409 && body?.status === REMOTE_DB_WORKER_BLOCKED && (body.batch_status === 'queued' || body.batch_status === 'processing')) {
    return 'waiting_for_worker'
  }

  if (!response.ok) {
    throw new QRWorkerRequestError(response.status, describeFailure(response.status, body))
  }

  if (!body) {
    throw new QRWorkerRequestError(response.status, 'QR batch processing returned an unreadable response')
  }

  if (body.message === 'No batches to process') return 'idle'
  if (body.status === LEASE_SKIPPED || body.message === 'Batch claimed by another worker') return 'busy'
  if (body.hasMore === true) return 'progress'
  if (body.hasMore === false) return 'complete'

  // A 2xx the UI does not recognise is not proof the batch finished.
  throw new QRWorkerRequestError(
    response.status,
    `QR batch processing returned an unexpected response: ${JSON.stringify(body)}`
  )
}

export async function triggerQRBatchProcessing(
  batchId: string,
  fetchImpl: typeof fetch = fetch
): Promise<QRWorkerRunOutcome> {
  const response = await fetchImpl(QR_BATCH_PROCESS_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch_id: batchId }),
  })
  return interpretQRWorkerResponse(response)
}
