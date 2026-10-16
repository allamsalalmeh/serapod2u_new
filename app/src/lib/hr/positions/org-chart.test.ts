import { describe, expect, it } from 'vitest'
import { buildPositionTree } from './org-chart'

const node = (id: string, parent: string | null, code = id) => ({
  id,
  position_code: code,
  name: code,
  parent_position_id: parent,
  relationship_type: 'PRIMARY',
  incumbent_user_id: null,
  incumbent_name: null,
  occupancy: 'VACANT' as const,
})

describe('buildPositionTree — multi-root (co-equal Managing Directors)', () => {
  it('renders two Managing Directors as two roots, neither subordinate to the other', () => {
    const tree = buildPositionTree([
      node('MD1', null, 'MD-001'),
      node('MD2', null, 'MD-002'),
      node('GM', 'MD1', 'GM-001'),
    ])
    expect(tree).toHaveLength(2)
    expect(tree.map((n) => n.id).sort()).toEqual(['MD1', 'MD2'])
    // GM is under MD1 only, never under MD2.
    const md1 = tree.find((n) => n.id === 'MD1')!
    expect(md1.children.map((c) => c.id)).toEqual(['GM'])
    const md2 = tree.find((n) => n.id === 'MD2')!
    expect(md2.children).toHaveLength(0)
  })

  it('does not synthesize a dummy CEO root', () => {
    const tree = buildPositionTree([node('MD1', null, 'MD-001'), node('MD2', null, 'MD-002')])
    expect(tree).toHaveLength(2)
    expect(tree.some((n) => n.id === 'CEO')).toBe(false)
  })

  it('keeps vacant and detached positions visible as roots', () => {
    const tree = buildPositionTree([
      node('MD1', null, 'MD-001'),
      node('VACANT', null, 'WH-OP-003'),
      node('DETACHED', 'MISSING-PARENT', 'DET-001'),
    ])
    expect(tree).toHaveLength(3)
  })

  it('breaks a reporting cycle by demoting the cyclic edge to a root', () => {
    const tree = buildPositionTree([
      node('A', 'C', 'A'),
      node('B', 'A', 'B'),
      node('C', 'B', 'C'),
    ])
    // No infinite loop; a cycle is broken so at least one node becomes a root.
    const ids = new Set<string>()
    const walk = (nodes: typeof tree) => nodes.forEach((n) => { ids.add(n.id); walk(n.children) })
    walk(tree)
    expect(ids).toEqual(new Set(['A', 'B', 'C']))
    expect(tree.length).toBeGreaterThan(0)
  })

  it('assigns correct depth and sorts children by code', () => {
    const tree = buildPositionTree([
      node('MD1', null, 'MD-001'),
      node('GM', 'MD1', 'GM-001'),
      node('WH-MGR', 'GM', 'WH-MGR-001'),
      node('WH-OP-002', 'WH-MGR', 'WH-OP-002'),
      node('WH-OP-001', 'WH-MGR', 'WH-OP-001'),
    ])
    const md1 = tree[0]
    expect(md1.depth).toBe(0)
    const gm = md1.children[0]
    expect(gm.depth).toBe(1)
    const mgr = gm.children[0]
    expect(mgr.depth).toBe(2)
    expect(mgr.children.map((c) => c.position_code)).toEqual(['WH-OP-001', 'WH-OP-002'])
  })
})
