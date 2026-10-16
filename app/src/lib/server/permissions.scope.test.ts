import { beforeEach, describe, expect, it, vi } from 'vitest'

const reads: string[] = []
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        single: async () => {
          reads.push(table)
          if (table === 'users') return { data: { id: 'u-1', organization_id: 'o-1', department_id: null, role_code: 'R', roles: { role_level: 40 } }, error: null }
          if (table === 'roles') return { data: { permissions: ['view_users'], role_level: 40 }, error: null }
          return { data: null, error: null }
        },
      }
      return builder
    },
  }),
}))

const { checkPermissionForUser, withPermissionEvaluationScope } = await import('./permissions')

beforeEach(() => { reads.length = 0 })

describe('withPermissionEvaluationScope', () => {
  it('reads a user\'s legacy permissions once per evaluation, however many questions it asks', async () => {
    const answers = await withPermissionEvaluationScope(() =>
      Promise.all(['view_users', 'view_settings', 'view_users'].map(key => checkPermissionForUser('u-1', key).then(r => r.allowed))))
    expect(answers).toEqual([true, false, true])
    expect(reads).toEqual(['users', 'roles'])
  })

  it('never carries answers into another evaluation or outside one', async () => {
    await withPermissionEvaluationScope(() => checkPermissionForUser('u-1', 'view_users'))
    await withPermissionEvaluationScope(() => checkPermissionForUser('u-1', 'view_users'))
    await checkPermissionForUser('u-1', 'view_users')
    await checkPermissionForUser('u-1', 'view_users')
    expect(reads).toEqual(['users', 'roles', 'users', 'roles', 'users', 'roles', 'users', 'roles'])
  })
})
