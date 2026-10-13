import { describe, expect, it, vi } from 'vitest'
import { classifyError, createTrace, isSchemaMissing } from './diagnostics'

describe('classifyError', () => {
  it('separates transport failures from database answers', () => {
    expect(classifyError({ code: '', message: 'AbortError: The operation was aborted due to timeout' })).toEqual({ classification: 'timeout', code: null })
    expect(classifyError({ code: '', message: 'TypeError: fetch failed' })).toEqual({ classification: 'network', code: null })
    expect(classifyError({ code: '57014', message: 'canceling statement' })).toEqual({ classification: 'database', code: '57014' })
    expect(classifyError({ code: 'PGRST205', message: 'missing' })).toEqual({ classification: 'schema_missing', code: 'PGRST205' })
    expect(classifyError(null)).toEqual({ classification: 'unknown', code: null })
  })
  it('only a missing relation counts as schema-not-ready', () => {
    expect(isSchemaMissing({ code: '42P01' })).toBe(true)
    expect(isSchemaMissing({ code: '', message: 'fetch failed' })).toBe(false)
    expect(isSchemaMissing({ code: '08006' })).toBe(false)
  })
})

describe('createTrace', () => {
  it('logs one sanitized line with phases, outcome and failures only (no messages)', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const trace = createTrace('test/route', 'corr-1')
    await trace.time('session', async () => 1)
    trace.fail('audit', { code: '', message: 'secret token abc fetch failed' })
    trace.outcome('ALLOW:ALLOWED_BY_ASSIGNMENT')
    const timing = trace.end(503)
    expect(timing).toMatch(/^session;dur=\d+, total;dur=\d+$/)
    const line = String(log.mock.calls[0][1])
    expect(JSON.parse(line)).toMatchObject({ route: 'test/route', id: 'corr-1', status: 503, authorization: 'ALLOW:ALLOWED_BY_ASSIGNMENT', failures: [{ phase: 'audit', classification: 'network', code: null }] })
    expect(line).not.toContain('secret')
    log.mockRestore()
  })
  it('stays quiet for fast successful requests', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    createTrace('quiet').end(200)
    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
  })
})
