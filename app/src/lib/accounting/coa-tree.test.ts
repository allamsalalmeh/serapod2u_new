import { describe, expect, it } from 'vitest'
import { allGroupKeys, buildCoaTree, filterCoaTree, formatCoaBalance, type CoaAccount } from './coa-tree'

const acc = (id: string, code: string, name: string, type: string, subtype: string | null, parent: string | null = null, active = true): CoaAccount =>
  ({ id, code, name, account_type: type, subtype, parent_account_id: parent, is_active: active })

const accounts: CoaAccount[] = [
  acc('a1100', '1100', 'Cash / Bank', 'ASSET', 'Current Asset'),
  acc('a1110', '1110', 'Hong Leong Islamic Bank', 'ASSET', 'Current Asset', 'a1100'),
  acc('a1300', '1300', 'Inventory', 'ASSET', 'Current Asset'),
  acc('a1400', '1400', 'Supplier Deposits', 'ASSET', 'Current Asset'),
  acc('a1700', '1700', 'Office Equipment', 'ASSET', 'Fixed Asset'),
  acc('a2100', '2100', 'Accounts Payable', 'LIABILITY', 'Current Liability'),
  acc('a4100', '4100', 'Sales Revenue', 'INCOME', 'Operating Income'),
  acc('a5100', '5100', 'Cost of Goods Sold', 'EXPENSE', 'Direct Cost'),
  acc('a5900', '5900', 'Old Expense', 'EXPENSE', null, null, false),
]

describe('buildCoaTree', () => {
  const tree = buildCoaTree(accounts, { a1110: -1400, a1300: 1400, a2100: -500, a4100: -36, a5100: 15 })

  it('roots by account type in 1000..5000 order with ERPNext names', () => {
    expect(tree.map((r) => [r.codeLabel, r.name])).toEqual([
      ['1000', 'Application of Funds (Assets)'],
      ['2000', 'Source of Funds (Liabilities)'],
      ['4000', 'Income'],
      ['5000', 'Expenses'],
    ])
  })

  it('groups by subtype with the code range of its accounts', () => {
    const assets = tree[0]
    expect(assets.children.map((g) => [g.name, g.codeLabel])).toEqual([
      ['Current Assets', '1100-1400'],
      ['Fixed Assets', '1700'],
    ])
  })

  it('nests real children and rolls balances up', () => {
    const current = tree[0].children[0]
    const cash = current.children.find((n) => n.key === 'a1100')!
    expect(cash.isGroup).toBe(true)
    expect(cash.children.map((c) => c.codeLabel)).toEqual(['1110'])
    expect(cash.balance).toBe(-1400)
    expect(current.balance).toBe(0)
    expect(tree[1].balance).toBe(-500)
  })

  it('hides inactive accounts unless asked', () => {
    expect(tree[3].children.flatMap((g) => g.children).map((n) => n.codeLabel)).toEqual(['5100'])
    const all = buildCoaTree(accounts, {}, true)
    expect(all[3].children.map((g) => g.name)).toEqual(['Direct Costs', 'Other'])
  })

  it('filters by code or name and expands the path', () => {
    const { tree: f, expand } = filterCoaTree(tree, '1110')
    expect(f).toHaveLength(1)
    expect(f[0].children[0].children[0].children[0].codeLabel).toBe('1110')
    expect([...expand]).toEqual(expect.arrayContaining(['type:ASSET', 'a1100']))
    expect(filterCoaTree(tree, 'zzz').tree).toEqual([])
  })

  it('formats balances and lists group keys', () => {
    expect(formatCoaBalance(1400)).toBe('RM 1,400.00 Dr')
    expect(formatCoaBalance(-980)).toBe('RM 980.00 Cr')
    expect(formatCoaBalance(0)).toBe('RM 0.00 Cr')
    expect(allGroupKeys(tree)).toContain('a1100')
  })
})
