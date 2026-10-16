import { describe, expect, it } from 'vitest'
import { loadStaffChart, projectStaffChart } from './staff-org-chart'

const rows = [
  { id: 'u-ceo', full_name: 'Aisha CEO', manager_user_id: null, positions: { name: 'CEO' }, departments: { dept_name: 'Executive' },
    // Sensitive columns that must never survive projection, even if a caller over-selected:
    email: 'aisha@x.test', phone: '+60123456789', salary: 99999, nric: '900101-01-1234', address: 'Home', personal_email: 'p@x.test' },
  { id: 'u-2', full_name: 'Ben Ops', manager_user_id: 'u-ceo', positions: [{ name: 'Ops Lead' }], departments: [{ dept_name: 'Operations' }] },
  { id: 'u-3', full_name: '  ', manager_user_id: 'u-outside', positions: null, departments: null },
  { id: 'u-4', full_name: 'Self Loop', manager_user_id: 'u-4', positions: null, departments: null },
] as any[]

describe('staff organization chart projection', () => {
  const nodes = projectStaffChart(rows, 'u-2')

  it('exposes exactly name, job title, department and the reporting line (plus an opaque key and a self flag)', () => {
    for (const node of nodes) expect(Object.keys(node).sort()).toEqual(['department', 'isSelf', 'jobTitle', 'key', 'managerKey', 'name'])
    const serialized = JSON.stringify(nodes)
    for (const secret of ['aisha@x.test', '+60123456789', '99999', '900101', 'Home', 'p@x.test', 'u-ceo', 'u-2', 'u-outside']) {
      expect(serialized, secret).not.toContain(secret)
    }
  })

  it('builds the reporting line with opaque keys and marks only the viewer', () => {
    expect(nodes[1]).toMatchObject({ name: 'Ben Ops', jobTitle: 'Ops Lead', department: 'Operations', managerKey: nodes[0].key, isSelf: true })
    expect(nodes.filter(n => n.isSelf)).toHaveLength(1)
    expect(nodes[0].managerKey).toBeNull()
  })

  it('treats a manager outside the chart or a self-reference as a root, and never invents a name', () => {
    expect(nodes[2]).toMatchObject({ name: 'Unnamed', managerKey: null, jobTitle: null, department: null })
    expect(nodes[3].managerKey).toBeNull()
  })
})

describe('loadStaffChart', () => {
  const builder = (result: any) => {
    const calls: Array<[string, ...unknown[]]> = []
    const chain: any = new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === 'then') return (resolve: any) => resolve(result)
        return (...args: unknown[]) => { calls.push([prop, ...args]); return chain }
      },
    })
    return { admin: { from: (table: string) => { calls.push(['from', table]); return chain } }, calls }
  }

  it('reads only the minimum columns, only the caller\'s organization, only completed active employees', async () => {
    const { admin, calls } = builder({ data: rows.slice(0, 2), error: null })
    await loadStaffChart(admin, 'org-hq', 'u-2')
    const select = String(calls.find(c => c[0] === 'select')![1])
    for (const forbidden of ['email', 'phone', 'salary', 'nric', 'address', 'avatar', 'birth', 'bank', 'join_date']) expect(select, forbidden).not.toContain(forbidden)
    expect(calls).toContainEqual(['eq', 'organization_id', 'org-hq'])
    expect(calls).toContainEqual(['eq', 'hr_employees.onboarding_status', 'completed'])
    expect(calls).toContainEqual(['eq', 'is_active', true])
  })

  it('fails closed when the read fails', async () => {
    const { admin } = builder({ data: null, error: { message: 'boom' } })
    await expect(loadStaffChart(admin, 'org-hq', 'u-2')).rejects.toThrow('staff_chart_unavailable')
  })
})
