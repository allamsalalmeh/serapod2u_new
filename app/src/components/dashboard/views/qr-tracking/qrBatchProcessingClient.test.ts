import { describe, expect, it, vi } from 'vitest'
import {
  QR_BATCH_PROCESS_PATH,
  QRWorkerRequestError,
  interpretQRWorkerResponse,
  triggerQRBatchProcessing,
} from './qrBatchProcessingClient'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('interpretQRWorkerResponse', () => {
  it('throws on 401 instead of reporting a completed run', async () => {
    await expect(interpretQRWorkerResponse(json({ error: 'Unauthorized' }, 401))).rejects.toBeInstanceOf(QRWorkerRequestError)
    await expect(interpretQRWorkerResponse(json({ error: 'Unauthorized' }, 401))).rejects.toThrow(
      'QR batch processing failed (HTTP 401): Unauthorized'
    )
  })

  it('surfaces the worker failure details on 500', async () => {
    const res = json({ error: 'Worker failed', details: 'Failed to upload Excel: bucket not found' }, 500)

    await expect(interpretQRWorkerResponse(res)).rejects.toMatchObject({
      status: 500,
      message: 'QR batch processing failed (HTTP 500): Worker failed: Failed to upload Excel: bucket not found',
    })
  })

  it('throws on 403, 404, 409 remote-DB block and 503 lease-unavailable responses', async () => {
    await expect(interpretQRWorkerResponse(json({ error: 'Forbidden' }, 403))).rejects.toMatchObject({ status: 403 })
    await expect(interpretQRWorkerResponse(json({ error: 'Batch not found' }, 404))).rejects.toMatchObject({ status: 404 })
    await expect(
      interpretQRWorkerResponse(
        json({ error: 'Background worker disabled for a local process connected to a remote database', details: 'NODE_ENV=development' }, 409)
      )
    ).rejects.toThrow('HTTP 409): Background worker disabled')
    await expect(
      interpretQRWorkerResponse(json({ status: 'LEASE_UNAVAILABLE', message: 'Worker lease unavailable; run skipped' }, 503))
    ).rejects.toThrow('HTTP 503')
  })

  it('treats the remote-DB guard 409 as "waiting" only when the API confirms the batch is queued', async () => {
    const guard = { error: 'Background worker disabled for a local process connected to a remote database', status: 'REMOTE_DB_WORKER_BLOCKED' }
    await expect(interpretQRWorkerResponse(json({ ...guard, batch_id: 'b', batch_status: 'queued' }, 409))).resolves.toBe('waiting_for_worker')
    await expect(interpretQRWorkerResponse(json({ ...guard, batch_id: 'b', batch_status: 'processing' }, 409))).resolves.toBe('waiting_for_worker')
    // No confirmation, a failed batch, or any other 409: still an error.
    await expect(interpretQRWorkerResponse(json(guard, 409))).rejects.toMatchObject({ status: 409 })
    await expect(interpretQRWorkerResponse(json({ ...guard, batch_status: 'failed' }, 409))).rejects.toMatchObject({ status: 409 })
    await expect(interpretQRWorkerResponse(json({ error: 'conflict', batch_status: 'queued' }, 409))).rejects.toMatchObject({ status: 409 })
  })

  it('throws on a non-JSON error page', async () => {
    const res = new Response('<html>Bad Gateway</html>', { status: 502 })

    await expect(interpretQRWorkerResponse(res)).rejects.toThrow('QR batch processing failed (HTTP 502): No response details')
  })

  it('does not treat an unrecognised 2xx body as completion', async () => {
    await expect(interpretQRWorkerResponse(json({ ok: true }))).rejects.toThrow('unexpected response')
  })

  it('maps successful responses to outcomes', async () => {
    await expect(interpretQRWorkerResponse(json({ message: 'No batches to process' }))).resolves.toBe('idle')
    await expect(
      interpretQRWorkerResponse(json({ status: 'SKIPPED_ALREADY_RUNNING', worker: 'qr-generation-worker', processed: 0 }))
    ).resolves.toBe('busy')
    await expect(interpretQRWorkerResponse(json({ message: 'Batch claimed by another worker' }))).resolves.toBe('busy')
    await expect(
      interpretQRWorkerResponse(json({ success: true, message: 'Worker run completed (more work remaining)', hasMore: true }))
    ).resolves.toBe('progress')
    await expect(
      interpretQRWorkerResponse(json({ success: true, message: 'Batch processing COMPLETED!', hasMore: false }))
    ).resolves.toBe('complete')
    await expect(
      interpretQRWorkerResponse(json({ success: true, message: 'Batch is already generated', status: 'generated', hasMore: false }))
    ).resolves.toBe('complete')
  })
})

describe('triggerQRBatchProcessing', () => {
  it('posts only the batch id, same-origin, with no Authorization header and never the cron route', async () => {
    const fetchImpl = vi.fn(async () => json({ success: true, hasMore: false }))

    await expect(triggerQRBatchProcessing('batch-123', fetchImpl as unknown as typeof fetch)).resolves.toBe('complete')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(QR_BATCH_PROCESS_PATH)
    expect(url).not.toContain('/api/cron/')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(JSON.parse(String(init.body))).toEqual({ batch_id: 'batch-123' })
    expect(new Headers(init.headers).has('authorization')).toBe(false)
  })

  it('rejects when the server responds non-2xx', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'Unauthorized' }, 401))

    await expect(triggerQRBatchProcessing('batch-123', fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ status: 401 })
  })
})
