import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient }))

import { COMMISSION_RELEASE_ENV, commissionReleased } from './release'
import { commissionContext } from '@/lib/server/commission/route-kit'

const src = (p: string) => readFileSync(resolve(process.cwd(), 'src', p), 'utf8')

describe('Staff Sales Commission release switch', () => {
  const saved = process.env[COMMISSION_RELEASE_ENV]
  beforeEach(() => { createClient.mockReset(); delete process.env[COMMISSION_RELEASE_ENV] })
  afterEach(() => { if (saved === undefined) delete process.env[COMMISSION_RELEASE_ENV]; else process.env[COMMISSION_RELEASE_ENV] = saved })

  it('is off unless the environment says exactly "true"', () => {
    expect(commissionReleased({})).toBe(false)
    for (const v of ['', 'false', '1', 'TRUE', 'yes']) expect(commissionReleased({ [COMMISSION_RELEASE_ENV]: v }), v).toBe(false)
    expect(commissionReleased({ [COMMISSION_RELEASE_ENV]: 'true' })).toBe(true)
  })

  it('off: every commission API answers 404 before any session or database call', async () => {
    const res = await commissionContext()
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(404)
    expect(await (res as Response).json()).toMatchObject({ code: 'commission_not_released' })
    expect(createClient).not.toHaveBeenCalled()
  })

  it('on: the database decides as before (no widening)', async () => {
    process.env[COMMISSION_RELEASE_ENV] = 'true'
    const rpc = vi.fn().mockResolvedValue({ data: { company_id: 'c1', 'hr.commission.view': false }, error: null })
    createClient.mockResolvedValue({ auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }) }, rpc })
    const ctx = await commissionContext()
    expect(ctx).not.toBeInstanceOf(Response)
    expect(rpc).toHaveBeenCalledWith('hr_commission_my_access')
    expect((ctx as any).access['hr.commission.view']).toBe(false)
  })

  it('every commission API route goes through commissionContext, so the switch covers all of them', () => {
    const routes = ['access', 'business-units', 'cycles', 'cycles/[cycleId]', 'employees/[userId]', 'reference', 'report', 'report/drilldown', 'report/export', 'requests', 'settings']
    for (const r of routes) expect(src(`app/api/hr/commission/${r}/route.ts`), r).toContain('commissionContext()')
  })

  it('the page 404s and the sidebar destination is forced off while unreleased', () => {
    const page = src('app/hr/payroll/commission-settings/page.tsx')
    expect(page).toMatch(/if \(!commissionReleased\(\)\) notFound\(\)/)
    expect(page).toContain("export const dynamic = 'force-dynamic'") // switch read at request time, not at build
    const nav = src('lib/server/nav-access.ts')
    expect(nav).toContain('destinations: withoutUnreleased(computeDestinations(answers))')
    expect(nav).toContain("const COMMISSION_SETTINGS_DESTINATION = 'hr/payroll/commission-settings'")
  })

  it('People and Reporting tabs depend on the access API (404 → no access → tab hidden)', () => {
    const hook = src('lib/hr/commission/use-commission-access.ts')
    expect(hook).toContain("fetch('/api/hr/commission/access'")
    expect(hook).toContain('r.ok ? r.json() : null')
    expect(src('components/hr/HrPeopleView.tsx')).toContain("commissionAccess.can('hr.commission.view')")
    expect(src('components/dashboard/views/reporting/ReportingView.tsx')).toContain("commissionAccess.can('reporting.commission.view')")
  })
})
