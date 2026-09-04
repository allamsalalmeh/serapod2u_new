import { describe, expect, it } from 'vitest'
import {
  canViewMonitor,
  resolveMonitorScope,
  type MonitorViewer,
} from '@/lib/notifications/monitorScope'

const HQ_ADMIN: MonitorViewer = {
  organizationId: 'e08f8574-e787-482b-b9fc-2b1551720056',
  orgTypeCode: 'HQ',
  roleCode: 'org_admin',
  roleLevel: 20,
}

const SHOP_ADMIN: MonitorViewer = {
  organizationId: 'd83bac94-0722-4901-9ca8-619788eab744',
  orgTypeCode: 'SHOP',
  roleCode: 'org_admin',
  roleLevel: 30,
}

describe('resolveMonitorScope', () => {
  it('gives HQ staff every organization', () => {
    expect(resolveMonitorScope(HQ_ADMIN)).toEqual({ kind: 'all' })
  })

  it('gives platform admins every organization even outside HQ', () => {
    expect(resolveMonitorScope({ ...SHOP_ADMIN, roleCode: 'super_admin' })).toEqual({ kind: 'all' })
  })

  it('limits a shop admin to their own organization', () => {
    expect(resolveMonitorScope(SHOP_ADMIN)).toEqual({
      kind: 'orgs',
      orgIds: ['d83bac94-0722-4901-9ca8-619788eab744'],
    })
  })

  it('never leaks HQ traffic into a shop admin scope', () => {
    const scope = resolveMonitorScope(SHOP_ADMIN)
    expect(scope.kind).toBe('orgs')
    if (scope.kind !== 'orgs') return
    expect(scope.orgIds).not.toContain(HQ_ADMIN.organizationId)
  })

  it('fails closed when the viewer has no organization', () => {
    const scope = resolveMonitorScope({ ...SHOP_ADMIN, organizationId: null })
    expect(scope).toEqual({ kind: 'orgs', orgIds: [] })
  })
})

describe('canViewMonitor', () => {
  it('keeps the existing allow rules', () => {
    expect(canViewMonitor(HQ_ADMIN)).toBe(true)
    expect(canViewMonitor(SHOP_ADMIN)).toBe(true)
    expect(canViewMonitor({ ...SHOP_ADMIN, roleCode: 'staff', roleLevel: 10 })).toBe(true)
    expect(canViewMonitor({ ...HQ_ADMIN, roleCode: 'staff', roleLevel: 40 })).toBe(true)
  })

  it('rejects low-privilege roles outside HQ', () => {
    expect(canViewMonitor({ ...SHOP_ADMIN, roleCode: 'staff', roleLevel: 30 })).toBe(false)
  })

  it('denies an account whose role carries no level', () => {
    expect(canViewMonitor({ ...SHOP_ADMIN, roleCode: 'staff', roleLevel: null })).toBe(false)
    expect(canViewMonitor({ ...HQ_ADMIN, roleCode: 'staff', roleLevel: null })).toBe(false)
  })
})
