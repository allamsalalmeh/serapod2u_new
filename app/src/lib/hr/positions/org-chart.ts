import type { PositionChartNode } from './types'

/**
 * Build a multi-root position hierarchy from a flat list of nodes.
 *
 * This is the client/server mirror of the `hr_position_org_chart(uuid, date)`
 * SQL function. It deliberately supports MULTIPLE roots (co-equal Managing
 * Directors) and does NOT synthesize a dummy "CEO" root — positions with no
 * active PRIMARY parent are roots. Cycles are broken by ignoring a child edge
 * that would revisit a node already on its path.
 */

interface FlatNode {
  id: string
  position_code: string
  name: string
  parent_position_id: string | null
  relationship_type: string
  incumbent_user_id: string | null
  incumbent_name: string | null
  occupancy: 'FILLED' | 'VACANT'
}

/**
 * Build the tree. Returns roots sorted deterministically (by position_code).
 * A node whose parent is missing from the set becomes a root (never dropped),
 * so vacant or detached positions remain visible.
 */
export function buildPositionTree(nodes: readonly FlatNode[]): PositionChartNode[] {
  const byId = new Map<string, PositionChartNode>()
  for (const n of nodes) {
    byId.set(n.id, {
      id: n.id,
      position_code: n.position_code,
      name: n.name,
      parent_position_id: n.parent_position_id,
      relationship_type: n.relationship_type as PositionChartNode['relationship_type'],
      incumbent_user_id: n.incumbent_user_id,
      incumbent_name: n.incumbent_name,
      occupancy: n.occupancy,
      depth: 0,
      children: [],
    })
  }

  const roots: PositionChartNode[] = []

  const attach = (node: PositionChartNode, ancestors: Set<string>): void => {
    const parent = node.parent_position_id ? byId.get(node.parent_position_id) : undefined
    if (parent && !ancestors.has(parent.id)) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  for (const n of nodes) {
    const node = byId.get(n.id)!
    // Walk up from the node to determine which ancestor chain is valid, breaking cycles.
    const chain = new Set<string>([node.id])
    let cursor: PositionChartNode | undefined = node.parent_position_id ? byId.get(node.parent_position_id) : undefined
    while (cursor) {
      if (chain.has(cursor.id)) {
        // Cycle: this node cannot be attached under its own subtree — treat as root.
        node.parent_position_id = null
        break
      }
      chain.add(cursor.id)
      cursor = cursor.parent_position_id ? byId.get(cursor.parent_position_id) : undefined
    }
  }

  // Second pass: attach (roots are those with null parent or missing parent).
  for (const n of nodes) {
    const node = byId.get(n.id)!
    const parent = node.parent_position_id ? byId.get(node.parent_position_id) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const assignDepth = (node: PositionChartNode, depth: number): void => {
    node.depth = depth
    node.children.sort((a, b) => a.position_code.localeCompare(b.position_code))
    node.children.forEach((c) => assignDepth(c, depth + 1))
  }

  roots.sort((a, b) => a.position_code.localeCompare(b.position_code))
  roots.forEach((r) => assignDepth(r, 0))
  return roots
}
