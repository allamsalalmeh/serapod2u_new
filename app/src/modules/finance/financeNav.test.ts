import { describe, expect, it } from 'vitest'
import { filterFinanceNavGroups } from './financeNav'
import { computeDestinations } from '@/lib/security-access/nav-access'

const allowsFor = (org: string[]) => {
  const d = computeDestinations({ org: Object.fromEntries(org.map(p => [p, true])), self: {} })
  return (id: string) => d[id] === true
}

describe('filterFinanceNavGroups', () => {
  it('Finance Full Access: every group', () => {
    const groups = filterFinanceNavGroups(allowsFor(['finance.module.view', 'finance.ledger.view', 'finance.receivable.view', 'finance.payable.view', 'finance.cash.view', 'finance.report.view_sensitive', 'finance.settings.manage']))
    expect(groups.map(g => g.id)).toEqual(['finance-gl', 'finance-ar', 'finance-ap', 'finance-cash', 'finance-reports', 'finance-settings'])
  })

  it('AP clerk: payables (and the ledger) only; Cash & Banking, Receivables and Reports hidden', () => {
    const groups = filterFinanceNavGroups(allowsFor(['finance.module.view', 'finance.ledger.view', 'finance.payable.view']))
    expect(groups.map(g => g.id)).toEqual(['finance-gl', 'finance-ap', 'finance-settings'])
  })

  it('module entry alone: only the informational Finance Permissions entry', () => {
    const groups = filterFinanceNavGroups(allowsFor(['finance.module.view']))
    expect(groups.flatMap(g => g.children.map(c => c.id))).toEqual(['finance/settings/permissions'])
  })

  it('nothing while access is unresolved', () => {
    expect(filterFinanceNavGroups(() => false)).toEqual([])
  })
})
