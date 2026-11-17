/**
 * Chart of Accounts as a tree (ERPNext-style): company -> account type -> subtype -> accounts.
 *
 * Accounts linked by parent_account_id nest under their parent. Accounts without a parent
 * are grouped under a root per account type (Assets 1000, Liabilities 2000, ...) and a
 * group per subtype (Current Assets, Fixed Assets, ...). These groups are for display only;
 * nothing is written to gl_accounts. Group balances are the sum of their accounts.
 */

export type CoaAccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE'

export interface CoaAccount {
  id: string
  code: string
  name: string
  account_type: CoaAccountType | string
  subtype: string | null
  parent_account_id: string | null
  is_active: boolean
}

export interface CoaNode {
  /** Account id, or "type:ASSET" / "sub:ASSET:Current Asset" for display groups. */
  key: string
  name: string
  /** Account code, or the code range of the accounts below a group ("1100-1600"). */
  codeLabel: string
  isGroup: boolean
  /** True for groups made here (type / subtype), false for real accounts. */
  isVirtual: boolean
  account: CoaAccount | null
  accountType: string
  subtype: string | null
  /** Net debit minus credit, including all accounts below. */
  balance: number
  isActive: boolean
  children: CoaNode[]
}

const ROOTS: { type: CoaAccountType; name: string; code: string }[] = [
  { type: 'ASSET', name: 'Application of Funds (Assets)', code: '1000' },
  { type: 'LIABILITY', name: 'Source of Funds (Liabilities)', code: '2000' },
  { type: 'EQUITY', name: 'Equity', code: '3000' },
  { type: 'INCOME', name: 'Income', code: '4000' },
  { type: 'EXPENSE', name: 'Expenses', code: '5000' },
]

const SUBTYPE_PLURALS: Record<string, string> = {
  'current asset': 'Current Assets',
  'fixed asset': 'Fixed Assets',
  'non-current asset': 'Non-Current Assets',
  'current liability': 'Current Liabilities',
  'long term liability': 'Long Term Liabilities',
  'long-term liability': 'Long Term Liabilities',
  'direct cost': 'Direct Costs',
  'operating expense': 'Operating Expenses',
  'other income': 'Other Income',
  'operating income': 'Operating Income',
}

export function subtypeGroupName(subtype: string | null | undefined): string {
  const s = String(subtype || '').trim()
  if (!s) return 'Other'
  return SUBTYPE_PLURALS[s.toLowerCase()] || s
}

const byCode = (a: CoaNode, b: CoaNode) =>
  a.codeLabel.localeCompare(b.codeLabel, undefined, { numeric: true }) || a.name.localeCompare(b.name)

function leafCodes(node: CoaNode): string[] {
  if (!node.isVirtual) return [node.account!.code]
  return node.children.flatMap(leafCodes)
}

function codeRange(codes: string[]): string {
  const sorted = [...new Set(codes)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (sorted.length === 0) return ''
  return sorted.length === 1 ? sorted[0] : `${sorted[0]}-${sorted[sorted.length - 1]}`
}

/** Sums balances bottom-up and sorts children by code. */
function finish(node: CoaNode): number {
  node.children.sort(byCode)
  const own = node.isVirtual ? 0 : node.balance
  node.balance = own + node.children.reduce((s, c) => s + finish(c), 0)
  return node.balance
}

/**
 * @param balances net debit-minus-credit per account id
 * @param showDisabled include inactive accounts
 */
export function buildCoaTree(
  accounts: CoaAccount[],
  balances: Record<string, number> = {},
  showDisabled = false,
): CoaNode[] {
  const visible = accounts.filter((a) => showDisabled || a.is_active)
  const nodes = new Map<string, CoaNode>()
  for (const a of visible) {
    nodes.set(a.id, {
      key: a.id,
      name: a.name,
      codeLabel: a.code,
      isGroup: false,
      isVirtual: false,
      account: a,
      accountType: a.account_type,
      subtype: a.subtype,
      balance: Number(balances[a.id]) || 0,
      isActive: a.is_active,
      children: [],
    })
  }

  const roots = new Map<string, CoaNode>()
  const rootFor = (type: string): CoaNode => {
    let r = roots.get(type)
    if (!r) {
      const def = ROOTS.find((x) => x.type === type)
      r = {
        key: `type:${type}`,
        name: def?.name || type,
        codeLabel: def?.code || '',
        isGroup: true,
        isVirtual: true,
        account: null,
        accountType: type,
        subtype: null,
        balance: 0,
        isActive: true,
        children: [],
      }
      roots.set(type, r)
    }
    return r
  }
  const subFor = (type: string, subtype: string | null): CoaNode => {
    const root = rootFor(type)
    const name = subtypeGroupName(subtype)
    const key = `sub:${type}:${name}`
    let g = root.children.find((c) => c.key === key)
    if (!g) {
      g = {
        key,
        name,
        codeLabel: '',
        isGroup: true,
        isVirtual: true,
        account: null,
        accountType: type,
        subtype: subtype ? String(subtype).trim() : null,
        balance: 0,
        isActive: true,
        children: [],
      }
      root.children.push(g)
    }
    return g
  }

  for (const node of nodes.values()) {
    const parentId = node.account!.parent_account_id
    const parent = parentId ? nodes.get(parentId) : undefined
    if (parent && parent !== node) {
      parent.children.push(node)
      parent.isGroup = true
    } else {
      subFor(node.accountType, node.subtype).children.push(node)
    }
  }

  const ordered = ROOTS.map((r) => roots.get(r.type)).filter(Boolean) as CoaNode[]
  for (const [type, r] of roots) if (!ROOTS.some((x) => x.type === type)) ordered.push(r)

  for (const r of ordered) {
    finish(r)
    for (const g of r.children) if (g.isVirtual) g.codeLabel = codeRange(leafCodes(g))
    r.children.sort(byCode)
  }
  return ordered
}

/** Keeps nodes that match (code or name) and their ancestors; returns keys to expand. */
export function filterCoaTree(tree: CoaNode[], query: string): { tree: CoaNode[]; expand: Set<string> } {
  const q = query.trim().toLowerCase()
  const expand = new Set<string>()
  if (!q) return { tree, expand }
  const visit = (n: CoaNode): CoaNode | null => {
    const kids = n.children.map(visit).filter(Boolean) as CoaNode[]
    const hit = n.name.toLowerCase().includes(q) || (!n.isVirtual && n.codeLabel.toLowerCase().includes(q))
    if (!hit && kids.length === 0) return null
    if (kids.length > 0) expand.add(n.key)
    return { ...n, children: hit && kids.length === 0 ? n.children : kids }
  }
  return { tree: tree.map(visit).filter(Boolean) as CoaNode[], expand }
}

/** "RM 1,400.00 Dr" / "RM 980.00 Cr" (zero shows as Cr, like ERPNext). */
export function formatCoaBalance(balance: number): string {
  const v = Math.round(balance * 100) / 100
  const side = v > 0 ? 'Dr' : 'Cr'
  return `RM ${Math.abs(v).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${side}`
}

/** Keys of every group, for "Expand all". */
export function allGroupKeys(tree: CoaNode[]): string[] {
  const out: string[] = []
  const walk = (n: CoaNode) => {
    if (n.children.length > 0) out.push(n.key)
    n.children.forEach(walk)
  }
  tree.forEach(walk)
  return out
}
