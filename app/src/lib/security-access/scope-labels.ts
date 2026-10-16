/**
 * Display labels for scope definitions. Several scopes legitimately share a display name (every organization has
 * its own "Own record" scope; an organization and its warehouse can both be called the same), so the bare name is
 * ambiguous in lists. Presentation only: ids, types and values are never changed.
 */
export interface ScopeLike { id: string; display_name: string; scope_type: string; organization_id?: string | null }

const typeLabel = (t: string) => { const s = String(t).replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1) }

export function scopeLabels(scopes: ScopeLike[], orgNames: Map<string, string> = new Map()): Map<string, string> {
  const org = (s: ScopeLike) => (s.organization_id ? orgNames.get(s.organization_id) : undefined)
  // Step 1: a per-organization scope is named by its organization.
  const step1 = new Map<string, string>(scopes.map(s => [s.id, s.scope_type === 'own_record' && org(s) ? `${s.display_name} · ${org(s)}` : s.display_name]))
  // Step 2: remaining repeats are told apart by scope type, then by organization.
  const count = (m: Map<string, string>) => { const c = new Map<string, number>(); for (const v of m.values()) c.set(v, (c.get(v) ?? 0) + 1); return c }
  const c1 = count(step1)
  const step2 = new Map<string, string>(scopes.map(s => [s.id, (c1.get(step1.get(s.id)!) ?? 0) > 1 ? `${step1.get(s.id)} (${typeLabel(s.scope_type)})` : step1.get(s.id)!]))
  const c2 = count(step2)
  return new Map(scopes.map(s => [s.id, (c2.get(step2.get(s.id)!) ?? 0) > 1 && org(s) ? `${step2.get(s.id)} · ${org(s)}` : step2.get(s.id)!]))
}
