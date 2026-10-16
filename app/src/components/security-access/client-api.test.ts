// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { callApi } from './client-api'
import { NAV_ACCESS_CHANGED_EVENT } from '@/hooks/useNavAccess'

afterEach(() => vi.unstubAllGlobals())
const respond = (ok: boolean, body: unknown = {}) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok, status: ok ? 200 : 400, json: async () => body })))

describe('callApi tells the shell when access changed', () => {
  it('after a successful change, so stale navigation answers are re-read', async () => {
    respond(true)
    const heard = vi.fn()
    window.addEventListener(NAV_ACCESS_CHANGED_EVENT, heard)
    await callApi('/api/security-access/assignments', { method: 'DELETE', body: { id: 'a-1' } })
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener(NAV_ACCESS_CHANGED_EVENT, heard)
  })
  it('not for reads and not for failed changes', async () => {
    const heard = vi.fn()
    window.addEventListener(NAV_ACCESS_CHANGED_EVENT, heard)
    respond(true)
    await callApi('/api/security-access/overview')
    respond(false, { error: 'nope' })
    await callApi('/api/security-access/assignments', { body: { id: 'a-1' } })
    expect(heard).not.toHaveBeenCalled()
    window.removeEventListener(NAV_ACCESS_CHANGED_EVENT, heard)
  })
})
