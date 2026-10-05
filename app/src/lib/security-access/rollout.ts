/**
 * Security & Access → Overview read model. Presentation only: groups the
 * current authorization modes by the existing permission groups
 * (labels.ts) and summarises recorded access differences. Nothing here
 * participates in an authorization decision.
 */
import { modeLabel, permissionLabel } from './labels'
import { MODULE_TAXONOMY, OTHER_MODULE, classifyPermission as classifyModule, type ModuleGroup } from './modules'

/** Overview presentation per mode; wording comes from the shared vocabulary (labels.ts). */
const ROLLOUT_STYLE: Record<string, { shortLabel: string; dot: string; text: string }> = {
  NEW_ENFORCED: { shortLabel: 'Active', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  SHADOW: { shortLabel: 'Monitoring', dot: 'bg-blue-500', text: 'text-blue-700' },
  LEGACY_RETIRED: { shortLabel: 'Retired', dot: 'bg-purple-500', text: 'text-purple-700' },
  LEGACY_ENFORCED: { shortLabel: 'Legacy', dot: 'bg-gray-400', text: 'text-gray-700' },
}

/** Column order: the three rollout columns first, then any other mode present. */
export const PRIMARY_ROLLOUT_MODES = ['NEW_ENFORCED', 'SHADOW', 'LEGACY_RETIRED'] as const

export function rolloutMode(mode: string) {
  const style = ROLLOUT_STYLE[mode]
  const shared = modeLabel(mode)
  if (!style) return { label: mode, shortLabel: mode, help: 'Unrecognised mode.', dot: 'bg-gray-400', text: 'text-gray-700' }
  return { label: shared.label, shortLabel: style.shortLabel, help: shared.help, dot: style.dot, text: style.text }
}

export interface ModeRow {
  permission_key: string
  mode: string
  enforcementReady?: boolean
}

export interface RolloutPermission {
  key: string
  label: string
  mode: string
  enforcementReady: boolean
}

export interface RolloutNode {
  /** Stable identifier (derived from permission-key modules/resources, never display text). */
  id: string
  name: string
  level: 'group' | 'subgroup'
  counts: Record<string, number>
  total: number
  /** Subgroups (main groups with meaningful subcategories). */
  children: RolloutNode[]
  /** Permissions (subgroups, and main groups that expand directly). */
  permissions: RolloutPermission[]
}

export interface Rollout {
  groups: RolloutNode[]
  /** Every mode present, primary rollout modes first (never drops a mode). */
  columns: string[]
  totals: Record<string, number>
  total: number
}

/**
 * Overview display hierarchy: the shared S&A module taxonomy (modules.ts),
 * Group → Area → Permission. Presentation only.
 */
export const ROLLOUT_HIERARCHY = MODULE_TAXONOMY
/** Unmapped modules stay visible here until they are added to the taxonomy. */
export const OTHER_GROUP = OTHER_MODULE

export function classifyPermission(permissionKey: string): { groupId: string; subgroupId: string | null } {
  const c = classifyModule(permissionKey)
  return { groupId: c.groupId, subgroupId: c.areaId }
}

const tally = (permissions: RolloutPermission[]) => {
  const counts: Record<string, number> = {}
  for (const p of permissions) counts[p.mode] = (counts[p.mode] ?? 0) + 1
  return counts
}

function node(id: string, name: string, level: 'group' | 'subgroup', children: RolloutNode[], permissions: RolloutPermission[]): RolloutNode {
  const all = [...permissions, ...children.flatMap(c => c.permissions)]
  return { id, name, level, children, permissions, counts: tally(all), total: all.length }
}

/** Builds the tree; each unique permission key appears exactly once. */
export function buildRollout(permissions: RolloutPermission[]): Rollout {
  const unique = Array.from(new Map(permissions.map(p => [p.key, p])).values())
  const defs: ModuleGroup[] = [...ROLLOUT_HIERARCHY, { ...OTHER_GROUP, match: () => false }]
  const groups: RolloutNode[] = []
  for (const def of defs) {
    const mine = unique.filter(p => classifyPermission(p.key).groupId === def.id)
    if (mine.length === 0) continue
    const byLabel = (a: RolloutPermission, b: RolloutPermission) => a.label.localeCompare(b.label)
    if (!def.areas) {
      groups.push(node(def.id, def.name, 'group', [], [...mine].sort(byLabel)))
      continue
    }
    const children = def.areas
      .map(sg => node(`${def.id}/${sg.id}`, sg.name, 'subgroup', [],
        mine.filter(p => classifyPermission(p.key).subgroupId === sg.id).sort(byLabel)))
      .filter(c => c.total > 0)
    // A permission of this group matching no subgroup stays directly under it.
    const loose = mine.filter(p => classifyPermission(p.key).subgroupId === null).sort(byLabel)
    groups.push(node(def.id, def.name, 'group', children, loose))
  }
  const totals = tally(unique)
  const extra = Object.keys(totals).filter(m => !(PRIMARY_ROLLOUT_MODES as readonly string[]).includes(m)).sort()
  return { groups, columns: [...PRIMARY_ROLLOUT_MODES, ...extra], totals, total: unique.length }
}

export function aggregateRollout(modes: ModeRow[]): Rollout {
  return buildRollout(modes.map(m => ({
    key: m.permission_key,
    label: permissionLabel(m.permission_key).label,
    mode: m.mode,
    enforcementReady: Boolean(m.enforcementReady),
  })))
}

export interface FilteredRollout {
  rollout: Rollout
  /** Ancestors to open so every match is visible. */
  autoOpen: string[]
}

/**
 * Search across group, subgroup and permission names and technical keys.
 * A matching group or subgroup keeps all its descendants; a matching
 * permission keeps only matching siblings. Counts are recomputed for the
 * filtered tree.
 */
export function filterRollout(rollout: Rollout, query: string): FilteredRollout {
  const q = query.trim().toLowerCase()
  if (!q) return { rollout, autoOpen: [] }
  const hit = (text: string) => text.toLowerCase().includes(q)
  const permHit = (p: RolloutPermission) => hit(p.label) || hit(p.key)
  const autoOpen: string[] = []
  const groups: RolloutNode[] = []
  for (const g of rollout.groups) {
    if (hit(g.name)) {
      groups.push(g)
      autoOpen.push(g.id)
      continue
    }
    const children: RolloutNode[] = []
    for (const c of g.children) {
      if (hit(c.name)) { children.push(c); autoOpen.push(c.id); continue }
      const perms = c.permissions.filter(permHit)
      if (perms.length) { children.push(node(c.id, c.name, 'subgroup', [], perms)); autoOpen.push(c.id) }
    }
    const loose = g.permissions.filter(permHit)
    if (children.length || loose.length) {
      groups.push(node(g.id, g.name, 'group', children, loose))
      autoOpen.push(g.id)
    }
  }
  const all = groups.flatMap(g => [...g.permissions, ...g.children.flatMap(c => c.permissions)])
  const totals = tally(all)
  return { rollout: { groups, columns: rollout.columns, totals, total: all.length }, autoOpen }
}

export interface DecisionRow {
  occurred_at: string
  permission_key: string
  comparison: string
}

export interface DifferenceSummary {
  /** Recorded legacy-vs-new differences (not MATCH_ALLOW / MATCH_DENY). */
  count: number
  /** Earliest and latest decision in the loaded sample. */
  from: string | null
  to: string | null
  /** The sample is the latest `sampleLimit` non-matching decisions (not a time window). */
  sampleSize: number
  capped: boolean
  /** Differences on permissions still in Monitoring / Legacy enforced: review before enabling. */
  pending: number
  pendingPermissions: string[]
  /** Differences on permissions the new model already decides: historical. */
  historical: number
  byPermission: Record<string, number>
}

const isDifference = (comparison: string) => !['MATCH_ALLOW', 'MATCH_DENY'].includes(comparison)
const NOT_YET_ENFORCED = new Set(['SHADOW', 'LEGACY_ENFORCED'])

export function summarizeDifferences(decisions: DecisionRow[], modes: ModeRow[], sampleLimit: number): DifferenceSummary {
  const modeByKey = new Map(modes.map(m => [m.permission_key, m.mode]))
  const times = decisions.map(d => d.occurred_at).filter(Boolean).sort()
  const diffs = decisions.filter(d => isDifference(d.comparison))
  const byPermission: Record<string, number> = {}
  let pending = 0
  const pendingKeys = new Set<string>()
  for (const d of diffs) {
    byPermission[d.permission_key] = (byPermission[d.permission_key] ?? 0) + 1
    if (NOT_YET_ENFORCED.has(modeByKey.get(d.permission_key) ?? '')) {
      pending += 1
      pendingKeys.add(d.permission_key)
    }
  }
  return {
    count: diffs.length,
    from: times[0] ?? null,
    to: times[times.length - 1] ?? null,
    sampleSize: decisions.length,
    capped: decisions.length >= sampleLimit,
    pending,
    pendingPermissions: Array.from(pendingKeys).sort(),
    historical: diffs.length - pending,
    byPermission,
  }
}
